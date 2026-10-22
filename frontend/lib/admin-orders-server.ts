import "server-only";
import { request } from "./orders-server";
import type { Order } from "./orders";
import type { PaymentAttempt } from "./payments";

export type AdminOrder = { order: Order; customerUsername: string };
type Page = { items: AdminOrder[]; page: number; size: number; hasNext: boolean };
type Detail = { order: AdminOrder; payments: PaymentAttempt[] };

export function getAdminOrders(query: URLSearchParams) {
  return request<Page>(`/api/admin/orders?${query}`);
}

export function getAdminOrder(id: string) {
  return request<Detail>(`/api/admin/orders/${encodeURIComponent(id)}`);
}
