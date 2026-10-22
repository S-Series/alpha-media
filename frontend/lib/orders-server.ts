import "server-only";
import { cookies } from "next/headers";
import type { Order, OrderPage } from "./orders";

async function request<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const session = (await cookies()).get("ALPHA_SESSION");
  if (!session) return { ok: false, status: 401 };
  try {
    const response = await fetch(new URL(path, process.env.GATEWAY_BASE_URL || "http://127.0.0.1:8080"), {
      cache: "no-store",
      headers: { Cookie: `ALPHA_SESSION=${session.value}` },
      signal: AbortSignal.timeout(Number(process.env.GATEWAY_REQUEST_TIMEOUT_MS || 8000)),
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, data: await response.json() as T };
  } catch {
    return { ok: false, status: 503 };
  }
}

export function getOrders(page: number) {
  return request<OrderPage>(`/api/orders?page=${page}&size=20`);
}

export function getOrder(orderId: string) {
  return request<Order>(`/api/orders/${encodeURIComponent(orderId)}`);
}
