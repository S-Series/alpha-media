"use client";

import Link from "next/link";
import { incidentStatuses, useReconciliationRead, type IncidentStatus } from "@/lib/admin-reconciliation";
import { kst } from "@/lib/format";

const names: Record<string, string> = { PROTECTION: "SIM 차단·정리", PAYMENT: "결제", REFUND: "환불", ISSUANCE: "발급", PROFILE: "SIM 추적", INBOUND: "웹훅",
  RECOVERY: "운영자 복구", RECONCILIATION: "대사", RECONCILIATION_PAGE: "대사 원장 수집", RECONCILIATION_ITEM: "대사 거래 조회" };
const statuses: Record<string, string> = { HEALTHY: "정상", DEGRADED: "확인 필요", STALE: "감시 결과 지연", STARTING: "첫 점검 대기", DISABLED: "감시 비활성" };
type Monitoring = { status: string; lastCheckedAt: string | null; checkedAt: string; unresolvedIncidents: number;
  heartbeatThresholdSeconds: number; backlogThresholdSeconds: number; supplierThresholdSeconds: number;
  workers: { name: string; enabled: boolean; lastSeenAt: string | null; silentSeconds: number; overdue: boolean }[];
  queues: { name: string; count: number; orderId: string | null; waitingSeconds: number; overdue: boolean }[];
  supplierFailures: { kind: string; id: string; orderId: string; since: string; error: string; failureSeconds: number; overdue: boolean }[];
  alerts: { id: string; incidentId: string; status: IncidentStatus; actor: string | null; reason: string | null;
    recordedAt: string; kind: string; code: string; orderId: string | null }[] };

export default function AdminMonitoring({ refresh, onSelect }: { refresh: number; onSelect: (id: string) => void }) {
  const result = useReconciliationRead<Monitoring>("/api/admin/monitoring", refresh, 5000);
  const data = result.data;
  return <section className="home-panel"><h2>장애 감시·알림</h2>
    <p><strong>{result.error ? "현재 감시 상태 확인 불가" : data ? statuses[data.status] || data.status : "감시 상태 조회 중"}</strong></p>
    {result.error && <p role="alert">{result.error} 아래는 마지막 조회 결과입니다. 현재 정상이라는 의미가 아닙니다.</p>}
    <p>워커 신호 60초 초과 누락, 실행 가능한 작업 2분 초과 대기, 공급사 확인 실패 5분 초과를 감지합니다.</p>
    <p>서버 전체 종료·DB 전체 장애는 이 화면의 내부 감시만으로 통지할 수 없습니다. 외부 가용성 감시가 별도로 필요합니다. 이메일·Slack 전송은 연결되어 있지 않습니다.</p>
    {data && <>
      <p>마지막 감시 완료: {data.lastCheckedAt ? kst(data.lastCheckedAt) : "아직 없음"} · 화면 조회: {kst(data.checkedAt)}<br />
        미해결 운영 사건: {data.unresolvedIncidents}건 · 감시 결과가 30초 넘게 갱신되지 않으면 지연으로 표시합니다.</p>
      <details><summary>워커 신호와 실행 대기열</summary>
        <div className="table-scroll"><table><caption>업무 워커의 실행 신호, 업무 성공 여부와는 별개입니다.</caption>
          <thead><tr><th>워커</th><th>신호</th><th>마지막 신호</th></tr></thead>
          <tbody>{data.workers.map(worker => <tr key={worker.name}><td>{names[worker.name] || worker.name}</td>
            <td>{!worker.enabled ? "비활성" : worker.overdue ? "60초 초과 누락" : !worker.lastSeenAt ? "첫 실행 대기" : "수신 중"}</td>
            <td>{worker.lastSeenAt ? kst(worker.lastSeenAt) : "없음"} · {worker.silentSeconds}초</td></tr>)}</tbody>
        </table></div>
        <div className="table-scroll"><table><caption>예약 시각 도달·처리 잠금 만료 후 실행 가능한 작업</caption>
          <thead><tr><th>대기열</th><th>실행 대기</th><th>최장 대기</th><th>주문</th></tr></thead>
          <tbody>{data.queues.map(queue => <tr key={queue.name}><td>{names[queue.name] || queue.name}</td><td>{queue.count}건</td>
            <td>{queue.waitingSeconds}초 {queue.overdue && "· 2분 초과"}</td><td>{queue.orderId && <Link href={`/admin/orders/${queue.orderId}`}>가장 오래 기다린 주문</Link>}</td></tr>)}</tbody>
        </table></div>
      </details>
      <details><summary>공급사 연속 확인 실패 {data.supplierFailures.length}건</summary>
        {data.supplierFailures.length === 0 ? <p>기록된 연속 실패가 없습니다.</p> : <ul>{data.supplierFailures.map(failure => <li key={`${failure.kind}:${failure.id}`}>
          {names[failure.kind]} · {failure.error} · {failure.failureSeconds}초 {failure.overdue && "· 5분 초과"}<br />
          최초 실패: {kst(failure.since)} · <Link href={`/admin/orders/${failure.orderId}`}>주문 상세</Link>
        </li>)}</ul>}
      </details>
      <h3>최근 상태 변경 알림</h3>
      <p>최근 50건입니다. 같은 장애의 반복 점검은 알림을 늘리지 않고, 새 근거·조사·회복·재발을 기록합니다.</p>
      {data.alerts.length === 0 ? <p>아직 상태 변경 알림이 없습니다.</p> : <ol className="timeline">{data.alerts.map(alert => <li key={alert.id}>
        {kst(alert.recordedAt)} · {incidentStatuses[alert.status]} · {alert.code}<br />
        {alert.actor || "SYSTEM"} · {alert.reason || "사유 없음"} · <a href="#operational-incidents" onClick={() => onSelect(alert.incidentId)}>해당 사건·조사 이력</a>
      </li>)}</ol>}
    </>}
  </section>;
}
