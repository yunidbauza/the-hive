import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PHRASES } from '@lib/swarm/phrases';
import { isSession } from '@/types/entity';
import { isDesktop } from '@config/runtime';
import { peek, stamp } from '@lib/fake-clock';
import { resetProjectConfig } from '@lib/project-config';
import { noteSessionTicket } from '@lib/session-history';
import { requestSpawn } from '@lib/terminal/pty-transport';
import { sendToSession } from '@lib/terminal/session-input';

import { useAppearanceStore } from '@stores/appearance-store';
import {
  ACK_DELAY_MS,
  statusWord,
  useActiveSessions,
  useEndedSessions,
  useHiveStore,
  useNavOrder,
  useRestoredSessions,
} from '@stores/hive-store';
import { parseCommand } from '@features/orchestrator/utils/parse-command';
import { useUiStore } from '@stores/ui-store';
import { NOTIFICATION_CAP } from '@shared/notification-contract';
import type { SessionHistoryEntry } from '@shared/session-history-contract';

import { notif as notif2 } from '../support/notifications';
import { seedDemoFleet, seedDemoProjectConfig } from '@tests/support/demo-fleet';

/**
 * The desktop half of the store is mocked at the module edge, not stubbed
 * through `window.hive`.
 *
 * `isDesktop()` and the two terminal modules are the store's entire contact
 * with a real process. Mocking them keeps every assertion below about
 * *routing* — which path a message took, and what the store did about it —
 * rather than about the bridge, which has its own suites.
 */
vi.mock('@config/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@config/runtime')>()),
  isDesktop: vi.fn(() => false),
}));

vi.mock('@lib/terminal/session-input', () => ({
  sendToSession: vi.fn(() => ({ ok: true })),
  normalizeInput: (text: string) => text.trim(),
}));

vi.mock('@lib/terminal/pty-transport', () => ({
  requestSpawn: vi.fn(() => Promise.resolve({ ok: true })),
  sessionChannelState: vi.fn(() => 'live'),
  resetPtyChannels: vi.fn(),
}));

/*
  HIVE-87. The store tells main a session's ticket so it survives a quit; what
  matters here is *when* — after the spawn resolves, not before it.
*/
vi.mock('@lib/session-history', () => ({
  noteSessionTicket: vi.fn(),
  readSessionHistory: vi.fn(() => Promise.resolve([])),
}));

/**
 * Reference pattern for store tests (story 013): call the action against a
 * fresh store and assert the resulting state. No React involved.
 *
 * Timer-based behaviour is driven with fake timers, never with real waits.
 */
describe('hive-store', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    /*
      `appearance-store` is the one store that persists, so a test that leaves
      it on `light` leaks into every test declared after it. Harmless while
      every spawn assertion uses `objectContaining`, and a trap for the first
      one that asserts the dark default.
    */
    useAppearanceStore.getState().reset();
    seedDemoFleet();
    /**
     * The console's `spawn` verb validates its repo against the *config* now,
     * not the store's `projects` slice — that slice was only ever authoritative
     * because it arrived pre-seeded, and emptying it made every spawn answer
     * "unknown repo" for a project sitting in the Projects panel.
     */
    seedDemoProjectConfig();
    useUiStore.getState().reset();
    // Call history as well as return values: "was the pty asked at all?" is
    // half the assertions below, and it is meaningless if it accumulates.
    vi.clearAllMocks();
    vi.mocked(isDesktop).mockReturnValue(false);
    vi.mocked(sendToSession).mockReturnValue({ ok: true });
    vi.mocked(requestSpawn).mockResolvedValue({ ok: true });
  });

  describe('fixtures', () => {
    it('loads the concept dataset', () => {
      const state = useHiveStore.getState();

      expect(state.order).toHaveLength(10);
      expect(state.agentOrder).toHaveLength(3);
      expect(state.tickets).toHaveLength(8);
      expect(state.prs).toHaveLength(5);
      // The inbox is fed by the main process now — nothing seeds it (HIVE-75).
      expect(state.notifs).toHaveLength(0);
      expect(state.orchLines).toHaveLength(3);
      expect(Object.keys(state.entities)).toHaveLength(13);
    });

    it('boots the orchestrator console with the maestro banner', () => {
      expect(useHiveStore.getState().orchLines[0].text).toContain(
        'maestro v0.4.2',
      );
    });
  });

  describe('spawnSession', () => {
    it('creates a session, appends it to the order, and opens its tab', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      const state = useHiveStore.getState();

      expect(state.order.at(-1)).toBe(id);
      expect(state.entities[id]).toBeDefined();
      expect(useUiStore.getState().activeTab).toBe(id);
    });

    it('invents no branch at all (HIVE-78)', () => {
      /**
       * This assertion is the inverse of the one it replaces, which required
       * `` `feat/${id}` `` — a branch nothing ever created, rendered with
       * complete confidence beside a session sitting on `main`.
       *
       * A spawn is now silent about the branch, and `sessions/index.ts` reads
       * the real one with `git rev-parse` a moment later. Absent is the honest
       * state in between, and every surface draws it as an em dash.
       */
      const id = useHiveStore.getState().spawnSession('referral-api');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.branch).toBeUndefined();
      expect(isSession(session) && session.project).toBe('referral-api');
    });

    it('names a ticket session after its key, and de-duplicates', () => {
      /**
       * The Work-tab path (HIVE-78). Two sessions on one ticket is ordinary —
       * a frontend and a backend, or a second attempt — and two rows both
       * reading `HIVE-73` is the ambiguity the suffix removes.
       */
      const store = useHiveStore.getState();
      const first = store.spawnSession('apfm-web', '', 'opus', 'high', 'HIVE-73');
      const second = store.spawnSession('apfm-web', '', 'opus', 'high', 'HIVE-73');
      const third = store.spawnSession('apfm-web', '', 'opus', 'high', 'HIVE-73');

      const nameOf = (id: string) => {
        const entity = useHiveStore.getState().entities[id];
        return isSession(entity) ? entity.name : undefined;
      };

      expect(nameOf(first)).toBe('HIVE-73');
      expect(nameOf(second)).toBe('HIVE-73-2');
      expect(nameOf(third)).toBe('HIVE-73-3');
      // The id is untouched: it is the entities-map key, not a label.
      expect(first).not.toBe('HIVE-73');
    });

    it('avoids colliding with a session that has already ended', () => {
      /**
       * An ended row keeps its name and its place — `DONE_CAP` leaves it in the
       * rails and the WORK card still lists it. Skipping ended rows would put
       * two `HIVE-73`s on one ticket card the moment a user picked the issue
       * back up, which is the common case rather than an exotic one.
       */
      const first = useHiveStore
        .getState()
        .spawnSession('apfm-web', '', 'opus', 'high', 'HIVE-73');
      useHiveStore.getState().setSessionStatus(first, 'terminated');

      const second = useHiveStore
        .getState()
        .spawnSession('apfm-web', '', 'opus', 'high', 'HIVE-73');

      const entity = useHiveStore.getState().entities[second];
      expect(isSession(entity) && entity.name).toBe('HIVE-73-2');
    });

    it('tells main the ticket only after the spawn has resolved', async () => {
      /**
       * Ordering, not merely delivery (HIVE-87).
       *
       * `session:note` and `pty:spawn` are both `invoke` on one pipe and arrive
       * in order, and main refuses a note for an entity it has no record of —
       * a guard that stops a note inventing a row for a session that never
       * existed. Noting first therefore dropped the ticket every time, silently,
       * on the ticket-card path that is the whole reason the field exists.
       */
      vi.mocked(isDesktop).mockReturnValue(true);

      const id = useHiveStore
        .getState()
        .spawnSession('apfm-web', '', 'opus', 'high', 'HIVE-73');

      // Nothing yet: the spawn has been asked for but has not answered.
      expect(noteSessionTicket).not.toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(noteSessionTicket).toHaveBeenCalledWith({
          entityId: id,
          ticket: 'HIVE-73',
        });
      });
    });

    it('says nothing about a ticket when the spawn was refused', async () => {
      // A record main never created cannot be annotated, and claiming a ticket
      // for a session that failed to start would outlive the failure.
      vi.mocked(isDesktop).mockReturnValue(true);
      vi.mocked(requestSpawn).mockResolvedValue({
        ok: false,
        reason: 'at-capacity',
      } as never);

      useHiveStore
        .getState()
        .spawnSession('apfm-web', '', 'opus', 'high', 'HIVE-73');

      await Promise.resolve();
      await Promise.resolve();
      expect(noteSessionTicket).not.toHaveBeenCalled();
    });

    it('says nothing at all when no ticket named the session', async () => {
      vi.mocked(isDesktop).mockReturnValue(true);

      useHiveStore.getState().spawnSession('apfm-web');

      await Promise.resolve();
      await Promise.resolve();
      expect(noteSessionTicket).not.toHaveBeenCalled();
    });

    it('leaves a session with no ticket unnamed', () => {
      // Every other spawn is byte-identical to what HIVE-61 shipped: no name
      // on the entity, so main falls back to the entity id on the command line.
      const id = useHiveStore.getState().spawnSession('apfm-web');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.name).toBeUndefined();
    });

    it('starts idle when no task is given', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.status).toBe('idle');
    });

    it('starts working when a task is given', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web', 'Fix the nav');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.status).toBe('working');
    });

    it('seeds three transcript lines', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web', 'Fix the nav');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.lines).toHaveLength(3);
    });

    it('defaults to opus / high effort', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.model).toBe('opus');
      expect(isSession(session) && session.effort).toBe('high');
    });

    it('honours an explicit model and effort', () => {
      const id = useHiveStore
        .getState()
        .spawnSession('apfm-web', 'Spike', 'haiku', 'low');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.model).toBe('haiku');
      expect(isSession(session) && session.effort).toBe('low');
    });

    it('gives each session a distinct id', () => {
      const first = useHiveStore.getState().spawnSession('apfm-web');
      const second = useHiveStore.getState().spawnSession('apfm-web');

      expect(first).not.toBe(second);
    });
  });

  describe('sendToEntity', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('appends the routed message immediately, in cyan', () => {
      useHiveStore.getState().sendToEntity('lead-form', 'y');
      const entity = useHiveStore.getState().entities['lead-form'];

      const last = entity.lines.at(-1);
      expect(last?.text).toBe('❯ [overmind] y');
      expect(last?.color).toBe('cyan');
    });

    it('acknowledges and starts working only after the delay', () => {
      useHiveStore.getState().sendToEntity('lead-form', 'y');

      expect(
        useHiveStore.getState().entities['lead-form'],
      ).toMatchObject({ status: 'waiting' });

      vi.advanceTimersByTime(ACK_DELAY_MS);

      const entity = useHiveStore.getState().entities['lead-form'];
      expect(isSession(entity) && entity.status).toBe('working');
      /**
       * The verb is drawn from a pool now, so the assertion is on the shape of
       * the line rather than its wording — the marker and the fact that a
       * working verb is present.
       */
      const working = entity.lines.at(-1)?.text ?? '';
      expect(working.startsWith('✱ ')).toBe(true);
      expect(PHRASES['working.session']).toContain(working.slice(2));
      // One acknowledgement line for both origins (story 043): the message
      // means the same thing however it arrived.
      expect(entity.lines.at(-2)?.text).toBe('● Acknowledged — working on it');
    });

    it('returns the timer handle so the ack can be cancelled', () => {
      const outcome = useHiveStore.getState().sendToEntity('lead-form', 'y');
      expect(outcome).toMatchObject({ kind: 'demo' });

      clearTimeout((outcome as { timer: ReturnType<typeof setTimeout> }).timer);
      vi.advanceTimersByTime(ACK_DELAY_MS);

      // Only the routed message landed; the acknowledgement never fired.
      const entity = useHiveStore.getState().entities['lead-form'];
      expect(entity.lines.at(-1)?.text).toBe('❯ [overmind] y');
    });

    it('is a no-op for an unknown entity', () => {
      expect(useHiveStore.getState().sendToEntity('nope', 'hi')).toBeNull();
    });

    /**
     * The story's payload (097): on desktop a session's message is a pty
     * write, not a narration. The demo round-trip above is what the browser
     * target keeps, and the two are asserted side by side deliberately —
     * deleting the timer outright would take the browser demo with it.
     */
    describe('on a live desktop session', () => {
      beforeEach(() => {
        vi.mocked(isDesktop).mockReturnValue(true);
      });

      it('routes to the pty and reports it', () => {
        const outcome = useHiveStore.getState().sendToEntity('lead-form', 'y');

        expect(sendToSession).toHaveBeenCalledWith('lead-form', 'y');
        expect(outcome).toEqual({ kind: 'routed' });
      });

      it('does not echo into the transcript — that is the pty’s job', () => {
        const before = useHiveStore.getState().entities['lead-form'].lines.length;

        useHiveStore.getState().sendToEntity('lead-form', 'y');

        // A renderer-side echo plus the pty's own would double-print every
        // message, which is the defect story 097 names by name.
        expect(
          useHiveStore.getState().entities['lead-form'].lines,
        ).toHaveLength(before);
      });

      it('starts no acknowledgement timer', () => {
        useHiveStore.getState().sendToEntity('lead-form', 'y');

        vi.advanceTimersByTime(ACK_DELAY_MS * 2);

        // Status is observed from the process now (096), not narrated here.
        const entity = useHiveStore.getState().entities['lead-form'];
        expect(isSession(entity) && entity.status).toBe('waiting');
      });

      it('reports a refusal and writes nothing', () => {
        vi.mocked(sendToSession).mockReturnValue({
          ok: false,
          reason: 'lead-form has exited — restart it to send again',
        });
        const before = useHiveStore.getState().entities['lead-form'].lines.length;

        const outcome = useHiveStore.getState().sendToEntity('lead-form', 'y');

        expect(outcome).toEqual({
          kind: 'refused',
          reason: 'lead-form has exited — restart it to send again',
        });
        expect(
          useHiveStore.getState().entities['lead-form'].lines,
        ).toHaveLength(before);
      });

      it('leaves agents on the demo round-trip — they have no pty this epic', () => {
        const outcome = useHiveStore.getState().sendToEntity('slack-agent', 'hi');

        expect(sendToSession).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ kind: 'demo' });
      });
    });

    describe('on the browser target', () => {
      it('keeps the demo round-trip, timer and all', () => {
        const outcome = useHiveStore.getState().sendToEntity('lead-form', 'y');

        expect(sendToSession).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ kind: 'demo' });

        vi.advanceTimersByTime(ACK_DELAY_MS);

        const entity = useHiveStore.getState().entities['lead-form'];
        expect(isSession(entity) && entity.status).toBe('working');
      });
    });
  });

  describe('runOrchCommand', () => {
    /**
     * The executor half of the grammar (story 041). The parser is tested on its
     * own; these run parsed commands against a fresh store and assert what the
     * transcript and the rest of the state look like afterwards.
     */
    const run = (input: string) =>
      useHiveStore.getState().runOrchCommand(parseCommand(input));

    const transcript = () =>
      useHiveStore
        .getState()
        .orchLines.map((l) => l.text)
        .join('\n');

    const lastLine = () => useHiveStore.getState().orchLines.at(-1);

    it('ignores blank input', () => {
      const before = useHiveStore.getState().orchLines.length;
      run('   ');
      expect(useHiveStore.getState().orchLines).toHaveLength(before);
    });

    it('echoes the command in green before anything else', () => {
      run('help');
      expect(useHiveStore.getState().orchLines[3]).toMatchObject({
        text: '❯ help',
        color: 'green',
      });
    });

    it('echoes a multi-line command as one entry per line', () => {
      /**
       * `ORCH_LINE_CAP` bounds the replay by counting entries, while the
       * surface renders with `convertEol: true` — so one entry holding sixty
       * newlines is one line to the cap and sixty rows on screen. The console
       * has been a textarea since `Shift+Enter` landed, which is what made that
       * reachable: a single pasted block could push the transcript far past the
       * bound that keeps opening the orchestrator from getting slower all
       * session.
       */
      const before = useHiveStore.getState().orchLines.length;
      run('send lead-form first\nsecond\nthird');

      const echoed = useHiveStore
        .getState()
        .orchLines.slice(before, before + 3);

      expect(echoed.map((line) => line.text)).toEqual([
        '❯ send lead-form first',
        '  second',
        '  third',
      ]);
      // No entry smuggles a newline past the cap.
      for (const line of useHiveStore.getState().orchLines) {
        expect(line.text).not.toContain('\n');
      }
    });

    describe('help', () => {
      it('lists every command in the grammar', () => {
        run('help');
        const text = transcript();

        for (const command of ['help', 'status', 'open', 'send', 'spawn', 'clear']) {
          expect(text).toContain(command);
        }
      });
    });

    describe('status', () => {
      it('prints one aligned row per session, and none for agents', () => {
        run('status');
        const rows = useHiveStore
          .getState()
          .orchLines.slice(4)
          .map((l) => l.text);

        expect(rows).toHaveLength(10);
        expect(rows[0]).toContain('hero-refresh');
        expect(rows[0]).toContain('apfm-web · feat/hero-refresh');
        // Agents have no branch and are not part of the fleet table.
        expect(transcript()).not.toContain('slack-agent');
      });

      it('colours each row by status and renames waiting', () => {
        run('status');
        const rows = useHiveStore.getState().orchLines.slice(4);

        const leadForm = rows.find((l) => l.text.includes('lead-form'));
        expect(leadForm).toMatchObject({ color: 'amber' });
        expect(leadForm?.text).toContain('needs input');
      });

      /**
       * Review Fix 3: `statusWord()` had zero production callers, so this
       * table printed plain `idle` for a session the dot shows hollow. Wired
       * up at the `status` command's row builder — this is the console's own
       * evidence that the wiring is live, not just that `statusWord` is
       * unit-tested in isolation.
       */
      it('spells out what a quiet session is still running, not just plain idle', () => {
        useHiveStore.getState().setSessionStatus('hero-refresh', 'idle', 'agents');

        run('status');
        const rows = useHiveStore.getState().orchLines.slice(4);

        const heroRefresh = rows.find((l) => l.text.includes('hero-refresh'));
        expect(heroRefresh?.text).toContain('idle (agents)');
      });
    });

    describe('open', () => {
      it('opens the session and confirms', () => {
        run('open webhooks');

        expect(useUiStore.getState().activeTab).toBe('webhooks');
        expect(lastLine()).toMatchObject({ text: '  opened webhooks', color: 'dim' });
      });

      it('rejects a session that does not exist', () => {
        run('open nope');

        expect(useUiStore.getState().activeTab).toBe('orch');
        expect(lastLine()).toMatchObject({
          text: '  no such session: nope',
          color: 'red',
        });
      });

      it('rejects a missing argument as a usage error', () => {
        run('open');
        expect(lastLine()).toMatchObject({
          text: '  usage: open <session>',
          color: 'red',
        });
      });

      it('refuses a terminated session, out loud (story 108)', () => {
        /**
         * Printed rather than swallowed: a console that answered
         * `opened webhooks` and then did not open it would be worse than one
         * that said nothing.
         */
        useHiveStore.getState().setSessionStatus('webhooks', 'terminated');

        run('open webhooks');

        expect(useUiStore.getState().activeTab).toBe('orch');
        expect(lastLine()).toMatchObject({
          text: '  webhooks has terminated — its process is gone',
          color: 'red',
        });
      });
    });

    describe('openEntity — the gate every navigation path goes through', () => {
      it('opens an entity that is still running', () => {
        expect(useHiveStore.getState().openEntity('webhooks')).toBe(true);
        expect(useUiStore.getState().activeTab).toBe('webhooks');
      });

      it('refuses a terminated session and sends the user home', () => {
        /**
         * Its pty is gone. Entering it shows a dead rectangle that swallows
         * keystrokes and offers no way back except the mouse — the trap this
         * gate replaces. The orchestrator still lists the row.
         */
        useHiveStore.getState().setSessionStatus('webhooks', 'terminated');

        expect(useHiveStore.getState().openEntity('webhooks')).toBe(false);
        expect(useUiStore.getState().activeTab).toBe('orch');
      });

      /**
       * A `done` session is refused too, and for the opposite reason to a
       * terminated one.
       *
       * This used to assert it *opened*: `done` was a fixture's judgement about
       * the work, its transcript was a recording, and reading it was harmless.
       * `done` means `/clear` now, and a cleared session's pty is very much
       * alive — it belongs to the successor. Opening the retired row would put
       * the new session's output on screen under the old session's name and let
       * the user type into work they believe they finished.
       */
      it('refuses a session that was cleared, though its pty still runs', () => {
        useHiveStore.getState().setSessionStatus('webhooks', 'done');

        expect(useHiveStore.getState().openEntity('webhooks')).toBe(false);
        expect(useUiStore.getState().activeTab).toBe('orch');
      });

      it('passes an unknown id through rather than inventing an answer', () => {
        /**
         * `resolve-view` already sends an unknown `activeTab` to the
         * orchestrator, deliberately, so a session removed while its tab is open
         * leaves the user somewhere. Duplicating that decision here would put
         * two answers to one question in two files.
         */
        expect(useHiveStore.getState().openEntity('nope')).toBe(true);
        expect(useUiStore.getState().activeTab).toBe('nope');
      });
    });

    describe('send', () => {
      it('routes the message to the target session', () => {
        vi.useFakeTimers();
        run('send lead-form y please');

        const entity = useHiveStore.getState().entities['lead-form'];
        expect(entity.lines.at(-1)?.text).toBe('❯ [overmind] y please');
        expect(lastLine()).toMatchObject({ text: '  routed → lead-form', color: 'dim' });
        vi.useRealTimers();
      });

      it('flips the target to working after the acknowledgement delay', () => {
        vi.useFakeTimers();
        run('send lead-form y');

        expect(useHiveStore.getState().entities['lead-form']).toMatchObject({
          status: 'waiting',
        });
        vi.advanceTimersByTime(ACK_DELAY_MS);

        // The demo's payoff: a blocked session resumes once answered.
        expect(useHiveStore.getState().entities['lead-form']).toMatchObject({
          status: 'working',
        });
        vi.useRealTimers();
      });

      it('rejects send with no message', () => {
        run('send lead-form');
        expect(lastLine()).toMatchObject({
          text: '  usage: send <session> <message>',
          color: 'red',
        });
      });

      describe('on desktop', () => {
        beforeEach(() => {
          vi.mocked(isDesktop).mockReturnValue(true);
        });

        it('confirms a routed message', () => {
          run('send lead-form y');

          expect(lastLine()?.text).toBe('  routed → lead-form');
        });

        it('prints the refusal verbatim, in red, and does not claim it routed', () => {
          vi.mocked(sendToSession).mockReturnValue({
            ok: false,
            reason: 'lead-form has exited — restart it to send again',
          });

          run('send lead-form y');

          expect(lastLine()).toEqual({
            text: '  lead-form has exited — restart it to send again',
            color: 'red',
          });
        });
      });

      it('reports an unknown session', () => {
        run('send nope hello');
        expect(lastLine()).toMatchObject({
          text: '  no such session: nope',
          color: 'red',
        });
      });
    });

    /**
     * Addressing a session by the identifier on screen (HIVE-92).
     *
     * The console indexed `entities` directly, so it accepted only the entity id.
     * Every other surface renders `entityLabel`, and for a ticket session that is
     * the Jira key — so the fleet showed `INCORP-455` everywhere and the one
     * place you can type at it answered `no such session: INCORP-455`.
     */
    describe('addressing by name', () => {
      /** A ticket spawn, which is the only path that names a session up front. */
      const ticketSession = () =>
        useHiveStore
          .getState()
          .spawnSession('apfm-web', '', 'opus', 'high', 'INCORP-455');

      it('routes to a ticket session by its key', () => {
        const id = ticketSession();

        run('send INCORP-455 what time is it');

        const entity = useHiveStore.getState().entities[id];
        expect(entity?.lines.at(-1)?.text).toBe(
          '❯ [overmind] what time is it',
        );
        expect(lastLine()).toMatchObject({
          text: '  routed → INCORP-455',
          color: 'dim',
        });
      });

      it('accepts the key in any case, and echoes back the real one', () => {
        // A Jira key is upper-case; a prompt is where people type lower-case.
        const id = ticketSession();

        run('send incorp-455 hello');

        const entity = useHiveStore.getState().entities[id];
        expect(entity?.lines.at(-1)?.text).toBe('❯ [overmind] hello');
        // The resolved label, not what was typed — otherwise the user cannot
        // tell whether it matched.
        expect(lastLine()).toMatchObject({ text: '  routed → INCORP-455' });
      });

      it('still routes by entity id, which is what it always accepted', () => {
        const id = ticketSession();

        run(`send ${id} hello`);

        expect(lastLine()).toMatchObject({ text: '  routed → INCORP-455' });
      });

      it('opens a session by name too, not only send', () => {
        const id = ticketSession();

        run('open INCORP-455');

        expect(useUiStore.getState().activeTab).toBe(id);
        expect(lastLine()).toMatchObject({
          text: '  opened INCORP-455',
          color: 'dim',
        });
      });

      it('prefers an exact id over another session’s name', () => {
        /**
         * Reachable because an agent can rename itself to anything over the
         * title stream, including another row's id. The id is the `entities` map
         * key, so an exact hit is unique by construction — resolving to its owner
         * is the only answer that does not depend on map order.
         */
        // A ticket key that happens to equal a fixture session's id. The spawn
        // path is the only thing needed — no rename, so no title-stream guards.
        useHiveStore
          .getState()
          .spawnSession('apfm-web', '', 'opus', 'high', 'lead-form');

        run('send lead-form hello');

        expect(useHiveStore.getState().entities['lead-form']?.lines.at(-1)?.text).toBe(
          '❯ [overmind] hello',
        );
        expect(lastLine()).toMatchObject({ text: '  routed → lead-form' });
      });

      it('refuses an ambiguous target instead of guessing', () => {
        /**
         * Two rows answering to one string, which the case-insensitive match
         * makes reachable even though `ticketSessionName` prevents duplicate
         * names. Routing a message to a coin flip between two agents is the one
         * outcome worse than refusing it.
         */
        const store = useHiveStore.getState();
        // `ticketSessionName` de-duplicates case-*sensitively*, so two keys that
        // differ only in case both keep their name — and both then answer to one
        // case-insensitive target.
        const first = store.spawnSession('apfm-web', '', 'opus', 'high', 'Duplicate');
        const second = store.spawnSession('apfm-web', '', 'opus', 'high', 'duplicate');

        run('send DUPLICATE hello');

        expect(lastLine()).toMatchObject({ color: 'red' });
        expect(lastLine()?.text).toContain('matches');
        expect(lastLine()?.text).toContain('use a session id');
        // Nothing was routed.
        expect(useHiveStore.getState().entities[first]?.lines.at(-1)?.text).not.toContain(
          'hello',
        );
        expect(useHiveStore.getState().entities[second]?.lines.at(-1)?.text).not.toContain(
          'hello',
        );
      });

      it('still reports a genuinely unknown target', () => {
        ticketSession();
        run('send INCORP-999 hello');

        expect(lastLine()).toMatchObject({
          text: '  no such session: INCORP-999',
          color: 'red',
        });
      });

      it('status prints the name, so the column names what send accepts', () => {
        ticketSession();
        run('status');

        const rows = useHiveStore
          .getState()
          .orchLines.map((l) => l.text);

        expect(rows.some((row) => row.includes('INCORP-455'))).toBe(true);
      });
    });

    /**
     * An ended session is refused by both verbs, and the refusal says which
     * ending it was (HIVE-93).
     *
     * The `send` half is a **correctness** gate, not a nicety. `sendToEntity`
     * routes by `terminalOf`, and a cleared row's terminal is inherited by its
     * successor — so this used to type the user's message into a different, live
     * agent's prompt, under a row reading `done`.
     */
    describe('ended sessions', () => {
      beforeEach(() => {
        vi.mocked(isDesktop).mockReturnValue(true);
      });

      it('refuses to send to a cleared session, and routes nothing at all', () => {
        useHiveStore.getState().setSessionStatus('webhooks', 'done');

        run('send webhooks what time is it');

        expect(lastLine()).toEqual({
          text: '  not sent — webhooks was cleared — its terminal continues as a new session',
          color: 'red',
        });
        /**
         * The assertion the bug actually needed. A line in the transcript proves
         * the console *said* something; this proves nothing reached a pty — which
         * is the difference between a cosmetic message and the cross-talk fix.
         */
        expect(sendToSession).not.toHaveBeenCalled();
      });

      it('refuses to send to a terminated session', () => {
        useHiveStore.getState().setSessionStatus('webhooks', 'terminated');

        run('send webhooks hello');

        expect(lastLine()).toEqual({
          text: '  not sent — webhooks has terminated — its process is gone',
          color: 'red',
        });
        expect(sendToSession).not.toHaveBeenCalled();
      });

      it('does not append the message to the retired row either', () => {
        useHiveStore.getState().setSessionStatus('webhooks', 'done');
        const before = useHiveStore.getState().entities['webhooks']?.lines.length;

        run('send webhooks hello');

        expect(useHiveStore.getState().entities['webhooks']?.lines).toHaveLength(
          before ?? 0,
        );
      });

      it('reports a cleared session as cleared when opening, not as terminated', () => {
        /**
         * The wording bug this fixes: `open` printed the terminated sentence for
         * both endings, so a cleared session — whose process is alive and busy on
         * someone else's behalf — was reported as "its process is gone". Both
         * halves of that were false.
         */
        useHiveStore.getState().setSessionStatus('webhooks', 'done');

        run('open webhooks');

        expect(lastLine()).toEqual({
          text: '  webhooks was cleared — its terminal continues as a new session',
          color: 'red',
        });
        expect(useUiStore.getState().activeTab).toBe('orch');
      });

      it('still reports a terminated session as terminated when opening', () => {
        useHiveStore.getState().setSessionStatus('webhooks', 'terminated');

        run('open webhooks');

        expect(lastLine()).toEqual({
          text: '  webhooks has terminated — its process is gone',
          color: 'red',
        });
      });

      it('leaves a live session alone', () => {
        // The gate must not catch anything that is still running.
        run('send webhooks hello');

        expect(lastLine()).toMatchObject({ text: '  routed → webhooks' });
        expect(sendToSession).toHaveBeenCalled();
      });
    });

    describe('spawn', () => {
      it('creates a session on a known project and opens it', () => {
        const before = useHiveStore.getState().order.length;
        run('spawn apfm-web tidy the footer');

        const state = useHiveStore.getState();
        expect(state.order).toHaveLength(before + 1);
        const id = state.order.at(-1)!;
        expect(state.entities[id]).toMatchObject({
          project: 'apfm-web',
          task: 'tidy the footer',
        });
        // Newly spawned sessions are open and in nav order immediately.
        expect(useUiStore.getState().activeTab).toBe(id);
      });

      it('rejects a repo that is not a project', () => {
        const before = useHiveStore.getState().order.length;
        run('spawn not-a-repo do things');

        expect(useHiveStore.getState().order).toHaveLength(before);
        expect(lastLine()).toMatchObject({
          text: '  unknown repo: not-a-repo — try one from the Projects panel',
          color: 'red',
        });
      });

      /**
       * The verb reads the config, not the store's `projects` slice.
       *
       * A regression guard with a real failure behind it. `spawn` used to
       * validate against `state.projects`, which was authoritative only because
       * it booted pre-seeded with five demo projects. Emptying that seed left
       * the slice permanently empty, so the console answered "unknown repo" for
       * every project the user could see in the Projects panel — a verb that
       * refused everything, on a screen listing the things it was refusing.
       */
      it('accepts a project the config declares', () => {
        const before = useHiveStore.getState().order.length;

        run('spawn apfm-web do things');

        expect(useHiveStore.getState().order).toHaveLength(before + 1);
        expect(lastLine()?.text).not.toContain('unknown repo');
      });

      /**
       * No snapshot means permissive, not empty.
       *
       * `loadProjectConfig()` is fired without awaiting and leaves the snapshot
       * `null` when the IPC read throws — deliberately, so a broken hop
       * degrades rather than locks the app. Reading `null` as "no projects"
       * would make this verb refuse every repo for the first frames of a
       * launch, and refuse them permanently after a failed read.
       */
      it('does not refuse every repo when the config has not been read', () => {
        // Desktop explicitly: this suite defaults to the browser, where a null
        // snapshot means something else entirely — see the case below.
        vi.mocked(isDesktop).mockReturnValue(true);
        resetProjectConfig();
        const before = useHiveStore.getState().order.length;

        run('spawn apfm-web do things');

        expect(useHiveStore.getState().order).toHaveLength(before + 1);
        expect(lastLine()?.text).not.toContain('unknown repo');
      });

      /**
       * …but a *browser* has no snapshot for a different reason, and being
       * permissive there mints a phantom fleet.
       *
       * On desktop `null` means "not read yet" and main gives the refusal a
       * moment later. In a browser there is no bridge, so the snapshot is null
       * **forever** and `spawnSession` never calls `requestSpawn` — no refusal
       * can ever arrive, and the fabricated row stays in the rails and the
       * header counts. That is the exact lie this branch exists to delete.
       */
      it('refuses any repo in a browser, where no refusal could ever arrive', () => {
        vi.mocked(isDesktop).mockReturnValue(false);
        resetProjectConfig();
        const before = useHiveStore.getState().order.length;

        run('spawn anything at all');

        expect(useHiveStore.getState().order).toHaveLength(before);
        expect(lastLine()?.text).toContain('unknown repo: anything');
      });

      /**
       * The desktop half (097): a spawn is a real process, so it can be
       * refused for reasons only main knows. The console prints those
       * reasons rather than a generic failure.
       */
      describe('on desktop', () => {
        beforeEach(() => {
          vi.mocked(isDesktop).mockReturnValue(true);
        });

        it('carries the task to the spawn request', () => {
          run('spawn apfm-web tidy the footer');

          expect(requestSpawn).toHaveBeenCalledWith(
            expect.any(String),
            'apfm-web',
            expect.objectContaining({ task: 'tidy the footer' }),
          );
        });

        it('carries the resolved model and effort too (story 109)', () => {
          /**
           * A console `spawn` names neither, so the store's defaults are what
           * the new row records and what its chip renders — and therefore what
           * the process must actually be started as. Sending nothing here would
           * leave the chip claiming opus/high over a session running under
           * whatever `claude` happened to default to.
           */
          run('spawn apfm-web tidy the footer');

          expect(requestSpawn).toHaveBeenCalledWith(
            expect.any(String),
            'apfm-web',
            expect.objectContaining({ model: 'opus', effort: 'high' }),
          );
        });

        /**
         * The app's own theme rides along, because `claude` paints its UI from
         * its settings file rather than from the terminal's palette.
         *
         * Without it a light-themed Hive started dark-themed agents, and the
         * user's own submitted prompt came back as a near-black bar across a
         * white terminal — the palette in `ansi.ts` decides what the *named*
         * colours mean and cannot touch a colour Claude states outright.
         */
        it('carries the app’s resolved theme', () => {
          useAppearanceStore.setState({ theme: 'light' });

          run('spawn apfm-web tidy the footer');

          expect(requestSpawn).toHaveBeenCalledWith(
            expect.any(String),
            'apfm-web',
            expect.objectContaining({ theme: 'light' }),
          );
        });

        /** `system` is a preference, not a palette — it must arrive resolved. */
        it('resolves the system preference before sending it', () => {
          useAppearanceStore.setState({ theme: 'system', systemDark: false });

          run('spawn apfm-web tidy the footer');

          expect(requestSpawn).toHaveBeenCalledWith(
            expect.any(String),
            'apfm-web',
            expect.objectContaining({ theme: 'light' }),
          );
        });

        it('sends the picker’s choice, not the defaults', () => {
          useHiveStore
            .getState()
            .spawnSession('apfm-web', 'tidy the footer', 'haiku', 'low');

          expect(requestSpawn).toHaveBeenCalledWith(
            expect.any(String),
            'apfm-web',
            expect.objectContaining({ model: 'haiku', effort: 'low' }),
          );
        });

        it("prints main's refusal verbatim, in red", async () => {
          vi.mocked(requestSpawn).mockResolvedValue({
            ok: false,
            reason: 'apfm-web is not mapped — add it to /tmp/hive.json',
          });

          run('spawn apfm-web tidy the footer');

          await vi.waitFor(() =>
            expect(lastLine()).toEqual({
              text: '  apfm-web is not mapped — add it to /tmp/hive.json',
              color: 'red',
            }),
          );
        });

        it('says nothing extra when the spawn is accepted', async () => {
          run('spawn apfm-web tidy the footer');
          await vi.waitFor(() => expect(requestSpawn).toHaveBeenCalled());

          expect(lastLine()?.color).not.toBe('red');
        });
      });

      it('asks for no process on the browser target', () => {
        run('spawn apfm-web tidy the footer');

        expect(requestSpawn).not.toHaveBeenCalled();
      });

      it('rejects a missing task as a usage error', () => {
        run('spawn apfm-web');
        expect(lastLine()).toMatchObject({
          text: '  usage: spawn <repo> <task>',
          color: 'red',
        });
      });
    });

    describe('clear', () => {
      it('replaces the transcript with a single notice', () => {
        run('help');
        run('clear');

        expect(useHiveStore.getState().orchLines).toEqual([
          { text: 'console cleared — help for commands', color: 'dim' },
        ]);
      });
    });

    it('reports an unknown command and points at help', () => {
      run('frobnicate');
      expect(lastLine()).toMatchObject({
        text: '  command not found: frobnicate — try `help`',
        color: 'red',
      });
    });

    it('caps the transcript, dropping the oldest lines', () => {
      // The transcript is replayed into an xterm on every subscribe, so an
      // unbounded array would make opening the orchestrator slower over time.
      for (let i = 0; i < 120; i += 1) run('help');

      const lines = useHiveStore.getState().orchLines;
      expect(lines).toHaveLength(200);
      expect(lines.map((l) => l.text).join('\n')).not.toContain('maestro v0.4.2');
    });
  });

  describe('inbox', () => {
    it('markRead clears exactly the notification it names', () => {
      useHiveStore
        .getState()
        .hydrateNotifs([
          notif2({ id: 'a', createdAt: 2_000 }),
          notif2({ id: 'b', createdAt: 1_000 }),
        ]);

      useHiveStore.getState().markRead('a');
      const notifs = useHiveStore.getState().notifs;

      expect(notifs.find((n) => n.id === 'a')?.unread).toBe(false);
      expect(notifs.find((n) => n.id === 'b')?.unread).toBe(true);
    });

    /**
     * `applyRead` now carries a direction (HIVE-81): the foreground gate
     * raises a row already-read and promotes it back to unread once the user
     * looks away, and the renderer has to be told which way it went.
     */
    it('applyRead moves read-state in the direction it is given', () => {
      useHiveStore.getState().hydrateNotifs([notif2({ id: 'a' })]);

      useHiveStore.getState().applyRead('a', false);
      expect(
        useHiveStore.getState().notifs.find((n) => n.id === 'a')?.unread,
      ).toBe(false);

      useHiveStore.getState().applyRead('a', true);
      expect(
        useHiveStore.getState().notifs.find((n) => n.id === 'a')?.unread,
      ).toBe(true);
    });

    it('applyRead(null, false) clears every notification', () => {
      useHiveStore
        .getState()
        .hydrateNotifs([notif2({ id: 'a' }), notif2({ id: 'b' })]);

      useHiveStore.getState().applyRead(null, false);

      expect(useHiveStore.getState().notifs.every((n) => !n.unread)).toBe(
        true,
      );
    });

    it('markAllRead clears every notification', () => {
      useHiveStore
        .getState()
        .hydrateNotifs([notif2({ id: 'a' }), notif2({ id: 'b' })]);
      useHiveStore.getState().markAllRead();
      expect(
        useHiveStore.getState().notifs.every((n) => !n.unread),
      ).toBe(true);
    });

    /**
     * HIVE-81: `applyDismiss` is the echo of a dismissal main decided on its
     * own — a clicked desktop toast — so, unlike `dismissNotif`, it must not
     * write back to main. Doing so would tell main about the thing it just
     * told the renderer.
     */
    describe('applyDismiss', () => {
      afterEach(() => {
        delete window.hive;
      });

      it('removes the row and does not write back to main', () => {
        const dismiss = vi.fn();
        window.hive = {
          notifications: { dismiss },
        } as unknown as Window['hive'];

        useHiveStore
          .getState()
          .hydrateNotifs([notif2({ id: 'a' }), notif2({ id: 'b' })]);

        useHiveStore.getState().applyDismiss('a');

        expect(
          useHiveStore.getState().notifs.map((n) => n.id),
        ).toEqual(['b']);
        expect(dismiss).not.toHaveBeenCalled();
      });

      it('is a no-op for an id it does not hold', () => {
        useHiveStore.getState().hydrateNotifs([notif2({ id: 'a' })]);

        useHiveStore.getState().applyDismiss('nope');

        expect(
          useHiveStore.getState().notifs.map((n) => n.id),
        ).toEqual(['a']);
      });
    });
  });

  describe('appendEntityLines', () => {
    it('appends without touching status by default', () => {
      const before = useHiveStore.getState().entities['hero-refresh'];
      useHiveStore
        .getState()
        .appendEntityLines('hero-refresh', [{ text: 'more', color: 'ink' }]);

      const after = useHiveStore.getState().entities['hero-refresh'];
      expect(after.lines).toHaveLength(before.lines.length + 1);
      expect(isSession(after) && after.status).toBe('working');
    });

    it('updates status when one is supplied', () => {
      useHiveStore
        .getState()
        .appendEntityLines('hero-refresh', [{ text: 'done', color: 'green' }], 'done');

      const entity = useHiveStore.getState().entities['hero-refresh'];
      expect(isSession(entity) && entity.status).toBe('done');
    });

    it('leaves agents alone apart from their transcript', () => {
      useHiveStore
        .getState()
        .appendEntityLines('slack-agent', [{ text: 'ping', color: 'ink' }]);

      const entity = useHiveStore.getState().entities['slack-agent'];
      expect(entity.status).toBe('online');
      expect(entity.lines.at(-1)?.text).toBe('ping');
    });

    it('is a no-op for an unknown entity', () => {
      const before = useHiveStore.getState().entities;
      useHiveStore
        .getState()
        .appendEntityLines('nope', [{ text: 'x', color: 'ink' }]);

      expect(useHiveStore.getState().entities).toEqual(before);
    });
  });

  /**
   * The store no longer stamps anything through the clock — the activity feed
   * was its only producer, and the project explorer replaced it. `reset()`
   * still rewinds it, which is what this covers: the simulation story is the
   * clock's next consumer and inherits a store that resets it.
   */
  describe('the fake clock', () => {
    it('rewinds on reset', () => {
      stamp();
      stamp();
      expect(peek()).toBe('14:40');

      useHiveStore.getState().reset();
      seedDemoFleet();

      expect(peek()).toBe('14:38');
    });
  });

  describe('pushNotif', () => {
    /**
     * A distinct id per call, because `pushNotif` dedups on it now (HIVE-75).
     * A helper that reused one would make "nine notifications" mean "one".
     */
    let seq = 0;
    const notif = (title: string) => {
      seq += 1;
      return notif2({ id: `local-${seq}`, title, createdAt: seq });
    };

    it('prepends, so the newest notification is first', () => {
      useHiveStore.getState().pushNotif(notif('newest'));

      expect(useHiveStore.getState().notifs[0].title).toBe('newest');
    });

    it('caps the list at the shared cap, dropping the oldest', () => {
      useHiveStore.getState().pushNotif(notif('oldest'));

      for (let i = 0; i < NOTIFICATION_CAP; i += 1) {
        useHiveStore.getState().pushNotif(notif(`extra ${i}`));
      }

      const after = useHiveStore.getState().notifs;
      expect(after).toHaveLength(NOTIFICATION_CAP);
      expect(after.map((n) => n.title)).not.toContain('oldest');
    });

    it('counts as unread the moment it lands', () => {
      const before = useHiveStore
        .getState()
        .notifs.filter((n) => n.unread).length;

      useHiveStore.getState().pushNotif(notif('needs you'));

      expect(useHiveStore.getState().notifs.filter((n) => n.unread).length).toBe(
        before + 1,
      );
    });
  });

  /**
   * The merge is the whole action, and it turns on a distinction the type
   * system states but no test held: a field a payload **omitted** is preserved,
   * and a field a payload set to **null** is cleared.
   */
  describe('setSessionMetrics', () => {
    it('merges a partial report over what the session already said', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      useHiveStore.getState().setSessionMetrics(id, {
        contextPct: 46,
        fiveHourPct: 12,
      });

      useHiveStore.getState().setSessionMetrics(id, { fiveHourPct: 13 });

      expect(useHiveStore.getState().metrics[id]).toEqual({
        contextPct: 46,
        fiveHourPct: 13,
      });
    });

    /**
     * `rate_limits` stops being reported under API-key auth and is absent until
     * a session's first API response. The last reading is account-global and
     * still the best available, so silence must not erase it.
     */
    it('keeps a value a later payload simply did not mention', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      useHiveStore.getState().setSessionMetrics(id, { sevenDayPct: 63 });

      useHiveStore.getState().setSessionMetrics(id, { contextPct: 46 });

      expect(useHiveStore.getState().metrics[id]?.sevenDayPct).toBe(63);
    });

    /**
     * The assertion this describe block exists for.
     *
     * After `/compact` the session reports a context window it cannot put a
     * percentage on, and `metrics.ts` forwards that as an explicit null.
     * Preserving the old number would leave the pre-compact reading on screen —
     * high, confident, and about a conversation that no longer exists.
     */
    it('clears the context percentage when the session reports it as null', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      useHiveStore.getState().setSessionMetrics(id, { contextPct: 92 });

      useHiveStore.getState().setSessionMetrics(id, { contextPct: null });

      expect(useHiveStore.getState().metrics[id]?.contextPct).toBeNull();
    });

    it('ignores a report for an id that is not a session', () => {
      useHiveStore.getState().setSessionMetrics('slack-agent', {
        contextPct: 46,
      });

      expect(useHiveStore.getState().metrics['slack-agent']).toBeUndefined();
    });
  });

  describe('setSessionStatus — idleDetail (HIVE-83)', () => {
    const detailOf = (id: string) => {
      const entity = useHiveStore.getState().entities[id];
      return isSession(entity) ? entity.idleDetail : undefined;
    };

    it('carries the detail alongside idle', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      useHiveStore.getState().setSessionStatus(id, 'idle', 'agents');

      expect(detailOf(id)).toBe('agents');
    });

    /**
     * The assertion this describe block exists for.
     *
     * A snapshot compares keys, not values, so an explicit `idleDetail:
     * undefined` is not the same as the key being absent — the reducer must
     * delete it outright, or `idle (agents) → working` would keep the ring lit
     * for a session with nothing left running.
     */
    it('clears a stale detail when the next event carries none', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      useHiveStore.getState().setSessionStatus(id, 'idle', 'agents');
      expect(detailOf(id)).toBe('agents');

      useHiveStore.getState().setSessionStatus(id, 'working');

      const entity = useHiveStore.getState().entities[id];
      expect(isSession(entity) && 'idleDetail' in entity).toBe(false);
    });

    it('clears a stale detail on a same-status update that drops it', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      useHiveStore.getState().setSessionStatus(id, 'idle', 'script');

      useHiveStore.getState().setSessionStatus(id, 'idle');

      expect(detailOf(id)).toBeUndefined();
    });

    it('ignores a report for an id that is not a session', () => {
      useHiveStore.getState().setSessionStatus('slack-agent', 'idle', 'agents');

      expect(detailOf('slack-agent')).toBeUndefined();
    });
  });

  describe('statusWord', () => {
    it('names what is still running, mirroring the dot label', () => {
      expect(statusWord('idle', 'agents')).toBe('idle (agents)');
      expect(statusWord('idle', 'script')).toBe('idle (script)');
      expect(statusWord('idle')).toBe('idle');
      expect(statusWord('waiting')).toBe('needs input');
    });
  });

  /**
   * Restoring the fleet from the ledger (HIVE-87).
   *
   * The first time this store receives data at boot, which `emptySeeds()`
   * argues against at length — so most of these are about the restored rows
   * staying *inert*: they may not overwrite anything live, may not claim to be
   * running, and may not hand out an id a future spawn would collide with.
   */
  describe('hydrateSessions', () => {
    const record = (over: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry => ({
      id: 'sess-01',
      project: 'apfm-web',
      task: '',
      status: 'working',
      createdAt: 1,
      ...over,
    });

    const statusOf = (id: string) => {
      const entity = useHiveStore.getState().entities[id];
      return entity && isSession(entity) ? entity.status : undefined;
    };

    it('restores a record that was running as closed, not working', () => {
      // The whole inference: the file says `working`, and it plainly is not.
      useHiveStore.getState().hydrateSessions([record({ status: 'working' })]);

      expect(statusOf('sess-01')).toBe('closed');
    });

    it('treats every live status the same way', () => {
      useHiveStore.getState().hydrateSessions([
        record({ id: 'a', status: 'working' }),
        record({ id: 'b', status: 'waiting' }),
        record({ id: 'c', status: 'idle' }),
      ]);

      expect(statusOf('a')).toBe('closed');
      expect(statusOf('b')).toBe('closed');
      expect(statusOf('c')).toBe('closed');
    });

    it('keeps an ending that was actually observed', () => {
      // `terminated` is never capped precisely because it is the only record a
      // process existed. Rewriting it to `closed` would forfeit that.
      useHiveStore.getState().hydrateSessions([
        record({ id: 'a', status: 'terminated' }),
        record({ id: 'b', status: 'done' }),
      ]);

      expect(statusOf('a')).toBe('terminated');
      expect(statusOf('b')).toBe('done');
    });

    it('drops a record naming a status it does not understand', () => {
      // The file may have been written by a build that knew a status this one
      // does not. Guessing would put an unrenderable row in the table.
      useHiveStore.getState().hydrateSessions([record({ status: 'nonsense' })]);

      expect(useHiveStore.getState().entities['sess-01']).toBeUndefined();
    });

    it('carries the fields a restored row renders', () => {
      useHiveStore.getState().hydrateSessions([
        record({
          name: 'HIVE-78',
          ticket: 'HIVE-78',
          branch: 'feat/hive-78',
          cwd: '/repos/the-hive',
          model: 'haiku',
          effort: 'low',
        }),
      ]);

      expect(useHiveStore.getState().entities['sess-01']).toMatchObject({
        name: 'HIVE-78',
        ticket: 'HIVE-78',
        branch: 'feat/hive-78',
        cwd: '/repos/the-hive',
        model: 'haiku',
        effort: 'low',
        project: 'apfm-web',
      });
    });

    it('never clobbers a live row', () => {
      // A restart reuses entity ids, so this collision is the ordinary case
      // rather than a corner: the ledger holds `sess-01` from last time and
      // this run has just spawned one.
      useHiveStore.getState().spawnSession('the-hive');
      const live = useHiveStore.getState().order.at(-1)!;

      useHiveStore
        .getState()
        .hydrateSessions([record({ id: live, project: 'apfm-web', status: 'done' })]);

      const entity = useHiveStore.getState().entities[live];
      expect(statusOf(live)).not.toBe('done');
      expect(entity && isSession(entity) ? entity.project : undefined).toBe(
        'the-hive',
      );
    });

    it('appends restored rows to order without disturbing what is there', () => {
      const before = [...useHiveStore.getState().order];

      useHiveStore.getState().hydrateSessions([record({ id: 'old-01' })]);

      expect(useHiveStore.getState().order).toEqual([...before, 'old-01']);
    });

    it('seeds the id counter past every restored id', () => {
      // Without this the counter restarts at 1 and `nextSessionId`'s collision
      // guard merely *skips* the taken ids rather than continuing the sequence
      // — so a fresh session could be handed an id a restored row already
      // holds the moment the guard is removed or reordered.
      useHiveStore.getState().hydrateSessions([record({ id: 'sess-05' })]);
      useHiveStore.getState().spawnSession('the-hive');

      const fresh = useHiveStore
        .getState()
        .order.find((id) => id !== 'sess-05');
      expect(fresh).not.toBe('sess-05');
      expect(statusOf('sess-05')).toBe('closed');
    });

    it('marks every restored row as restored, however it ended', () => {
      // Provenance, not lifecycle. A session that quit normally last run comes
      // back as `terminated`, which is indistinguishable from one that quit ten
      // seconds ago in this run — so the group cannot key on the status.
      useHiveStore.getState().hydrateSessions([
        record({ id: 'a', status: 'working' }),
        record({ id: 'b', status: 'terminated' }),
        record({ id: 'c', status: 'done' }),
      ]);

      const { entities } = useHiveStore.getState();
      for (const id of ['a', 'b', 'c']) {
        const entity = entities[id];
        expect(entity && isSession(entity) ? entity.restored : undefined).toBe(
          true,
        );
      }
    });

    it('does not mark a session this run started', () => {
      useHiveStore.getState().spawnSession('the-hive');
      const live = useHiveStore.getState().order.at(-1)!;

      const entity = useHiveStore.getState().entities[live];
      expect(
        entity && isSession(entity) ? entity.restored : 'missing',
      ).toBeUndefined();
    });

    it('drops a model or effort the closed lists do not contain', () => {
      // `ledger.ts` casts these on the way in and points here for validation.
      // A hand-edited file must not put an arbitrary string into a union.
      useHiveStore.getState().hydrateSessions([
        record({
          id: 'x',
          model: 'gpt-9' as never,
          effort: 'extreme' as never,
        }),
      ]);

      const entity = useHiveStore.getState().entities['x'];
      expect(entity).toBeDefined();
      expect(entity && isSession(entity) ? entity.model : 'set').toBeUndefined();
      expect(entity && isSession(entity) ? entity.effort : 'set').toBeUndefined();
    });

    it('keeps a model and effort that are valid', () => {
      useHiveStore
        .getState()
        .hydrateSessions([record({ id: 'y', model: 'haiku', effort: 'low' })]);

      expect(useHiveStore.getState().entities['y']).toMatchObject({
        model: 'haiku',
        effort: 'low',
      });
    });

    it('seeds the counter from an id it skipped as a collision', () => {
      /**
       * The narrow race the counter has to survive: a spawn lands between boot
       * and the unawaited hydrate, taking `sess-01`. The ledger's own `sess-01`
       * is then skipped — and if the counter never heard of it, the next spawn
       * takes `sess-02`, the id of another record still waiting to be restored.
       */
      useHiveStore.getState().reset();
      useHiveStore.getState().spawnSession('the-hive');
      const live = useHiveStore.getState().order.at(-1)!;

      useHiveStore
        .getState()
        .hydrateSessions([record({ id: live }), record({ id: 'sess-09' })]);
      useHiveStore.getState().spawnSession('the-hive');

      const fresh = useHiveStore.getState().order.at(-1)!;
      expect(fresh).not.toBe('sess-09');
      expect(useHiveStore.getState().entities['sess-09']).toBeDefined();
    });

    it('puts a session main still runs straight into ACTIVE', () => {
      /**
       * The renderer is not always the first of its run (HIVE-88). Close the
       * window on macOS and reopen it from the dock, reload it, crash it: a
       * fresh store hydrates in front of the same running ptys, and the ledger
       * lists them. Main marks those `live`, and a live row is this run's fleet
       * — not restored, not closed, and reading whatever it was last doing.
       */
      useHiveStore.getState().hydrateSessions([
        record({ id: 'live-01', status: 'idle', live: true }),
        record({ id: 'old-01', status: 'idle' }),
      ]);

      expect(statusOf('live-01')).toBe('idle');
      expect(statusOf('old-01')).toBe('closed');
      const live = useHiveStore.getState().entities['live-01'];
      expect(live && isSession(live) ? live.restored : 'missing').toBeUndefined();
      const old = useHiveStore.getState().entities['old-01'];
      expect(old && isSession(old) ? old.restored : 'missing').toBe(true);
    });

    it('keeps an ended status on a live entry, and keeps it restored', () => {
      // `live` says main holds a pty under this id; it does not say the record
      // describes a running conversation. A `done` record with a live pty is
      // a cleared row whose terminal belongs to its successor.
      useHiveStore.getState().hydrateSessions([
        record({ id: 'x', status: 'done', live: true }),
      ]);

      expect(statusOf('x')).toBe('done');
    });

    it('is a no-op for an empty ledger', () => {
      const before = [...useHiveStore.getState().order];

      useHiveStore.getState().hydrateSessions([]);

      expect(useHiveStore.getState().order).toEqual(before);
    });

    it('leaves the store untouched when every record is unusable', () => {
      // The `restored === 0` early return: a hydrate that admits nothing must
      // not hand back new `entities`/`order` objects, or every selector
      // subscribed to them repaints for no reason at boot.
      const entitiesBefore = useHiveStore.getState().entities;
      const orderBefore = useHiveStore.getState().order;

      useHiveStore
        .getState()
        .hydrateSessions([record({ id: 'x', status: 'nonsense' })]);

      expect(useHiveStore.getState().entities).toBe(entitiesBefore);
      expect(useHiveStore.getState().order).toBe(orderBefore);
    });
  });

  /**
   * A restored row that comes back to life (HIVE-88).
   *
   * `restored` records where a row came from, which is durable; the section it
   * belongs in depends on whether it is running *now*, which is not. A row
   * reopened from PREVIOUS RUN gets a live status from its new process, and
   * that status has to move it — once, to ACTIVE — rather than leave one
   * entity satisfying both groups' selectors and painting twice.
   */
  describe('reviving a restored session', () => {
    const record = (over: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry => ({
      id: 'old-01',
      project: 'apfm-web',
      task: '',
      status: 'working',
      createdAt: 1,
      ...over,
    });

    const restoredOf = (id: string) => {
      const entity = useHiveStore.getState().entities[id];
      return entity && isSession(entity) ? entity.restored : 'missing';
    };

    const partition = () => {
      const { result } = renderHook(() => ({
        active: useActiveSessions(),
        restored: useRestoredSessions(),
        ended: useEndedSessions(),
        nav: useNavOrder(),
      }));
      return result.current;
    };

    it('leaves PREVIOUS RUN the moment a live status lands', () => {
      useHiveStore.getState().hydrateSessions([record()]);
      expect(partition().restored).toEqual(['old-01']);

      useHiveStore.getState().setSessionStatus('old-01', 'working');

      const groups = partition();
      expect(groups.active).toContain('old-01');
      expect(groups.restored).not.toContain('old-01');
      expect(groups.ended).not.toContain('old-01');
      expect(restoredOf('old-01')).toBeUndefined();
    });

    it('occupies exactly one slot in the keyboard order', () => {
      // The partition the caret walks is the one the table draws; both have to
      // see one row, in the ACTIVE position, and never a second one.
      useHiveStore.getState().hydrateSessions([record()]);
      useHiveStore.getState().setSessionStatus('old-01', 'working');

      const { nav, active } = partition();
      expect(nav.filter((id) => id === 'old-01')).toHaveLength(1);
      // In the ACTIVE block of the walk — before every ended or restored row.
      expect(nav.indexOf('old-01')).toBeLessThan(active.length);
    });

    it('revives on any live status, not only working', () => {
      useHiveStore.getState().hydrateSessions([
        record({ id: 'a' }),
        record({ id: 'b' }),
      ]);

      useHiveStore.getState().setSessionStatus('a', 'idle');
      useHiveStore.getState().setSessionStatus('b', 'waiting');

      expect(restoredOf('a')).toBeUndefined();
      expect(restoredOf('b')).toBeUndefined();
    });

    it('stays in PREVIOUS RUN when only an ended status is written', () => {
      // A process that failed to start settles `terminated` without ever
      // having been live. That is still last run's row, and it stays put.
      useHiveStore.getState().hydrateSessions([record()]);

      useHiveStore.getState().setSessionStatus('old-01', 'terminated');

      expect(restoredOf('old-01')).toBe(true);
      expect(partition().restored).toEqual(['old-01']);
    });

    it('revives through the transcript path too', () => {
      // `appendEntityLines` is the other writer that can carry a live status.
      useHiveStore.getState().hydrateSessions([record()]);

      useHiveStore.getState().appendEntityLines('old-01', [], 'working');

      expect(restoredOf('old-01')).toBeUndefined();
      expect(partition().active).toContain('old-01');
    });

    it('ends under ENDED once revived, like any session of this run', () => {
      useHiveStore.getState().hydrateSessions([record()]);
      useHiveStore.getState().setSessionStatus('old-01', 'working');

      useHiveStore.getState().setSessionStatus('old-01', 'terminated');

      const groups = partition();
      expect(groups.ended).toContain('old-01');
      expect(groups.restored).not.toContain('old-01');
      expect(groups.active).not.toContain('old-01');
    });

    it('opens a closed row, and still refuses the other two endings', () => {
      // `closed` is the one ending whose remedy is opening it: the surface
      // mounting is what asks main to resume the conversation.
      useHiveStore.getState().hydrateSessions([
        record({ id: 'closed-01' }),
        record({ id: 'term-01', status: 'terminated' }),
        record({ id: 'done-01', status: 'done' }),
      ]);

      expect(useHiveStore.getState().openEntity('closed-01')).toBe(true);
      expect(useUiStore.getState().activeTab).toBe('closed-01');
      expect(useHiveStore.getState().openEntity('term-01')).toBe(false);
      expect(useHiveStore.getState().openEntity('done-01')).toBe(false);
    });

    it('never restores a second row for an id this run already runs', () => {
      // The identity that survives a restart is the entity id: a reopened row
      // spawns under its own id, and the ledger is keyed by it. The collision
      // guard is therefore the dedup, and it has to hold with the live row
      // under any status.
      useHiveStore.getState().spawnSession('the-hive');
      const live = useHiveStore.getState().order.at(-1)!;
      useHiveStore.getState().setSessionStatus(live, 'working');

      useHiveStore.getState().hydrateSessions([record({ id: live })]);

      const rows = useHiveStore.getState().order.filter((id) => id === live);
      expect(rows).toHaveLength(1);
      expect(restoredOf(live)).toBeUndefined();
      expect(partition().restored).toEqual([]);
    });

    it('keeps a genuinely previous-run row in PREVIOUS RUN', () => {
      useHiveStore.getState().hydrateSessions([
        record({ id: 'old-01' }),
        record({ id: 'old-02', status: 'terminated' }),
      ]);
      useHiveStore.getState().setSessionStatus('old-01', 'working');

      const groups = partition();
      expect(groups.restored).toEqual(['old-02']);
      expect(groups.active).toContain('old-01');
    });

    it('keeps terminated rows exempt from DONE_CAP, revived or not', () => {
      useHiveStore.getState().hydrateSessions([
        record({ id: 'old-term', status: 'terminated' }),
        record({ id: 'old-live' }),
      ]);
      useHiveStore.getState().setSessionStatus('old-live', 'working');
      useHiveStore.getState().setSessionStatus('old-live', 'terminated');

      // Well past the cap: every `/clear` retires a row as `done`.
      for (let i = 0; i < 25; i += 1) {
        const id = useHiveStore.getState().spawnSession('the-hive');
        useHiveStore.getState().clearSession(id);
      }

      expect(useHiveStore.getState().entities['old-term']).toBeDefined();
      expect(useHiveStore.getState().entities['old-live']).toBeDefined();
    });
  });
});
