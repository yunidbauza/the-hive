import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptySnapshot } from '@shared/config-contract';

import { SettingsOverlay } from '@features/settings/components/settings-overlay';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The settings overlay shell (story 101).
 *
 * The section list is the part worth pinning: story 105 turned it into a real
 * switcher, and the sections that do not exist yet are *absent* rather than
 * disabled — a nav full of dead items teaches the user that settings are
 * broken.
 */
describe('SettingsOverlay', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    resetProjectConfig();
    setProjectConfigForTest(emptySnapshot('/tmp/hive/config.json'));
    useUiStore.getState().openSettings();
  });

  afterEach(() => {
    resetProjectConfig();
  });

  it('names itself and shows the Projects section', () => {
    render(<SettingsOverlay />);

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Projects', level: 2 }),
    ).toBeInTheDocument();
  });

  it('ships the sections that exist, and no placeholders', () => {
    render(<SettingsOverlay />);

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });

    expect(nav).toBeInTheDocument();
    for (const present of ['Projects', 'Runtime', 'Appearance', 'Integrations']) {
      expect(within(nav).getByRole('button', { name: present })).toBeInTheDocument();
    }

    // Story 107 fills the last slot. Rendering it now as a disabled item would
    // teach the user that settings are broken.
    for (const absent of ['Advanced']) {
      expect(screen.queryByText(absent)).not.toBeInTheDocument();
    }
  });

  it('opens on Projects and switches panes on click', async () => {
    const user = userEvent.setup();
    render(<SettingsOverlay />);

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const projects = within(nav).getByRole('button', { name: 'Projects' });
    const appearance = within(nav).getByRole('button', { name: 'Appearance' });

    // Always Projects on open: the realistic route in is the picker finding no
    // projects to offer, and landing that user in Appearance would strand them.
    expect(projects).toHaveAttribute('aria-current', 'page');
    expect(appearance).not.toHaveAttribute('aria-current');

    await user.click(appearance);

    expect(
      screen.getByRole('heading', { name: 'Appearance', level: 2 }),
    ).toBeInTheDocument();
    expect(appearance).toHaveAttribute('aria-current', 'page');
    expect(projects).not.toHaveAttribute('aria-current');

    await user.click(projects);

    expect(
      screen.getByRole('heading', { name: 'Projects', level: 2 }),
    ).toBeInTheDocument();
  });

  it('closes on the close button', async () => {
    const user = userEvent.setup();
    render(<SettingsOverlay />);

    await user.click(screen.getByRole('button', { name: 'Close settings' }));

    expect(useUiStore.getState().settings).toBe(false);
  });

  it('closes on Escape, matching the picker', async () => {
    const user = userEvent.setup();
    render(<SettingsOverlay />);

    await user.keyboard('{Escape}');

    expect(useUiStore.getState().settings).toBe(false);
  });

  /**
   * The half that `stopPropagation` cannot cover (story 103).
   *
   * Radix listens for Escape on the document in the **capture** phase, so it
   * decides before the key reaches whatever is focused — a nested control can
   * never win that race by stopping propagation. Anything that owns Escape for
   * itself marks its subtree `data-escape-scope`, and the overlay declines
   * those; without it, cancelling a rename closed the whole of Settings.
   */
  it('ignores an Escape a nested control has claimed', async () => {
    const user = userEvent.setup();
    render(<SettingsOverlay />);

    const claimed = document.createElement('input');
    claimed.setAttribute('data-escape-scope', '');
    screen.getByRole('dialog').append(claimed);
    claimed.focus();

    await user.keyboard('{Escape}');

    expect(useUiStore.getState().settings).toBe(true);
  });

  it('still closes on an Escape from an unclaimed element', async () => {
    const user = userEvent.setup();
    render(<SettingsOverlay />);

    const plain = document.createElement('input');
    screen.getByRole('dialog').append(plain);
    plain.focus();

    await user.keyboard('{Escape}');

    expect(useUiStore.getState().settings).toBe(false);
  });

  it('leaves activeTab untouched when it closes', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ activeTab: 'hero-refresh' });
    render(<SettingsOverlay />);

    await user.click(screen.getByRole('button', { name: 'Close settings' }));

    // Closing settings returns the user to the terminal they were watching.
    expect(useUiStore.getState().activeTab).toBe('hero-refresh');
  });
});
