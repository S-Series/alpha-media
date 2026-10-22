"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiRequestError, post } from "@/lib/auth";
import { kst, money } from "@/lib/format";
import { orderStatus, type Order } from "@/lib/orders";
import { issuanceStatus } from "@/lib/issuance";

const scenarios = {
  PENDING_PAYMENT: { label: "결제 대기", detail: "결제 전 주문을 만듭니다. 고객 계정에서 승인·거절·응답 유실을 시연할 수 있습니다." },
  ISSUANCE_FAILED: { label: "발급 실패·환불 미접수", detail: "결제 승인 후 발급 실패가 확정된 주문입니다. 발급 재시도·환불·두 운영자 동시 조치를 시연할 수 있습니다." },
  ISSUED: { label: "발급 완료·미설치", detail: "발급 완료된 SIM을 만듭니다. 고객 계정에서 설치·개통·만료를 시연할 수 있습니다." },
  REFUNDED: { label: "환불 완료", detail: "발급 실패 후 전액 환불까지 완료합니다. PG 취소와 조치 이력을 확인할 수 있습니다." },
  REFUND_REVIEW_REQUIRED: { label: "환불 확인 필요", detail: "모의 PG 취소 장애로 3회 실패한 주문입니다. 새 조치 차단 시연용이며, 현재 환불 복구 기능은 없습니다." },
};
type Scenario = keyof typeof scenarios;
type Draft = { key: string; body: string };
type Options = { customers: { username: string; displayName: string }[];
  plans: { id: string; name: string; price: number }[] };
type Generation = { id: string; scenario: Scenario; createdBy: string; customer: string; planId: string; orderId: string;
  status: "GENERATING" | "READY" | "FAILED"; lastError: string | null; orderStatus: Order["status"];
  issuanceStatus: Parameters<typeof issuanceStatus>[0] | null; refundStatus: string | null; simId: string | null; createdAt: string; updatedAt: string };
const errors: Record<string, string> = { GENERATION_TIMEOUT: "10분 안에 목표 상태에 도달하지 못했습니다. 실제 주문 상태를 확인하세요.",
  OPERATOR_UNAVAILABLE: "생성을 요청한 계정의 운영자 권한을 확인할 수 없습니다.",
  SCENARIO_STATE_CHANGED: "주문 상태가 예상 흐름과 달라 생성을 중단했습니다. 실제 주문 이력을 확인하세요." };

export default function ScenarioGenerator({ operatorId }: { operatorId: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState(true);
  const [options, setOptions] = useState<Options | null>(null);
  const [scenario, setScenario] = useState<Scenario>("ISSUANCE_FAILED");
  const [customer, setCustomer] = useState("customer1");
  const [planId, setPlanId] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [optionsRefresh, setOptionsRefresh] = useState(0);
  const [restored, setRestored] = useState(false);
  const storage = `scenario-generator:${operatorId}`;
  const path = "/api/admin/scenarios";

  function show() {
    if (restored) { setOpen(true); return; }
    try {
      const saved = JSON.parse(sessionStorage.getItem(storage) || "null");
      if (saved && typeof saved.key === "string" && /^[0-9a-f-]{36}$/i.test(saved.key) && typeof saved.body === "string") {
        const body = JSON.parse(saved.body);
        if (body.scenario in scenarios && typeof body.customer === "string" && typeof body.planId === "string") {
          setDraft(saved); setScenario(body.scenario); setCustomer(body.customer); setPlanId(body.planId);
        }
      }
    } catch { /* Creation stays disabled until the request can be saved successfully. */ }
    setRestored(true);
    setOpen(true);
  }

  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`${path}/options`, { cache: "no-store", credentials: "same-origin",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if ([401, 403].includes(response.status)) { setAllowed(false); return; }
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "생성 옵션을 조회하지 못했습니다.");
        if (controller.signal.aborted) return;
        setOptions(data); setError("");
        setPlanId(current => current || data.plans[0]?.id || "");
      } catch (exception) {
        if (!controller.signal.aborted) setError(exception instanceof Error ? exception.message : "생성 옵션 조회에 실패했습니다.");
      }
    }
    void load();
    return () => controller.abort();
  }, [open, optionsRefresh]);

  const key = draft?.key;
  useEffect(() => {
    if (!key || !restored) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`${path}/${key}`, { cache: "no-store", credentials: "same-origin",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if ([401, 403].includes(response.status)) { setAllowed(false); return; }
        const data = await response.json();
        if (!response.ok) throw new ApiRequestError(response.status, data.message || "생성 결과 조회에 실패했습니다.");
        if (controller.signal.aborted) return;
        setGeneration(data); setLookupError("");
        if (data.status === "GENERATING") timer = setTimeout(poll, 1500);
      } catch (exception) {
        if (controller.signal.aborted) return;
        setLookupError(exception instanceof Error ? exception.message : "결과가 불명확합니다. 같은 요청으로 다시 확인하세요.");
        if (!(exception instanceof ApiRequestError && exception.status === 404)) timer = setTimeout(poll, 5000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, restored, refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !restored) return;
    busy.current = true; setPending(true); setError("");
    try {
      const request = draft || { key: crypto.randomUUID(), body: JSON.stringify({ scenario, customer, planId }) };
      // Save before sending; a lost response or reload must retain the original key and payload.
      try { sessionStorage.setItem(storage, JSON.stringify(request)); }
      catch { throw new Error("생성 요청 키를 저장하지 못했습니다. 브라우저 저장소 설정을 확인하세요. 새 요청은 보내지 않았습니다."); }
      setDraft(request);
      const response = await post(path, request.body, "application/json", { "Idempotency-Key": request.key });
      setGeneration(await response.json()); setLookupError("");
    } catch (exception) {
      if (exception instanceof ApiRequestError && [401, 403].includes(exception.status)) setAllowed(false);
      if (exception instanceof ApiRequestError && ["INVALID_REQUEST", "INVALID_DEMO_CUSTOMER", "INVALID_DEMO_PLAN", "PLAN_NOT_FOUND"].includes(exception.code || "")) {
        try { sessionStorage.removeItem(storage); setDraft(null); setLookupError(""); }
        catch { /* Retain the saved request until storage can be changed. */ }
      }
      setError(exception instanceof Error ? exception.message : "접수 결과가 불명확합니다. 같은 요청으로 다시 확인하세요.");
    } finally { busy.current = false; setPending(false); setRefresh(value => value + 1); }
  }

  function reset() {
    if (pending || generation?.status === "GENERATING") return;
    try { sessionStorage.removeItem(storage); } catch { setError("저장된 요청을 지우지 못했습니다."); return; }
    setDraft(null); setGeneration(null); setLookupError(""); setError("");
  }

  if (!allowed) return null;
  const finished = generation && generation.status !== "GENERATING";
  return <>
    <button type="button" className="scenario-fab" aria-haspopup="dialog" aria-controls="scenario-generator" onClick={show}>
      시나리오 데이터 생성
    </button>
    <dialog id="scenario-generator" className="scenario-dialog" ref={dialog} aria-labelledby="scenario-title"
      onCancel={() => setOpen(false)} onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="scenario-panel">
        <div className="sidebar-heading"><h2 id="scenario-title">시나리오 데이터 생성</h2>
          <button type="button" onClick={() => setOpen(false)} aria-label="시나리오 생성 닫기">×</button></div>
        <p>선택한 고객의 시연용 주문을 1건 생성합니다. 실제 카드 결제는 발생하지 않습니다.</p>
        <form className="screen-form" onSubmit={submit}>
          <label>시나리오 <select value={scenario} disabled={!!draft || pending} onChange={e => setScenario(e.target.value as Scenario)}>
            {Object.entries(scenarios).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
          </select></label>
          <p>{scenarios[scenario].detail}</p>
          <label>고객 <select value={customer} disabled={!!draft || pending || !options} onChange={e => setCustomer(e.target.value)} required>
            {options?.customers.map(item => <option key={item.username} value={item.username}>{item.displayName} ({item.username})</option>)}
          </select></label>
          <label>상품 <select value={planId} disabled={!!draft || pending || !options} onChange={e => setPlanId(e.target.value)} required>
            {options?.plans.map(item => <option key={item.id} value={item.id}>{item.name} · {money(item.price)} KRW</option>)}
          </select></label>
          <button type="submit" disabled={pending || !restored || (!draft && (!options || !planId || !customer))}>
            {pending ? "접수 확인 중…" : draft ? "같은 생성 요청으로 접수 확인" : "1건 생성"}
          </button>
        </form>
        {!options && <button type="button" onClick={() => setOptionsRefresh(value => value + 1)}>생성 옵션 다시 조회</button>}
        {error && <p role="alert">{error}</p>}{lookupError && <p role="alert">{lookupError}</p>}
        {draft && <p>생성 요청 키: <code>{draft.key}</code><br />다시 접수해도 같은 주문을 반환합니다. 창을 닫아도 처리는 계속됩니다.</p>}
        {generation && <>
          <p role="status"><strong>{generation.status === "READY" ? "생성 완료" : generation.status === "FAILED" ? "목표 상태 생성 중단" : "기존 결제·발급·환불 흐름 처리 중"}</strong></p>
          <p>{scenarios[generation.scenario].label} · {generation.customer}<br />생성 운영자: {generation.createdBy}<br />
            주문: {orderStatus(generation.orderStatus)}{generation.issuanceStatus && <> · 발급: {issuanceStatus(generation.issuanceStatus)}</>}
            {generation.refundStatus && <><br />환불: {generation.refundStatus === "REVIEW_REQUIRED" ? "확인 필요, 새 조치 차단" : generation.refundStatus === "SUCCEEDED" ? "환불 완료" : "처리 중"}</>}</p>
          <p>주문번호: <code>{generation.orderId}</code><br />생성: {kst(generation.createdAt)} · 마지막 변경: {kst(generation.updatedAt)}</p>
          {generation.lastError && <p role="alert">{errors[generation.lastError] || generation.lastError}</p>}
          <div className="page-actions"><Link href={`/admin/orders/${generation.orderId}`} onClick={() => setOpen(false)}>주문 상세로 이동</Link>
            <button type="button" onClick={() => setRefresh(value => value + 1)}>생성 결과 다시 조회</button>
            {finished && <button type="button" disabled={pending} onClick={reset}>새 시나리오 준비</button>}
          </div>
        </>}
      </div>
    </dialog>
  </>;
}
