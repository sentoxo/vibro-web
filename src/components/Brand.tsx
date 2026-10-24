// Inline SVG waveform logo + wordmark (no icon package, plan §5.6).

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a class="brand" href="." aria-label="Vibro home" onClick={(e) => e.preventDefault()}>
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M2 12h2.2l1.6-6 2.4 12 2.4-9 2.2 6 1.8-3.4 1.4 2.4H22" />
      </svg>
      {!compact && <span class="brand-word">VIBRO</span>}
    </a>
  );
}
