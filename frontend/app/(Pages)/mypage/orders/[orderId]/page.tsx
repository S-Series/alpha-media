import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import PreviewNotice from "@/components/screens/preview-notice";
import OrderSummary from "@/components/screens/order-summary";
import { previewOrders } from "@/lib/preview-data";

export function generateStaticParams() {
  return previewOrders.map(({ id }) => ({ orderId: id }));
}

export default function OrderDetailPage(
  props: PageProps<"/mypage/orders/[orderId]">,
) {
  return (
    <>
      <h1>주문 상세</h1>
      <PreviewNotice />
      <Suspense fallback={<p role="status">주문 정보 확인 중…</p>}>
        <OrderDetail {...props} />
      </Suspense>
    </>
  );
}

async function OrderDetail({ params }: PageProps<"/mypage/orders/[orderId]">) {
  const { orderId } = await params;
  const order = previewOrders.find((item) => item.id === orderId);
  if (!order) notFound();
  return (
    <>
      <OrderSummary order={order} />
      <section className="home-panel">
        <h2>다음 행동</h2>
        {order.payment === "결제 대기" && (
          <p>
            미결제 주문의 유효 시간은 생성 후 10분입니다. 잔여 시간과 만료
            여부는 서버 확인 후 표시합니다.
          </p>
        )}
        {order.fulfillment === "발급 중" && (
          <p>
            발급이 지연되는 경우 상태를 다시 확인하거나 고객지원에 문의할 수
            있습니다.
          </p>
        )}
        <div className="page-actions">
          <button type="button" disabled>
            상태 다시 확인
          </button>
          {order.payment === "결제 대기" && (
            <Link href={`/checkout?orderId=${order.id}`}>결제 화면 확인</Link>
          )}
          {order.simId && (
            <Link href={`/mypage/sims/${order.simId}`}>SIM 상세 보기</Link>
          )}
          <Link href="/support">고객지원</Link>
        </div>
      </section>
      <section className="home-panel">
        <h2>환불</h2>
        <p>
          {order.installation === "개통"
            ? "설치·개통된 SIM은 환불할 수 없습니다."
            : "공급사의 최신 설치·개통 상태와 결제 내역을 확인한 뒤 환불 가능 여부를 안내합니다."}
        </p>
        <button type="button" disabled>
          환불 요청
        </button>
      </section>
      <Link href="/mypage/orders">주문 내역으로 돌아가기</Link>
    </>
  );
}
