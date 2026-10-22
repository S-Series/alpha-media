"use client";

import Link from "next/link";
import { useState } from "react";
import { incidentStatuses, reconciliationKinds, useReconciliationAction, useReconciliationRead,
  type Incident, type IncidentDetail, type IncidentPage, type IncidentStatus } from "@/lib/admin-reconciliation";
import { kst } from "@/lib/format";

const base = "/api/admin/incidents";
type Receipt = { incident: Incident; replayed: boolean };

export default function AdminIncidents({ refresh, onRefresh }: { refresh: number; onRefresh: () => void }) {
  const [status, setStatus] = useState<IncidentStatus | "">("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const list = useReconciliationRead<IncidentPage>(`${base}?page=${page}&size=20${status ? `&status=${status}` : ""}`, refresh);
  const detail = useReconciliationRead<IncidentDetail>(selected ? `${base}/${selected}` : null, refresh);
  const action = useReconciliationAction<Receipt>("incident-investigation");
  const incident = detail.data?.incident;

  async function investigate(replay = false) {
    setMessage("");
    if (!replay && (!incident || incident.status === "RESOLVED" || !reason.trim())) return;
    const receipt = replay ? await action.replay() : await action.submit(`${base}/${incident!.id}/investigations`,
      { expectedVersion: incident!.version, reason: reason.trim() });
    if (receipt) {
      setSelected(receipt.incident.id);
      setMessage(`${receipt.replayed ? "기존 조사 기록 확인" : "조사 기록 접수 완료"} · 사건번호 ${receipt.incident.id}`);
    }
    onRefresh();
  }

  return <section className="home-panel"><h2>운영 사건·조사 이력</h2>
    <p>주문에 연결되지 않은 외부 처리도 사건으로 확인합니다. 조사 기록은 사건을 해결 처리하지 않습니다.</p>
    <p>외부 원장을 확인한 뒤 위의 <strong>누락·미해결 건 재조회</strong>를 실행하세요. 서버가 불일치 해소를 확인한 경우에만 자동으로 해결 상태가 됩니다.</p>
    <div className="screen-form">
      <label>사건 상태 <select value={status} onChange={event => { setStatus(event.target.value as IncidentStatus | ""); setPage(0); }}>
        <option value="">전체</option>{Object.entries(incidentStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <button onClick={onRefresh}>사건 목록 다시 조회</button>
    </div>
    {list.error && <p role="alert">{list.error} 마지막으로 확인한 목록을 유지합니다.</p>}
    {!list.data ? <p>운영 사건 조회 중…</p> : <>
      <p>서버 조회: {kst(list.data.checkedAt)} · 10초 간격 갱신</p>
      {list.data.items.length === 0 ? <p>조건에 맞는 운영 사건이 없습니다.</p> : <div className="table-scroll"><table>
        <caption>운영 사건 {list.data.page + 1}페이지 · 최대 {list.data.size}건</caption>
        <thead><tr><th>사건·대상</th><th>상태·조사자</th><th>발견 시각</th><th>연결</th></tr></thead>
        <tbody>{list.data.items.map(item => <tr key={item.id}>
          <td>{item.code}<br />{reconciliationKinds[item.kind]} · {item.targetId}</td>
          <td>{incidentStatuses[item.status]}<br />{item.actor || "조사자 미지정"}</td>
          <td>최초 {kst(item.firstSeenAt)}<br />최근 {kst(item.lastSeenAt)}</td>
          <td><button aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>조사 이력 보기</button><br />
            {item.orderId ? <Link href={`/admin/orders/${item.orderId}`}>주문 상세</Link> : "연결된 주문 없음"}</td>
        </tr>)}</tbody>
      </table></div>}
      <nav className="page-actions" aria-label="운영 사건 페이지">
        <button disabled={page === 0} onClick={() => setPage(value => value - 1)}>이전 사건</button>
        <span>{list.data.page + 1}페이지</span>
        <button disabled={!list.data.hasNext} onClick={() => setPage(value => value + 1)}>다음 사건</button>
      </nav>
    </>}
    {selected && <>
      <h3>선택한 사건</h3>
      {detail.error && <p role="alert">{detail.error} 마지막으로 확인한 사건을 유지합니다.</p>}
      {!incident ? <p>사건 상세 조회 중…</p> : <>
        <p>사건번호: {incident.id}<br />{incident.code} · {incidentStatuses[incident.status]} · 상태 버전 {incident.version}<br />
          대상: {reconciliationKinds[incident.kind]} · {incident.targetId}<br />
          조사자: {incident.actor || "미지정"} · 최근 사유: {incident.reason || "미기록"}<br />
          최초 발견: {kst(incident.firstSeenAt)} · 최근 발견: {kst(incident.lastSeenAt)}<br />
          해결 확인: {incident.resolvedAt ? kst(incident.resolvedAt) : "미해결"}</p>
        {incident.orderId && <p><Link href={`/admin/orders/${incident.orderId}`}>관련 주문 상세로 이동</Link></p>}
        <details><summary>현재 확인 근거</summary><p>외부 처리번호: {incident.externalReference || "없음"}<br />근거 해시: {incident.evidenceHash || "없음"}</p></details>
        <form className="screen-form" onSubmit={event => { event.preventDefault(); void investigate(); }}>
          <label>조사 사유·확인 내용 <textarea value={reason} required maxLength={300} disabled={action.blocked || incident.status === "RESOLVED"}
            onChange={event => setReason(event.target.value)} /></label>
          <button disabled={action.blocked || incident.status === "RESOLVED" || !reason.trim()}>조사 기록 남기기</button>
        </form>
        <p>다른 운영자가 상태를 변경하면 오래된 버전의 조사는 차단됩니다. 최신 사건을 조회한 뒤 다시 확인해 주세요.</p>
        <h4>조사·상태 변경 이력</h4>
        {detail.data?.events.length === 0 ? <p>아직 기록된 이력이 없습니다.</p> : <ol className="timeline">{detail.data?.events.map(event => <li key={event.id}>
          {kst(event.recordedAt)} · {incidentStatuses[event.status]} · {event.actor || "자동 대사"}<br />
          사유: {event.reason || "없음"}
          {event.evidenceHash && <details><summary>당시 근거 해시</summary><code>{event.evidenceHash}</code></details>}
        </li>)}</ol>}
      </>}
    </>}
    <div className="page-actions">
      <button disabled={action.pending || !action.draft} onClick={() => void investigate(true)}>동일 조사 요청 다시 확인</button>
      <button disabled={action.pending} onClick={onRefresh}>최신 사건 다시 조회</button>
    </div>
    {action.draft && <p>요청 키: <code>{action.draft.key}</code> · 최초 사건·상태 버전·사유를 그대로 다시 보냅니다.</p>}
    {action.draft?.uncertain && <p role="alert">조사 접수 결과가 불명확합니다. 다른 조사를 기록하기 전에 동일 요청으로 확인해 주세요.</p>}
    {action.error && <p role="alert">{action.error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
