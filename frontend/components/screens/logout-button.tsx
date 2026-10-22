"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/auth";

export default function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setPending(true);
    setError("");
    try {
      await logout();
      router.replace("/login");
      router.refresh();
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
