import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HISTORY_CAP } from '../../../../electron/shared/session-history-contract';
import {
  createSessionHistory,
  readHistory,
} from '../../../../electron/main/sessions/history';

/**
 * The session history (HIVE-87).
 *
 * These tests use a **real temporary directory** rather than a mocked `fs`, for
 * the reason `tests/electron/main/config/index.test.ts` gives: nothing is
 * spawned and nothing outlives the test, so the objection AGENTS.md raises
 * against a real `node-pty` does not apply. The module takes a path rather than
 * calling `app.getPath` itself, so no Electron mock is needed either.
 *
 * The posture under test is **lenient**, deliberately, and half of these cases
 * exist to pin that: a module that could throw on a corrupt file would be one
 * that can stop the app from opening, which is a far worse bug than losing a
 * page of history.
 */
describe('session history', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-history-'));
    file = join(dir, 'sessions.json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('writing', () => {
    it('round-trips a record', () => {
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', {
        project: 'the-hive',
        task: '',
        status: 'working',
      });
      history.flush();

      expect(readHistory(file)).toEqual([
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
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', {
        project: 'the-hive',
        task: '',
        status: 'working',
      });
      history.record('sess-01', { branch: 'feat/x', cwd: '/tmp/x' });
      history.record('sess-01', { status: 'terminated', endedAt: 2000 });
      history.flush();

      const records = readHistory(file);
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
      const history = createSessionHistory(file, () => clock);
      history.record('sess-01', {
        project: 'p',
        task: '',
        status: 'working',
      });
      clock = 9999;
      history.record('sess-01', { branch: 'main' });
      history.flush();

      expect(readHistory(file)[0]?.createdAt).toBe(1000);
    });

    it('exposes what it holds without going through the file', () => {
      const history = createSessionHistory(file, () => 1);
      history.record('sess-01', { project: 'p', task: '', status: 'idle' });

      expect(history.all().map((record) => record.id)).toEqual(['sess-01']);
    });

    /**
     * The pull request a session produced, across a quit.
     *
     * This file used to refuse a `pr` field, on the theory that a restored row
     * re-associates through `branch`. It cannot: the renderer matches against a
     * sweep holding open PRs plus 24 hours of merges, so a session that landed
     * one last Tuesday matched nothing and its `PR` cell read `—`. A fifth
     * writer — `session:pr` — now sends this, and it survives the same way
     * every other field here does.
     */
    it('round-trips the pull request a session produced', () => {
      const pr = {
        number: 118,
        repo: 'the-hive',
        url: 'https://github.com/demo/the-hive/pull/118',
      };
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'the-hive', task: '', status: 'working' });
      history.record('sess-01', { pr });
      history.flush();

      const reopened = createSessionHistory(file, () => 2000);
      expect(reopened.all()[0]).toMatchObject({ id: 'sess-01', pr });
    });

    /**
     * A name the *app* chose, and the defence that keeps it (HIVE-107).
     *
     * `namePinned` used to be excluded from the record on the grounds that "an
     * ended row has no title stream to defend against". Resume made that false:
     * a restored row reopens a real `claude`, which repaints the name it knows
     * — the id — several times a second, and an unpinned row takes it.
     */
    it('round-trips a pinned name', () => {
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'p', task: '', status: 'working' });
      history.record('sess-01', { name: 'HIVE-104', namePinned: true });
      history.flush();

      expect(createSessionHistory(file, () => 2000).all()[0]).toMatchObject({
        name: 'HIVE-104',
        namePinned: true,
      });
    });

    /**
     * The same rule `renameSession` enforces in the store, enforced here for
     * the same reason and against the same writer.
     *
     * `readTitle` records every title it reads. A pin with no ticket behind it
     * cannot name a prefix, so it refuses outright — the pre-HIVE-108 behaviour,
     * kept for exactly this state. Without it the row on screen stayed
     * `HIVE-104` while the file underneath it went back to `sess-01` on the very
     * next repaint, and the file is what the next launch reads.
     */
    it('refuses a title-stream name while one is pinned without a ticket', () => {
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'p', task: '', status: 'working' });
      history.record('sess-01', { name: 'HIVE-104', namePinned: true });
      history.record('sess-01', { name: 'sess-01' });
      history.flush();

      expect(readHistory(file)[0]?.name).toBe('HIVE-104');
    });

    /**
     * With a ticket to name the prefix, the pin *keeps the key in front* rather
     * than refusing the title (HIVE-108) — the store's rule, mirrored, because
     * this file is what the next launch restores from and the two must not
     * disagree.
     */
    it('keeps a pinned key in front of a title-stream name', () => {
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'p', task: '', status: 'working' });
      history.record('sess-01', {
        ticket: 'HIVE-104',
        name: 'HIVE-104',
        namePinned: true,
      });
      history.record('sess-01', { name: 'back key interception', nameOrigin: 'rename' });
      history.flush();

      expect(readHistory(file)[0]?.name).toBe('HIVE-104-back-key-interception');
    });

    it('does not lengthen a pinned name on every repaint', () => {
      // The compounding failure, guarded here as well as in the store: the
      // prefix is the ticket, never the name the last repaint produced.
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'p', task: '', status: 'working' });
      history.record('sess-01', {
        ticket: 'HIVE-104',
        name: 'HIVE-104',
        namePinned: true,
      });
      for (let i = 0; i < 5; i += 1) {
        history.record('sess-01', { name: 'back key interception', nameOrigin: 'rename' });
      }
      history.flush();

      expect(readHistory(file)[0]?.name).toBe('HIVE-104-back-key-interception');
    });

    it('spells an unpinned title-stream name in the rail’s register', () => {
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'p', task: '', status: 'working' });
      history.record('sess-01', { name: 'Mutex explanation' });
      history.flush();

      expect(readHistory(file)[0]?.name).toBe('mutex-explanation');
    });

    it('lets the app repin over its own name', () => {
      // The pin outranks the agent, not the app: a note that carries a name is
      // the store saying so, and it is the only thing that may replace one.
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'p', task: '', status: 'working' });
      history.record('sess-01', { name: 'HIVE-104', namePinned: true });
      history.record('sess-01', { name: 'HIVE-104-2', namePinned: true });
      history.flush();

      expect(readHistory(file)[0]?.name).toBe('HIVE-104-2');
    });

    /**
     * The same origin rule the store runs, because this file is what the next
     * launch restores from.
     *
     * Applying it in only one of the two places is a fix that lasts until the
     * app is quit: `readTitle` records every title it reads, so a late `ai-title`
     * the live row correctly ignored would still land here — and
     * `hydrateSessions` would bring the row back under it. That is the HIVE-107
     * shape, one layer down.
     */
    describe('who may replace a name', () => {
      const named = (name: string, origin?: 'prompt' | 'rename' | 'agent') => {
        const history = createSessionHistory(file, () => 1000);
        history.record('sess-01', { project: 'p', task: '', status: 'working' });
        history.record('sess-01', { name: 'HIVE-123', nameOrigin: 'prompt' });
        history.record('sess-01', origin === undefined ? { name } : { name, nameOrigin: origin });
        history.flush();
        return readHistory(file)[0]?.name;
      };

      it('refuses the agent’s late guess against a first-prompt name', () => {
        expect(named('PR 157 merge check and implementation', 'agent')).toBe('HIVE-123');
      });

      it('refuses it when no origin is given, which is what every old writer was', () => {
        expect(named('PR 157 merge check and implementation')).toBe('HIVE-123');
      });

      it('accepts a deliberate rename', () => {
        expect(named('something else', 'rename')).toBe('something-else');
      });

      it('takes any title while the row is still wearing its minted id', () => {
        const history = createSessionHistory(file, () => 1000);
        history.record('sess-01', { project: 'p', task: '', status: 'working' });
        history.record('sess-01', { name: 'sess-01' });
        history.record('sess-01', { name: 'Mutex explanation', nameOrigin: 'agent' });
        history.flush();

        expect(readHistory(file)[0]?.name).toBe('mutex-explanation');
      });

      it('never writes the origin into the record itself', () => {
        // It decides what is written; it is not a field. A record carrying it
        // would be one `hydrateSessions` had to learn to ignore.
        const history = createSessionHistory(file, () => 1000);
        history.record('sess-01', {
          project: 'p',
          task: '',
          status: 'working',
          name: 'HIVE-123',
          nameOrigin: 'prompt',
        });
        history.flush();

        expect(readHistory(file)[0]).not.toHaveProperty('nameOrigin');
        expect(readHistory(file)[0]?.name).toBe('HIVE-123');
      });
    });

    it('still takes a title-stream name on a row nobody pinned', () => {
      // HIVE-61's behaviour, unchanged for every session the app has not named.
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'p', task: '', status: 'working' });
      history.record('sess-01', { name: 'troubleshooting-crawling' });
      history.flush();

      expect(readHistory(file)[0]?.name).toBe('troubleshooting-crawling');
    });

    /**
     * A pin describes the conversation it was set on. `begin` already discards
     * a previous run's record when a spawn merely reuses its id — this is the
     * same fact one field further in, and it is the flag that would otherwise
     * make a brand-new session refuse its own name.
     */
    it('drops the pin when a fresh session takes the id', () => {
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'p', task: '', status: 'working' });
      history.record('sess-01', { name: 'HIVE-104', namePinned: true });
      history.flush();

      const reopened = createSessionHistory(file, () => 2000);
      reopened.begin('sess-01', { project: 'p', status: 'working' });
      reopened.record('sess-01', { name: 'sess-01' });

      expect(reopened.all()[0]).toMatchObject({ name: 'sess-01' });
      expect(reopened.all()[0]).not.toHaveProperty('namePinned');
    });

    /**
     * A later sweep resolving a different PR — a branch reused, or a second one
     * raised — replaces rather than merging into. Only one PR is remembered,
     * which is what the 34px column can show.
     */
    it('replaces a remembered pull request rather than merging into it', () => {
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'p', task: '', status: 'working' });
      history.record('sess-01', {
        pr: { number: 1, repo: 'p', url: 'https://github.com/demo/p/pull/1' },
      });
      history.record('sess-01', {
        pr: { number: 2, repo: 'p', url: 'https://github.com/demo/p/pull/2' },
      });
      history.flush();

      expect(readHistory(file)[0]?.pr).toEqual({
        number: 2,
        repo: 'p',
        url: 'https://github.com/demo/p/pull/2',
      });
    });

    /**
     * All three fields or nothing, unlike the flat optionals beside it — and
     * still only that field, never the row. A `number` with no `url` renders a
     * `#123` that links nowhere; nineteen good rows should not be lost over it.
     */
    it('drops a malformed pull request without dropping the record', () => {
      writeFileSync(
        file,
        JSON.stringify([
          {
            id: 'sess-01',
            project: 'p',
            task: '',
            status: 'done',
            createdAt: 1,
            pr: { number: 7 },
          },
        ]),
        'utf8',
      );

      const records = readHistory(file);
      expect(records).toHaveLength(1);
      expect(records[0]).not.toHaveProperty('pr');
    });
  });

  /**
   * The second launch — the case every other test here was blind to.
   *
   * Each of them builds a fresh history over a fresh temp file, which is the one
   * arrangement where "the history does not load the file" cannot be observed.
   * The first draft of this module did exactly that, and the cost was not
   * merely a missing feature: an unseeded history answers `session:history` with
   * nothing and then writes that nothing back, so the *second* launch after any
   * session erased the first launch's history. `session-history.spec.ts` caught
   * it by quitting a real app; these are the unit tests that should have.
   */
  describe('reopening an existing history', () => {
    const seed = () => {
      const first = createSessionHistory(file, () => 1000);
      first.begin('sess-01', {
        project: 'the-hive',
        task: '',
        sessionUuid: 'abc',
      });
      first.flush();
    };

    it('starts holding what the file already held', () => {
      seed();

      expect(createSessionHistory(file, () => 2000).all()).toEqual([
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

      createSessionHistory(file, () => 2000).flush();

      expect(readHistory(file).map((record) => record.id)).toEqual(['sess-01']);
    });

    it('merges a new run into the old records rather than replacing them', () => {
      seed();

      const second = createSessionHistory(file, () => 2000);
      second.record('sess-02', { project: 'p', task: '', status: 'working' });
      second.flush();

      expect(readHistory(file).map((record) => record.id).sort()).toEqual([
        'sess-01',
        'sess-02',
      ]);
    });

    it('keeps the original createdAt when an old record is patched again', () => {
      seed();

      const second = createSessionHistory(file, () => 2000);
      second.record('sess-01', { status: 'terminated', endedAt: 3000 });
      second.flush();

      expect(readHistory(file)[0]).toMatchObject({
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

      const [record] = createSessionHistory(file, () => 9000).all();
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

      const history = createSessionHistory(file, () => 9000);
      history.flush();

      const ids = readHistory(file).map((record) => record.id);
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

      expect(createSessionHistory(file, () => 9000).all()[0]?.endedAt).toBe(700);
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

      const history = createSessionHistory(file, () => 9000);
      history.flush();

      expect(readHistory(file)).toHaveLength(HISTORY_CAP);
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
      const history = createSessionHistory(file, () => 1000);
      history.begin('sess-01', { project: 'p', task: '' });
      history.record('sess-01', { status: 'terminated', endedAt: 2000 });

      history.record('sess-01', { status: 'working' });
      history.flush();

      const [record] = readHistory(file);
      expect(record?.status).toBe('working');
      expect(record?.endedAt).toBe(2000);
    });

    it('keeps an ending the caller states explicitly alongside a status', () => {
      const history = createSessionHistory(file, () => 1000);
      history.record('sess-01', { project: 'p', task: '', status: 'working' });
      history.record('sess-01', { status: 'done', endedAt: 4000 });
      history.flush();

      expect(readHistory(file)[0]?.endedAt).toBe(4000);
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

      const history = createSessionHistory(file, () => 5000);
      history.begin('sess-01', {
        project: 'new-project',
        task: '',
        sessionUuid: 'new-uuid',
      });
      history.flush();

      const [record] = readHistory(file);
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

    it('keeps a previous run record when asked to resume it (HIVE-88)', () => {
      // The opposite of the case above, and deliberately opt-in: this spawn
      // *is* that conversation, picked up again, so what the row learned last
      // run is still true of it.
      writeFileSync(
        file,
        JSON.stringify([
          {
            id: 'sess-01',
            project: 'p',
            task: 'old task',
            status: 'working',
            createdAt: 100,
            branch: 'feat/old',
            cwd: '/old',
            ticket: 'HIVE-1',
            name: 'old-name',
            sessionUuid: 'old-uuid',
          },
        ]),
        'utf8',
      );

      const history = createSessionHistory(file, () => 5000);
      expect(history.resumable('sess-01')).toBe('old-uuid');

      history.begin(
        'sess-01',
        { project: 'p', task: '', sessionUuid: 'old-uuid' },
        { resume: true },
      );
      history.flush();

      expect(readHistory(file)[0]).toMatchObject({
        branch: 'feat/old',
        cwd: '/old',
        ticket: 'HIVE-1',
        name: 'old-name',
        sessionUuid: 'old-uuid',
        status: 'working',
        createdAt: 100,
      });
      expect(readHistory(file)[0]?.endedAt).toBeUndefined();
    });

    it('forgets a uuid a patch withdraws, so a cleared terminal cannot resume', () => {
      writeFileSync(
        file,
        JSON.stringify([
          { id: 'sess-01', project: 'p', task: '', status: 'working', createdAt: 1, sessionUuid: 'old' },
        ]),
        'utf8',
      );
      const history = createSessionHistory(file, () => 5000);
      expect(history.resumable('sess-01')).toBe('old');

      history.record('sess-01', { sessionUuid: undefined });
      history.flush();

      expect(history.resumable('sess-01')).toBeUndefined();
      expect(readHistory(file)[0]).not.toHaveProperty('sessionUuid');
    });

    it('resumes a session this run began once it has ended (HIVE-93)', () => {
      /*
        The bar used to be "started this run", full stop, and the reasoning was
        about the *process*: resuming a conversation that is currently open
        means a second `claude` against one transcript. `/done` produces a
        session that started this run and is now over — its transcript is
        closed, its uuid still names it, and offering to reopen it is the whole
        point of the feature.
      */
      const history = createSessionHistory(file, () => 5000);
      history.begin('mine', { project: 'p', task: '', sessionUuid: 'fresh' });

      // While it runs, still refused.
      expect(history.resumable('mine')).toBeUndefined();

      history.record('mine', { status: 'done', endedAt: 6000 });

      expect(history.resumable('mine')).toBe('fresh');
    });

    it('has nothing to resume for a record without a uuid, or one this run began', () => {
      writeFileSync(
        file,
        JSON.stringify([
          { id: 'no-uuid', project: 'p', task: '', status: 'working', createdAt: 1 },
        ]),
        'utf8',
      );
      const history = createSessionHistory(file, () => 5000);
      history.begin('mine', { project: 'p', task: '', sessionUuid: 'fresh' });

      expect(history.resumable('no-uuid')).toBeUndefined();
      expect(history.resumable('mine')).toBeUndefined();
      expect(history.resumable('never-heard')).toBeUndefined();

      // `resume` on a record with nothing to resume starts over, as any reused
      // id does.
      history.begin(
        'no-uuid',
        { project: 'q', task: '', sessionUuid: 'new' },
        { resume: true },
      );
      history.flush();
      expect(readHistory(file).find((r) => r.id === 'no-uuid')).toMatchObject({
        project: 'q',
        sessionUuid: 'new',
        createdAt: 5000,
      });
    });

    it('keeps what a restart has already learned this run', () => {
      // Same session, new process. Its ticket and branch did not change because
      // the agent was restarted.
      const history = createSessionHistory(file, () => 1000);
      history.begin('sess-01', { project: 'p', task: '', sessionUuid: 'first' });
      history.record('sess-01', {
        branch: 'feat/x',
        cwd: '/repo',
        ticket: 'HIVE-87',
        name: 'worker',
      });
      history.record('sess-01', { status: 'terminated', endedAt: 2000 });

      history.begin('sess-01', { project: 'p', task: '', sessionUuid: 'second' });
      history.flush();

      expect(readHistory(file)[0]).toMatchObject({
        branch: 'feat/x',
        cwd: '/repo',
        ticket: 'HIVE-87',
        name: 'worker',
        sessionUuid: 'second',
        status: 'working',
        createdAt: 1000,
      });
      expect(readHistory(file)[0]?.endedAt).toBeUndefined();
    });

    it('clears the previous generation ending so a restart is not prunable', () => {
      const history = createSessionHistory(file, () => 1000);
      history.begin('sess-01', { project: 'p', task: '' });
      history.record('sess-01', { status: 'terminated', endedAt: 2000 });
      history.begin('sess-01', { project: 'p', task: '' });

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
        history.record(`ended-${i}`, {
          project: 'p',
          task: '',
          status: 'done',
          endedAt: 3000 + i,
        });
      }
      history.flush();

      expect(readHistory(file).map((r) => r.id)).toContain('sess-01');
    });
  });

  describe('dispose', () => {
    it('drops a pending write instead of performing it', () => {
      // Nulling the reference is not enough: the debounce closes over the write
      // directly, so an unreferenced history still fires one last writeFileSync
      // at whatever path it was built with.
      vi.useFakeTimers();
      try {
        const history = createSessionHistory(file, () => 1);
        history.record('sess-01', { project: 'p', task: '', status: 'working' });

        history.dispose();
        vi.advanceTimersByTime(1000);

        expect(readHistory(file)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is safe with nothing pending', () => {
      expect(() => createSessionHistory(file, () => 1).dispose()).not.toThrow();
    });
  });

  describe('reading', () => {
    it('reads an absent file as empty', () => {
      expect(readHistory(join(dir, 'nothing-here.json'))).toEqual([]);
    });

    it('reads unparseable json as empty rather than throwing', () => {
      writeFileSync(file, '{ not json at all', 'utf8');
      expect(() => readHistory(file)).not.toThrow();
      expect(readHistory(file)).toEqual([]);
    });

    it('reads a truncated file as empty', () => {
      // What a write interrupted by a power loss actually leaves behind.
      writeFileSync(file, '[{"id":"sess-01","proj', 'utf8');
      expect(readHistory(file)).toEqual([]);
    });

    it('reads a json document that is not an array as empty', () => {
      writeFileSync(file, JSON.stringify({ sessions: [] }), 'utf8');
      expect(readHistory(file)).toEqual([]);
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

      expect(readHistory(file).map((record) => record.id)).toEqual([
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

      const [record] = readHistory(file);
      expect(record?.id).toBe('sess-01');
      expect(record?.branch).toBeUndefined();
      expect(record?.sessionUuid).toBeUndefined();
    });

    /**
     * A name is re-cleaned with today's rule, not the one that wrote it.
     *
     * `title.ts` has twice been wrong about which glyphs Claude puts in front
     * of a name, and the history is where a wrong answer outlives the fix: these
     * are the records PREVIOUS RUN shows at launch, so a `◐` written by
     * yesterday's build would still be on screen after the reader stopped
     * producing them, until it aged out of a 40-record history.
     */
    it('cleans a glyph an older build stored in a name', () => {
      writeFileSync(
        file,
        JSON.stringify([
          {
            id: 'sess-01',
            project: 'p',
            task: '',
            status: 'done',
            createdAt: 1,
            name: '◐ sess-0c',
          },
        ]),
        'utf8',
      );

      expect(readHistory(file)[0]?.name).toBe('sess-0c');
    });

    it('leaves a name a fixed build wrote exactly as it is', () => {
      // The same function the reader applies, so a clean name is a no-op —
      // interior spaces, punctuation and all.
      writeFileSync(
        file,
        JSON.stringify([
          {
            id: 'sess-01',
            project: 'p',
            task: '',
            status: 'done',
            createdAt: 1,
            name: 'fix "login" & logout',
          },
        ]),
        'utf8',
      );

      expect(readHistory(file)[0]?.name).toBe('fix "login" & logout');
    });

    it('reads a stored default title as no name at all', () => {
      // `Claude Code` is the absence of a name spelled out. A record carrying
      // it should restore as unnamed, not as a session called `Claude Code`.
      writeFileSync(
        file,
        JSON.stringify([
          {
            id: 'sess-01',
            project: 'p',
            task: '',
            status: 'done',
            createdAt: 1,
            name: 'Claude Code',
          },
        ]),
        'utf8',
      );

      expect(readHistory(file)[0]?.name).toBeUndefined();
    });
  });

  describe('retention', () => {
    it('caps ended records oldest-first', () => {
      const history = createSessionHistory(file, () => 1);
      for (let i = 0; i < HISTORY_CAP + 5; i += 1) {
        history.record(`ended-${i}`, {
          project: 'p',
          task: '',
          status: 'done',
          endedAt: i,
        });
      }
      history.flush();

      const ids = readHistory(file).map((record) => record.id);
      expect(ids).toHaveLength(HISTORY_CAP);
      expect(ids).not.toContain('ended-0');
      expect(ids).not.toContain('ended-4');
      expect(ids).toContain('ended-5');
      expect(ids).toContain(`ended-${HISTORY_CAP + 4}`);
    });

    it('never prunes a live record, however full the history is', () => {
      // A live record is a process that still exists. Forgetting one is a
      // different and much worse bug than forgetting one that has ended.
      const history = createSessionHistory(file, () => 1);
      history.record('still-running', {
        project: 'p',
        task: '',
        status: 'working',
      });
      for (let i = 0; i < HISTORY_CAP + 10; i += 1) {
        history.record(`ended-${i}`, {
          project: 'p',
          task: '',
          status: 'done',
          endedAt: i,
        });
      }
      history.flush();

      const ids = readHistory(file).map((record) => record.id);
      expect(ids).toContain('still-running');
      expect(ids).toHaveLength(HISTORY_CAP + 1);
    });

    it('sorts by createdAt when a record ended without a timestamp', () => {
      const history = createSessionHistory(file, () => 1);
      history.record('oldest', {
        project: 'p',
        task: '',
        status: 'done',
        createdAt: 1,
      });
      for (let i = 0; i < HISTORY_CAP; i += 1) {
        history.record(`newer-${i}`, {
          project: 'p',
          task: '',
          status: 'done',
          endedAt: 100 + i,
        });
      }
      history.flush();

      expect(readHistory(file).map((record) => record.id)).not.toContain('oldest');
    });
  });

  describe('durability posture', () => {
    it('does not write until flushed or the debounce elapses', () => {
      vi.useFakeTimers();
      try {
        const history = createSessionHistory(file, () => 1);
        history.record('sess-01', { project: 'p', task: '', status: 'idle' });
        expect(readHistory(file)).toEqual([]);

        vi.advanceTimersByTime(500);
        expect(readHistory(file).map((record) => record.id)).toEqual(['sess-01']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('collapses a burst of writes into one', () => {
      vi.useFakeTimers();
      try {
        const history = createSessionHistory(file, () => 1);
        for (let i = 0; i < 10; i += 1) {
          history.record('sess-01', { project: 'p', task: '', status: 'working' });
        }
        vi.advanceTimersByTime(500);

        expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('survives an unwritable path without throwing', () => {
      // The whole posture in one case: the history must never be the reason the
      // app fails to start or quit.
      const history = createSessionHistory(
        join(dir, 'no-such-directory', 'sessions.json'),
        () => 1,
      );
      history.record('sess-01', { project: 'p', task: '', status: 'working' });

      expect(() => history.flush()).not.toThrow();
    });
  });
});
