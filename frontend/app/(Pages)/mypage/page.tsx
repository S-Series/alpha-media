import Link from "next/link";
import { getCurrentMember } from "@/lib/auth-server";
import LogoutButton from "@/components/screens/logout-button";

export default async function MyPage() {
  const result = await getCurrentMember();
  if (!result.ok) return null;
  return (
    <>
      <h1>마이페이지</h1>
      <p>{result.data.displayName}님, 로그인되어 있습니다.</p>
      <p>{result.data.email}</p>
      <LogoutButton />
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
