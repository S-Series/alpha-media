"use client";

import { useState, type FormEvent } from "react";
import { login } from "@/lib/auth";

export default function AuthForm({ nextPath = "/mypage" }: { nextPath?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const username = String(values.get("username") || "");
      const password = String(values.get("password") || "");
      const member = await login(username, password);
      // 새 세션 쿠키를 읽고 운영자는 전체 주문 화면으로 이동한다.
      window.location.replace(member.role === "ADMIN" ? "/admin/orders" : nextPath);
    } catch (error) {
      setError(error instanceof Error ? error.message : "서버에 연결하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="screen-form home-panel">
      <label>
        아이디
        <input name="username" autoComplete="username" maxLength={32} autoCapitalize="none" required />
      </label>
      <label>
        비밀번호
        <input name="password" type="password" autoComplete="current-password" maxLength={128} required />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>{pending ? "처리 중…" : "로그인"}</button>
    </form>
  );
}
