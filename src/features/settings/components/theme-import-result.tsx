import { CheckCircle, WarningCircle, X, XCircle } from '@phosphor-icons/react';

import {
  SYNTAX_KEYS,
  TERMINAL_KEYS,
  THEME_MODES,
  UI_KEYS,
} from '@lib/theme/contract';
import type { ImportResult } from '@lib/theme/validate';

/**
 * The three ways an import can land (HIVE-80, story 10).
 *
 * `ImportResult` (from `validate.ts`) is a discriminated union of "ok, with
 * zero or more notes" and "failed" — but the banner has three visual states,
 * not two: a clean import reads calm (green), an import that came with notes
 * reads as worth a second look (amber), and a failure reads as blocked (red).
 * `themeBannerOf` is the one place that split gets made, so the component
 * itself only ever renders a `ThemeBanner`.
 */

export type ThemeBannerTone = 'ok' | 'warn' | 'err';

export interface ThemeBanner {
  tone: ThemeBannerTone;
  title: string;
  detail: string;
}

/**
 * Every colour value a theme *file* holds: 50 keys, in each of the two modes.
 *
 * The unit matters, because both of the banner's sentences count in it. The
 * other one is `inherited`, which `validate.ts` accumulates across both modes
 * — so counting the complete case per-mode ("50 of 50") while counting the
 * partial case per-file ("2 colours inherited") described one colour omitted
 * from both modes in two different currencies. Per-file wins the tie: it is the
 * unit `inherited` can be counted in without losing which mode a colour was
 * missing from, and every other note in the banner names a
 * `modes.<mode>.<group>.<key>` path for exactly that reason.
 *
 * Derived from the format's own key lists rather than hard-coded, so a token
 * added to `contract.ts` moves this number without anyone having to remember it
 * lives here too.
 */
const TOTAL_COLOUR_KEYS =
  (UI_KEYS.length + SYNTAX_KEYS.length + TERMINAL_KEYS.length) * THEME_MODES.length;

/** Turn a raw `importTheme()` result into the three strings the banner shows. */
export function themeBannerOf(result: ImportResult): ThemeBanner {
  if (!result.ok) {
    return { tone: 'err', title: result.title, detail: result.detail };
  }

  const { theme, inherited, notes } = result;

  /**
   * Both conditions, not just `notes.length === 0`. `validate.ts` always
   * notes an inheritance (its own first note, story HIVE-80 review), so the
   * two should never disagree — but the "N of 100" sentence below is only
   * ever *true* when nothing was inherited, and checking that directly here
   * means this component can't be fooled into claiming a complete import
   * that wasn't, even if that invariant were ever broken upstream. There is
   * no subtraction left to go wrong: with `inherited` excluded by the guard,
   * the count is always the full total, never a value counted down from it.
   */
  if (notes.length === 0 && inherited === 0) {
    return {
      tone: 'ok',
      title: `${theme.name} imported and activated`,
      detail: `${TOTAL_COLOUR_KEYS} of ${TOTAL_COLOUR_KEYS} colours set. Light and dark both complete.`,
    };
  }

  return {
    tone: 'warn',
    title: `${theme.name} imported with ${notes.length} ${
      notes.length === 1 ? 'note' : 'notes'
    }`,
    detail: notes.join(' · '),
  };
}

const TONE_BORDER: Record<ThemeBannerTone, string> = {
  ok: 'border-green',
  warn: 'border-amber',
  err: 'border-red',
};

const TONE_ICON_COLOR: Record<ThemeBannerTone, string> = {
  ok: 'text-green',
  warn: 'text-amber',
  err: 'text-red',
};

function ToneGlyph({ tone }: { tone: ThemeBannerTone }) {
  const className = `mt-px shrink-0 ${TONE_ICON_COLOR[tone]}`;
  if (tone === 'ok') return <CheckCircle size={15} weight="bold" className={className} />;
  if (tone === 'warn') return <WarningCircle size={15} weight="bold" className={className} />;
  return <XCircle size={15} weight="bold" className={className} />;
}

interface ThemeImportResultProps {
  result: ImportResult;
  onDismiss: () => void;
}

/**
 * The banner a theme import leaves behind — success, success-with-notes, or
 * failure, all one shape so the gallery can render whichever it got without
 * asking which.
 *
 * Stays on screen until `onDismiss` fires; nothing here times it out.
 */
export function ThemeImportResult({ result, onDismiss }: ThemeImportResultProps) {
  const banner = themeBannerOf(result);

  return (
    <div
      className={`flex items-start gap-2 border-l-2 bg-panel px-3 py-2.5 ${TONE_BORDER[banner.tone]}`}
    >
      <ToneGlyph tone={banner.tone} />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium text-ink">{banner.title}</p>
        <p className="text-[11.5px] text-muted">{banner.detail}</p>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 rounded p-1 text-subtle hover:bg-hover hover:text-ink"
      >
        <X size={13} weight="bold" />
      </button>
    </div>
  );
}
