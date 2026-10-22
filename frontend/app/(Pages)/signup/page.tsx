import Link from "next/link";
import AuthForm from "@/components/screens/auth-form";

export default function SignupPage() {
  return (
    <>
      <h1>회원가입</h1>
      <AuthForm mode="signup" />
      <Link href="/login">로그인</Link>
    </>
  );
}
