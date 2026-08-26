import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { ThemeCard } from '@features/settings/components/theme-card';

const base = {
  theme: BUILT_IN_THEME,
  onActivate: vi.fn(),
  onExport: vi.fn(),
  onRemove: vi.fn(),
};

describe('ThemeCard', () => {
  it('marks the active card pressed', () => {
    render(<ThemeCard {...base} id="hive" isActive isBuiltIn />);
    // Exact: the card holds two buttons naming this theme — the activate
    // button ("Hive Built in") and the ⋯ trigger ("Hive actions").
    expect(screen.getByRole('button', { name: 'Hive Built in' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('names the author, or says it ships with the app', () => {
    render(<ThemeCard {...base} id="hive" isActive isBuiltIn />);
    expect(screen.getByText('Built in')).toBeInTheDocument();
  });

  it('chips an imported theme', () => {
    render(<ThemeCard {...base} id="nord" isActive={false} isBuiltIn={false} />);
    expect(screen.getByText('Imported')).toBeInTheDocument();
  });

  it('offers Remove on an imported theme', async () => {
    render(<ThemeCard {...base} id="nord" isActive={false} isBuiltIn={false} />);
    await userEvent.click(screen.getByRole('button', { name: /actions$/ }));
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeInTheDocument();
  });

  it('offers the built-in no Remove at all, rather than a disabled one', async () => {
    render(<ThemeCard {...base} id="hive" isActive isBuiltIn />);
    await userEvent.click(screen.getByRole('button', { name: /actions$/ }));
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull();
  });

  it('disables Activate on the theme already active', async () => {
    render(<ThemeCard {...base} id="hive" isActive isBuiltIn />);
    await userEvent.click(screen.getByRole('button', { name: /actions$/ }));
    expect(screen.getByRole('menuitem', { name: 'Activate' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('never nests a button inside a button', () => {
    const { container } = render(
      <ThemeCard {...base} id="nord" isActive={false} isBuiltIn={false} />,
    );
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.querySelector('button')).toBeNull();
    }
  });

  it('opening the menu does not also activate the card', async () => {
    const onActivate = vi.fn();
    render(
      <ThemeCard
        {...base}
        id="nord"
        isActive={false}
        isBuiltIn={false}
        onActivate={onActivate}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /actions$/ }));
    expect(onActivate).not.toHaveBeenCalled();
  });
});
