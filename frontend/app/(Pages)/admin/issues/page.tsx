import { Suspense } from "react";
import { getAdminOrders } from "@/lib/admin-orders-server";
import OrderTable from "@/components/screens/order-table";

export default function AdminIssuesPage() {
  return <><h1>결과 확인이 필요한 주문</h1><p>결제 결과 불명, 발급 실패·운영자 확인 대상, 발급 대기 2분 초과, 환불 자동 확인 중단 주문입니다.</p>
    <Suspense fallback={<p>주문 조회 중…</p>}><Issues /></Suspense></>;
}

async function Issues() {
  const result = await getAdminOrders(new URLSearchParams({ needsReview: "true", size: "100" }));
  if (!result.ok) return <p role="alert">확인이 필요한 주문을 조회하지 못했습니다.</p>;
  return <><OrderTable orders={result.data.items} />{result.data.hasNext && <p>100건을 초과했습니다. 전체 주문 목록에서도 확인해 주세요.</p>}</>;
}
