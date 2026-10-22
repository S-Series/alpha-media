import { post } from "./auth";

export type Order = {
  id: string;
  planId: string;
  planName: string;
  country: string;
  days: number;
  dataMb: number;
  simType: "ESIM";
  travelStartDate: string;
  amount: number;
  currency: "KRW";
  status: "PENDING_PAYMENT" | "PAYMENT_PROCESSING" | "PAID" | "EXPIRED";
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
};

export type OrderPage = { items: Order[]; page: number; size: number; hasNext: boolean };

export async function createOrder(planId: string, travelStartDate: string, key: string): Promise<Order> {
  const response = await post("/api/orders", JSON.stringify({ planId, travelStartDate }),
    "application/json", { "Idempotency-Key": key });
  return response.json();
}

export function orderStatus(status: Order["status"]) {
  return { PENDING_PAYMENT: "결제 대기", PAYMENT_PROCESSING: "결제 확인 중", PAID: "결제 완료", EXPIRED: "주문 만료" }[status];
}
