import { probeCommand } from '../config/probe';
import { runAsync, type RunAsync } from '../integrations/github/run';

/**
 * Reading the branch a session is actually on (HIVE-78).
 *
 * ## Why main has to go and look
 *
 * `session:status` and `session:name` are *reported* — a hook says what the
 * agent is doing, a terminal title says what it calls itself. Nothing reports a
 * branch. So this is the one session fact main has to observe for itself, and
 * `docs/branch-sync-note.md` named the two things that needed solving before it
 * could: a live working directory, and a cadence.
 *
 * The first turned out to be free — every hook payload carries `cwd`, so there
 * is no need for the `lsof -a -p <pid> -d cwd` shape that note proposed. This
 * module is the second half: making the read cheap enough that a hook boundary
 * is a sensible place to do it.
 *
 * ## Why it is not a poller
 *
 * `integrations-section.tsx` already writes down the argument against polling
 * for `gh`, and it applies harder here: a fleet of thirteen sessions polled
 * every few seconds is a process spawn per session per tick, forever, to answer
 * a question whose answer changes maybe twice a day. Hook events are the natural
 * cadence — they fire when the agent does something, which is exactly when a
 * branch can have changed, and they stop when it does not.
 *
 * ## Why there is a cache and a debounce anyway
 *
 * `UserPromptSubmit`, `PermissionRequest` and `Stop` can arrive several times a
 * turn, and a large edit can bring a burst of them within a second. Without a
 * floor between reads, a busy session would spawn `git` dozens of times a minute
 * for an answer that has not changed. {@link MIN_INTERVAL_MS} is that floor;
 * the cache is what makes a repeat read free rather than merely cheap.
 */

/**
 * The shortest gap between two reads for the same directory.
 *
 * Two seconds, and it exists to collapse the burst of hook events **inside** a
 * turn — `UserPromptSubmit`, then a `PermissionRequest` or two — into one
 * `git` spawn.
 *
 * ## Why a turn boundary must be allowed through it
 *
 * A floor alone gets the important case exactly backwards. Suppose the agent
 * runs `git checkout -b feat/x` during a short turn:
 *
 * ```
 * t=0.0s  UserPromptSubmit -> reads, caches `main`
 * t=1.2s  Stop             -> inside the floor, returns cached `main`
 *         (no further hook until the user's next prompt)
 * ```
 *
 * The rail then shows `main` until the user types again — which may be minutes,
 * and is precisely the window in which they look at the rail to check what the
 * agent just did. The read was suppressed at the one moment the answer was most
 * likely to have changed.
 *
 * So `Stop` passes `fresh`. It is the *end of a turn*: rare by construction —
 * once per turn, not several — and the moment after which nothing else will
 * happen to trigger a read. Every other event still pays the floor.
 */
export const MIN_INTERVAL_MS = 2_000;

/**
 * How long a `git rev-parse` gets.
 *
 * Far shorter than the 20 s `runAsync` allows `gh`, because the two are not
 * comparable: `gh` is a network call and this is a stat of `.git/HEAD`. A
 * `rev-parse` that has not answered in three seconds is a wedged filesystem or
 * a lock nobody is going to release, and waiting longer only holds a timer open.
 */
export const READ_TIMEOUT_MS = 3_000;

/** What Git prints for a detached HEAD, which is not a branch name. */
const DETACHED = 'HEAD';

export interface BranchReader {
  /**
   * The branch checked out in `cwd`, or `null` when there is not one.
   *
   * `null` covers three genuinely different situations — not a work tree, a
   * detached HEAD, and `git` not being installed — and deliberately does not
   * distinguish them. Every one of them renders as the same em dash, and a
   * reason nobody displays is a field that goes stale unnoticed.
   *
   * `fresh` bypasses the rate limit — see {@link MIN_INTERVAL_MS} for why a
   * turn boundary has to.
   */
  read(cwd: string, fresh?: boolean): Promise<string | null>;
  /**
   * Drop everything remembered about a directory.
   *
   * Called from `settleExit` with the directory that session was last observed
   * in, which is what keeps this cache from being append-only for the life of
   * the app — an agent that works through several worktrees would otherwise
   * leave an entry per directory behind it forever.
   *
   * **Two sessions can share a directory**, and this does not reference-count
   * them. Forgetting one that another is still using costs a single extra `git`
   * spawn on that directory's next read, which is a better trade than the
   * bookkeeping: the cache is an optimisation, and a wrong *answer* is not
   * among the things dropping an entry can cause.
   */
  forget(cwd: string): void;
}

interface Entry {
  branch: string | null;
  at: number;
  /** In flight, so a burst shares one spawn rather than starting several. */
  pending: Promise<string | null> | null;
}

export interface BranchReaderOptions {
  /** Injected so tests answer without spawning anything. */
  run?: RunAsync;
  /**
   * Where `git` is, resolved on demand.
   *
   * The absolute path is what runs, never the bare name — `gh.ts`'s rule, for
   * its reason: it closes the window in which `PATH` could resolve to something
   * else between the probe and the call.
   *
   * **A callback rather than a string, and that is the fix for a real bug.**
   * This first shipped resolving `git` once, from the bare `process.env.PATH`,
   * at `createSessions()` time — but a GUI-launched Electron app on macOS gets
   * a minimal `PATH` that frequently has no `git` in it. That is the entire
   * reason `runtime.path` exists in the config, and it is what `gh` and
   * `claude` are already resolved against. Reading the bare environment once
   * meant a user who had configured their way around the problem still got
   * `null` from every branch read, for the life of the process, with no
   * diagnostic.
   *
   * Called at most once per successful resolution — see `gitPathOnce` — and
   * **re-tried while it answers `null`**, so fixing the config and reloading it
   * repairs branch reading without restarting the app.
   *
   * `null` means `git` is not reachable; every read then answers `null` without
   * attempting to spawn. A machine with no `git` is not an error state for a
   * terminal multiplexer.
   */
  gitPath?: () => string | null;
  /** Injected for tests; the wall clock otherwise. */
  now?: () => number;
  minIntervalMs?: number;
}

/**
 * Resolve `git` on a `PATH`, or `null`.
 *
 * Takes the environment rather than reading `process.env`, so the caller can
 * hand it the **config-augmented** one. See {@link BranchReaderOptions.gitPath}.
 */
export function resolveGit(env: NodeJS.ProcessEnv): string | null {
  return probeCommand('git', env.PATH ?? '').resolved;
}

export function createBranchReader(
  options: BranchReaderOptions = {},
): BranchReader {
  const {
    run = runAsync,
    gitPath = () => resolveGit(process.env),
    now = () => Date.now(),
    minIntervalMs = MIN_INTERVAL_MS,
  } = options;

  const cache = new Map<string, Entry>();

  /**
   * The resolved path, remembered once found.
   *
   * Asymmetric on purpose: a **successful** resolution is cached forever, and a
   * failure is not cached at all. Caching the failure is what would make a
   * config fix require an app restart, which is the bug this shape exists to
   * avoid; caching the success is what keeps a probe off the hot path.
   */
  let resolved: string | null = null;

  function gitPathOnce(): string | null {
    resolved ??= gitPath();
    return resolved;
  }

  async function spawnRead(cwd: string): Promise<string | null> {
    const git = gitPathOnce();
    if (git === null) return null;

    let result;
    try {
      /**
       * `--abbrev-ref HEAD` rather than `git branch --show-current`, which is
       * the more obvious spelling and the wrong one here: `--show-current`
       * prints an empty line for a detached HEAD, so "detached" and "the
       * command failed" become the same observation. `--abbrev-ref` prints the
       * literal `HEAD`, which is unambiguous.
       *
       * `-C <cwd>` rather than the `cwd` option, so that a directory which has
       * been deleted between the hook arriving and this running is Git's error
       * to report rather than a spawn failure with no output.
       */
      result = await run(git, ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        timeoutMs: READ_TIMEOUT_MS,
      });
    } catch {
      /**
       * The binary could not be executed at all. Not cached as a verdict — it
       * was on the `PATH` when this started, so this is a transient condition
       * rather than a fact about the directory.
       */
      return null;
    }

    if (result.code !== 0) return null;

    const branch = result.stdout.trim();
    if (branch === '' || branch === DETACHED) return null;

    /**
     * A branch name cannot contain a newline, so anything with one is not an
     * answer to this question — it is some other program's output arriving on
     * a hijacked stdout. Refused rather than truncated.
     */
    if (branch.includes('\n')) return null;

    return branch;
  }

  return {
    read(cwd, fresh = false) {
      const entry = cache.get(cwd);

      if (entry) {
        /**
         * An in-flight read is shared even by a `fresh` caller.
         *
         * `fresh` means "do not serve me a stale *cached* answer", not "start a
         * second process". A read already running was started microseconds ago
         * and is about to produce a current answer, so joining it is both
         * cheaper and no less fresh.
         */
        if (entry.pending !== null) return entry.pending;
        if (!fresh && now() - entry.at < minIntervalMs) {
          return Promise.resolve(entry.branch);
        }
      }

      const pending = spawnRead(cwd).then((branch) => {
        cache.set(cwd, { branch, at: now(), pending: null });
        return branch;
      });

      cache.set(cwd, {
        branch: entry?.branch ?? null,
        at: entry?.at ?? 0,
        pending,
      });

      return pending;
    },

    forget(cwd) {
      cache.delete(cwd);
    },
  };
}
