import {
  kst,
  money,
  previewPlans,
  type PreviewOrder,
} from "@/lib/preview-data";

export default function OrderSummary({ order }: { order: PreviewOrder }) {
  const plan = previewPlans.find((item) => item.id === order.planId)!;
  return (
    <>
      <section className="home-panel">
        <h2>주문·처리 상태</h2>
        <dl className="detail-list">
          <dt>주문번호</dt>
          <dd>{order.id}</dd>
          <dt>상품</dt>
          <dd>{plan.name}</dd>
          <dt>여행 시작일</dt>
          <dd>{order.travelStartDate}</dd>
          <dt>결제 금액</dt>
          <dd>{money(plan.price)}</dd>
          <dt>결제</dt>
          <dd>{order.payment}</dd>
          <dt>발급</dt>
          <dd>{order.fulfillment}</dd>
          <dt>설치·개통</dt>
          <dd>{order.installation}</dd>
          <dt>환불</dt>
          <dd>{order.refund}</dd>
          <dt>마지막 확인</dt>
          <dd>{kst(order.updatedAt)} · 예시 시각</dd>
        </dl>
        {order.issue && <p role="status">확인 필요: {order.issue}</p>}
      </section>
      <section className="home-panel">
        <h2>처리 이력</h2>
        <ol className="timeline">
          {order.history.map((event) => (
            <li key={`${event.at}-${event.change}`}>
              <time dateTime={event.at}>{kst(event.at)}</time>
              <p>{event.change}</p>
              <p>
                실행자·신호: {event.actor} / 사유: {event.reason}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
