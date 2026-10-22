import { Suspense, type ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/auth-server";

export default function MyPageLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={<p>로그인 상태 확인 중…</p>}><Authenticated>{children}</Authenticated></Suspense>;
}

async function Authenticated({ children }: { children: ReactNode }) {
  const result = await getCurrentMember();
  if (!result.ok) {
    if (result.status === 401) redirect("/login");
    return <p role="alert">로그인 상태를 확인하지 못했습니다. 잠시 후 다시 접속해 주세요.</p>;
  }
  return children;
}
