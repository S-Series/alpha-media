import Link from "next/link";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { getOrder } from "@/lib/orders-server";
import { orderStatus } from "@/lib/orders";
import { kst, money } from "@/lib/preview-data";
import PaymentPanel from "@/components/screens/payment-panel";

export default function OrderDetailPage(props: PageProps<"/mypage/orders/[orderId]">) {
  return <><h1>주문 상세</h1><Suspense fallback={<p>주문 조회 중…</p>}><OrderDetail {...props} /></Suspense></>;
}

async function OrderDetail({ params }: PageProps<"/mypage/orders/[orderId]">) {
  const { orderId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) notFound();
  const result = await getOrder(orderId);
  if (!result.ok) {
    if (result.status === 401) redirect("/login");
    if (result.status === 404) notFound();
    return <p role="alert">주문을 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.</p>;
  }
  const order = result.data;
  return (
    <>
      <section className="home-panel">
        <h2>{order.planName}</h2>
        <dl className="detail-list">
          <dt>주문번호</dt><dd>{order.id}</dd>
          <dt>상품 조건</dt><dd>{order.country} · {order.days}일 · {order.dataMb.toLocaleString("ko-KR")}MB · {order.simType}</dd>
          <dt>여행 시작일</dt><dd>{order.travelStartDate}</dd>
          <dt>주문 금액</dt><dd>{money(order.amount)} {order.currency}</dd>
          <dt>상태</dt><dd>{orderStatus(order.status)}</dd>
          <dt>생성 시각</dt><dd>{kst(order.createdAt)}</dd>
          <dt>유효 기한</dt><dd>{kst(order.expiresAt)}</dd>
        </dl>
        {order.status === "EXPIRED" && <p>주문이 만료됐습니다. 구매하려면 상품을 다시 선택해 새 주문을 생성해 주세요.</p>}
        <form action={`/mypage/orders/${order.id}`} method="get"><button type="submit">상태 다시 확인</button></form>
      </section>
      <PaymentPanel orderId={order.id} status={order.status} expiresAt={order.expiresAt} />
      <nav className="page-actions"><Link href="/mypage/orders">주문 내역</Link><Link href="/plans">요금제 선택</Link></nav>
    </>
  );
}
