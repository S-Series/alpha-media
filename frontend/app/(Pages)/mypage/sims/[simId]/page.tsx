import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getSim } from "@/lib/sims-server";
import { kst } from "@/lib/format";
import SimTrackingPanel from "@/components/screens/sim-tracking-panel";

export default function SimDetailPage(props: PageProps<"/mypage/sims/[simId]">) {
  return <Suspense fallback={<p>SIM 확인 중…</p>}><Detail {...props} /></Suspense>;
}

async function Detail({ params }: PageProps<"/mypage/sims/[simId]">) {
  const { simId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(simId)) notFound();
  const result = await getSim(simId);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <p role="alert">SIM을 조회하지 못했습니다.</p>;
  }
  const profile = result.data;
  return <><h1>내 SIM 상세</h1><section className="home-panel">
    <dl className="detail-list">
      <dt>ICCID</dt><dd>{profile.iccid}</dd>
      <dt>발급 상태</dt><dd>발급 완료</dd>
      <dt>공급사 접수번호</dt><dd>{profile.supplierOrderNo}</dd>
      <dt>발급 시각</dt><dd>{kst(profile.issuedAt)}</dd>
    </dl>
    <Link href={`/mypage/orders/${profile.orderId}`}>주문 상세</Link>
  </section><SimTrackingPanel initial={profile} /><Link href="/mypage/sims">내 SIM 목록</Link></>;
}
