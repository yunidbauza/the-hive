import type { Entity } from '@/types/entity';

/**
 * What the center stage is showing. Exactly one at a time — that is the whole
 * point of naming the states.
 */
export type ViewState =
  | 'settings'
  | 'picker'
  | 'editor'
  | 'orchestrator'
  | 'session'
  | 'agent';

/** The orchestrator's reserved tab id. */
export const ORCH_TAB = 'orch';

export interface ViewInput {
  /** `'orch'`, or an entity id. */
  activeTab: string;
  /** Whether the new-session overlay is open. */
  picker: boolean;
  /** Whether the settings overlay is open (story 101). */
  settings: boolean;
  /** The entity behind `activeTab`, or null for the orchestrator. */
  entity: Entity | null;
  /**
   * A file is on screen **and** the editor is set to fill the stage.
   *
   * Deliberately one boolean rather than the two facts behind it. In `split`
   * placement the editor is not a view state at all — it is a layout of the
   * entity view, rendered beside the terminal under whatever view already
   * resolved. Passing `placement` in here would invite this function to return
   * `'editor'` for the split case, and `isEntityView` would then stop being
   * true for a stage that is still showing a session's meta bar.
   */
  editorFull: boolean;
}

/**
 * The center stage's view-state machine, as a pure function.
 *
 * Extracted from the component (story 040) so the four states can be tested
 * exhaustively without rendering anything — the component's whole job is to
 * render what this returns. A machine embedded in JSX conditionals is one that
 * gets a fifth state by accident.
 *
 * Precedence is deliberate and load-bearing:
 *
 * 1. **Settings wins over the picker** (story 101). The realistic route into
 *    settings *is* the picker discovering it has no projects to offer, and two
 *    stacked full-stage overlays is the result of not deciding this.
 * 2. **Picker wins over everything below it.** It is a full-stage overlay, and
 *    it deliberately does not change `activeTab` — closing it has to return the
 *    user to whatever they were looking at, which only works if the underlying
 *    tab is untouched. Settings follows the same rule for the same reason.
 * 3. **The editor sits below both overlays and above the entity views.** It is
 *    not an overlay — it has no scrim, no focus trap and no dismissal — but it
 *    does fill the stage, so a settings pane opened from behind it must win.
 *    Like the overlays it never touches `activeTab`: closing the last file has
 *    to return the user to the terminal they were watching.
 * 4. **The orchestrator is the floor.** An `activeTab` that names no entity
 *    resolves here rather than to a blank stage: a session can be removed while
 *    its tab is open, and stranding the user on nothing is worse than sending
 *    them home.
 */
export function resolveView({
  activeTab,
  picker,
  settings,
  entity,
  editorFull,
}: ViewInput): ViewState {
  if (settings) return 'settings';
  if (picker) return 'picker';
  if (editorFull) return 'editor';
  if (activeTab === ORCH_TAB) return 'orchestrator';
  if (!entity) return 'orchestrator';

  return entity.kind === 'agent' ? 'agent' : 'session';
}

/**
 * Whether the stage is about one entity, of either kind.
 *
 * The question "is the user already looking at this thing?" — which is what
 * the foreground gate (HIVE-81) suppresses notifications on. An agent view
 * answers it exactly as a session's terminal does, and the rule has nothing to
 * do with which kind of entity is on screen.
 */
export function isEntityView(view: ViewState): boolean {
  return view === 'session' || view === 'agent';
}

/**
 * Whether a view shows the **terminal** and its meta bar.
 *
 * Split from {@link isEntityView} by HIVE-116, because the two questions
 * stopped having the same answer. `'agent'` used to be an entity view *and* a
 * terminal one, which is what mounted a read-only xterm replaying the agent's
 * lines, a session meta bar, and a message row beneath it. An agent now has a
 * surface of its own, and a run log is not a terminal: nothing is typed into a
 * process, the input posts to the ledger, and the transcript is of turns that
 * have already ended.
 *
 * Widening this one again would put two places to type on one stage — the bug
 * the message row was removed from live sessions to avoid. Widening the other
 * is harmless; they are separate on purpose.
 */
export function isTerminalView(view: ViewState): boolean {
  return view === 'session';
}
