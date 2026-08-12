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

    toggleProject('apfm-web');
    expect(useUiStore.getState().collapsed['apfm-web']).toBe(true);

    toggleProject('apfm-web');
    expect(useUiStore.getState().collapsed['apfm-web']).toBe(false);
  });

  it('tracks each project independently', () => {
    useUiStore.getState().toggleProject('apfm-web');

    expect(useUiStore.getState().collapsed['apfm-web']).toBe(true);
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
    setPickerQuery('apfm');
    closePicker();
    expect(useUiStore.getState().pickerQuery).toBe('apfm');

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
    state.toggleProject('apfm-web');

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
    useUiStore.getState().toggleExplorerDir('apfm-web', 'src');
    expect(useUiStore.getState().explorerExpanded['apfm-web:src']).toBe(true);

    useUiStore.getState().toggleExplorerDir('apfm-web', 'src');
    expect(useUiStore.getState().explorerExpanded['apfm-web:src']).toBe(false);
  });

  /**
   * Keyed by project as well as path, so returning to a repository finds it as
   * it was left rather than inheriting whatever the last one had expanded.
   */
  it('keeps one project’s expansion separate from another’s', () => {
    useUiStore.getState().toggleExplorerDir('apfm-web', 'src');

    expect(useUiStore.getState().explorerExpanded['referral-api:src']).toBeUndefined();
  });

  /**
   * Everything, in every project. "Collapse all" that left another
   * repository's tree open would surprise the user the next time they opened a
   * session in it.
   */
  it('collapses every project at once', () => {
    useUiStore.getState().toggleExplorerDir('apfm-web', 'src');
    useUiStore.getState().toggleExplorerDir('referral-api', 'lib');

    useUiStore.getState().collapseExplorer();

    expect(useUiStore.getState().explorerExpanded).toEqual({});
  });

  it('remembers the project the tree was rooted at', () => {
    useUiStore.getState().setExplorerProjectId('referral-api');
    expect(useUiStore.getState().explorerProjectId).toBe('referral-api');
  });

  it('starts with nothing expanded and no sticky project', () => {
    useUiStore.getState().toggleExplorerDir('apfm-web', 'src');
    useUiStore.getState().setExplorerProjectId('apfm-web');

    useUiStore.getState().reset();

    expect(useUiStore.getState().explorerExpanded).toEqual({});
    expect(useUiStore.getState().explorerProjectId).toBeNull();
  });
});
