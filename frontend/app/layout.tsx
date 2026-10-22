import type { Metadata } from "next";
import SiteLayout from "@/components/layout/site-layout";
import Footer from "@/components/layout/footer";
import { Suspense } from "react";
import ScenarioGeneratorAccess from "@/components/layout/scenario-generator-access";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alpha Media",
  description: "여행용 eSIM·USIM 서비스",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body id="top">
        <a className="skip-link" href="#main-content">본문 바로가기</a>
        <SiteLayout>{children}</SiteLayout>
        <Footer />
        <Suspense fallback={null}><ScenarioGeneratorAccess /></Suspense>
      </body>
    </html>
  );
}
