// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  LEDGER_ASK_TTL_MS,
  OVERMIND,
  type LedgerEntry,
} from '../../../electron/shared/ledger-contract';
import {
  agentSiteFor,
  asksMeAbout,
  INBOUND_NAME_MAX,
  INBOUND_TEXT_MAX,
  asInbound,
  buildProgressFor,
  claims,
  closedAskThreads,
  delegatesOf,
  expiredAsks,
  holderPost,
  isShipping,
  keepNewest,
  laneOfRun,
  matches,
  mergeAsk,
  mergeWaiting,
  nextRef,
  openAsks,
  prEvents,
  prOpener,
  resolveRef,
  reviewUrls,
  SHIP_STOPS,
  shipStage,
  shipTrack,
  thread,
  ttlOf,
  STAGE_TEXT_MAX,
} from '../../../electron/shared/ledger-derive';

const NOW = 1_800_000_000_000;

const entry = (over: Partial<LedgerEntry> & Pick<LedgerEntry, 'id'>): LedgerEntry => ({
  ts: NOW,
  from: 'sess-a',
  kind: 'post',
  body: '',
  ...over,
});

describe('isShipping and buildProgressFor (HIVE-171)', () => {
  const posts = [
    entry({ id: 'p1', from: 'shipper', body: 'stage', meta: { pr: 214, repo: 'yunidbauza/the-hive', stage: 'intake' } }),
    entry({ id: 'p2', from: 'shipper', body: 'stage', meta: { pr: 214, repo: 'Yunidbauza/The-Hive', stage: 'ci' } }),
    entry({ id: 'p3', from: 'shipper', body: 'stage', meta: { pr: 9, repo: 'behiques/incorpx', stage: 'merge' } }),
    entry({ id: 'p4', from: 'drone', body: 'stage', meta: { pr: 214, repo: 'yunidbauza/the-hive', stage: 'forged' } }),
    entry({ id: 'b1', from: 'builder', body: 'task', meta: { ticket: 'HIVE-7', stage: 'build', task: 2 } }),
    entry({ id: 'b2', from: 'builder', body: 'task', meta: { ticket: 'hive-7', stage: 'build', task: 3 } }),
    entry({ id: 'b3', from: 'builder', body: 'task', meta: { ticket: 'HIVE-8', stage: 'verify' } }),
  ];

  it('reads a PR as shipping by number and whole slug, case-insensitively', () => {
    expect(isShipping(posts, 'yunidbauza/the-hive', 214)).toBe(true);
    expect(isShipping(posts, 'behiques/incorpx', 9)).toBe(true);
  });

  it('matches the whole slug, never a tail or a substring of it', () => {
    expect(isShipping(posts, 'the-hive', 214)).toBe(false);
    expect(isShipping(posts, 'someone-else/the-hive', 214)).toBe(false);
    expect(isShipping(posts, 'hive', 214)).toBe(false);
    expect(isShipping(posts, '', 214)).toBe(false);
  });

  it('answers false for a PR nobody shipped, and reads only the shipper\'s posts', () => {
    expect(isShipping(posts, 'yunidbauza/the-hive', 1)).toBe(false);
    expect(isShipping(posts.filter((e) => e.from !== 'shipper'), 'yunidbauza/the-hive', 214)).toBe(false);
  });

  /*
    The shipper claims at intake and may post no stage until `ci`, so the
    claim alone has to carry the pill through the self review.
  */
  it('reads the shipper\'s own claim as shipping before any stage post', () => {
    const claimed = [
      entry({ id: 'c1', from: 'shipper', kind: 'claim', body: 'claimed', meta: { task: 'Acme/Nova#5' } }),
      entry({ id: 'c2', from: 'fixer', kind: 'claim', body: 'claimed', meta: { task: 'acme/nova#6' } }),
    ];
    expect(isShipping(claimed, 'acme/nova', 5)).toBe(true);
    expect(isShipping(claimed, 'acme/nova', 6)).toBe(false);
    expect(isShipping(claimed, 'acme/nova', 55)).toBe(false);
    const released = [
      ...claimed,
      entry({ id: 'r1', from: 'shipper', kind: 'release', body: 'released', meta: { task: 'acme/nova#5' } }),
    ];
    expect(isShipping(released, 'acme/nova', 5)).toBe(false);
  });

  it('stops once the shipper released its claim on the PR', () => {
    const released = [
      ...posts,
      entry({ id: 'r1', from: 'shipper', kind: 'release', body: 'released', meta: { task: 'Yunidbauza/the-hive#214' } }),
    ];
    expect(isShipping(released, 'yunidbauza/the-hive', 214)).toBe(false);
    expect(isShipping(released, 'behiques/incorpx', 9)).toBe(true);
  });

  /*
    The `closed` step releases the claim first and posts "PR #N merged" with
    `stage: "closed"` after it, so the post is the newer entry. Read as a
    stage, it left `ship: closed` on every merged card.
  */
  it('stops at the closing post the shipper writes after its release', () => {
    const closed = [
      ...posts,
      entry({ id: 'r1', from: 'shipper', kind: 'release', body: 'released', meta: { task: 'yunidbauza/the-hive#214' } }),
      entry({ id: 'p6', from: 'shipper', to: 'sess-a', body: 'PR #214 merged', meta: { pr: 214, repo: 'yunidbauza/the-hive', stage: 'closed' } }),
    ];
    expect(isShipping(closed, 'yunidbauza/the-hive', 214)).toBe(false);
    expect(isShipping(closed, 'behiques/incorpx', 9)).toBe(true);
  });

  it('accepts a number written as digits, and nothing that is not whole', () => {
    const loose = [
      entry({ id: 'l1', from: 'shipper', body: 'stage', meta: { pr: '77', repo: 'acme/nova', stage: 'ci' } }),
      entry({ id: 'l2', from: 'shipper', body: 'stage', meta: { pr: 7.5, repo: 'acme/nova', stage: 'ci' } }),
      entry({ id: 'l3', from: 'builder', body: 'task', meta: { ticket: 'ACME-1', stage: 'x'.repeat(60), task: '4' } }),
    ];
    expect(isShipping(loose, 'acme/nova', 77)).toBe(true);
    expect(isShipping(loose, 'acme/nova', 7)).toBe(false);
    expect(buildProgressFor(loose, 'ACME-1')).toEqual({ from: 'builder', stage: 'x'.repeat(STAGE_TEXT_MAX), task: 4 });
  });

  it('reads the newest agent progress for a ticket, key case-insensitive, task optional; the builder still answers', () => {
    expect(buildProgressFor(posts, 'HIVE-7')).toEqual({ from: 'builder', stage: 'build', task: 3 });
    expect(buildProgressFor(posts, 'HIVE-8')).toEqual({ from: 'builder', stage: 'verify' });
    expect(buildProgressFor(posts, 'HIVE-9')).toBeUndefined();
    const claimed = [
      entry({ id: 'c1', from: 'builder', kind: 'claim', body: 'claimed HIVE-9', meta: { ticket: 'HIVE-9', stage: 'build', task: 'HIVE-9' } }),
    ];
    expect(buildProgressFor(claimed, 'HIVE-9')).toBeUndefined();
  });

  it('reads any agent\'s post, newest wins across agents (HIVE-203)', () => {
    const mixed = [
      ...posts,
      entry({ id: 's1', from: 'shipper', body: 'stage', meta: { ticket: 'HIVE-7', stage: 'ci' } }),
    ];
    expect(buildProgressFor(mixed, 'HIVE-7')).toEqual({ from: 'shipper', stage: 'ci' });
    expect(buildProgressFor(posts, 'HIVE-7')).toEqual({ from: 'builder', stage: 'build', task: 3 });
  });
});

describe('shipStage (HIVE-215)', () => {
  const slug = 'yunidbauza/the-hive';
  const claim = entry({ id: 'c1', from: 'shipper', kind: 'claim', body: 'claimed', meta: { task: 'yunidbauza/the-hive#214' } });
  const stage = (id: string, s: string, over: Partial<LedgerEntry> = {}) =>
    entry({ id, from: 'shipper', body: 'stage', meta: { pr: 214, repo: slug, stage: s }, ...over });

  it('reads intake from the claim before any post', () => {
    expect(shipStage([claim], slug, 214)).toBe('intake');
  });

  it('follows the stages forward, newest wins', () => {
    expect(shipStage([claim, stage('p1', 'self-review'), stage('p2', 'ci'), stage('p3', 'findings')], slug, 214)).toBe('findings');
  });

  it('follows a step back from approval to findings', () => {
    expect(shipStage([claim, stage('p1', 'approval'), stage('p2', 'findings')], slug, 214)).toBe('findings');
  });

  it('is null after the release of the claim', () => {
    const release = entry({ id: 'r1', from: 'shipper', kind: 'release', body: 'released', meta: { task: 'Yunidbauza/The-Hive#214' } });
    expect(shipStage([claim, stage('p1', 'merge'), release], slug, 214)).toBeNull();
  });

  it('is null at closed', () => {
    expect(shipStage([claim, stage('p1', 'merge'), stage('p2', 'closed', { to: 'sess-a' })], slug, 214)).toBeNull();
  });

  it('ignores another owner\'s repo with the same name and number', () => {
    const other = entry({ id: 'o1', from: 'shipper', body: 'stage', meta: { pr: 214, repo: 'acme/the-hive', stage: 'merge' } });
    expect(shipStage([claim, stage('p1', 'ci'), other], slug, 214)).toBe('ci');
    expect(shipStage([other], slug, 214)).toBeNull();
  });

  it('is null for a PR nobody holds, and for an empty slug', () => {
    expect(shipStage([], slug, 214)).toBeNull();
    expect(shipStage([claim], '', 214)).toBeNull();
  });
});

describe('the two ask readings (HIVE-215)', () => {
  const slug = 'owner/name';
  const sessions = new Set(['sess-a']);
  const toMe = (to: string) => to === OVERMIND || sessions.has(to);
  const ask = (id: string, over: Partial<LedgerEntry>) =>
    entry({ id, ts: NOW - 1_000, from: 'shipper', kind: 'ask', body: 'PR #214 waits on a review', ...over });
  const open = (entries: LedgerEntry[]) => openAsks(entries, NOW);

  describe('asksMeAbout', () => {
    it('reads an ask to the overmind and to a session naming the PR', () => {
      expect(asksMeAbout(open([ask('a1', { to: OVERMIND, meta: { pr: 214, repo: 'Owner/Name' } })]), slug, 214, toMe)).toBe(true);
      expect(asksMeAbout(open([ask('a2', { to: 'sess-a', meta: { pr: '214', repo: slug } })]), slug, 214, toMe)).toBe(true);
    });

    it('ignores an ask naming another repo, another number, or sent to an agent', () => {
      expect(asksMeAbout(open([ask('a1', { to: OVERMIND, meta: { pr: 214, repo: 'acme/name' } })]), slug, 214, toMe)).toBe(false);
      expect(asksMeAbout(open([ask('a2', { to: OVERMIND, meta: { pr: 215, repo: slug } })]), slug, 214, toMe)).toBe(false);
      expect(asksMeAbout(open([ask('a3', { to: 'fixer', meta: { pr: 214, repo: slug } })]), slug, 214, toMe)).toBe(false);
    });

    it('ignores an answered ask and one past its ttl', () => {
      const answered = [
        ask('a1', { to: OVERMIND, meta: { pr: 214, repo: slug } }),
        entry({ id: 'x1', kind: 'answer', thread: 'a1', body: 'merge now' }),
      ];
      expect(asksMeAbout(open(answered), slug, 214, toMe)).toBe(false);
      const stale = ask('a2', { ts: NOW - LEDGER_ASK_TTL_MS - 1, to: OVERMIND, meta: { pr: 214, repo: slug } });
      expect(asksMeAbout(open([stale]), slug, 214, toMe)).toBe(false);
    });
  });

  describe('mergeWaiting', () => {
    const merge = (id: string, command: string, over: Partial<LedgerEntry> = {}) =>
      ask(id, { to: OVERMIND, meta: { kind: 'permission', tool: 'Bash', input: { command } }, ...over });

    it('reads the shipper\'s gh pr merge permission ask for this PR', () => {
      const one = merge('m1', 'gh pr merge 214 --squash --match-head-commit 3f2a9c1 --repo owner/name');
      expect(mergeWaiting(open([one]), slug, 214)).toBe(true);
    });

    it('ignores another number, a command without --repo, and another asker', () => {
      expect(mergeWaiting(open([merge('m1', 'gh pr merge 215 --squash --repo owner/name')]), slug, 214)).toBe(false);
      expect(mergeWaiting(open([merge('m2', 'gh pr merge 214 --squash')]), slug, 214)).toBe(false);
      expect(mergeWaiting(open([merge('m3', 'gh pr merge 214 --repo owner/name', { from: 'builder' })]), slug, 214)).toBe(false);
    });

    it('reads --repo=owner/name and ignores another repo', () => {
      expect(mergeWaiting(open([merge('m1', 'gh pr merge 214 --squash --repo=Owner/Name')]), slug, 214)).toBe(true);
      expect(mergeWaiting(open([merge('m2', 'gh pr merge 214 --squash --repo acme/name')]), slug, 214)).toBe(false);
    });
  });

  describe('mergeAsk (HIVE-205)', () => {
    const merge = (id: string, command: string) =>
      ask(id, { to: OVERMIND, meta: { kind: 'permission', tool: 'Bash', input: { command } } });

    it('returns the waiting merge card itself, so Merge can answer it', () => {
      const card = merge('m1', 'gh pr merge 214 --squash --match-head-commit abc --repo owner/name');
      expect(mergeAsk(open([card]), 'owner/name', 214)?.id).toBe('m1');
      expect(mergeAsk(open([card]), 'owner/name', 215)).toBeUndefined();
      expect(mergeWaiting(open([card]), 'owner/name', 214)).toBe(true);
    });
  });
});

describe('matches: ticket (HIVE-203)', () => {
  it('keeps entries whose meta.ticket names the key, case-insensitively', () => {
    const a = entry({ id: 'a', meta: { ticket: 'hive-7' } });
    const b = entry({ id: 'b', meta: { ticket: 'HIVE-8' } });
    const c = entry({ id: 'c' });
    const d = entry({ id: 'd', meta: { ticket: 7 } });
    expect([a, b, c, d].filter((e) => matches(e, { ticket: 'HIVE-7' })).map((e) => e.id)).toEqual(['a']);
  });

  it('ignores ticket when the query has none', () => {
    expect(matches(entry({ id: 'x' }), {})).toBe(true);
  });
});

describe('agentSiteFor (HIVE-172)', () => {
  const HIVE_6 = '/home/x/.hive/work/builder/hive-6';
  const HIVE_7 = '/home/x/.hive/work/builder/hive-7';
  const posts = [
    entry({ id: 'w0', from: 'builder', body: 'task', meta: { worktree: HIVE_6, checkout: '/repos/elsewhere' } }),
    entry({ id: 'w1', from: 'builder', body: 'task', meta: { worktree: HIVE_7, checkout: '/repos/the-hive' } }),
    entry({ id: 'w2', from: 'builder', body: 'task', meta: { worktree: 'relative/path', checkout: '/repos/the-hive' } }),
    entry({ id: 'w3', from: 'fixer', body: 'round', meta: { worktree: '/home/x/.hive/work/fixer/nova-pr9' } }),
    entry({ id: 'w4', from: 'shipper', body: 'stage', meta: { worktree: '/somewhere/else', stage: 'ci' } }),
    entry({ id: 'w5', from: 'builder', kind: 'claim', body: 'claimed', meta: { task: 'HIVE-8', worktree: '/home/x/.hive/work/builder/claimed' } }),
  ];

  it('reads the newest absolute worktree the agent posted, with its checkout when named', () => {
    expect(agentSiteFor(posts, 'builder')).toEqual({ worktree: HIVE_7, checkout: '/repos/the-hive' });
    expect(agentSiteFor(posts, 'fixer')).toEqual({ worktree: '/home/x/.hive/work/fixer/nova-pr9' });
  });

  it('reads only posts: a claim naming a worktree is not a report of one', () => {
    expect(agentSiteFor(posts, 'builder')?.worktree).not.toBe('/home/x/.hive/work/builder/claimed');
  });

  it('answers nothing for an agent that posted no worktree, and never reads another party', () => {
    expect(agentSiteFor(posts, 'acr')).toBeUndefined();
    expect(agentSiteFor(posts.filter((e) => e.from !== 'builder'), 'builder')).toBeUndefined();
  });

  it('stops at the agent\'s release: the job is over and the worktree is the shipper\'s to remove', () => {
    const released = [...posts, entry({ id: 'r1', from: 'builder', kind: 'release', body: 'released', meta: { task: 'HIVE-7' } })];
    expect(agentSiteFor(released, 'builder')).toBeUndefined();
    expect(agentSiteFor(released, 'fixer')).toEqual({ worktree: '/home/x/.hive/work/fixer/nova-pr9' });
    const next = [...released, entry({ id: 'w6', from: 'builder', body: 'task', meta: { worktree: HIVE_6, checkout: '/repos/next' } })];
    expect(agentSiteFor(next, 'builder')).toEqual({ worktree: HIVE_6, checkout: '/repos/next' });
  });

  it('recovers the checkout from an earlier post of the same worktree, never from another one', () => {
    const dropped = [...posts, entry({ id: 'w7', from: 'builder', body: 'task 2', meta: { worktree: HIVE_7 } })];
    expect(agentSiteFor(dropped, 'builder')).toEqual({ worktree: HIVE_7, checkout: '/repos/the-hive' });
    const moved = [...posts, entry({ id: 'w8', from: 'builder', body: 'task 1', meta: { worktree: '/home/x/.hive/work/builder/hive-8' } })];
    expect(agentSiteFor(moved, 'builder')).toEqual({ worktree: '/home/x/.hive/work/builder/hive-8' });
  });
});

describe('openAsks', () => {
  it('reports an unanswered ask as open, with its age', () => {
    const entries = [entry({ id: '20260828-100000-0001', kind: 'ask', ts: NOW - 60_000 })];

    expect(openAsks(entries, NOW)).toEqual([
      { ...entries[0], open: true, ageMs: 60_000 },
    ]);
  });

  it('closes an ask once an answer names its thread', () => {
    const entries = [
      entry({ id: '20260828-100000-0001', kind: 'ask' }),
      entry({ id: '20260828-100001-0001', kind: 'answer', thread: '20260828-100000-0001' }),
    ];

    expect(openAsks(entries, NOW)).toEqual([]);
  });

  /**
   * HIVE-118 self-review, findings 2 and 6. `done` and `failed` both take a
   * `thread` — `ledger-tools.ts` calls them "the ask this completes" and "the
   * ask this abandons" — and neither closed the ask here.
   *
   * The `done` half was visible: `notify.ts` dismissed the card while this
   * function kept the ask open, so the left rail's Agents badge — counted off
   * the ledger, immune to notification state — stayed lit with nothing behind
   * it. The `failed` half was the mirror image: the card stayed, offering
   * buttons `Ledger.append` would refuse.
   */
  it.each(['done', 'failed'] as const)(
    'closes an ask when a %s names its thread, exactly as an answer does',
    (kind) => {
      const entries = [
        entry({ id: '20260828-100000-0001', kind: 'ask' }),
        entry({ id: '20260828-100001-0001', kind, thread: '20260828-100000-0001' }),
      ];

      expect(openAsks(entries, NOW)).toEqual([]);
    },
  );

  /**
   * A `done` or `failed` with no thread is an agent reporting on its wake, not
   * on a question. It must leave every open ask exactly where it was.
   */
  it.each(['done', 'failed'] as const)(
    'leaves an unrelated ask open when a threadless %s lands',
    (kind) => {
      const ask = entry({ id: '20260828-100000-0001', kind: 'ask', ts: NOW - 60_000 });
      const entries = [ask, entry({ id: '20260828-100001-0001', kind })];

      expect(openAsks(entries, NOW)).toEqual([{ ...ask, open: true, ageMs: 60_000 }]);
    },
  );

  it('expires an ask older than the TTL even with no answer', () => {
    const entries = [
      entry({ id: '20260827-100000-0001', kind: 'ask', ts: NOW - LEDGER_ASK_TTL_MS - 1 }),
    ];

    expect(openAsks(entries, NOW)).toEqual([]);
  });

  it('ignores non-ask kinds', () => {
    const entries = [entry({ id: '20260828-100000-0001', kind: 'done' })];

    expect(openAsks(entries, NOW)).toEqual([]);
  });
});

describe('claims', () => {
  it('gives a task to the latest claim without a later release', () => {
    const entries = [
      entry({ id: '1', kind: 'claim', from: 'sess-a', meta: { task: 'HIVE-9' } }),
      entry({ id: '2', kind: 'claim', from: 'sess-b', meta: { task: 'HIVE-8' } }),
    ];

    expect(claims(entries)).toEqual({ 'HIVE-9': 'sess-a', 'HIVE-8': 'sess-b' });
  });

  it('drops a claim once released', () => {
    const entries = [
      entry({ id: '1', kind: 'claim', from: 'sess-a', meta: { task: 'HIVE-9' } }),
      entry({ id: '2', kind: 'release', from: 'sess-a', meta: { task: 'HIVE-9' } }),
    ];

    expect(claims(entries)).toEqual({});
  });

  it('lets a later claim take a released task', () => {
    const entries = [
      entry({ id: '1', kind: 'claim', from: 'sess-a', meta: { task: 'HIVE-9' } }),
      entry({ id: '2', kind: 'release', from: 'sess-a', meta: { task: 'HIVE-9' } }),
      entry({ id: '3', kind: 'claim', from: 'sess-b', meta: { task: 'HIVE-9' } }),
    ];

    expect(claims(entries)).toEqual({ 'HIVE-9': 'sess-b' });
  });

  it('ignores a claim with no task in meta', () => {
    expect(claims([entry({ id: '1', kind: 'claim' })])).toEqual({});
  });
});

describe('thread', () => {
  it('returns the ask and everything naming it, in order', () => {
    const entries = [
      entry({ id: 'a', kind: 'ask' }),
      entry({ id: 'b', kind: 'post' }),
      entry({ id: 'c', kind: 'answer', thread: 'a' }),
    ];

    expect(thread(entries, 'a').map((found) => found.id)).toEqual(['a', 'c']);
  });
});

describe('matches', () => {
  const subject = entry({
    id: '20260828-100000-0001',
    from: 'sess-a',
    to: 'sess-b',
    kind: 'ask',
    thread: 't1',
  });

  it('matches an empty query', () => {
    expect(matches(subject, {})).toBe(true);
  });

  it('filters on from, kind and thread', () => {
    expect(matches(subject, { from: 'sess-a' })).toBe(true);
    expect(matches(subject, { from: 'sess-z' })).toBe(false);
    expect(matches(subject, { kind: 'ask' })).toBe(true);
    expect(matches(subject, { kind: 'post' })).toBe(false);
    expect(matches(subject, { thread: 't1' })).toBe(true);
    expect(matches(subject, { thread: 't2' })).toBe(false);
  });

  /**
   * "The conversation" has to mean the same thing here as it does in
   * `thread()` above, which includes the ask. Matching only `entry.thread`
   * gave one contract two definitions: a read for `thread: <askId>` came back
   * with every reply and not the question they were replying to.
   */
  it('counts the ask itself as part of its own thread', () => {
    expect(matches(subject, { thread: subject.id })).toBe(true);

    const reply = entry({ id: 'reply', thread: subject.id });
    expect(matches(reply, { thread: subject.id })).toBe(true);

    const unrelated = entry({ id: 'other', thread: undefined });
    expect(matches(unrelated, { thread: subject.id })).toBe(false);
  });

  it('treats `to` as "addressed to me, or broadcast"', () => {
    expect(matches(subject, { to: 'sess-b' })).toBe(true);
    expect(matches(subject, { to: 'sess-c' })).toBe(false);

    const broadcast = entry({ id: '2', to: undefined });
    expect(matches(broadcast, { to: 'sess-c' })).toBe(true);
  });

  it('treats `since` as an exclusive lower bound on the id', () => {
    expect(matches(subject, { since: '20260828-095959-0001' })).toBe(true);
    expect(matches(subject, { since: '20260828-100000-0001' })).toBe(false);
    expect(matches(subject, { since: '20260828-100001-0001' })).toBe(false);
  });
});

describe('resolveRef', () => {
  const entries = [entry({ id: '20260828-100000-0001', kind: 'ask', ref: 'a7' })];

  it('resolves a short ref to the canonical id', () => {
    expect(resolveRef(entries, 'a7')).toEqual({ kind: 'found', id: '20260828-100000-0001' });
  });

  it('passes a canonical id straight through', () => {
    expect(resolveRef(entries, '20260828-100000-0001')).toEqual({ kind: 'found', id: '20260828-100000-0001' });
  });

  it('says none for anything it does not know', () => {
    expect(resolveRef(entries, 'a9')).toEqual({ kind: 'none' });
  });

  it('resolves a ref in any case, since A7 is the same handle to whoever types it', () => {
    expect(resolveRef(entries, 'A7')).toEqual({ kind: 'found', id: '20260828-100000-0001' });
    expect(resolveRef([entry({ id: '20260828-100000-0002', kind: 'ask', ref: 'A8' })], 'a8')).toEqual({ kind: 'found', id: '20260828-100000-0002' });
  });

  it('refuses a ref two writers both minted (HIVE-227)', () => {
    const twice = [...entries, entry({ id: '20260828-100500-0001', kind: 'ask', ref: 'A7' })];
    expect(resolveRef(twice, 'a7')).toEqual({ kind: 'ambiguous' });
  });

  it('refuses an id written twice (HIVE-227)', () => {
    const twice = [...entries, entry({ id: '20260828-100000-0001', kind: 'post' })];
    expect(resolveRef(twice, '20260828-100000-0001')).toEqual({ kind: 'ambiguous' });
  });

  it('lets an exact id win over a ref that happens to equal it', () => {
    const odd = [...entries, entry({ id: 'x', kind: 'ask', ref: '20260828-100000-0001' })];
    expect(resolveRef(odd, '20260828-100000-0001')).toEqual({ kind: 'found', id: '20260828-100000-0001' });
  });
});

describe('keepNewest', () => {
  const entries = [
    entry({ id: '1', body: 'one' }),
    entry({ id: '2', body: 'two' }),
    entry({ id: '3', body: 'three' }),
  ];

  it('returns everything when no limit is given', () => {
    expect(keepNewest(entries, undefined)).toEqual(entries);
  });

  it('keeps the newest `limit` entries', () => {
    expect(keepNewest(entries, 2).map((e) => e.body)).toEqual(['two', 'three']);
  });

  /**
   * `slice(-0)` is `slice(0)` — a whole copy — so the narrowest request a
   * caller can make used to return the widest possible answer. `0` is not an
   * exotic input: `parseLedgerReadQuery` explicitly admits it, so
   * `{"limit": 0}` returned the entire log over both the HTTP and IPC paths.
   */
  it('returns nothing, not everything, for a limit of zero', () => {
    expect(keepNewest(entries, 0)).toEqual([]);
  });

  it('returns everything when the limit is larger than the log', () => {
    expect(keepNewest(entries, 10)).toEqual(entries);
  });
});

describe('nextRef', () => {
  it('starts at a1 on an empty log', () => {
    expect(nextRef([])).toBe('a1');
  });

  it('takes the highest existing ref and adds one', () => {
    const entries = [
      entry({ id: '1', kind: 'ask', ref: 'a3' }),
      entry({ id: '2', kind: 'ask', ref: 'a11' }),
    ];

    expect(nextRef(entries)).toBe('a12');
  });

  it('ignores entries with no ref', () => {
    expect(nextRef([entry({ id: '1', kind: 'post' })])).toBe('a1');
  });
});

describe('ttlOf', () => {
  it('is the constant when no meta.ttlMs is given', () => {
    expect(ttlOf({})).toBe(LEDGER_ASK_TTL_MS);
    expect(ttlOf({ meta: {} })).toBe(LEDGER_ASK_TTL_MS);
  });

  it('honours a shorter meta.ttlMs', () => {
    expect(ttlOf({ meta: { ttlMs: 60_000 } })).toBe(60_000);
  });

  it('clamps a longer one to the constant', () => {
    // An agent may shorten its own ask; it may not outlive the log's own rule.
    expect(ttlOf({ meta: { ttlMs: LEDGER_ASK_TTL_MS * 2 } })).toBe(LEDGER_ASK_TTL_MS);
  });

  it('ignores a ttlMs that is not a positive finite number', () => {
    const bad: unknown[] = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5m', null];

    for (const ttlMs of bad) {
      expect(ttlOf({ meta: { ttlMs } })).toBe(LEDGER_ASK_TTL_MS);
    }
  });
});

describe('expiredAsks', () => {
  const ask = (over: Partial<LedgerEntry> = {}): LedgerEntry =>
    entry({ id: 'a1', kind: 'ask', ts: 0, from: 'pr-reviewer', to: 'overmind', ...over });

  it('is empty while the ask is inside its ttl', () => {
    expect(expiredAsks([ask()], LEDGER_ASK_TTL_MS - 1)).toEqual([]);
  });

  it('names an ask that has crossed its ttl', () => {
    expect(expiredAsks([ask()], LEDGER_ASK_TTL_MS).map((found) => found.id)).toEqual([
      'a1',
    ]);
  });

  it('uses the ask own meta.ttlMs', () => {
    expect(expiredAsks([ask({ meta: { ttlMs: 1_000 } })], 1_000)).toHaveLength(1);
  });

  it('ignores an ask something already closed', () => {
    const answer = entry({ id: 'x1', ts: 5, kind: 'answer', thread: 'a1' });

    expect(expiredAsks([ask(), answer], LEDGER_ASK_TTL_MS)).toEqual([]);
  });

  it('ignores an ask that already has its expiry event — the sweep is idempotent', () => {
    const expiry = entry({
      id: 'e1',
      ts: 5,
      from: OVERMIND,
      kind: 'event',
      thread: 'a1',
      meta: { expired: 'a1' },
    });

    expect(expiredAsks([ask(), expiry], LEDGER_ASK_TTL_MS)).toEqual([]);
  });

  it('ignores kinds that are not asks', () => {
    expect(expiredAsks([ask({ kind: 'post' })], LEDGER_ASK_TTL_MS)).toEqual([]);
  });

  it('only lets the overmind retire an ask', () => {
    /*
      `meta` is a free-form rider any writer controls, so a forged marker would
      otherwise put an id in the "already told" set permanently — retiring a
      question nobody answered, with no expiry event ever written for it.
    */
    const forged = entry({
      id: 'e2',
      ts: 5,
      from: 'sess-9',
      kind: 'event',
      thread: 'a1',
      meta: { expired: 'a1' },
    });

    expect(expiredAsks([ask(), forged], LEDGER_ASK_TTL_MS)).toHaveLength(1);
  });
});

describe('asInbound', () => {
  it('keeps a well-formed message, with and without a time', () => {
    expect(asInbound({ author: 'Marcos', text: 'puedes cubrir el demo?' })).toEqual({
      author: 'Marcos',
      text: 'puedes cubrir el demo?',
    });
    expect(asInbound({ author: 'Marcos', text: 'puedes cubrir?', at: '2:41pm' })).toEqual({
      author: 'Marcos',
      text: 'puedes cubrir?',
      at: '2:41pm',
    });
  });

  /*
    `meta` is a free-form rider the model controls, so every shape below is
    reachable from a hand-written `ledger_ask`. A partial one is dropped whole
    rather than drawn with a blank author: a card that says who wrote to you is
    only worth drawing when it actually knows.
  */
  it.each([
    ['not an object', 'Marcos: hola'],
    ['null', null],
    ['an array', [{ author: 'Marcos', text: 'hola' }]],
    ['no author', { text: 'hola' }],
    ['no text', { author: 'Marcos' }],
    ['a blank author', { author: '   ', text: 'hola' }],
    ['a blank text', { author: 'Marcos', text: '' }],
    ['a non-string author', { author: 42, text: 'hola' }],
  ])('drops %s', (_label, value) => {
    expect(asInbound(value)).toBeUndefined();
  });

  it('drops a time that is not a string, keeping the rest', () => {
    expect(asInbound({ author: 'Marcos', text: 'hola', at: 42 })).toEqual({
      author: 'Marcos',
      text: 'hola',
    });
  });

  /*
    Measuring the trimmed value and returning the untrimmed one admitted
    leading newlines, which under the card's `whitespace-pre-wrap` open the
    box with blank lines above the message.
  */
  it('returns the trimmed value, not merely a value that trims to something', () => {
    expect(asInbound({ author: '  Marcos  ', text: '\n\n\nhola\n' })).toEqual({
      author: 'Marcos',
      text: 'hola',
    });
  });

  /*
    Nothing else bounds a rider. `LEDGER_BODY_MAX` reads like it would and does
    not — `Ledger.append` measures it against the body alone — so an unbounded
    `text` reaches the JSONL, the renderer's capped mirror, and every IPC
    payload after it.
  */
  it('truncates an over-long text, visibly', () => {
    const kept = asInbound({ author: 'Marcos', text: 'x'.repeat(INBOUND_TEXT_MAX + 500) });

    expect(kept?.text).toHaveLength(INBOUND_TEXT_MAX + 1);
    expect(kept?.text.endsWith('…')).toBe(true);
  });

  it('cuts an over-long author and time to a name-sized bound', () => {
    const kept = asInbound({
      author: 'a'.repeat(INBOUND_NAME_MAX + 40),
      text: 'hola',
      at: 'b'.repeat(INBOUND_NAME_MAX + 40),
    });

    expect(kept?.author).toHaveLength(INBOUND_NAME_MAX + 1);
    expect(kept?.at).toHaveLength(INBOUND_NAME_MAX + 1);
  });

  /*
    Built from nothing, the way `honestPermissionAsk` builds its own meta: an
    allowlist is what stops the next model-supplied key riding in on a shape
    the card has certified.
  */
  it('carries no key the caller invented', () => {
    expect(
      asInbound({ author: 'Marcos', text: 'hola', permalink: 'https://example.invalid' }),
    ).toEqual({ author: 'Marcos', text: 'hola' });
  });
});

import { afterTarget, isHeld, releasesAfter } from '../../../electron/shared/ledger-derive';

/*
  Retro C: an ask can wait for a PR to merge. `meta.after: "owner/repo#N"`
  holds it until the shipper's `closed` entry for that PR is in the log.
*/
describe('held asks: meta.after (retro C)', () => {
  const ask = (after?: unknown, id = 'a1'): LedgerEntry =>
    entry({ id, kind: 'ask', to: 'builder', ...(after === undefined ? {} : { meta: { after } }) });
  const closed = (pr: unknown, repo: unknown, stage: unknown = 'closed'): LedgerEntry =>
    entry({ id: `c-${String(pr)}-${String(repo)}`, from: 'shipper', meta: { stage, pr, repo } });

  it('parses owner/repo#N and nothing else', () => {
    expect(afterTarget(ask('a/b#3'))).toEqual({ repo: 'a/b', pr: 3 });
    expect(afterTarget(ask('yunidbauza/the-hive#256'))).toEqual({ repo: 'yunidbauza/the-hive', pr: 256 });
    for (const bad of ['a/b', '#3', 3, 'a/b#0', 'a/b#x', 'ab#3', 'a/b/c#3', '', null]) {
      expect(afterTarget(ask(bad))).toBeUndefined();
    }
    expect(afterTarget(ask())).toBeUndefined();
  });

  it('holds an ask while its PR has no closed entry', () => {
    const held = ask('a/b#3');
    expect(isHeld(held, [held])).toBe(true);
  });

  it('releases it on the closed entry for that PR, by whole slug, case-insensitively', () => {
    const held = ask('a/b#3');
    expect(releasesAfter(closed(3, 'a/b'), { repo: 'a/b', pr: 3 })).toBe(true);
    expect(isHeld(held, [held, closed(3, 'a/b')])).toBe(false);
    expect(isHeld(held, [held, closed(3, 'A/B')])).toBe(false);
  });

  it('is not released by another PR, another repo, or another stage', () => {
    const held = ask('a/b#3');
    expect(isHeld(held, [held, closed(4, 'a/b'), closed(3, 'a/c'), closed(3, 'a/b', 'merge'), closed('4', 'a/b'), closed('3.0', 'a/b'), closed('#3', 'a/b')])).toBe(true);
  });

  /*
    `meta` is model-written, and `"pr": "3"` is one token away from `"pr": 3`.
    Read the way `shipStageFor` reads it, through `wholeNumberOf`, so the merge
    that happened releases the ask instead of leaving it held for seven days.
  */
  it('is released by a closed entry that wrote the PR as its digits', () => {
    const held = ask('a/b#3');
    expect(releasesAfter(closed('3', 'a/b'), { repo: 'a/b', pr: 3 })).toBe(true);
    expect(isHeld(held, [held, closed('3', 'a/b')])).toBe(false);
  });

  it('never holds an ask without after, or an entry that is not an ask', () => {
    expect(isHeld(ask(), [ask()])).toBe(false);
    const post = entry({ id: 'p1', meta: { after: 'a/b#3' } });
    expect(isHeld(post, [post])).toBe(false);
  });
});

/*
  Retro C, from the Task 2 review: a held ask must not expire while it waits.
  A chain whose earlier PR sits a day in review would otherwise lose the next
  job without a word. Held, it does not age; released, it ages from then.
*/
describe('a held ask does not age until its PR merges (retro C)', () => {
  const held = entry({
    id: 'h1',
    kind: 'ask',
    to: 'builder',
    ts: NOW - 2 * LEDGER_ASK_TTL_MS,
    meta: { after: 'a/b#3' },
  });
  const closedAt = (ts: number): LedgerEntry =>
    entry({ id: 'c1', from: 'shipper', ts, meta: { stage: 'closed', pr: 3, repo: 'a/b' } });

  it('stays open and unexpired while its PR is open, for days', () => {
    expect(openAsks([held], NOW).map((ask) => ask.id)).toEqual(['h1']);
    expect(expiredAsks([held], NOW)).toEqual([]);
  });

  /*
    From the Task 3 review: a PR abandoned, handed back or mistyped writes no
    `closed` entry, and a held ask that never aged would stay open forever,
    its asker never told. Seven days held, and it expires like any other.
  */
  it('expires once it has waited seven days for a PR that never closed', () => {
    const stale = entry({
      id: 'h2',
      kind: 'ask',
      to: 'builder',
      ts: NOW - 7 * LEDGER_ASK_TTL_MS,
      meta: { after: 'a/b#9' },
    });

    expect(openAsks([stale], NOW)).toEqual([]);
    expect(expiredAsks([stale], NOW).map((ask) => ask.id)).toEqual(['h2']);
  });

  it('ages from its release, not from when it was posted', () => {
    const released = NOW - 1000;
    const log = [held, closedAt(released)];

    expect(openAsks(log, NOW).map((ask) => ask.id)).toEqual(['h1']);
    expect(expiredAsks(log, NOW)).toEqual([]);

    const later = released + LEDGER_ASK_TTL_MS;
    expect(openAsks(log, later)).toEqual([]);
    expect(expiredAsks(log, later).map((ask) => ask.id)).toEqual(['h1']);
  });

  it('ages from a release that wrote the PR as its digits', () => {
    const released = NOW - 1000;
    const digits = entry({
      id: 'c2',
      from: 'shipper',
      ts: released,
      meta: { stage: 'closed', pr: '3', repo: 'a/b' },
    });
    const later = released + LEDGER_ASK_TTL_MS;

    expect(openAsks([held, digits], later)).toEqual([]);
    expect(expiredAsks([held, digits], later).map((ask) => ask.id)).toEqual(['h1']);
  });

  it('leaves an ask without after aging from its post', () => {
    const plain = entry({ id: 'p1', kind: 'ask', to: 'builder', ts: NOW - LEDGER_ASK_TTL_MS });
    expect(openAsks([plain], NOW)).toEqual([]);
    expect(expiredAsks([plain], NOW).map((ask) => ask.id)).toEqual(['p1']);
  });
});

describe('laneOfRun (HIVE-186; shared since HIVE-188)', () => {
  const started = (run: string, lane?: string): LedgerEntry => ({
    id: `s-${run}`, ts: 0, from: 'builder', kind: 'event', body: 'run.started — ledger',
    meta: { run, trigger: 'ledger', kind: 'standing', ...(lane === undefined ? {} : { lane }) },
  });

  it('reads a run with no run.started, or no meta.lane, as standing', () => {
    expect(laneOfRun('builder', 'r9', [])).toBe('standing');
    expect(laneOfRun('builder', 'r1', [started('r1')])).toBe('standing');
    expect(laneOfRun('builder', undefined, [])).toBe('standing');
  });

  it('only trusts the agent\'s own run.started — first one wins', () => {
    const forged = { ...started('r1', 'thread:Z'), id: 'f', from: 'other' };
    expect(laneOfRun('builder', 'r1', [forged, started('r1', 'thread:A')])).toBe('thread:A');
  });
});

describe('closedAskThreads (HIVE-214)', () => {
  it('closes a thread on an answer, a done and a failed', () => {
    const closed = closedAskThreads([
      entry({ id: 'x1', kind: 'answer', thread: 'a1' }),
      entry({ id: 'x2', kind: 'done', thread: 'a2' }),
      entry({ id: 'x3', kind: 'failed', thread: 'a3' }),
      entry({ id: 'x4', kind: 'post', thread: 'a4' }),
    ]);

    expect([...closed].sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('closes a thread the overmind expired', () => {
    const expiry = entry({ id: 'e1', from: OVERMIND, kind: 'event', thread: 'a1', meta: { expired: 'a1' } });

    expect(closedAskThreads([expiry]).has('a1')).toBe(true);
  });

  it('ignores an expiry marker anyone else wrote', () => {
    const forged = entry({ id: 'e2', from: 'sess-9', kind: 'event', meta: { expired: 'a1' } });

    expect(closedAskThreads([forged]).has('a1')).toBe(false);
  });
});

describe('shipTrack (HIVE-205)', () => {
  const slug = 'acme/server';
  const MIN = 60_000;
  const at = (minutes: number) => NOW - 200 * MIN + minutes * MIN;
  const claim = entry({ id: 'c1', ts: at(0), from: 'shipper', kind: 'claim', meta: { task: 'Acme/Server#1182' } });
  const stage = (id: string, minutes: number, name: string) =>
    entry({ id, ts: at(minutes), from: 'shipper', body: name, meta: { pr: 1182, repo: slug, stage: name } });
  const askTo = (id: string, minutes: number, to: string, body: string, meta?: Record<string, unknown>) =>
    entry({ id, ts: at(minutes), from: 'shipper', kind: 'ask', to, body, ...(meta ? { meta } : {}) });
  const stop = (track: ReturnType<typeof shipTrack>, name: string) => track.stops.find((s) => s.stage === name)!;

  it('has all eight stops, in order, and nothing held with no entries', () => {
    const track = shipTrack([], slug, 1182, NOW);
    expect(track.stops.map((s) => s.stage)).toEqual([...SHIP_STOPS]);
    expect(track).toMatchObject({ held: false, current: null });
    expect(track.stops.every((s) => s.firstAt === null && s.spentMs === 0 && s.holder === null)).toBe(true);
  });

  it('walks forward: the claim opens intake, each post the next stop, the last runs to now', () => {
    const track = shipTrack([claim, stage('p1', 2, 'self-review'), stage('p2', 30, 'fix-self'), stage('p3', 56, 'ready'), stage('p4', 57, 'ci')], slug, 1182, at(100));
    expect(stop(track, 'intake')).toEqual({ stage: 'intake', firstAt: at(0), spentMs: 2 * MIN, holder: 'shipper' });
    expect(stop(track, 'self-review')).toMatchObject({ firstAt: at(2), spentMs: 28 * MIN });
    expect(stop(track, 'ci')).toMatchObject({ firstAt: at(57), spentMs: 43 * MIN });
    expect(track).toMatchObject({ held: true, current: { stage: 'ci' } });
    expect(stop(track, 'merge')).toEqual({ stage: 'merge', firstAt: null, spentMs: 0, holder: null });
  });

  it('steps back from approval to findings, summing the time at findings over both visits', () => {
    const track = shipTrack([claim, stage('p1', 10, 'findings'), stage('p2', 30, 'approval'), stage('p3', 40, 'findings')], slug, 1182, at(55));
    expect(stop(track, 'findings')).toMatchObject({ firstAt: at(10), spentMs: (20 + 15) * MIN });
    expect(stop(track, 'approval')).toMatchObject({ spentMs: 10 * MIN });
    expect(track.current?.stage).toBe('findings');
  });

  it('takes the holder from an ask to acr or fixer naming the PR in meta or in its words', () => {
    const track = shipTrack([
      claim,
      stage('p1', 2, 'self-review'),
      askTo('a1', 2, 'acr', 'Review https://github.com/acme/server/pull/1182 --self'),
      stage('p2', 30, 'fix-self'),
      askTo('a2', 30, 'fixer', 'Fix these', { pr: 1182, repo: slug }),
      stage('p3', 56, 'ready'),
    ], slug, 1182, at(60));
    expect(stop(track, 'self-review').holder).toBe('acr');
    expect(stop(track, 'fix-self').holder).toBe('fixer');
    expect(stop(track, 'ready').holder).toBe('shipper');
  });

  it('ignores an ask for another PR in the same window, and a number that only starts the same', () => {
    const track = shipTrack([
      claim,
      stage('p1', 10, 'findings'),
      askTo('a1', 11, 'fixer', 'acme/server#11820 has findings'),
      askTo('a2', 12, 'fixer', 'acme/other#1182 has findings'),
      askTo('a3', 13, 'fixer', 'xacme/server#1182 is not this one'),
    ], slug, 1182, at(20));
    expect(stop(track, 'findings').holder).toBe('shipper');
  });

  it('ends on a release or a closed post, keeping the times', () => {
    const release = entry({ id: 'r1', ts: at(20), from: 'shipper', kind: 'release', meta: { task: 'acme/server#1182' } });
    const released = shipTrack([claim, stage('p1', 10, 'ci'), release], slug, 1182, at(90));
    expect(released).toMatchObject({ held: false, current: null });
    expect(stop(released, 'ci').spentMs).toBe(10 * MIN);

    const closed = shipTrack([claim, stage('p1', 10, 'merge'), stage('p2', 12, 'closed')], slug, 1182, at(90));
    expect(closed).toMatchObject({ held: false, current: null });
    expect(stop(closed, 'merge')).toMatchObject({ firstAt: at(10), spentMs: 2 * MIN });
  });

  it('reads only the shipper, only this repo, and holds an unknown stage word without a stop', () => {
    const track = shipTrack([
      entry({ id: 'x1', ts: at(1), from: 'drone', meta: { pr: 1182, repo: slug, stage: 'ci' } }),
      entry({ id: 'x2', ts: at(1), from: 'shipper', meta: { pr: 1182, repo: 'other/server', stage: 'ci' } }),
      stage('p1', 3, 'sync'),
    ], slug, 1182, at(10));
    expect(track).toMatchObject({ held: true, current: null });
    expect(track.stops.every((s) => s.firstAt === null)).toBe(true);
    expect(shipTrack([claim], '', 1182, at(10)).held).toBe(false);
  });

  it('returns its visits oldest first, the open one with no end (HIVE-208)', () => {
    const track = shipTrack([claim, stage('p1', 2, 'self-review'), askTo('a1', 3, 'acr', 'https://github.com/acme/server/pull/1182 --self'), stage('p2', 30, 'fix-self')], slug, 1182, at(40));
    expect(track.visits).toEqual([
      { stage: 'intake', from: at(0), to: at(2), holder: null },
      { stage: 'self-review', from: at(2), to: at(30), holder: 'acr' },
      { stage: 'fix-self', from: at(30), to: null, holder: null },
    ]);
    expect(shipTrack([], slug, 1182, NOW).visits).toEqual([]);
  });
});

describe('the PR page readings (HIVE-205)', () => {
  const slug = 'acme/server';
  const log = [
    entry({ id: 'i1', ts: 1, from: 'builder', kind: 'ask', to: 'shipper', body: 'Ship it', meta: { pr: 1182, repo: slug, ticket: 'INCORP-598', stage: 'intake' } }),
    entry({ id: 'i2', ts: 2, from: 'sess-b', kind: 'ask', to: 'shipper', body: 'Ship mine', meta: { pr: 7, repo: slug, stage: 'intake' } }),
    entry({ id: 'f1', ts: 3, from: 'fixer', kind: 'claim', meta: { task: 'acme/server#1182 findings' } }),
    entry({ id: 'f2', ts: 4, from: 'fixer', body: 'On it: acme/server#1182 finding 1, the registered agent' }),
    entry({ id: 'f3', ts: 5, from: 'fixer', body: 'acme/server#7 is clean' }),
    entry({ id: 'r1', ts: 6, from: 'acr', kind: 'answer', body: 'changes requested', meta: { review_url: 'https://github.com/acme/server/pull/1182#pullrequestreview-7' } }),
    entry({ id: 'r2', ts: 7, from: 'sess-a', body: 'x', meta: { review_url: 'https://github.com/acme/server/pull/1182#pullrequestreview-9' } }),
    entry({ id: 'f4', ts: 8, from: 'fixer', body: 'Pushed the fix for acme/server#1182' }),
  ];

  it('prEvents: every entry naming the PR, oldest first', () => {
    expect(prEvents(log, slug, 1182).map((e) => e.id)).toEqual(['i1', 'f1', 'f2', 'f4']);
    expect(prEvents(log, '', 1182)).toEqual([]);
  });

  it('reviewUrls: acr’s review URLs only', () => {
    expect([...reviewUrls(log)]).toEqual(['https://github.com/acme/server/pull/1182#pullrequestreview-7']);
  });

  it('prOpener: who handed the PR to the shipper, or null', () => {
    expect(prOpener(log, slug, 1182)).toBe('builder');
    expect(prOpener(log, 'ACME/Server', 7)).toBe('sess-b');
    expect(prOpener(log, slug, 99)).toBeNull();
  });

  it('holderPost: the holder’s newest entry naming the PR', () => {
    expect(holderPost(log, slug, 1182, 'fixer')?.id).toBe('f4');
    expect(holderPost(log, slug, 1182, 'acr')).toBeNull();
    expect(holderPost(log, '', 1182, 'fixer')).toBeNull();
  });
});

describe('delegatesOf (idle with agents)', () => {
  const AGENTS = new Set(['shipper', 'fixer', 'acr', 'builder', 'pr-patrol-nightly']);
  const isAgent = (id: string) => AGENTS.has(id);
  const ask = (id: string, from: string, to: string, meta?: Record<string, unknown>) =>
    entry({ id, from, to, kind: 'ask', body: 'job', ...(meta === undefined ? {} : { meta }) });
  const of = (log: LedgerEntry[], party = 'sess-a') => delegatesOf(openAsks(log, NOW), log, party, isAgent);

  it('names the agents the session asked, once each, in the order it asked', () => {
    const log = [
      ask('a1', 'sess-a', 'shipper', { pr: 106, repo: 'behiques/hivetty' }),
      ask('a2', 'sess-a', 'builder', { ticket: 'HIVE-9' }),
      ask('a3', 'sess-a', 'shipper', { pr: 107, repo: 'behiques/hivetty' }),
    ];
    expect(of(log).map((d) => d.agent)).toEqual(['shipper', 'builder']);
  });

  it('drops a closed ask, an ask to a session or the overmind, and another party\'s ask', () => {
    const log = [
      ask('a1', 'sess-a', 'shipper'),
      entry({ id: 'd1', from: 'shipper', kind: 'done', body: 'merged', thread: 'a1' }),
      ask('a2', 'sess-a', 'sess-b'),
      ask('a3', 'sess-a', OVERMIND),
      ask('a4', 'sess-b', 'fixer'),
    ];
    expect(of(log)).toEqual([]);
  });

  it('counts a held ask only once its PR has closed', () => {
    const held = ask('a1', 'sess-a', 'builder', { after: 'behiques/hivetty#108' });
    expect(of([held])).toEqual([]);
    const closed = entry({ id: 'c1', from: 'shipper', body: 'closed', meta: { pr: 108, repo: 'behiques/hivetty', stage: 'closed' } });
    expect(of([held, closed]).map((d) => d.agent)).toEqual(['builder']);
  });

  it('lists the helpers an agent brought in for the same PR or ticket, and no other job\'s', () => {
    const log = [
      ask('a1', 'sess-a', 'shipper', { pr: 106, repo: 'behiques/hivetty' }),
      ask('s1', 'shipper', 'acr', { pr: 106, repo: 'Behiques/Hivetty' }),
      ask('s2', 'shipper', 'fixer', { pr: 106, repo: 'behiques/hivetty' }),
      ask('s3', 'shipper', 'acr', { pr: 99, repo: 'behiques/hivetty' }),
      ask('s4', 'shipper', 'sess-a', { pr: 106, repo: 'behiques/hivetty' }),
    ];
    expect(of(log)).toEqual([{ agent: 'shipper', helpers: ['acr', 'fixer'] }]);
  });
});
