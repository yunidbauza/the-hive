import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { Effort, Model } from '@/types/entity';
import type { SettingsSection } from '@/types/settings';

import type { FsSearchMode } from '@shared/fs-contract';


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
  /**
   * Which fleet row the caret is on — **an entity id, not a position**.
   *
   * This was `selIdx: number`, an index into `useNavOrder()`, and the index was
   * only ever stable because that list was in insertion order. It is sorted by
   * recency now, so a session spawning in the background lands at the top and
   * renumbers every row beneath it: a user who had arrowed down three rows and
   * paused would find the caret on a different session, and Enter would open
   * the wrong one. Ending a session did the same thing even before the sort,
   * by moving a row from the live group to the ended one.
   *
   * An id has no such failure. The caret stays on the session the user put it
   * on however the fleet rearranges around it, which is what "selection" means
   * everywhere else in the app — `activeTab` above is an id for the same
   * reason.
   *
   * `null` is "nothing selected", the state a fresh launch is in: there is no
   * sensible zeroth row to be on before a fleet exists, and defaulting to one
   * would put the caret on whichever session happened to arrive first.
   */
  selId: string | null;
  leftTab: LeftTab;
  railTab: RailTab;
  /**
   * What the PRs panel's search box holds. `''` means the panel shows the
   * ordinary sweep — the user's own open and recently-merged pull requests.
   *
   * View state, so it lives here rather than beside the results in
   * `hive-store`: the *term* is what the user is looking at, and the PRs that
   * come back are domain data. A keystroke must not re-render anything that
   * subscribes to the fleet.
   */
  prSearchTerm: string;
  /**
   * Whether the search reaches every mapped project rather than the active
   * session's.
   *
   * Unchecked is the default and means "this session's project". **Not
   * persisted**, and reset whenever the search is cleared or the session
   * changes — a scope the user set for one question must not silently govern
   * the next one, which is the failure mode of every remembered filter.
   *
   * With no session there is nothing narrower to offer, so the panel shows this
   * checked and disabled rather than pretending a narrower scope exists.
   */
  prSearchAllRepos: boolean;
  /**
   * What the Explorer's search box holds. `''` means the panel shows the tree.
   *
   * Here rather than in `hive-store` for the same reason `prSearchTerm` is:
   * the term is what the user is looking at, and the files that come back are
   * data. A keystroke in the box must not re-render the fleet.
   */
  explorerSearchTerm: string;
  /**
   * Whether the Explorer searches file *names* or their *contents*.
   *
   * `name` is the default because it is the cheaper walk and the commoner
   * question — "where does this file live" is asked far more often than "who
   * calls this". **Not persisted**, and reset with the term, for the reason
   * `prSearchAllRepos` gives: a mode set for one question must not silently
   * govern the next.
   */
  explorerSearchMode: FsSearchMode;
  /**
   * What the WORK panel's search box holds. `''` means the panel shows the
   * configured query's answer — the standing list of the user's own tickets.
   *
   * Here rather than in `hive-store` for the reason `prSearchTerm` gives: the
   * term is view state and the issues that come back are data.
   */
  workSearchTerm: string;
  /**
   * Whether the search is narrowed to the user's own tickets.
   *
   * Unchecked is the default, and that is the panel's whole argument about what
   * a search is: the standing list already answers "what is assigned to me", so
   * a search that could not leave it would never answer "which ticket was that
   * again". Ticking it appends `assignee = currentUser()`.
   *
   * **Not persisted**, and reset whenever the box is cleared — a scope set for
   * one question must not silently govern the next, which is the rule
   * {@link UiState.prSearchAllRepos} follows.
   */
  workSearchMineOnly: boolean;
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
  /** The pane `openSettings` was asked for, or `null` for the default. */
  settingsSection: SettingsSection | null;
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
  /** Put the caret on a row, or clear it with `null`. */
  setSelId: (id: string | null) => void;
  setLeftTab: (tab: LeftTab) => void;
  setRailTab: (tab: RailTab) => void;
  setPrSearchTerm: (term: string) => void;
  setPrSearchAllRepos: (all: boolean) => void;
  /** Empty the box and put the scope back to the session's project. */
  clearPrSearch: () => void;
  setExplorerSearchTerm: (term: string) => void;
  setExplorerSearchMode: (mode: FsSearchMode) => void;
  /** Empty the box and put the mode back to names. */
  clearExplorerSearch: () => void;
  setWorkSearchTerm: (term: string) => void;
  setWorkSearchMineOnly: (mine: boolean) => void;
  /** Empty the box and put the scope back to everyone's tickets. */
  clearWorkSearch: () => void;
  /**
   * Show a rail tab, revealing the rail if it was hidden (HIVE-93).
   *
   * Distinct from `setRailTab` because that one only changes which tab is
   * selected — on a collapsed rail it selects a tab nobody can see. And distinct
   * from `toggleActivityRail`, which would *hide* the rail when it is already
   * open: exactly the wrong outcome for the header bell, whose job is "show me
   * the inbox" rather than "flip the rail".
   *
   * Idempotent, so a second click on the bell leaves the inbox up instead of
   * playing peekaboo with it.
   */
  revealRailTab: (tab: RailTab) => void;
  toggleProject: (id: string) => void;
  openPicker: (ticketKey?: string) => void;
  closePicker: () => void;
  revealStage: () => void;
  openSettings: (section?: SettingsSection) => void;
  /**
   * Mark the requested pane as consumed.
   *
   * The overlay calls this once it has navigated. Without it the request would
   * stay set, and any later re-render that re-read it would drag the user back
   * to that pane after they had moved on.
   */
  clearSettingsSection: () => void;
  closeSettings: () => void;
  setPickerQuery: (query: string) => void;
  setNewModel: (model: Model) => void;
  setNewEffort: (effort: Effort) => void;
  toggleActivityRail: () => void;
  toggleExplorerDir: (projectId: string, relPath: string) => void;
  collapseExplorer: () => void;
  bumpFsRevision: () => void;
  reset: () => void;
}

const initialUiState = {
  activeTab: 'orch' as 'orch' | string,
  selId: null as string | null,
  leftTab: 'projects' as LeftTab,
  railTab: 'inbox' as RailTab,
  prSearchTerm: '',
  prSearchAllRepos: false,
  explorerSearchTerm: '',
  explorerSearchMode: 'name' as FsSearchMode,
  workSearchTerm: '',
  workSearchMineOnly: false,
  collapsed: {} as Record<string, boolean>,
  picker: false,
  pickerQuery: '',
  pickerTicket: null as string | null,
  settings: false,
  /**
   * Which pane the *next* open should land on, or `null` for the default.
   *
   * Set by `openSettings('agents')` and cleared by a bare `openSettings()`,
   * so the rule below still holds for every route that does not name a pane.
   */
  settingsSection: null as SettingsSection | null,
  newModel: 'opus' as Model,
  newEffort: 'high' as Effort,
  showActivityRail: true,
  explorerExpanded: {} as Record<string, boolean>,
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

  setSelId: (id) => set({ selId: id }),
  setLeftTab: (tab) => set({ leftTab: tab }),
  setRailTab: (tab) => set({ railTab: tab }),

  /*
    Clearing the box resets the scope with it. The two belong to one question,
    and leaving `all repos` switched on for the *next* search is exactly the
    stale-filter behaviour the flag is documented as avoiding.
  */
  setPrSearchTerm: (term) =>
    set(term === '' ? { prSearchTerm: '', prSearchAllRepos: false } : { prSearchTerm: term }),
  setPrSearchAllRepos: (all) => set({ prSearchAllRepos: all }),
  clearPrSearch: () => set({ prSearchTerm: '', prSearchAllRepos: false }),
  setExplorerSearchTerm: (term) =>
    set(
      term === ''
        ? { explorerSearchTerm: '', explorerSearchMode: 'name' }
        : { explorerSearchTerm: term },
    ),
  setExplorerSearchMode: (mode) => set({ explorerSearchMode: mode }),
  clearExplorerSearch: () =>
    set({ explorerSearchTerm: '', explorerSearchMode: 'name' }),

  // Same rule again: emptying the box puts the scope back, so a search narrowed
  // to the user once does not quietly narrow the next question too.
  setWorkSearchTerm: (term) =>
    set(
      term === ''
        ? { workSearchTerm: '', workSearchMineOnly: false }
        : { workSearchTerm: term },
    ),
  setWorkSearchMineOnly: (mine) => set({ workSearchMineOnly: mine }),
  clearWorkSearch: () => set({ workSearchTerm: '', workSearchMineOnly: false }),

  // `showActivityRail: true` unconditionally rather than a toggle — see the
  // interface note for why the bell must not flip it.
  revealRailTab: (tab) => set({ railTab: tab, showActivityRail: true }),

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
  /**
   * `settings: false` is not defensive tidying — it is the other half of
   * `openSettings`, which has always dismissed the picker.
   *
   * `resolveView` gives settings precedence, so setting `picker` while settings
   * is open changed nothing on screen and then dropped the user into the picker
   * whenever they next closed settings. That was unreachable while the header
   * was `pointer-events: none` behind an overlay; making the chrome live is
   * what exposed it.
   */
  openPicker: (ticketKey) =>
    set({
      picker: true,
      settings: false,
      pickerQuery: '',
      pickerTicket: ticketKey ?? null,
    }),
  closePicker: () => set({ picker: false }),

  /**
   * Dismiss whatever full-stage overlay is covering the centre, without moving
   * the user anywhere else.
   *
   * For an action taken in the chrome that *targets the stage* — opening a file
   * from the explorer is the one today. `openTab` and `backToOrch` already do
   * this as part of navigating; this is the case where the destination is
   * already correct and only the overlay is in the way.
   *
   * It exists because the rails became clickable behind an overlay. Before
   * that, opening a file from the explorer with settings open was unreachable;
   * now it would open the file silently *behind* settings — the tree row
   * highlights, the stage does not change, and the editor appears only once the
   * overlay is dismissed by hand.
   */
  revealStage: () => set({ picker: false, settings: false }),

  /**
   * Open settings, dismissing the picker (story 101).
   *
   * The realistic route here is the picker discovering it has no projects to
   * offer, so leaving it open would stack two full-stage overlays. Like the
   * picker, this never touches `activeTab`: closing settings has to return the
   * user to the terminal they were watching.
   */
  openSettings: (section) =>
    set({ settings: true, picker: false, settingsSection: section ?? null }),
  closeSettings: () => set({ settings: false, settingsSection: null }),
  clearSettingsSection: () => set({ settingsSection: null }),
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
  clearSettingsSection: state.clearSettingsSection,
});

const pickerActionsSelector = (state: UiState) => ({
  openPicker: state.openPicker,
  closePicker: state.closePicker,
  setPickerQuery: state.setPickerQuery,
  setNewModel: state.setNewModel,
  setNewEffort: state.setNewEffort,
});

/** Dismiss a full-stage overlay when the destination is already correct. */
export const useRevealStage = () => useUiStore((state) => state.revealStage);

/** Show a rail tab, opening the rail if it was hidden (HIVE-93). */
export const useRevealRailTab = () =>
  useUiStore((state) => state.revealRailTab);

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

/** The PRs panel's search box: what is typed, and how wide it reaches. */
export const usePrSearchTerm = () => useUiStore((state) => state.prSearchTerm);
export const usePrSearchAllRepos = () =>
  useUiStore((state) => state.prSearchAllRepos);
export const useSetPrSearchTerm = () =>
  useUiStore((state) => state.setPrSearchTerm);
export const useSetPrSearchAllRepos = () =>
  useUiStore((state) => state.setPrSearchAllRepos);
export const useClearPrSearch = () => useUiStore((state) => state.clearPrSearch);

/** The Explorer's search box: what is typed, and whether it reads contents. */
export const useExplorerSearchTerm = () =>
  useUiStore((state) => state.explorerSearchTerm);
export const useExplorerSearchMode = () =>
  useUiStore((state) => state.explorerSearchMode);
export const useSetExplorerSearchTerm = () =>
  useUiStore((state) => state.setExplorerSearchTerm);
export const useSetExplorerSearchMode = () =>
  useUiStore((state) => state.setExplorerSearchMode);
export const useClearExplorerSearch = () =>
  useUiStore((state) => state.clearExplorerSearch);

/** The WORK panel's search box: what is typed, and whose tickets it reaches. */
export const useWorkSearchTerm = () =>
  useUiStore((state) => state.workSearchTerm);
export const useWorkSearchMineOnly = () =>
  useUiStore((state) => state.workSearchMineOnly);
export const useSetWorkSearchTerm = () =>
  useUiStore((state) => state.setWorkSearchTerm);
export const useSetWorkSearchMineOnly = () =>
  useUiStore((state) => state.setWorkSearchMineOnly);
export const useClearWorkSearch = () =>
  useUiStore((state) => state.clearWorkSearch);

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

/**
 * The pane the overlay should navigate to, or `null` for none outstanding.
 *
 * A **request**, not a current-pane mirror. The overlay is `modal={false}` so
 * the rails stay clickable underneath it, which means `openSettings('agents')`
 * can fire while it is already open — reading this only at mount made that
 * click do visibly nothing. The overlay now navigates whenever a request
 * appears and calls `clearSettingsSection` to consume it, so a request acts
 * exactly once and a later render cannot re-apply it.
 */
export const useSettingsSection = (): SettingsSection | null =>
  useUiStore((state) => state.settingsSection);

/** New-session picker state and actions. */
export const usePickerState = () => useUiStore(useShallow(pickerStateSelector));
export const usePickerActions = () =>
  useUiStore(useShallow(pickerActionsSelector));

/** Orchestrator table selection. */
export const useSelId = () => useUiStore((state) => state.selId);
export const useSetSelId = () => useUiStore((state) => state.setSelId);

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
/** The filesystem-change counter the tree re-reads on. */
export const useFsRevision = () => useUiStore((state) => state.fsRevision);

export const useBumpFsRevision = () =>
  useUiStore((state) => state.bumpFsRevision);


