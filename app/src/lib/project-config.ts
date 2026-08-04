import type {
  AddProjectRequest,
  ConfigSnapshot,
  ProjectStatus,
  RemoveProjectRequest,
} from '@shared/config-contract';

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
    // Main never rejects these — it returns a snapshot even for a malformed
    // file. A rejection here means the channel itself failed, which is not
    // something the user can fix by editing their config, so the surfaces stay
    // permissive rather than locking the app over a broken IPC hop.
    console.error('[hive] could not read the workspace config:', cause);
    snapshot = null;
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
 * `read` installs it — which is the whole reason the contract is shaped that
 * way: the renderer can never render a list the write already invalidated.
 */
export const addProjectToConfig = (request: AddProjectRequest): Promise<void> =>
  read((bridge) => bridge.config.addProject(request));

/** Remove one entry by id (story 101). */
export const removeProjectFromConfig = (
  request: RemoveProjectRequest,
): Promise<void> => read((bridge) => bridge.config.removeProject(request));

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
 * The mutating *verbs* return their snapshot and `read` installs it, which is
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
