"use client";

import { useEffect, useRef, useState } from "react";
import type { AdminOrderDetail, MockPaymentStorageAction } from "@/lib/admin-orders-server";
import { ApiRequestError, post } from "@/lib/auth";
import { kst } from "@/lib/format";

type Draft = { key: string; action: "ARM" | "RELEASE"; reason: string };

export default function AdminPaymentStorage({ orderId, enabled, canArm, actions, payments, onRefresh }: {
  orderId: string; enabled: boolean; canArm: boolean; actions: MockPaymentStorageAction[];
  payments: AdminOrderDetail["mockPaymentStoragePayments"]; onRefresh: () => void;
}) {
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<MockPaymentStorageAction | null>(null);
  const sending = useRef(false);
  const storage = `mock-payment-storage:${orderId}`;
  const history = receipt && !actions.some(action => action.id === receipt.id) ? [...actions, receipt] : actions;
  const armed = history.some(action => action.action === "ARM");
  const released = history.some(action => action.action === "RELEASE");
  const allowed = armed ? !released : enabled && canArm;

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storage) || "null");
        if (saved && typeof saved.key === "string" && typeof saved.reason === "string" && ["ARM", "RELEASE"].includes(saved.action)) {
          setDraft(saved); setReason(saved.reason);
        }
      } catch { /* Server actions remain authoritative if local storage is unavailable. */ }
      setReady(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [storage]);

  async function submit() {
    if (sending.current || !ready || (!draft && (!allowed || !reason.trim()))) return;
    sending.current = true; setPending(true); setError("");
    const request: Draft = draft || { key: crypto.randomUUID(), action: armed ? "RELEASE" : "ARM", reason: reason.trim() };
    setDraft(request);
    try { sessionStorage.setItem(storage, JSON.stringify(request)); } catch { /* Retain the key in memory. */ }
    try {
      const response = await post(`/api/admin/orders/${orderId}/mock-payment-storage`,
        JSON.stringify({ action: request.action, reason: request.reason }), "application/json", { "Idempotency-Key": request.key });
      const result: { action: MockPaymentStorageAction } = await response.json();
      setReceipt(result.action); setDraft(null); setReason("");
      try { sessionStorage.removeItem(storage); } catch { /* Keep the server result visible. */ }
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.status < 500) {
        setDraft(null);
        try { sessionStorage.removeItem(storage); } catch { /* Keep the error visible. */ }
      }
      setError(failure instanceof Error ? failure.message : "응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
    } finally { sending.current = false; setPending(false); onRefresh(); }
  }

  return <section className="home-panel">
    <h2>결제 승인 DB 반영 실패 시연</h2>
    <p>현재: <strong>{released ? "장애 해제됨" : armed ? "이 주문의 승인 반영 실패 중" : "장애 없음"}</strong></p>
    <p>결제 대기 데이터 생성 → 장애 설정 → 고객 계정으로 승인 결제(웹훅 1회 이상) → 위의 수신함에서 실패 확인 → 장애 해제 순서로 진행하세요.</p>
    <p>실제 SQL 오류로 이 주문의 승인 반영을 롤백합니다. PG 승인과 웹훅 원문 저장은 유지하고, 주문은 결제 확인 중으로 남습니다. 응답·웹훅·조회 어느 경로도 장애를 우회하지 않습니다.</p>
    {armed && (payments.length === 0 ? <p>모의 PG 처리 기록을 기다리고 있습니다.</p> : payments.map(payment => <p key={payment.paymentId}>
      PG 원장: <strong>{payment.status === "APPROVED" ? "승인 완료" : "거절"}</strong> · 승인 실행 {payment.approvalExecutions}회<br />
      결제번호: {payment.paymentId} · 위의 내부 결제 상태와 비교하세요.
    </p>))}
    {!released && <div className="screen-form">
      <label>조치 사유 <textarea maxLength={300} value={reason} onChange={event => setReason(event.target.value)} disabled={pending || !!draft || !allowed} /></label>
      <button type="button" disabled={!ready || pending || (!draft && (!allowed || !reason.trim()))} onClick={submit}>
        {pending ? "결과 확인 중…" : draft ? "같은 요청으로 결과 확인" : armed ? "이 주문의 DB 반영 장애 해제" : "이 주문의 DB 반영 장애 설정"}
      </button>
      {!armed && !canArm && <p>결제 시도가 없는 유효한 결제 대기 주문에서 설정할 수 있습니다.</p>}
      {allowed && !draft && !reason.trim() && <p>조치 사유를 입력하면 {armed ? "장애 해제" : "장애 설정"} 버튼이 활성화됩니다.</p>}
    </div>}
    <p>해제 후 남은 자동 재시도로 복구합니다. 수신함이 ‘운영자 확인 필요’라면 아래 복구 영역에서 해당 웹훅을 선택해 ‘외부 결과 재조회’ → ‘저장된 웹훅 재처리’를 진행하세요. 회차당 6회·최초 포함 3회차 제한은 초기화하지 않습니다.</p>
    <p>주문당 한 번 설정·해제할 수 있습니다. 다시 시연하려면 새 주문을 생성하세요. 이 기능은 DB 전체 연결 장애를 재현하지 않습니다.</p>
    {history.map(action => <p key={action.id}>{action.action === "ARM" ? "장애 설정" : "장애 해제"} · {action.actor} · {kst(action.createdAt)}<br />사유: {action.reason}</p>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
