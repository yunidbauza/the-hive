import { probeCommand } from '../config/probe';
import { runAsync, type RunAsync } from '../integrations/github/run';

/**
 * Reading the branch a session is actually on (HIVE-77).
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
 * Two seconds. Long enough that a burst of hook events costs one spawn, short
 * enough that a user who runs `git checkout -b` and looks at the rail sees the
 * new branch by the time they have finished reading the sentence the agent
 * wrote about it.
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
   */
  read(cwd: string): Promise<string | null>;
  /** Drop everything remembered about a directory. Used when a session exits. */
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
   * Where `git` is.
   *
   * Resolved once, from `PATH`, exactly as `gh.ts` resolves `gh` and for the
   * reason it gives: the absolute path is what runs, never the bare name, which
   * closes the window in which `PATH` could resolve to something else between
   * the probe and the call.
   *
   * `null` means `git` was not found, and every read answers `null` without
   * attempting to spawn — a machine with no `git` is not an error state for a
   * terminal multiplexer.
   */
  gitPath?: string | null;
  /** Injected for tests; the wall clock otherwise. */
  now?: () => number;
  minIntervalMs?: number;
}

/** Resolve `git` on `PATH`, or `null`. */
export function resolveGit(env: NodeJS.ProcessEnv): string | null {
  return probeCommand('git', env.PATH ?? '').resolved;
}

export function createBranchReader(
  options: BranchReaderOptions = {},
): BranchReader {
  const {
    run = runAsync,
    gitPath = resolveGit(process.env),
    now = () => Date.now(),
    minIntervalMs = MIN_INTERVAL_MS,
  } = options;

  const cache = new Map<string, Entry>();

  async function spawnRead(cwd: string): Promise<string | null> {
    if (gitPath === null) return null;

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
      result = await run(gitPath, ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
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
    read(cwd) {
      const entry = cache.get(cwd);

      if (entry) {
        if (entry.pending !== null) return entry.pending;
        if (now() - entry.at < minIntervalMs) return Promise.resolve(entry.branch);
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
