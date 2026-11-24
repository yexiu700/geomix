export function MarketingBrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="gm-mkt-brand-mark"
    >
      <circle cx="10" cy="10" r="9" fill="none" stroke="var(--gm-fg-3)" strokeWidth="1.2" />
      <circle cx="10" cy="10" r="6" fill="none" stroke="var(--gm-fg-3)" strokeWidth="1.2" />
      <circle cx="10" cy="10" r="3" fill="var(--gm-phosphor)" />
    </svg>
  );
}
