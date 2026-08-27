import { useState } from 'react';

import { ThemeCard } from '@features/settings/components/theme-card';
import { ThemeImportResult } from '@features/settings/components/theme-import-result';
import { BUILT_IN_THEMES } from '@lib/theme/built-in-themes';
import type { HiveTheme } from '@lib/theme/contract';
import { PickThemeFailure, pickThemeFile, saveThemeFile } from '@lib/theme/files';
import { themeTemplateJson, themeToJson, TEMPLATE_FILE_NAME } from '@lib/theme/template';
import { importTheme, type ImportResult } from '@lib/theme/validate';
import {
  useActiveThemeId,
  useThemeLibraryActions,
  useThemes,
} from '@stores/appearance-store';

/**
 * The Themes gallery — the settings epic's first group (HIVE-80, story 11).
 *
 * Self-contained: it reads the theme library through the store's own selector
 * hooks and owns the import flow end to end, so `appearance-section.tsx` only
 * has to mount it.
 *
 * ## The import flow
 *
 * `pickThemeFile()` → `importTheme(contents, name)` → on success `addTheme`
 * then `activateTheme`; on failure nothing in the store changes. Either way
 * the result is kept in local state so `ThemeImportResult` can render it, and
 * it stays until the person dismisses it — a fresh import overwrites whatever
 * banner was showing, same as any other "latest result" state.
 *
 * `pickThemeFile()` can **reject** (an oversize file, per `files.ts`) as well
 * as resolve `null` (the dialog was cancelled). Only the rejection produces a
 * banner — a cancel is the person closing a dialog they opened, and showing
 * them a card about it would be answering a question they did not ask.
 */

const VALID_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * How long an id may get.
 *
 * A theme's `name` is untrusted text out of a file that may be up to 256 KB,
 * and this id becomes a `localStorage` key \u2014 so an unbounded slug let a
 * hostile (or merely absurd) file spend the whole storage quota on a key with
 * no value attached to it. Long enough to stay readable in devtools, short
 * enough that the bound is the interesting thing rather than the name.
 */
const MAX_ID_LENGTH = 48;

/** A theme name, turned into something fit to be an object key and a filename stem. */
function slugify(name: string): string {
  const cleaned = name
    // Bounded *before* the normalise, not after: NFKD on a 200 KB string is
    // the expensive half, and nothing past this point can survive the slice.
    .slice(0, MAX_ID_LENGTH * 4)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/, '');
  return VALID_ID.test(cleaned) ? cleaned : 'theme';
}

/**
 * `slugify`'d and de-duplicated against every id already in use — the
 * every built-in's and every imported theme's. Never resolves to a shipped id:
 * all of them are checked into `existingIds` below, so a theme literally named
 * "Hive" — or "Cinder" — collides on the first try and is pushed to `hive-2`
 * the same as any other duplicate.
 */
function uniqueThemeId(name: string, existingIds: ReadonlySet<string>): string {
  const base = slugify(name);
  if (!existingIds.has(base)) return base;

  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function ThemeGallery() {
  const themes = useThemes();
  const activeThemeId = useActiveThemeId();
  const { addTheme, activateTheme, removeTheme } = useThemeLibraryActions();

  const [result, setResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);

  /**
   * No re-entrancy guard here: the button this drives sets `disabled` from
   * the same `importing` flag, so a second invocation while one is in flight
   * is not a state a click can reach — the guard would be dead code a test
   * could only fake, not exercise.
   */
  const onImport = async () => {
    setImporting(true);
    try {
      const picked = await pickThemeFile().catch((error: unknown) => {
        // `pickThemeFile()` itself rejects with a `PickThemeFailure` on every
        // path it controls (`files.ts`); the fallback below only guards
        // against something genuinely unexpected reaching this catch, so the
        // title it uses is the same one `PickThemeFailure` defaults to,
        // never a second copy invented here.
        const failure =
          error instanceof PickThemeFailure
            ? error
            : new PickThemeFailure(error instanceof Error ? error.message : String(error));
        setResult({ ok: false, title: failure.title, detail: failure.detail });
        return undefined;
      });

      // `undefined` marks the rejection above (already banner'd);
      // `null` is a cancel, which changes nothing and shows nothing.
      if (picked === undefined || picked === null) return;

      const imported = importTheme(picked.contents, picked.name);
      if (imported.ok) {
        const existingIds = new Set([
          ...Object.keys(BUILT_IN_THEMES),
          ...Object.keys(themes),
        ]);
        const id = uniqueThemeId(imported.theme.name, existingIds);
        /**
         * `zustand/persist` writes to `localStorage` **synchronously, inside
         * `set`**, so a full quota throws straight back out of `addTheme` —
         * past `onImport`, past `void onImport()` at the call site, and into
         * the console as an unhandled rejection. No banner, no activation, and
         * the in-memory store already mutated: the gallery would show a theme
         * that storage never took.
         *
         * Rolling back is what makes the banner true rather than merely
         * present. Removing shrinks the payload, so that write normally
         * succeeds; if even it fails there is nothing further to try, and the
         * banner is already saying the import did not stick.
         */
        try {
          addTheme(id, imported.theme);
          activateTheme(id);
        } catch {
          try {
            removeTheme(id);
          } catch {
            // Storage is refusing every write. The banner below is the fix.
          }
          setResult({
            ok: false,
            title: `Couldn't save ${imported.theme.name}`,
            detail:
              'The theme was read fine, but there was no room left to store it. Remove a theme you no longer use and import it again.',
          });
          return;
        }
      }
      setResult(imported);
    } finally {
      setImporting(false);
    }
  };

  /**
   * The theme travels with the id rather than being looked up from it.
   *
   * Every card already holds the theme it renders, so each one can hand back
   * both. Resolving `themes[id]` here instead would have to answer for a miss
   * that no rendered card can produce — either by lying about the type or by
   * carrying a branch nothing can exercise.
   */
  const onExport = (id: string, theme: HiveTheme) => {
    void saveThemeFile(`${id}.json`, themeToJson(theme));
  };

  const onDownloadTemplate = () => {
    void saveThemeFile(TEMPLATE_FILE_NAME, themeTemplateJson());
  };

  return (
    /*
      `SettingsGroup`'s markup, by hand, because this heading carries two
      buttons beside it and the primitive's does not. That makes it the one
      place the rhythm has to be repeated rather than imported — so it moves
      with it: `pb-5`, against each pane's `gap-6`. It was left at `pb-4` when
      the primitive changed, which put this single section half a step out of
      time with every other group in Appearance.
    */
    <section className="flex flex-col gap-3 border-b border-border-soft pb-5 last:border-b-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13px] font-semibold text-ink">Themes</h3>
          <p className="text-[11.5px] text-subtle">
            Every theme carries a light and a dark mode. The switch below picks
            which one you see.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onDownloadTemplate}
            className="flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
          >
            Download template
          </button>
          <button
            type="button"
            onClick={() => void onImport()}
            disabled={importing}
            className="flex w-fit items-center gap-1.5 rounded-md bg-brand-fill px-3 py-1.5 text-[12.5px] text-on-brand hover:bg-brand-fill-hover disabled:opacity-60"
          >
            Import theme…
          </button>
        </div>
      </div>

      {/*
        A fixed tile that flows, rather than a fixed count that stretches.

        Four columns capped at 880px meant a wide settings pane left a gap at
        the right while the rows stayed short — and any narrower pane divided
        the same 880px into four *smaller* tiles. `auto-fill` at a fixed track
        width inverts both: the tile is the constant and the column count is
        what the width buys, so widening the window adds themes to a row
        instead of inflating the ones already there.

        `minmax(min(212px,100%),212px)` is the one-column escape hatch: below
        212px of content box the track collapses to the container instead of
        overflowing it, which a bare `212px` track would do.
      */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(212px,100%),212px))] gap-2.5">
        {Object.entries(BUILT_IN_THEMES).map(([id, theme]) => (
          <ThemeCard
            key={id}
            theme={theme}
            id={id}
            isActive={activeThemeId === id}
            isBuiltIn
            onActivate={activateTheme}
            onExport={(exportId) => onExport(exportId, theme)}
            onRemove={() => {}}
          />
        ))}
        {Object.entries(themes).map(([id, theme]) => (
          <ThemeCard
            key={id}
            theme={theme}
            id={id}
            isActive={activeThemeId === id}
            isBuiltIn={false}
            onActivate={activateTheme}
            onExport={(exportId) => onExport(exportId, theme)}
            onRemove={removeTheme}
          />
        ))}
      </div>

      {result ? (
        <ThemeImportResult result={result} onDismiss={() => setResult(null)} />
      ) : null}
    </section>
  );
}
