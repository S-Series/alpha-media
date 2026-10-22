import Link from "next/link";
import type { AdminOrder } from "@/lib/admin-orders-server";
import { orderStatus } from "@/lib/orders";
import { kst, money } from "@/lib/format";

export default function OrderTable({ orders }: { orders: AdminOrder[] }) {
  if (orders.length === 0) return <p>조회된 주문이 없습니다.</p>;
  return <div className="table-scroll"><table>
    <thead><tr><th>주문번호</th><th>고객</th><th>상품</th><th>금액</th><th>상태</th><th>마지막 변경</th></tr></thead>
    <tbody>{orders.map(({ order, customerUsername }) => <tr key={order.id}>
      <td><Link href={`/admin/orders/${order.id}`}>{order.id}</Link></td><td>{customerUsername}</td>
      <td>{order.planName}</td><td>{money(order.amount)}</td><td>{orderStatus(order.status)}</td><td>{kst(order.updatedAt)}</td>
    </tr>)}</tbody>
  </table></div>;
}
