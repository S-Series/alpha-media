"use client";

import { useEffect, useState } from "react";
import { getCsrfToken, post } from "@/lib/auth";
import type { AdminOrderDetail, InboundEvent } from "@/lib/admin-orders-server";
import { issuanceStatus, simStatus } from "@/lib/issuance";
import { paymentStatus } from "@/lib/payments";
import { orderStatus } from "@/lib/orders";
import { kst, money } from "@/lib/format";
import OrderSummary from "./order-summary";
import AdminOrderTimeline from "./admin-order-timeline";
import AdminConcurrencyDemo from "./admin-concurrency-demo";

type Draft = { key: string; path: string; body: string };
const states: Record<string, string> = { REQUESTED: "환불 접수", QUEUED: "발급 재시도 접수", UNKNOWN: "PG 취소 결과 확인 중",
  PROCESSING: "PG 취소 확인 중", SUCCEEDED: "환불 완료", REVIEW_REQUIRED: "운영자 확인 필요", ISSUED: "발급 완료", FAILED: "발급 실패" };
const inboundStates: Record<InboundEvent["status"], string> = { PENDING: "저장 완료·처리 대기", PROCESSING: "처리 중",
  RETRY: "재처리 대기", PROCESSED: "처리 완료", REVIEW_REQUIRED: "운영자 확인 필요" };
const inboundSources: Record<InboundEvent["source"], string> = { PG: "결제 PG", SUPPLIER: "공급사 발급", PROFILE: "공급사 설치·사용" };

export default function AdminOrderActions({ initial }: { initial: AdminOrderDetail }) {
  const [view, setView] = useState(initial);
  const [reason, setReason] = useState("");
  const [scenario, setScenario] = useState("SUCCESS");
  const [issueScenario, setIssueScenario] = useState("SUCCEED");
  const [duplicate, setDuplicate] = useState(false);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [pollError, setPollError] = useState("");
  const [now, setNow] = useState<number | null>(null);
  const id = initial.order.order.id;
  const storage = `admin-action:${id}`;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    async function poll() {
      try {
        const response = await fetch(`/api/admin/orders/${id}`, { cache: "no-store", credentials: "same-origin",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error("조치 결과를 조회하지 못했습니다.");
        const data: AdminOrderDetail = await response.json();
        if (controller.signal.aborted) return;
        setView(data); setPollError("");
        try {
          const saved = JSON.parse(sessionStorage.getItem(storage) || "null");
          if (saved && typeof saved.key === "string" && typeof saved.body === "string"
            && [`/api/admin/orders/${id}/refunds`, `/api/admin/orders/${id}/issuance-retries`].includes(saved.path)) setDraft(saved);
        } catch { /* 저장할 수 없어도 같은 화면에서는 요청 키를 유지한다. */ }
        const active = ["REQUESTED", "PROCESSING", "UNKNOWN"].includes(data.refund?.status || "")
          || ["QUEUED", "PROCESSING", "WAITING_CALLBACK"].includes(data.issuance?.issuance?.status || "")
          || (data.inboundEvents || []).some(event => ["PENDING", "PROCESSING", "RETRY"].includes(event.status));
        timer = setTimeout(poll, active ? 1500 : 5000);
      } catch {
        if (!controller.signal.aborted) {
          setPollError("최신 상태를 확인하지 못했습니다. 마지막 확인 상태를 유지하며 재조회합니다.");
          timer = setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); clearInterval(clock); };
  }, [id, storage, refresh]);

  async function send(request: Draft, count: number) {
    setPending(true); setError(""); setMessage("");
    try {
      // 같은 배치의 요청은 CSRF 발급을 경합하지 않고 하나의 토큰을 공유한다.
      const csrf = await getCsrfToken();
      const replies = await Promise.all(Array.from({ length: count }, async () => {
        const response = await post(request.path, request.body, "application/json", { "Idempotency-Key": request.key }, csrf);
        return response.json() as Promise<{ action: { id: string }; replayed: boolean }>;
      }));
      setMessage(`조치번호 ${replies[0].action.id} · 접수 ${replies.filter(r => !r.replayed).length}건 · 중복 응답 ${replies.filter(r => r.replayed).length}건`);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "접수 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.");
    } finally { setPending(false); setRefresh(value => value + 1); }
  }

  function submit(type: "refunds" | "issuance-retries") {
    const job = view.issuance?.issuance;
    if (!job || !reason.trim()) return;
    const body = { issuanceId: job.id, reason: reason.trim(), ...(type === "refunds" ? { scenario } : {
      simulation: { scenario: issueScenario, callbackCopies: 1, callbackDelayMs: 2000 },
    }) };
    const request = { key: crypto.randomUUID(), path: `/api/admin/orders/${id}/${type}`, body: JSON.stringify(body) };
    setDraft(request);
    try { sessionStorage.setItem(storage, JSON.stringify(request)); } catch { /* 메모리의 키로 재전송한다. */ }
    void send(request, duplicate ? 2 : 1);
  }

  const job = view.issuance?.issuance;
  const profile = view.issuance?.profile;
  const conflicts = view.conflicts || [];
  const age = now === null || !view.checkedAt ? null : Math.max(0, Math.floor((now - Date.parse(view.checkedAt)) / 1000));
  const canAct = view.order.order.status === "PAID" && job?.status === "FAILED" && !view.issuance?.profile && !view.refund && conflicts.length === 0;
  return <>
    <p>서버 마지막 조회: {view.checkedAt ? kst(view.checkedAt) : "조회 시각 확인 대기"}{age !== null && ` · ${age}초 전`} · 처리 중 1.5초, 그 외 5초 간격 갱신</p>
    {pollError && <p role="alert">{pollError}</p>}
    <OrderSummary order={view.order.order} />
    {conflicts.length > 0 && <section className="home-panel"><h2>상충 결과 확인 필요</h2>
      <p role="alert">기존 기록과 다른 외부 결과가 발견되어 발급 재시도·환불을 차단했습니다. PG·공급사의 실제 처리 결과를 확인해야 합니다.</p>
      {conflicts.map(conflict => <article key={conflict.id}>
        <h3>{conflict.target} · {conflict.code}</h3>
        <p>기존 기록: {conflict.expectedStatus} · 수신 결과: {conflict.observedStatus}<br />
          대상 번호: {conflict.targetId}<br />수신 경로: {conflict.source} · 기록 시각: {kst(conflict.recordedAt)}</p>
      </article>)}
    </section>}
    <section className="home-panel"><h2>결제 시도</h2><p>최근 최대 20건을 표시합니다.</p>
      {view.payments.length === 0 ? <p>아직 결제 시도가 없습니다.</p> : view.payments.map(payment => <article key={payment.id}>
        <h3>{paymentStatus(payment.status)}</h3><p>결제번호: {payment.id}</p>
        <p>누적 PG 처리·확인 시도 {payment.attemptCount}회 · 마지막 변경 {kst(payment.updatedAt)}</p>
        {payment.executionRound !== undefined && <p>실행 회차 {payment.executionRound} · 이번 회차 시도 {payment.roundAttemptCount ?? payment.attemptCount}/6회</p>}
        {payment.lastError && <p>확인 사유: {payment.lastError}</p>}
      </article>)}
    </section>
    <section className="home-panel"><h2>발급·설치 상태</h2>
      {job ? <><p>{issuanceStatus(job.status)} · 발급 요청번호 {job.id}</p>
        <p>공급사 접수번호: {job.supplierOrderNo || "접수 확인 중"}<br />누적 공급사 확인 시도 {job.checkCount}회 · 마지막 변경 {kst(job.updatedAt)}</p>
        {job.executionRound !== undefined && <p>실행 회차 {job.executionRound} · 발급 제출 시도 {job.submissionCount ?? 0}회</p>}
        {job.waitingSince && <p>정상 결과 대기 시작: {kst(job.waitingSince)} · 최대 2분, 5초 간격 확인</p>}
        {job.lastError && <p role="alert">조치 필요: {job.lastError}</p>}</> : <p>아직 발급 작업이 없습니다.</p>}
      {profile && <><p>ICCID: {profile.iccid} · {simStatus(profile.installStatus)}</p>
        <p>설치: {profile.installedAt ? kst(profile.installedAt) : "미확인"}<br />
          개통: {profile.activatedAt ? kst(profile.activatedAt) : "미개통"}<br />
          만료: {profile.expiresAt ? kst(profile.expiresAt) : "개통 후 결정"}<br />
          공급사 마지막 확인: {profile.lastSyncedAt ? kst(profile.lastSyncedAt) : "확인 대기"}</p>
        {profile.syncError && <p role="alert">공급사 확인 지연: {profile.syncError}. 마지막 확인 상태입니다.</p>}
      </>}
    </section>
    <section className="home-panel"><h2>웹훅 수신·처리 내역</h2>
      <p>최근 최대 100건입니다. 수신을 먼저 저장한 뒤 처리합니다. 같은 내용의 중복 수신은 수신 횟수에 합산됩니다.</p>
      {(view.inboundEvents || []).length === 0 ? <p>아직 수신한 웹훅이 없습니다.</p> : view.inboundEvents?.map(event => <article key={event.id}>
        <h3>{inboundSources[event.source]} · {inboundStates[event.status]}</h3>
        <p>이벤트 번호: {event.eventId}<br />수신 기록번호: {event.id}<br />수신 {event.receiveCount}회 · 처리 시도 {event.attemptCount}회</p>
        <p>최초 수신: {kst(event.receivedAt)}<br />마지막 수신: {kst(event.lastReceivedAt)}<br />
          처리 완료: {event.processedAt ? kst(event.processedAt) : "미완료"}
          {event.nextAttemptAt && <><br />다음 처리 시각: {kst(event.nextAttemptAt)}</>}</p>
        {event.lastError && <p>처리 오류: {event.lastError}{event.errorStatus !== null && ` · 오류 상태 ${event.errorStatus}`}</p>}
        {event.status === "REVIEW_REQUIRED" && <p role="alert">자동 처리를 중단했습니다. 오류와 상충 결과를 확인해 주세요.</p>}
      </article>)}
    </section>
    <AdminOrderTimeline orderId={id} latest={view.timeline} />
    <section className="home-panel"><h2>운영자 조치</h2>
      <p>현재 주문: {orderStatus(view.order.order.status)} · 발급: {job ? issuanceStatus(job.status) : "작업 없음"}</p>
      <p>발급 실패가 확정되고 SIM이 없는 주문만 재시도 또는 전액 환불할 수 있습니다. 환불 접수 후 발급 재시도는 차단됩니다.</p>
      <div className="screen-form">
      <label>조치 사유 <textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={300} disabled={pending} /></label>
      <label>재시도 발급 결과 <select value={issueScenario} onChange={e => setIssueScenario(e.target.value)} disabled={pending}>
        <option value="SUCCEED">발급 성공</option><option value="FAIL">발급 실패</option>
      </select></label>
      <label>환불 시연 상황 <select value={scenario} onChange={e => setScenario(e.target.value)} disabled={pending}>
        <option value="SUCCESS">취소 성공</option><option value="RESPONSE_LOST">취소 후 응답 유실</option><option value="UNAVAILABLE">PG 취소 장애, 3회 후 확인 필요</option>
      </select></label>
      <label><input type="checkbox" checked={duplicate} onChange={e => setDuplicate(e.target.checked)} disabled={pending} />같은 요청을 동시에 2회 전송</label>
      </div>
      <div className="page-actions">
        <button disabled={pending || !canAct || !reason.trim()} onClick={() => submit("issuance-retries")}>발급 재시도</button>
        <button disabled={pending || !canAct || !reason.trim()} onClick={() => submit("refunds")}>전액 환불 접수</button>
        <button disabled={pending || !draft || conflicts.length > 0} onClick={() => draft && void send(draft, 1)}>동일 요청 다시 전송</button>
        <button disabled={pending} onClick={() => setRefresh(value => value + 1)}>조치 결과 다시 확인</button>
      </div>
      {draft && <p>요청 키: <code>{draft.key}</code> · 재전송은 사유·시연 조건까지 처음 요청 그대로 보냅니다.</p>}
      {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    </section>
    {conflicts.length === 0 && <AdminConcurrencyDemo orderId={id} issuanceId={job?.id} eligible={!!canAct} />}
    <section className="home-panel"><h2>환불 처리</h2>
      {view.refund ? <>
        <p>{states[view.refund.status] || view.refund.status} · {money(view.refund.amount)} KRW</p>
        <p>환불번호: {view.refund.id}<br />PG 취소번호: {view.refund.pgCancellationId || "확인 중"}</p>
        <p>누적 PG 처리·확인 시도 {view.refund.attemptCount}회</p>
        {view.refund.executionRound !== undefined && <p>실행 회차 {view.refund.executionRound} · 이번 회차 시도 {view.refund.roundAttemptCount ?? view.refund.attemptCount}/3회</p>}
        {view.refund.lastError && <p>확인 사유: {view.refund.lastError}</p>}
        {view.refund.status === "REVIEW_REQUIRED" && <p role="alert">자동 처리를 중단했습니다. 환불 완료로 간주하지 않으며 새 환불·발급을 막습니다. PG 원장 확인이 필요합니다.</p>}
      </> : <p>환불 접수 없음</p>}
    </section>
    <section className="home-panel"><h2>운영자 조치 이력</h2><p>최근 최대 100건입니다. 중복 요청은 기존 조치번호를 반환하며 이력을 추가하지 않습니다.</p>
      {(view.actions || []).length === 0 ? <p>아직 조치 이력이 없습니다.</p> : view.actions?.map(action => <article key={action.id}>
        <h3>{action.type === "REFUND" ? "전액 환불" : "발급 재시도"} · {action.actor}</h3>
        <p>사유: {action.reason}<br />접수: {kst(action.createdAt)}<br />조치번호: {action.id}</p>
        <p>대상 번호: {action.refundId || action.issuanceId}</p>
        {(view.actionEvents || []).filter(event => event.actionId === action.id).map(event => <p key={event.id}>
          {kst(event.createdAt)} · {states[event.status] || event.status}{event.detail && ` · ${event.detail}`}
        </p>)}
      </article>)}
    </section>
  </>;
}
