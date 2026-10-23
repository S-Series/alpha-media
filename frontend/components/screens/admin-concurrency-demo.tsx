"use client";

import { useEffect, useRef, useState } from "react";
import { ApiRequestError, post } from "@/lib/auth";
import { kst, money } from "@/lib/format";

type Settings = { issuanceId: string; mode: string; keyMode: string; reason: string; firstAmount?: number; secondAmount?: number };
type Result = { status: number; code: string; message: string; actionId: string | null; appliedBy: string | null;
  replayed: boolean; startedAt: string | null; finishedAt: string };
type Round = { id: string; expiresAt: string; phase: string; participating: boolean; request: Settings;
  participants: { username: string; operation: string; key: string; amount: number | null; result: Result | null }[];
  stats: { actionCount: number; refundCount: number; retryCount: number; profileCount: number; pgCancellations: number;
    cancelledAmount: number; supplierOrders: number; supplierIssues: number; orderAmount: number;
    confirmedAmount: number; reservedAmount: number }; checkedAt: string };
const phases: Record<string, string> = { WAITING: "두 번째 운영자 참가 대기", READY: "두 운영자 참가 완료, 실행 대기",
  RUNNING: "두 조치 접수 결과 확인 중", PROCESSING: "접수 완료, PG·공급사 처리 확인 중", PASSED: "검증 통과, 접수 결과와 실제 처리 일치",
  BLOCKED: "두 조치 모두 차단, 주문 상태 확인 필요", REVIEW_REQUIRED: "결과 불명확, 실제 조치 이력 확인 필요",
  INVARIANT_FAILED: "검증 실패, 실제 처리 건수 확인 필요" };
const terminal = ["PASSED", "BLOCKED", "REVIEW_REQUIRED", "INVARIANT_FAILED"];
const modes: Record<string, string> = { REFUND_REFUND: "환불 / 환불", RETRY_RETRY: "발급 재시도 / 발급 재시도",
  REFUND_RETRY: "환불 / 발급 재시도", PARTIAL_REFUND_REFUND: "부분 환불 / 부분 환불" };
const operation = (value: string) => value === "REFUND" ? "전액 환불" : "발급 재시도";

export default function AdminConcurrencyDemo({ orderId, issuanceId, eligible, orderAmount }: {
  orderId: string; issuanceId?: string; eligible: boolean; orderAmount: number;
}) {
  const [mode, setMode] = useState("REFUND_REFUND");
  const [keyMode, setKeyMode] = useState("SEPARATE");
  const [reason, setReason] = useState("");
  const [firstAmount, setFirstAmount] = useState(() => String(Math.max(1, Math.floor(orderAmount / 2))));
  const [secondAmount, setSecondAmount] = useState(() => String(Math.max(1, Math.floor(orderAmount / 2))));
  const [id, setId] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [view, setView] = useState<Round | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const draft = useRef<{ id: string; body: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const base = `/api/admin/orders/${orderId}/concurrency-demos`;
  const partial = mode === "PARTIAL_REFUND_REFUND";
  const amountsValid = [firstAmount, secondAmount].every(value => /^\d+$/.test(value)
    && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) < orderAmount);
  const prepareBlocked = pending ? "시연 준비 요청을 처리 중입니다."
    : uncertain ? "" : !eligible ? "새 ‘발급 실패·환불 미접수’ 주문을 생성하세요. SIM·환불 이력이 있는 주문은 시작할 수 없습니다."
    : partial && !amountsValid ? `두 금액을 각각 1원 이상 ${money(orderAmount)}원 미만의 정수로 입력하세요.`
    : !reason.trim() ? "‘두 조치의 사유’를 입력하면 시연 준비가 활성화됩니다." : "";

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
      if (!issuanceId || !reason.trim() || (partial && !amountsValid)) return;
      draft.current = { id: crypto.randomUUID(), body: JSON.stringify({ issuanceId, mode, keyMode, reason: reason.trim(),
        ...(partial ? { firstAmount: Number(firstAmount), secondAmount: Number(secondAmount) } : {}) }) };
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
          <option value="SEPARATE">각 운영자가 다른 키 사용</option>
          <option value="SHARED" disabled={mode === "REFUND_RETRY"}>같은 키 사용</option>
        </select></label>
        {partial && <>
          <label>시연을 만든 운영자 환불액 (KRW) <input type="number" min={1} max={orderAmount - 1} step={1}
            value={firstAmount} onChange={e => setFirstAmount(e.target.value)} disabled={pending || uncertain} /></label>
          <label>두 번째로 참가한 운영자 환불액 (KRW) <input type="number" min={1} max={orderAmount - 1} step={1}
            value={secondAmount} onChange={e => setSecondAmount(e.target.value)} disabled={pending || uncertain} /></label>
          <p>각 금액은 1원 이상, 주문액 {money(orderAmount)} KRW 미만의 정수입니다. 두 요청이 모두 다른 키이고 합계가 잔액 이내면 두 건 모두 접수됩니다. 초과하면 먼저 접수된 금액을 예약하고 나머지 요청을 차단합니다.</p>
          <p>같은 키와 같은 금액이면 한 건만 처리하고 기존 결과를 반환합니다. 같은 키에 다른 금액이면 요청 내용 충돌로 한 건을 차단합니다.</p>
          {amountsValid && <p>요청 합계: {money(Number(firstAmount) + Number(secondAmount))} KRW · 예상 결과: <strong>
            {keyMode === "SHARED" ? Number(firstAmount) === Number(secondAmount) ? "한 건 접수 · 기존 결과 반환" : "한 건 접수 · 요청 내용 충돌"
              : Number(firstAmount) + Number(secondAmount) <= orderAmount ? "두 건 접수" : "한 건 접수 · 잔액 초과 차단"}</strong></p>}
        </>}
        <label>두 조치의 사유 <textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={300} disabled={pending || uncertain} /></label>
      </div>
      <button disabled={!!prepareBlocked} aria-describedby="concurrency-prepare-help" onClick={() => void create()}>
        {uncertain ? "같은 시연 준비 요청으로 결과 확인" : "시연 준비"}
      </button>
      {prepareBlocked && <p id="concurrency-prepare-help" role="status">시연 준비 제한: {prepareBlocked}</p>}
      {uncertain && <p role="alert">준비 응답을 확인하지 못했습니다. 처음 설정과 요청 키를 유지해 다시 확인합니다. 이 단계에서는 조치를 실행하지 않습니다.</p>}
    </> : <>
      <label>다른 운영자에게 전달할 주소 <input readOnly value={shareUrl} onFocus={e => e.target.select()} /></label>
      <p>시연 번호: <code>{id}</code></p>
      {view && view.id === id && <>
        <p role="status"><strong>{phases[view.phase] || view.phase}</strong></p>
        <p>{modes[view.request.mode]} · {view.request.keyMode === "SHARED" ? "같은 요청 키" : "서로 다른 요청 키"}<br />
          사유: {view.request.reason}<br />유효 기한: {kst(view.expiresAt)} · 마지막 확인: {kst(view.checkedAt)}</p>
        {view.request.mode === "PARTIAL_REFUND_REFUND" && <p>첫 참가자 {money(view.request.firstAmount!)} KRW · 두 번째 참가자 {money(view.request.secondAmount!)} KRW</p>}
        <div className="page-actions">
          <button disabled={pending || view.participating || view.phase !== "WAITING"} onClick={() => void act("join")}>이 운영자로 참가</button>
          <button disabled={pending || !view.participating || view.phase !== "READY"} onClick={() => void act("start")}>두 조치 동시 실행</button>
          <button disabled={pending} onClick={() => setRefresh(value => value + 1)}>시연 결과 다시 확인</button>
        </div>
        {view.phase === "WAITING" && <p>실행하려면 다른 운영자 계정이 위 주소를 열고 ‘이 운영자로 참가’를 눌러야 합니다. 시연을 만든 운영자는 이미 참가되어 있습니다.</p>}
        {view.phase === "READY" && !view.participating && <p>이 시연에 참가한 운영자 계정으로 로그인해야 실행할 수 있습니다.</p>}
        {terminal.includes(view.phase) && <p>이 시연은 종료되었습니다. 새로 실행하려면 우하단에서 ‘발급 실패·환불 미접수’ 주문을 생성해 이동하세요.</p>}
        <p>각 운영자가 등록한 조치를 서버에서 동시에 시작합니다. 주문 잠금 안에서 잔액과 기존 요청을 확인하며, 어느 운영자가 먼저 처리될지는 정해져 있지 않습니다. 부분 환불은 남은 금액이 충분하면 두 건 모두 처리합니다.</p>
        {view.participants.map(person => <article key={person.username}>
          <h3>{person.username} · {person.amount != null ? `부분 환불 ${money(person.amount)} KRW` : operation(person.operation)}</h3>
          <p>요청 키: <code>{person.key}</code></p>
          {person.result ? <>
            <p>접수 결과: <strong>{person.result.status} · {person.result.code}</strong> · {person.result.message}</p>
            {person.result.actionId && <p>실제 조치번호: {person.result.actionId} · 최초 처리자: {person.result.appliedBy}</p>}
            <p>호출 시작: {person.result.startedAt || "시작 실패"}<br />응답 확인: {person.result.finishedAt}</p>
          </> : <p>접수 결과 대기</p>}
        </article>)}
        <p>실제 DB 원장: 조치 <strong>{view.stats.actionCount}건</strong> · 환불 {view.stats.refundCount}건 · 새 발급 작업 {view.stats.retryCount}건</p>
        <p>주문액 {money(view.stats.orderAmount)} · 확정 환불 <strong>{money(view.stats.confirmedAmount)}</strong> · 미확정 예약 <strong>{money(view.stats.reservedAmount)}</strong> · 추가 환불 가능 <strong>{money(Math.max(0, view.stats.orderAmount - view.stats.confirmedAmount - view.stats.reservedAmount))}</strong> KRW</p>
        <p>모의 PG 취소 <strong>{view.stats.pgCancellations}건</strong> · 취소액 {money(view.stats.cancelledAmount)} KRW<br />
          모의 공급사 요청 {view.stats.supplierOrders}건 · 발급 실행 <strong>{view.stats.supplierIssues}회</strong> · 주문의 SIM {view.stats.profileCount}개</p>
        <p>접수 응답과 별도로 PG 취소 또는 공급사 발급까지 완료되어야 검증 통과입니다. 아래 운영자 조치 이력에서 최초 처리자와 사유를 확인할 수 있습니다.</p>
      </>}
    </>}
    {error && <p role="alert">{error}</p>}
    <p>시연 참가·결과 화면은 10분 동안 유지되며 서버 재시작 시 사라집니다. 실제 주문·환불·발급·조치 이력은 DB에 보관됩니다. 완료된 주문에서 다시 시연하려면 다른 발급 실패 주문을 선택하세요.</p>
  </section>;
}
