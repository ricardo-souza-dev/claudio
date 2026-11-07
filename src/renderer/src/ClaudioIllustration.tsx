/** Local, theme-aware artwork for the empty conversation and project chooser. */
export function ClaudioIllustration() {
  return (
    <svg
      className="claudio-illustration"
      width="240"
      height="180"
      viewBox="0 0 240 180"
      role="img"
      aria-label="Claudio, um programador de óculos e fones, sorrindo atrás de um notebook"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Quiet background details echo the conversation's blue thread. */}
      <circle cx="119" cy="86" r="70" fill="var(--thread)" opacity="0.06" />
      <g fill="none" stroke="var(--thread)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.55">
        <path d="m41 64-8 7 8 7m13-14 8 7-8 7m-5-18-4 22" />
        <path d="M196 44v8m-4-4h8M27 118v6m-3-3h6" />
        <circle cx="206" cy="99" r="3" />
      </g>
      {/* Hoodie and neck. */}
      <path d="M68 151v-20c0-23 20-36 51-36s52 13 52 36v20" fill="var(--thread)" />
      <path d="m99 101 20 22 21-22" fill="none" stroke="#152b48" strokeOpacity="0.3" strokeWidth="3" strokeLinejoin="round" />
      <path d="M107 87v16c5 9 19 9 24 0V87" fill="#d99b78" />
      <path d="m102 114-2 19m36-19 2 19" stroke="#dce9ff" strokeWidth="2" strokeLinecap="round" />
      {/* Headphones sit behind the face. */}
      <path d="M83 65V53a36 36 0 0 1 72 0v12" fill="none" stroke="var(--ink-2)" strokeWidth="7" />
      <rect x="78" y="57" width="12" height="28" rx="6" fill="var(--thread)" />
      <rect x="149" y="57" width="12" height="28" rx="6" fill="var(--thread)" />
      <ellipse cx="88" cy="73" rx="7" ry="10" fill="#eab18c" />
      <ellipse cx="151" cy="73" rx="7" ry="10" fill="#eab18c" />
      <path d="M88 49c0-23 62-23 62 0v28c0 20-13 33-31 33S88 97 88 77Z" fill="#f0bd98" />
      {/* Swept hair, eyebrows and round glasses. */}
      <path d="M86 63V45c0-20 14-29 32-28 13-8 34 3 36 18 2 9-1 21-4 28l-5-20c-14 4-26 0-32-6-4 10-12 16-23 16l-1 10Z" fill="#30313b" />
      <path d="m97 59 12-1m20 0 12 1" fill="none" stroke="#65493d" strokeWidth="2.5" strokeLinecap="round" />
      <g fill="none" stroke="#30313b" strokeWidth="2.5">
        <rect x="93" y="64" width="22" height="17" rx="7" />
        <rect x="124" y="64" width="22" height="17" rx="7" />
        <path d="M115 70q4-3 9 0M88 67l5 2m53 0 5-2" />
      </g>
      <g fill="#30313b">
        <circle cx="105" cy="72" r="2" />
        <circle cx="134" cy="72" r="2" />
      </g>
      <path d="m119 75-2 9h4" fill="none" stroke="#cd8d6b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M101 88c3 13 31 18 38-1-5 5-10 4-19 4s-14 1-19-3Z" fill="#65493d" />
      <path d="M112 92q7 6 15 0" fill="none" stroke="#fff3e6" strokeWidth="2.5" strokeLinecap="round" />
      {/* Laptop with a small code mark instead of a vendor logo. */}
      <path d="M62 119a5 5 0 0 1 5-6h105a5 5 0 0 1 5 6l-7 46H69Z" fill="var(--bg-raised)" stroke="var(--ink-3)" strokeWidth="1.5" />
      <path d="m111 134-7 6 7 6m17-12 7 6-7 6m-7-14-4 16" fill="none" stroke="var(--thread)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M57 165h125l-4 5H62Z" fill="var(--bg-sunken)" stroke="var(--ink-3)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M42 171h155" stroke="var(--ink-3)" strokeWidth="1.5" strokeLinecap="round" opacity="0.35" />
    </svg>
  )
}
