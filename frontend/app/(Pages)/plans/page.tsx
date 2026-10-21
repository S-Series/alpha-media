import Link from "next/link";
import { Suspense } from "react";
import PreviewNotice from "@/components/screens/preview-notice";
import PlanList from "@/components/screens/plan-list";
import { previewPlans, queryText } from "@/lib/preview-data";

export default function PlansPage(props: PageProps<"/plans">) {
  return (
    <>
      <h1>요금제 목록</h1>
      <PreviewNotice />
      <Suspense fallback={<p>요금제 확인 중…</p>}>
        <Plans {...props} />
      </Suspense>
    </>
  );
}

async function Plans({ searchParams }: PageProps<"/plans">) {
  const query = await searchParams;
  const country = queryText(query.country),
    days = queryText(query.days),
    dataMb = queryText(query.dataMb),
    simType = queryText(query.simType);
  const plans = previewPlans.filter(
    (plan) =>
      (!country || plan.country.includes(country.trim())) &&
      (!days || plan.days === Number(days)) &&
      (!dataMb || plan.dataMb === Number(dataMb)) &&
      (!simType || plan.simType === simType),
  );
  return (
    <>
      <form
        key={JSON.stringify([country, days, dataMb, simType])}
        action="/plans"
        method="get"
        className="screen-form home-panel"
      >
        <label>
          국가·지역
          <input name="country" defaultValue={country} />
        </label>
        <label>
          사용 일수
          <input name="days" type="number" min="1" defaultValue={days} />
        </label>
        <label>
          데이터 용량
          <select name="dataMb" defaultValue={dataMb}>
            <option value="">전체</option>
            <option value="3000">3,000MB</option>
            <option value="5000">5,000MB</option>
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
        <button type="submit">검색</button>
        <Link href="/plans">초기화</Link>
      </form>
      <p>예시 상품 {plans.length}개</p>
      <PlanList plans={plans} />
    </>
  );
}
