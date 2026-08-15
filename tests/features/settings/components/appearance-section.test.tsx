import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { AppearanceSection } from '@features/settings/components/appearance-section';
import { DEFAULT_TEAM_NAME, useAppearanceStore } from '@stores/appearance-store';

/**
 * The appearance pane (story 105).
 *
 * Every control writes straight to the store, which persists itself — there is
 * no save button and no error state, which is the whole difference from the
 * Projects section. What is worth pinning is that each control is wired to the
 * field it claims, and that the DOM sees the result.
 */
describe('AppearanceSection', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.removeAttribute('data-theme');
    document.body.removeAttribute('data-density');
    useAppearanceStore.setState({ systemDark: true });
    useAppearanceStore.getState().reset();
  });

  it('names itself and offers every group', () => {
    render(<AppearanceSection />);

    expect(
      screen.getByRole('heading', { name: 'Appearance', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Font' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Size' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Scrollback' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Team name' })).toBeInTheDocument();
  });

  it('shows the stored values as the current selection', () => {
    useAppearanceStore.setState({
      theme: 'light',
      terminalFont: 'monaco',
      terminalFontSize: 16,
      terminalScrollback: 1000,
      density: 'compact',
    });

    render(<AppearanceSection />);

    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Compact' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Font' })).toHaveValue('monaco');
    expect(screen.getByRole('combobox', { name: 'Size' })).toHaveValue('16');
    expect(screen.getByRole('combobox', { name: 'Scrollback' })).toHaveValue('1000');
  });

  it('changing the theme applies it to the body immediately', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);

    await user.click(screen.getByRole('radio', { name: 'Light' }));

    expect(useAppearanceStore.getState().theme).toBe('light');
    expect(document.body.getAttribute('data-theme')).toBe('light');
  });

  it('changing density applies it to the body immediately', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);

    await user.click(screen.getByRole('radio', { name: 'Compact' }));

    expect(useAppearanceStore.getState().density).toBe('compact');
    expect(document.body.getAttribute('data-density')).toBe('compact');
  });

  it('stores the terminal font by id', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Font' }), 'menlo');

    expect(useAppearanceStore.getState().terminalFont).toBe('menlo');
  });

  it('stores font size and scrollback as numbers, not the option strings', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Size' }), '14');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Scrollback' }),
      '10000',
    );

    // xterm's options are numeric; a string would be silently wrong rather than
    // an error, so the conversion is worth pinning.
    expect(useAppearanceStore.getState().terminalFontSize).toBe(14);
    expect(useAppearanceStore.getState().terminalScrollback).toBe(10_000);
  });

  it('shows the stored team name and writes it as it is typed', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);

    const field = screen.getByRole('textbox', { name: 'Team name' });
    expect(field).toHaveValue(DEFAULT_TEAM_NAME);

    await user.clear(field);
    // Two words: a setter that trimmed would swallow the space between them
    // and this name could never be typed.
    await user.type(field, 'Assimilation Team');

    expect(useAppearanceStore.getState().teamName).toBe('Assimilation Team');
  });

  it('tidies the trailing space when the field commits', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);

    const field = screen.getByRole('textbox', { name: 'Team name' });
    await user.clear(field);
    await user.type(field, 'Zergling Battalion  ');
    await user.tab();

    expect(useAppearanceStore.getState().teamName).toBe('Zergling Battalion');
  });

  it('lets the line be turned off by clearing the field', async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);

    await user.clear(screen.getByRole('textbox', { name: 'Team name' }));

    expect(useAppearanceStore.getState().teamName).toBe('');
  });

  it('puts Themes first and calls the switch Mode', () => {
    render(<AppearanceSection />);
    // Level 3: the group headings (Themes, Mode, Terminal, Team, Density) —
    // not the pane's own level-2 "Appearance" title, which this task leaves
    // untouched and which would otherwise always win first place.
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings[0]).toBe('Themes');
    expect(headings).toContain('Mode');
    expect(headings).not.toContain('Theme');
  });
});
