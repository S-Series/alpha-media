import "server-only";
import { cookies } from "next/headers";
import type { Member } from "./auth";

type MemberResult = { ok: true; data: Member } | { ok: false; status: number };

export async function getCurrentMember(): Promise<MemberResult> {
  const session = (await cookies()).get("ALPHA_SESSION");
  if (!session) return { ok: false, status: 401 };
  const gateway = process.env.GATEWAY_BASE_URL || "http://127.0.0.1:8080";
  try {
    const response = await fetch(new URL("/api/me", gateway), {
      cache: "no-store",
      headers: { Cookie: `ALPHA_SESSION=${session.value}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, data: (await response.json()) as Member };
  } catch {
    return { ok: false, status: 503 };
  }
}
