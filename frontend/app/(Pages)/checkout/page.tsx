import Link from "next/link";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import OrderForm from "@/components/screens/order-form";
import { getCurrentMember } from "@/lib/auth-server";
import { getPlan } from "@/lib/plans";
import { money, queryText } from "@/lib/format";

export default function CheckoutPage(props: PageProps<"/checkout">) {
  return <><h1>주문 확인</h1><Suspense fallback={<p>주문 조건 확인 중…</p>}><Checkout {...props} /></Suspense></>;
}

async function Checkout({ searchParams }: PageProps<"/checkout">) {
  const query = await searchParams;
  const orderId = queryText(query.orderId);
  if (orderId) redirect(`/mypage/orders/${encodeURIComponent(orderId)}`);
  const planId = queryText(query.planId);
  const travelStartDate = queryText(query.travelStartDate);
  if (!planId) return <p>먼저 <Link href="/plans">요금제를 선택해 주세요.</Link></p>;
  const result = await getPlan(planId);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <p role="alert">주문할 상품을 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.</p>;
  }
  const plan = result.data;
  if (plan.simType !== "ESIM") return <p>현재는 eSIM 주문만 지원합니다. <Link href="/plans">상품 다시 선택</Link></p>;
  const member = await getCurrentMember();
  if (!member.ok) {
    if (member.status !== 401) return <p role="alert">로그인 상태를 확인하지 못했습니다.</p>;
    const next = `/checkout?${new URLSearchParams({ planId, travelStartDate })}`;
    redirect(`/login?${new URLSearchParams({ next })}`);
  }
  if (member.data.role !== "USER") return <p>주문하려면 고객 계정으로 로그인해 주세요. <Link href="/admin/orders">운영자 주문 관리</Link></p>;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  return (
    <>
      <section className="home-panel">
        <h2>{plan.name}</h2>
        <p>{plan.country} · {plan.days}일 · {plan.dataMb.toLocaleString("ko-KR")}MB</p>
        <p>주문 예정 금액: {money(plan.price)} (KRW)</p>
        <p>최종 금액은 서버가 상품 가격을 조회해 고정하며, 주문은 생성 후 10분 동안 유효합니다.</p>
      </section>
      <OrderForm memberId={member.data.id} planId={plan.id} travelStartDate={travelStartDate} today={today} />
      <Link href={`/plans/${plan.id}`}>상품 상세로 돌아가기</Link>
    </>
  );
}
