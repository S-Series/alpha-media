import type { Order } from "@/lib/orders";
import { orderStatus } from "@/lib/orders";
import { kst, money } from "@/lib/format";

export default function OrderSummary({ order }: { order: Order }) {
  return <section className="home-panel"><h2>{order.planName}</h2><dl className="detail-list">
    <dt>주문번호</dt><dd>{order.id}</dd><dt>여행 시작일</dt><dd>{order.travelStartDate}</dd>
    <dt>금액</dt><dd>{money(order.amount)} {order.currency}</dd><dt>상태</dt><dd>{orderStatus(order.status)}</dd>
    <dt>생성 시각</dt><dd>{kst(order.createdAt)}</dd><dt>마지막 변경</dt><dd>{kst(order.updatedAt)}</dd>
  </dl></section>;
}
