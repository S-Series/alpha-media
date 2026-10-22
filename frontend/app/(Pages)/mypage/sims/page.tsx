import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSims } from "@/lib/sims-server";
import { kst } from "@/lib/format";
import { simStatus } from "@/lib/issuance";

export default function SimsPage() {
  return <><h1>내 SIM</h1><Suspense fallback={<p>SIM 조회 중…</p>}><Sims /></Suspense>
    <Link href="/mypage/orders">주문 내역 확인</Link></>;
}

async function Sims() {
  const result = await getSims();
  if (!result.ok) {
    if (result.status === 401) redirect("/login");
    return <p role="alert">SIM을 조회하지 못했습니다.</p>;
  }
  return <>{result.data.length === 0 ? <p>아직 발급된 SIM이 없습니다.</p> : <>
    <p>최근 발급 최대 100건 · 모의 공급사의 시연용 프로필입니다.</p>
    {result.data.map(profile => <article key={profile.id} className="home-panel">
      <h2>ICCID {profile.iccid}</h2><p>{simStatus(profile.installStatus)} · 발급 {kst(profile.issuedAt)}</p>
      <Link href={`/mypage/sims/${profile.id}`}>SIM 상세 보기</Link>
    </article>)}
  </>}</>;
}
