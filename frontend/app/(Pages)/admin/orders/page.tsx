import Link from "next/link";
import { Suspense } from "react";
import OrderTable from "@/components/screens/order-table";
import { getAdminOrders } from "@/lib/admin-orders-server";
import { queryText, kst } from "@/lib/format";

export default function AdminOrdersPage(props: PageProps<"/admin/orders">) {
  return <><h1>운영자 주문 목록</h1><Suspense fallback={<p>주문 조회 중…</p>}><Orders {...props} /></Suspense></>;
}

async function Orders({ searchParams }: PageProps<"/admin/orders">) {
  const query = await searchParams;
  const pageValue = Number(queryText(query.page));
  const page = Number.isSafeInteger(pageValue) && pageValue >= 0 ? pageValue : 0;
  const filters = new URLSearchParams({ page: String(page), size: "20" });
  for (const key of ["status", "simType", "from", "to", "paymentStatus", "issuanceStatus", "installStatus", "needsReview"]) {
    const value = queryText(query[key]); if (value) filters.set(key, value);
  }
  const result = await getAdminOrders(filters);
  function href(next: number) { const params = new URLSearchParams(filters); params.set("page", String(next)); return `/admin/orders?${params}`; }
  return <>
    <form action="/admin/orders" method="get" className="screen-form home-panel">
      <label>주문 상태 <select name="status" defaultValue={queryText(query.status)}>
        <option value="">전체</option><option value="PENDING_PAYMENT">결제 대기</option>
        <option value="PAYMENT_PROCESSING">결제 확인 중</option><option value="PAID">결제 완료</option><option value="EXPIRED">만료</option>
        <option value="REFUND_PROCESSING">환불 확인 중</option><option value="REFUNDED">환불 완료</option>
      </select></label>
      <label>최근 결제 상태 <select name="paymentStatus" defaultValue={queryText(query.paymentStatus)}>
        <option value="">전체</option><option value="NOT_STARTED">결제 전</option><option value="QUEUED">접수</option>
        <option value="PROCESSING">승인 확인 중</option><option value="UNKNOWN">결과 불명</option><option value="APPROVED">승인</option>
        <option value="DECLINED">거절</option><option value="REVIEW_REQUIRED">운영자 확인 필요</option>
      </select></label>
      <label>발급 상태 <select name="issuanceStatus" defaultValue={queryText(query.issuanceStatus)}>
        <option value="">전체</option><option value="NOT_STARTED">발급 전</option><option value="QUEUED">접수</option>
        <option value="PROCESSING">요청 중</option><option value="WAITING_CALLBACK">결과 대기</option><option value="ISSUED">발급 완료</option>
        <option value="FAILED">발급 실패</option><option value="REVIEW_REQUIRED">운영자 확인 필요</option>
      </select></label>
      <label>설치·사용 상태 <select name="installStatus" defaultValue={queryText(query.installStatus)}>
        <option value="">전체</option><option value="NOT_ISSUED">SIM 없음</option><option value="ISSUED">발급 완료·미설치</option>
        <option value="QR_VIEWED">활성화 정보 열람</option><option value="INSTALLED">설치 완료</option><option value="ACTIVE">개통·사용 중</option>
        <option value="EXPIRED">사용 기간 만료</option><option value="DELETED">프로필 삭제</option>
      </select></label>
      <label>SIM 종류 <select name="simType" defaultValue={queryText(query.simType)}><option value="">전체</option>
        <option value="ESIM">eSIM</option><option value="USIM">USIM</option></select></label>
      <label>주문일 시작 (KST)<input type="date" name="from" defaultValue={queryText(query.from)} /></label>
      <label>종료 (KST)<input type="date" name="to" defaultValue={queryText(query.to)} /></label>
      <label><input type="checkbox" name="needsReview" value="true" defaultChecked={queryText(query.needsReview) === "true"} />확인이 필요한 주문만</label>
      <button type="submit">조회</button><Link href="/admin/orders">필터 초기화</Link>
    </form>
    {!result.ok ? <p role="alert">주문을 조회하지 못했습니다. 필터와 서버 연결을 확인해 주세요.</p> : <>
      <p>서버 조회 {result.data.checkedAt ? kst(result.data.checkedAt) : "조회 시각 확인 대기"} · {result.data.page + 1}페이지 · 페이지당 최대 20건. 조회 버튼으로 갱신합니다.</p><OrderTable orders={result.data.items} />
      <nav className="page-actions">{page > 0 && <Link href={href(page - 1)}>이전</Link>}
        {result.data.hasNext && <Link href={href(page + 1)}>다음</Link>}</nav>
    </>}
  </>;
}
