import { Suspense } from "react";
import { redirect } from "next/navigation";
import AuthForm from "@/components/screens/auth-form";
import { getCurrentMember } from "@/lib/auth-server";

export default function LoginPage(props: PageProps<"/login">) {
  return <Suspense fallback={<p>로그인 상태 확인 중…</p>}><LoginForm {...props} /></Suspense>;
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
  const member = await getCurrentMember();
  if (member.ok) redirect(member.data.role === "ADMIN" ? "/admin/orders" : nextPath);
  if (member.status !== 401) return <p role="alert">로그인 상태를 확인하지 못했습니다. 잠시 후 다시 접속해 주세요.</p>;
  return <>
    <h1>로그인</h1>
    <AuthForm nextPath={nextPath} />
    <section className="home-panel" aria-labelledby="login-accounts-heading">
      <h2 id="login-accounts-heading">체험용 로그인 계정</h2>
      <div className="table-scroll">
        <table style={{ minWidth: 0 }}>
          <thead><tr><th scope="col">구분</th><th scope="col">아이디</th><th scope="col">비밀번호</th></tr></thead>
          <tbody>
            <tr><th scope="row">고객 1</th><td><code>customer1</code></td><td><code>OBCYp7bAqeeMdrQK!A1</code></td></tr>
            <tr><th scope="row">고객 2</th><td><code>customer2</code></td><td><code>kjVqVaC7THLnkxEb!A1</code></td></tr>
            <tr><th scope="row">운영자</th><td><code>admin</code></td><td><code>DYAN1d5W2asJlgjm!A1</code></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </>;
}
