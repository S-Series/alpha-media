import "server-only";
import { cookies } from "next/headers";
import type { Member } from "./auth";

type MemberResult = { ok: true; data: Member } | { ok: false; status: number };

export async function getCurrentMember(): Promise<MemberResult> {
  const session = (await cookies()).get("ALPHA_SESSION");
  if (!session) return { ok: false, status: 401 };
  const gateway = process.env.GATEWAY_BASE_URL?.trim();
  if (!gateway) return { ok: false, status: 503 };
  try {
    const response = await fetch(new URL("/api/me", gateway), {
      cache: "no-store",
      headers: { Cookie: `ALPHA_SESSION=${session.value}` },
      signal: AbortSignal.timeout(Number(process.env.GATEWAY_REQUEST_TIMEOUT_MS || 8000)),
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, data: (await response.json()) as Member };
  } catch {
    return { ok: false, status: 503 };
  }
}
