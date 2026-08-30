// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLedger, type Ledger } from '../../../../electron/main/ledger/index';

/**
 * A disk write that fails (HIVE-111 ship review).
 *
 * Its own file because `node:fs` has to be mocked for the whole module graph,
 * and `index.test.ts` needs the real one — the same reason `guards.*.test.ts`
 * is several files rather than one.
 *
 * ENOSPC and EACCES are the realistic causes: a full disk, or a `~/.hive` the
 * user moved or chmod-ed out from under the app. Before this, `appendFileSync`
 * threw straight out through `store.append` and `ledger.append`, reaching the
 * HTTP caller as a bare `500` with no body and the IPC caller as a rejected
 * promise — while `LedgerResult` is a value type *precisely* so that both
 * boundaries can hand a model a reason it can read and act on.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: (...args: unknown[]) => {
      if (String(args[0]).endsWith('.jsonl')) {
        const failure = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
        failure.code = 'ENOSPC';
        throw failure;
      }
      return (actual.appendFileSync as (...rest: unknown[]) => void)(...args);
    },
  };
});

describe('createLedger when the disk write fails', () => {
  let dir: string;
  let ledger: Ledger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-ledger-io-'));
    ledger = createLedger({ dir, knowsParty: () => true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses with a reason naming the cause instead of throwing', () => {
    const result = ledger.append({ from: 'sess-a', kind: 'post', body: 'hello' });

    expect(result).toMatchObject({ ok: false, status: 500 });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toContain('ENOSPC');
  });

  it('keeps the failed entry out of memory as well as off disk', () => {
    ledger.append({ from: 'sess-a', kind: 'post', body: 'hello' });

    // A ledger whose reader and writer disagree about what happened has
    // stopped being a ledger — a write nobody kept must not be readable.
    expect(ledger.read({}).entries).toEqual([]);
  });

  it('does not notify listeners about a write that failed', () => {
    const seen: string[] = [];
    ledger.onChange((entry) => seen.push(entry.id));

    ledger.append({ from: 'sess-a', kind: 'post', body: 'hello' });

    expect(seen).toEqual([]);
  });
});
