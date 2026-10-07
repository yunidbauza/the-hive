import { beforeEach, describe, expect, it } from 'vitest';

import { useUiStore } from '@stores/ui-store';

/**
 * Reference pattern for store tests (story 013): call the action against a
 * fresh store and assert the resulting state. No React involved — the stores
 * are plain functions and are the highest-value target in the repo.
 *
 * Theme moved to `appearance-store` in story 105 — see
 * `tests/stores/appearance-store.test.ts` for its coverage.
 */
describe('ui-store — view state', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  it('starts on the orchestrator', () => {
    expect(useUiStore.getState().activeTab).toBe('orch');
  });

  it('openTab switches the center stage and dismisses the picker', () => {
    useUiStore.getState().openPicker();
    useUiStore.getState().openTab('webhooks');

    expect(useUiStore.getState().activeTab).toBe('webhooks');
    // The user has made their choice; leaving the overlay up would cover it.
    expect(useUiStore.getState().picker).toBe(false);
  });

  /**
   * The other half of `openSettings`, which has always dismissed the picker.
   *
   * `resolveView` gives settings precedence, so a picker opened underneath it
   * changed nothing on screen and then ambushed the user the next time they
   * closed settings. Unreachable while the header was inert behind an overlay;
   * reachable now that the chrome is live.
   */
  it('openPicker dismisses settings, the way openSettings dismisses the picker', () => {
    useUiStore.getState().openSettings();

    useUiStore.getState().openPicker();

    expect(useUiStore.getState()).toMatchObject({ picker: true, settings: false });
  });

  it('openSettings still dismisses the picker', () => {
    useUiStore.getState().openPicker();

    useUiStore.getState().openSettings();

    expect(useUiStore.getState()).toMatchObject({ picker: false, settings: true });
  });

  /**
   * For an action in the chrome whose destination is already correct — opening
   * a file from the explorer — where only the overlay is in the way.
   */
  it('revealStage clears both overlays and moves nothing else', () => {
    useUiStore.getState().openTab('webhooks');
    useUiStore.getState().openSettings();

    useUiStore.getState().revealStage();

    expect(useUiStore.getState()).toMatchObject({
      picker: false,
      settings: false,
      activeTab: 'webhooks',
    });
  });

  it('backToOrch returns to the orchestrator from any tab', () => {
    useUiStore.getState().openTab('webhooks');

    useUiStore.getState().backToOrch();

    expect(useUiStore.getState().activeTab).toBe('orch');
  });

  it('backToOrch also dismisses the picker', () => {
    useUiStore.getState().openTab('webhooks');
    useUiStore.getState().openPicker();

    useUiStore.getState().backToOrch();

    // Going home means going home: leaving the overlay up would cover the
    // orchestrator the user just asked for.
    expect(useUiStore.getState()).toMatchObject({
      activeTab: 'orch',
      picker: false,
    });
  });

  it('clears a stale query when the picker reopens', () => {
    const { openPicker, setPickerQuery, closePicker } = useUiStore.getState();

    openPicker();
    setPickerQuery('nova');
    closePicker();
    expect(useUiStore.getState().pickerQuery).toBe('nova');

    openPicker();
    expect(useUiStore.getState().pickerQuery).toBe('');
  });

  it('defaults new sessions to opus / high and lets both change', () => {
    expect(useUiStore.getState().newModel).toBe('opus');
    expect(useUiStore.getState().newEffort).toBe('high');

    useUiStore.getState().setNewModel('haiku');
    useUiStore.getState().setNewEffort('low');

    expect(useUiStore.getState().newModel).toBe('haiku');
    expect(useUiStore.getState().newEffort).toBe('low');
  });

  it('tracks the orchestrator table selection by id', () => {
    useUiStore.getState().setSelId('webhooks');
    expect(useUiStore.getState().selId).toBe('webhooks');
  });

  /**
   * An id, not a position. The nav order is sorted by recency, so an index is a
   * fact about the current fleet rather than about the caret — a session
   * spawning in the background renumbers every row and would move a selection
   * the user had not touched.
   */
  it('clears the selection with null', () => {
    useUiStore.getState().setSelId('webhooks');
    useUiStore.getState().setSelId(null);
    expect(useUiStore.getState().selId).toBeNull();
  });

  it('reset returns every field to its initial value', () => {
    const state = useUiStore.getState();
    state.openTab('webhooks');
    state.setSelId('webhooks');

    useUiStore.getState().reset();

    expect(useUiStore.getState()).toMatchObject({
      activeTab: 'orch',
      selId: null,
    });
  });
});

describe('settings overlay (story 101)', () => {
  it('openSettings clears the picker and leaves activeTab untouched', () => {
    useUiStore.getState().openTab('s1');
    useUiStore.getState().openPicker();

    useUiStore.getState().openSettings();

    const state = useUiStore.getState();
    expect(state.settings).toBe(true);
    // Two stacked full-stage overlays is the thing this prevents.
    expect(state.picker).toBe(false);
    // Closing settings has to return the user to the terminal they were
    // watching, which only works if the tab underneath is untouched.
    expect(state.activeTab).toBe('s1');
  });

  it('closeSettings changes nothing else — nothing was changed on open', () => {
    useUiStore.getState().openTab('s1');
    useUiStore.getState().openSettings();

    useUiStore.getState().closeSettings();

    expect(useUiStore.getState().settings).toBe(false);
    expect(useUiStore.getState().activeTab).toBe('s1');
  });

  it('reset clears the settings flag', () => {
    useUiStore.getState().openSettings();

    useUiStore.getState().reset();

    expect(useUiStore.getState().settings).toBe(false);
  });

  /**
   * The rails stay visible behind a full-stage overlay, so they remain
   * clickable while settings is open. `resolveView` returns `'settings'`
   * whatever `activeTab` says — so a rail click that left the overlay up would
   * change the tab underneath and look, to the user, like nothing happened.
   */
  it('opening a tab closes settings, as it closes the picker', () => {
    useUiStore.getState().openSettings();

    useUiStore.getState().openTab('s2');

    expect(useUiStore.getState().settings).toBe(false);
    expect(useUiStore.getState().activeTab).toBe('s2');
  });

  it('backToOrch closes settings', () => {
    useUiStore.getState().openSettings();

    useUiStore.getState().backToOrch();

    expect(useUiStore.getState().settings).toBe(false);
    expect(useUiStore.getState().activeTab).toBe('orch');
  });
});

/**
 * The explorer's view state.
 *
 * Which directories are open, and which repository the tree is rooted at while
 * no session is. Both are facts about a panel, both die with the window — which
 * is why they are here and not in `editor-store` beside the buffers.
 */
describe('the explorer tree', () => {
  it('toggles a directory open and closed', () => {
    useUiStore.getState().toggleExplorerDir('nova-web', 'src');
    expect(useUiStore.getState().explorerExpanded['nova-web:src']).toBe(true);

    useUiStore.getState().toggleExplorerDir('nova-web', 'src');
    expect(useUiStore.getState().explorerExpanded['nova-web:src']).toBe(false);
  });

  /**
   * Keyed by project as well as path, so returning to a repository finds it as
   * it was left rather than inheriting whatever the last one had expanded.
   */
  it('keeps one project’s expansion separate from another’s', () => {
    useUiStore.getState().toggleExplorerDir('nova-web', 'src');

    expect(useUiStore.getState().explorerExpanded['referral-api:src']).toBeUndefined();
  });

  /**
   * Everything, in every project. "Collapse all" that left another
   * repository's tree open would surprise the user the next time they opened a
   * session in it.
   */
  it('collapses every project at once', () => {
    useUiStore.getState().toggleExplorerDir('nova-web', 'src');
    useUiStore.getState().toggleExplorerDir('referral-api', 'lib');

    useUiStore.getState().collapseExplorer();

    expect(useUiStore.getState().explorerExpanded).toEqual({});
  });

  /**
   * The sticky project is gone (HIVE-93).
   *
   * It existed so the tree kept its last repository on the overmind tab. The
   * explorer now follows the active session or shows nothing, so there is
   * nothing to remember — see `use-explorer-project.ts` for why showing the
   * wrong repository is worse than showing none.
   */
  it('starts with nothing expanded', () => {
    useUiStore.getState().toggleExplorerDir('nova-web', 'src');

    useUiStore.getState().reset();

    expect(useUiStore.getState().explorerExpanded).toEqual({});
  });
});

/**
 * Which pane settings opens on (HIVE-116).
 *
 * The overlay's rule — always land on Projects — was written for the route
 * that dominates: the picker discovering there are no projects. A caller that
 * *names* a pane is answering a question the user just asked, and the rule has
 * to make room for it without losing the default.
 */
describe('openSettings and its pane', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  it('records the pane a caller asked for', () => {
    useUiStore.getState().openSettings('agents');

    expect(useUiStore.getState().settings).toBe(true);
    expect(useUiStore.getState().settingsSection).toBe('agents');
  });

  it('asks for nothing when called bare, so the default still wins', () => {
    useUiStore.getState().openSettings();

    expect(useUiStore.getState().settings).toBe(true);
    expect(useUiStore.getState().settingsSection).toBeNull();
  });

  it('does not strand the next bare open on the last pane asked for', () => {
    // The bug this guards: `+ New agent…` opens Agents, the user closes, then
    // the header's gear opens — and lands on Agents with no idea why.
    useUiStore.getState().openSettings('agents');
    useUiStore.getState().closeSettings();
    useUiStore.getState().openSettings();

    expect(useUiStore.getState().settingsSection).toBeNull();
  });

  it('still dismisses the picker when a pane is named', () => {
    useUiStore.getState().openPicker();

    useUiStore.getState().openSettings('agents');

    expect(useUiStore.getState().picker).toBe(false);
  });

  it('is cleared by reset', () => {
    useUiStore.getState().openSettings('agents');

    useUiStore.getState().reset();

    expect(useUiStore.getState().settingsSection).toBeNull();
  });
});

/**
 * The WORK tab's search box, whose term lives here for the reason
 * `prSearchTerm` does: the term is what the user is looking at, and the issues
 * that come back are data.
 */
describe('ui-store — the work search', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  it('starts empty and searching everyone’s tickets', () => {
    const state = useUiStore.getState();

    expect(state.workSearchTerm).toBe('');
    expect(state.workSearchMineOnly).toBe(false);
  });

  it('holds what is typed', () => {
    useUiStore.getState().setWorkSearchTerm('rails');

    expect(useUiStore.getState().workSearchTerm).toBe('rails');
  });

  it('narrows to the user when asked', () => {
    useUiStore.getState().setWorkSearchMineOnly(true);

    expect(useUiStore.getState().workSearchMineOnly).toBe(true);
  });

  it('drops the scope when the box is emptied by hand', () => {
    // The failure this guards: a scope set for one question silently governing
    // the next. `prSearchAllRepos` follows the same rule, for the same reason.
    useUiStore.getState().setWorkSearchTerm('rails');
    useUiStore.getState().setWorkSearchMineOnly(true);

    useUiStore.getState().setWorkSearchTerm('');

    expect(useUiStore.getState().workSearchMineOnly).toBe(false);
  });

  it('drops the scope when the box is cleared by its button', () => {
    useUiStore.getState().setWorkSearchTerm('rails');
    useUiStore.getState().setWorkSearchMineOnly(true);

    useUiStore.getState().clearWorkSearch();

    expect(useUiStore.getState().workSearchTerm).toBe('');
    expect(useUiStore.getState().workSearchMineOnly).toBe(false);
  });

  it('keeps the scope while the term is only being edited', () => {
    useUiStore.getState().setWorkSearchMineOnly(true);

    useUiStore.getState().setWorkSearchTerm('rail');
    useUiStore.getState().setWorkSearchTerm('rails');

    expect(useUiStore.getState().workSearchMineOnly).toBe(true);
  });

  it('is cleared by reset', () => {
    useUiStore.getState().setWorkSearchTerm('rails');
    useUiStore.getState().setWorkSearchMineOnly(true);

    useUiStore.getState().reset();

    expect(useUiStore.getState().workSearchTerm).toBe('');
    expect(useUiStore.getState().workSearchMineOnly).toBe(false);
  });
});

describe('ui-store — the place machine (HIVE-195)', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  const ui = () => useUiStore.getState();

  it('opens on Home with the panel open', () => {
    expect(ui().place).toBe('home');
    expect(ui().panelOpen).toBe(true);
  });

  it('a new place opens its panel and dismisses the picker and settings', () => {
    useUiStore.setState({ panelOpen: false, picker: true, settings: true });

    ui().selectPlace('work');

    expect(ui()).toMatchObject({ place: 'work', panelOpen: true, picker: false, settings: false });
  });

  it('the active place, under settings or the picker, dismisses them and leaves everything else', () => {
    ui().selectPlace('sessions');
    ui().openTab('hero-refresh');
    useUiStore.setState({ settings: true, picker: true, panelOpen: true });

    ui().selectPlace('sessions');

    expect(ui()).toMatchObject({ place: 'sessions', settings: false, picker: false, panelOpen: true, activeTab: 'hero-refresh' });
  });

  it('the active place toggles its panel', () => {
    ui().selectPlace('work');

    ui().selectPlace('work');
    expect(ui().panelOpen).toBe(false);

    ui().selectPlace('work');
    expect(ui().panelOpen).toBe(true);
  });

  it('Sessions with a session on stage goes back to the Overmind, panel untouched, then toggles', () => {
    ui().selectPlace('sessions');
    ui().openTab('hero-refresh');
    useUiStore.setState({ panelOpen: false });

    ui().selectPlace('sessions');
    expect(ui()).toMatchObject({ activeTab: 'orch', panelOpen: false, place: 'sessions' });

    ui().selectPlace('sessions');
    expect(ui().panelOpen).toBe(true);
  });

  it('returning to Sessions puts back the session opened there, though Agents wrote the tab', () => {
    ui().openTab('hero-refresh', 'sessions');
    ui().openAgentPage('slack-agent', 'activity');
    expect(ui().activeTab).toBe('slack-agent');

    ui().selectPlace('sessions');
    expect(ui()).toMatchObject({ place: 'sessions', activeTab: 'hero-refresh' });
  });

  it('returning to Sessions lands on the Overmind when asked to, and forgets the session', () => {
    ui().openTab('hero-refresh', 'sessions');
    ui().selectPlace('work');

    ui().selectPlace('sessions', true);
    expect(ui()).toMatchObject({ activeTab: 'orch', sessionsTab: 'orch' });
  });

  it('a first visit to Sessions, and one after the Overmind was chosen, show the Overmind', () => {
    ui().selectPlace('sessions');
    expect(ui().activeTab).toBe('orch');

    ui().openTab('hero-refresh');
    ui().backToOrch();
    ui().selectPlace('work');
    ui().selectPlace('sessions');
    expect(ui().activeTab).toBe('orch');
  });

  it('remembering what a place shows keeps its page state until the row changes', () => {
    ui().openWorkTicket('A-1');
    ui().setWorkConversation('everything');
    ui().rememberWorkTicket('A-1', 3);
    expect(ui()).toMatchObject({ workTicket: 'A-1', workTicketAt: 3, workConversation: 'everything' });
    ui().rememberWorkTicket('A-2', 3);
    expect(ui()).toMatchObject({ workTicket: 'A-2', workConversation: 'comments' });

    ui().openAgentPage('a', 'definition');
    ui().rememberAgentPage('a', 1);
    expect(ui()).toMatchObject({ agentPage: { name: 'a', view: 'definition' }, agentPageAt: 1 });
    ui().rememberAgentPage('b', 1);
    expect(ui().agentPage).toEqual({ name: 'b', view: 'activity' });

    ui().openPrPage({ owner: 'Acme', repo: 'Server', n: 1 });
    ui().setPrFile('a.ts');
    ui().rememberPrPage({ owner: 'acme', repo: 'server', n: 1 }, 0);
    expect(ui()).toMatchObject({ prFile: 'a.ts', prPageAt: 0 });
    ui().rememberPrPage({ owner: 'acme', repo: 'server', n: 2 }, 0);
    expect(ui()).toMatchObject({ prPage: { n: 2 }, prFile: null });
  });

  it('togglePanel flips panelOpen', () => {
    ui().togglePanel();
    expect(ui().panelOpen).toBe(false);
    ui().togglePanel();
    expect(ui().panelOpen).toBe(true);
  });

  it('openTab with a place moves it; without one it stays', () => {
    ui().openTab('slack-agent', 'agents');
    expect(ui().place).toBe('agents');

    ui().openTab('hero-refresh');
    expect(ui()).toMatchObject({ place: 'agents', activeTab: 'hero-refresh' });
  });

  it('backToOrch lands on Sessions', () => {
    ui().backToOrch();
    expect(ui()).toMatchObject({ activeTab: 'orch', place: 'sessions' });
  });

  it('reset restores Home with the panel open', () => {
    ui().selectPlace('prs');
    ui().togglePanel();

    ui().reset();

    expect(ui()).toMatchObject({ place: 'home', panelOpen: true });
  });
});

describe('reset (HIVE-213)', () => {
  it('restores Home with the panel open, and no rail fields exist', () => {
    useUiStore.setState({ place: 'prs', panelOpen: false });
    useUiStore.getState().reset();
    const state = useUiStore.getState() as unknown as Record<string, unknown>;
    expect(state.place).toBe('home');
    expect(state.panelOpen).toBe(true);
    for (const key of ['leftTab', 'railTab', 'showActivityRail', 'collapsed']) {
      expect(key in state).toBe(false);
    }
  });
});

describe('Sessions place view state (HIVE-197)', () => {
  beforeEach(() => useUiStore.getState().reset());

  it('starts unfiltered, folded, Ended folded', () => {
    const s = useUiStore.getState();
    expect(s.sessionsProject).toBeNull();
    expect(s.sessionsFilter).toBe('all');
    expect(s.endedExpanded).toBe(false);
    expect(s.expanded).toEqual({});
  });

  it('setSessionsProject filters and unfolds that project; null clears and keeps folds', () => {
    useUiStore.getState().setSessionsProject('nova-web');
    expect(useUiStore.getState().sessionsProject).toBe('nova-web');
    expect(useUiStore.getState().expanded['nova-web']).toBe(true);
    useUiStore.getState().setSessionsProject(null);
    expect(useUiStore.getState().sessionsProject).toBeNull();
    expect(useUiStore.getState().expanded['nova-web']).toBe(true);
  });

  it('toggleProjectFold flips, and expandProject only opens', () => {
    useUiStore.getState().toggleProjectFold('a');
    expect(useUiStore.getState().expanded.a).toBe(true);
    useUiStore.getState().toggleProjectFold('a');
    expect(useUiStore.getState().expanded.a).toBe(false);
    useUiStore.getState().expandProject('a');
    useUiStore.getState().expandProject('a');
    expect(useUiStore.getState().expanded.a).toBe(true);
  });

  it('setSessionsFilter and expandEnded', () => {
    useUiStore.getState().setSessionsFilter('ended');
    useUiStore.getState().expandEnded();
    expect(useUiStore.getState().sessionsFilter).toBe('ended');
    expect(useUiStore.getState().endedExpanded).toBe(true);
  });

  it('the console starts folded and toggles (HIVE-197)', () => {
    useUiStore.getState().reset();
    expect(useUiStore.getState().consoleShown).toBe(false);
    useUiStore.getState().toggleConsole();
    expect(useUiStore.getState().consoleShown).toBe(true);
  });
});

describe('back to the Overmind (HIVE-197)', () => {
  beforeEach(() => useUiStore.getState().reset());

  it('backToOrch selects the session left and keeps filters and folds', () => {
    useUiStore.setState({
      activeTab: 'hero-refresh',
      sessionsProject: 'nova-web',
      sessionsFilter: 'live',
      expanded: { 'nova-web': true },
    });
    useUiStore.getState().backToOrch();
    const s = useUiStore.getState();
    expect(s.activeTab).toBe('orch');
    expect(s.selId).toBe('hero-refresh');
    expect(s.sessionsProject).toBe('nova-web');
    expect(s.sessionsFilter).toBe('live');
    expect(s.expanded).toEqual({ 'nova-web': true });
  });

  it('backToOrch from the Overmind leaves selId alone', () => {
    useUiStore.setState({ activeTab: 'orch', selId: 'x' });
    useUiStore.getState().backToOrch();
    expect(useUiStore.getState().selId).toBe('x');
  });

  it('the Sessions icon with a session on stage does the same', () => {
    useUiStore.setState({ place: 'sessions', activeTab: 'lead-form', selId: null });
    useUiStore.getState().selectPlace('sessions');
    expect(useUiStore.getState().activeTab).toBe('orch');
    expect(useUiStore.getState().selId).toBe('lead-form');
    expect(useUiStore.getState().panelOpen).toBe(true);
  });
});

describe('Work place (HIVE-203)', () => {
  beforeEach(() => useUiStore.getState().reset());

  it('opens a ticket on the Work place, on Comments, closing overlays', () => {
    useUiStore.setState({ picker: true, settings: true, workConversation: 'everything' });
    useUiStore.getState().openWorkTicket('HIVE-7');
    expect(useUiStore.getState()).toMatchObject({
      workTicket: 'HIVE-7',
      place: 'work',
      panelOpen: true,
      workConversation: 'comments',
      picker: false,
      settings: false,
    });
  });

  it('starts with Done folded and toggles one group', () => {
    expect(useUiStore.getState().workFolded).toEqual({ todo: false, 'in-progress': false, done: true });
    useUiStore.getState().toggleWorkGroup('done');
    expect(useUiStore.getState().workFolded.done).toBe(false);
  });

  it('starts with every agent lane unfolded and folds one (HIVE-204)', () => {
    expect(useUiStore.getState().agentsFolded).toEqual({ summons: false, morphing: false, burrowed: false });
    useUiStore.getState().toggleAgentGroup('burrowed');
    expect(useUiStore.getState().agentsFolded.burrowed).toBe(true);
  });

  it('switches the conversation mode', () => {
    useUiStore.getState().setWorkConversation('everything');
    expect(useUiStore.getState().workConversation).toBe('everything');
  });
});

describe('ui-store — the agent page (HIVE-204)', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  it('starts with no agent page', () => {
    expect(useUiStore.getState().agentPage).toBeNull();
  });

  it('openAgentPage opens the Agents place on the asked view and dismisses overlays', () => {
    useUiStore.getState().openSettings('agents');
    useUiStore.getState().openAgentPage('acr', 'definition');
    expect(useUiStore.getState()).toMatchObject({
      agentPage: { name: 'acr', view: 'definition' },
      place: 'agents',
      panelOpen: true,
      picker: false,
      settings: false,
    });
  });

  it('opening a named page also makes it the active tab; a new agent returns the tab to the orchestrator', () => {
    useUiStore.getState().openAgentPage('acr', 'activity');
    expect(useUiStore.getState().activeTab).toBe('acr');
    useUiStore.getState().openAgentPage(null, 'definition');
    expect(useUiStore.getState().activeTab).toBe('orch');
    expect(useUiStore.getState().agentPage).toEqual({ name: null, view: 'definition' });
  });

  it('openTab to the agents place opens that agent on Activity', () => {
    useUiStore.getState().openTab('shipper', 'agents');
    expect(useUiStore.getState().agentPage).toEqual({ name: 'shipper', view: 'activity' });
  });

  it('openTab to another place leaves the agent page as it was', () => {
    useUiStore.getState().openAgentPage('acr', 'definition');
    useUiStore.getState().openTab('sess-1', 'sessions');
    expect(useUiStore.getState().agentPage).toEqual({ name: 'acr', view: 'definition' });
  });

  it('setAgentPageView changes the view and keeps the agent', () => {
    useUiStore.getState().openAgentPage('acr', 'activity');
    useUiStore.getState().setAgentPageView('definition');
    expect(useUiStore.getState().agentPage).toEqual({ name: 'acr', view: 'definition' });
  });

  it('setAgentPageView with nothing open does nothing', () => {
    useUiStore.getState().setAgentPageView('definition');
    expect(useUiStore.getState().agentPage).toBeNull();
  });

  it('closeAgentPage leaves nothing open and stays on the place', () => {
    useUiStore.getState().openAgentPage('acr', 'activity');
    useUiStore.getState().closeAgentPage();
    expect(useUiStore.getState().agentPage).toBeNull();
    expect(useUiStore.getState().place).toBe('agents');
  });
});

describe('ui-store — the PRs place (HIVE-205)', () => {
  beforeEach(() => useUiStore.getState().reset());

  it('starts with no PR open, on Conversation, Hatched folded, Comments, no search', () => {
    expect(useUiStore.getState()).toMatchObject({
      prPage: null, prTab: 'conversation', prsFolded: true, prConversation: 'comments', prSearchOpen: false,
    });
  });

  it('starts with no file, no filter, Unified (HIVE-207)', () => {
    const s = useUiStore.getState();
    expect([s.prFile, s.prFileFilter, s.prDiffView]).toEqual([null, '', 'unified']);
  });

  it('opening a PR resets the file and the filter but keeps the view and the Files tab (HIVE-207)', () => {
    const s = useUiStore.getState();
    s.setPrTab('files');
    s.setPrFile('src/a.ts');
    s.setPrFileFilter('fees');
    s.setPrDiffView('split');
    s.openPrPage({ owner: 'acme', repo: 'web', n: 2 });
    const after = useUiStore.getState();
    expect([after.prTab, after.prFile, after.prFileFilter, after.prDiffView]).toEqual(['files', null, '', 'split']);
  });

  it('openPrPage opens the PRs place on the PR, dismisses overlays, keeps the tab and resets the filter', () => {
    useUiStore.getState().openPicker();
    useUiStore.getState().setPrConversation('everything');
    useUiStore.setState({ panelOpen: false });

    useUiStore.getState().openPrPage({ owner: 'acme', repo: 'server', n: 1182 });

    expect(useUiStore.getState()).toMatchObject({
      prPage: { owner: 'acme', repo: 'server', n: 1182 },
      place: 'prs', panelOpen: true, picker: false, settings: false,
      prTab: 'conversation', prConversation: 'comments',
    });
  });

  it('toggles the fold, sets the tab, the filter and the search', () => {
    const ui = useUiStore.getState();
    ui.togglePrsFolded();
    ui.setPrTab('conversation');
    ui.setPrConversation('everything');
    ui.setPrSearchOpen(true);
    expect(useUiStore.getState()).toMatchObject({ prsFolded: false, prTab: 'conversation', prConversation: 'everything', prSearchOpen: true });
  });

  it('is reset with the rest of the view state', () => {
    useUiStore.getState().openPrPage({ owner: 'acme', repo: 'server', n: 1 });
    useUiStore.getState().reset();
    expect(useUiStore.getState().prPage).toBeNull();
  });
});

describe('the Checks tab selection (HIVE-206)', () => {
  beforeEach(() => useUiStore.getState().reset());

  it('openPrChecks shows the Checks tab on a job', () => {
    useUiStore.getState().openPrChecks(77);
    expect(useUiStore.getState()).toMatchObject({ prTab: 'checks', prJob: 77 });
  });

  it('openPrChecks leaves an older push so the clicked job is looked up in the latest', () => {
    useUiStore.setState({ prRun: 'oldsha1' });
    useUiStore.getState().openPrChecks(77);
    expect(useUiStore.getState()).toMatchObject({ prTab: 'checks', prRun: null, prJob: 77 });
  });

  it('showPrRun shows a push and lets go of the clicked job', () => {
    useUiStore.setState({ prJob: 77 });
    useUiStore.getState().showPrRun('9f3c2ab');
    expect(useUiStore.getState()).toMatchObject({ prRun: '9f3c2ab', prJob: null });
  });

  it('showPrJob picks a job', () => {
    useUiStore.getState().showPrJob(12);
    expect(useUiStore.getState().prJob).toBe(12);
  });

  it('openPrPage forgets the shown push and job, and keeps the tab', () => {
    useUiStore.setState({ prTab: 'checks', prRun: 'abc', prJob: 3 });
    useUiStore.getState().openPrPage({ owner: 'acme', repo: 'server', n: 1 });
    expect(useUiStore.getState()).toMatchObject({ prTab: 'checks', prRun: null, prJob: null });
  });
});

describe('ui-store — the inbox stack (HIVE-198, HIVE-228)', () => {
  beforeEach(() => useUiStore.getState().reset());

  it('starts down with the drawer shut', () => {
    const s = useUiStore.getState();
    expect(s.stackUp).toBe(false);
    expect(s.arrivalPulse).toBeNull();
    expect(s.inboxDrawer).toEqual({ open: false, thread: null });
  });

  it('an arrival raises the stack', () => {
    useUiStore.getState().pushArrival('a', false);
    expect(useUiStore.getState().stackUp).toBe(true);
  });

  it('a quiet arrival pulses instead of rising', () => {
    useUiStore.getState().pushArrival('a', true);
    expect(useUiStore.getState().stackUp).toBe(false);
    expect(useUiStore.getState().arrivalPulse).toBe('a');
  });

  it('nothing rises while the drawer is open', () => {
    useUiStore.getState().openInboxDrawer();
    useUiStore.getState().pushArrival('a', false);
    expect(useUiStore.getState().stackUp).toBe(false);
  });

  it('✕ hides the stack', () => {
    useUiStore.getState().pushArrival('a', false);
    useUiStore.getState().hideStack();
    expect(useUiStore.getState().stackUp).toBe(false);
  });

  it('the pill toggles the stack', () => {
    useUiStore.getState().toggleStack();
    expect(useUiStore.getState().stackUp).toBe(true);
    useUiStore.getState().toggleStack();
    expect(useUiStore.getState().stackUp).toBe(false);
  });

  it('opens the drawer on a thread, hiding the stack, and closes it', () => {
    useUiStore.getState().pushArrival('a', false);
    useUiStore.getState().openInboxDrawer('t1');
    expect(useUiStore.getState().inboxDrawer).toEqual({ open: true, thread: 't1' });
    expect(useUiStore.getState().stackUp).toBe(false);
    useUiStore.getState().closeInboxDrawer();
    expect(useUiStore.getState().inboxDrawer).toEqual({ open: false, thread: null });
  });

  it('opens without a thread', () => {
    useUiStore.getState().openInboxDrawer();
    expect(useUiStore.getState().inboxDrawer).toEqual({ open: true, thread: null });
  });
});

describe('awaySince (HIVE-200)', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  it('starts at store creation and moves with markAway', () => {
    expect(typeof useUiStore.getState().awaySince).toBe('number');
    useUiStore.getState().markAway(1_700_000_000_000);
    expect(useUiStore.getState().awaySince).toBe(1_700_000_000_000);
  });
});

describe('focusPrEvent (HIVE-208)', () => {
  beforeEach(() => useUiStore.getState().reset());

  it('lands on Conversation at the item, switching to Everything for a Hive event', () => {
    useUiStore.getState().setPrTab('timeline');
    useUiStore.getState().focusPrEvent('e-20261003-110500-0001', true);
    expect(useUiStore.getState()).toMatchObject({ prTab: 'conversation', prFocus: 'e-20261003-110500-0001', prConversation: 'everything' });
    useUiStore.getState().setPrConversation('comments');
    useUiStore.getState().focusPrEvent('c-https://x', false);
    expect(useUiStore.getState()).toMatchObject({ prFocus: 'c-https://x', prConversation: 'comments' });
    useUiStore.getState().clearPrFocus();
    expect(useUiStore.getState().prFocus).toBeNull();
  });

  it('each open clears it', () => {
    useUiStore.getState().focusPrEvent('c-https://x', false);
    useUiStore.getState().openPrPage({ owner: 'acme', repo: 'server', n: 1 });
    expect(useUiStore.getState().prFocus).toBeNull();
  });
});

describe('narrow (HIVE-211)', () => {
  beforeEach(() => useUiStore.getState().reset());

  it('crossing below 1,200px closes the panel; widening does not reopen it', () => {
    useUiStore.setState({ place: 'work', panelOpen: true });
    useUiStore.getState().setNarrow(true);
    expect(useUiStore.getState()).toMatchObject({ narrow: true, panelOpen: false });
    useUiStore.getState().setNarrow(false);
    expect(useUiStore.getState()).toMatchObject({ narrow: false, panelOpen: false });
  });

  it('the bar icon still opens the panel while narrow', () => {
    useUiStore.getState().setNarrow(true);
    useUiStore.getState().selectPlace('work');
    expect(useUiStore.getState().panelOpen).toBe(true);
  });

  it('a repeat is a no-op', () => {
    useUiStore.getState().setNarrow(false);
    const before = useUiStore.getState();
    useUiStore.getState().setNarrow(false);
    expect(useUiStore.getState()).toBe(before);
  });
});

describe('a row pick while narrow (HIVE-211)', () => {
  beforeEach(() => useUiStore.getState().reset());

  const picks: [string, () => void][] = [
    ['openWorkTicket', () => useUiStore.getState().openWorkTicket('HIVE-1')],
    ['openAgentPage', () => useUiStore.getState().openAgentPage('acr', 'activity')],
    ['openPrPage', () => useUiStore.getState().openPrPage({ owner: 'o', repo: 'r', n: 1 })],
    ['openTab with a place', () => useUiStore.getState().openTab('s-1', 'sessions')],
    ['setSessionsProject', () => useUiStore.getState().setSessionsProject('p1')],
    ['setSessionsProject(null)', () => useUiStore.getState().setSessionsProject(null)],
  ];

  it.each(picks)('%s closes the overlay', (_name, pick) => {
    useUiStore.getState().setNarrow(true);
    useUiStore.setState({ panelOpen: true }); // opened from the bar icon
    pick();
    expect(useUiStore.getState().panelOpen).toBe(false);
  });

  it.each(picks.slice(0, 3))('%s still opens the panel when wide', (_name, pick) => {
    useUiStore.setState({ panelOpen: false });
    pick();
    expect(useUiStore.getState().panelOpen).toBe(true);
  });

  it.each(picks.slice(3))('%s leaves the panel as it is when wide', (_name, pick) => {
    useUiStore.setState({ panelOpen: false });
    pick();
    expect(useUiStore.getState().panelOpen).toBe(false);
    useUiStore.setState({ panelOpen: true });
    pick();
    expect(useUiStore.getState().panelOpen).toBe(true);
  });
});

describe('answeredHere (HIVE-218)', () => {
  beforeEach(() => useUiStore.getState().reset());

  it('remembers a thread answered in this window, and reset forgets it', () => {
    useUiStore.getState().markAnsweredHere('q1');
    expect(useUiStore.getState().answeredHere.has('q1')).toBe(true);
    useUiStore.getState().reset();
    expect(useUiStore.getState().answeredHere.has('q1')).toBe(false);
  });

  it('keeps the same set when the thread is already there', () => {
    useUiStore.getState().markAnsweredHere('q1');
    const before = useUiStore.getState().answeredHere;
    useUiStore.getState().markAnsweredHere('q1');
    expect(useUiStore.getState().answeredHere).toBe(before);
  });
});

describe('ui-store — What’s new', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  it('opens and closes the dialog', () => {
    expect(useUiStore.getState().whatsNewOpen).toBe(false);
    useUiStore.getState().setWhatsNewOpen(true);
    expect(useUiStore.getState().whatsNewOpen).toBe(true);
    useUiStore.getState().setWhatsNewOpen(false);
    expect(useUiStore.getState().whatsNewOpen).toBe(false);
  });

  it('opening it from Settings closes Settings, so the card is not stacked under the overlay', () => {
    useUiStore.getState().openSettings();
    useUiStore.getState().setWhatsNewOpen(true);
    expect(useUiStore.getState()).toMatchObject({ whatsNewOpen: true, settings: false });
  });
});
