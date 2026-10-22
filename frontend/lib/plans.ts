import "server-only";
import { io } from "next/cache";

export type Plan = {
  id: string;
  name: string;
  country: string;
  days: number;
  dataMb: number;
  simType: "ESIM" | "USIM";
  price: number;
};

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number };

async function request<T>(path: string): Promise<ApiResult<T>> {
  // 요청 시 조회하므로 프론트엔드 빌드 때 백엔드가 실행 중일 필요는 없다.
  await io();
  const gatewayUrl = process.env.GATEWAY_BASE_URL?.trim();
  if (!gatewayUrl) return { ok: false, status: 503 };
  try {
    const response = await fetch(new URL(path, gatewayUrl), {
      cache: "no-store",
      signal: AbortSignal.timeout(Number(process.env.GATEWAY_REQUEST_TIMEOUT_MS || 8000)),
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, status: 503 };
  }
}

export function getPlans(filters: Record<string, string> = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  return request<Plan[]>(`/api/plans?${query}`);
}

export function getPlan(planId: string) {
  return request<Plan>(`/api/plans/${encodeURIComponent(planId)}`);
}
