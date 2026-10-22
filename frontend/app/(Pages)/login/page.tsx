import Link from "next/link";
import AuthForm from "@/components/screens/auth-form";

export default function LoginPage() {
  return (
    <>
      <h1>로그인</h1>
      <AuthForm mode="login" />
      <Link href="/signup">회원가입</Link>
    </>
  );
}
