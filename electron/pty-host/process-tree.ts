import { execFile } from 'node:child_process';

/**
 * Reading and signalling the process tree (HIVE-72).
 *
 * The only module that reads the process table.
 *
 * It exists because `kill(-shellPid)` reaches exactly one process *group*, and
 * the session shell is `/bin/sh -l` on a real pty — interactive, so job
 * control is on, so `&` puts the backgrounded job in a group of its own. The
 * group kill structurally cannot reach the thing this app most needs dead: a
 * `claude` that outlives the window is invisible, keeps consuming tokens, and
 * can still write to the repository.
 */

/** A live descendant of a session shell, with the group it belongs to. */
export interface Descendant {
  pid: number;
  pgid: number;
}

export interface ProcessControl {
  /** Signal a process group. */
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
  /** Signal a single process. */
  signalPid(pid: number, signal: NodeJS.Signals): void;
  /** Whether a pid is still around. */
  isAlive(pid: number): boolean;
  /** Every descendant of every root. Resolves empty when unreadable. */
  descendants(roots: readonly number[]): Promise<Descendant[]>;
}

/**
 * How long `ps` gets before teardown gives up on knowing the tree.
 *
 * Deliberately short. This runs on the app's quit path, inside a budget the
 * supervisor enforces with a force-kill, and a `ps` still running after half a
 * second is not going to produce an answer that arrives in time to be useful.
 * Giving up early leaves budget for the signals, which are the part that
 * actually kills anything.
 */
export const PS_TIMEOUT_MS = 500;

/**
 * The lowest pid or pgid worth signalling.
 *
 * `process.kill(-0, sig)` is `kill(0, sig)` — *every process in the caller's
 * own group*, i.e. the pty-host shooting itself. `kill(-1, sig)` is every
 * process the user can signal. Neither can come from a well-formed `ps` on a
 * real session, but the cost of being wrong is the user's whole login, so the
 * table is filtered rather than trusted. pid 1 is init/launchd; nothing below
 * that is ever a session descendant.
 */
const LOWEST_SIGNALLABLE = 2;

/** Room for a very busy machine — a truncated table reads as a short one. */
const PS_MAX_BUFFER = 4 * 1024 * 1024;

interface Row {
  pid: number;
  ppid: number;
  pgid: number;
}

/** Parse `ps -eo pid=,ppid=,pgid=` — three padded numeric columns, no header. */
export function parseProcessTable(text: string): Row[] {
  const rows: Row[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length !== 3) continue;

    const [pid, ppid, pgid] = parts.map(Number);
    if (
      !Number.isInteger(pid) ||
      !Number.isInteger(ppid) ||
      !Number.isInteger(pgid)
    ) {
      continue;
    }

    /**
     * `ppid` is left alone — 0 and 1 are ordinary there, and a row whose parent
     * is init is exactly how the tree terminates. `pid` and `pgid` are what get
     * signalled, and a 0 among them would signal the caller's own group.
     * Linux reports pgid 0 for kernel threads, so this is not hypothetical.
     */
    if (pid < LOWEST_SIGNALLABLE || pgid < LOWEST_SIGNALLABLE) continue;

    rows.push({ pid, ppid, pgid });
  }

  return rows;
}

/** Every descendant of `roots`, breadth-first, roots excluded. */
export function walkDescendants(
  rows: readonly Row[],
  roots: readonly number[],
): Descendant[] {
  const children = new Map<number, Row[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }

  /**
   * Seeded with the roots, which does two jobs: a root that is itself a
   * descendant of another root is not reported, and a `ppid` cycle cannot loop
   * here forever. No sane kernel produces a cycle — but a parser that *can*
   * hang has no business on the app's quit path.
   */
  const seen = new Set<number>(roots);
  const queue = [...roots];
  const found: Descendant[] = [];

  while (queue.length > 0) {
    const pid = queue.shift()!;

    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push({ pid: child.pid, pgid: child.pgid });
      queue.push(child.pid);
    }
  }

  return found;
}

/** Read the table, answering `''` for any failure at all. */
function readProcessTable(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      // Pinned rather than resolved through PATH: this runs with the app's
      // inherited environment, and the result is fed straight into `kill`.
      '/bin/ps',
      ['-eo', 'pid=,ppid=,pgid='],
      { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER },
      (error, stdout) => {
        resolve(error ? '' : stdout);
      },
    );
  });
}

export interface ProcessControlDeps {
  /** Injected so tests never exec a real `ps`. */
  readTable?: () => Promise<string>;
  platform?: NodeJS.Platform;
}

export function createProcessControl({
  readTable = readProcessTable,
  platform = process.platform,
}: ProcessControlDeps = {}): ProcessControl {
  return {
    signalGroup(pgid, signal) {
      // Belt and braces: the parser already drops these, and this is the call
      // where getting it wrong SIGKILLs the pty-host's own process group.
      if (!Number.isInteger(pgid) || pgid < LOWEST_SIGNALLABLE) return;

      // Negative pid means "the process group led by pgid".
      process.kill(-pgid, signal);
    },

    signalPid(pid, signal) {
      if (!Number.isInteger(pid) || pid < LOWEST_SIGNALLABLE) return;

      process.kill(pid, signal);
    },

    isAlive(pid) {
      try {
        // Signal 0 asks the question without delivering anything.
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },

    async descendants(roots) {
      if (roots.length === 0) return [];

      // No Windows build is packaged (`electron/main/config/probe.ts`); this is
      // about not shelling out to a `ps` that does not exist.
      if (platform === 'win32') return [];

      const table = await readTable();
      if (table === '') return [];

      return walkDescendants(parseProcessTable(table), roots);
    },
  };
}

/** The real one. Injected over in every test. */
export const processControl: ProcessControl = createProcessControl();
