"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiRequestError } from "@/lib/auth";
import type { Order } from "@/lib/orders";
import { acceptPayment, paymentStatus, type PaymentAttempt, type PaymentScenario, type PaymentSimulation } from "@/lib/payments";
import { defaultIssuanceSimulation, type IssuanceSimulation } from "@/lib/issuance";

export default function PaymentPanel({ orderId, status, expiresAt }: Pick<Order, "status" | "expiresAt"> & { orderId: string }) {
  const router = useRouter();
  const [scenario, setScenario] = useState<PaymentScenario>("APPROVE");
  const [webhookDelaySeconds, setWebhookDelaySeconds] = useState(1);
  const [webhookCopies, setWebhookCopies] = useState(2);
  const [issuance, setIssuance] = useState<IssuanceSimulation>(defaultIssuanceSimulation);
  const [latest, setLatest] = useState<PaymentAttempt | null>(null);
  const [pending, setPending] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState("");
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  const refreshed = useRef("");
  const active = latest && latest.status !== "DECLINED";

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/payment-attempts`,
          { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new ApiRequestError(response.status,
          response.status === 401 ? "로그인 후 주문을 다시 확인해 주세요." : "결제 상태를 조회하지 못했습니다.");
        const attempts: PaymentAttempt[] = await response.json();
        const payment = attempts[0] ?? null;
        setLatest(payment);
        setCheckedAt(new Date().toLocaleTimeString("ko-KR"));
        if (payment) {
          if (payment.status !== "DECLINED") {
            setScenario(payment.scenario);
            setWebhookCopies(payment.webhookCopies);
            setWebhookDelaySeconds(payment.webhookDelayMs / 1000);
            setIssuance(payment.issuance ?? defaultIssuanceSimulation);
          }
          const marker = `${payment.id}:${payment.status}`;
          if (["APPROVED", "DECLINED"].includes(payment.status) && refreshed.current !== marker) {
            refreshed.current = marker;
            router.refresh();
          }
        }
        if (payment && ["QUEUED", "PROCESSING", "UNKNOWN"].includes(payment.status)) {
          timer = setTimeout(poll, 1500);
        } else if (!payment && status === "PAYMENT_PROCESSING") {
          timer = setTimeout(poll, 1500);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : "결제 상태 조회에 실패했습니다.");
          // 조회 실패는 결제 거절이 아니다. 주문이 처리 중이면 조회만 재시도한다.
          if (status === "PAYMENT_PROCESSING" && !(failure instanceof ApiRequestError && failure.status === 401)) {
            timer = setTimeout(poll, 3000);
          }
        }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [orderId, status, revision, router]);

  async function pay() {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError("");
    const storageKey = `payment:${orderId}`;
    try {
      const saved = sessionStorage.getItem(storageKey);
      const intent: PaymentSimulation & { key: string } = saved ? JSON.parse(saved) : {
        key: crypto.randomUUID(), scenario, webhookCopies, webhookDelayMs: webhookDelaySeconds * 1000, issuance,
      };
      // 이전 화면에서 저장한 요청도 당시의 고정 설정으로 재전송한다.
      intent.webhookCopies ??= 2;
      intent.webhookDelayMs ??= intent.scenario === "RESPONSE_LOST" ? 6000 : 1000;
      intent.issuance ??= defaultIssuanceSimulation;
      setScenario(intent.scenario);
      setWebhookCopies(intent.webhookCopies);
      setWebhookDelaySeconds(intent.webhookDelayMs / 1000);
      setIssuance(intent.issuance);
      // 응답 유실 후에는 키뿐 아니라 지연·중복 설정도 그대로 유지한다.
      sessionStorage.setItem(storageKey, JSON.stringify(intent));
      const payment = await acceptPayment(orderId, intent.key, {
        scenario: intent.scenario, webhookCopies: intent.webhookCopies, webhookDelayMs: intent.webhookDelayMs, issuance: intent.issuance,
      });
      sessionStorage.removeItem(storageKey);
      setLatest(payment); setAmbiguous(false); setRevision(value => value + 1);
      router.refresh();
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.code === "PAYMENTS_UNAVAILABLE") {
        sessionStorage.removeItem(storageKey);
        setAmbiguous(false);
        setError(failure.message);
      } else if (failure instanceof ApiRequestError && failure.status < 500) {
        setError(failure.message);
        if (failure.status === 409) { setRevision(value => value + 1); router.refresh(); }
      } else {
        setAmbiguous(true);
        setError("접수 결과를 확인하지 못했습니다. 다시 누르면 같은 요청 키로 기존 결제를 확인합니다.");
      }
    } finally { inFlight.current = false; setPending(false); }
  }

  return <section className="home-panel">
    <h2>모의 결제</h2>
    <p>실제 카드 결제는 발생하지 않습니다. 모의 PG의 승인 결과와 웹훅 전송 조건을 조절할 수 있습니다.</p>
    <p>새 결제 접수 기한: {new Date(expiresAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (KST)</p>
    {status === "PAID" && <p>결제가 완료됐습니다. 서버가 발급 작업을 이어서 처리합니다.</p>}
    {status === "REFUND_PROCESSING" && <p>전액 환불 결과를 확인 중입니다. 새 결제는 차단됩니다.</p>}
    {status === "PARTIALLY_REFUNDED" && <p>부분 환불이 완료됐습니다.</p>}
    {status === "REFUNDED" && <p>전액 환불이 완료됐습니다.</p>}
    {status === "PAYMENT_PROCESSING" && <p>기존 결제 결과를 확인 중입니다. 새 결제를 시작할 수 없습니다.</p>}
    {status === "EXPIRED" && <p>주문이 만료되어 새 결제를 시작할 수 없습니다.</p>}
    {latest && <p aria-live="polite">최근 결제: {paymentStatus(latest.status)} · PG 확인 {latest.attemptCount}회<br />결제번호: {latest.id}</p>}
    {latest && <p>접수한 설정: {latest.scenario === "APPROVE" ? "승인 성공" : latest.scenario === "DECLINE" ? "승인 거절" : "승인 후 응답 유실"}
      {" · "}웹훅 지연 {latest.webhookDelayMs / 1000}초 · 총 {latest.webhookCopies}회 전송</p>}
    {latest?.status === "DECLINED" && <p>거절이 확인됐습니다. 주문 유효시간이 남아 있으면 다시 결제할 수 있습니다.</p>}
    {latest?.status === "REVIEW_REQUIRED" && <p role="alert">자동 확인이 중단됐습니다. 운영자 확인 전까지 새 결제는 차단됩니다.</p>}
    {checkedAt && <p>마지막 조회: {checkedAt} · 처리 중 1.5초 간격 갱신</p>}
    <fieldset disabled={pending || ambiguous || status !== "PENDING_PAYMENT" || Boolean(active)}>
      <legend>새 결제 시연 설정</legend>
      <p><label>시연 상황 <select value={scenario} onChange={event => setScenario(event.target.value as PaymentScenario)}>
        <option value="APPROVE">승인 성공</option><option value="DECLINE">승인 거절</option><option value="RESPONSE_LOST">승인 후 응답 유실</option>
      </select></label></p>
      <p><label htmlFor="webhook-delay">웹훅 지연: {webhookDelaySeconds}초</label><br />
        <input id="webhook-delay" type="range" min={0} max={60} step={1} value={webhookDelaySeconds}
          aria-valuetext={`${webhookDelaySeconds}초`} onChange={event => setWebhookDelaySeconds(Number(event.target.value))} />
        {" "}0~60초</p>
      <p><label htmlFor="webhook-copies">웹훅 전송 횟수: {webhookCopies}회</label><br />
        <input id="webhook-copies" type="range" min={0} max={20} step={1} value={webhookCopies}
          aria-valuetext={`총 ${webhookCopies}회, 중복 ${Math.max(0, webhookCopies - 1)}회`}
          onChange={event => setWebhookCopies(Number(event.target.value))} />{" "}0~20회</p>
      <p>{webhookCopies === 0 ? "웹훅 누락: API 응답이나 PG 결과 조회로 결제를 확인합니다."
        : `최초 통지 1회 + 중복 통지 ${webhookCopies - 1}회입니다. 지연은 첫 통지까지의 시간입니다.`}</p>
      <p>웹훅 지연은 승인 API 응답을 늦추지 않습니다. 응답 유실은 웹훅 또는 같은 결제번호의 결과 조회로 복구합니다.</p>
      {scenario === "RESPONSE_LOST" && <p>웹훅이 먼저 오면 바로 승인 완료로 바뀔 수 있습니다. 조회로 복구되는 과정을 보려면 전송 횟수를 0회로 설정해 주세요.</p>}
      <h3>결제 승인 후 모의 공급사 동작</h3>
      <p><label>발급 결과 <select value={issuance.scenario}
        onChange={event => setIssuance(value => ({ ...value, scenario: event.target.value as IssuanceSimulation["scenario"] }))}>
        <option value="SUCCEED">발급 성공</option><option value="FAIL">발급 실패</option>
      </select></label></p>
      <p><label htmlFor="supplier-callback-delay">발급 콜백 지연: {issuance.callbackDelayMs / 1000}초</label><br />
        <input id="supplier-callback-delay" type="range" min={0} max={60} step={1} value={issuance.callbackDelayMs / 1000}
          aria-valuetext={`${issuance.callbackDelayMs / 1000}초`}
          onChange={event => setIssuance(value => ({ ...value, callbackDelayMs: Number(event.target.value) * 1000 }))} />{" "}0~60초</p>
      <p><label htmlFor="supplier-callback-copies">발급 콜백 전송 횟수: {issuance.callbackCopies}회</label><br />
        <input id="supplier-callback-copies" type="range" min={0} max={20} step={1} value={issuance.callbackCopies}
          aria-valuetext={`총 ${issuance.callbackCopies}회, 중복 ${Math.max(0, issuance.callbackCopies - 1)}회`}
          onChange={event => setIssuance(value => ({ ...value, callbackCopies: Number(event.target.value) }))} />{" "}0~20회</p>
      <p>{issuance.callbackCopies === 0 ? "발급 콜백을 보내지 않습니다. 서버가 공급사 결과 조회로 복구합니다."
        : `발급 결과 준비 후 ${issuance.callbackDelayMs / 1000}초 뒤 최초 콜백 1회 + 중복 ${issuance.callbackCopies - 1}회를 보냅니다.`}</p>
      <p>설정은 결제 접수 시 함께 고정됩니다. 브라우저를 닫아도 발급은 계속되며, 콜백이 늦거나 빠지면 서버가 결과를 조회합니다.</p>
    </fieldset>
    {ambiguous && <p>접수 결과를 확인할 때까지 처음 선택한 시연 설정을 유지합니다.</p>}
    <button type="button" disabled={pending || status !== "PENDING_PAYMENT" || Boolean(active)} onClick={pay}>
      {pending ? "접수 중…" : ambiguous ? "같은 결제 요청 확인" : "모의 결제 요청"}
    </button>{" "}
    <button type="button" onClick={() => { setError(""); setRevision(value => value + 1); router.refresh(); }}>결과 다시 조회</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
