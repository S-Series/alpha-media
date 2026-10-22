import Link from "next/link";

export default function SimsPage() {
  return <><h1>내 SIM</h1><p>아직 발급된 SIM이 없습니다.</p>
    <p>현재는 주문과 모의 결제까지 지원합니다. 공급사 발급을 연결하면 실제 발급된 SIM을 이곳에서 확인할 수 있습니다.</p>
    <Link href="/mypage/orders">주문 내역 확인</Link></>;
}
