import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Telling a `/rename` apart from Claude's own auto-title (first-prompt naming).
 *
 * ## The problem this exists for
 *
 * Both reach the Hive as an OSC 0 terminal title and are **identical on that
 * channel** — `createTitleReader` sees `ESC ] 0 ; ✳ <name> BEL` either way. But
 * they deserve opposite treatment:
 *
 * - A `/rename` is a person saying, just now, what this session is called. It
 *   must win against anything.
 * - An `ai-title` is Claude's guess, and it is measurably a guess about the
 *   *wrong moment*: Claude writes exactly one per conversation, at an arbitrary
 *   point, from whatever the conversation had drifted to. Across this project's
 *   own transcripts it lands at line 170 of 2054, 740 of 1408, 1226 of 2613,
 *   1441 of 1445. That is where `HIVE-123-pr-157-merge-check` came from: the
 *   session was opened for HIVE-123 and titled after a merge check it happened
 *   to be doing when Claude got round to naming it.
 *
 * ## Why the transcript is the right place to look
 *
 * Claude records the distinction itself, and nothing else does:
 *
 * ```
 * {"type":"custom-title","customTitle":"HIVE-104","sessionId":"…"}
 * {"type":"ai-title","aiTitle":"github token debug","sessionId":"…"}
 * ```
 *
 * The path is deterministic because `bootstrap.ts` pins the conversation's uuid
 * at spawn rather than letting Claude mint one — its comment names reading these
 * two records back as the reason. So this is the use that pinning was for.
 *
 * ## Why it reads the tail, and why that is enough
 *
 * A transcript runs to megabytes, and reading one per title repaint would put a
 * multi-megabyte read on the pty data path several times a second. It reads a
 * bounded tail instead, which is sound because of *when* it is called: a title
 * only needs classifying at the instant it changed, and the record of that
 * change is the thing Claude has just appended. The line being looked for is
 * always near the end of the file at the only moment anyone asks.
 *
 * ## What guards this against Claude Code changing its mind
 *
 * These two records are someone else's private format, so a release that renames
 * or drops them would make `classify` answer `unknown` forever and silently
 * report every title as `agent` — the feature defeated with nothing to see.
 *
 * `tests/live/title-conformance.test.ts` is the guard, and it already was one
 * before this module existed: it asserts, against a real `claude`, that an
 * unnamed session reaches an `ai-title` and that a named one writes a
 * `custom-title`. Both assertions are exactly the shapes read here, so a format
 * change fails `pnpm test:title` rather than going unnoticed.
 *
 * ## Why "unknown" is a real answer
 *
 * The OSC repaint and the transcript append are not ordered with respect to each
 * other, so a title can arrive a few milliseconds before the line explaining it.
 * Guessing there would be permanent — the caller caches — so this reports
 * `unknown` instead, and `sessions/index.ts` declines to cache that and asks
 * again on the next repaint. The ambiguity resolves itself within a frame or two
 * without a timer anywhere.
 */

/** What wrote a title, as far as the transcript can say. */
export type TitleVerdict =
  /** A `custom-title` record carries exactly this name — the user renamed. */
  | 'rename'
  /** An `ai-title` record carries exactly this name — Claude guessed. */
  | 'agent'
  /** No record for this name yet: not written, not readable, not there. */
  | 'unknown';

/**
 * How much of the end of a transcript is read.
 *
 * Generous next to the handful of lines that can separate a title record from
 * the end of the file at the moment it is written, and small enough that doing
 * it on the pty path is unremarkable.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * Claude's directory name for a working directory.
 *
 * Every character that is not alphanumeric becomes `-`, which is why
 * `/Users/me/.claude/jobs/x` is `-Users-me--claude-jobs-x` — the `.` collapses
 * into the separator and leaves the doubled dash. Derived from the real
 * directory names on disk rather than from documentation.
 */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The transcript for one conversation, or `null` if it cannot be found.
 *
 * ## Why the computed name is not trusted on its own
 *
 * {@link claudeProjectDir} is this repository's reconstruction of *someone
 * else's* encoding, and it can miss without being wrong. The sharpest case is a
 * path that is not the path it says: on macOS a directory under `/var/folders`
 * really lives at `/private/var/folders`, and Claude records whichever spelling
 * its own process resolved. `tests/live/title-conformance.test.ts` hit exactly
 * that and stopped rebuilding the name for it.
 *
 * A miss here is not cosmetic — it reports `unknown`, which the caller reads as
 * "Claude's guess", so a `/rename` in a session whose path contains a symlink
 * would be silently ignored. That is the one failure this whole module exists to
 * prevent, so it is worth a directory listing to avoid.
 *
 * So: the computed name first, because it is one `stat` and right nearly always;
 * a scan for the uuid second, which survives any future change to the escaping —
 * a uuid is unique across every project, so finding one is unambiguous.
 */
function transcriptPath(home: string, cwd: string, sessionUuid: string): string | null {
  const projects = join(home, '.claude', 'projects');
  const file = `${sessionUuid}.jsonl`;

  const computed = join(projects, claudeProjectDir(cwd), file);
  if (existsSync(computed)) return computed;

  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, file);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* No projects directory at all — the same answer as no transcript. */
  }

  return null;
}

export interface TitleOriginReader {
  /**
   * What wrote `name` in the conversation `sessionUuid` names, started in `cwd`.
   *
   * Never throws. Every failure — no such file, a directory that moved, a
   * truncated write, a line that is not JSON — is `unknown`, which the caller
   * treats as "ask again later" rather than as a verdict.
   */
  classify(cwd: string, sessionUuid: string, name: string): TitleVerdict;
}

export interface TitleOriginOptions {
  /** Overridable for tests; defaults to the real home directory. */
  home?: string;
  /** Overridable for tests; defaults to {@link TAIL_BYTES}. */
  tailBytes?: number;
}

/**
 * Read the tail of a file as text, or `null` if it cannot be read at all.
 *
 * The first line of a tail that did not start at byte 0 is dropped: the read
 * begins mid-line by construction, and a half-line of JSON is not a record.
 */
function readTail(path: string, tailBytes: number): string[] | null {
  let fd: number | undefined;

  try {
    const { size } = statSync(path);
    const start = size > tailBytes ? size - tailBytes : 0;
    const length = size - start;
    if (length === 0) return [];

    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(path, 'r');
    const read = readSync(fd, buffer, 0, length, start);

    const lines = buffer.toString('utf8', 0, read).split('\n');
    return start === 0 ? lines : lines.slice(1);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Closing a descriptor that failed to open is not an error worth having. */
      }
    }
  }
}

/**
 * One title record, or `null` for a line that is not one.
 *
 * Tested with `includes` before `JSON.parse` because the overwhelming majority
 * of lines in a transcript are multi-kilobyte assistant turns, and parsing every
 * one of them to discover it is not a title would make the tail read the cheap
 * half of this function.
 */
function titleRecord(line: string): { origin: TitleVerdict; title: string } | null {
  if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) return null;

  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const record = parsed as { type?: unknown; customTitle?: unknown; aiTitle?: unknown };

    if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
      return { origin: 'rename', title: record.customTitle };
    }
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
      return { origin: 'agent', title: record.aiTitle };
    }
    return null;
  } catch {
    return null;
  }
}

export function createTitleOriginReader(options: TitleOriginOptions = {}): TitleOriginReader {
  const { home = homedir(), tailBytes = TAIL_BYTES } = options;

  return {
    classify(cwd, sessionUuid, name) {
      const path = transcriptPath(home, cwd, sessionUuid);
      if (path === null) return 'unknown';

      const lines = readTail(path, tailBytes);
      if (lines === null) return 'unknown';

      /*
        Backwards, and matched **by value** rather than by "newest title record
        wins". A session can hold both records — one renamed after Claude had
        already titled it — and the question being asked is not "what is this
        session called" but "what wrote *this* name". Value matching answers that
        without depending on the order two independent writers appended in.
      */
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const record = titleRecord(lines[i]);
        if (record !== null && record.title === name) return record.origin;
      }

      return 'unknown';
    },
  };
}
