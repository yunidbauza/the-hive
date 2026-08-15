import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ThemeImportResult } from '@features/settings/components/theme-import-result';
import { BUILT_IN_THEME } from '@lib/theme/built-in';
import type { HiveTheme } from '@lib/theme/contract';
import { importTheme, type ImportOk } from '@lib/theme/validate';

const nord: HiveTheme = { ...BUILT_IN_THEME, name: 'Nord' };
const solarized: HiveTheme = { ...BUILT_IN_THEME, name: 'Solarized' };

const okResult: ImportOk = { ok: true, theme: nord, inherited: 0, notes: [] };

describe('ThemeImportResult', () => {
  it('reports a clean import', () => {
    render(
      <ThemeImportResult
        result={{ ok: true, theme: nord, inherited: 0, notes: [] }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Nord imported and activated')).toBeInTheDocument();
    // 98, not 49: a theme *file* holds 49 colours in each of its two modes,
    // and `inherited` — the number the other sentence reports — counts in that
    // same per-file unit. See `theme-import-result.tsx`.
    expect(
      screen.getByText('98 of 98 colours set. Light and dark both complete.'),
    ).toBeInTheDocument();
  });

  it('counts the notes, which is the common case', () => {
    render(
      <ThemeImportResult
        result={{
          ok: true,
          theme: solarized,
          inherited: 6,
          notes: [
            '6 colours inherited from the built-in theme',
            '`accentHover` is not a Hive token and was ignored',
            'body text on panel is 3.9:1 in light mode, below the 4.5:1 guideline',
          ],
        }}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Solarized imported with 3 notes'),
    ).toBeInTheDocument();
  });

  it('says "1 note", not "1 notes"', () => {
    render(
      <ThemeImportResult
        result={{
          ok: true,
          theme: solarized,
          inherited: 1,
          notes: ['1 colour inherited from the built-in theme'],
        }}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Solarized imported with 1 note'),
    ).toBeInTheDocument();
  });

  it('says what to fix and where when it failed', () => {
    render(
      <ThemeImportResult
        result={{
          ok: false,
          title: "Couldn't import midnight.json",
          detail:
            'modes.light is missing. A Hive theme needs both a light and a dark mode — add a light block, or start from the downloaded template.',
        }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Couldn't import midnight.json")).toBeInTheDocument();
  });

  it('stays until dismissed', async () => {
    const onDismiss = vi.fn();
    render(<ThemeImportResult result={okResult} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  /**
   * The Critical fix from review: `inherited` sums across both modes (up to
   * 98), so `TOTAL_COLOUR_KEYS - inherited` alone could go negative. The
   * component no longer trusts `notes.length === 0` to imply nothing was
   * inherited — it checks `inherited === 0` directly — so even a
   * hand-constructed `ImportOk` that skips notes entirely (a shape
   * `validate.ts` should never produce now that it notes every inheritance,
   * but nothing stops another caller from constructing one) can't make this
   * sentence lie.
   */
  it('never claims a negative or partial count from inherited colours alone', () => {
    const minimal: HiveTheme = { ...BUILT_IN_THEME, name: 'Minimal' };
    render(
      <ThemeImportResult
        result={{ ok: true, theme: minimal, inherited: 98, notes: [] }}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.queryByText(/-\d+ of 98/)).toBeNull();
    expect(
      screen.queryByText('98 of 98 colours set. Light and dark both complete.'),
    ).toBeNull();
  });

  it('a mostly-empty theme lands in the warn tone, the inheritance note first', () => {
    const raw = JSON.stringify({
      hiveThemeVersion: 1,
      name: 'Minimal',
      modes: { light: {}, dark: {} },
    });
    const result = importTheme(raw, 'minimal.json');

    render(<ThemeImportResult result={result} onDismiss={vi.fn()} />);

    expect(result.ok && result.notes[0]).toBe(
      '98 colours inherited from the built-in theme',
    );
    expect(
      screen.getByText(/^98 colours inherited from the built-in theme/),
    ).toBeInTheDocument();
  });
});
