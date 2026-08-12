import type {
  AddProjectRequest,
  CommandDiagnostic,
  ConfigSnapshot,
  DiagnoseCommandRequest,
  ProjectStatus,
  RemoveProjectRequest,
  RenameProjectRequest,
  ReorderProjectsRequest,
  RepointProjectRequest,
  SetJiraRequest,
  SetNotificationsRequest,
  SetProjectRuntimeRequest,
  SetRuntimeRequest,
} from '@shared/config-contract';
import type {
  AppInfo,
  IntegrationsStatus,
  NotificationDeliveryStatus,
} from '@shared/ipc-contract';

/**
 * The workspace config, as the renderer sees it (story 090).
 *
 * A module with a subscription rather than a Zustand store, deliberately. The
 * two stores are split along "what the user is looking at" versus "what the
 * system knows" (`AGENTS.md`), and this is neither — it is a fact about the
 * *machine*, read once from main, never mutated here, and consumed by exactly
 * two surfaces. Putting it in `hive-store` would mean fixture data and
 * filesystem truth sharing one reducer, which is the confusion story 090's
 * scope discipline is trying to avoid.
 *
 * It lives in `src/lib/` so `src/config/runtime.ts` can consult it without
 * importing a store, and so the ESLint zones keep it out of reach of
 * `src/components/terminal/`.
 */

let snapshot: ConfigSnapshot | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  // Copied before iterating: a listener that unsubscribes during the emit is
  // the ordinary React teardown case, not an edge case.
  for (const listener of [...listeners]) listener();
}

/** `useSyncExternalStore`'s subscribe. Returns its own disposer. */
export function subscribeProjectConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The current snapshot, or `null` when there is none.
 *
 * `null` means one of two things and deliberately does not distinguish them:
 * the browser demo has no bridge to ask, and the desktop app has not finished
 * asking yet. Both should behave identically — see {@link projectAccess}.
 */
export function projectConfigSnapshot(): ConfigSnapshot | null {
  return snapshot;
}

async function read(
  fetch: (bridge: NonNullable<Window['hive']>) => Promise<ConfigSnapshot>,
): Promise<void> {
  const bridge = window.hive;
  // No bridge is the browser demo, not a failure. Story 083's rule: feature-
  // detect the bridge, never the user agent.
  if (!bridge) return;

  try {
    snapshot = await fetch(bridge);
  } catch (cause) {
    // Main never rejects a *read* — it returns a snapshot even for a malformed
    // file. A rejection here means the channel itself failed, which is not
    // something the user can fix by editing their config, so the surfaces stay
    // permissive rather than locking the app over a broken IPC hop.
    console.error('[hive] could not read the workspace config:', cause);
    snapshot = null;
  }
  emit();
}

/**
 * Run a mutating verb, keeping the last good snapshot if it is refused.
 *
 * Separate from {@link read} because the two failures mean opposite things. A
 * failed read is a broken channel, and story 090 decided that must leave the
 * app permissive rather than locked. A failed **write** says only that the
 * write did not happen — nothing on disk changed, so the snapshot the renderer
 * already holds is still exactly true.
 *
 * Clearing it here was a real bug: story 103's payload guards throw, and
 * `handle` does not catch, so a refused mutation rejects the invoke. That is
 * reachable without malice — a config holding two entries with the same id
 * renders two rows, and reordering posts a duplicate the guard refuses. The
 * settings list emptied, and `projectAccess` (permissive with no snapshot, by
 * design) reopened the spawn gate for every project until a reload.
 */
async function mutate(
  call: (bridge: NonNullable<Window['hive']>) => Promise<ConfigSnapshot>,
): Promise<void> {
  const bridge = window.hive;
  if (!bridge) return;

  try {
    snapshot = await call(bridge);
  } catch (cause) {
    console.error('[hive] the workspace config was not written:', cause);
  }
  emit();
}

/** Ask main for the config. Called once at startup. */
export const loadProjectConfig = (): Promise<void> =>
  read((bridge) => bridge.config.get());

/** Re-read the file the user just edited, without restarting the app. */
export const reloadProjectConfig = (): Promise<void> =>
  read((bridge) => bridge.config.reload());

/**
 * Add a directory the user chose (story 101).
 *
 * No reload follows. Every mutating verb returns the fresh snapshot, and
 * `mutate` installs it — which is the whole reason the contract is shaped that
 * way: the renderer can never render a list the write already invalidated.
 */
export const addProjectToConfig = (request: AddProjectRequest): Promise<void> =>
  mutate((bridge) => bridge.config.addProject(request));

/**
 * Change the top-level shell or agent command (story 104).
 *
 * Same `mutate` path as every other write: main returns the fresh snapshot and
 * it becomes what the UI renders, so there is no optimistic value here to
 * reconcile if the write is refused.
 */
export const setRuntimeConfig = (request: SetRuntimeRequest): Promise<void> =>
  mutate((bridge) => bridge.config.setRuntime(request));

/**
 * Change one project's overrides (story 104).
 *
 * `null` clears an override; an absent field is untouched. The distinction is
 * preserved all the way from the input to the file, which is what lets the UI
 * save the shell field without disturbing an env map it is not showing.
 */
export const setProjectRuntimeConfig = (
  request: SetProjectRuntimeRequest,
): Promise<void> =>
  mutate((bridge) => bridge.config.setProjectRuntime(request));

/**
 * Change which events raise an OS notification (story 106).
 *
 * The same `mutate` path as every other write. Only the classes named are
 * touched, so a section that saves one switch cannot restate another.
 */
export const setNotificationPrefs = (
  request: SetNotificationsRequest,
): Promise<void> => mutate((bridge) => bridge.config.setNotifications(request));

/**
 * Change the Jira site and account email (HIVE-67).
 *
 * Here rather than in `lib/jira.ts` because it writes the config file and
 * returns a `ConfigSnapshot`, so it needs this module's `mutate` to install the
 * fresh one — the same path every other settings write takes. The *token* lives
 * in `lib/jira.ts`, because it is not config and does not produce a snapshot.
 *
 * `null` clears a field; an absent field is untouched, so saving the site never
 * restates the email.
 */
export const setJiraConnection = (request: SetJiraRequest): Promise<void> =>
  mutate((bridge) => bridge.config.setJira(request));

/**
 * What this machine's `gh` looks like (story 106).
 *
 * Not routed through `mutate` — it writes nothing, so there is no snapshot to
 * install. Returns `null` with no bridge (the browser demo) or on a failed
 * channel, and the caller says so rather than rendering a fabricated verdict.
 */
export async function readIntegrationsStatus(): Promise<IntegrationsStatus | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.integrations.status();
  } catch (cause) {
    console.error('[hive] reading integrations status failed:', cause);
    return null;
  }
}

/**
 * Whether the OS is actually accepting desktop notifications.
 *
 * Deliberately **not** read off {@link readIntegrationsStatus}, which carries
 * the same two facts: that one executes `gh` to build the rest of its answer,
 * and this is the value the Notifications pane has to re-ask on a timer,
 * because a refusal is only knowable once a delivery has been attempted and
 * turned down. Polling the other verb would spawn a subprocess every few
 * seconds to read a variable.
 *
 * `null` with no bridge — the browser demo has no OS to ask, and the pane
 * renders its controls without a verdict rather than inventing one.
 */
export async function readNotificationDelivery(): Promise<NotificationDeliveryStatus | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.notifications.delivery();
  } catch (cause) {
    console.error('[hive] reading notification delivery status failed:', cause);
    return null;
  }
}

/**
 * Show the config file in the OS file manager (story 107).
 *
 * Not routed through `mutate`: it writes nothing and returns no snapshot, so
 * there is nothing to install. Silent with no bridge — the browser demo has no
 * file manager to open, and story 083's rule is to feature-detect the bridge
 * rather than the user agent.
 *
 * A failure is logged rather than surfaced. The only thing that can go wrong is
 * that the OS declined to open a window, and there is nothing the user could do
 * about that in this pane which the path printed above the button has not
 * already given them.
 */
export async function revealConfigFile(): Promise<void> {
  const bridge = window.hive;
  if (!bridge) return;

  try {
    await bridge.config.revealConfig();
  } catch (cause) {
    console.error('[hive] could not reveal the config file:', cause);
  }
}

/**
 * Put the config file back to the first-run template (story 107).
 *
 * Routed through `mutate` like every other write, which is what makes a refused
 * reset leave the last good snapshot in place rather than emptying the UI's
 * project list over a write that never happened — the bug story 103 fixed, and
 * the whole reason `mutate` exists separately from `read`.
 */
export const resetConfigToTemplate = (): Promise<void> =>
  mutate((bridge) => bridge.config.resetConfig());

/**
 * Versions, platform, log directory and PTY counters (story 107).
 *
 * Not routed through `mutate` — it writes nothing, so there is no snapshot to
 * install. `null` with no bridge (the browser demo) or on a failed channel, and
 * the caller says so rather than rendering fabricated version numbers: a
 * diagnostics pane that invented an answer would be worse than no pane.
 *
 * Asked on demand rather than subscribed to. `appInfo` is `invoke`-only and
 * there is no push channel for the counters, so the pane carries an explicit
 * refresh — see `advanced-section.tsx` for why polling was rejected.
 */
export async function readAppInfo(): Promise<AppInfo | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.appInfo();
  } catch (cause) {
    console.error('[hive] reading app info failed:', cause);
    return null;
  }
}

/**
 * Ask why the agent command was not found (story 104).
 *
 * Not routed through `mutate`: it writes nothing, so there is no snapshot to
 * install. Returns `null` when there is no bridge (the browser demo) or the
 * channel fails, and the caller renders nothing rather than a fake verdict —
 * a diagnostic that invented an answer would be worse than no diagnostic.
 */
export async function diagnoseAgentCommand(
  request: DiagnoseCommandRequest,
): Promise<CommandDiagnostic | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.config.diagnoseCommand(request);
  } catch (cause) {
    console.error('[hive] the command diagnostic failed:', cause);
    return null;
  }
}

/** Remove one entry by id (story 101). */
export const removeProjectFromConfig = (
  request: RemoveProjectRequest,
): Promise<void> => mutate((bridge) => bridge.config.removeProject(request));

/**
 * Change a project's display name (story 103).
 *
 * Routed through `mutate` like every other mutating verb, so the snapshot main
 * returns is the one the UI renders. There is deliberately no optimistic name
 * held here to reconcile — that is the whole reason the contract returns a
 * snapshot instead of a status.
 */
export const renameProjectInConfig = (
  request: RenameProjectRequest,
): Promise<void> => mutate((bridge) => bridge.config.renameProject(request));

/** Point a project at a folder that moved (story 103). */
export const repointProjectInConfig = (
  request: RepointProjectRequest,
): Promise<void> => mutate((bridge) => bridge.config.repointProject(request));

/**
 * Rewrite the project order (story 103).
 *
 * The whole ordering, because main refuses one that is not a permutation of the
 * file on disk — see {@link ReorderProjectsRequest}.
 */
export const reorderProjectsInConfig = (
  request: ReorderProjectsRequest,
): Promise<void> => mutate((bridge) => bridge.config.reorderProjects(request));

/**
 * Open the native directory dialog (story 101).
 *
 * Resolves `null` when the user cancelled *and* when there is no bridge — the
 * browser demo has no filesystem to offer, and story 083's rule is to
 * feature-detect the bridge rather than the user agent. The caller treats both
 * the same way: no path, no write.
 */
export const chooseProjectDirectory = async (): Promise<string | null> => {
  const bridge = window.hive;
  if (!bridge) return null;
  return bridge.config.chooseDirectory();
};

/**
 * Install a snapshot main pushed with an event (story 102).
 *
 * The mutating *verbs* return their snapshot and `mutate` installs it, which is
 * what stops the renderer rendering a list a write already invalidated. A clone
 * concludes on an **event** instead — it finishes long after the call that
 * started it returned — so its snapshot needs the same treatment, or the
 * project list stays exactly as stale as it would have been without the rule.
 */
export function installProjectConfig(next: ConfigSnapshot): void {
  snapshot = next;
  emit();
}

/** Test-only: drop the snapshot and every subscriber. */
export function resetProjectConfig(): void {
  snapshot = null;
  listeners.clear();
}

/** Test-only: install a snapshot without going through the bridge. */
export function setProjectConfigForTest(next: ConfigSnapshot | null): void {
  snapshot = next;
  emit();
}

/**
 * Why an entry is unusable, in words the person editing the file can act on.
 *
 * The status code itself is the reason — these only spell it out. `ok` has an
 * empty entry rather than being excluded from the map, so adding a status to
 * the union is a type error here rather than a silently blank tooltip.
 */
const STATUS_REASON: Record<ProjectStatus, string> = {
  ok: '',
  missing: 'the configured path does not exist',
  'not-a-directory': 'the configured path is not a directory',
  'not-absolute': 'the configured path is not absolute',
  'duplicate-id': 'this id is already claimed by an earlier entry',
};

export interface ProjectAccess {
  /** May a session be started in this project? */
  spawnable: boolean;
  /** Tooltip text explaining a refusal. `null` when spawnable. */
  reason: string | null;
  /**
   * The project is mapped but its entry is broken — amber, not muted.
   *
   * The distinction the user needs: *unmapped* is a thing they have not done
   * yet, *invalid* is a thing they did wrong. Painting both the same colour
   * makes a typo look like an unfinished setup.
   */
  invalid: boolean;
}

const SPAWNABLE: ProjectAccess = { spawnable: true, reason: null, invalid: false };

/**
 * Whether a session may be started in a project.
 *
 * **Permissive with no snapshot.** With no config loaded — the browser demo,
 * and the first frames of a desktop launch — every project is spawnable. Two
 * reasons, and they point the same way:
 *
 * - The browser build is a fixtures-only demo where "start a session" adds a
 *   fixture entity rather than a process (story 083). Gating it would remove
 *   the demo's main flow while protecting nothing, and would break five of the
 *   six Playwright web specs — which story 083 already names as the signal
 *   that the gate is wrong rather than the specs.
 * - On desktop, refusing until the async read lands would flash every project
 *   as unmapped for a frame or two on every launch.
 */
/**
 * A mapped project's absolute directory, or `null` (HIVE-78).
 *
 * The config already carries it — `resolve.ts` expands, absolutises and
 * `realpath`s every project path — and until now nothing in the renderer needed
 * it, because every filesystem verb names a `projectId` and lets main resolve
 * the rest. The explorer's worktree retarget is the first thing that has to
 * compare an absolute path to another absolute path, so it needs the value
 * rather than the id.
 *
 * **This does not become a way to read files by path.** It answers one
 * question — "is the session's cwd inside this project?" — and `fs-contract`'s
 * rule that no verb takes a path is untouched.
 *
 * `null` for an unknown project and for one whose `status` is not `ok`, which
 * are the same two cases `projectRoot()` refuses in main.
 */
export function projectPath(projectId: string): string | null {
  const entry = snapshot?.projects.find((project) => project.id === projectId);
  if (!entry || entry.status !== 'ok') return null;
  return entry.path;
}

export function projectAccess(projectId: string): ProjectAccess {
  const current = snapshot;
  if (!current) return SPAWNABLE;

  const entry = current.projects.find((project) => project.id === projectId);

  if (!entry) {
    return {
      spawnable: false,
      invalid: false,
      reason: `not mapped in ${current.configPath} — add it there to open a session in this project`,
    };
  }

  if (entry.status === 'ok') return SPAWNABLE;

  return {
    spawnable: false,
    invalid: true,
    reason: `${STATUS_REASON[entry.status]} (${entry.status}) — check ${current.configPath}`,
  };
}
