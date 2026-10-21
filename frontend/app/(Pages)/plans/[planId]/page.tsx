import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import PreviewNotice from "@/components/screens/preview-notice";
import { money, previewPlans } from "@/lib/preview-data";

export function generateStaticParams() {
  return previewPlans.map(({ id }) => ({ planId: id }));
}

export default function PlanDetailPage(props: PageProps<"/plans/[planId]">) {
  return (
    <>
      <h1>요금제 상세</h1>
      <PreviewNotice />
      <Suspense fallback={<p role="status">상품 정보 확인 중…</p>}>
        <PlanDetail {...props} />
      </Suspense>
    </>
  );
}

async function PlanDetail({ params }: PageProps<"/plans/[planId]">) {
  const { planId } = await params;
  const plan = previewPlans.find((item) => item.id === planId);
  if (!plan) notFound();
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
      <form action="/checkout" method="get" className="screen-form home-panel">
        <input type="hidden" name="planId" value={plan.id} />
        <label>
          여행 시작일
          <input type="date" name="travelStartDate" required />
        </label>
        <button type="submit">주문 조건 확인</button>
      </form>
      <nav className="page-actions" aria-label="상품 관련 화면">
        <Link href="/plans">요금제 목록</Link>
        <Link href="/guide">설치·수령 안내</Link>
      </nav>
    </>
  );
}
