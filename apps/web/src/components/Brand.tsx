/**
 * PONSHOT identity.
 *
 * Drawn as inline SVG rather than shipped as bitmaps: it stays crisp at every size, costs
 * no extra request, and can pick up the surrounding colour. Raster versions of the same
 * artwork live in `public/brand/` for the places a bitmap is unavoidable — the favicon and
 * the social preview — see the README there.
 *
 * The mark is a glossy black coin carrying a lime "P", trailing a comet streak with a
 * smaller coin at its head: the "shot" the name refers to.
 */

let uid = 0;
/** Gradient ids must be unique per instance or a second copy on the page reuses the first one's fills. */
const nextId = () => `ps${(uid = (uid + 1) % 100000)}`;

export function LogoMark({size = 32, className = "", trail = true}: {size?: number; className?: string; trail?: boolean}) {
  const id = nextId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      className={className}
      role="img"
      aria-label="PONSHOT"
    >
      <defs>
        <radialGradient id={`${id}-coin`} cx="38%" cy="30%" r="78%">
          <stop offset="0%" stopColor="#3a3f36" />
          <stop offset="45%" stopColor="#16181a" />
          <stop offset="100%" stopColor="#050607" />
        </radialGradient>
        <linearGradient id={`${id}-p`} x1="34" y1="26" x2="86" y2="102" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#cdfa7a" />
          <stop offset="42%" stopColor="#9be81c" />
          <stop offset="100%" stopColor="#77b512" />
        </linearGradient>
        <linearGradient id={`${id}-streak`} x1="118" y1="12" x2="70" y2="62" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#b4f53f" stopOpacity="1" />
          <stop offset="100%" stopColor="#9be81c" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-gloss`} x1="30" y1="20" x2="70" y2="72" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {trail && (
        <g>
          {/* Comet streak, thinning as it leaves the coin. */}
          <path d="M74 54 L116 14" stroke={`url(#${id}-streak)`} strokeWidth="9" strokeLinecap="round" />
          <path d="M69 62 L108 22" stroke={`url(#${id}-streak)`} strokeWidth="4.5" strokeLinecap="round" opacity="0.75" />
          <path d="M78 47 L120 8" stroke={`url(#${id}-streak)`} strokeWidth="2.5" strokeLinecap="round" opacity="0.55" />
          {/* Small coin at the head of the streak. */}
          <circle cx="112" cy="17" r="13.5" fill={`url(#${id}-coin)`} stroke="#9be81c" strokeWidth="2.5" />
          <path
            d="M108.4 24.5V9.8h5.6c3 0 5.1 2 5.1 4.9 0 3-2.1 4.9-5.1 4.9h-2.1v4.9h-3.5Zm3.5-7.7h1.8c1.1 0 1.8-.6 1.8-1.5s-.7-1.5-1.8-1.5h-1.8v3Z"
            fill="#9be81c"
          />
        </g>
      )}

      {/* Main coin */}
      <circle cx="60" cy="66" r="52" fill={`url(#${id}-coin)`} />
      <circle cx="60" cy="66" r="52" fill="none" stroke="#9be81c" strokeWidth="4.5" />
      <ellipse cx="46" cy="42" rx="30" ry="20" fill={`url(#${id}-gloss)`} transform="rotate(-24 46 42)" />

      {/*
        The "P": a bowl over a stem whose foot is cut on a diagonal, so the letterform
        reads as leaning into the shot rather than sitting square.
      */}
      <path
        d="M38 100V32h26.5c13.4 0 22.6 8.8 22.6 21.8 0 13.1-9.2 21.9-22.6 21.9H53.6V100l-8 -6.5-7.6 6.5Z"
        fill={`url(#${id}-p)`}
      />
      <path d="M53.6 61.6h9.2c4.6 0 7.6-2.6 7.6-6.6s-3-6.6-7.6-6.6h-9.2v13.2Z" fill="#0b0d0a" />
    </svg>
  );
}

/**
 * The wordmark: "PON" in lime, "SHOT" in white, obliqued, with an arrow lifting off the end.
 */
export function Wordmark({className = "", showArrow = true}: {className?: string; showArrow?: boolean}) {
  return (
    <span className={`relative inline-flex items-baseline ${className}`}>
      <span className="skew-x-[-9deg] text-[19px] font-black italic tracking-[-0.02em] text-up-500">PON</span>
      <span className="skew-x-[-9deg] text-[19px] font-black italic tracking-[-0.02em] text-white">SHOT</span>
      {showArrow && (
        <svg width="11" height="11" viewBox="0 0 12 12" className="ml-0.5 -translate-y-2.5" aria-hidden="true">
          <path d="M2 10L10 2M10 2H4.5M10 2v5.5" stroke="#9be81c" strokeWidth="2.2" strokeLinecap="round"
                strokeLinejoin="round" fill="none" />
        </svg>
      )}
    </span>
  );
}

/** Full lockup with the tagline, for empty states and the footer. */
export function LogoLockup({size = 64, className = ""}: {size?: number; className?: string}) {
  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <LogoMark size={size} />
      <Wordmark />
      <span className="text-[9px] font-bold uppercase tracking-[0.34em] text-mute-500">
        Predict. <span className="text-up-500">Shot.</span> Win.
      </span>
    </div>
  );
}

/**
 * Token avatar.
 *
 * A monogram rather than a remote image: no external request, nothing to break if a CDN
 * is down, and nothing that could be mistaken for official token artwork.
 */
export function TokenAvatar({size = 40, symbol = "P"}: {size?: number; symbol?: string}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full border-2 border-up-500/70 bg-gradient-to-br from-base-700 to-base-950 font-black italic text-up-500"
      style={{width: size, height: size, fontSize: size * 0.46}}
    >
      {symbol}
    </div>
  );
}

/**
 * Identicon for a wallet.
 *
 * Derived from the address itself, so the same wallet always looks the same with no
 * lookup and no avatar service. Decorative only — the address stays visible beside it.
 */
export function AccountAvatar({address, size = 26}: {address: string; size?: number}) {
  const seed = parseInt(address.slice(2, 10), 16) || 0;
  const hue = seed % 360;
  const hue2 = (hue + 48) % 360;
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black/70"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${hue} 62% 58%), hsl(${hue2} 62% 42%))`,
      }}
      title={address}
    >
      {address.slice(2, 4).toUpperCase()}
    </div>
  );
}
