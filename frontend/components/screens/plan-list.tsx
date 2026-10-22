import Link from "next/link";
import { money } from "@/lib/format";
import type { Plan } from "@/lib/plans";

export default function PlanList({
  plans,
}: {
  plans: readonly Plan[];
}) {
  return (
    <div className="home-links">
      {plans.map((plan) => (
        <article className="home-panel" key={plan.id}>
          <h3>{plan.name}</h3>
          <p>
            {plan.country} · {plan.days}일 ·{" "}
            {plan.dataMb.toLocaleString("ko-KR")}MB · {plan.simType}
          </p>
          <p>{money(plan.price)}</p>
          <Link href={`/plans/${plan.id}`}>요금제 상세 보기</Link>
        </article>
      ))}
      {plans.length === 0 && <p>조건에 맞는 요금제가 없습니다.</p>}
    </div>
  );
}
