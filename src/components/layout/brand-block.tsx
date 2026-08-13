import { useTeamName } from '@stores/appearance-store';

/**
 * The hive tile and wordmark, top-left and always present.
 *
 * The tile is the app icon minus its prompt line — same window, same chrome,
 * same mark on the glass — cut from the same master by
 * `scripts/icon/generate-app-icon.py`. Top-left and dock therefore show one
 * design at two sizes, and neither can drift without the other.
 *
 * It arrives as a raster rather than tokens and a mark, which is deliberate on
 * the same grounds the fill was: a logo that changes colour with the theme
 * reads as a different logo. Baked pixels cannot flip.
 *
 * The concept sets the wordmark in a display serif. This app is deliberately
 * all-mono (`.claude/DESIGN-SYSTEM.md`), so the size and tracking come across
 * from the concept and the family does not.
 */
export function BrandBlock() {
  const teamName = useTeamName();

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <img
        /*
         * Resolved through `BASE_URL` rather than written as `/hive-tile.png`
         * (story 083). A built Electron app loads its renderer over `file://`,
         * where a root-relative URL points at the filesystem root and the tile
         * silently fails to load. `BASE_URL` is `/` for the browser target and
         * `./` for the desktop one.
         */
        src={`${import.meta.env.BASE_URL}hive-tile.png`}
        alt=""
        aria-hidden="true"
        className="size-[30px] shrink-0"
      />

      <div className="flex min-w-0 flex-col leading-[1.15]">
        <span className="text-[17px] tracking-[-0.02em]">The Hive</span>
        {/*
         * Whose hive this is — set in Appearance, blank by choice as often as
         * by default. An empty line is not rendered rather than rendered
         * empty: a 10px span with nothing in it still takes a row, and the
         * wordmark would sit off-centre against the tile for no reason.
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
