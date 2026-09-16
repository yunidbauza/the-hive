/**
 * One bar of a loading placeholder.
 *
 * The width arrives as a class rather than a prop with a number, because each
 * skeleton picks widths that mirror the card it stands in for — see
 * `pr-card-skeleton.tsx` and `ticket-card-skeleton.tsx` for why the geometry
 * matching matters.
 */
export function SkeletonBar({ className }: { className: string }) {
  return <span className={`block h-2.5 rounded-full bg-chip ${className}`} />;
}
