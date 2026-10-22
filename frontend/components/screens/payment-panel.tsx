"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiRequestError } from "@/lib/auth";
import type { Order } from "@/lib/orders";
import { acceptPayment, paymentStatus, type PaymentAttempt, type PaymentScenario } from "@/lib/payments";

export default function PaymentPanel({ orderId, status, expiresAt }: Pick<Order, "status" | "expiresAt"> & { orderId: string }) {
  const router = useRouter();
  const [scenario, setScenario] = useState<PaymentScenario>("APPROVE");
  const [latest, setLatest] = useState<PaymentAttempt | null>(null);
  const [pending, setPending] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState("");
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  const refreshed = useRef("");
  const active = latest && ["QUEUED", "PROCESSING", "UNKNOWN", "REVIEW_REQUIRED"].includes(latest.status);

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
      const intent: { key: string; scenario: PaymentScenario } = saved ? JSON.parse(saved) : { key: crypto.randomUUID(), scenario };
      // 네트워크 오류 후에는 선택을 바꾸더라도 기존 결제 의도와 키로만 재접수한다.
      sessionStorage.setItem(storageKey, JSON.stringify(intent));
      const payment = await acceptPayment(orderId, intent.key, intent.scenario);
      sessionStorage.removeItem(storageKey);
      setLatest(payment); setAmbiguous(false); setRevision(value => value + 1);
      router.refresh();
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.status < 500) {
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
    <p>실제 카드 결제는 발생하지 않습니다. 승인 결과 웹훅은 같은 내용으로 두 번 전송합니다.</p>
    <p>새 결제 접수 기한: {new Date(expiresAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (KST)</p>
    {status === "PAID" && <p>결제가 완료됐습니다. 발급 기능은 아직 연결되지 않았습니다.</p>}
    {status === "PAYMENT_PROCESSING" && <p>기존 결제 결과를 확인 중입니다. 새 결제를 시작할 수 없습니다.</p>}
    {status === "EXPIRED" && <p>주문이 만료되어 새 결제를 시작할 수 없습니다.</p>}
    {latest && <p aria-live="polite">최근 결제: {paymentStatus(latest.status)} · PG 확인 {latest.attemptCount}회<br />결제번호: {latest.id}</p>}
    {latest?.status === "DECLINED" && <p>거절이 확인됐습니다. 주문 유효시간이 남아 있으면 다시 결제할 수 있습니다.</p>}
    {latest?.status === "REVIEW_REQUIRED" && <p role="alert">자동 확인이 중단됐습니다. 운영자 확인 전까지 새 결제는 차단됩니다.</p>}
    {checkedAt && <p>마지막 조회: {checkedAt} · 처리 중 1.5초 간격 갱신</p>}
    <label>시연 상황 <select value={scenario} disabled={pending || ambiguous || status !== "PENDING_PAYMENT" || Boolean(active)}
      onChange={event => setScenario(event.target.value as PaymentScenario)}>
      <option value="APPROVE">승인 성공</option><option value="DECLINE">승인 거절</option><option value="RESPONSE_LOST">승인 후 응답 유실</option>
    </select></label>{" "}
    <button type="button" disabled={pending || status !== "PENDING_PAYMENT" || Boolean(active)} onClick={pay}>
      {pending ? "접수 중…" : ambiguous ? "같은 결제 요청 확인" : "모의 결제 요청"}
    </button>{" "}
    <button type="button" onClick={() => { setError(""); setRevision(value => value + 1); router.refresh(); }}>결과 다시 조회</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
