import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import PreviewNotice from "@/components/screens/preview-notice";
import {
  kst,
  money,
  previewOrders,
  previewPlans,
  previewSims,
} from "@/lib/preview-data";

export function generateStaticParams() {
  return previewSims.map(({ id }) => ({ simId: id }));
}

export default function SimDetailPage(
  props: PageProps<"/mypage/sims/[simId]">,
) {
  return (
    <>
      <h1>SIM 상세</h1>
      <PreviewNotice />
      <Suspense fallback={<p role="status">SIM 정보 확인 중…</p>}>
        <SimDetail {...props} />
      </Suspense>
    </>
  );
}

async function SimDetail({ params }: PageProps<"/mypage/sims/[simId]">) {
  const { simId } = await params;
  const sim = previewSims.find((item) => item.id === simId);
  if (!sim) notFound();
  const order = previewOrders.find((item) => item.id === sim.orderId)!;
  const plan = previewPlans.find((item) => item.id === order.planId)!;
  return (
    <>
      <section className="home-panel">
        <h2>{plan.name}</h2>
        <dl className="detail-list">
          <dt>결제 금액</dt>
          <dd>{money(plan.price)}</dd>
          <dt>현재 상태</dt>
          <dd>{sim.state}</dd>
          <dt>설치·개통</dt>
          <dd>{sim.installed}</dd>
          <dt>개통 시각</dt>
          <dd>{sim.activatedAt ? kst(sim.activatedAt) : "개통 전"}</dd>
          <dt>만료 시각</dt>
          <dd>{sim.expiresAt ? kst(sim.expiresAt) : "개통 후 확정"}</dd>
          <dt>남은 기간</dt>
          <dd>개통·만료 상태 조회 후 표시 · 상품 사용 일수 {plan.days}일</dd>
          <dt>마지막 확인</dt>
          <dd>{kst(order.updatedAt)} · 예시 시각</dd>
          <dt>환불</dt>
          <dd>
            {order.installation === "개통"
              ? "설치·개통으로 제한"
              : "최신 공급사 상태 확인 필요"}
          </dd>
        </dl>
        <button type="button" disabled>
          상태 다시 확인
        </button>
      </section>
      {plan.simType === "ESIM" ? (
        <section className="home-panel">
          <h2>eSIM 설치 정보</h2>
          <details>
            <summary>설치 정보 보기</summary>
            <div
              className="qr-placeholder"
              role="img"
              aria-label="설치용 QR이 표시될 영역"
            >
              QR 표시 영역
            </div>
            <p>활성화 코드: 발급 결과를 연결한 뒤 표시합니다.</p>
          </details>
          <p>
            QR 열람 여부와 실제 설치 상태를 구분합니다. 설치·개통은 공급사
            신호로 확인합니다.
          </p>
          <p>
            열람 기록: QR_VIEWED / 공급사에서 확인할 상태: INSTALLED · ACTIVE ·
            EXPIRED
          </p>
          <Link href="/guide">설치 안내</Link>
        </section>
      ) : (
        <section className="home-panel">
          <h2>USIM 수령·등록</h2>
          <p>
            공항 수령 대기입니다. 수령한 카드의 ICCID를 등록한 뒤 개통을
            요청합니다. 수령 장소와 운영 시간은 확정 후 표시합니다.
          </p>
          <div className="screen-form">
            <label>
              ICCID
              <input inputMode="numeric" placeholder="카드 뒷면의 ICCID" />
            </label>
            <button type="button" disabled>
              등록·개통 요청
            </button>
          </div>
          <p>
            자릿수·체크 디지트 오류와 다른 주문에 등록된 ICCID는 등록할 수
            없습니다.
          </p>
          <Link href="/guide">수령·등록 안내</Link>
        </section>
      )}
      <nav className="page-actions" aria-label="SIM 관련 화면">
        <Link href={`/mypage/orders/${order.id}`}>관련 주문 보기</Link>
        <Link href="/mypage/sims">내 SIM 목록</Link>
        <Link href="/support">고객지원</Link>
      </nav>
    </>
  );
}
