import { Suspense } from "react";
import { getAdminOrders } from "@/lib/admin-orders-server";
import OrderTable from "@/components/screens/order-table";
import { kst } from "@/lib/format";

export default function AdminIssuesPage() {
  return <><h1>결과 확인이 필요한 주문</h1><p>결제 결과 불명, 발급 실패·운영자 확인 대상, 발급 대기 2분 초과, 환불 자동 확인 중단, 공급사 설치 상태 확인 지연 주문입니다.</p>
    <Suspense fallback={<p>주문 조회 중…</p>}><Issues /></Suspense></>;
}

async function Issues() {
  const result = await getAdminOrders(new URLSearchParams({ needsReview: "true", size: "100" }));
  if (!result.ok) return <p role="alert">확인이 필요한 주문을 조회하지 못했습니다.</p>;
  return <><p>서버 조회 {result.data.checkedAt ? kst(result.data.checkedAt) : "조회 시각 확인 대기"}</p><OrderTable orders={result.data.items} />
    <form action="/admin/issues"><button>이상 건 다시 조회</button></form>
    {result.data.hasNext && <p>100건을 초과했습니다. 전체 주문 목록의 이상 건 필터와 페이지 이동을 사용해 주세요.</p>}</>;
}
