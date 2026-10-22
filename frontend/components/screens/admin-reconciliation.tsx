"use client";

import Link from "next/link";
import { useState } from "react";
import { activeRun, reconciliationKinds, runModes, runStatuses, useReconciliationAction, useReconciliationRead,
  type ReconciliationDetail, type ReconciliationRun, type ReconciliationRuns } from "@/lib/admin-reconciliation";
import { kst } from "@/lib/format";
import AdminIncidents from "./admin-incidents";
import AdminMonitoring from "./admin-monitoring";

const base = "/api/admin/reconciliation-runs";
type Receipt = { run: ReconciliationRun; replayed: boolean };

export default function AdminReconciliation() {
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState<ReconciliationRun["mode"]>("PENDING");
  const [reason, setReason] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState("");
  const [incidentId, setIncidentId] = useState("");
  const list = useReconciliationRead<ReconciliationRuns>(base, refresh);
  const id = selected || list.data?.items[0]?.id || "";
  const detail = useReconciliationRead<ReconciliationDetail>(id ? `${base}/${id}?page=${page}&size=50` : null, refresh, 5000);
  const action = useReconciliationAction<Receipt>("reconciliation-runs");
  const interval = from && to ? (Date.parse(to) - Date.parse(from)) / 86400000 : null;
  const datesValid = mode === "PENDING" || (!from && !to) || (interval !== null && interval > 0 && interval <= 31);
  const activeCount = list.data?.items.filter(activeRun).length || 0;

  async function submit(replay = false) {
    setMessage("");
    if (!replay && (!reason.trim() || !datesValid)) return;
    const receipt = replay ? await action.replay() : await action.submit(base,
      { mode, reason: reason.trim(), ...(mode === "LEDGER" && from && to ? { from, to } : {}) });
    if (receipt) {
      setSelected(receipt.run.id); setPage(0);
      setMessage(`${receipt.replayed ? "기존 대사 접수 확인" : "대사 접수 완료"} · 실행번호 ${receipt.run.id}`);
    }
    setRefresh(value => value + 1);
  }

  return <>
    <AdminMonitoring refresh={refresh} onSelect={setIncidentId} />
    <section className="home-panel"><h2>주기적 대사 상태</h2>
      <p>마지막 대사 성공: {list.data?.lastSuccessfulAt ? kst(list.data.lastSuccessfulAt) : "성공 기록 확인 대기"}<br />
        화면 조회: {list.data?.checkedAt ? kst(list.data.checkedAt) : "조회 중"} · 실행 중 {activeCount}건</p>
      <p>대사는 기존 PG·공급사 결과를 조회합니다. 확인된 결제 결과의 후속 발급은 기존 처리 절차로 이어집니다.</p>
      <p><strong>대사 완료는 조회 작업의 완료입니다. 운영 사건이 모두 해결되었다는 의미는 아닙니다.</strong></p>
      {list.error && <p role="alert">{list.error} 마지막으로 확인한 목록을 유지합니다.</p>}
    </section>
    <section className="home-panel"><h2>수동 대사</h2>
      <p>누락·미해결 건 재조회는 미완료 처리와 미해결 운영 사건을 확인합니다. 원장 대사는 KST 시작일 포함, 종료일 제외입니다.</p>
      <form className="screen-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label>대사 방식 <select value={mode} disabled={action.blocked} onChange={event => setMode(event.target.value as ReconciliationRun["mode"])}>
          {Object.entries(runModes).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
        {mode === "LEDGER" && <>
          <label>시작일 포함 (KST) <input type="date" value={from} disabled={action.blocked} onChange={event => setFrom(event.target.value)} /></label>
          <label>종료일 제외 (KST) <input type="date" value={to} disabled={action.blocked} onChange={event => setTo(event.target.value)} /></label>
        </>}
        <label>실행 사유 <textarea value={reason} maxLength={300} required disabled={action.blocked} onChange={event => setReason(event.target.value)} /></label>
        <button type="submit" disabled={action.blocked || !reason.trim() || !datesValid}>대사 실행 접수</button>
      </form>
      {mode === "LEDGER" && <><p>날짜를 모두 비우면 최근 7개의 완료된 KST 날짜를 확인합니다. 직접 지정할 때는 두 날짜를 모두 입력하며 최대 31일입니다.</p>
        <p>오늘 데이터를 포함하려면 종료일을 내일로 지정하세요. 실제 종료 시각은 접수 시각으로 고정되며, 내일보다 뒤의 종료일은 허용하지 않습니다.</p></>}
      {!datesValid && <p role="alert">시작일보다 뒤의 종료일을 입력하고, 조회 기간을 31일 이내로 지정해 주세요.</p>}
      <div className="page-actions">
        <button disabled={action.pending || !action.draft} onClick={() => void submit(true)}>동일 대사 요청 다시 확인</button>
        <button disabled={action.pending} onClick={() => setRefresh(value => value + 1)}>대사 상태 다시 조회</button>
      </div>
      {action.draft && <p>요청 키: <code>{action.draft.key}</code> · 다시 확인하면 최초 방식·기간·사유를 그대로 보냅니다.</p>}
      {action.draft?.uncertain && <p role="alert">접수 결과가 불명확합니다. 새 실행을 만들기 전에 동일 대사 요청으로 확인해 주세요.</p>}
      {action.error && <p role="alert">{action.error}</p>}{message && <p role="status">{message}</p>}
    </section>
    <section className="home-panel"><h2>대사 실행 기록</h2>
      <p>자동·수동 실행을 함께 표시합니다. 목록은 10초, 선택한 실행 결과는 5초 간격으로 갱신합니다.</p>
      {!list.data ? <p>대사 목록 조회 중…</p> : list.data.items.length === 0 ? <p>아직 대사 실행 기록이 없습니다.</p> : <div className="table-scroll"><table>
        <caption>서버가 반환한 최근 대사 실행</caption><thead><tr><th>실행 시각·주체</th><th>방식·상태</th><th>처리 건수</th><th>상세</th></tr></thead>
        <tbody>{list.data.items.map(run => <tr key={run.id}>
          <td>{kst(run.createdAt)}<br />{run.actor || "자동 대사"}</td>
          <td>{runModes[run.mode]}<br />{runStatuses[run.status]}{run.lastError && <p>{run.lastError}</p>}</td>
          <td>대상 {run.itemCount} · 처리 {run.processedCount}<br />이상 {run.issueCount} · 수집 페이지 {run.pageCount}</td>
          <td><button aria-pressed={id === run.id} onClick={() => { setSelected(run.id); setPage(0); }}>실행 결과 보기</button><br />{run.id}</td>
        </tr>)}</tbody>
      </table></div>}
      {id && <>
        <h3>선택한 실행 결과</h3>
        {detail.error && <p role="alert">{detail.error} 마지막으로 확인한 결과를 유지합니다.</p>}
        {!detail.data ? <p>실행 결과 조회 중…</p> : <>
          <p>실행번호: {detail.data.run.id}<br />{runModes[detail.data.run.mode]} · {runStatuses[detail.data.run.status]} · 단계 {detail.data.run.phase}<br />
            실행자: {detail.data.run.actor || "자동 대사"} · 사유: {detail.data.run.reason}<br />
            시작: {kst(detail.data.run.createdAt)} · 완료: {detail.data.run.completedAt ? kst(detail.data.run.completedAt) : "미완료"}</p>
          {detail.data.run.mode === "LEDGER" && detail.data.run.fromAt && detail.data.run.toAt && <p>원장 기간: {kst(detail.data.run.fromAt)} 포함 ~ {kst(detail.data.run.toAt)} 제외</p>}
          <p>수집 {detail.data.run.pageCount}페이지 · 대상 {detail.data.run.itemCount}건 · 처리 {detail.data.run.processedCount}건 · 이상 {detail.data.run.issueCount}건 · 실행 시도 {detail.data.run.attemptCount}회</p>
          {detail.data.run.lastError && <p role="alert">실행 오류: {detail.data.run.lastError}</p>}
          {detail.data.items.length === 0 ? <p>이 페이지의 수집 결과가 없습니다.</p> : <div className="table-scroll"><table>
            <caption>대사 항목 {detail.data.page + 1}페이지 · 최대 {detail.data.size}건</caption>
            <thead><tr><th>대상</th><th>상태·결과</th><th>외부 결과·근거</th><th>주문</th></tr></thead>
            <tbody>{detail.data.items.map(item => <tr key={item.id}>
              <td>{reconciliationKinds[item.kind]}<br />{item.targetId}</td>
              <td>{item.status} · {item.outcome || "결과 대기"}<br />확인 시도 {item.attemptCount}회
                {item.lastError && <p>오류: {item.lastError}</p>}</td>
              <td>{item.externalStatus || "외부 상태 미확인"}<br />{item.checkedAt ? kst(item.checkedAt) : "확인 시각 없음"}
                <details><summary>확인 근거</summary><p>외부 처리번호: {item.externalReference || "없음"}<br />근거 해시: {item.evidenceHash || "없음"}<br />항목번호: {item.id}</p></details></td>
              <td>{item.orderId ? <Link href={`/admin/orders/${item.orderId}`}>주문 상세</Link> : "연결된 주문 없음"}</td>
            </tr>)}</tbody>
          </table></div>}
          <nav className="page-actions" aria-label="대사 항목 페이지">
            <button disabled={page === 0} onClick={() => setPage(value => value - 1)}>이전 결과</button>
            <span>{detail.data.page + 1}페이지</span>
            <button disabled={!detail.data.hasNext} onClick={() => setPage(value => value + 1)}>다음 결과</button>
          </nav>
        </>}
      </>}
    </section>
    <AdminIncidents refresh={refresh} onRefresh={() => setRefresh(value => value + 1)} selected={incidentId} onSelect={setIncidentId} />
  </>;
}
