import Link from "next/link";

export default function MyPage() {
  return (
    <>
      <h1>마이페이지</h1>
      <p>본인 정보·최근 주문·보유 SIM 요약 영역</p>
      <nav aria-label="마이페이지 메뉴">
        <ul>
          <li><Link href="/mypage/profile">내 정보</Link></li>
          <li><Link href="/mypage/orders">주문 내역</Link></li>
          <li><Link href="/mypage/sims">내 SIM</Link></li>
        </ul>
      </nav>
    </>
  );
}
