import Link from "next/link";

export default function LoginPage() {
  return (
    <>
      <h1>로그인</h1>
      <p>로그인 입력 영역</p>
      <Link href="/signup">회원가입</Link>
    </>
  );
}
