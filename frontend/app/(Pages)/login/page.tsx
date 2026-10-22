import { Suspense } from "react";
import AuthForm from "@/components/screens/auth-form";

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <>
      <h1>로그인</h1>
      <Suspense fallback={<p>로그인 화면 준비 중…</p>}><LoginForm {...props} /></Suspense>
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
  return <AuthForm nextPath={nextPath} />;
}
