"use client";

import Link from "next/link";
import type {ReactElement} from "react";
import {usePathname} from "next/navigation";
import {formatEth} from "@pons/sdk";
import {useAccount, useBalance} from "wagmi";
import {AccountAvatar, LogoMark, Wordmark} from "./Brand";
import {WalletButton} from "./Wallet";

const NAV = [
  {href: "/", label: "Predict"},
  {href: "/positions", label: "Positions"},
  {href: "/leaderboard", label: "Leaderboard"},
  {href: "/history", label: "History"},
];

export function Header() {
  const pathname = usePathname();
  const {address, isConnected} = useAccount();
  const {data: balance} = useBalance({address, query: {enabled: Boolean(address), refetchInterval: 12_000}});

  return (
    <header className="sticky top-0 z-40 border-b border-base-800 bg-base-950/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1180px] items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2.5" aria-label="PONSHOT home">
          <LogoMark size={34} />
          <span className="flex flex-col leading-none">
            <Wordmark />
            <span className="mt-0.5 hidden text-[8px] font-bold uppercase tracking-[0.24em] text-mute-600 sm:block">
              Predict. <span className="text-up-600">Shot.</span> Win.
            </span>
          </span>
        </Link>

        <nav className="hidden flex-1 items-center gap-1 md:flex">
          {NAV.map((n) => {
            const active = pathname === n.href;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`relative rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors ${
                  active ? "text-up-400" : "text-mute-400 hover:text-white"
                }`}
              >
                {n.label}
                {active && (
                  <span className="absolute inset-x-3 -bottom-[9px] h-[2px] rounded-full bg-up-500" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {isConnected && (
            <div className="hidden items-center gap-2 rounded-xl border border-base-700 bg-base-850 px-3 py-1.5 sm:flex">
              <LogoMark size={18} trail={false} />
              <span className="num text-sm font-semibold text-white">
                {balance ? formatEth(balance.value, 4) : "—"}
              </span>
              <span className="text-xs text-mute-500">ETH</span>
            </div>
          )}
          <WalletButton />
          {address && <AccountAvatar address={address} size={30} />}
        </div>
      </div>
    </header>
  );
}

/** Fixed bottom bar, matching the mobile shape of the design. */
export function BottomNav() {
  const pathname = usePathname();
  const item = (href: string, label: string, icon: ReactElement) => {
    const active = pathname === href;
    return (
      <Link
        key={href}
        href={href}
        className={`flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-semibold transition-colors ${
          active ? "text-up-400" : "text-mute-500 hover:text-mute-300"
        }`}
      >
        {icon}
        {label}
      </Link>
    );
  };

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-base-800 bg-base-950/95 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1180px] items-end px-2">
        {item("/", "Predict", <Icon d="M3 13h4l3 7 4-16 3 9h4" />)}
        {item("/positions", "Positions", <Icon d="M4 6h16M4 12h16M4 18h10" />)}

        <Link
          href="/"
          aria-label="Predict"
          className="relative -mt-6 flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-4 border-base-950 bg-base-950 shadow-glow-up"
        >
          <LogoMark size={44} trail={false} />
        </Link>

        {item("/leaderboard", "Leaderboard", <Icon d="M6 20V10M12 20V4M18 20v-7" />)}
        {item("/history", "History", <Icon d="M12 7v5l3 2M21 12a9 9 0 1 1-9-9" />)}
      </div>
    </nav>
  );
}

function Icon({d}: {d: string}) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/**
 * Non-affiliation notice.
 *
 * Required, not decorative: this application uses Robinhood Chain purely as a network and
 * PONS purely as a traded asset. Nothing here is operated or endorsed by either.
 */
export function Footer() {
  return (
    <footer className="mx-auto mt-14 max-w-[1180px] px-4 pb-6 text-[11px] leading-relaxed text-mute-500">
      <div className="flex items-center justify-center gap-3 border-t border-base-800 pt-6 pb-5">
        <LogoMark size={22} trail={false} />
        <Wordmark showArrow={false} className="scale-90" />
        <span className="text-base-600">|</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-mute-500">Powered by PONS</span>
      </div>
      <div>
        <p className="max-w-3xl">
          PONSHOT is an independent application. It is not operated, endorsed, sponsored by, or affiliated with
          Robinhood or with Pons. &ldquo;Robinhood Chain&rdquo; names the network the contracts run on;
          &ldquo;PONS&rdquo; names the asset whose price the market tracks, and
          &ldquo;powered by PONS&rdquo; describes that dependency — not a partnership.
        </p>
        <p className="mt-2 max-w-3xl">
          Outcomes are decided solely by the PonsPrediction contract from a Uniswap V3 time-weighted average
          price. This interface cannot influence any result. Predicting risks total loss of the amount you stake.
        </p>
      </div>
    </footer>
  );
}
