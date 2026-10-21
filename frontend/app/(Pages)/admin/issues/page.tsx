import Link from "next/link";
import { previewOrders } from "@/lib/preview-data";
import OrderTable from "@/components/screens/order-table";

export default function AdminIssuesPage() {
  const issues = previewOrders.filter((order) => order.issue);
  return (
    <>
      <h1>이상 건 확인</h1>
      <p>
        발급 지연·환불 실패 예시입니다. 지연 시간과 재시도 한도는 운영 정책 확정
        후 적용합니다.
      </p>
      <OrderTable orders={issues} admin />
      {issues.map((order) => (
        <section key={order.id} className="home-panel">
          <h2>{order.issue}</h2>
          <Link href={`/admin/orders/${order.id}`}>
            {order.id} 확인 및 조치
          </Link>
        </section>
      ))}
    </>
  );
}
