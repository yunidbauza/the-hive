#!/usr/bin/env node
/**
 * Tests for the portable goal-on Stop verifier.
 * Run: node --test test-verify-goal.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decide,
  harnessOf,
  briefDir,
  receiptFor,
  emitFor,
  resolveBrief,
  prVerdict,
  hasBranchRef,
  section,
  checkboxItems,
  hasEvidence,
  sessionIdOf,
  readPayload,
  splitFrontmatter,
  setHeaderStatus,
  setHeaderField,
  headerValue,
} from '../../../../resources/skills/goal-on/scripts/verify-goal.mjs';

const brief = ({
  status = 'ACTIVE',
  turns = 0,
  budget = 8,
  outcome = '- [x] done thing\n',
  evidence = '$ npm test\nok\n',
} = {}) => `---
status: ${status}
route: code
turns_used: ${turns}
turn_budget: ${budget}
branch: goal/x
---

## Task

Do the thing.

## Outcome

${outcome}
## Stop Rules

Stop after ${budget} turns.

## Verification evidence

${evidence}`;

// --- terminal statuses release the turn -------------------------------------

for (const status of ['PENDING-APPROVAL', 'CLEARED', 'DONE', 'FAILED', 'NEEDS-DECISION']) {
  test(`status ${status} allows the turn to end`, () => {
    // Unmet outcome + no evidence: only the status may release it.
    const md = brief({ status, outcome: '- [ ] not done\n', evidence: '' });
    assert.equal(decide(md).action, 'allow');
  });
}

test('PENDING-APPROVAL never blocks — it is the Phase 1 approval gate', () => {
  const md = brief({ status: 'PENDING-APPROVAL', outcome: '- [ ] a\n- [ ] b\n', evidence: '' });
  const r = decide(md, () => '2026-01-01T00:00:00.000Z');
  assert.equal(r.action, 'allow');
  // It writes — the liveness stamp — but must not touch the status, which is the
  // user's approval gate.
  assert.match(r.write, /^status: PENDING-APPROVAL$/m);
  assert.match(r.write, /^last_verified: 2026-01-01T00:00:00\.000Z$/m);
});

// --- blocking ----------------------------------------------------------------

test('ACTIVE with unchecked outcome items blocks and names them', () => {
  const md = brief({ outcome: '- [x] first\n- [ ] second thing\n- [ ] third thing\n' });
  const r = decide(md);
  assert.equal(r.action, 'block');
  assert.match(r.reason, /2 Outcome item\(s\) still unchecked/);
  assert.match(r.reason, /second thing/);
});

test('ACTIVE with all items checked but empty evidence blocks', () => {
  const md = brief({ outcome: '- [x] all done\n', evidence: '' });
  const r = decide(md);
  assert.equal(r.action, 'block');
  assert.match(r.reason, /Verification evidence" is empty/);
});

test('the placeholder alone does not count as evidence', () => {
  const md = brief({ outcome: '- [x] all done\n', evidence: '(appended during Phase 2)\n' });
  assert.equal(decide(md).action, 'block');
});

test('blocking increments turns_used in the written header', () => {
  const md = brief({ turns: 2, outcome: '- [ ] nope\n' });
  const r = decide(md);
  assert.equal(r.action, 'block');
  assert.match(r.write, /^turns_used: 3$/m);
});

// --- completion --------------------------------------------------------------

test('all checked plus real evidence releases and writes DONE', () => {
  // route: code, so the PR gate is part of the claim — say what it found.
  const md = brief({ outcome: '- [x] a\n- [x] b\n', evidence: '$ pnpm test\n12 passed\n' });
  const r = decide(md, { checkPr: () => 'match' });
  assert.equal(r.action, 'allow');
  assert.match(r.write, /^status: DONE$/m);
});

// --- stop rule ---------------------------------------------------------------

test('turns_used >= turn_budget writes FAILED and releases', () => {
  const md = brief({ turns: 8, budget: 8, outcome: '- [ ] never finished\n', evidence: '' });
  const r = decide(md);
  assert.equal(r.action, 'allow', 'must not block past the budget — the harness gives up anyway');
  assert.match(r.write, /^status: FAILED$/m);
});

test('budget trip takes precedence over an otherwise-complete brief', () => {
  const md = brief({ turns: 9, budget: 8 });
  assert.match(decide(md).write, /^status: FAILED$/m);
});

// --- fail open ---------------------------------------------------------------

test('a brief with no frontmatter fails open', () => {
  assert.equal(decide('# just a document\n\nno header here').action, 'allow');
});

test('a brief with no status field fails open', () => {
  assert.equal(decide('---\nroute: code\n---\n\n## Outcome\n\n- [ ] x\n').action, 'allow');
});

test('garbage input does not throw', () => {
  for (const input of ['', '---\n---\n', '---\nstatus:\n---\n']) {
    assert.doesNotThrow(() => decide(input));
  }
});

// --- payload parsing ---------------------------------------------------------

test('both sessionId conventions are accepted', () => {
  assert.equal(sessionIdOf({ sessionId: 'abc' }), 'abc');
  assert.equal(sessionIdOf({ session_id: 'xyz' }), 'xyz');
  assert.equal(sessionIdOf({}), null);
});

test('malformed payloads parse to an empty object rather than throwing', () => {
  assert.deepEqual(readPayload('not json'), {});
  assert.deepEqual(readPayload(''), {});
  assert.deepEqual(readPayload('{"sessionId":"s1"}'), { sessionId: 's1' });
});

// --- helpers -----------------------------------------------------------------

test('section stops at the next heading and does not leak a literal Z', () => {
  const body = '## Outcome\n\n- [x] one\n\n## Stop Rules\n\nstop\n';
  const out = section(body, 'Outcome');
  assert.match(out, /- \[x\] one/);
  assert.doesNotMatch(out, /Stop Rules/);
});

test('section reads the final heading through end-of-string', () => {
  const body = '## Outcome\n\n- [x] one\n\n## Verification evidence\n\n$ cmd\nout\n';
  assert.match(section(body, 'Verification evidence'), /\$ cmd/);
});

test('checkboxItems ignores ticked boxes and handles * bullets', () => {
  assert.deepEqual(checkboxItems('- [x] a\n- [ ] b\n* [ ] c\n').unchecked, ['b', 'c']);
  assert.deepEqual(checkboxItems('- [x] a\n').unchecked, []);
  assert.equal(checkboxItems('- [x] a\n- [ ] b\n').total, 2);
  assert.equal(checkboxItems('no checkboxes here\n').total, 0);
});

test('hasEvidence ignores headings and whitespace', () => {
  assert.equal(hasEvidence('\n\n   \n'), false);
  assert.equal(hasEvidence('### A heading only\n'), false);
  assert.equal(hasEvidence('### Run\n$ cmd\nok\n'), true);
});

test('splitFrontmatter tolerates CRLF line endings', () => {
  const s = splitFrontmatter('---\r\nstatus: ACTIVE\r\n---\r\nbody');
  assert.ok(s);
  assert.match(s.header, /status: ACTIVE/);
});

test('setHeaderStatus rewrites only the header status', () => {
  const md = '---\nstatus: ACTIVE\n---\n\nstatus: ACTIVE in the body stays\n';
  const out = setHeaderStatus(md, 'DONE');
  assert.match(out, /^status: DONE$/m);
  assert.match(out, /status: ACTIVE in the body stays/);
});

// --- regressions from the PR #30 self review ------------------------------------
// Each of these previously produced a FALSE SUCCESS (a `DONE` stamp on a brief that
// was not actually verified) or silently disabled the stop rule.

test('no ## Outcome section: releases but never stamps DONE', () => {
  const md = '---\nstatus: ACTIVE\nturns_used: 0\nturn_budget: 8\n---\n\n## Task\n\nx\n';
  const r = decide(md);
  assert.equal(r.action, 'allow');
  assert.doesNotMatch(r.write, /status: DONE/, 'unverifiable brief must not be marked DONE');
  assert.match(r.write, /^status: ACTIVE$/m);
});

test('Outcome written as prose with no checkboxes: releases but never stamps DONE', () => {
  const md = brief({ outcome: 'Ship the thing and make sure it works.\n' });
  const r = decide(md);
  assert.equal(r.action, 'allow');
  assert.doesNotMatch(r.write, /status: DONE/);
  assert.match(r.write, /^status: ACTIVE$/m);
});

test('a heading-like line inside a fenced block does not truncate the Outcome', () => {
  const outcome = [
    '- [x] first',
    '',
    '```md',
    '## not a heading',
    '```',
    '',
    '- [ ] genuinely unfinished',
    '',
  ].join('\n');
  const r = decide(brief({ outcome }));
  assert.equal(r.action, 'block', 'the item after the fence must still be seen');
  assert.match(r.reason, /genuinely unfinished/);
});

test('section still returns fenced evidence content intact', () => {
  const body = '## Verification evidence\n\n```\n## output heading\nok\n```\n';
  const out = section(body, 'Verification evidence');
  assert.match(out, /## output heading/, 'masking must not delete fenced content');
  assert.equal(hasEvidence(out), true);
});

test('an unrelated ## heading does not end a section (only siblings do)', () => {
  const body = '## Outcome\n\n- [ ] a\n\n## Some Other Heading\n\n- [ ] b\n\n## Stop Rules\n\nx\n';
  assert.equal(checkboxItems(section(body, 'Outcome')).unchecked.length, 2);
});

for (const [label, raw] of [
  ['an inline # comment', 'turns_used: 2   # bumped by the verifier'],
  ['a quoted value', 'turns_used: "2"'],
  ['extra whitespace', 'turns_used:    2   '],
]) {
  test(`turns_used with ${label} still increments (stop rule stays live)`, () => {
    const md = `---\nstatus: ACTIVE\n${raw}\nturn_budget: 8\n---\n\n## Outcome\n\n- [ ] x\n\n## Verification evidence\n\nout\n`;
    const r = decide(md);
    assert.equal(r.action, 'block');
    assert.match(r.write, /^turns_used: 3$/m, 'a no-op bump would loop forever and never hit FAILED');
  });
}

test('turns_used missing entirely is inserted rather than silently dropped', () => {
  const md = '---\nstatus: ACTIVE\nturn_budget: 8\n---\n\n## Outcome\n\n- [ ] x\n\n## Verification evidence\n\nout\n';
  const r = decide(md);
  assert.equal(r.action, 'block');
  assert.match(r.write, /^turns_used: 1$/m);
});

test('headerValue tolerates comments and quotes', () => {
  const h = 'status: ACTIVE  # running\nturn_budget: "12"\n';
  assert.equal(headerValue(h, 'status'), 'ACTIVE');
  assert.equal(headerValue(h, 'turn_budget'), '12');
});

test('setHeaderField rewrites a commented value and touches only the header', () => {
  const md = '---\nstatus: ACTIVE   # was pending\n---\n\nstatus: ACTIVE stays in the body\n';
  const out = setHeaderField(md, 'status', 'DONE');
  assert.match(out, /^status: DONE$/m);
  assert.match(out, /status: ACTIVE stays in the body/);
});

test('sessionIdOf rejects ids that could escape the brief directory', () => {
  assert.equal(sessionIdOf({ sessionId: '../../etc/passwd' }), null);
  assert.equal(sessionIdOf({ sessionId: 'a/b' }), null);
  assert.equal(sessionIdOf({ sessionId: '..' }), null);
  assert.equal(sessionIdOf({ sessionId: 'ok-123_ABC.def' }), 'ok-123_ABC.def');
});

// --- the liveness stamp ------------------------------------------------------

// `last_verified` is the only evidence that the verifier ran at all. Both verifiers
// fail open on any error — mandatory, so a broken one cannot wedge a session — and
// failing open is indistinguishable from succeeding unless something is written
// down. Under Claude Code the failure is real: the `agent` hook reads the brief
// through the Read tool, and a bypass-permissions session denies it.

const AT = () => '2026-01-01T00:00:00.000Z';

test('every decision that parsed the brief stamps last_verified', () => {
  const cases = {
    'awaiting approval': brief({ status: 'PENDING-APPROVAL' }),
    terminal: brief({ status: 'DONE' }),
    'budget spent': brief({ turns: 8, budget: 8 }),
    verified: brief(),
    blocking: brief({ outcome: '- [ ] not done\n', evidence: '' }),
    'nothing to verify': brief({ outcome: 'prose, no checkboxes\n' }),
  };

  for (const [label, md] of Object.entries(cases)) {
    const r = decide(md, AT);
    assert.match(
      r.write ?? '',
      /^last_verified: 2026-01-01T00:00:00\.000Z$/m,
      `${label}: must record that the verifier ran`,
    );
  }
});

test('a brief with no frontmatter is not stamped', () => {
  // Nothing was parsed, so there is nothing to make a liveness claim about — a
  // stamp here would assert the verifier read a brief it never understood.
  const r = decide('# just a document\n\nno header here', AT);
  assert.equal(r.action, 'allow');
  assert.equal(r.write, undefined);
});

test('the stamp is refreshed rather than appended twice', () => {
  const once = decide(brief(), () => '2026-01-01T00:00:00.000Z').write;
  const twice = decide(once, () => '2026-02-02T00:00:00.000Z').write;

  assert.equal((twice.match(/^last_verified:/gm) ?? []).length, 1);
  assert.match(twice, /^last_verified: 2026-02-02T00:00:00\.000Z$/m);
});

test('stamping leaves the body untouched', () => {
  const md = brief();
  const r = decide(md, AT);
  const bodyOf = (text) => text.slice(text.indexOf('---', 4) + 3);

  assert.equal(bodyOf(r.write), bodyOf(md));
});

// --- harness contracts -------------------------------------------------------

// Claude Code's `Stop` and Copilot's `agentStop` want different JSON. Getting this
// wrong is invisible: an unrecognised shape reads as "release the turn", which is
// precisely the silent non-enforcement this verifier exists to prevent.

test('the harness is declared by the hook command, never guessed', () => {
  assert.equal(harnessOf(['--harness=claude']), 'claude');
  assert.equal(harnessOf([]), 'copilot');
  assert.equal(harnessOf(['--something-else']), 'copilot');
});

test('Claude Code gets its Stop shape: JSON to block, silence to release', () => {
  assert.deepEqual(JSON.parse(emitFor('claude', 'block', 'because')), {
    decision: 'block',
    reason: 'because',
  });
  assert.equal(emitFor('claude', 'allow'), '');
});

test('Copilot keeps its agentStop shape unchanged', () => {
  assert.deepEqual(JSON.parse(emitFor('copilot', 'allow')), { decision: 'allow' });
  assert.deepEqual(JSON.parse(emitFor('copilot', 'block', 'because')), {
    decision: 'block',
    reason: 'because',
  });
});

// --- finding the brief -------------------------------------------------------

// A brief the verifier cannot locate is indistinguishable from no goal at all, and
// the filename is written by a model. Every drift below was observed in a real
// ~/.claude/workstream/goal-on directory.

const dirWith = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-on-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  return dir;
};

test('the documented filename is found first', () => {
  const dir = dirWith({ 'abc123.md': brief(), 'session_abc123.md': brief() });
  assert.equal(resolveBrief(dir, 'abc123'), join(dir, 'abc123.md'));
});

test('the session_ prefixed variant is found', () => {
  const dir = dirWith({ 'session_abc123.md': brief() });
  assert.equal(resolveBrief(dir, 'abc123'), join(dir, 'session_abc123.md'));
});

test('a renamed brief is found by its in-file session identity', () => {
  const dir = dirWith({
    'abc123-some-slug.md': '---\nstatus: ACTIVE\nsession: abc123\n---\n\n## Task\n',
    'unrelated.md': '---\nstatus: ACTIVE\nsession: zzz999\n---\n\n## Task\n',
  });
  assert.equal(resolveBrief(dir, 'abc123'), join(dir, 'abc123-some-slug.md'));
});

test('when several briefs claim the session, the newest wins', () => {
  const dir = dirWith({
    'old.md': '---\nstatus: DONE\nsession: abc123\n---\n',
    'new.md': '---\nstatus: ACTIVE\nsession: abc123\n---\n',
  });
  utimesSync(join(dir, 'old.md'), new Date(1e9), new Date(1e9));
  utimesSync(join(dir, 'new.md'), new Date(2e9), new Date(2e9));
  assert.equal(resolveBrief(dir, 'abc123'), join(dir, 'new.md'));
});

test('no brief for this session resolves to null rather than a neighbour', () => {
  const dir = dirWith({ 'someone-else.md': '---\nstatus: ACTIVE\nsession: zzz999\n---\n' });
  assert.equal(resolveBrief(dir, 'abc123'), null);
});

test('a missing brief directory is not an error', () => {
  assert.equal(resolveBrief(join(tmpdir(), 'goal-on-does-not-exist-9d3f'), 'abc123'), null);
});

test('a partial id does not match a longer one', () => {
  const dir = dirWith({ 'x.md': '---\nsession: abc123456\n---\n' });
  assert.equal(resolveBrief(dir, 'abc123'), null);
});

// --- the code route's objective check ----------------------------------------

const PR = (rows) => JSON.stringify(rows);

test('an open PR on the brief branch is a match', () => {
  assert.equal(prVerdict('goal/x', PR([{ state: 'OPEN', isDraft: true, headRefName: 'goal/x' }])), 'match');
});

test('an already-merged PR still counts — ship marks it ready and merges it', () => {
  assert.equal(prVerdict('goal/x', PR([{ state: 'MERGED', isDraft: false, headRefName: 'goal/x' }])), 'match');
  // isDraft is deliberately not required: `ship`'s first move is to mark it ready.
  assert.equal(prVerdict('goal/x', PR([{ state: 'OPEN', isDraft: false, headRefName: 'goal/x' }])), 'match');
});

test('a closed PR, or none at all, is a mismatch', () => {
  assert.equal(prVerdict('goal/x', PR([{ state: 'CLOSED', headRefName: 'goal/x' }])), 'mismatch');
  assert.equal(prVerdict('goal/x', PR([])), 'mismatch');
  assert.equal(prVerdict('goal/x', PR([{ state: 'OPEN', headRefName: 'goal/other' }])), 'mismatch');
});

test('an unusable gh result is unknown, never a mismatch', () => {
  // 'unknown' releases the turn; 'mismatch' would block it. A missing gh, an
  // unauthenticated one, or a network failure must never wedge the session.
  assert.equal(prVerdict('goal/x', null), 'unknown');
  assert.equal(prVerdict('goal/x', 'not json'), 'unknown');
  assert.equal(prVerdict('goal/x', '{"not":"an array"}'), 'unknown');
  assert.equal(prVerdict('', PR([])), 'unknown');
  assert.equal(prVerdict('TBD — filled in once the ticket exists', PR([])), 'unknown');
});

test('the code route will not stamp DONE without a PR to point at', () => {
  const md = brief({ outcome: '- [x] a\n' });
  const r = decide(md, { checkPr: () => 'mismatch' });
  assert.equal(r.action, 'block');
  assert.match(r.reason, /no PR exists on branch "goal\/x"/);
  assert.match(r.write, /^turns_used: 1$/m, 'a blocked turn spends budget');
  assert.doesNotMatch(r.write, /^status: DONE$/m);
});

test('an unverifiable PR check releases the turn but claims nothing', () => {
  const r = decide(brief({ outcome: '- [x] a\n' }), { checkPr: () => 'unknown' });
  assert.equal(r.action, 'allow', 'failing open is mandatory');
  assert.doesNotMatch(r.write, /^status: DONE$/m, 'a check that did not run cannot succeed');
  assert.match(r.write, /^status: ACTIVE$/m, 'and it must not silently settle the goal either');
  assert.match(r.write, /^last_verified:/m);
});

test('the artifact route has no PR gate', () => {
  const md = brief({ outcome: '- [x] a\n' }).replace('route: code', 'route: artifact');
  const r = decide(md, {
    checkPr: () => assert.fail('the PR gate must not run off the code route'),
  });
  assert.equal(r.action, 'allow');
  assert.match(r.write, /^status: DONE$/m);
});

test('the PR gate is the last gate, not the first', () => {
  // An unmet Outcome blocks on its own terms; GitHub is never consulted for it.
  const md = brief({ outcome: '- [ ] not done\n' });
  const r = decide(md, { checkPr: () => assert.fail('unchecked items must short-circuit first') });
  assert.equal(r.action, 'block');
});

// --- one stale PR must not mask a live one -----------------------------------

test('any qualifying PR on the branch is proof, not just the first row', () => {
  // A branch can carry several PRs: a merged one, then a closed follow-up. Judging
  // whichever row came back first would report "no PR" with a merged one right there,
  // and block every turn until the budget was spent.
  const rows = [
    { state: 'CLOSED', headRefName: 'goal/x' },
    { state: 'MERGED', headRefName: 'goal/x' },
  ];
  assert.equal(prVerdict('goal/x', JSON.stringify(rows)), 'match');
  assert.equal(prVerdict('goal/x', JSON.stringify(rows.reverse())), 'match');
});

test('rows for other branches never satisfy the check', () => {
  const rows = [
    { state: 'OPEN', headRefName: 'goal/other' },
    { state: 'CLOSED', headRefName: 'goal/x' },
  ];
  assert.equal(prVerdict('goal/x', JSON.stringify(rows)), 'mismatch');
});

// --- and the check refuses to answer about the wrong repository --------------

test('the branch ref is what proves we are standing in the right repository', () => {
  // `gh pr list` resolves its repo from cwd, so a lookup run from an unrelated repo
  // returns a confident empty list — identical to "the PR was never raised". The
  // local branch ref is the tell, and its absence downgrades the verdict to unknown.
  //
  // Built here rather than asserted against this checkout: CI checks out a detached
  // HEAD, so `refs/heads/main` does not exist on the runner. A test that reads its
  // own environment tests the environment.
  const repo = mkdtempSync(join(tmpdir(), 'goal-on-repo-'));
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  git('checkout', '-q', '-b', 'probe-branch');

  assert.equal(hasBranchRef(repo, 'probe-branch'), true);
  assert.equal(hasBranchRef(repo, 'no-such-branch-2f9a'), false, 'a branch this repo never had');
  assert.equal(hasBranchRef(mkdtempSync(join(tmpdir(), 'not-a-repo-')), 'probe-branch'), false, 'not a repo at all');
});

test('receiptFor: one event per written status, naming the goal and its budget', () => {
  const md = '---\nstatus: ACTIVE\nturns_used: 2\nturn_budget: 8\n---\n\n## Task\nMake the cache invalidate on write.\n\n## Outcome\n- [ ] x\n';
  const r = receiptFor(md, 'sess-1');
  assert.equal(r.kind, 'event');
  assert.equal(r.body, 'goal ACTIVE: Make the cache invalidate on write. (turn 2/8)');
  assert.deepEqual(r.meta, { goal: 'sess-1', status: 'ACTIVE', turns_used: 2, turn_budget: 8 });
});

test('receiptFor: nothing to post for a brief with no header or no status', () => {
  assert.equal(receiptFor('# not a brief', 's'), null);
  assert.equal(receiptFor('---\nroute: code\n---\n', 's'), null);
});

test('briefDir: HIVE_GOALS_DIR relocates the brief tree', () => {
  const prev = process.env.HIVE_GOALS_DIR;
  process.env.HIVE_GOALS_DIR = '/tmp/goals-x';
  try {
    assert.equal(briefDir(), '/tmp/goals-x');
  } finally {
    if (prev === undefined) delete process.env.HIVE_GOALS_DIR; else process.env.HIVE_GOALS_DIR = prev;
  }
});
