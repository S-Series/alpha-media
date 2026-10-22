import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getAdminOrder } from "@/lib/admin-orders-server";
import { kst } from "@/lib/format";
import { paymentStatus } from "@/lib/payments";
import OrderSummary from "@/components/screens/order-summary";

export default function AdminOrderDetailPage(props: PageProps<"/admin/orders/[orderId]">) {
  return <><h1>운영자 주문 상세</h1><Suspense fallback={<p>주문 조회 중…</p>}><Detail {...props} /></Suspense></>;
}

async function Detail({ params }: PageProps<"/admin/orders/[orderId]">) {
  const { orderId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) notFound();
  const result = await getAdminOrder(orderId);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <p role="alert">주문을 조회하지 못했습니다.</p>;
  }
  return <>
    <p>고객: {result.data.order.customerUsername}</p><OrderSummary order={result.data.order.order} />
    <section className="home-panel"><h2>결제 시도</h2><p>최근 최대 20건을 표시합니다.</p>
      {result.data.payments.length === 0 ? <p>아직 결제 시도가 없습니다.</p> : result.data.payments.map(payment => <article key={payment.id}>
        <h3>{paymentStatus(payment.status)}</h3><p>결제번호: {payment.id}</p>
        <p>PG 확인 {payment.attemptCount}회 · 마지막 변경 {kst(payment.updatedAt)}</p>
        {payment.lastError && <p>확인 사유: {payment.lastError}</p>}
      </article>)}
    </section>
    <p>발급·설치·환불 처리와 운영자 조치는 아직 연결되지 않았습니다.</p>
    <form action={`/admin/orders/${orderId}`} method="get"><button type="submit">상태 다시 확인</button></form>
    <Link href="/admin/orders">주문 목록</Link>
  </>;
}
