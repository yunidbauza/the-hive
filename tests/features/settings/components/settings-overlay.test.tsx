import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptySnapshot } from '@shared/config-contract';

import {
  SettingsOverlay,
  escapeIsClaimed,
} from '@features/settings/components/settings-overlay';
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

    /*
      Story 107 fills the last slot, so every section the epic named now exists
      and there is nothing left to be absent. The rule that produced the old
      "and no placeholders" half of this test still stands for whatever comes
      next: a section stays out of this list until it exists, because a nav full
      of dead items teaches the user that settings are broken.
    */
    for (const present of [
      'Projects',
      'Runtime',
      'Skills',
      'Agents',
      'Appearance',
      'Integrations',
      'Advanced',
    ]) {
      expect(within(nav).getByRole('button', { name: present })).toBeInTheDocument();
    }
  });

  it('puts Skills next to Runtime (HIVE-96)', () => {
    /*
      Both answer "what does a session I start actually run?" — Runtime decides
      the binary and its environment, Skills decides the commands it comes with.
      Appearance onwards is about the app rather than the session.
    */
    render(<SettingsOverlay />);

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const labels = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent);

    expect(labels.indexOf('Skills')).toBe(labels.indexOf('Runtime') + 1);
  });

  it('puts Agents between Skills and Appearance (HIVE-114)', () => {
    /*
      It belongs with the session-shaped sections rather than the app-shaped
      ones: a skill is a command a session comes with, and an agent is a
      correspondent that runs sessions of its own. Appearance onwards is about
      the app.
    */
    render(<SettingsOverlay />);

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const labels = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent);

    expect(labels.indexOf('Agents')).toBe(labels.indexOf('Skills') + 1);
    expect(labels.indexOf('Appearance')).toBe(labels.indexOf('Agents') + 1);
  });

  it('switches to Advanced (story 107)', async () => {
    const user = userEvent.setup();
    render(<SettingsOverlay />);

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const advanced = within(nav).getByRole('button', { name: 'Advanced' });

    await user.click(advanced);

    expect(advanced).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('heading', { name: 'Advanced', level: 2 }),
    ).toBeInTheDocument();
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

  /**
   * A caller may name the pane (HIVE-116).
   *
   * The always-Projects rule above is about the route that dominates — the
   * picker with nothing to offer. `+ New agent…` in the rail is the other
   * kind: it is answering a question the user just asked, and Projects would
   * lose it.
   */
  it('opens on the pane the caller asked for', () => {
    useUiStore.getState().openSettings('agents');

    render(<SettingsOverlay />);

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });

    expect(within(nav).getByRole('button', { name: 'Agents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      within(nav).getByRole('button', { name: 'Projects' }),
    ).not.toHaveAttribute('aria-current');
  });

  /**
   * The overlay is `modal={false}` so the rails stay clickable underneath it,
   * which means `+ New agent…` can fire while Settings is already open. Reading
   * the request only at mount made that click do visibly nothing.
   */
  it('navigates on a request that arrives while it is already open', async () => {
    const user = userEvent.setup();
    render(<SettingsOverlay />);

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    await user.click(within(nav).getByRole('button', { name: 'Appearance' }));

    act(() => {
      useUiStore.getState().openSettings('agents');
    });

    expect(within(nav).getByRole('button', { name: 'Agents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('consumes the request, so it cannot re-apply after the user moves on', async () => {
    // The other half of the same rule: a request acts exactly once. Left set,
    // any later re-render would drag the reader back to that pane.
    const user = userEvent.setup();
    useUiStore.getState().openSettings('agents');
    render(<SettingsOverlay />);

    expect(useUiStore.getState().settingsSection).toBeNull();

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    await user.click(within(nav).getByRole('button', { name: 'Appearance' }));

    act(() => {
      useUiStore.setState({ activeTab: 'hero-refresh' });
    });

    expect(
      within(nav).getByRole('button', { name: 'Appearance' }),
    ).toHaveAttribute('aria-current', 'page');
  });
});

/**
 * The predicate behind that guard, on its own.
 *
 * It was inline until the overlay stopped being modal. The two tests above
 * cover the focused cases; the branch that only exists *without* a focus trap —
 * the key pressed after focus has already left — needs a target outside the
 * dialog, which is easier to state here than to stage through the component.
 */
describe('escapeIsClaimed', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is false when nothing has claimed the key', () => {
    document.body.innerHTML = '<input id="plain" />';

    expect(escapeIsClaimed(document.getElementById('plain'))).toBe(false);
  });

  it('is true for a target inside a claiming subtree', () => {
    document.body.innerHTML = '<div data-escape-scope=""><input id="inner" /></div>';

    expect(escapeIsClaimed(document.getElementById('inner'))).toBe(true);
  });

  /**
   * The branch the non-modal overlay made reachable.
   *
   * With no focus trap a keyboard user can Tab out to the header while a rename
   * editor is still open. Escape pressed there has a target outside every
   * scope; keying off the target alone would let the overlay close and discard
   * the edit — the exact loss `data-escape-scope` exists to prevent.
   */
  it('is true when focus has left the overlay but an editor is still open', () => {
    document.body.innerHTML =
      '<header><button id="theme">theme</button></header>' +
      '<input id="editor" data-escape-scope="" />';

    expect(escapeIsClaimed(document.getElementById('theme'))).toBe(true);
  });

  it('is false once the claiming control unmounts', () => {
    document.body.innerHTML = '<header><button id="theme">theme</button></header>';

    expect(escapeIsClaimed(document.getElementById('theme'))).toBe(false);
  });

  it('survives a null target, and one that is not an element', () => {
    // `event.target` is typed `EventTarget`; `document` has no `closest`.
    expect(escapeIsClaimed(null)).toBe(false);
    expect(escapeIsClaimed(document)).toBe(false);
  });
});
