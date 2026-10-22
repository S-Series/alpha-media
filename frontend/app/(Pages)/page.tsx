import Link from "next/link";
import { Suspense } from "react";
import PlanList from "@/components/screens/plan-list";
import { getPlans } from "@/lib/plans";

export default function Home() {
  return (
    <>
      <h1>홈</h1>
      <p>eSIM 주문을 생성하고 내역을 확인할 수 있습니다. 결제·발급·환불은 아직 실행되지 않습니다.</p>
      <section className="home-panel" aria-labelledby="search-title">
        <h2 id="search-title">여행 요금제 찾기</h2>
        <form action="/plans" method="get" className="plan-search">
          <label htmlFor="destination">국가·지역</label>
          <input
            id="destination"
            name="country"
            type="search"
            placeholder="여행할 국가 또는 지역"
          />
          <button type="submit">요금제 찾기</button>
        </form>
      </section>

      <section className="home-panel" aria-labelledby="plans-title">
        <h2 id="plans-title">요금제 목록</h2>
        <Suspense fallback={<p>요금제 확인 중…</p>}>
          <HomePlans />
        </Suspense>
        <Link href="/plans">전체 요금제 보기</Link>
      </section>

      <div className="home-links">
        <section className="home-panel" aria-labelledby="guide-title">
          <h2 id="guide-title">이용안내</h2>
          <p>eSIM 설치와 USIM 수령·개통 안내</p>
          <Link href="/guide">이용안내 보기</Link>
        </section>
        <section className="home-panel" aria-labelledby="mypage-title">
          <h2 id="mypage-title">마이페이지</h2>
          <p>내 정보·주문 내역·보유 SIM 확인</p>
          <Link href="/mypage">마이페이지 이동</Link>
        </section>
      </div>
    </>
  );
}

async function HomePlans() {
  const result = await getPlans();
  if (!result.ok) {
    return <p role="alert">요금제를 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.</p>;
  }
  return <PlanList plans={result.data.slice(0, 2)} />;
}
