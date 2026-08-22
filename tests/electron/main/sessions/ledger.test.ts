import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HISTORY_CAP } from '../../../../electron/shared/session-history-contract';
import {
  createSessionLedger,
  readLedger,
} from '../../../../electron/main/sessions/ledger';

/**
 * The ledger (HIVE-87).
 *
 * These tests use a **real temporary directory** rather than a mocked `fs`, for
 * the reason `tests/electron/main/config/index.test.ts` gives: nothing is
 * spawned and nothing outlives the test, so the objection AGENTS.md raises
 * against a real `node-pty` does not apply. The module takes a path rather than
 * calling `app.getPath` itself, so no Electron mock is needed either.
 *
 * The posture under test is **lenient**, deliberately, and half of these cases
 * exist to pin that: a ledger that could throw on a corrupt file would be a
 * ledger that can stop the app from opening, which is a far worse bug than
 * losing a page of history.
 */
describe('session ledger', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-ledger-'));
    file = join(dir, 'sessions.json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('writing', () => {
    it('round-trips a record', () => {
      const ledger = createSessionLedger(file, () => 1000);
      ledger.record('sess-01', {
        project: 'the-hive',
        task: '',
        status: 'working',
      });
      ledger.flush();

      expect(readLedger(file)).toEqual([
        {
          id: 'sess-01',
          project: 'the-hive',
          task: '',
          status: 'working',
          createdAt: 1000,
        },
      ]);
    });

    it('merges a patch into the existing record rather than appending', () => {
      // Every call site sends a fragment — spawn knows the uuid, publishBranch
      // knows the branch, settleExit knows the ending. One row, four writers.
      const ledger = createSessionLedger(file, () => 1000);
      ledger.record('sess-01', {
        project: 'the-hive',
        task: '',
        status: 'working',
      });
      ledger.record('sess-01', { branch: 'feat/x', cwd: '/tmp/x' });
      ledger.record('sess-01', { status: 'terminated', endedAt: 2000 });
      ledger.flush();

      const records = readLedger(file);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        id: 'sess-01',
        branch: 'feat/x',
        cwd: '/tmp/x',
        status: 'terminated',
        endedAt: 2000,
        createdAt: 1000,
      });
    });

    it('keeps createdAt from the first write, not the last', () => {
      let clock = 1000;
      const ledger = createSessionLedger(file, () => clock);
      ledger.record('sess-01', {
        project: 'p',
        task: '',
        status: 'working',
      });
      clock = 9999;
      ledger.record('sess-01', { branch: 'main' });
      ledger.flush();

      expect(readLedger(file)[0]?.createdAt).toBe(1000);
    });

    it('exposes what it holds without going through the file', () => {
      const ledger = createSessionLedger(file, () => 1);
      ledger.record('sess-01', { project: 'p', task: '', status: 'idle' });

      expect(ledger.all().map((record) => record.id)).toEqual(['sess-01']);
    });
  });

  /**
   * The second launch — the case every other test here was blind to.
   *
   * Each of them builds a fresh ledger over a fresh temp file, which is the one
   * arrangement where "the ledger does not load the file" cannot be observed.
   * The first draft of this module did exactly that, and the cost was not
   * merely a missing feature: an unseeded ledger answers `session:history` with
   * nothing and then writes that nothing back, so the *second* launch after any
   * session erased the first launch's history. `session-history.spec.ts` caught
   * it by quitting a real app; these are the unit tests that should have.
   */
  describe('reopening an existing ledger', () => {
    const seed = () => {
      const first = createSessionLedger(file, () => 1000);
      first.begin('sess-01', {
        project: 'the-hive',
        task: '',
        sessionUuid: 'abc',
      });
      first.flush();
    };

    it('starts holding what the file already held', () => {
      seed();

      expect(createSessionLedger(file, () => 2000).all()).toEqual([
        {
          id: 'sess-01',
          project: 'the-hive',
          task: '',
          status: 'working',
          sessionUuid: 'abc',
          createdAt: 1000,
          /*
            Stamped on load, because a record on disk cannot describe a running
            process — and stamped with the *load* clock (2000 here), not the
            spawn time, so the session left open at the quit ranks as the newest
            ending rather than the oldest. See "what counts as ended" below for
            what the other choice cost.
          */
          endedAt: 2000,
        },
      ]);
    });

    it('does not erase the file when it writes without recording anything', () => {
      // The destructive half. A launch that touches no session must leave the
      // previous launch's history exactly where it was.
      seed();

      createSessionLedger(file, () => 2000).flush();

      expect(readLedger(file).map((record) => record.id)).toEqual(['sess-01']);
    });

    it('merges a new run into the old records rather than replacing them', () => {
      seed();

      const second = createSessionLedger(file, () => 2000);
      second.record('sess-02', { project: 'p', task: '', status: 'working' });
      second.flush();

      expect(readLedger(file).map((record) => record.id).sort()).toEqual([
        'sess-01',
        'sess-02',
      ]);
    });

    it('keeps the original createdAt when an old record is patched again', () => {
      seed();

      const second = createSessionLedger(file, () => 2000);
      second.record('sess-01', { status: 'terminated', endedAt: 3000 });
      second.flush();

      expect(readLedger(file)[0]).toMatchObject({
        createdAt: 1000,
        endedAt: 3000,
        status: 'terminated',
      });
    });
  });

  /**
   * The two ways a record's "is it over?" answer went wrong (HIVE-87 review).
   *
   * `hasEnded` keys off `endedAt`, and both of these are about that timestamp
   * being present when it should not be, or absent when it must not be. Each
   * one, left alone, breaks the cap in the opposite direction: the first exempts
   * a dead record forever, the second condemns a live one.
   */
  describe('what counts as ended', () => {
    it('stamps a loaded record that still claims to be running', () => {
      // Nothing on disk can describe a live process — it died with the app that
      // wrote it. Without a timestamp such a record is exempt from the cap for
      // ever, and every crashy launch adds another.
      writeFileSync(
        file,
        JSON.stringify([
          { id: 'sess-01', project: 'p', task: '', status: 'working', createdAt: 500 },
        ]),
        'utf8',
      );

      const [record] = createSessionLedger(file, () => 9000).all();
      // Stamped at load, not at spawn — see the next test for why that matters.
      expect(record?.endedAt).toBe(9000);
      // The status is untouched: the renderer needs to see `working` to infer
      // `closed`.
      expect(record?.status).toBe('working');
    });

    it('ranks the session left open at quit as the newest ending, not the oldest', () => {
      /**
       * The cap keeps the newest `HISTORY_CAP` endings. Stamping a live-at-quit
       * record with its *spawn* time sorts it below every throwaway that ended
       * after it — so the one row the user actually wants back is the first one
       * evicted. A session opened at 09:00 and worked in all day loses to twenty
       * sessions that ended at lunchtime.
       */
      const openedEarly = {
        id: 'worked-in-all-day',
        project: 'p',
        task: '',
        status: 'working',
        createdAt: 1,
      };
      const throwaways = Array.from({ length: HISTORY_CAP }, (_, i) => ({
        id: `throwaway-${i}`,
        project: 'p',
        task: '',
        status: 'terminated',
        createdAt: 10 + i,
        endedAt: 100 + i,
      }));
      writeFileSync(file, JSON.stringify([openedEarly, ...throwaways]), 'utf8');

      const ledger = createSessionLedger(file, () => 9000);
      ledger.flush();

      const ids = readLedger(file).map((record) => record.id);
      expect(ids).toContain('worked-in-all-day');
      expect(ids).toHaveLength(HISTORY_CAP);
    });

    it('does not restamp a record that already ended', () => {
      writeFileSync(
        file,
        JSON.stringify([
          {
            id: 'sess-01',
            project: 'p',
            task: '',
            status: 'terminated',
            createdAt: 500,
            endedAt: 700,
          },
        ]),
        'utf8',
      );

      expect(createSessionLedger(file, () => 9000).all()[0]?.endedAt).toBe(700);
    });

    it('caps records the previous run left claiming to be live', () => {
      // The whole point of the stamp: they are ended, so the cap reaches them.
      const stale = Array.from({ length: HISTORY_CAP + 5 }, (_, i) => ({
        id: `old-${i}`,
        project: 'p',
        task: '',
        status: 'working',
        createdAt: i,
      }));
      writeFileSync(file, JSON.stringify(stale), 'utf8');

      const ledger = createSessionLedger(file, () => 9000);
      ledger.flush();

      expect(readLedger(file)).toHaveLength(HISTORY_CAP);
    });

    it('leaves liveness to begin — a patch only adds what it carries', () => {
      /**
       * `record` deliberately does **not** clear an ending when a patch happens
       * to carry a live status. An earlier draft did, to catch the restart case,
       * and `begin` owns that now.
       *
       * Removing it was not merely tidying. Records loaded from disk are stamped
       * with an `endedAt` *so the cap can reach them*, and a live status routed
       * through `record` would have stripped that stamp straight back off —
       * re-creating the "exempt from the cap forever" growth the stamp exists to
       * prevent. One verb decides liveness.
       */
      const ledger = createSessionLedger(file, () => 1000);
      ledger.begin('sess-01', { project: 'p', task: '' });
      ledger.record('sess-01', { status: 'terminated', endedAt: 2000 });

      ledger.record('sess-01', { status: 'working' });
      ledger.flush();

      const [record] = readLedger(file);
      expect(record?.status).toBe('working');
      expect(record?.endedAt).toBe(2000);
    });

    it('keeps an ending the caller states explicitly alongside a status', () => {
      const ledger = createSessionLedger(file, () => 1000);
      ledger.record('sess-01', { project: 'p', task: '', status: 'working' });
      ledger.record('sess-01', { status: 'done', endedAt: 4000 });
      ledger.flush();

      expect(readLedger(file)[0]?.endedAt).toBe(4000);
    });
  });

  /**
   * Starting a session, as distinct from patching one (HIVE-87 review).
   *
   * Entity ids are reused across a restart, so `begin` has to tell two cases
   * apart that arrive through the same code path: a restart, which keeps what
   * the row has learned, and a spawn that happens to take an id the *previous*
   * run used, which must keep none of it.
   */
  describe('begin', () => {
    it('keeps nothing from a record the previous run left behind', () => {
      // The corruption this exists to stop: a brand-new session advertising a
      // branch and a ticket belonging to a session it never was.
      writeFileSync(
        file,
        JSON.stringify([
          {
            id: 'sess-01',
            project: 'old-project',
            task: 'old task',
            status: 'terminated',
            createdAt: 100,
            endedAt: 200,
            branch: 'feat/old',
            cwd: '/old',
            ticket: 'HIVE-1',
            name: 'old-name',
            sessionUuid: 'old-uuid',
          },
        ]),
        'utf8',
      );

      const ledger = createSessionLedger(file, () => 5000);
      ledger.begin('sess-01', {
        project: 'new-project',
        task: '',
        sessionUuid: 'new-uuid',
      });
      ledger.flush();

      const [record] = readLedger(file);
      expect(record).toMatchObject({
        project: 'new-project',
        sessionUuid: 'new-uuid',
        status: 'working',
        createdAt: 5000,
      });
      expect(record?.branch).toBeUndefined();
      expect(record?.cwd).toBeUndefined();
      expect(record?.ticket).toBeUndefined();
      expect(record?.name).toBeUndefined();
      expect(record?.endedAt).toBeUndefined();
    });

    it('keeps what a restart has already learned this run', () => {
      // Same session, new process. Its ticket and branch did not change because
      // the agent was restarted.
      const ledger = createSessionLedger(file, () => 1000);
      ledger.begin('sess-01', { project: 'p', task: '', sessionUuid: 'first' });
      ledger.record('sess-01', {
        branch: 'feat/x',
        cwd: '/repo',
        ticket: 'HIVE-87',
        name: 'worker',
      });
      ledger.record('sess-01', { status: 'terminated', endedAt: 2000 });

      ledger.begin('sess-01', { project: 'p', task: '', sessionUuid: 'second' });
      ledger.flush();

      expect(readLedger(file)[0]).toMatchObject({
        branch: 'feat/x',
        cwd: '/repo',
        ticket: 'HIVE-87',
        name: 'worker',
        sessionUuid: 'second',
        status: 'working',
        createdAt: 1000,
      });
      expect(readLedger(file)[0]?.endedAt).toBeUndefined();
    });

    it('clears the previous generation ending so a restart is not prunable', () => {
      const ledger = createSessionLedger(file, () => 1000);
      ledger.begin('sess-01', { project: 'p', task: '' });
      ledger.record('sess-01', { status: 'terminated', endedAt: 2000 });
      ledger.begin('sess-01', { project: 'p', task: '' });

      /**
       * The fillers end **after** the stale timestamp, and that is the whole
       * test.
       *
       * A first draft used `500 + i`, all below the `endedAt: 2000` left by the
       * previous generation — so a still-ended `sess-01` would have sorted
       * *newest* and survived the cap anyway. The assertion held with the fix
       * removed, which is a test that cannot fail. Ending them at `3000 + i`
       * makes a still-ended `sess-01` the oldest of twenty-six and therefore the
       * first evicted, so only actually clearing the ending keeps it.
       */
      for (let i = 0; i < HISTORY_CAP + 5; i += 1) {
        ledger.record(`ended-${i}`, {
          project: 'p',
          task: '',
          status: 'done',
          endedAt: 3000 + i,
        });
      }
      ledger.flush();

      expect(readLedger(file).map((r) => r.id)).toContain('sess-01');
    });
  });

  describe('dispose', () => {
    it('drops a pending write instead of performing it', () => {
      // Nulling the reference is not enough: the debounce closes over the write
      // directly, so an unreferenced ledger still fires one last writeFileSync
      // at whatever path it was built with.
      vi.useFakeTimers();
      try {
        const ledger = createSessionLedger(file, () => 1);
        ledger.record('sess-01', { project: 'p', task: '', status: 'working' });

        ledger.dispose();
        vi.advanceTimersByTime(1000);

        expect(readLedger(file)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is safe with nothing pending', () => {
      expect(() => createSessionLedger(file, () => 1).dispose()).not.toThrow();
    });
  });

  describe('reading', () => {
    it('reads an absent file as empty', () => {
      expect(readLedger(join(dir, 'nothing-here.json'))).toEqual([]);
    });

    it('reads unparseable json as empty rather than throwing', () => {
      writeFileSync(file, '{ not json at all', 'utf8');
      expect(() => readLedger(file)).not.toThrow();
      expect(readLedger(file)).toEqual([]);
    });

    it('reads a truncated file as empty', () => {
      // What a write interrupted by a power loss actually leaves behind.
      writeFileSync(file, '[{"id":"sess-01","proj', 'utf8');
      expect(readLedger(file)).toEqual([]);
    });

    it('reads a json document that is not an array as empty', () => {
      writeFileSync(file, JSON.stringify({ sessions: [] }), 'utf8');
      expect(readLedger(file)).toEqual([]);
    });

    it('drops an individual malformed record and keeps the rest', () => {
      // One bad row must not cost the user the other nineteen.
      writeFileSync(
        file,
        JSON.stringify([
          { id: 'keeps', project: 'p', task: '', status: 'done', createdAt: 1 },
          { id: 42, project: 'p', task: '', status: 'done', createdAt: 2 },
          { project: 'p', task: '', status: 'done', createdAt: 3 },
          { id: 'no-created-at', project: 'p', task: '', status: 'done' },
          'not an object at all',
          null,
          { id: 'also-keeps', project: 'q', task: '', status: 'idle', createdAt: 5 },
        ]),
        'utf8',
      );

      expect(readLedger(file).map((record) => record.id)).toEqual([
        'keeps',
        'also-keeps',
      ]);
    });

    it('drops an optional field of the wrong type without dropping the record', () => {
      writeFileSync(
        file,
        JSON.stringify([
          {
            id: 'sess-01',
            project: 'p',
            task: '',
            status: 'done',
            createdAt: 1,
            branch: 99,
            sessionUuid: { nope: true },
          },
        ]),
        'utf8',
      );

      const [record] = readLedger(file);
      expect(record?.id).toBe('sess-01');
      expect(record?.branch).toBeUndefined();
      expect(record?.sessionUuid).toBeUndefined();
    });
  });

  describe('retention', () => {
    it('caps ended records oldest-first', () => {
      const ledger = createSessionLedger(file, () => 1);
      for (let i = 0; i < HISTORY_CAP + 5; i += 1) {
        ledger.record(`ended-${i}`, {
          project: 'p',
          task: '',
          status: 'done',
          endedAt: i,
        });
      }
      ledger.flush();

      const ids = readLedger(file).map((record) => record.id);
      expect(ids).toHaveLength(HISTORY_CAP);
      expect(ids).not.toContain('ended-0');
      expect(ids).not.toContain('ended-4');
      expect(ids).toContain('ended-5');
      expect(ids).toContain(`ended-${HISTORY_CAP + 4}`);
    });

    it('never prunes a live record, however full the history is', () => {
      // A live record is a process that still exists. Forgetting one is a
      // different and much worse bug than forgetting one that has ended.
      const ledger = createSessionLedger(file, () => 1);
      ledger.record('still-running', {
        project: 'p',
        task: '',
        status: 'working',
      });
      for (let i = 0; i < HISTORY_CAP + 10; i += 1) {
        ledger.record(`ended-${i}`, {
          project: 'p',
          task: '',
          status: 'done',
          endedAt: i,
        });
      }
      ledger.flush();

      const ids = readLedger(file).map((record) => record.id);
      expect(ids).toContain('still-running');
      expect(ids).toHaveLength(HISTORY_CAP + 1);
    });

    it('sorts by createdAt when a record ended without a timestamp', () => {
      const ledger = createSessionLedger(file, () => 1);
      ledger.record('oldest', {
        project: 'p',
        task: '',
        status: 'done',
        createdAt: 1,
      });
      for (let i = 0; i < HISTORY_CAP; i += 1) {
        ledger.record(`newer-${i}`, {
          project: 'p',
          task: '',
          status: 'done',
          endedAt: 100 + i,
        });
      }
      ledger.flush();

      expect(readLedger(file).map((record) => record.id)).not.toContain('oldest');
    });
  });

  describe('durability posture', () => {
    it('does not write until flushed or the debounce elapses', () => {
      vi.useFakeTimers();
      try {
        const ledger = createSessionLedger(file, () => 1);
        ledger.record('sess-01', { project: 'p', task: '', status: 'idle' });
        expect(readLedger(file)).toEqual([]);

        vi.advanceTimersByTime(500);
        expect(readLedger(file).map((record) => record.id)).toEqual(['sess-01']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('collapses a burst of writes into one', () => {
      vi.useFakeTimers();
      try {
        const ledger = createSessionLedger(file, () => 1);
        for (let i = 0; i < 10; i += 1) {
          ledger.record('sess-01', { project: 'p', task: '', status: 'working' });
        }
        vi.advanceTimersByTime(500);

        expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('survives an unwritable path without throwing', () => {
      // The whole posture in one case: the ledger must never be the reason the
      // app fails to start or quit.
      const ledger = createSessionLedger(
        join(dir, 'no-such-directory', 'sessions.json'),
        () => 1,
      );
      ledger.record('sess-01', { project: 'p', task: '', status: 'working' });

      expect(() => ledger.flush()).not.toThrow();
    });
  });
});
