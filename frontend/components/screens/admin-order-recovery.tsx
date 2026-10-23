"use client";

import { useEffect, useRef, useState } from "react";
import { ApiRequestError, getCsrfToken, post } from "@/lib/auth";
import type { RecoveryAction, RecoveryTarget } from "@/lib/admin-orders-server";
import { kst } from "@/lib/format";

type Draft = { key: string; path: string; body: string; uncertain: boolean };
type Receipt = { action: RecoveryAction; replayed: boolean };
const targets: Record<RecoveryTarget["kind"], string> = { PAYMENT: "결제", ISSUANCE: "발급", REFUND: "환불", INBOUND: "웹훅", PROTECTION: "SIM 차단·종료·해제" };
const states: Record<RecoveryAction["status"], string> = { QUEUED: "접수·처리 대기", PROCESSING: "처리 중", RETRY: "조회 재시도 대기",
  SUCCEEDED: "조치 완료", REVIEW_REQUIRED: "확인 필요", STALE: "상태 변경으로 중단" };
const outcomes: Record<string, string> = { RESUME_ALLOWED: "같은 번호로 처리 재개 가능", REPLAY_ALLOWED: "저장된 웹훅 재처리 가능",
  BLOCKED: "상충 결과·안전 조건으로 차단", APPLIED: "확인한 결과 반영 완료", RESUMED: "다음 회차 처리 접수" };
const active = (action: RecoveryAction) => ["QUEUED", "PROCESSING", "RETRY"].includes(action.status);

export default function AdminOrderRecovery({ orderId, items, actions, blocked, now, onRefresh }: {
  orderId: string; items: RecoveryTarget[]; actions: RecoveryAction[]; blocked: boolean;
  now: number | null; onRefresh: () => void;
}) {
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const sending = useRef(false);
  const storage = `admin-recovery:${orderId}`;
  const base = `/api/admin/orders/${orderId}`;
  const target = items.find(item => `${item.kind}:${item.id}` === selected) || items.find(item => item.status === "REVIEW_REQUIRED") || items[0];
  const targetActions = actions.filter(action => action.target === target?.kind && action.targetId === target?.id);
  const evidence = targetActions.filter(action => action.kind === "RECONCILE")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const evidenceAge = now === null || !evidence?.checkedAt ? null : Math.max(0, now - Date.parse(evidence.checkedAt));
  const matches = evidence?.status === "SUCCEEDED" && evidence.resultVersion === target?.version;
  const fresh = evidenceAge !== null && evidenceAge < 60000;
  const resumable = matches && fresh && ["RESUME_ALLOWED", "REPLAY_ALLOWED"].includes(evidence.outcome || "")
    && target?.status === "REVIEW_REQUIRED" && target.executionRound < 3 && !blocked;
  const busy = pending || actions.some(active) || !!draft?.uncertain;
  const canQuery = !!target && (target.status === "REVIEW_REQUIRED" || blocked);
  const busyReason = pending ? "접수 중입니다." : draft?.uncertain ? "이전 접수 결과가 불명확합니다. ‘동일 조치 요청 다시 확인’을 먼저 누르세요."
    : actions.some(active) ? "기존 재조회 작업이 처리 중입니다. 완료 후 다시 확인하세요." : "";
  const queryBlocked = busyReason || (!target ? "확인 대상이 없습니다." : !canQuery ? "자동 처리 중이거나 이미 완료된 대상입니다. ‘확인 필요’ 상태의 대상을 선택하세요."
    : !reason.trim() ? "조회·재개 사유를 입력하세요." : "");
  const resumeBlocked = busyReason || (blocked ? "상충 기록이 있어 처리 재개를 차단했습니다."
    : !target || target.status !== "REVIEW_REQUIRED" ? "‘확인 필요’ 상태의 대상만 처리 재개할 수 있습니다."
    : target.executionRound >= 3 ? "최초 포함 3회차 한도에 도달했습니다. 외부 결과 재조회만 가능합니다."
    : !evidence ? "먼저 ‘외부 결과 재조회’를 실행하세요."
    : !matches ? "현재 상태에 맞는 조회 근거가 없습니다. 외부 결과를 다시 조회하세요."
    : !fresh ? "조회 완료 후 60초가 지났거나 확인 시각을 읽는 중입니다. 외부 결과를 다시 조회하세요."
    : !resumable ? "최근 조회 결과가 재개를 허용하지 않습니다. 아래 조회 결과를 확인하세요."
    : !reason.trim() ? "조회·재개 사유를 입력하세요." : "");

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storage) || "null");
        if (saved && typeof saved.key === "string" && typeof saved.body === "string"
          && [`${base}/reconciliations`, `${base}/recoveries`].includes(saved.path)) {
          setDraft({ ...saved, uncertain: saved.uncertain !== false });
        }
      } catch { /* 저장할 수 없어도 화면 안의 키로 재전송한다. */ }
    }, 0);
    return () => clearTimeout(timer);
  }, [base, storage]);

  function save(request: Draft) {
    setDraft(request);
    try { sessionStorage.setItem(storage, JSON.stringify(request)); } catch { /* 메모리의 키로 재전송한다. */ }
  }

  async function send(request: Draft, count: number) {
    if (sending.current) return;
    sending.current = true; setPending(true); setMessage(""); setError("");
    try {
      const csrf = await getCsrfToken();
      const replies = await Promise.allSettled(Array.from({ length: count }, async () => {
        const response = await post(request.path, request.body, "application/json", { "Idempotency-Key": request.key }, csrf);
        return response.json() as Promise<Receipt>;
      }));
      const accepted = replies.filter(reply => reply.status === "fulfilled").map(reply => reply.value);
      const failed = replies.filter(reply => reply.status === "rejected").map(reply => reply.reason);
      if (accepted.length) {
        save({ ...request, uncertain: false });
        setMessage(`조치번호 ${accepted[0].action.id} · 접수 ${accepted.filter(reply => !reply.replayed).length}건 · 중복 응답 ${accepted.filter(reply => reply.replayed).length}건. 처리 결과는 아래 이력에서 확인합니다.`);
        if (failed.length) setError("일부 응답을 확인하지 못했지만 같은 요청의 접수는 확인했습니다. 이력에서 결과를 확인해 주세요.");
      } else {
        save({ ...request, uncertain: failed.some(failure => !(failure instanceof ApiRequestError) || failure.status >= 500) });
        setError(failed[0] instanceof Error ? failed[0].message : "접수 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.");
      }
    } catch (exception) {
      save({ ...request, uncertain: true });
      setError(exception instanceof Error ? exception.message : "접수 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.");
    } finally { sending.current = false; setPending(false); onRefresh(); }
  }

  function submit(kind: "reconciliations" | "recoveries") {
    if (!target || !reason.trim() || busy || (kind === "recoveries" ? !resumable : !canQuery)) return;
    const request = { key: crypto.randomUUID(), path: `${base}/${kind}`, uncertain: true,
      body: JSON.stringify({ target: target.kind, targetId: target.id, expectedVersion: target.version, reason: reason.trim(),
        ...(kind === "recoveries" ? { evidenceId: evidence.id } : {}) }) };
    save(request);
    void send(request, duplicate ? 2 : 1);
  }

  return <section className="home-panel"><h2>확인 필요 건 재조회·재처리</h2>
    <p>먼저 PG·공급사 결과를 조회합니다. 확정된 결과는 기존 주문에 반영하고, 재개가 허용된 경우에만 같은 결제·발급·환불 번호로 처리합니다.</p>
    <p>재개는 조회 완료 후 60초 이내, 상태가 그대로인 경우에만 가능합니다. 실행 회차는 최초 포함 최대 3회이며 누적 시도·조치 이력을 보존합니다.</p>
    {items.length === 0 ? <p>현재 재조회가 필요한 결제·발급·환불·공급사 차단·웹훅 대상이 없습니다.</p> : <>
      <div className="screen-form">
        <label>확인 대상 <select value={target ? `${target.kind}:${target.id}` : ""} disabled={busy} onChange={event => setSelected(event.target.value)}>
          {items.map(item => <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>
            {targets[item.kind]} · {item.status} · {item.id}
          </option>)}
        </select></label>
        <label>조회·재개 사유 <textarea value={reason} disabled={busy} maxLength={300} onChange={event => setReason(event.target.value)} /></label>
        <label><input type="checkbox" checked={duplicate} disabled={busy} onChange={event => setDuplicate(event.target.checked)} />같은 요청을 동시에 2회 전송</label>
      </div>
      {target && <p>대상 상태: {target.status} · 실행 회차 {target.executionRound}/3 · {target.kind === "ISSUANCE"
        ? `연속 확인 실패 ${target.roundAttemptCount}/6회 · 누적 확인 ${target.attemptCount}회`
        : `이번 회차 시도 ${target.roundAttemptCount}/${target.kind === "REFUND" ? 3 : 6}회 · 누적 ${target.attemptCount}회`}
        {target.lastError && <><br />마지막 오류: {target.lastError}</>}</p>}
      <div className="page-actions">
        <button disabled={!!queryBlocked} aria-describedby="recovery-query-help" onClick={() => submit("reconciliations")}>외부 결과 재조회</button>
        <button disabled={!!resumeBlocked} aria-describedby="recovery-resume-help" onClick={() => submit("recoveries")}>
          {target?.kind === "INBOUND" ? "저장된 웹훅 재처리" : "같은 번호로 처리 재개"}
        </button>
      </div>
      {queryBlocked && <p id="recovery-query-help">재조회 제한: {queryBlocked}</p>}
      {resumeBlocked && <p id="recovery-resume-help">처리 재개 제한: {resumeBlocked}</p>}
      {evidence && <p>최근 조회: {states[evidence.status]}{evidence.outcome && ` · ${outcomes[evidence.outcome] || evidence.outcome}`}
        {evidence.checkedAt && <><br />확인 시각: {kst(evidence.checkedAt)}{evidenceAge !== null && ` · ${Math.floor(evidenceAge / 1000)}초 전`}</>}
        {matches && !fresh && <><br />조회 근거의 유효 시간이 지났습니다. 외부 결과를 다시 조회해 주세요.</>}
        {evidence.status === "SUCCEEDED" && !matches && <><br />대상 상태가 변경되었습니다. 외부 결과를 다시 조회해 주세요.</>}
      </p>}
      {target && target.executionRound >= 3 && <p role="alert">최대 3회차에 도달해 재개할 수 없습니다. 외부 결과 재조회는 가능합니다.</p>}
      {blocked && <p role="alert">상충 기록이 있는 주문은 재개하지 않습니다. 재조회 결과와 기존 상충 기록을 확인해 주세요.</p>}
    </>}
    <div className="page-actions">
      <button disabled={pending || !draft} onClick={() => draft && void send(draft, 1)}>동일 조치 요청 다시 확인</button>
      <button disabled={pending} onClick={onRefresh}>최신 상태 다시 확인</button>
    </div>
    {draft && <p>요청 키: <code>{draft.key}</code> · 동일 요청은 처음의 대상·상태 버전·사유·조회 근거로 다시 보냅니다.</p>}
    {draft?.uncertain && <p role="alert">접수 결과가 불명확합니다. 새 조치를 만들기 전에 동일 조치 요청으로 접수 여부를 확인해 주세요.</p>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    <h3>재조회·재개 조치 이력</h3>
    <p>최근 최대 100건입니다. 같은 요청 키의 중복 접수는 기존 조치번호를 반환합니다.</p>
    {actions.length === 0 ? <p>아직 재조회·재개 이력이 없습니다.</p> : actions.map(action => <article key={action.id}>
      <h4>{action.kind === "RECONCILE" ? "외부 결과 재조회" : "처리 재개"} · {states[action.status]} · {action.actor}</h4>
      <p>조치번호: {action.id}<br />대상: {targets[action.target]} · {action.targetId}<br />사유: {action.reason}<br />
        접수: {kst(action.createdAt)}{action.checkedAt && <><br />확인: {kst(action.checkedAt)}</>}</p>
      <p>{action.kind === "RECONCILE" ? `조회 시도 ${action.attemptCount}/3회 · ` : ""}실행 회차 {action.fromRound}{action.toRound !== null && ` → ${action.toRound}`}
        {action.outcome && <><br />결과: {outcomes[action.outcome] || action.outcome}</>}
        {action.externalStatus && <><br />외부 상태: {action.externalStatus}</>}
        {action.externalReference && <><br />외부 처리번호: {action.externalReference}</>}
        {action.evidenceId && <><br />근거 조회번호: {action.evidenceId}</>}
        {action.evidenceHash && <><br />조회 근거 해시: <code>{action.evidenceHash}</code></>}
        {action.lastError && <><br />오류: {action.lastError}</>}</p>
    </article>)}
  </section>;
}
