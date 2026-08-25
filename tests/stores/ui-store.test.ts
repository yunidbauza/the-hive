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

  it('starts on the orchestrator with the projects and inbox tabs', () => {
    const state = useUiStore.getState();

    expect(state.activeTab).toBe('orch');
    expect(state.leftTab).toBe('projects');
    expect(state.railTab).toBe('inbox');
    expect(state.showActivityRail).toBe(true);
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

  it('toggleProject collapses and expands', () => {
    const { toggleProject } = useUiStore.getState();

    toggleProject('nova-web');
    expect(useUiStore.getState().collapsed['nova-web']).toBe(true);

    toggleProject('nova-web');
    expect(useUiStore.getState().collapsed['nova-web']).toBe(false);
  });

  it('tracks each project independently', () => {
    useUiStore.getState().toggleProject('nova-web');

    expect(useUiStore.getState().collapsed['nova-web']).toBe(true);
    expect(useUiStore.getState().collapsed['referral-api']).toBeUndefined();
  });

  it('switches left and rail tabs', () => {
    useUiStore.getState().setLeftTab('agents');
    useUiStore.getState().setRailTab('prs');

    expect(useUiStore.getState().leftTab).toBe('agents');
    expect(useUiStore.getState().railTab).toBe('prs');
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

  it('toggles the activity rail', () => {
    useUiStore.getState().toggleActivityRail();
    expect(useUiStore.getState().showActivityRail).toBe(false);
  });

  it('tracks the orchestrator table selection', () => {
    useUiStore.getState().setSelIdx(4);
    expect(useUiStore.getState().selIdx).toBe(4);
  });

  it('reset returns every field to its initial value', () => {
    const state = useUiStore.getState();
    state.openTab('webhooks');
    state.setLeftTab('agents');
    state.setSelIdx(7);
    state.toggleProject('nova-web');

    useUiStore.getState().reset();

    expect(useUiStore.getState()).toMatchObject({
      activeTab: 'orch',
      leftTab: 'projects',
      selIdx: 0,
      collapsed: {},
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

describe('revealRailTab (HIVE-93)', () => {
  it('selects the tab and opens the rail', () => {
    useUiStore.setState({ railTab: 'prs', showActivityRail: false });

    useUiStore.getState().revealRailTab('inbox');

    expect(useUiStore.getState().railTab).toBe('inbox');
    expect(useUiStore.getState().showActivityRail).toBe(true);
  });

  it('is idempotent, so a second click does not hide the rail', () => {
    /**
     * The distinction from `toggleActivityRail`, which is what the header bell
     * must not do: a user clicking the bell twice is asking for the inbox twice,
     * not asking for it and then asking for it to go away.
     */
    useUiStore.getState().revealRailTab('inbox');
    useUiStore.getState().revealRailTab('inbox');

    expect(useUiStore.getState().showActivityRail).toBe(true);
    expect(useUiStore.getState().railTab).toBe('inbox');
  });

  it('does not disturb the rail when only the tab differs', () => {
    useUiStore.setState({ railTab: 'explorer', showActivityRail: true });

    useUiStore.getState().revealRailTab('inbox');

    expect(useUiStore.getState().railTab).toBe('inbox');
    expect(useUiStore.getState().showActivityRail).toBe(true);
  });
});
