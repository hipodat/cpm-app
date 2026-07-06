import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "건설공정관리",
  description: "산업단지·공장 건설 CPM 공정관리 (Critical Path Method)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
