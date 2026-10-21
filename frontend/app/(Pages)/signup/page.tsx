import Link from "next/link";

export default function SignupPage() {
  return (
    <>
      <h1>회원가입</h1>
      <p>회원가입 입력 영역</p>
      <Link href="/login">로그인</Link>
    </>
  );
}
