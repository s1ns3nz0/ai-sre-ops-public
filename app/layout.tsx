import type { Metadata } from "next";
import { IBM_Plex_Sans } from "next/font/google";
import { Suspense } from "react";
import { TimeBar } from "@/components/TimeBar.tsx";
import { shifts } from "@/lib/shifts.ts";
import "./globals.css";

const plex = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex" });

export const metadata: Metadata = {
  title: "AI SRE Ops",
  description: "Lineth L2 incident console",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${plex.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {/* TimeBar reads the URL (active nav item), so it streams in; the fallback keeps the bar's height. */}
        <Suspense fallback={<div className="h-[5.75rem] bg-bar" />}>
          <TimeBar shifts={shifts()} />
        </Suspense>
        <main className="flex-1 w-full">{children}</main>
      </body>
    </html>
  );
}
