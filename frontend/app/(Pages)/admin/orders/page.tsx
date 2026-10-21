import Link from "next/link";
import { Suspense } from "react";
import OrderTable from "@/components/screens/order-table";
import { previewOrders, previewPlans, queryText } from "@/lib/preview-data";

export default function AdminOrdersPage(props: PageProps<"/admin/orders">) {
  return (
    <>
      <h1>운영자 주문 목록</h1>
      <Suspense fallback={<p>주문 목록 확인 중…</p>}>
        <Orders {...props} />
      </Suspense>
    </>
  );
}

async function Orders({ searchParams }: PageProps<"/admin/orders">) {
  const query = await searchParams;
  const payment = queryText(query.payment),
    fulfillment = queryText(query.fulfillment),
    installation = queryText(query.installation),
    simType = queryText(query.simType);
  const from = queryText(query.from),
    to = queryText(query.to);
  const filtered = previewOrders.filter((order) => {
    const plan = previewPlans.find((item) => item.id === order.planId)!;
    const date = new Date(Date.parse(order.updatedAt) + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    return (
      (!payment || order.payment === payment) &&
      (!fulfillment || order.fulfillment === fulfillment) &&
      (!installation || order.installation === installation) &&
      (!simType || plan.simType === simType) &&
      (!from || date >= from) &&
      (!to || date <= to)
    );
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / 3));
  const requested = Number(queryText(query.page));
  const page =
    Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, pageCount)
      : 1;
  function pageHref(next: number) {
    const params = new URLSearchParams({
      payment,
      fulfillment,
      installation,
      simType,
      from,
      to,
      page: String(next),
    });
    return `/admin/orders?${params}`;
  }
  return (
    <>
      <form
        key={JSON.stringify([
          payment,
          fulfillment,
          installation,
          simType,
          from,
          to,
        ])}
        action="/admin/orders"
        method="get"
        className="screen-form home-panel"
      >
        <label>
          결제 상태
          <select name="payment" defaultValue={payment}>
            <option value="">전체</option>
            <option>결제 대기</option>
            <option>승인 완료</option>
          </select>
        </label>
        <label>
          발급 상태
          <select name="fulfillment" defaultValue={fulfillment}>
            <option value="">전체</option>
            {[
              "발급 대기",
              "발급 중",
              "발급 완료",
              "공항 수령 대기",
              "발급 실패",
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          설치 상태
          <select name="installation" defaultValue={installation}>
            <option value="">전체</option>
            {["미발급", "미설치", "미등록", "개통"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          SIM 종류
          <select name="simType" defaultValue={simType}>
            <option value="">전체</option>
            <option value="ESIM">eSIM</option>
            <option value="USIM">USIM</option>
          </select>
        </label>
        <label>
          마지막 확인일 시작
          <input type="date" name="from" defaultValue={from} />
        </label>
        <label>
          종료
          <input type="date" name="to" defaultValue={to} />
        </label>
        <button type="submit">조회</button>
        <Link href="/admin/orders">필터 초기화</Link>
      </form>
      <p>
        예시 주문 {filtered.length}건 · {page} / {pageCount}페이지
      </p>
      <OrderTable orders={filtered.slice((page - 1) * 3, page * 3)} admin />
      <nav className="page-actions" aria-label="주문 페이지 이동">
        {page > 1 && <Link href={pageHref(page - 1)}>이전</Link>}
        {page < pageCount && <Link href={pageHref(page + 1)}>다음</Link>}
      </nav>
    </>
  );
}
