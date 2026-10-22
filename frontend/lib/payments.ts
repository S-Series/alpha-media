import { post } from "./auth";
import type { IssuanceSimulation } from "./issuance";

export type PaymentScenario = "APPROVE" | "DECLINE" | "RESPONSE_LOST";
export type PaymentSimulation = {
  scenario: PaymentScenario;
  webhookCopies: number;
  webhookDelayMs: number;
  issuance: IssuanceSimulation;
};
export type PaymentAttempt = {
  id: string;
  orderId: string;
  amount: number;
  currency: "KRW";
  scenario: PaymentScenario;
  webhookCopies: number;
  webhookDelayMs: number;
  issuance?: IssuanceSimulation;
  status: "QUEUED" | "PROCESSING" | "UNKNOWN" | "APPROVED" | "DECLINED" | "REVIEW_REQUIRED";
  pgTransactionId: string | null;
  declineCode: string | null;
  lastError: string | null;
  attemptCount: number;
  updatedAt: string;
};

export async function acceptPayment(orderId: string, key: string, simulation: PaymentSimulation): Promise<PaymentAttempt> {
  const response = await post(`/api/orders/${encodeURIComponent(orderId)}/payment-attempts`,
    JSON.stringify(simulation),
    "application/json", { "Idempotency-Key": key });
  return response.json();
}

export function paymentStatus(status: PaymentAttempt["status"]) {
  return { QUEUED: "승인 대기", PROCESSING: "PG 확인 중", UNKNOWN: "응답 유실, 결과 재확인 중",
    APPROVED: "승인 완료", DECLINED: "승인 거절", REVIEW_REQUIRED: "운영자 확인 필요" }[status];
}
