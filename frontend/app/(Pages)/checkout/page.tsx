import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import PreviewNotice from "@/components/screens/preview-notice";
import {
  money,
  previewOrders,
  previewPlans,
  queryText,
} from "@/lib/preview-data";

export default function CheckoutPage(props: PageProps<"/checkout">) {
  return (
    <>
      <h1>주문·결제</h1>
      <PreviewNotice />
      <Suspense fallback={<p>주문 조건 확인 중…</p>}>
        <Checkout {...props} />
      </Suspense>
    </>
  );
}

async function Checkout({ searchParams }: PageProps<"/checkout">) {
  const query = await searchParams;
  const orderId = queryText(query.orderId);
  const order = previewOrders.find((item) => item.id === orderId);
  if (orderId && !order) notFound();
  const planId = order?.planId || queryText(query.planId);
  const plan = previewPlans.find((item) => item.id === planId);
  if (planId && !plan) notFound();
  if (!plan)
    return (
      <p>
        먼저 <Link href="/plans">요금제를 선택해 주세요.</Link>
      </p>
    );
  return (
    <>
      <section className="home-panel">
        <h2>주문 조건</h2>
        <dl className="detail-list">
          <dt>상품</dt>
          <dd>{plan.name}</dd>
          <dt>여행 시작일</dt>
          <dd>
            {order?.travelStartDate ||
              queryText(query.travelStartDate) ||
              "미선택"}
          </dd>
          <dt>결제 예정 금액</dt>
          <dd>{money(plan.price)}</dd>
          <dt>주문번호</dt>
          <dd>{order?.id || "주문 생성 전"}</dd>
        </dl>
        <p>
          미결제 주문은 생성 후 10분 동안 유효합니다. 남은 시간은 주문 생성
          결과를 기준으로 표시합니다.
        </p>
        <div className="page-actions">
          <button type="button" disabled>
            주문 생성
          </button>
          <button type="button" disabled>
            결제하기
          </button>
        </div>
      </section>
      <section className="home-panel">
        <h2>주문 상태 화면 확인</h2>
        <p>다음 링크에서 예시 주문의 결제·발급 결과를 확인할 수 있습니다.</p>
        <Link href={`/mypage/orders/${order?.id || "order-pending"}`}>
          주문 상세 보기
        </Link>
      </section>
      <Link href={`/plans/${plan.id}`}>상품 상세로 돌아가기</Link>
    </>
  );
}
