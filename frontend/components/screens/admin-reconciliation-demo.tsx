"use client";

import Link from "next/link";
import { useState } from "react";
import { useReconciliationAction, useReconciliationRead } from "@/lib/admin-reconciliation";
import { kst, money } from "@/lib/format";

type Kind = "CONFLICTING_DECLINE" | "EXTERNAL_CANCELLATION";
type Demo = { id: string; paymentId: string; kind: Kind; actor: string; reason: string; eventId: string; cancellationId: string | null;
  amount: number; copies: number; delayMs: number; status: string; sentCount: number; attemptCount: number; lastError: string | null; createdAt: string };
type View = { demos: Demo[]; ledger: { paymentId: string; status: string; amount: number; cancelledAmount: number }[];
  incidents: { id: string; code: string; status: string }[]; checkedAt: string };
const names: Record<Kind, string> = { CONFLICTING_DECLINE: "승인 후 거절 통지", EXTERNAL_CANCELLATION: "PG에서만 전액 취소" };
const states: Record<string, string> = { PENDING: "전송 대기", SENDING: "전송 중", DELIVERED: "시연 전달 완료", REVIEW_REQUIRED: "전송 확인 필요" };

function ledgerLink(time: string) {
  const from = new Date(time).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return `/admin/reconciliation?from=${from}&to=${to}#manual-reconciliation`;
}

export default function AdminReconciliationDemo({ orderId, eligible, onRefresh }: {
  orderId: string; eligible: boolean; onRefresh: () => void;
}) {
  const [kind, setKind] = useState<Kind>("CONFLICTING_DECLINE");
  const [reason, setReason] = useState("");
  const [copies, setCopies] = useState(2);
  const [delayMs, setDelayMs] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [message, setMessage] = useState("");
  const path = `/api/admin/orders/${orderId}/reconciliation-demo`;
  const view = useReconciliationRead<View>(path, refresh, 3000);
  const action = useReconciliationAction<{ demo: Demo; replayed: boolean }>(`reconciliation-demo:${orderId}`);
  const existing = (view.data?.demos.length || 0) > 0;
  const blockedReason = action.pending ? "시연 접수 중입니다." : action.draft?.uncertain ? "이전 요청의 응답을 확인하지 못했습니다. ‘같은 요청으로 접수 확인’을 먼저 눌러 주세요."
    : existing ? "이 주문에는 이미 시연이 생성되어 있습니다. 다른 종류를 시연하려면 새 ‘발급 실패·환불 미접수’ 주문을 생성하세요."
    : !eligible ? "환불·SIM·상충이 없는 ‘발급 실패·환불 미접수’ 주문이 필요합니다."
    : view.error ? "조회에 실패했습니다. 아래 오류를 확인하세요."
    : !view.data || action.blocked ? "시연 가능 상태를 조회 중입니다."
    : !reason.trim() ? "시연 사유를 입력하세요." : "";
  async function submit(replay = false) {
    const result = replay ? await action.replay() : await action.submit(path, {
      kind, reason: reason.trim(), copies: kind === "CONFLICTING_DECLINE" ? copies : 1, delayMs: kind === "CONFLICTING_DECLINE" ? delayMs : 0,
    });
    if (result) setMessage(`${result.replayed ? "기존 시연 확인" : "시연 접수 완료"} · ${result.demo.id}`);
    setRefresh(value => value + 1); onRefresh();
  }
  return <section className="home-panel">
    <h2>상충·대사 시연</h2>
    <p>시나리오 데이터 생성에서 ‘발급 실패’를 만든 뒤 실행하세요. 주문당 한 종류만 생성하며, 상충을 지우거나 강제 해결하지 않습니다.</p>
    <div className="screen-form">
      <label>시연 종류 <select value={kind} disabled={action.blocked} onChange={e => setKind(e.target.value as Kind)}>
        {Object.entries(names).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {kind === "CONFLICTING_DECLINE" ? <>
        <p>승인 원장은 그대로 두고, 반대 결과를 서명된 웹훅으로 보냅니다. 수신함 처리 후 상충 사건이 생기고 환불·재발급이 차단됩니다.</p>
        <label>통지 횟수 {copies}회 <input type="range" min={1} max={20} step={1} value={copies} disabled={action.blocked}
          onChange={e => setCopies(Number(e.target.value))} /></label>
        <label>최초 통지 지연 {delayMs / 1000}초 <input type="range" min={0} max={60000} step={1000} value={delayMs} disabled={action.blocked}
          onChange={e => setDelayMs(Number(e.target.value))} /></label>
        <p>전송은 요청 횟수 + 5회까지 시도합니다. 수신함·상충 처리 상태는 위 영역에서 확인하세요.</p>
      </> : <p>모의 PG에서만 전액 취소합니다. 내부 환불을 새로 만들지 않으며, 아래 원장 대사에서 취소액 반영과 미연결 취소 사건을 확인합니다.</p>}
      <label>시연 사유 <textarea maxLength={300} value={reason} disabled={action.blocked} onChange={e => setReason(e.target.value)} /></label>
      <button disabled={!!blockedReason} aria-describedby="reconciliation-demo-help" onClick={() => void submit()}>시연 생성</button>
      {action.draft && <button disabled={action.pending} onClick={() => void submit(true)}>같은 요청으로 접수 확인</button>}
    </div>
    {blockedReason && <p id="reconciliation-demo-help" role="status">시연 생성 제한: {blockedReason}</p>}
    {message && <p role="status">{message}</p>}{action.error && <p role="alert">{action.error}</p>}
    {view.error && <p role="alert">{view.error} 아래 내용은 마지막 조회 결과입니다.</p>}
    {view.data && <>
      <p>조회 시각: {kst(view.data.checkedAt)}</p>
      {view.data.ledger.map(row => <p key={row.paymentId}>PG 결제번호: {row.paymentId}<br />
        승인 상태: {row.status} · 요청액 {money(row.amount)} · PG 취소 누계 <strong>{money(row.cancelledAmount)}</strong></p>)}
      {view.data.demos.map(demo => <article key={demo.id}>
        <h3>{names[demo.kind]} · {states[demo.status]}</h3>
        <p>{demo.actor} · {kst(demo.createdAt)} · {demo.reason}</p>
        <p>{demo.kind === "CONFLICTING_DECLINE" ? `이벤트 ${demo.eventId} · 통지 ${demo.sentCount}/${demo.copies}회 · 전송 시도 ${demo.attemptCount}/${demo.copies + 5}회` : `PG 취소번호 ${demo.cancellationId}`}</p>
        {demo.lastError && <p role="alert">{demo.lastError}</p>}
        <Link href={ledgerLink(demo.createdAt)}>시연 날짜의 원장 대사로 이동</Link>
      </article>)}
      <p>원장 대사는 선택 기간의 전체 주문을 조회합니다. ‘시연 전달 완료’는 통지·PG 취소 완료이며, 대사 완료나 사건 해결을 뜻하지 않습니다.</p>
      <h3>이 주문의 운영 사건</h3>
      {view.data.incidents.length === 0 ? <p>조회된 사건이 없습니다. 통지 처리 또는 원장 대사 이후 다시 확인하세요.</p> : view.data.incidents.map(incident => <p key={incident.id}>
        <Link href={`/admin/reconciliation?incident=${incident.id}#operational-incidents`}>{incident.code} · {incident.status}</Link>
      </p>)}
    </>}
  </section>;
}
