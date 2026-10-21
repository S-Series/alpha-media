import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { previewOrders } from "@/lib/preview-data";
import OrderSummary from "@/components/screens/order-summary";

export function generateStaticParams() {
  return previewOrders.map(({ id }) => ({ orderId: id }));
}

export default function AdminOrderDetailPage(
  props: PageProps<"/admin/orders/[orderId]">,
) {
  return (
    <>
      <h1>운영자 주문 상세</h1>
      <Suspense fallback={<p role="status">주문 정보 확인 중…</p>}>
        <AdminOrderDetail {...props} />
      </Suspense>
    </>
  );
}

async function AdminOrderDetail({
  params,
}: PageProps<"/admin/orders/[orderId]">) {
  const { orderId } = await params;
  const order = previewOrders.find((item) => item.id === orderId);
  if (!order) notFound();
  return (
    <>
      <OrderSummary order={order} />
      <section className="home-panel">
        <h2>운영자 조치</h2>
        <div className="screen-form">
          <label>
            운영자
            <input value="연결 전" readOnly />
          </label>
          <label>
            조치 사유
            <textarea placeholder="수동 환불·발급 재시도 사유" />
          </label>
        </div>
        <div className="page-actions">
          <button type="button" disabled>
            수동 환불
          </button>
          <button type="button" disabled>
            발급 재시도
          </button>
          <button type="button" disabled>
            상태 다시 확인
          </button>
        </div>
        <p>
          재시도 횟수·다음 시도·실패 원인과 운영자 조치 이력이 표시될
          영역입니다.
        </p>
      </section>
      <nav className="page-actions" aria-label="주문 관련 화면">
        <Link href="/admin/orders">주문 목록</Link>
        <Link href="/admin/issues">이상 건</Link>
      </nav>
    </>
  );
}
