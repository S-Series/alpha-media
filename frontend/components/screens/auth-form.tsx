"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { login, signup } from "@/lib/auth";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [registered, setRegistered] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const email = String(values.get("email") || "");
      const password = String(values.get("password") || "");
      if (mode === "signup") {
        await signup(email, String(values.get("displayName") || ""), password);
        setRegistered(true);
      } else {
        await login(email, password);
        router.replace("/mypage");
        router.refresh();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "서버에 연결하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  if (registered) return <p role="status">회원가입이 완료됐습니다. 아래 로그인 링크로 이동해 주세요.</p>;

  return (
    <form onSubmit={submit} className="screen-form home-panel">
      <label>
        이메일
        <input name="email" type="email" autoComplete="username" maxLength={254} required />
      </label>
      {mode === "signup" && (
        <label>
          이름
          <input name="displayName" autoComplete="name" minLength={2} maxLength={60} required />
        </label>
      )}
      <label>
        비밀번호
        <input name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"}
          minLength={mode === "signup" ? 12 : 1} maxLength={128} required />
      </label>
      {mode === "signup" && <p>비밀번호는 12~128자로 입력해 주세요.</p>}
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>{pending ? "처리 중…" : mode === "signup" ? "회원가입" : "로그인"}</button>
    </form>
  );
}
