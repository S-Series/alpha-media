import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/auth-server";
import LogoutButton from "@/components/screens/logout-button";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={<p>운영자 권한 확인 중…</p>}><AdminAccess>{children}</AdminAccess></Suspense>;
}

async function AdminAccess({ children }: { children: ReactNode }) {
  const result = await getCurrentMember();
  if (!result.ok) {
    if (result.status === 401) redirect("/login");
    return <p role="alert">로그인 상태를 확인하지 못했습니다. 잠시 후 다시 접속해 주세요.</p>;
  }
  if (result.data.role !== "ADMIN") return <p role="alert">운영자 권한이 필요합니다. <Link href="/mypage">마이페이지로 이동</Link></p>;
  return <>
    <p>운영자: {result.data.username}</p><LogoutButton />
    <nav className="page-actions" aria-label="운영자 메뉴"><Link href="/admin/orders">주문 목록</Link>
      <Link href="/admin/issues">결과 확인 필요</Link><Link href="/">고객 화면</Link></nav>
    {children}
  </>;
}
