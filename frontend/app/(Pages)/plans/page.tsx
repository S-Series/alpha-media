import Link from "next/link";
import { Suspense } from "react";
import PlanList from "@/components/screens/plan-list";
import { getPlans } from "@/lib/plans";
import { queryText } from "@/lib/preview-data";

export default function PlansPage(props: PageProps<"/plans">) {
  return (
    <>
      <h1>요금제 목록</h1>
      <p>상품을 조회하고 eSIM 주문을 생성한 뒤 모의 결제를 진행할 수 있습니다. 발급은 아직 연결되지 않았습니다.</p>
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
  const result = await getPlans({ country, days, dataMb, simType });
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
      {result.ok ? (
        <>
          <p>상품 {result.data.length}개</p>
          <PlanList plans={result.data} />
        </>
      ) : (
        <p role="alert">
          {result.status === 400
            ? "검색 조건을 확인해 주세요. 사용 일수와 용량은 양수여야 합니다."
            : "요금제를 불러오지 못했습니다. 잠시 후 다시 조회해 주세요."}
        </p>
      )}
    </>
  );
}
