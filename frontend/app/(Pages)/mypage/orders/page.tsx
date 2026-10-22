import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getOrders } from "@/lib/orders-server";
import { orderStatus } from "@/lib/orders";
import { kst, money, queryText } from "@/lib/format";

export default function OrdersPage(props: PageProps<"/mypage/orders">) {
  return <><h1>주문 내역</h1><Suspense fallback={<p>주문 조회 중…</p>}><Orders {...props} /></Suspense></>;
}

async function Orders({ searchParams }: PageProps<"/mypage/orders">) {
  const raw = queryText((await searchParams).page) || "0";
  const page = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(page) || page > 2147483647) return <p role="alert">잘못된 페이지입니다.</p>;
  const result = await getOrders(page);
  if (!result.ok) {
    if (result.status === 401) redirect("/login");
    return <p role="alert">주문을 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.</p>;
  }
  return (
    <>
      <div className="table-scroll"><table>
        <caption>내 주문 목록</caption>
        <thead><tr><th>주문·상품</th><th>금액</th><th>상태</th><th>생성 시각</th></tr></thead>
        <tbody>{result.data.items.map(order => <tr key={order.id}>
          <td><Link href={`/mypage/orders/${order.id}`}>{order.planName}</Link><br />{order.id}</td>
          <td>{money(order.amount)} {order.currency}</td><td>{orderStatus(order.status)}</td><td>{kst(order.createdAt)}</td>
        </tr>)}</tbody>
      </table></div>
      {result.data.items.length === 0 && <p>주문 내역이 없습니다.</p>}
      <nav className="page-actions" aria-label="주문 페이지">
        {page > 0 && <Link href={`/mypage/orders?page=${page - 1}`}>이전</Link>}
        {result.data.hasNext && <Link href={`/mypage/orders?page=${page + 1}`}>다음</Link>}
      </nav>
      <Link href="/plans">요금제 선택</Link>
    </>
  );
}
