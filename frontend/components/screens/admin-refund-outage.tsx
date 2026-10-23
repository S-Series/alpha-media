"use client";

import { useEffect, useRef, useState } from "react";
import { ApiRequestError, post } from "@/lib/auth";
import type { MockPgOutageRelease } from "@/lib/admin-orders-server";
import { kst } from "@/lib/format";

type Draft = { key: string; reason: string };
type Receipt = { release: MockPgOutageRelease; replayed: boolean };

export default function AdminRefundOutage({ orderId, refundId, eligible, release, onRefresh }: {
  orderId: string; refundId: string; eligible: boolean; release?: MockPgOutageRelease; onRefresh: () => void;
}) {
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const storage = `mock-pg-outage-release:${orderId}:${refundId}`;
  const released = release || receipt?.release;

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storage) || "null");
        if (saved && typeof saved.key === "string" && typeof saved.reason === "string") {
          setDraft(saved); setReason(saved.reason);
        }
      } catch { /* A persisted server release still prevents duplicate changes. */ }
      setReady(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [storage]);

  async function submit() {
    if (sending.current || !ready || released || (!draft && (!eligible || !reason.trim()))) return;
    sending.current = true; setPending(true); setError("");
    const request = draft || { key: crypto.randomUUID(), reason: reason.trim() };
    setDraft(request);
    try { sessionStorage.setItem(storage, JSON.stringify(request)); } catch { /* Keep the key in memory. */ }
    try {
      const response = await post(`/api/admin/orders/${orderId}/refunds/${refundId}/mock-pg-outage-release`,
        JSON.stringify({ reason: request.reason }), "application/json", { "Idempotency-Key": request.key });
      setReceipt(await response.json());
      try { sessionStorage.removeItem(storage); } catch { /* Server history remains authoritative. */ }
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.status < 500) {
        setDraft(null);
        try { sessionStorage.removeItem(storage); } catch { /* Keep the error visible. */ }
      }
      setError(failure instanceof Error ? failure.message : "결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
    } finally { sending.current = false; setPending(false); onRefresh(); }
  }

  return <div className="screen-form">
    <h4>모의 PG 장애 해제</h4>
    {released ? <>
      <p>장애 해제 완료 · {released.actor} · {kst(released.createdAt)}<br />사유: {released.reason}</p>
      <p>해제 기록번호: {released.id}</p>
    </> : <>
      <p>이 환불번호의 PG 취소 장애만 해제합니다. 원래 환불 요청·예약액·시도 횟수는 유지됩니다.</p>
      <label>장애 해제 사유 <textarea value={reason} maxLength={300} disabled={pending || !!draft || !eligible}
        onChange={event => setReason(event.target.value)} /></label>
      <button type="button" disabled={!ready || pending || (!draft && (!eligible || !reason.trim()))} onClick={submit}>
        {pending ? "해제 결과 확인 중…" : draft ? "같은 장애 해제 요청으로 결과 확인" : "이 환불의 PG 장애 해제"}
      </button>
      {!eligible && <p>확인 필요 상태에서, 상충 결과가 없는 경우 해제할 수 있습니다.</p>}
      {eligible && !draft && !reason.trim() && <p>장애 해제 사유를 입력하면 버튼이 활성화됩니다.</p>}
    </>}
    <p>장애 해제는 환불 완료가 아닙니다. 위의 복구 영역에서 이 환불을 선택해 ‘외부 결과 재조회’ 후 ‘같은 번호로 처리 재개’를 진행하세요. 최초 포함 3회차 제한은 유지됩니다.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
