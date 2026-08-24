import { SwarmCreature } from '@components/ui/swarm-creature';
import { useTeamName } from '@stores/appearance-store';

/**
 * The hive and the wordmark, top-left and always present.
 *
 * ## The mark breathes now (HIVE-100)
 *
 * This was `hive-tile.png` — the app icon minus its prompt line, cut from the
 * same master as the dock icon by `scripts/icon/generate-app-icon.py`, so that
 * top-left and dock showed one design at two sizes and neither could drift
 * without the other. That link is deliberately cut: the mark is now the live
 * hive sprite, the same one the empty fleet and the settings cards use.
 *
 * What is given up is the guarantee that the corner and the dock agree. What is
 * bought is that the corner of a **swarm command centre** is alive — the app's
 * one persistent chrome element does the thing the app is named for. The dock
 * icon is unchanged and still generated from the master; it simply is no longer
 * the same image as this one.
 *
 * The old tile also argued that baked pixels cannot flip with the theme, and a
 * logo that changes colour reads as a different logo. That argument survives
 * intact — the sprite is a raster with its own palette and no tokens in it.
 *
 * ## Size
 *
 * A third register for {@link SwarmCreature}, and the smallest: 34px against a
 * 56px header row. Smaller than the rails' 44px because this is a *mark* beside
 * a wordmark rather than an illustration standing in for missing content, and
 * because the header is the one row that is never empty — everything on it is
 * competing with the terminal for attention, so it earns its place by being
 * small.
 *
 * The concept sets the wordmark in a display serif. This app is deliberately
 * all-mono (`.claude/DESIGN-SYSTEM.md`), so the size and tracking come across
 * from the concept and the family does not.
 */
export function BrandBlock() {
  const teamName = useTeamName();

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {/*
        `SwarmCreature` rather than an `<img>` of its own, so the header cannot
        drift from the other seven surfaces that draw this sprite — and so it
        inherits the reduced-motion fallback for free. Under the preference the
        mark is the single-frame file: still there, simply holding still.
      */}
      <SwarmCreature creature="hive" size={34} />

      <div className="flex min-w-0 flex-col leading-[1.15]">
        <span className="text-[17px] tracking-[-0.02em]">The Hive</span>
        {/*
         * Whose hive this is — set in Appearance, blank by choice as often as
         * by default. An empty line is not rendered rather than rendered
         * empty: a 10px span with nothing in it still takes a row, and the
         * wordmark would sit off-centre against the mark for no reason.
         */}
        {teamName ? (
          <span className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-subtle">
            {teamName}
          </span>
        ) : null}
      </div>
    </div>
  );
}
