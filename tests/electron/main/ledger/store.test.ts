// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLedgerStore, type LedgerStore } from '../../../../electron/main/ledger/store';

/**
 * Pinned, because one of the specs below is *about* a timezone.
 *
 * `vitest.config.ts` sets no `TZ` and this repo has no CI, so the suite runs
 * in whatever zone the developer's machine is in. Under UTC — which has no
 * DST — the spring-forward regression test passes against the naive
 * `ms - 24h` implementation it exists to catch, so it proved nothing on a
 * host set to UTC and everything on one set to New York. A regression test
 * that only fails on some laptops is not one.
 *
 * Set before `AT` is computed, so every local-time instant in this file is
 * built in the same zone the assertions reason about.
 */
const HOST_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

afterAll(() => {
  if (HOST_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = HOST_TZ;
});

/** 2026-08-28 14:15:30 local. */
const AT = new Date(2026, 7, 28, 14, 15, 30).getTime();

describe('ledger store', () => {
  let dir: string;
  let clock: number;
  let store: LedgerStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-ledger-'));
    clock = AT;
    store = createLedgerStore({ dir, now: () => clock });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const file = (day: string): string => readFileSync(join(dir, `${day}.jsonl`), 'utf8');

  it('appends one JSON line per entry into a file named for the day', () => {
    store.append({ from: 'sess-a', kind: 'post', body: 'hello' });

    const lines = file('2026-08-28').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      id: '20260828-141530-0001',
      ts: AT,
      from: 'sess-a',
      kind: 'post',
      body: 'hello',
    });
  });

  it('gives two appends in the same second ids that sort in write order', () => {
    const first = store.append({ from: 'sess-a', kind: 'post', body: 'one' });
    const second = store.append({ from: 'sess-a', kind: 'post', body: 'two' });

    expect(first.id).toBe('20260828-141530-0001');
    expect(second.id).toBe('20260828-141530-0002');
    expect(first.id < second.id).toBe(true);
  });

  it('restarts the sequence on a new second, still sorting forward', () => {
    const first = store.append({ from: 'sess-a', kind: 'post', body: 'one' });
    clock += 1_000;
    const second = store.append({ from: 'sess-a', kind: 'post', body: 'two' });

    expect(second.id).toBe('20260828-141531-0001');
    expect(first.id < second.id).toBe(true);
  });

  it('allocates a ref for an ask and none for anything else', () => {
    const ask = store.append({ from: 'sess-a', kind: 'ask', to: 'overmind', body: 'ship?' });
    const post = store.append({ from: 'sess-a', kind: 'post', body: 'fyi' });

    expect(ask.ref).toBe('a1');
    expect('ref' in post).toBe(false);

    const next = store.append({ from: 'sess-a', kind: 'ask', body: 'again?' });
    expect(next.ref).toBe('a2');
  });

  it('does not reissue a colliding id after a restart within the same second', () => {
    store.append({ from: 'sess-a', kind: 'post', body: 'one' });
    store.append({ from: 'sess-a', kind: 'post', body: 'two' });

    const restarted = createLedgerStore({ dir, now: () => clock });
    const third = restarted.append({ from: 'sess-a', kind: 'post', body: 'three' });

    const ids = restarted.all().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(third.id).toBe('20260828-141530-0003');
  });

  it('loads yesterday correctly across a spring-forward boundary', () => {
    // 2026-03-08: DST starts in America/New_York, 01:59:59 -> 03:00:00 local,
    // so this calendar day is only 23 real hours long.
    clock = new Date(2026, 2, 8, 10, 0, 0).getTime();
    store.append({ from: 'sess-a', kind: 'post', body: 'dst-day' });

    // Just after local midnight the next day — a naive `ms - 24h` yesterday
    // calculation lands on 2026-03-07 instead of the true 2026-03-08.
    clock = new Date(2026, 2, 9, 0, 30, 0).getTime();
    const reopened = createLedgerStore({ dir, now: () => clock });

    expect(reopened.all().map((entry) => entry.body)).toEqual(['dst-day']);
  });

  it('opens a new file when the day rolls over', () => {
    store.append({ from: 'sess-a', kind: 'post', body: 'today' });
    clock = new Date(2026, 7, 29, 9, 0, 0).getTime();
    store.append({ from: 'sess-a', kind: 'post', body: 'tomorrow' });

    expect(file('2026-08-28')).toContain('today');
    expect(file('2026-08-29')).toContain('tomorrow');
  });

  it('reads today and yesterday back on a second launch', () => {
    store.append({ from: 'sess-a', kind: 'post', body: 'yesterday' });
    clock = new Date(2026, 7, 29, 9, 0, 0).getTime();
    store.append({ from: 'sess-a', kind: 'post', body: 'today' });

    const reopened = createLedgerStore({ dir, now: () => clock });

    expect(reopened.all().map((entry) => entry.body)).toEqual(['yesterday', 'today']);
  });

  it('skips a malformed line and reports it rather than failing to load', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-08-28.jsonl'),
      `{"id":"20260828-100000-0001","ts":1,"from":"sess-a","kind":"post","body":"good"}\nnot json\n`,
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reopened = createLedgerStore({ dir, now: () => clock });

    expect(reopened.all().map((entry) => entry.body)).toEqual(['good']);
    expect(reopened.malformed()).toEqual(['not json']);
    /*
      "Reported" has to mean something a person can see: `malformed()` is read
      by nothing in the app, so without this the user's hand-edit — this is a
      file they are invited to open — vanishes silently.
    */
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2026-08-28.jsonl'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped 1'));
    // The body itself is correspondence and stays out of the log.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('not json'));
    warn.mockRestore();
  });

  /**
   * Parsing is not validating.
   *
   * `null`, `123` and `"x"` are all valid JSON, and the old loader pushed each
   * of them straight into `entries`. That is not a cosmetic wrong: the
   * sequence reseed reads `newest.id`, so a bare number sorting last threw
   * inside the constructor — and `createLedgerStore` runs inside
   * `createLedger`, which runs inside `registerIpcHandlers()` unguarded at
   * startup, so the app would have booted with **no IPC handlers at all**.
   * A `null` survived construction and threw later, in `openAsks`, on
   * `entry.kind`. This is a file the user is invited to open and edit, which
   * is exactly how such a line arrives.
   */
  it('skips a line that parses but is not an entry, and still constructs', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-08-28.jsonl'),
      [
        '{"id":"20260828-100000-0001","ts":1,"from":"sess-a","kind":"post","body":"good"}',
        'null',
        '123',
        '"just some text"',
        '{"ts":2,"from":"sess-a","kind":"post","body":"no id"}',
        '{"id":"20260828-100000-0003","ts":"soon","from":"sess-a","kind":"post","body":"ts"}',
        '{"id":"20260828-100000-0004","ts":4,"from":"sess-a","kind":"nonsense","body":"kind"}',
        '',
      ].join('\n'),
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reopened = createLedgerStore({ dir, now: () => clock });

    expect(reopened.all().map((entry) => entry.body)).toEqual(['good']);
    // Counted and warned about through the same path a parse failure takes.
    expect(reopened.malformed()).toHaveLength(6);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped 6'));
    warn.mockRestore();
  });

  /**
   * The rider that bites is `ref` (HIVE-111 re-review).
   *
   * `nextRef` calls `entry.ref.startsWith(...)` over every loaded entry each
   * time an `ask` is appended, so a hand-edited `"ref": 3` reaches it and
   * throws a `TypeError`. That throw is now caught and turned into a refusal,
   * which makes the symptom *worse* to diagnose rather than better: every ask
   * would come back `500 could not write the ledger` until the user found the
   * line themselves. The subsequent successful ask is the real assertion here
   * — it proves the poisoned line never reached `nextRef`.
   */
  it.each([
    ['ref', '{"id":"20260828-100000-0002","ts":2,"from":"sess-a","kind":"ask","body":"q","ref":3}'],
    [
      'to',
      '{"id":"20260828-100000-0002","ts":2,"from":"sess-a","kind":"post","body":"q","to":null}',
    ],
    [
      'thread',
      '{"id":"20260828-100000-0002","ts":2,"from":"sess-a","kind":"post","body":"q","thread":7}',
    ],
  ])('skips a line whose `%s` is not a string, and keeps appending', (_field, line) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-08-28.jsonl'),
      `{"id":"20260828-100000-0001","ts":1,"from":"sess-a","kind":"ask","body":"good","ref":"a1"}\n${line}\n`,
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reopened = createLedgerStore({ dir, now: () => clock });

    expect(reopened.all().map((entry) => entry.body)).toEqual(['good']);
    // Counted and warned about through the same path every other shape
    // failure takes, so a hand-edit never vanishes silently.
    expect(reopened.malformed()).toEqual([line]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped 1'));

    // The ask that used to throw: `nextRef` still sees only the good entry,
    // so it allocates the next ref rather than blowing up on the bad one.
    expect(reopened.append({ from: 'sess-a', kind: 'ask', body: 'next?' }).ref).toBe('a2');
    warn.mockRestore();
  });

  /**
   * A read that fails for a reason other than "no such file" is not an empty
   * day. Booting empty would also leave the sequence at 0 while the file on
   * disk already holds ids for this second — the exact duplicate-id failure
   * the reseed exists to prevent — so it has to be said out loud. A directory
   * where a file belongs gives a real EISDIR without mocking `fs`.
   */
  it('warns rather than silently booting empty when a day file cannot be read', () => {
    mkdirSync(join(dir, '2026-08-28.jsonl'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reopened = createLedgerStore({ dir, now: () => clock });

    expect(reopened.all()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2026-08-28.jsonl'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('collide'));
    warn.mockRestore();
  });

  /**
   * `Number('xxxx')` is `NaN` and `pad(NaN, 4)` is `'0NaN'` — an id that is
   * neither unique nor sortable, which breaks `since`, `resolveRef` and
   * `thread` at once, permanently, in an append-only file.
   */
  it('falls back to sequence 0 when the newest id has an unparseable tail', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-08-28.jsonl'),
      '{"id":"20260828-141530-xxxx","ts":1,"from":"sess-a","kind":"post","body":"hand edited"}\n',
      'utf8',
    );

    const reopened = createLedgerStore({ dir, now: () => clock });

    expect(reopened.append({ from: 'sess-a', kind: 'post', body: 'after' }).id).toBe(
      '20260828-141530-0001',
    );
  });

  it('says nothing when every line parses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.append({ from: 'sess-a', kind: 'post', body: 'one' });

    createLedgerStore({ dir, now: () => clock });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('notifies listeners with the stored entry', () => {
    const seen: string[] = [];
    const off = store.onChange((entry) => seen.push(entry.id));

    store.append({ from: 'sess-a', kind: 'post', body: 'one' });
    off();
    store.append({ from: 'sess-a', kind: 'post', body: 'two' });

    expect(seen).toEqual(['20260828-141530-0001']);
  });
});
