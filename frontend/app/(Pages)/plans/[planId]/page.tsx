import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getPlan } from "@/lib/plans";
import { money } from "@/lib/format";

export default function PlanDetailPage(props: PageProps<"/plans/[planId]">) {
  return (
    <>
      <h1>요금제 상세</h1>
      <p>상품을 확인하고 eSIM 주문을 생성한 뒤 모의 결제·비동기 발급을 진행할 수 있습니다.</p>
      <Suspense fallback={<p role="status">상품 정보 확인 중…</p>}>
        <PlanDetail {...props} />
      </Suspense>
    </>
  );
}

async function PlanDetail({ params }: PageProps<"/plans/[planId]">) {
  const { planId } = await params;
  const result = await getPlan(planId);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <p role="alert">상품 정보를 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.</p>;
  }
  const plan = result.data;
  return (
    <>
      <section className="home-panel">
        <h2>{plan.name}</h2>
        <dl className="detail-list">
          <dt>국가</dt>
          <dd>{plan.country}</dd>
          <dt>사용 일수</dt>
          <dd>{plan.days}일</dd>
          <dt>데이터</dt>
          <dd>{plan.dataMb.toLocaleString("ko-KR")}MB</dd>
          <dt>종류</dt>
          <dd>{plan.simType}</dd>
          <dt>금액</dt>
          <dd>{money(plan.price)}</dd>
        </dl>
      </section>
      {plan.simType === "ESIM" ? <form action="/checkout" method="get" className="screen-form home-panel">
        <input type="hidden" name="planId" value={plan.id} />
        <label>
          여행 시작일
          <input type="date" name="travelStartDate" required />
        </label>
        <button type="submit">주문 조건 확인</button>
      </form> : <p>USIM 주문은 수령·등록 절차를 연결한 뒤 제공할 예정입니다.</p>}
      <nav className="page-actions" aria-label="상품 관련 화면">
        <Link href="/plans">요금제 목록</Link>
        <Link href="/guide">설치·수령 안내</Link>
      </nav>
    </>
  );
}
