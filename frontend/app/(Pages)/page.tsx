import Link from "next/link";
import PreviewNotice from "@/components/screens/preview-notice";
import PlanList from "@/components/screens/plan-list";
import { previewPlans } from "@/lib/preview-data";

export default function Home() {
  return (
    <>
      <h1>홈</h1>
      <PreviewNotice />
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
        <PlanList plans={previewPlans.slice(0, 2)} />
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
