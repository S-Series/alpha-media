"use client";

import { useState } from "react";
import { logout } from "@/lib/auth";

export default function LogoutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setPending(true);
    setError("");
    try {
      await logout();
      // 이전 로그인 화면을 재사용하지 않고 삭제된 세션을 기준으로 새로 조회한다.
      window.location.replace("/login");
    } catch {
      setError("로그아웃하지 못했습니다. 다시 시도해 주세요.");
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" disabled={pending} onClick={submit}>{pending ? "처리 중…" : "로그아웃"}</button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
