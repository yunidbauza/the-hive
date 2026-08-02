/**
 * The hive mark and wordmark, top-left and always present.
 *
 * The tile keeps its Serenity blue in both themes (`bg-brand-fill-strong`, not
 * `bg-brand`) — a logo that changes colour with the theme reads as a different
 * logo.
 *
 * The concept sets the wordmark in a display serif. This app is deliberately
 * all-mono (`.claude/DESIGN-SYSTEM.md`), so the size and tracking come across
 * from the concept and the family does not.
 */
export function BrandBlock() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-brand-fill-strong">
        <img
          src="/hive-mark.png"
          alt=""
          aria-hidden="true"
          className="size-[19px] object-contain"
        />
      </div>

      <div className="flex min-w-0 flex-col leading-[1.15]">
        <span className="text-[17px] tracking-[-0.02em]">The Hive</span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-subtle">
          APFM Engineering
        </span>
      </div>
    </div>
  );
}
