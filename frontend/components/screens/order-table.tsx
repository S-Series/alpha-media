import Link from "next/link";
import {
  kst,
  money,
  previewPlans,
  type PreviewOrder,
} from "@/lib/preview-data";

export default function OrderTable({
  orders,
  admin = false,
}: {
  orders: PreviewOrder[];
  admin?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table>
        <caption>{admin ? "운영자 주문 목록" : "내 주문 목록"}</caption>
        <thead>
          <tr>
            <th scope="col">주문</th>
            <th scope="col">상품·금액</th>
            <th scope="col">결제</th>
            <th scope="col">발급·설치</th>
            <th scope="col">환불</th>
            <th scope="col">마지막 확인</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const plan = previewPlans.find((item) => item.id === order.planId)!;
            return (
              <tr key={order.id}>
                <td>
                  <Link
                    href={`${admin ? "/admin/orders" : "/mypage/orders"}/${order.id}`}
                  >
                    {order.id}
                  </Link>
                </td>
                <td>
                  {plan.name}
                  <br />
                  {money(plan.price)}
                </td>
                <td>{order.payment}</td>
                <td>
                  {order.fulfillment}
                  <br />
                  {order.installation}
                </td>
                <td>{order.refund}</td>
                <td>{kst(order.updatedAt)}</td>
              </tr>
            );
          })}
          {orders.length === 0 && (
            <tr>
              <td colSpan={6}>조건에 맞는 예시 주문이 없습니다.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
