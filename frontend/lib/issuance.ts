export type IssuanceSimulation = {
  scenario: "SUCCEED" | "FAIL";
  callbackCopies: number;
  callbackDelayMs: number;
};

export const defaultIssuanceSimulation: IssuanceSimulation = {
  scenario: "SUCCEED", callbackCopies: 1, callbackDelayMs: 2000,
};

export type Issuance = {
  id: string;
  orderId: string;
  simulation: IssuanceSimulation;
  status: "QUEUED" | "PROCESSING" | "WAITING_CALLBACK" | "ISSUED" | "FAILED" | "REVIEW_REQUIRED";
  supplierOrderNo: string | null;
  revision: number;
  checkCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SimProfile = {
  id: string;
  orderId: string;
  issuanceId: string;
  supplierOrderNo: string;
  iccid: string;
  activationCode: string;
  installStatus: "ISSUED";
  issuedAt: string;
};

export type IssuanceView = { issuance: Issuance | null; profile: SimProfile | null };

export function issuanceStatus(status: Issuance["status"]) {
  return { QUEUED: "발급 대기", PROCESSING: "공급사 확인 중", WAITING_CALLBACK: "발급 결과 대기",
    ISSUED: "발급 완료", FAILED: "발급 실패, 운영자 조치 필요", REVIEW_REQUIRED: "자동 확인 중단, 운영자 확인 필요" }[status];
}
