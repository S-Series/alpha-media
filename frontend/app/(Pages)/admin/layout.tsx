import Link from "next/link";
import PreviewNotice from "@/components/screens/preview-notice";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <nav className="page-actions" aria-label="운영자 메뉴">
        <Link href="/admin/orders">주문 목록</Link>
        <Link href="/admin/issues">이상 건</Link>
        <Link href="/">고객 화면</Link>
      </nav>
      <PreviewNotice />
      {children}
    </>
  );
}
