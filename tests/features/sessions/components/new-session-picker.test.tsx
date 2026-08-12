import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_JIRA,
  DEFAULT_NOTIFICATIONS,
  type ConfigSnapshot,
  type ProjectStatus,
} from '@shared/config-contract';

import { NewSessionPicker } from '@features/sessions/components/new-session-picker';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet, seedDemoProjectConfig } from '@tests/support/demo-fleet';

const search = () => screen.getByRole('textbox', { name: 'Search all projects' });
const rowsFor = (name: RegExp) => screen.getAllByRole('button', { name });

/**
 * The new-session picker (story 044). Keyboard-first: New session → type →
 * Enter → a live terminal, hands never leaving the keyboard.
 */
describe('NewSessionPicker', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useUiStore.getState().openPicker();
    /**
     * The picker lists `useProjects()`, which reads the config and nothing else.
     *
     * This block used to end at `resetProjectConfig()` — no config, and the
     * picker still had five projects to show, because the store seeded them and
     * the selector fell back to that seed. Both are gone, so an unconfigured
     * picker is now correctly empty and every test below has to declare the
     * projects it means to pick from.
     */
    resetProjectConfig();
    seedDemoProjectConfig();
  });

  afterEach(() => {
    resetProjectConfig();
  });

  it('names itself and explains what picking does', () => {
    render(<NewSessionPicker />);

    expect(screen.getByText('Start a new session')).toBeInTheDocument();
    expect(
      screen.getByText('Pick a project — a Claude Code terminal will open for it'),
    ).toBeInTheDocument();
  });

  it('focuses the search box on open', () => {
    render(<NewSessionPicker />);

    // The whole point of the picker is that it is keyboard-first.
    expect(search()).toHaveFocus();
  });

  it('pins the first four projects', () => {
    render(<NewSessionPicker />);

    /**
     * A pill's accessible name is the bare project id; a search row's also
     * carries its count ("apfm-web 3 active"). Five fixtures, four pinned —
     * `infra-terraform` is reachable through search only.
     */
    for (const id of ['apfm-web', 'referral-api', 'advisor-portal', 'design-system']) {
      expect(screen.getByRole('button', { name: id })).toBeInTheDocument();
    }
    expect(
      screen.queryByRole('button', { name: 'infra-terraform' }),
    ).not.toBeInTheDocument();
  });

  describe('search', () => {
    it('filters case-insensitively on the project id', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);

      await user.type(search(), 'REFERRAL');

      // The pinned pills are unfiltered, so scope to the result rows — they are
      // the ones whose name carries a count.
      expect(rowsFor(/^referral-api \d+ active$/)).toHaveLength(1);
      expect(
        screen.queryByRole('button', { name: /^design-system \d+ active$/ }),
      ).not.toBeInTheDocument();
    });

    it('matches a substring, not just a prefix', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);

      await user.type(search(), 'terra');

      expect(
        screen.getByRole('button', { name: /infra-terraform/ }),
      ).toBeInTheDocument();
    });

    it('says so when nothing matches', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);

      await user.type(search(), 'nonsense');

      expect(screen.getByText('no projects match "nonsense"')).toBeInTheDocument();
    });

    it('shows each project’s active session count', () => {
      render(<NewSessionPicker />);

      // apfm-web: hero-refresh, lead-form, e2e-quote. `tz-fix` is done and does
      // not count, which is what makes this a live number rather than a total.
      expect(
        screen.getByRole('button', { name: 'apfm-web 3 active' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'advisor-portal 1 active' }),
      ).toBeInTheDocument();
    });
  });

  describe('spawning', () => {
    it('spawns on Enter, using the first match', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);
      const before = useHiveStore.getState().order.length;

      await user.type(search(), 'referral{Enter}');

      const state = useHiveStore.getState();
      expect(state.order).toHaveLength(before + 1);
      // The counter makes the id exact rather than a regex match.
      expect(state.entities['sess-01']).toMatchObject({
        project: 'referral-api',
        status: 'idle',
        task: '',
        cost: '$0.02',
      });
    });

    it('is a no-op on Enter with zero matches', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);
      const before = useHiveStore.getState().order.length;

      await user.type(search(), 'nonsense{Enter}');

      expect(useHiveStore.getState().order).toHaveLength(before);
      expect(useUiStore.getState().picker).toBe(true);
    });

    it('spawns from a pinned pill', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);

      await user.click(screen.getByRole('button', { name: 'design-system' }));

      expect(useHiveStore.getState().entities['sess-01']).toMatchObject({
        project: 'design-system',
      });
    });

    it('opens the new session and dismisses the picker', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);

      await user.type(search(), 'referral{Enter}');

      expect(useUiStore.getState()).toMatchObject({
        activeTab: 'sess-01',
        picker: false,
      });
    });

    it('seeds a transcript that invites the first instruction', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);

      await user.type(search(), 'referral{Enter}');

      const lines = useHiveStore
        .getState()
        .entities['sess-01'].lines.map((line) => line.text);
      expect(lines[0]).toBe(
        '❯ claude --model opus --effort high — new session on referral-api',
      );
      expect(lines).toContain('● Reading CLAUDE.md, mapping repo…');
      expect(lines).toContain(
        '· Ready — type below to give this session its task',
      );
    });

    it('records the spawn in the console', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);

      await user.type(search(), 'referral{Enter}');

      expect(
        useHiveStore.getState().orchLines.map((line) => line.text),
      ).toContain('  spawned sess-01 on referral-api');
    });
  });

  describe('model and effort', () => {
    it('defaults to opus and high', () => {
      render(<NewSessionPicker />);

      expect(screen.getByRole('radio', { name: 'opus' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'high' })).toBeChecked();
    });

    it('records a different choice on the spawned session', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);

      await user.click(screen.getByRole('radio', { name: 'haiku' }));
      await user.click(screen.getByRole('radio', { name: 'max' }));
      await user.type(search(), 'referral{Enter}');

      expect(useHiveStore.getState().entities['sess-01']).toMatchObject({
        model: 'haiku',
        effort: 'max',
      });
    });

    it('persists the choice across open and close', async () => {
      const user = userEvent.setup();
      const { unmount } = render(<NewSessionPicker />);

      await user.click(screen.getByRole('radio', { name: 'sonnet' }));
      unmount();
      useUiStore.getState().closePicker();
      useUiStore.getState().openPicker();
      render(<NewSessionPicker />);

      // Held in the store, not in component state — reopening must not silently
      // reset a deliberate choice.
      expect(screen.getByRole('radio', { name: 'sonnet' })).toBeChecked();
    });
  });

  describe('dismissal', () => {
    it('closes on the cancel button', async () => {
      const user = userEvent.setup();
      render(<NewSessionPicker />);

      await user.click(screen.getByRole('button', { name: 'esc · cancel' }));

      expect(useUiStore.getState().picker).toBe(false);
    });

    it('closes on Escape and leaves the underlying tab alone', async () => {
      const user = userEvent.setup();
      useUiStore.getState().openTab('webhooks');
      useUiStore.getState().openPicker();
      render(<NewSessionPicker />);

      await user.keyboard('{Escape}');

      // Restores exactly the previous view rather than defaulting home.
      expect(useUiStore.getState()).toMatchObject({
        picker: false,
        activeTab: 'webhooks',
      });
    });
  });
});

/**
 * Gating on the workspace config (story 090).
 *
 * A project with no real directory behind it cannot host a PTY, so the picker
 * refuses it rather than opening a terminal with nowhere to run. Note every
 * assertion above this block runs with **no** config loaded and is unchanged —
 * that is the browser demo, and it stays whole.
 */
describe('NewSessionPicker · unmapped projects', () => {
  const CONFIG_PATH = '/home/dev/.hive/config.json';

  function snapshot(
    projects: { id: string; status: ProjectStatus }[],
    overrides: Partial<ConfigSnapshot> = {},
  ): ConfigSnapshot {
    return {
      configPath: CONFIG_PATH,
      templateWritten: false,
      shell: '/bin/zsh',
      claudeCommand: 'claude',
      projects: projects.map(({ id, status }) => ({
        id,
        name: id,
        path: status === 'ok' ? `/repos/${id}` : null,
        icon: 'ph-folder',
        origin: 'local' as const,
        status,
        isRepo: true,
      })),
      notifications: { ...DEFAULT_NOTIFICATIONS },
      jira: { ...DEFAULT_JIRA },
      subscriptionAuth: true,
  sessionMetrics: true,
      errors: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useUiStore.getState().openPicker();
    resetProjectConfig();
  });

  afterEach(() => {
    resetProjectConfig();
  });

  /**
   * "Unmapped" now means *declared but unresolvable*, not *absent from the
   * config*.
   *
   * This used to declare only `referral-api` and assert that `apfm-web` was
   * still listed — pinned, disabled, explained. It could be listed because the
   * seeded projects were merged into `useProjects()` whatever the config said.
   * With the config as the only source, a project the picker lists is by
   * definition one the config declares, so the unreachable half of that premise
   * is gone and the case that survives is a declared project whose path is not
   * there: `status: 'missing'`.
   */
  it('disables a pinned project whose path is missing, and says why', () => {
    setProjectConfigForTest(
      snapshot([
        { id: 'apfm-web', status: 'missing' },
        { id: 'referral-api', status: 'ok' },
      ]),
    );
    render(<NewSessionPicker />);

    const pinned = screen.getByRole('button', { name: 'apfm-web' });

    expect(pinned).toBeDisabled();
    expect(pinned).toHaveAttribute(
      'title',
      expect.stringContaining(CONFIG_PATH),
    );
    expect(screen.getByRole('button', { name: 'referral-api' })).toBeEnabled();
  });

  /**
   * The other half of the same rule, stated directly: a project the config does
   * not declare is not offered at all — not disabled, not greyed, absent.
   */
  it('does not list a project the config never declared', () => {
    setProjectConfigForTest(snapshot([{ id: 'referral-api', status: 'ok' }]));
    render(<NewSessionPicker />);

    expect(screen.queryByRole('button', { name: 'apfm-web' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'referral-api' })).toBeEnabled();
  });

  it('disables a search row and replaces its count with the refusal', async () => {
    const user = userEvent.setup();
    setProjectConfigForTest(snapshot([{ id: 'apfm-web', status: 'missing' }]));
    render(<NewSessionPicker />);

    await user.type(search(), 'apfm');

    const row = screen.getByRole('button', { name: 'apfm-web unmapped' });
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute('title', expect.stringContaining('missing'));
  });

  it('refuses Enter on an unmapped project rather than spawning into nowhere', async () => {
    const user = userEvent.setup();
    setProjectConfigForTest(snapshot([]));
    render(<NewSessionPicker />);
    const before = Object.keys(useHiveStore.getState().entities).length;

    await user.type(search(), 'apfm');
    await user.keyboard('{Enter}');

    // The buttons are disabled, but Enter in the search box does not go
    // through them — this is the path a keyboard-first picker actually takes.
    expect(Object.keys(useHiveStore.getState().entities)).toHaveLength(before);
    expect(useUiStore.getState().picker).toBe(true);
  });

  it('still spawns into a project that resolves', async () => {
    const user = userEvent.setup();
    setProjectConfigForTest(snapshot([{ id: 'apfm-web', status: 'ok' }]));
    render(<NewSessionPicker />);
    const before = Object.keys(useHiveStore.getState().entities).length;

    await user.click(screen.getByRole('button', { name: 'apfm-web' }));

    expect(Object.keys(useHiveStore.getState().entities)).toHaveLength(before + 1);
  });

  /**
   * Story 090 printed the config path here. Story 101 replaces it with a
   * button: naming a file the user has never opened is not an instruction, and
   * that dead end is the failure this story exists to end.
   */
  it('offers a first-run user a way into settings, not a file path', () => {
    setProjectConfigForTest(snapshot([], { templateWritten: true }));
    render(<NewSessionPicker />);

    expect(
      screen.getByRole('button', { name: /add project/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(CONFIG_PATH))).not.toBeInTheDocument();
  });

  it('opens settings when the first-run button is pressed', async () => {
    const user = userEvent.setup();
    setProjectConfigForTest(snapshot([], { templateWritten: true }));
    render(<NewSessionPicker />);

    await user.click(screen.getByRole('button', { name: /add project/i }));

    expect(useUiStore.getState().settings).toBe(true);
    // openSettings clears the picker: two stacked full-stage overlays is what
    // that rule exists to prevent, and this is the path that would cause it.
    expect(useUiStore.getState().picker).toBe(false);
  });

  it('shows no first-run notice once the file exists', () => {
    setProjectConfigForTest(snapshot([{ id: 'apfm-web', status: 'ok' }]));
    render(<NewSessionPicker />);

    expect(screen.queryByText(/no projects yet/)).not.toBeInTheDocument();
  });
});

/**
 * Opened from a ticket card (HIVE-73).
 *
 * The click that opens the picker from a card means "work this issue", so the
 * picker has to say which issue — otherwise the user gets a generic overlay
 * and no confirmation that the session will be linked at all.
 */
describe('NewSessionPicker · opened for a ticket', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    resetProjectConfig();
    seedDemoProjectConfig();
  });

  afterEach(() => {
    resetProjectConfig();
  });
  const openForTicket = (key: string) => {
    useUiStore.getState().openPicker(key);
  };

  it('names the ticket and shows its summary', () => {
    useHiveStore.getState().hydrateTickets(
      [
        {
          key: 'HIVE-73',
          summary: 'Sessions and PRs on the ticket card',
          status: 'In Progress',
          statusCategory: 'in-progress',
          issueType: 'Story',
          priority: null,
          assignee: null,
          updated: '2026-08-09T00:00:00.000+0000',
          url: 'https://example.test/HIVE-73',
        },
      ],
      false,
    );
    openForTicket('HIVE-73');
    render(<NewSessionPicker />);

    expect(
      screen.getByText('Start a session for HIVE-73'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Sessions and PRs on the ticket card'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Start a new session')).not.toBeInTheDocument();
  });

  /**
   * The key comes from the click and is always known; the ticket object is a
   * lookup into a list the WORK panel replaces on every refresh. A card that
   * scrolled out from under the query still gets a titled picker.
   */
  it('still names a ticket the list no longer holds', () => {
    openForTicket('GONE-1');
    render(<NewSessionPicker />);

    expect(screen.getByText('Start a session for GONE-1')).toBeInTheDocument();
    expect(
      screen.getByText('Pick a project — a Claude Code terminal will open for it'),
    ).toBeInTheDocument();
  });

  it('links the spawned session to the ticket', async () => {
    const user = userEvent.setup();
    openForTicket('HIVE-73');
    render(<NewSessionPicker />);

    await user.click(rowsFor(/^apfm-web/)[0]);

    const linked = Object.values(useHiveStore.getState().entities).filter(
      (entity) => entity.kind === 'session' && entity.ticket === 'HIVE-73',
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]?.kind === 'session' && linked[0].project).toBe('apfm-web');
  });

  it('carries the chosen model and effort onto the linked session', async () => {
    const user = userEvent.setup();
    openForTicket('HIVE-73');
    useUiStore.getState().setNewModel('sonnet');
    useUiStore.getState().setNewEffort('low');
    render(<NewSessionPicker />);

    await user.click(rowsFor(/^apfm-web/)[0]);

    const linked = Object.values(useHiveStore.getState().entities).find(
      (entity) => entity.kind === 'session' && entity.ticket === 'HIVE-73',
    );
    expect(linked?.kind === 'session' && linked.model).toBe('sonnet');
    expect(linked?.kind === 'session' && linked.effort).toBe('low');
  });

  /**
   * The header's entry point must not acquire a ticket. `openPicker` assigns
   * on every open for exactly this reason.
   */
  it('leaves no ticket on a session started from the header', async () => {
    const user = userEvent.setup();
    const linkedCount = () =>
      Object.values(useHiveStore.getState().entities).filter(
        (entity) => entity.kind === 'session' && entity.ticket !== undefined,
      ).length;

    // Open for a ticket, then reopen from the header: the second open must
    // overwrite the key rather than inherit it.
    openForTicket('HIVE-73');
    useUiStore.getState().openPicker();
    const before = linkedCount();
    render(<NewSessionPicker />);

    await user.click(rowsFor(/^apfm-web/)[0]);

    expect(linkedCount()).toBe(before);
  });
});
