import "server-only";
import { request } from "./orders-server";
import type { Order } from "./orders";
import type { PaymentAttempt } from "./payments";
import type { Issuance, IssuanceView } from "./issuance";

export type AdminOrder = { order: Order; customerUsername: string; issuanceStatus?: Issuance["status"] | null; issuanceError?: string | null };
type Page = { items: AdminOrder[]; page: number; size: number; hasNext: boolean };
export type AdminOrderDetail = { order: AdminOrder; payments: PaymentAttempt[]; issuance?: IssuanceView;
  refund?: { id: string; status: string; amount: number; attemptCount: number; lastError: string | null; pgCancellationId: string | null } | null;
  actions?: { id: string; actor: string; type: string; reason: string; issuanceId: string | null; refundId: string | null; createdAt: string }[];
  actionEvents?: { id: string; actionId: string; status: string; detail: string | null; createdAt: string }[];
};

export function getAdminOrders(query: URLSearchParams) {
  return request<Page>(`/api/admin/orders?${query}`);
}

export function getAdminOrder(id: string) {
  return request<AdminOrderDetail>(`/api/admin/orders/${encodeURIComponent(id)}`);
}
