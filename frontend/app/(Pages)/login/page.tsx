import Link from "next/link";
import { Suspense } from "react";
import AuthForm from "@/components/screens/auth-form";

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <>
      <h1>로그인</h1>
      <Suspense fallback={<p>로그인 화면 준비 중…</p>}><LoginForm {...props} /></Suspense>
      <Link href="/signup">회원가입</Link>
    </>
  );
}

async function LoginForm({ searchParams }: PageProps<"/login">) {
  const query = await searchParams;
  let nextPath = "/mypage";
  if (typeof query.next === "string") {
    try {
      const target = new URL(query.next, "https://local.invalid");
      if (target.origin === "https://local.invalid" && target.pathname === "/checkout") {
        nextPath = target.pathname + target.search;
      }
    } catch { /* 잘못된 복귀 주소는 기본 마이페이지로 이동한다. */ }
  }
  return <AuthForm mode="login" nextPath={nextPath} />;
}
