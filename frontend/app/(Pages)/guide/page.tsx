export default function GuidePage() {
  return (
    <>
      <h1>이용안내</h1>
      <section className="home-panel">
        <h2>eSIM</h2>
        <p>
          주문 결제 → 발급 결과 확인 → 내 SIM에서 QR·활성화 정보 확인 →
          설치·개통 상태 확인
        </p>
        <p>QR을 열어본 기록과 실제 설치·개통 상태는 구분해서 표시합니다.</p>
      </section>
      <section className="home-panel">
        <h2>USIM</h2>
        <p>주문 결제 → 공항 수령 → 내 SIM에서 ICCID 등록 → 개통 결과 확인</p>
        <p>
          수령 장소·운영 시간과 기기별 상세 안내는 확정 후 제공할 영역입니다.
        </p>
      </section>
      <nav className="page-actions" aria-label="이용 관련 화면">
        <Link href="/plans">요금제 보기</Link>
        <Link href="/mypage/orders">주문 확인</Link>
        <Link href="/mypage/sims">내 SIM</Link>
      </nav>
    </>
  );
}
import Link from "next/link";
