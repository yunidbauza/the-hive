#!/usr/bin/env node
/**
 * goal-on Stop verifier, The Hive's copy (HIVE-163). Ported from claude-kit's
 * workstream plugin with two changes: the brief lives in ~/.hive/goals, and every
 * status the floor writes is also posted to the Hive's ledger as a receipt.
 *
 * This script is the FLOOR under both harnesses: a plain Node process that reads the
 * brief with `readFileSync` and is therefore not permission-gated. It is the only
 * thing that writes brief state — `last_verified`, `turns_used`, `DONE`, `FAILED`.
 *
 * Claude Code additionally runs an `agent`-type Stop hook declared in goal-on's
 * SKILL.md frontmatter. That one is a semantic CEILING: an LLM judges whether the
 * recorded evidence actually supports the ticked Outcome items, and it may block on
 * that judgement — but it writes nothing. It reaches the brief through the Read tool,
 * which a bypass-permissions session denies, so it can vanish silently. That is
 * exactly why it may not own any state: when it disappears, this script is still
 * standing and the goal is still enforced.
 *
 * Mechanical, not semantic. It enforces the contract the brief already encodes:
 *   - every `## Outcome` item is ticked `- [x]`,
 *   - `## Verification evidence` actually contains something, and
 *   - for `route: code`, a real PR exists on the header's `branch`.
 * It does NOT judge whether prose evidence is convincing. That difference is
 * documented in the workstream README.
 *
 * Output shapes differ per harness and are NOT interchangeable, so the hook command
 * says which one it is (`--harness=claude`) rather than guessing from the payload:
 *   Copilot `agentStop`: {"decision":"allow"} | {"decision":"block","reason":"..."}
 *   Claude Code `Stop`:  {"decision":"block","reason":"..."} to block; silence to release.
 *
 * TWO FAILURE MODES ARE FORBIDDEN, and they pull in opposite directions:
 *   1. Wedging a session. Every unexpected condition must release the turn.
 *   2. Recording a FALSE SUCCESS. Failing open must never mean writing `DONE` to a
 *      brief we could not actually verify — that destroys the audit trail. So
 *      "cannot verify" releases the turn WITHOUT stamping DONE.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, renameSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TERMINAL = new Set([
  'PENDING-APPROVAL', // Phase 1 is waiting on the user — must be allowed to end
  'CLEARED',
  'DONE',
  'FAILED',
  'NEEDS-DECISION',
]);

/** Headings that legitimately end a section in a goal-on brief. */
const SIBLING_HEADINGS = ['Task', 'Scope', 'Constraints', 'Outcome', 'Stop Rules', 'Verification evidence'];

/** How long `gh` gets before the completion check gives up and fails open. */
const GH_TIMEOUT_MS = 10_000;

/**
 * Which harness is calling. Claude Code's `Stop` and Copilot's `agentStop` expect
 * different JSON, and the two payloads are too alike to tell apart reliably — a
 * misread would either wedge a session or silently release every turn. So the hook
 * command states it outright and the default stays Copilot, which is where this
 * script was born.
 */
export function harnessOf(argv = process.argv.slice(2)) {
  return argv.includes('--harness=claude') ? 'claude' : 'copilot';
}

export function emitFor(harness, decision, reason) {
  if (harness === 'claude') {
    // Claude Code blocks on `{"decision":"block"}` and releases on anything else.
    // The quietest way to release is to say nothing at all.
    return decision === 'block' ? JSON.stringify({ decision: 'block', reason }) : '';
  }
  return JSON.stringify(reason ? { decision, reason } : { decision });
}

function emit(decision, reason, harness = harnessOf()) {
  const out = emitFor(harness, decision, reason);
  if (out) process.stdout.write(out);
  // Set exitCode and return rather than process.exit(), which can drop buffered
  // stdout when it is a pipe.
  process.exitCode = 0;
}

/** Read the hook payload from stdin (or an explicit string, for tests). Never throws. */
export function readPayload(raw) {
  try {
    const text = raw ?? readFileSync(0, 'utf8');
    if (!text || !text.trim()) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Both naming conventions are valid; Copilot emits either. */
export function sessionIdOf(payload) {
  const id = payload?.sessionId || payload?.session_id || null;
  // The id becomes a filename. Reject anything that could escape the brief dir.
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') return null;
  return id;
}

export const briefDir = () => process.env.HIVE_GOALS_DIR || join(homedir(), '.hive', 'goals');

/** Split a brief into { header, body }. Returns null if there is no frontmatter. */
export function splitFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return null;
  return { header: m[1], body: m[2] };
}

export function headerValue(header, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(header);
  if (!m) return null;
  // Tolerate trailing `# comments` and quoted values — the brief template in
  // goal-on/SKILL.md demonstrates inline comments on header keys.
  return m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
}

/**
 * Locate the brief for a session.
 *
 * `<session-id>.md` is the documented name, but the file is written by a model, and
 * in practice the name drifts — `session_<id>.md`, a truncated id, an id with a slug
 * appended. Every one of those looks identical to "no goal-on session here", so the
 * verifier releases every turn and the whole skill quietly stops working. Resolution
 * is therefore three-tier: the documented name, the common `session_` variant, then a
 * scan for a brief whose header carries `session: <id>` — an identity that lives
 * INSIDE the file and survives any renaming. Newest wins if several match.
 */
export function resolveBrief(dir, sessionId) {
  for (const name of [`${sessionId}.md`, `session_${sessionId}.md`]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }

  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null; // no brief directory at all — not a goal-on machine yet
  }

  const want = new RegExp(`^session:[ \\t]*["']?${sessionId.replace(/[.]/g, '\\.')}["']?[ \\t]*$`, 'm');
  let best = null;
  let bestMtime = -Infinity;

  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const p = join(dir, name);
    try {
      const split = splitFrontmatter(readFileSync(p, 'utf8'));
      if (!split || !want.test(split.header)) continue;
      const mtime = statSync(p).mtimeMs;
      if (mtime > bestMtime) {
        best = p;
        bestMtime = mtime;
      }
    } catch {
      /* an unreadable neighbour must not stop the search */
    }
  }
  return best;
}

/**
 * Blank out `#` characters that sit inside fenced code blocks, preserving offsets.
 * Without this, a line like `## not a heading` inside a fence inside `## Outcome`
 * truncates the section and hides the unchecked items below it.
 */
function maskFences(text) {
  const out = text.split('');
  let inFence = false;
  const lines = [];
  let idx = 0;
  for (const line of text.split('\n')) {
    lines.push({ start: idx, line });
    idx += line.length + 1;
  }
  for (const { start, line } of lines) {
    if (/^[ \t]*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      for (let i = 0; i < line.length; i++) {
        if (out[start + i] === '#') out[start + i] = ' ';
      }
    }
  }
  return out.join('');
}

/**
 * Extract a `## Section` body, up to the next sibling `## ` heading or EOF.
 * NB: JavaScript has no `\Z`; end-of-string is `$(?![\s\S])` under the `m` flag.
 * Boundaries are found on a fence-masked copy, then sliced out of the original, so
 * fenced content (command output, examples) is returned intact.
 */
export function section(body, title) {
  const masked = maskFences(body);
  const startRe = new RegExp(`^##[ \\t]+${title}[ \\t]*$`, 'mi');
  const s = startRe.exec(masked);
  if (!s) return '';
  const from = s.index + s[0].length;
  const endRe = new RegExp(`^##[ \\t]+(?:${SIBLING_HEADINGS.join('|')})\\b`, 'gmi');
  endRe.lastIndex = from;
  const e = endRe.exec(masked);
  return body.slice(from, e ? e.index : body.length);
}

export function checkboxItems(outcome) {
  const all = outcome.match(/^[ \t]*[-*][ \t]*\[[ xX]\][ \t]*(.*)$/gm) || [];
  const unchecked = (outcome.match(/^[ \t]*[-*][ \t]*\[ \][ \t]*(.*)$/gm) || []).map((l) =>
    l.replace(/^[ \t]*[-*][ \t]*\[ \][ \t]*/, '').trim(),
  );
  return { total: all.length, unchecked };
}

/** Evidence is "present" only if it has real content beyond the placeholder. */
export function hasEvidence(evidence) {
  const stripped = evidence
    .replace(/^\s*\(appended during Phase 2\)\s*$/gim, '')
    .replace(/^\s*#+.*$/gm, '')
    .trim();
  return stripped.length > 0;
}

/**
 * Read a PR verdict out of `gh pr list --json ...` output.
 *
 * Deliberately NOT requiring `isDraft`. goal-on ends at "draft PR raised plus ship
 * handed off", and `ship`'s very first move is to mark the PR ready — so insisting on
 * a draft would fail the briefs that got furthest. An OPEN or already-MERGED PR on the
 * header's branch is the real proof that the code route reached its destination.
 *
 * `null` stdout means the command could not be run or trusted: that is 'unknown', and
 * 'unknown' never becomes DONE.
 */
export function prVerdict(branch, stdout) {
  if (!branch || /^TBD/i.test(branch)) return 'unknown';
  if (stdout == null) return 'unknown';
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return 'unknown';
  }
  if (!Array.isArray(rows)) return 'unknown';
  // ANY qualifying row is proof, not the first one that happens to match the branch.
  // A branch can carry several PRs — say a merged one and a later closed follow-up —
  // and picking whichever `find` lands on first would report 'mismatch' with a merged
  // PR sitting right there, blocking every turn until the budget is spent.
  return rows.some((r) => r?.headRefName === branch && (r.state === 'OPEN' || r.state === 'MERGED'))
    ? 'match'
    : 'mismatch';
}

/**
 * Is `branch` a ref in the repository at `dir`?
 *
 * The guard against answering about the wrong repository. `gh pr list` resolves its
 * repo from the working directory, so a session started in repo A whose work lives in
 * repo B gets a confident empty list — indistinguishable from "the PR was never
 * raised", which would block every turn and drive a finished brief to FAILED. The
 * branch ref is the cheap local tell: it exists in the repo the work happened in
 * (worktree branches share the ref namespace) and not in an unrelated one.
 */
export function hasBranchRef(dir, branch) {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Ask GitHub whether the brief's branch actually has a PR. Looked up by head branch
 * rather than by the checked-out branch, because `workspace: worktree` briefs are
 * verified from a session whose cwd is the shared checkout, sitting on main.
 */
export function ghPrCheck(header, cwd) {
  const branch = headerValue(header, 'branch');
  if (!branch || /^TBD/i.test(branch)) return 'unknown';

  // The brief may name the repo it actually worked in; the session cwd is the fallback.
  // Absolute directories only: a bare `repo: incorpx-server` slug would otherwise
  // resolve against cwd and quietly interrogate an unrelated checkout.
  let dir = cwd;
  for (const key of ['worktree', 'repo']) {
    const p = headerValue(header, key);
    try {
      if (p && isAbsolute(p) && statSync(p).isDirectory()) {
        dir = p;
        break;
      }
    } catch {
      /* a header pointing at a path that no longer exists is not a reason to stop */
    }
  }

  // Standing in the wrong repository produces a confident, wrong 'mismatch'. Refuse to
  // answer instead: 'unknown' releases the turn without claiming anything either way.
  if (!hasBranchRef(dir, branch)) return 'unknown';

  let stdout = null;
  try {
    const r = spawnSync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,isDraft,headRefName', '--limit', '30'],
      { cwd: dir, encoding: 'utf8', timeout: GH_TIMEOUT_MS },
    );
    if (!r.error && r.status === 0) stdout = r.stdout;
  } catch {
    /* gh missing, not a repo, unauthenticated, offline — all 'unknown' */
  }
  return prVerdict(branch, stdout);
}

/**
 * Set a key in the frontmatter header only, rewriting whatever value is there.
 * Deliberately lenient about the OLD value (comments, quotes, junk) — a strict
 * pattern here silently no-ops, which would stop turns_used advancing and mean the
 * turn_budget stop rule never fires.
 */
export function setHeaderField(md, key, value) {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(md);
  if (!m) return md;
  const [, open, header, close] = m;
  const line = new RegExp(`^${key}:[^\\r\\n]*$`, 'm');
  const next = line.test(header)
    ? header.replace(line, `${key}: ${value}`)
    : `${header}\n${key}: ${value}`;
  return open + next + close + md.slice(m.index + m[0].length);
}

export const setHeaderStatus = (md, status) => setHeaderField(md, 'status', status);
export const bumpTurns = (md, next) => setHeaderField(md, 'turns_used', next);

/**
 * Core decision. Pure apart from the caller's file write, so tests drive it directly.
 * Returns {action: 'allow'|'block', reason?, write?}
 *
 * `now` is injected for the same reason the rest of this is pure: a real clock makes
 * the `last_verified` stamp unassertable. `checkPr` is injected because the code
 * route's completion check talks to GitHub, and its default is the honest one —
 * 'unknown', which releases the turn but never claims DONE. A caller that wants the
 * real check passes `ghPrCheck`; `main()` always does.
 */
export function decide(md, opts = {}) {
  const { now = () => new Date().toISOString(), checkPr = () => 'unknown' } =
    typeof opts === 'function' ? { now: opts } : opts;

  const split = splitFrontmatter(md);
  // Not a brief we understand — fail open, and stamp nothing. A `last_verified` on
  // a file this verifier could not parse would be a liveness claim about a brief it
  // never actually read.
  if (!split) return { action: 'allow' };

  /**
   * Every path below writes, and the stamp is why.
   *
   * `last_verified` is the only evidence that the verifier ran *at all*. Both
   * verifiers fail open on any error — mandatory, since one that failed closed could
   * wedge a session with no way out — but failing open is indistinguishable from
   * succeeding unless something is written down. This script cannot be denied its
   * tools, so an absent stamp now means something blunter: the hook never ran at all
   * (plugin not installed, `node` missing, hooks disabled). Phase 2 checks for it and
   * says so plainly rather than letting the user believe a goal is being held.
   *
   * Stamped even on the terminal statuses. It costs one atomic write per turn end
   * and keeps the signal true for the whole session rather than only until the
   * goal is settled.
   */
  const stamped = setHeaderField(md, 'last_verified', now());

  const { header, body } = split;
  const status = headerValue(header, 'status');
  if (!status || TERMINAL.has(status)) return { action: 'allow', write: stamped };

  const turnsUsed = Number.parseInt(headerValue(header, 'turns_used') ?? '0', 10) || 0;
  const budget = Number.parseInt(headerValue(header, 'turn_budget') ?? '8', 10) || 8;

  // Stop rule tripped: record the failure and release, never loop forever.
  if (turnsUsed >= budget) {
    return { action: 'allow', write: setHeaderStatus(stamped, 'FAILED') };
  }

  const outcome = section(body, 'Outcome');
  const evidence = section(body, 'Verification evidence');
  const { total, unchecked } = checkboxItems(outcome);
  const evidenceOk = hasEvidence(evidence);

  // No Outcome section, or one with no checkbox items at all: there is nothing
  // mechanical to verify. Release the turn, but do NOT stamp DONE — claiming success
  // on an unverifiable brief is worse than not verifying at all. The liveness stamp
  // is not a success claim and rides along regardless.
  if (total === 0) return { action: 'allow', write: stamped };

  if (unchecked.length === 0 && evidenceOk) {
    // Ticking a box is a claim. On the code route one claim is checkable without
    // trusting anybody: the PR.
    if (headerValue(header, 'route') === 'code') {
      const verdict = checkPr(header);
      if (verdict === 'mismatch') {
        return {
          action: 'block',
          reason:
            `Every Outcome item is ticked but no PR exists on branch "${headerValue(header, 'branch')}". ` +
            `Raise the draft PR and record it in "## Verification evidence". Turn ${turnsUsed + 1}/${budget}.`,
          write: bumpTurns(stamped, turnsUsed + 1),
        };
      }
      // 'unknown' — gh unavailable, offline, no branch recorded. Release the turn
      // (failing open is mandatory) but never stamp DONE on a check we could not run.
      if (verdict !== 'match') return { action: 'allow', write: stamped };
    }
    return { action: 'allow', write: setHeaderStatus(stamped, 'DONE') };
  }

  const reasons = [];
  if (unchecked.length) {
    reasons.push(
      `${unchecked.length} Outcome item(s) still unchecked: ` +
        unchecked.slice(0, 3).map((s) => `"${s.slice(0, 80)}"`).join('; ') +
        (unchecked.length > 3 ? ` (+${unchecked.length - 3} more)` : ''),
    );
  }
  if (!evidenceOk) {
    reasons.push('"## Verification evidence" is empty — record real command output');
  }
  reasons.push(`Turn ${turnsUsed + 1}/${budget}. Do the next unmet item, then tick it.`);

  return { action: 'block', reason: reasons.join('. '), write: bumpTurns(stamped, turnsUsed + 1) };
}

/**
 * The ledger receipt (HIVE-163). One `event` per status the floor writes, so the
 * overmind sees ACTIVE turns, DONE and FAILED without opening the file. Posted to
 * the Hive's own receiver with the session's token, both exported into every hook
 * process by the app. Fire-and-forget by construction: a receiver that is not
 * there, a token that is wrong, a body the receiver refuses, all cost nothing and
 * never delay the turn. The floor's decision was already made.
 */
export function receiptFor(md, sessionId) {
  const split = splitFrontmatter(md);
  if (!split) return null;
  const status = headerValue(split.header, 'status');
  if (!status) return null;
  const turnsUsed = Number.parseInt(headerValue(split.header, 'turns_used') ?? '0', 10) || 0;
  const turnBudget = Number.parseInt(headerValue(split.header, 'turn_budget') ?? '8', 10) || 8;
  const task = /^## Task\s*\n+([^\n]+)/m.exec(split.body)?.[1]?.trim() ?? '';
  return {
    kind: 'event',
    body: `goal ${status}${task ? `: ${task}` : ''} (turn ${turnsUsed}/${turnBudget})`,
    meta: { goal: sessionId, status, turns_used: turnsUsed, turn_budget: turnBudget },
  };
}

function postReceipt(md, sessionId, env = process.env) {
  const url = env.HIVE_RECEIVER_URL;
  const token = env.HIVE_HOOK_TOKEN;
  const session = env.HIVE_SESSION_ID || sessionId;
  if (!url || !token || typeof fetch !== 'function') return;
  const receipt = receiptFor(md, sessionId);
  if (!receipt) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    fetch(`${url.replace(/\/$/, '')}/ledger`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hive-token': token,
        'x-hive-session': session,
      },
      body: JSON.stringify(receipt),
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  } catch {
    /* never the floor's problem */
  }
}

/** Write via temp + rename so a crash mid-write cannot truncate the user's brief. */
function writeAtomic(path, contents) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, contents, 'utf8');
    renameSync(tmp, path);
  } catch {
    /* a read-only or unwritable brief must not wedge the turn */
  }
}

function main() {
  const harness = harnessOf();
  try {
    const payload = readPayload();
    const sessionId = sessionIdOf(payload);
    if (!sessionId) return emit('allow', undefined, harness);

    const briefPath = resolveBrief(briefDir(), sessionId);
    if (!briefPath) return emit('allow', undefined, harness); // not a goal-on session

    const md = readFileSync(briefPath, 'utf8');
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const result = decide(md, { checkPr: (header) => ghPrCheck(header, cwd) });

    if (result.write) {
      writeAtomic(briefPath, result.write);
      postReceipt(result.write, sessionId);
    }
    if (result.action === 'block') return emit('block', result.reason, harness);
    return emit('allow', undefined, harness);
  } catch {
    return emit('allow', undefined, harness); // fail open, always
  }
}

// Only run when invoked directly, so the test file can import the helpers.
// NB: an `endsWith('verify-goal.mjs')` check is WRONG — 'test-verify-goal.mjs' also
// ends with it, so importing from the test would run main() and block on stdin.
// argv[1] is realpath'd because Node realpaths import.meta.url but not argv[1]; without
// it, invoking through a symlink silently disables the hook.
if (process.argv[1]) {
  let entry = process.argv[1];
  try {
    entry = realpathSync(entry);
  } catch {
    /* keep the raw path */
  }
  if (import.meta.url === pathToFileURL(entry).href) main();
}
