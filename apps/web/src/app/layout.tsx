import type {Metadata} from "next";
import type {ReactNode} from "react";
import {BottomNav, Footer, Header} from "@/components/Header";
import {NetworkBanner} from "@/components/Wallet";
import {Providers} from "@/components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "PONSHOT — Predict. Shot. Win.",
  description:
    "Predict whether $PONS finishes higher or lower each round. Settled on chain from a manipulation-resistant Uniswap V3 time-weighted average price.",
  openGraph: {
    title: "PONSHOT — Predict. Shot. Win.",
    description: "Round-based $PONS price prediction, settled on chain.",
    images: ["/brand/og.png"],
  },
  twitter: {card: "summary_large_image", images: ["/brand/og.png"]},
  // No `icons` key on purpose. Next detects app/favicon.ico, app/icon.svg and
  // app/apple-icon.png by convention and emits the <link> tags itself; declaring `icons`
  // here *replaces* that detection rather than adding to it, which is exactly what left
  // the browser tab with no icon at all.
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <NetworkBanner />
          <Header />
          <main className="mx-auto max-w-[1180px] px-4 py-5">{children}</main>
          <Footer />
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}
