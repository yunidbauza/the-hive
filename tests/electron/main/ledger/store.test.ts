// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLedgerStore, type LedgerStore } from '../../../../electron/main/ledger/store';

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
    expect(post.ref).toBeUndefined();

    const next = store.append({ from: 'sess-a', kind: 'ask', body: 'again?' });
    expect(next.ref).toBe('a2');
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

    const reopened = createLedgerStore({ dir, now: () => clock });

    expect(reopened.all().map((entry) => entry.body)).toEqual(['good']);
    expect(reopened.malformed()).toEqual(['not json']);
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
