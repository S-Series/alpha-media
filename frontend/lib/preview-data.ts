// 화면 배치와 이동 확인에만 사용하는 예시이며 실제 거래 데이터가 아니다.
export const previewPlans = [
  {
    id: "jp-esim-7d",
    name: "일본 eSIM 7일",
    country: "일본",
    days: 7,
    dataMb: 5000,
    simType: "ESIM",
    price: 15900,
  },
  {
    id: "jp-usim-7d",
    name: "일본 USIM 7일",
    country: "일본",
    days: 7,
    dataMb: 5000,
    simType: "USIM",
    price: 19900,
  },
  {
    id: "th-esim-5d",
    name: "태국 eSIM 5일",
    country: "태국",
    days: 5,
    dataMb: 3000,
    simType: "ESIM",
    price: 9900,
  },
] as const;

type HistoryEvent = {
  at: string;
  change: string;
  actor: string;
  reason: string;
};

export type PreviewOrder = {
  id: string;
  planId: string;
  travelStartDate: string;
  payment: string;
  fulfillment: string;
  installation: string;
  refund: string;
  updatedAt: string;
  simId?: string;
  issue?: string;
  history: HistoryEvent[];
};

export const previewOrders: PreviewOrder[] = [
  {
    id: "order-active",
    planId: "jp-esim-7d",
    travelStartDate: "2026-10-21",
    payment: "승인 완료",
    fulfillment: "발급 완료",
    installation: "개통",
    refund: "환불 제한",
    updatedAt: "2026-10-21T01:05:00Z",
    simId: "sim-esim-active",
    history: [
      {
        at: "2026-10-21T01:02:00Z",
        change: "프로필 발급 완료",
        actor: "공급사 콜백",
        reason: "발급 결과 수신",
      },
      {
        at: "2026-10-21T01:04:00Z",
        change: "설치 확인",
        actor: "공급사 상태 조회",
        reason: "INSTALLED 확인",
      },
      {
        at: "2026-10-21T01:05:00Z",
        change: "개통 확인",
        actor: "공급사 콜백",
        reason: "ACTIVE 확인",
      },
    ],
  },
  {
    id: "order-pending",
    planId: "jp-esim-7d",
    travelStartDate: "2026-11-01",
    payment: "결제 대기",
    fulfillment: "발급 대기",
    installation: "미발급",
    refund: "요청 없음",
    updatedAt: "2026-10-21T01:00:00Z",
    history: [
      {
        at: "2026-10-21T01:00:00Z",
        change: "주문 생성 · PENDING",
        actor: "고객",
        reason: "요금제 선택",
      },
    ],
  },
  {
    id: "order-issuing",
    planId: "jp-esim-7d",
    travelStartDate: "2026-11-01",
    payment: "승인 완료",
    fulfillment: "발급 중",
    installation: "미발급",
    refund: "요청 없음",
    updatedAt: "2026-10-21T01:02:00Z",
    issue: "결제 후 발급 지연",
    history: [
      {
        at: "2026-10-21T01:01:00Z",
        change: "결제 승인 반영",
        actor: "PG 웹훅",
        reason: "금액 확인",
      },
      {
        at: "2026-10-21T01:02:00Z",
        change: "발급 요청 접수",
        actor: "서버 워커",
        reason: "승인 후 발급",
      },
    ],
  },
  {
    id: "order-issued",
    planId: "jp-esim-7d",
    travelStartDate: "2026-11-01",
    payment: "승인 완료",
    fulfillment: "발급 완료",
    installation: "미설치",
    refund: "요청 없음",
    updatedAt: "2026-10-21T01:03:00Z",
    simId: "sim-esim-issued",
    history: [
      {
        at: "2026-10-21T01:01:00Z",
        change: "결제 승인 반영",
        actor: "PG 응답",
        reason: "승인 확인",
      },
      {
        at: "2026-10-21T01:03:00Z",
        change: "프로필 발급 완료",
        actor: "공급사 콜백",
        reason: "발급 결과 수신",
      },
    ],
  },
  {
    id: "order-pickup",
    planId: "jp-usim-7d",
    travelStartDate: "2026-11-01",
    payment: "승인 완료",
    fulfillment: "공항 수령 대기",
    installation: "미등록",
    refund: "요청 없음",
    updatedAt: "2026-10-21T01:04:00Z",
    simId: "sim-usim-pickup",
    history: [
      {
        at: "2026-10-21T01:04:00Z",
        change: "PICKUP_READY · 공항 수령 대기",
        actor: "서버",
        reason: "USIM 결제 승인",
      },
    ],
  },
  {
    id: "order-refund-failed",
    planId: "th-esim-5d",
    travelStartDate: "2026-11-01",
    payment: "승인 완료",
    fulfillment: "발급 실패",
    installation: "미발급",
    refund: "환불 실패",
    updatedAt: "2026-10-21T01:06:00Z",
    issue: "발급 실패 후 환불 확인 필요",
    history: [
      {
        at: "2026-10-21T01:04:00Z",
        change: "발급 최종 실패",
        actor: "공급사 콜백",
        reason: "공급사 발급 거절",
      },
      {
        at: "2026-10-21T01:06:00Z",
        change: "환불 실패 · 운영자 확인 대상",
        actor: "환불 워커",
        reason: "취소 API 타임아웃 · 예시 재시도 한도 초과",
      },
    ],
  },
];

export const previewSims = [
  {
    id: "sim-esim-active",
    orderId: "order-active",
    state: "사용 중 · ACTIVE",
    installed: "설치·개통 확인",
    activatedAt: "2026-10-21T01:05:00Z",
    expiresAt: "2026-10-28T01:05:00Z",
  },
  {
    id: "sim-esim-issued",
    orderId: "order-issued",
    state: "발급 완료 · ISSUED",
    installed: "설치 이력 없음",
    activatedAt: null,
    expiresAt: null,
  },
  {
    id: "sim-usim-pickup",
    orderId: "order-pickup",
    state: "공항 수령 대기 · PICKUP_READY",
    installed: "ICCID 미등록",
    activatedAt: null,
    expiresAt: null,
  },
] as const;

export function money(amount: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
  }).format(amount);
}

export function kst(value: string) {
  return (
    new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      dateStyle: "short",
      timeStyle: "medium",
      hour12: false,
    }).format(new Date(value)) + " KST"
  );
}

export function queryText(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}
