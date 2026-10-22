"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/auth";
import { createOrder } from "@/lib/orders";

export default function OrderForm({ memberId, planId, travelStartDate, today }: {
  memberId: string; planId: string; travelStartDate: string; today: string;
}) {
  const router = useRouter();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [loginRequired, setLoginRequired] = useState(false);
  const [selectedDate, setSelectedDate] = useState(travelStartDate);
  const next = `/checkout?${new URLSearchParams({ planId, travelStartDate: selectedDate })}`;
  const loginUrl = `/login?${new URLSearchParams({ next })}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError("");
    setLoginRequired(false);
    const date = String(new FormData(event.currentTarget).get("travelStartDate") || "");
    // 미확인 요청은 새로고침 후에도 같은 키로 확인한다. 로그인 토큰은 저장하지 않는다.
    const storageKey = `alpha-media:pending-order:${memberId}:${planId}:${date}`;
    try {
      const key = sessionStorage.getItem(storageKey) || crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      const order = await createOrder(planId, date, key);
      sessionStorage.removeItem(storageKey);
      router.replace(`/mypage/orders/${order.id}`);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status < 500) {
        setError(error.message);
        setLoginRequired(error.status === 401);
      } else {
        setError("주문 결과를 확인하지 못했습니다. 같은 조건으로 다시 누르면 기존 요청 키로 확인합니다. 주문 내역에서도 확인할 수 있습니다.");
      }
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="screen-form home-panel">
      <label>여행 시작일
        <input name="travelStartDate" type="date" min={today} value={selectedDate}
          onChange={event => setSelectedDate(event.target.value)} required disabled={pending} />
      </label>
      <p>주문 생성만 진행합니다. 결제와 발급은 아직 실행되지 않습니다.</p>
      {error && <p role="alert">{error}</p>}
      {loginRequired && <Link href={loginUrl}>로그인 후 다시 주문하기</Link>}
      <button type="submit" disabled={pending}>{pending ? "주문 확인 중…" : "주문 생성"}</button>
      <Link href="/mypage/orders">주문 내역 확인</Link>
    </form>
  );
}
