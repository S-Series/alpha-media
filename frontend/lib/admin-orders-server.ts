import "server-only";
import { request } from "./orders-server";
import type { Order } from "./orders";
import type { PaymentAttempt } from "./payments";
import type { Issuance, IssuanceView } from "./issuance";

export type AdminOrder = { order: Order; customerUsername: string; issuanceStatus?: Issuance["status"] | null; issuanceError?: string | null };
type Page = { items: AdminOrder[]; page: number; size: number; hasNext: boolean };
type Detail = { order: AdminOrder; payments: PaymentAttempt[]; issuance?: IssuanceView };

export function getAdminOrders(query: URLSearchParams) {
  return request<Page>(`/api/admin/orders?${query}`);
}

export function getAdminOrder(id: string) {
  return request<Detail>(`/api/admin/orders/${encodeURIComponent(id)}`);
}
