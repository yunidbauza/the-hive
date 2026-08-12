import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { Effort, Model } from '@/types/entity';

export type LeftTab = 'projects' | 'work' | 'agents';
export type RailTab = 'inbox' | 'prs' | 'explorer';

/**
 * View state — what the user is looking at, as opposed to what the system knows
 * (which lives in `hive-store.ts`).
 *
 * The split is not cosmetic: it keeps a keystroke in the picker from
 * re-rendering thirteen live terminals.
 *
 * Nothing here is persisted, and that is now a structural rule rather than an
 * omission: durable preferences live in `appearance-store.ts`, which persists
 * everything it holds. `theme` moved there in story 105 — restoring `picker` or
 * `activeTab` across a launch would reopen an overlay the user had closed.
 */
interface UiState {
  activeTab: 'orch' | string; // entity id, or the orchestrator
  selIdx: number; // orchestrator table selection
  leftTab: LeftTab;
  railTab: RailTab;
  collapsed: Record<string, boolean>; // project id -> collapsed
  picker: boolean; // new-session overlay open
  pickerQuery: string;
  /**
   * The ticket the picker was opened *for*, or `null` for the header button.
   *
   * View state rather than domain state: it is a property of the overlay
   * currently on screen, not something the app knows about the ticket. It dies
   * with the overlay, which is why it lives here and not in `hive-store`.
   */
  pickerTicket: string | null;
  settings: boolean; // full-stage settings overlay open (story 101)
  newModel: Model;
  newEffort: Effort;
  showActivityRail: boolean;

  /**
   * Which directories the explorer has open, keyed `projectId:relPath`.
   *
   * Keyed by project as well as path so that returning to a repository finds it
   * as it was left, rather than inheriting whatever the last one had expanded.
   *
   * View state, and therefore not persisted: an expansion map restored across a
   * launch would describe a tree that an agent has been rewriting all night.
   */
  explorerExpanded: Record<string, boolean>;
  /**
   * The project the explorer is rooted at while no session is open.
   *
   * The tree follows the active session, and the orchestrator tab names no
   * session — so this remembers the last one it was rooted at. Falling back to
   * "the first mapped project" every time you visit the orchestrator would
   * yank the tree away from what you were reading, once per navigation.
   */
  explorerProjectId: string | null;
  /**
   * Bumped whenever the filesystem is known to have changed — by the watcher,
   * and by the explorer's ↻ button.
   *
   * A counter rather than a timestamp: two events in the same millisecond must
   * still be two refreshes, and `Date.now()` would collapse them.
   *
   * It lives in the store rather than in the panel because the watcher now
   * outlives the panel. Local state died with the rail tab, which is precisely
   * the bug — an open file stopped reconciling the moment the user looked at
   * the Inbox.
   */
  fsRevision: number;

  openTab: (id: 'orch' | string) => void;
  backToOrch: () => void;
  setSelIdx: (index: number) => void;
  setLeftTab: (tab: LeftTab) => void;
  setRailTab: (tab: RailTab) => void;
  toggleProject: (id: string) => void;
  openPicker: (ticketKey?: string) => void;
  closePicker: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  setPickerQuery: (query: string) => void;
  setNewModel: (model: Model) => void;
  setNewEffort: (effort: Effort) => void;
  toggleActivityRail: () => void;
  toggleExplorerDir: (projectId: string, relPath: string) => void;
  collapseExplorer: () => void;
  setExplorerProjectId: (projectId: string) => void;
  bumpFsRevision: () => void;
  reset: () => void;
}

const initialUiState = {
  activeTab: 'orch' as 'orch' | string,
  selIdx: 0,
  leftTab: 'projects' as LeftTab,
  railTab: 'inbox' as RailTab,
  collapsed: {} as Record<string, boolean>,
  picker: false,
  pickerQuery: '',
  pickerTicket: null as string | null,
  settings: false,
  newModel: 'opus' as Model,
  newEffort: 'high' as Effort,
  showActivityRail: true,
  explorerExpanded: {} as Record<string, boolean>,
  explorerProjectId: null as string | null,
  fsRevision: 0,
};

export const useUiStore = create<UiState>()((set) => ({
  ...initialUiState,

  // Opening a tab always dismisses the picker: the user has made their choice.
  // Settings goes with it (story 101) — the rails stay visible behind the
  // overlay, so a rail click that left settings up would look broken.
  openTab: (id) => set({ activeTab: id, picker: false, settings: false }),

  /**
   * Return to the orchestrator — the ← pill on the session meta bar, and the
   * ArrowLeft binding story 060 adds.
   *
   * A named action rather than `openTab('orch')` at each call site: "go home"
   * is a distinct intent from "open this thing", and 060 needs something to
   * bind that reads as the former.
   */
  backToOrch: () => set({ activeTab: 'orch', picker: false, settings: false }),

  setSelIdx: (index) => set({ selIdx: index }),
  setLeftTab: (tab) => set({ leftTab: tab }),
  setRailTab: (tab) => set({ railTab: tab }),

  toggleProject: (id) =>
    set((state) => ({
      collapsed: { ...state.collapsed, [id]: !state.collapsed[id] },
    })),

  /**
   * Open the picker, optionally *for* a ticket.
   *
   * The query is cleared on open, not on close, so reopening never shows a
   * stale filter — and `pickerTicket` is assigned on **every** open for the
   * same reason, `null` included. That unconditional assignment is what makes
   * the four other places that set `picker: false` safe to leave alone: a
   * ticket key can never outlive the overlay it was set for, because the next
   * open overwrites it before anything can read it.
   */
  openPicker: (ticketKey) =>
    set({ picker: true, pickerQuery: '', pickerTicket: ticketKey ?? null }),
  closePicker: () => set({ picker: false }),

  /**
   * Open settings, dismissing the picker (story 101).
   *
   * The realistic route here is the picker discovering it has no projects to
   * offer, so leaving it open would stack two full-stage overlays. Like the
   * picker, this never touches `activeTab`: closing settings has to return the
   * user to the terminal they were watching.
   */
  openSettings: () => set({ settings: true, picker: false }),
  closeSettings: () => set({ settings: false }),
  setPickerQuery: (query) => set({ pickerQuery: query }),

  setNewModel: (model) => set({ newModel: model }),
  setNewEffort: (effort) => set({ newEffort: effort }),

  toggleActivityRail: () =>
    set((state) => ({ showActivityRail: !state.showActivityRail })),

  toggleExplorerDir: (projectId, relPath) =>
    set((state) => {
      const key = `${projectId}:${relPath}`;
      return {
        explorerExpanded: {
          ...state.explorerExpanded,
          [key]: !state.explorerExpanded[key],
        },
      };
    }),

  /**
   * Collapse everything, in every project — the panel's ⤡ button.
   *
   * Everything, not just the visible project. "Collapse all" that left another
   * repository's tree expanded would surprise the user the next time they
   * opened a session in it, and there is nothing worth preserving in a map of
   * directories they asked to close.
   */
  collapseExplorer: () => set({ explorerExpanded: {} }),

  setExplorerProjectId: (explorerProjectId) => set({ explorerProjectId }),

  bumpFsRevision: () =>
    set((state) => ({ fsRevision: state.fsRevision + 1 })),

  reset: () => set(initialUiState),
}));

/**
 * Selector hooks — the incorpx rule.
 *
 * Components never read the store object directly and never call `getState()`.
 * Every consumer goes through a named hook so a change to one slice of state
 * cannot re-render everything subscribed to the store.
 */
const railStateSelector = (state: UiState) => ({
  railTab: state.railTab,
  showActivityRail: state.showActivityRail,
});

const pickerStateSelector = (state: UiState) => ({
  picker: state.picker,
  pickerQuery: state.pickerQuery,
  pickerTicket: state.pickerTicket,
  newModel: state.newModel,
  newEffort: state.newEffort,
});

const newSessionDefaultsSelector = (state: UiState) => ({
  newModel: state.newModel,
  newEffort: state.newEffort,
});

const settingsActionsSelector = (state: UiState) => ({
  openSettings: state.openSettings,
  closeSettings: state.closeSettings,
});

const pickerActionsSelector = (state: UiState) => ({
  openPicker: state.openPicker,
  closePicker: state.closePicker,
  setPickerQuery: state.setPickerQuery,
  setNewModel: state.setNewModel,
  setNewEffort: state.setNewEffort,
});

/** Which tab the center stage is showing. */
export const useActiveTab = () => useUiStore((state) => state.activeTab);

/** Open a tab (entity id, or `'orch'`). */
export const useOpenTab = () => useUiStore((state) => state.openTab);

/** Return to the orchestrator view (story 040's ← pill, story 060's ArrowLeft). */
export const useBackToOrch = () => useUiStore((state) => state.backToOrch);

/** Left rail tab + setter. */
export const useLeftTab = () => useUiStore((state) => state.leftTab);
export const useSetLeftTab = () => useUiStore((state) => state.setLeftTab);

/** Activity rail state. */
export const useRailState = () => useUiStore(useShallow(railStateSelector));

/** Switch rail panels — the activity rail's tab bar (story 050). */
export const useSetRailTab = () => useUiStore((state) => state.setRailTab);

/**
 * Whether the activity rail is mounted (story 020).
 *
 * Deliberately narrower than `useRailState()`: the shell only cares about
 * visibility, and subscribing it to `railTab` too would re-render all three
 * regions — terminal included — every time the user switches rail tabs.
 */
export const useShowActivityRail = () =>
  useUiStore((state) => state.showActivityRail);

/** Whether a project is collapsed in the projects panel. */
export const useProjectCollapsed = (id: string) =>
  useUiStore((state) => Boolean(state.collapsed[id]));

export const useToggleProject = () => useUiStore((state) => state.toggleProject);

/**
 * The model and effort a new session starts with.
 *
 * Deliberately narrower than `usePickerState()`: the projects tree renders one
 * start link per project, and subscribing those to `pickerQuery` as well would
 * re-render every one of them on every keystroke in the picker's search box.
 *
 * These are the *current* defaults, not the seeded ones — the picker's steppers
 * write here, so the tree starts sessions on whatever the user last chose,
 * which is also what the picker shows as selected.
 */
export const useNewSessionDefaults = () =>
  useUiStore(useShallow(newSessionDefaultsSelector));

/** Whether the settings overlay is open (story 101). */
export const useSettingsOpen = () => useUiStore((state) => state.settings);

/** Settings actions, referentially stable across unrelated state changes. */
export const useSettingsActions = () =>
  useUiStore(useShallow(settingsActionsSelector));

/** New-session picker state and actions. */
export const usePickerState = () => useUiStore(useShallow(pickerStateSelector));
export const usePickerActions = () =>
  useUiStore(useShallow(pickerActionsSelector));

/** Orchestrator table selection. */
export const useSelIdx = () => useUiStore((state) => state.selIdx);
export const useSetSelIdx = () => useUiStore((state) => state.setSelIdx);

/**
 * Whether one explorer directory is expanded.
 *
 * Per row, like `useProjectCollapsed`, and for the same reason: subscribing the
 * whole tree to the expansion map would re-render every visible row each time
 * any one of them opened.
 */
export const useExplorerExpanded = (projectId: string, relPath: string) =>
  useUiStore((state) => Boolean(state.explorerExpanded[`${projectId}:${relPath}`]));

export const useToggleExplorerDir = () =>
  useUiStore((state) => state.toggleExplorerDir);

export const useCollapseExplorer = () =>
  useUiStore((state) => state.collapseExplorer);

/** The sticky root for the orchestrator tab. See the field's comment. */
export const useExplorerProjectId = () =>
  useUiStore((state) => state.explorerProjectId);

export const useSetExplorerProjectId = () =>
  useUiStore((state) => state.setExplorerProjectId);

/** The filesystem-change counter the tree re-reads on. */
export const useFsRevision = () => useUiStore((state) => state.fsRevision);

export const useBumpFsRevision = () =>
  useUiStore((state) => state.bumpFsRevision);


