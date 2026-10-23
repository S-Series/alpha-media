import "server-only";
import { request } from "./orders-server";
import type { Order } from "./orders";
import type { PaymentAttempt } from "./payments";
import type { Issuance, IssuanceView, SimProfile } from "./issuance";

export type AdminOrder = { order: Order; customerUsername: string; issuanceStatus?: Issuance["status"] | null; issuanceError?: string | null;
  paymentStatus: PaymentAttempt["status"] | "NOT_STARTED"; installStatus: SimProfile["installStatus"] | "NOT_ISSUED";
  lastSyncedAt: string | null; syncError: string | null };
export type HistoryEvent = { id: string; target: string; targetId: string; fromStatus: string | null; toStatus: string;
  actor: string; source: string; reason: string | null; recordedAt: string };
export type HistoryPage = { items: HistoryEvent[]; nextBefore: string | null; checkedAt: string };
export type OrderConflict = { id: string; orderId: string; target: string; targetId: string; code: string; source: string;
  expectedStatus: string; observedStatus: string; recordedAt: string };
export type InboundEvent = { id: string; source: "PG" | "SUPPLIER" | "PROFILE"; eventId: string;
  status: "PENDING" | "PROCESSING" | "RETRY" | "PROCESSED" | "REVIEW_REQUIRED";
  attemptCount: number; executionRound?: number; roundAttemptCount?: number;
  receiveCount: number; receivedAt: string; lastReceivedAt: string;
  processedAt: string | null; nextAttemptAt: string | null; lastError: string | null; errorStatus: number | null };
export type RecoveryTarget = { kind: "PAYMENT" | "ISSUANCE" | "REFUND" | "INBOUND" | "PROTECTION"; id: string; status: string;
  version: string; executionRound: number; attemptCount: number; roundAttemptCount: number; lastError: string | null };
export type RecoveryAction = { id: string; orderId: string; actor: string; kind: "RECONCILE" | "RESUME";
  target: RecoveryTarget["kind"]; targetId: string; reason: string; expectedVersion: string; evidenceId: string | null;
  status: "QUEUED" | "PROCESSING" | "RETRY" | "SUCCEEDED" | "REVIEW_REQUIRED" | "STALE";
  outcome: string | null; attemptCount: number; fromRound: number; toRound: number | null;
  externalStatus: string | null; externalReference: string | null; evidenceHash: string | null; resultVersion: string | null;
  createdAt: string; checkedAt: string | null; lastError: string | null };
type Page = { items: AdminOrder[]; page: number; size: number; hasNext: boolean; checkedAt: string };
export type MockPgOutageRelease = { id: string; refundId: string; paymentId: string; actor: string; reason: string; createdAt: string };
export type MockPaymentStorageAction = { id: string; action: "ARM" | "RELEASE"; actor: string; reason: string; createdAt: string };
export type AdminOrderDetail = { order: AdminOrder; payments: PaymentAttempt[]; issuance?: IssuanceView;
  refund?: { id: string; status: string; amount: number; attemptCount: number; executionRound?: number; roundAttemptCount?: number;
    scenario: "SUCCESS" | "DECLINED" | "RESPONSE_LOST" | "UNAVAILABLE";
    lastError: string | null; pgCancellationId: string | null } | null;
  refunds: NonNullable<AdminOrderDetail["refund"]>[];
  mockPgEnabled: boolean;
  mockPgOutageReleases: MockPgOutageRelease[];
  mockPaymentStorageActions: MockPaymentStorageAction[];
  mockPaymentStoragePayments: { paymentId: string; status: "APPROVED" | "DECLINED"; approvalExecutions: number }[];
  refundBalance: { approved: number; confirmed: number; reserved: number; available: number; overReserved: boolean };
  protectionJobs: { id: string; refundId: string; phase: "HOLD" | "RELEASE" | "TERMINATE"; status: string;
    attemptCount: number; roundAttemptCount: number; executionRound: number; lastError: string | null }[];
  conflicts?: OrderConflict[];
  inboundEvents?: InboundEvent[];
  recoveryTargets?: RecoveryTarget[];
  recoveryActions?: RecoveryAction[];
  actions?: { id: string; actor: string; type: string; reason: string; issuanceId: string | null; refundId: string | null; createdAt: string }[];
  actionEvents?: { id: string; actionId: string; status: string; detail: string | null; createdAt: string }[];
  timeline: HistoryPage; checkedAt: string;
};

export function getAdminOrders(query: URLSearchParams) {
  return request<Page>(`/api/admin/orders?${query}`);
}

export function getAdminOrder(id: string) {
  return request<AdminOrderDetail>(`/api/admin/orders/${encodeURIComponent(id)}`);
}
