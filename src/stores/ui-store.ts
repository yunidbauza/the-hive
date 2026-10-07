import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { Effort, Model } from '@/types/entity';
import type { HatcheryRow } from '@/types/pull-request';
import type { SettingsSection } from '@/types/settings';

import type { FsSearchMode } from '@shared/fs-contract';
import type { JiraStatusCategory } from '@shared/jira-contract';


/** The activity bar's places (HIVE-195). */
export type Place = 'home' | 'sessions' | 'work' | 'agents' | 'prs';
/** The Overmind table's segmented filter (HIVE-197). */
export type TableFilter = 'all' | 'live' | 'ended';
/** The ticket page's Comments | Everything switch (HIVE-203). */
export type WorkConversation = 'comments' | 'everything';
/** The agent page's Activity | Definition switch (HIVE-204). */
export type AgentPageView = 'activity' | 'definition';

/**
 * The Agents panel's lanes (HIVE-204). Declared here, not in hive-store, because hive-store imports this
 * module. In code a `group`, never a `lane`: `lane:` is an agent frontmatter key (HIVE-184).
 */
export type AgentGroupKey = 'summons' | 'morphing' | 'burrowed';
/** Which agent the Agents place has open, and on which view (HIVE-204). */
export interface AgentPage {
  /** `null` is a new agent never saved. */
  name: string | null;
  view: AgentPageView;
}

/** The PR page's tabs (HIVE-205); Checks is HIVE-206's, Files HIVE-207's, Timeline HIVE-208's. */
export type PrTab = 'conversation' | 'checks' | 'files' | 'timeline';
/** The Files tab's diff layout (HIVE-207). */
export type PrDiffView = 'unified' | 'split';
/** Which PR the PRs place last opened (HIVE-205). */
export interface PrPageRef {
  owner: string;
  repo: string;
  n: number;
  /** The row the click carried: a searched PR is no row of the sweep, so the page cannot find it there. */
  row?: HatcheryRow;
}

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
  picker: boolean; // new-session overlay open
  pickerQuery: string;
  /**
   * The ticket the picker was opened *for*, or `null` when opened from New session on the Overmind.
   *
   * View state rather than domain state: it is a property of the overlay
   * currently on screen, not something the app knows about the ticket. It dies
   * with the overlay, which is why it lives here and not in `hive-store`.
   */
  pickerTicket: string | null;
  settings: boolean; // full-stage settings overlay open (story 101)
  /** The What's new card is up (1.0): at launch for a release that has one, or from Settings. */
  whatsNewOpen: boolean;
  /** The pane `openSettings` was asked for, or `null` for the default. */
  settingsSection: SettingsSection | null;
  newModel: Model;
  newEffort: Effort;
  /** Which place the round-two bar has open (HIVE-195). Every launch starts on Home. */
  place: Place;
  /**
   * What the Sessions place shows when the bar returns to it: the session last
   * opened there, or the Overmind. `activeTab` cannot hold this alone, because
   * the Agents place writes an agent into it. View state, not persisted.
   */
  sessionsTab: 'orch' | string;
  /** Whether that place's list panel shows beside the stage. */
  panelOpen: boolean;
  /** The window is under 1,200px (HIVE-211). Fed from `useNarrowWindow` by the shell; never persisted. */
  narrow: boolean;
  /** The Overmind's project filter (HIVE-197). `null` is All projects. */
  sessionsProject: string | null;
  sessionsFilter: TableFilter;
  /** "N more ›" pressed under an unfiltered Ended group. */
  endedExpanded: boolean;
  /** The Overmind's transcript, folded by default in round two (HIVE-197). */
  consoleShown: boolean;
  /** The Sessions list's fold map, **folded by default** (HIVE-197). */
  expanded: Record<string, boolean>;

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
  /** The ticket open on the Work place's stage (HIVE-203). View state, not persisted. */
  workTicket: string | null;
  /** Where `workTicket` last sat in the list, `-1` when opened from outside it (`openRowIndex`). */
  workTicketAt: number;
  /** Which Work panel groups are folded; Done starts folded (HIVE-203). View state, not persisted. */
  workFolded: Record<JiraStatusCategory, boolean>;
  /** The ticket page's conversation filter (HIVE-203). View state, not persisted; each open resets it. */
  workConversation: WorkConversation;
  /** Which Agents panel lanes are folded; all start unfolded (HIVE-204). View state, not persisted. */
  agentsFolded: Record<AgentGroupKey, boolean>;
  /**
   * The Agents place's open page (HIVE-204): which agent, and Activity or Definition. `name: null` is a
   * new agent never saved. View state, not persisted.
   */
  agentPage: AgentPage | null;
  /** Where the page's agent last sat in the panel, `-1` when opened from outside it (`openRowIndex`). */
  agentPageAt: number;
  /**
   * The PR the PRs place last opened (HIVE-205). The page shows it while it is
   * still in the list; the opening rule (`features/pull-requests/open-pr.ts`)
   * falls back otherwise. View state, not persisted.
   */
  prPage: PrPageRef | null;
  /** Where `prPage` last sat in the Hatchery, `-1` when opened from outside it (`openRowIndex`). */
  prPageAt: number;
  /** The PR page's tab; kept across PRs, so Checks stays Checks (HIVE-205). */
  prTab: PrTab;
  /** The Checks tab's shown push, by head sha; null shows the newest (HIVE-206). Not persisted. */
  prRun: string | null;
  /** The job clicked in the Checks graph; null shows the failed one (HIVE-206). Not persisted. */
  prJob: number | null;
  /** Whether the Hatched group is folded; it starts folded (HIVE-205). */
  prsFolded: boolean;
  /** The PR page's Comments | Everything filter; each open resets it (HIVE-205). */
  prConversation: WorkConversation;
  /** The PRs panel's search row is open, which also draws the panel over the empty Hatchery (HIVE-205). */
  prSearchOpen: boolean;
  /** The Files tab's selected path; each open resets it, and the tab falls back to its first file (HIVE-207). */
  prFile: string | null;
  /** The Files tab's "Filter files" text; each open resets it (HIVE-207). */
  prFileFilter: string;
  /** Unified or Split; kept across PRs, as the tab is (HIVE-207). */
  prDiffView: PrDiffView;
  /** The Conversation item the Timeline clicked through to, by its list key; cleared once scrolled to (HIVE-208). Not persisted. */
  prFocus: string | null;

  /** Open a tab; `place`, when the caller knows the entity's owner, moves the bar with it. */
  openTab: (id: 'orch' | string, place?: Place) => void;
  backToOrch: () => void;
  /**
   * Pick a place on the bar. A new place opens its panel and dismisses the
   * overlays, as `openTab` does; the active one toggles its panel — except
   * Sessions with a session on stage, which goes back to the Overmind first.
   * Entering Sessions puts back `sessionsTab`, or the Overmind when `overmind`
   * says so: that session has ended or gone, or the caller wants the list.
   */
  selectPlace: (place: Place, overmind?: boolean) => void;
  togglePanel: () => void;
  /** Crossing below 1,200px closes the panel, so the stage is never covered without a click (HIVE-211). */
  setNarrow: (narrow: boolean) => void;
  setSessionsProject: (id: string | null) => void;
  setSessionsFilter: (filter: TableFilter) => void;
  expandEnded: () => void;
  toggleConsole: () => void;
  toggleProjectFold: (id: string) => void;
  expandProject: (id: string) => void;
  /** Put the caret on a row, or clear it with `null`. */
  setSelId: (id: string | null) => void;
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
  /** Opening closes Settings, so the card never sits under the overlay it was opened from. */
  setWhatsNewOpen: (open: boolean) => void;
  setPickerQuery: (query: string) => void;
  setNewModel: (model: Model) => void;
  setNewEffort: (effort: Effort) => void;
  toggleExplorerDir: (projectId: string, relPath: string) => void;
  collapseExplorer: () => void;
  bumpFsRevision: () => void;
  /**
   * Open a ticket's page on the Work place (HIVE-203): moves the bar there, shows its
   * panel, starts the conversation on Comments and dismisses the overlays, as `openTab` does.
   */
  openWorkTicket: (key: string) => void;
  /** The ticket the Work stage is showing, and where it sits in the list; quiet: no place, panel or overlay moves. */
  rememberWorkTicket: (key: string, at: number) => void;
  toggleWorkGroup: (category: JiraStatusCategory) => void;
  toggleAgentGroup: (key: AgentGroupKey) => void;
  setWorkConversation: (mode: WorkConversation) => void;
  /**
   * Open an agent's page (HIVE-204): moves the bar to Agents, shows its panel and dismisses the
   * overlays. A named agent also becomes the active tab; a new one leaves the tab alone.
   */
  openAgentPage: (name: string | null, view: AgentPageView) => void;
  /** The agent the Agents stage is showing, and where it sits in the panel; a new name opens on Activity. */
  rememberAgentPage: (name: string, at: number) => void;
  setAgentPageView: (view: AgentPageView) => void;
  closeAgentPage: () => void;
  /** Open a PR's page (HIVE-205): the PRs place, its panel, Comments; dismisses the overlays and keeps the tab; forgets the Checks tab's shown push and job (HIVE-206), the Files tab's file and filter (HIVE-207), and the Timeline's focus (HIVE-208). */
  openPrPage: (ref: PrPageRef) => void;
  /** The PR the PRs stage is showing, and where it sits in the Hatchery; another PR forgets what `openPrPage` does. */
  rememberPrPage: (ref: PrPageRef, at: number) => void;
  setPrTab: (tab: PrTab) => void;
  showPrRun: (sha: string) => void;
  showPrJob: (id: number | null) => void;
  openPrChecks: (jobId: number | null) => void;
  togglePrsFolded: () => void;
  setPrConversation: (mode: WorkConversation) => void;
  setPrSearchOpen: (open: boolean) => void;
  setPrFile: (path: string | null) => void;
  setPrFileFilter: (text: string) => void;
  setPrDiffView: (view: PrDiffView) => void;
  /** Conversation, scrolled to `key` (`c-<url>`, `r-<url>`, `e-<ledger id>`); `everything` for a Hive event (HIVE-208). */
  focusPrEvent: (key: string, everything: boolean) => void;
  clearPrFocus: () => void;
  /**
   * The arrival stack is up over the pill (HIVE-198, HIVE-228): raised by a loud arrival or
   * the pill, down on ✕ or the drawer. It stays until one of those, never on a timer. Not persisted.
   */
  stackUp: boolean;
  /** The latest arrival that came in while the keyboard was in a terminal: the pill pulses once for it. */
  arrivalPulse: string | null;
  /** The Inbox drawer, and the ask thread (or {@link NEWS_SECTION}) it was opened on. */
  inboxDrawer: { open: boolean; thread: string | null };
  /**
   * A live arrival (HIVE-198; news is always quiet, HIVE-231). `quiet` (the keyboard is in a terminal) only pulses
   * the pill; otherwise it raises the stack. Nothing rises over an open drawer.
   */
  pushArrival: (id: string, quiet: boolean) => void;
  /** ✕ on a card: the stack folds into the pill. The rows stay in the Summons queue. */
  hideStack: () => void;
  /** The pill's count: show the whole queue as the stack, or hide it. */
  toggleStack: () => void;
  /** Open the drawer, on an ask's thread when one is named, hiding the stack. */
  openInboxDrawer: (thread?: string) => void;
  closeInboxDrawer: () => void;
  /**
   * Ask threads this window answered (HIVE-218), so a leaving card names another device only
   * when it was another device. View state, not persisted. ponytail: never trimmed; one id per
   * human answer.
   */
  answeredHere: ReadonlySet<string>;
  markAnsweredHere: (thread: string) => void;
  /** When this window last lost focus, else when it launched (HIVE-200's "since"). View state, not persisted. */
  awaySince: number;
  markAway: (at: number) => void;
  reset: () => void;
}

/**
 * The drawer's New section, as the `thread` it opens on (HIVE-231): the pill's
 * `N new` sends focus there. Ask threads are ledger ids, so this never names one.
 */
export const NEWS_SECTION = '#news';

const initialUiState = {
  activeTab: 'orch' as 'orch' | string,
  selId: null as string | null,
  prSearchTerm: '',
  prSearchAllRepos: false,
  explorerSearchTerm: '',
  explorerSearchMode: 'name' as FsSearchMode,
  workSearchTerm: '',
  workSearchMineOnly: false,
  picker: false,
  pickerQuery: '',
  pickerTicket: null as string | null,
  settings: false,
  whatsNewOpen: false,
  /**
   * Which pane the *next* open should land on, or `null` for the default.
   *
   * Set by `openSettings('agents')` and cleared by a bare `openSettings()`,
   * so the rule below still holds for every route that does not name a pane.
   */
  settingsSection: null as SettingsSection | null,
  newModel: 'opus' as Model,
  newEffort: 'high' as Effort,
  place: 'home' as Place,
  sessionsTab: 'orch' as 'orch' | string,
  panelOpen: true,
  narrow: false,
  sessionsProject: null as string | null,
  sessionsFilter: 'all' as TableFilter,
  endedExpanded: false,
  consoleShown: false,
  expanded: {} as Record<string, boolean>,
  explorerExpanded: {} as Record<string, boolean>,
  fsRevision: 0,
  workTicket: null as string | null,
  workTicketAt: -1,
  workFolded: { todo: false, 'in-progress': false, done: true } as Record<JiraStatusCategory, boolean>,
  workConversation: 'comments' as WorkConversation,
  agentsFolded: { summons: false, morphing: false, burrowed: false } as Record<AgentGroupKey, boolean>,
  agentPage: null as AgentPage | null,
  agentPageAt: -1,
  prPage: null as PrPageRef | null,
  prPageAt: -1,
  prTab: 'conversation' as PrTab,
  prRun: null as string | null,
  prJob: null as number | null,
  prsFolded: true,
  prConversation: 'comments' as WorkConversation,
  prSearchOpen: false,
  prFile: null as string | null,
  prFileFilter: '',
  prDiffView: 'unified' as PrDiffView,
  prFocus: null as string | null,
  stackUp: false,
  arrivalPulse: null as string | null,
  inboxDrawer: { open: false, thread: null } as { open: boolean; thread: string | null },
  answeredHere: new Set<string>() as ReadonlySet<string>,
  awaySince: Date.now(),
};

/** Back to the Overmind with the row left behind under the caret (HIVE-197). */
const returnToOrch = (state: UiState) => ({
  activeTab: 'orch' as const,
  sessionsTab: 'orch' as const,
  picker: false,
  settings: false,
  ...(state.activeTab === 'orch' ? {} : { selId: state.activeTab }),
});

/** One PR, whatever case its owner and repo were written in. */
const samePr = (a: PrPageRef, b: PrPageRef): boolean =>
  a.n === b.n && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

/** A PR page shown afresh: Comments, and nothing of the last PR's push, job, file or focus. */
const freshPr = (ref: PrPageRef, at: number) => ({
  prPage: ref,
  prPageAt: at,
  prConversation: 'comments' as const,
  prRun: null,
  prJob: null,
  prFile: null,
  prFileFilter: '',
  prFocus: null,
});

/** A row pick: the panel stays as it is when wide, and a narrow overlay closes on it (HIVE-211). */
const pickPanel = (state: UiState, open: boolean) =>
  state.narrow ? { panelOpen: false } : open ? { panelOpen: true } : {};

export const useUiStore = create<UiState>()((set) => ({
  ...initialUiState,

  // Opening a tab always dismisses the picker: the user has made their choice.
  // Settings goes with it (story 101) — the panels stay visible behind the
  // overlay, so a panel click that left settings up would look broken.
  openTab: (id, place) =>
    set((state) => ({
      activeTab: id,
      picker: false,
      settings: false,
      ...(place ? { place, ...pickPanel(state, false) } : {}),
      // What the Sessions place returns to: a tab opened there.
      ...((place ?? state.place) === 'sessions' ? { sessionsTab: id } : {}),
      // An agent opened through `openEntity` lands on its page's Activity (HIVE-204).
      ...(place === 'agents'
        ? { agentPage: { name: id, view: 'activity' as const }, agentPageAt: -1 }
        : {}),
    })),

  /**
   * Return to the orchestrator — the ← pill on the session meta bar, and the
   * ArrowLeft binding story 060 adds.
   *
   * A named action rather than `openTab('orch')` at each call site: "go home"
   * is a distinct intent from "open this thing", and 060 needs something to
   * bind that reads as the former.
   *
   * Lands on Sessions in round two: the Overmind is that place's page (HIVE-195).
   * The caret lands on the session being left, and the Overmind's filters and
   * folds are kept, so the user comes back to the row they went in from (HIVE-197).
   */
  backToOrch: () => set((state) => ({ ...returnToOrch(state), place: 'sessions' })),

  selectPlace: (place, overmind = false) =>
    set((state) => {
      if (place !== state.place) {
        const moved = { place, panelOpen: true, picker: false, settings: false };
        if (place !== 'sessions') return moved;
        const tab = overmind ? 'orch' : state.sessionsTab;
        return { ...moved, activeTab: tab, sessionsTab: tab };
      }
      // Under settings or the picker, the place you are on is a way back to it, not a panel toggle.
      if (state.settings || state.picker) return { settings: false, picker: false };
      if (place === 'sessions' && state.activeTab !== 'orch') return returnToOrch(state);
      return { panelOpen: !state.panelOpen };
    }),

  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),

  setNarrow: (narrow) =>
    set((state) =>
      state.narrow === narrow ? state : { narrow, ...(narrow ? { panelOpen: false } : {}) },
    ),

  setSessionsProject: (id) =>
    set((state) =>
      id === null
        ? { sessionsProject: null, ...pickPanel(state, false) }
        : {
            sessionsProject: id,
            expanded: { ...state.expanded, [id]: true },
            ...pickPanel(state, false),
          },
    ),
  setSessionsFilter: (filter) => set({ sessionsFilter: filter }),
  expandEnded: () => set({ endedExpanded: true }),
  toggleConsole: () => set((state) => ({ consoleShown: !state.consoleShown })),
  toggleProjectFold: (id) =>
    set((state) => ({ expanded: { ...state.expanded, [id]: !state.expanded[id] } })),
  expandProject: (id) =>
    set((state) => (state.expanded[id] ? state : { expanded: { ...state.expanded, [id]: true } })),

  setSelId: (id) => set({ selId: id }),

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
   * It exists because the panels became clickable behind an overlay. Before
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
  setWhatsNewOpen: (open) => set(open ? { whatsNewOpen: true, settings: false } : { whatsNewOpen: false }),
  closeSettings: () => set({ settings: false, settingsSection: null }),
  clearSettingsSection: () => set({ settingsSection: null }),
  setPickerQuery: (query) => set({ pickerQuery: query }),

  setNewModel: (model) => set({ newModel: model }),
  setNewEffort: (effort) => set({ newEffort: effort }),

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

  openWorkTicket: (key) =>
    set((state) => ({
      workTicket: key,
      workTicketAt: -1,
      place: 'work',
      workConversation: 'comments',
      picker: false,
      settings: false,
      ...pickPanel(state, true),
    })),
  rememberWorkTicket: (key, at) =>
    set((state) =>
      state.workTicket === key
        ? state.workTicketAt === at
          ? state
          : { workTicketAt: at }
        : { workTicket: key, workTicketAt: at, workConversation: 'comments' },
    ),
  toggleWorkGroup: (category) =>
    set((state) => ({ workFolded: { ...state.workFolded, [category]: !state.workFolded[category] } })),
  toggleAgentGroup: (key) =>
    set((state) => ({ agentsFolded: { ...state.agentsFolded, [key]: !state.agentsFolded[key] } })),
  setWorkConversation: (mode) => set({ workConversation: mode }),
  openAgentPage: (name, view) =>
    set((state) => ({
      agentPage: { name, view },
      agentPageAt: -1,
      place: 'agents',
      picker: false,
      settings: false,
      // A new agent has no tab: leaving an agent's tab active would let resolveView show that agent's page
      // instead of the blank definition, and Save would overwrite it.
      activeTab: name ?? 'orch',
      ...pickPanel(state, true),
    })),
  rememberAgentPage: (name, at) =>
    set((state) =>
      state.agentPage?.name === name
        ? state.agentPageAt === at
          ? state
          : { agentPageAt: at }
        : { agentPage: { name, view: 'activity' }, agentPageAt: at },
    ),
  setAgentPageView: (view) =>
    set((state) => (state.agentPage === null ? {} : { agentPage: { ...state.agentPage, view } })),
  closeAgentPage: () => set({ agentPage: null }),
  openPrPage: (ref) =>
    set((state) => ({
      ...freshPr(ref, -1),
      place: 'prs',
      picker: false,
      settings: false,
      ...pickPanel(state, true),
    })),
  rememberPrPage: (ref, at) =>
    set((state) =>
      state.prPage !== null && samePr(state.prPage, ref)
        ? state.prPageAt === at
          ? state
          : { prPageAt: at }
        : freshPr(ref, at),
    ),
  setPrTab: (tab) => set({ prTab: tab }),
  showPrRun: (sha) => set({ prRun: sha, prJob: null }),
  showPrJob: (id) => set({ prJob: id }),
  openPrChecks: (jobId) => set({ prTab: 'checks', prRun: null, prJob: jobId }),
  togglePrsFolded: () => set((state) => ({ prsFolded: !state.prsFolded })),
  setPrConversation: (mode) => set({ prConversation: mode }),
  setPrSearchOpen: (open) => set({ prSearchOpen: open }),
  setPrFile: (path) => set({ prFile: path }),
  setPrFileFilter: (text) => set({ prFileFilter: text }),
  setPrDiffView: (view) => set({ prDiffView: view }),
  focusPrEvent: (key, everything) =>
    set((state) => ({ prTab: 'conversation', prFocus: key, prConversation: everything ? 'everything' : state.prConversation })),
  clearPrFocus: () => set({ prFocus: null }),
  pushArrival: (id, quiet) =>
    set((state) => {
      if (quiet) return { arrivalPulse: id };
      return state.inboxDrawer.open ? {} : { stackUp: true };
    }),
  hideStack: () => set({ stackUp: false }),
  toggleStack: () => set((state) => ({ stackUp: !state.stackUp })),
  openInboxDrawer: (thread) => set({ inboxDrawer: { open: true, thread: thread ?? null }, stackUp: false }),
  closeInboxDrawer: () => set({ inboxDrawer: { open: false, thread: null } }),
  markAnsweredHere: (thread) =>
    set((state) => (state.answeredHere.has(thread) ? {} : { answeredHere: new Set([...state.answeredHere, thread]) })),
  markAway: (at) => set({ awaySince: at }),
  reset: () => set({ ...initialUiState, answeredHere: new Set<string>() }),
}));

/**
 * Selector hooks — the incorpx rule.
 *
 * Components never read the store object directly and never call `getState()`.
 * Every consumer goes through a named hook so a change to one slice of state
 * cannot re-render everything subscribed to the store.
 */
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

const inboxActionsSelector = (state: UiState) => ({
  pushArrival: state.pushArrival,
  hideStack: state.hideStack,
  toggleStack: state.toggleStack,
  openInboxDrawer: state.openInboxDrawer,
  closeInboxDrawer: state.closeInboxDrawer,
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

/** Which tab the center stage is showing. */
export const useActiveTab = () => useUiStore((state) => state.activeTab);

/** Open a tab (entity id, or `'orch'`). */
export const useOpenTab = () => useUiStore((state) => state.openTab);

/** Return to the orchestrator view (story 040's ← pill, story 060's ArrowLeft). */
export const useBackToOrch = () => useUiStore((state) => state.backToOrch);
/** The round-two place, and whether its panel shows (HIVE-195). */
export const usePlace = () => useUiStore((state) => state.place);
export const useSessionsTab = () => useUiStore((state) => state.sessionsTab);
export const usePanelOpen = () => useUiStore((state) => state.panelOpen);
export const useSelectPlace = () => useUiStore((state) => state.selectPlace);
export const useTogglePanel = () => useUiStore((state) => state.togglePanel);
export const useNarrow = () => useUiStore((state) => state.narrow);
export const useSetNarrow = () => useUiStore((state) => state.setNarrow);
/** The Work place's open ticket, folds and conversation filter (HIVE-203). */
export const useWorkTicket = () => useUiStore((state) => state.workTicket);
export const useWorkTicketAt = () => useUiStore((state) => state.workTicketAt);
export const useRememberWorkTicket = () => useUiStore((state) => state.rememberWorkTicket);
export const useWorkFolded = () => useUiStore((state) => state.workFolded);
export const useWorkConversation = () => useUiStore((state) => state.workConversation);
export const useOpenWorkTicket = () => useUiStore((state) => state.openWorkTicket);
export const useToggleWorkGroup = () => useUiStore((state) => state.toggleWorkGroup);
export const useSetWorkConversation = () => useUiStore((state) => state.setWorkConversation);
/** The Agents panel's lane folds (HIVE-204). */
export const useAgentsFolded = () => useUiStore((state) => state.agentsFolded);
export const useToggleAgentGroup = () => useUiStore((state) => state.toggleAgentGroup);
/** The Agents place's open page and its actions (HIVE-204). */
export const useAgentPage = () => useUiStore((state) => state.agentPage);
export const useAgentPageAt = () => useUiStore((state) => state.agentPageAt);
export const useRememberAgentPage = () => useUiStore((state) => state.rememberAgentPage);
export const useAgentPageActions = () =>
  useUiStore(
    useShallow((state) => ({
      openAgentPage: state.openAgentPage,
      setAgentPageView: state.setAgentPageView,
      closeAgentPage: state.closeAgentPage,
    })),
  );

/** The PRs place's open PR, tab, fold, filter and search (HIVE-205). */
export const usePrPage = () => useUiStore((state) => state.prPage);
export const usePrPageAt = () => useUiStore((state) => state.prPageAt);
export const useRememberPrPage = () => useUiStore((state) => state.rememberPrPage);
export const usePrTab = () => useUiStore((state) => state.prTab);
/** The Checks tab's shown push and clicked job (HIVE-206). */
export const usePrRun = () => useUiStore((state) => state.prRun);
export const usePrJob = () => useUiStore((state) => state.prJob);
export const usePrsFolded = () => useUiStore((state) => state.prsFolded);
export const usePrConversation = () => useUiStore((state) => state.prConversation);
export const usePrSearchOpen = () => useUiStore((state) => state.prSearchOpen);
/** The Files tab's selected path, filter and Unified | Split (HIVE-207). */
export const usePrFile = () => useUiStore((state) => state.prFile);
export const usePrFileFilter = () => useUiStore((state) => state.prFileFilter);
export const usePrDiffView = () => useUiStore((state) => state.prDiffView);
/** The Conversation item the Timeline clicked through to (HIVE-208). */
export const usePrFocus = () => useUiStore((state) => state.prFocus);
export const usePrPageActions = () =>
  useUiStore(
    useShallow((state) => ({
      openPrPage: state.openPrPage,
      setPrTab: state.setPrTab,
      showPrRun: state.showPrRun,
      showPrJob: state.showPrJob,
      openPrChecks: state.openPrChecks,
      togglePrsFolded: state.togglePrsFolded,
      setPrConversation: state.setPrConversation,
      setPrSearchOpen: state.setPrSearchOpen,
      setPrFile: state.setPrFile,
      setPrFileFilter: state.setPrFileFilter,
      setPrDiffView: state.setPrDiffView,
      focusPrEvent: state.focusPrEvent,
      clearPrFocus: state.clearPrFocus,
    })),
  );

const fleetViewSelector = (state: UiState) => ({
  project: state.sessionsProject,
  filter: state.sessionsFilter,
  endedAll: state.endedExpanded,
});
/** What the Overmind table shows: one shallow object, read by the table and the caret alike. */
export const useFleetView = () => useUiStore(useShallow(fleetViewSelector));
/** The Sessions place's filter and folds (HIVE-197). */
export const useSessionsProject = () => useUiStore((state) => state.sessionsProject);
export const useSetSessionsProject = () => useUiStore((state) => state.setSessionsProject);
export const useSessionsFilter = () => useUiStore((state) => state.sessionsFilter);
export const useSetSessionsFilter = () => useUiStore((state) => state.setSessionsFilter);
export const useExpandEnded = () => useUiStore((state) => state.expandEnded);
/** The dock's transcript, shown or folded (HIVE-197). */
export const useConsoleShown = () => useUiStore((state) => state.consoleShown);
export const useToggleConsole = () => useUiStore((state) => state.toggleConsole);
/** Per row, so one fold re-renders one row. */
export const useProjectExpanded = (id: string) => useUiStore((state) => Boolean(state.expanded[id]));
export const useToggleProjectFold = () => useUiStore((state) => state.toggleProjectFold);

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
/** The picker or Settings covers the stage: What's new waits for both to close. */
export const useOverlayOpen = () => useUiStore((state) => state.picker || state.settings);
/** Whether the What's new card is up, and its one setter. */
export const useWhatsNewOpen = () => useUiStore((state) => state.whatsNewOpen);
export const useSetWhatsNewOpen = () => useUiStore((state) => state.setWhatsNewOpen);

/** Whether the arrival stack is up over the pill (HIVE-228). */
export const useStackUp = () => useUiStore((state) => state.stackUp);

/** The latest quiet arrival, which the pill pulses once for. */
export const useArrivalPulse = () => useUiStore((state) => state.arrivalPulse);

/** The Inbox drawer: open, and the thread it was opened on. */
export const useInboxDrawer = () => useUiStore((state) => state.inboxDrawer);
/** Did this window answer `thread`? (HIVE-218) */
export const useAnsweredHere = (thread: string) => useUiStore((state) => state.answeredHere.has(thread));
export const useMarkAnsweredHere = () => useUiStore((state) => state.markAnsweredHere);

/** Inbox arrival and drawer actions, referentially stable. */
export const useInboxActions = () => useUiStore(useShallow(inboxActionsSelector));

/** Settings actions, referentially stable across unrelated state changes. */
export const useSettingsActions = () =>
  useUiStore(useShallow(settingsActionsSelector));

/**
 * The pane the overlay should navigate to, or `null` for none outstanding.
 *
 * A **request**, not a current-pane mirror. The overlay is `modal={false}` so
 * the panels stay clickable underneath it, which means `openSettings('agents')`
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
 * Per row: subscribing the whole tree to the expansion map would re-render
 * every visible row each time any one of them opened.
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



/** Home's "since" (HIVE-200). */
export const useAwaySince = () => useUiStore((state) => state.awaySince);
export const useMarkAway = () => useUiStore((state) => state.markAway);
