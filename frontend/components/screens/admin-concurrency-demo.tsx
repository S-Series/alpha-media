"use client";

import { useEffect, useRef, useState } from "react";
import { ApiRequestError, post } from "@/lib/auth";
import { kst, money } from "@/lib/format";

type Settings = { issuanceId: string; mode: string; keyMode: string; reason: string };
type Result = { status: number; code: string; message: string; actionId: string | null; appliedBy: string | null;
  replayed: boolean; startedAt: string | null; finishedAt: string };
type Round = { id: string; expiresAt: string; phase: string; participating: boolean; request: Settings;
  participants: { username: string; operation: string; key: string; result: Result | null }[];
  stats: { actionCount: number; refundCount: number; retryCount: number; profileCount: number; pgCancellations: number;
    cancelledAmount: number; supplierOrders: number; supplierIssues: number }; checkedAt: string };
const phases: Record<string, string> = { WAITING: "두 번째 운영자 참가 대기", READY: "두 운영자 참가 완료, 실행 대기",
  RUNNING: "두 조치 접수 결과 확인 중", PROCESSING: "접수 완료, PG·공급사 처리 확인 중", PASSED: "검증 통과, 실제 처리 1건",
  BLOCKED: "두 조치 모두 차단, 주문 상태 확인 필요", REVIEW_REQUIRED: "결과 불명확, 실제 조치 이력 확인 필요",
  INVARIANT_FAILED: "검증 실패, 실제 처리 건수 확인 필요" };
const terminal = ["PASSED", "BLOCKED", "REVIEW_REQUIRED", "INVARIANT_FAILED"];
const modes: Record<string, string> = { REFUND_REFUND: "환불 / 환불", RETRY_RETRY: "발급 재시도 / 발급 재시도",
  REFUND_RETRY: "환불 / 발급 재시도" };
const operation = (value: string) => value === "REFUND" ? "전액 환불" : "발급 재시도";

export default function AdminConcurrencyDemo({ orderId, issuanceId, eligible }: {
  orderId: string; issuanceId?: string; eligible: boolean;
}) {
  const [mode, setMode] = useState("REFUND_REFUND");
  const [keyMode, setKeyMode] = useState("SEPARATE");
  const [reason, setReason] = useState("");
  const [id, setId] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [view, setView] = useState<Round | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const draft = useRef<{ id: string; body: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const base = `/api/admin/orders/${orderId}/concurrency-demos`;

  useEffect(() => {
    function readHash() {
      const value = new URLSearchParams(window.location.hash.slice(1)).get("race") || "";
      setId(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : "");
      setShareUrl(window.location.href);
    }
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, [orderId]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`${base}/${id}`, { cache: "no-store", credentials: "same-origin",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        const data = await response.json();
        if (!response.ok) throw new ApiRequestError(response.status, data.message || "시연 결과를 조회하지 못했습니다.");
        if (controller.signal.aborted) return;
        setView(data); setError("");
        if (!terminal.includes(data.phase)) timer = setTimeout(poll, 1500);
      } catch (exception) {
        if (controller.signal.aborted) return;
        setError(exception instanceof Error ? exception.message : "조회에 실패했습니다.");
        if (!(exception instanceof ApiRequestError && [401, 403, 404].includes(exception.status))) timer = setTimeout(poll, 5000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base, id, refresh]);

  async function create() {
    if (!draft.current) {
      if (!issuanceId || !reason.trim()) return;
      draft.current = { id: crypto.randomUUID(), body: JSON.stringify({ issuanceId, mode, keyMode, reason: reason.trim() }) };
    }
    const request = draft.current;
    setPending(true); setError("");
    try {
      const response = await post(base, request.body, "application/json", { "Idempotency-Key": request.id });
      setView(await response.json()); setUncertain(false);
      window.location.hash = new URLSearchParams({ race: request.id }).toString();
      draft.current = null;
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "접수 결과가 불명확합니다.");
      const knownRejection = exception instanceof ApiRequestError && exception.status < 500;
      if (knownRejection) draft.current = null;
      setUncertain(!knownRejection);
    } finally { setPending(false); }
  }

  async function act(action: "join" | "start") {
    setPending(true); setError("");
    try {
      const response = await post(`${base}/${id}/${action}`);
      setView(await response.json());
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "결과를 확인하지 못했습니다. 같은 시연 번호로 다시 확인하세요.");
    } finally { setPending(false); setRefresh(value => value + 1); }
  }

  return <section className="home-panel"><h2>두 운영자 동시 조치 시연</h2>
    <p>발급 실패가 확정되고 SIM·환불이 없는 주문에서 시작합니다. 재시도는 발급 성공, 환불은 취소 성공으로 고정합니다.</p>
    <p>운영자 1과 운영자 2가 각각 로그인해 같은 시연에 참가합니다. 같은 브라우저의 탭은 쿠키를 공유하므로 두 번째 운영자는 시크릿 창이나 다른 브라우저를 사용하세요.</p>
    {!id ? <>
      <div className="screen-form">
        <label>동시 조치 <select value={mode} disabled={pending || uncertain} onChange={e => {
          setMode(e.target.value); if (e.target.value === "REFUND_RETRY") setKeyMode("SEPARATE");
        }}>{Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>요청 키 <select value={keyMode} onChange={e => setKeyMode(e.target.value)} disabled={pending || uncertain}>
          <option value="SEPARATE">각 운영자가 다른 키 사용, 한 건 접수·한 건 차단</option>
          <option value="SHARED" disabled={mode === "REFUND_RETRY"}>같은 키 사용, 한 건 접수·기존 결과 반환</option>
        </select></label>
        <label>두 조치의 사유 <textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={300} disabled={pending || uncertain} /></label>
      </div>
      <button disabled={pending || (!uncertain && (!eligible || !reason.trim()))} onClick={() => void create()}>
        {uncertain ? "같은 시연 준비 요청으로 결과 확인" : "시연 준비"}
      </button>
      {!eligible && <p>현재 주문은 새 시연을 시작할 수 없습니다. 발급 실패 주문을 선택하세요.</p>}
      {uncertain && <p role="alert">준비 응답을 확인하지 못했습니다. 처음 설정과 요청 키를 유지해 다시 확인합니다. 이 단계에서는 조치를 실행하지 않습니다.</p>}
    </> : <>
      <label>다른 운영자에게 전달할 주소 <input readOnly value={shareUrl} onFocus={e => e.target.select()} /></label>
      <p>시연 번호: <code>{id}</code></p>
      {view && view.id === id && <>
        <p role="status"><strong>{phases[view.phase] || view.phase}</strong></p>
        <p>{modes[view.request.mode]} · {view.request.keyMode === "SHARED" ? "같은 요청 키" : "서로 다른 요청 키"}<br />
          사유: {view.request.reason}<br />유효 기한: {kst(view.expiresAt)} · 마지막 확인: {kst(view.checkedAt)}</p>
        <div className="page-actions">
          <button disabled={pending || view.participating || view.phase !== "WAITING"} onClick={() => void act("join")}>이 운영자로 참가</button>
          <button disabled={pending || !view.participating || view.phase !== "READY"} onClick={() => void act("start")}>두 조치 동시 실행</button>
          <button disabled={pending} onClick={() => setRefresh(value => value + 1)}>시연 결과 다시 확인</button>
        </div>
        <p>각 운영자가 등록한 조치를 서버에서 동시에 시작합니다. 먼저 주문 잠금을 획득한 조치만 적용되며, 어느 운영자가 먼저 처리될지는 정해져 있지 않습니다.</p>
        {view.participants.map(person => <article key={person.username}>
          <h3>{person.username} · {operation(person.operation)}</h3>
          <p>요청 키: <code>{person.key}</code></p>
          {person.result ? <>
            <p>접수 결과: <strong>{person.result.status} · {person.result.code}</strong> · {person.result.message}</p>
            {person.result.actionId && <p>실제 조치번호: {person.result.actionId} · 최초 처리자: {person.result.appliedBy}</p>}
            <p>호출 시작: {person.result.startedAt || "시작 실패"}<br />응답 확인: {person.result.finishedAt}</p>
          </> : <p>접수 결과 대기</p>}
        </article>)}
        <p>실제 DB 원장: 조치 <strong>{view.stats.actionCount}건</strong> · 환불 {view.stats.refundCount}건 · 새 발급 작업 {view.stats.retryCount}건</p>
        <p>모의 PG 취소 <strong>{view.stats.pgCancellations}건</strong> · 취소액 {money(view.stats.cancelledAmount)} KRW<br />
          모의 공급사 요청 {view.stats.supplierOrders}건 · 발급 실행 <strong>{view.stats.supplierIssues}회</strong> · 주문의 SIM {view.stats.profileCount}개</p>
        <p>접수 응답과 별도로 PG 취소 또는 공급사 발급까지 완료되어야 검증 통과입니다. 아래 운영자 조치 이력에서 최초 처리자와 사유를 확인할 수 있습니다.</p>
      </>}
    </>}
    {error && <p role="alert">{error}</p>}
    <p>시연 참가·결과 화면은 10분 동안 유지되며 서버 재시작 시 사라집니다. 실제 주문·환불·발급·조치 이력은 DB에 보관됩니다. 완료된 주문에서 다시 시연하려면 다른 발급 실패 주문을 선택하세요.</p>
  </section>;
}
