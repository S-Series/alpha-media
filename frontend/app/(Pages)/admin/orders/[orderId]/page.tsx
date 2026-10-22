import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getAdminOrder } from "@/lib/admin-orders-server";
import AdminOrderActions from "@/components/screens/admin-order-actions";

export default function AdminOrderDetailPage(props: PageProps<"/admin/orders/[orderId]">) {
  return <><h1>운영자 주문 상세</h1><Suspense fallback={<p>주문 조회 중…</p>}><Detail {...props} /></Suspense></>;
}

async function Detail({ params }: PageProps<"/admin/orders/[orderId]">) {
  const { orderId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) notFound();
  const result = await getAdminOrder(orderId);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <p role="alert">주문을 조회하지 못했습니다.</p>;
  }
  return <>
    <p>고객: {result.data.order.customerUsername}</p>
    <AdminOrderActions key={orderId} initial={result.data} />
    <form action={`/admin/orders/${orderId}`} method="get"><button type="submit">상태 다시 확인</button></form>
    <Link href="/admin/orders">주문 목록</Link>
  </>;
}
