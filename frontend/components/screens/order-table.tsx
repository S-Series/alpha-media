import Link from "next/link";
import type { AdminOrder } from "@/lib/admin-orders-server";
import { orderStatus } from "@/lib/orders";
import { kst, money } from "@/lib/format";
import { issuanceStatus, simStatus } from "@/lib/issuance";
import { paymentStatus } from "@/lib/payments";

export default function OrderTable({ orders }: { orders: AdminOrder[] }) {
  if (orders.length === 0) return <p>조회된 주문이 없습니다.</p>;
  return <div className="table-scroll"><table>
    <thead><tr><th>주문번호</th><th>고객</th><th>상품</th><th>금액</th><th>주문 상태</th><th>최근 결제</th><th>발급 상태</th><th>설치·사용 상태</th><th>주문 마지막 변경</th></tr></thead>
    <tbody>{orders.map(({ order, customerUsername, issuanceStatus: deliveryStatus, issuanceError, paymentStatus: payStatus, installStatus, lastSyncedAt, syncError }) => <tr key={order.id}>
      <td><Link href={`/admin/orders/${order.id}`}>{order.id}</Link></td><td>{customerUsername}</td>
      <td>{order.planName}</td><td>{money(order.amount)}</td><td>{orderStatus(order.status)}</td>
      <td>{payStatus === "NOT_STARTED" ? "결제 전" : paymentStatus(payStatus)}</td>
      <td>{deliveryStatus ? issuanceStatus(deliveryStatus) : "발급 전"}{issuanceError && <><br /><small>{issuanceError}</small></>}</td>
      <td>{installStatus === "NOT_ISSUED" ? "SIM 없음" : simStatus(installStatus)}
        {lastSyncedAt && <><br /><small>공급사 확인 {kst(lastSyncedAt)}</small></>}
        {syncError && <><br /><small>공급사 확인 지연: {syncError}</small></>}</td>
      <td>{kst(order.updatedAt)}</td>
    </tr>)}</tbody>
  </table></div>;
}
