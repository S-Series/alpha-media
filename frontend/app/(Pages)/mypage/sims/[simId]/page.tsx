import { Suspense } from "react";
import { notFound } from "next/navigation";

export default function SimDetailPage(props: PageProps<"/mypage/sims/[simId]">) {
  return <Suspense fallback={<p>SIM 확인 중…</p>}><Detail {...props} /></Suspense>;
}

async function Detail({ params }: PageProps<"/mypage/sims/[simId]">) {
  await params;
  return notFound();
}
