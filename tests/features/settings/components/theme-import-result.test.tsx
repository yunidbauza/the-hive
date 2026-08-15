import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ThemeImportResult } from '@features/settings/components/theme-import-result';
import { BUILT_IN_THEME } from '@lib/theme/built-in';
import type { HiveTheme } from '@lib/theme/contract';
import type { ImportOk } from '@lib/theme/validate';

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
    expect(
      screen.getByText('49 of 49 colours set. Light and dark both complete.'),
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
});
