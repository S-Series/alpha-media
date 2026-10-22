"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Order } from "@/lib/orders";
import { issuanceStatus, type IssuanceView } from "@/lib/issuance";
import { kst } from "@/lib/format";

export default function IssuancePanel({ orderId, status }: { orderId: string; status: Order["status"] }) {
  const [view, setView] = useState<IssuanceView | null>(null);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (status !== "PAID" && status !== "PAYMENT_PROCESSING") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/issuance`, {
          cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (!response.ok) {
          setError(response.status === 401 ? "로그인 후 발급 상태를 다시 확인해 주세요." : "발급 상태를 조회하지 못했습니다.");
          if (response.status >= 500) timer = setTimeout(poll, 3000);
          return;
        }
        const data: IssuanceView = await response.json();
        setView(data); setError(""); setCheckedAt(new Date().toLocaleTimeString("ko-KR"));
        if (!data.issuance || !["ISSUED", "FAILED", "REVIEW_REQUIRED"].includes(data.issuance.status)) timer = setTimeout(poll, 1500);
      } catch {
        if (!controller.signal.aborted) { setError("발급 서버에 연결하지 못했습니다. 다시 확인 중입니다."); timer = setTimeout(poll, 3000); }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [orderId, status, revision]);

  const job = view?.issuance, profile = view?.profile;
  return <section className="home-panel">
    <h2>eSIM 발급</h2>
    {status === "REFUND_PROCESSING" || status === "REFUNDED" ? <p>{status === "REFUNDED" ? "환불이 완료된 주문입니다." : "환불 확인 중입니다."} 발급 재시도는 중단됩니다.</p> :
    status !== "PAID" && status !== "PAYMENT_PROCESSING" ? <p>결제가 승인되면 서버가 자동으로 발급을 요청합니다.</p> : <>
      <p aria-live="polite">{job ? issuanceStatus(job.status) : "발급 작업을 확인 중입니다."}</p>
      {job && <>
        <p>발급 요청번호: {job.id}<br />공급사 접수번호: {job.supplierOrderNo ?? "접수 확인 중"}</p>
        <p>접수한 설정: {job.simulation.scenario === "SUCCEED" ? "발급 성공" : "발급 실패"}
          {" · "}콜백 지연 {job.simulation.callbackDelayMs / 1000}초 · 총 {job.simulation.callbackCopies}회 전송</p>
        <p>공급사 확인 {job.checkCount}회 · 마지막 상태 변경 {kst(job.updatedAt)}</p>
        {job.status === "FAILED" && <p role="alert">발급이 최종 실패했습니다. 운영자가 상태를 확인한 뒤 재시도 또는 전액 환불을 접수할 수 있습니다.</p>}
        {job.status === "REVIEW_REQUIRED" && <p role="alert">자동 확인을 중단하고 운영자 확인 대상으로 남겼습니다. 새 발급 요청을 중복 생성하지 않습니다.</p>}
        {job.lastError && <p>확인 사유: {job.lastError}</p>}
      </>}
      {profile && <>
        <p>ICCID: <code>{profile.iccid}</code></p>
        <p>활성화 코드: <code>{profile.activationCode}</code></p>
        <p>모의 공급사가 생성한 시연용 프로필이며 실제 기기에 설치할 수 없습니다.</p>
        <Link href={`/mypage/sims/${profile.id}`}>내 SIM 상세 보기</Link>
      </>}
      {checkedAt && <p>마지막 조회: {checkedAt} · 대기 중 화면은 1.5초 간격 갱신</p>}
      <p>화면을 닫아도 서버가 계속 처리합니다. 콜백 누락·지연은 공급사 결과 조회로 보완합니다.</p>
      <button type="button" onClick={() => setRevision(value => value + 1)}>발급 결과 다시 조회</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
