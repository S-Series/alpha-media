"use client";

import { useState } from "react";
import type { HistoryPage } from "@/lib/admin-orders-server";
import { kst } from "@/lib/format";

const targets: Record<string,string> = { ORDER: "주문", PAYMENT: "결제", ISSUANCE: "발급", PROFILE: "설치·사용", REFUND: "환불", ACTION: "운영자 조치" };
const signals: Record<string,string> = { ORDER_REQUEST: "고객 주문", PAYMENT_REQUEST: "고객 결제 접수", PG_RESPONSE: "PG 승인 응답",
  PG_LOOKUP: "PG 결과 조회", PG_WEBHOOK: "PG 웹훅", SUPPLIER_ACCEPTANCE: "공급사 접수 응답", SUPPLIER_LOOKUP: "공급사 발급 조회",
  SUPPLIER_CALLBACK: "공급사 발급 콜백", PROFILE_LOOKUP: "공급사 프로필 조회", PROFILE_CALLBACK: "공급사 프로필 콜백",
  QR_VIEW: "활성화 정보 열람", ORDER_EXPIRY: "주문 만료", SIM_EXPIRY: "SIM 만료", ADMIN_RETRY: "운영자 발급 재시도",
  ADMIN_REFUND: "운영자 환불 접수", ADMIN_ACTION: "운영자 조치 접수", PG_CANCEL_RESULT: "PG 취소 결과", SNAPSHOT: "기존 데이터 스냅샷" };

export default function AdminOrderTimeline({ orderId, latest }: { orderId: string; latest: HistoryPage }) {
  const [saved, setSaved] = useState<HistoryPage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const page = saved || latest;
  if (!page) return <section className="home-panel"><h2>통합 상태 타임라인</h2><p>서버의 새 이력 데이터를 기다리고 있습니다.</p></section>;

  async function more() {
    if (!page.nextBefore || pending) return;
    setPending(true); setError("");
    try {
      const response = await fetch(`/api/admin/orders/${orderId}/history?before=${page.nextBefore}`, {
        cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("이전 이력을 조회하지 못했습니다.");
      const older: HistoryPage = await response.json();
      setSaved({ items: [...page.items, ...older.items], nextBefore: older.nextBefore, checkedAt: page.checkedAt });
    } catch (e) { setError(e instanceof Error ? e.message : "이력 조회 실패"); }
    finally { setPending(false); }
  }

  return <section className="home-panel"><h2>통합 상태 타임라인</h2>
    <p>서버 기록 시각 기준, 최신순 · 조회 {kst(page.checkedAt)}. 상태 전이는 변경과 같은 트랜잭션에서 저장합니다.</p>
    <p>기존 데이터의 SNAPSHOT은 이력 수집 시작 시점의 상태이며, 과거 변경 시각·처리자를 뜻하지 않습니다.</p>
    {saved && <p>이전 이력을 읽는 동안 타임라인은 고정됩니다. 현재 주문 상태는 계속 갱신됩니다.
      <button disabled={pending} onClick={() => setSaved(null)}>최신 이력으로</button></p>}
    {page.items.length === 0 ? <p>기록된 이력이 없습니다.</p> : <ol>
      {page.items.map(event => <li key={event.id}>
        <p><time dateTime={event.recordedAt}>{kst(event.recordedAt)}</time> · {targets[event.target] || event.target}<br />
          {event.fromStatus || "없음"} → {event.toStatus}<br />
          처리자: {event.actor} · 신호: {signals[event.source] || event.source} ({event.source})
          {event.reason && <><br />사유: {event.reason}</>}
          <br /><small>대상 번호: {event.targetId} · 이력 #{event.id}</small>
        </p>
      </li>)}
    </ol>}
    {page.nextBefore && <button disabled={pending} onClick={more}>{pending ? "이력 조회 중…" : "이전 이력 더 보기"}</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
