import Link from "next/link";
import PreviewNotice from "@/components/screens/preview-notice";
import {
  money,
  previewOrders,
  previewPlans,
  previewSims,
} from "@/lib/preview-data";

export default function SimsPage() {
  return (
    <>
      <h1>내 SIM</h1>
      <PreviewNotice />
      <div className="home-links">
        {previewSims.map((sim) => {
          const order = previewOrders.find((item) => item.id === sim.orderId)!;
          const plan = previewPlans.find((item) => item.id === order.planId)!;
          return (
            <article className="home-panel" key={sim.id}>
              <h2>{plan.name}</h2>
              <p>{sim.state}</p>
              <p>
                결제 금액 {money(plan.price)} · {plan.days}일 요금제
              </p>
              <p>
                환불:{" "}
                {order.installation === "개통"
                  ? "설치·개통으로 제한"
                  : "최신 상태 확인 필요"}
              </p>
              <Link href={`/mypage/sims/${sim.id}`}>SIM 상세 보기</Link>
            </article>
          );
        })}
      </div>
    </>
  );
}
