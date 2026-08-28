import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PHRASES } from '@lib/swarm/phrases';
import { isSession } from '@/types/entity';
import type { SessionStatus } from '@/types/entity';
import { statusLabel } from '@components/ui/status-dot';
import type { IdleDetail } from '@shared/hook-contract';
import { isDesktop } from '@config/runtime';
import { peek, stamp } from '@lib/fake-clock';
import {
  projectConfigSnapshot,
  resetProjectConfig,
  setProjectConfigForTest,
} from '@lib/project-config';
import { noteSessionTicket } from '@lib/session-history';
import { reopenChannel, requestSpawn } from '@lib/terminal/pty-transport';
import { sendToSession } from '@lib/terminal/session-input';

import { useAppearanceStore } from '@stores/appearance-store';
import {
  ACK_DELAY_MS,
  openOrResume,
  statusWord,
  useActiveSessions,
  useDisplayName,
  useEndedSessions,
  currentRowFor,
  useHiveStore,
  useNavOrder,
  useSessionNameReports,
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
  // HIVE-93: `resumeSession` clears the renderer's exit latch before asking
  // for the new process, so a resume that only updated the store would leave
  // the surface typing into a pty that had gone.
  reopenChannel: vi.fn(),
}));

/*
  HIVE-87. The store tells main a session's ticket so it survives a quit; what
  matters here is *when* — after the spawn resolves, not before it.
*/
vi.mock('@lib/session-history', () => ({
  noteSessionTicket: vi.fn(),
  noteSessionPr: vi.fn(),
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
      const id = useHiveStore.getState().spawnSession('nova-web');
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
      const first = store.spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');
      const second = store.spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');
      const third = store.spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');

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
        .spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');
      useHiveStore.getState().setSessionStatus(first, 'terminated');

      const second = useHiveStore
        .getState()
        .spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');

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
        .spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');

      // Nothing yet: the spawn has been asked for but has not answered.
      expect(noteSessionTicket).not.toHaveBeenCalled();

      /*
        The name rides along since HIVE-108. Main used to learn it from the
        `--name` on this session's own command line, and there is no longer one —
        a note carrying a name is what pins it in the ledger, so without it the
        next launch would restore the agent's title with the key stripped off.
      */
      await vi.waitFor(() => {
        expect(noteSessionTicket).toHaveBeenCalledWith({
          entityId: id,
          ticket: 'HIVE-73',
          name: 'HIVE-73',
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
        .spawnSession('nova-web', '', 'opus', 'high', 'HIVE-73');

      await Promise.resolve();
      await Promise.resolve();
      expect(noteSessionTicket).not.toHaveBeenCalled();
    });

    it('says nothing at all when no ticket named the session', async () => {
      vi.mocked(isDesktop).mockReturnValue(true);

      useHiveStore.getState().spawnSession('nova-web');

      await Promise.resolve();
      await Promise.resolve();
      expect(noteSessionTicket).not.toHaveBeenCalled();
    });

    it('leaves a session with no ticket unnamed', () => {
      // Every other spawn is byte-identical to what HIVE-61 shipped: no name
      // on the entity, so main falls back to the entity id on the command line.
      const id = useHiveStore.getState().spawnSession('nova-web');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.name).toBeUndefined();
    });

    it('starts idle when no task is given', () => {
      const id = useHiveStore.getState().spawnSession('nova-web');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.status).toBe('idle');
    });

    it('starts working when a task is given', () => {
      const id = useHiveStore.getState().spawnSession('nova-web', 'Fix the nav');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.status).toBe('working');
    });

    it('seeds three transcript lines', () => {
      const id = useHiveStore.getState().spawnSession('nova-web', 'Fix the nav');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.lines).toHaveLength(3);
    });

    it('defaults to opus / high effort', () => {
      const id = useHiveStore.getState().spawnSession('nova-web');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.model).toBe('opus');
      expect(isSession(session) && session.effort).toBe('high');
    });

    it('honours an explicit model and effort', () => {
      const id = useHiveStore
        .getState()
        .spawnSession('nova-web', 'Spike', 'haiku', 'low');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.model).toBe('haiku');
      expect(isSession(session) && session.effort).toBe('low');
    });

    it('gives each session a distinct id', () => {
      const first = useHiveStore.getState().spawnSession('nova-web');
      const second = useHiveStore.getState().spawnSession('nova-web');

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
        expect(rows[0]).toContain('nova-web · feat/hero-refresh');
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
        expect(heroRefresh?.text).toContain('working (agents)');
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
          .spawnSession('nova-web', '', 'opus', 'high', 'INCORP-455');

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
          .spawnSession('nova-web', '', 'opus', 'high', 'lead-form');

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
        const first = store.spawnSession('nova-web', '', 'opus', 'high', 'Duplicate');
        const second = store.spawnSession('nova-web', '', 'opus', 'high', 'duplicate');

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
      /** The keys the seeded config declares, in file order (HIVE-94). */
      const projectKeys = (): string[] =>
        (projectConfigSnapshot()?.projects ?? []).map((project) => project.key);

      /**
       * A project whose three handles are all different (HIVE-94).
       *
       * The demo config sets `name` to the id, which cannot tell a name match
       * apart from an id match — so the resolver's precedence and its
       * case-insensitivity get a config built for the purpose.
       */
      const seedDistinctProject = () => {
        const current = projectConfigSnapshot()!;
        setProjectConfigForTest({
          ...current,
          projects: [
            {
              id: 'the-hive',
              key: 'hive',
              name: 'The Hive',
              path: '/repos/the-hive',
              icon: 'ph-folder',
              origin: 'local',
              status: 'ok',
              isRepo: true,
            },
          ],
        });
      };

      it('creates a session on a known project and opens it', () => {
        const before = useHiveStore.getState().order.length;
        run('spawn nova-web tidy the footer');

        const state = useHiveStore.getState();
        expect(state.order).toHaveLength(before + 1);
        const id = state.order.at(-1)!;
        expect(state.entities[id]).toMatchObject({
          project: 'nova-web',
          task: 'tidy the footer',
        });
        // Newly spawned sessions are open and in nav order immediately.
        expect(useUiStore.getState().activeTab).toBe(id);
      });

      /**
       * Key, id or name — all three land on the same project (HIVE-94).
       *
       * Table-driven because the point is that the four spellings are
       * *interchangeable*, and four separate tests would let one quietly start
       * resolving somewhere else without the shape of the failure saying so.
       */
      it.each([
        ['a key', 'hive'],
        ['a key in the wrong case', 'HIVE'],
        ['an id', 'the-hive'],
        ['a quoted display name', '"The Hive"'],
      ])('spawns by %s', (_label, reference) => {
        seedDistinctProject();
        const before = useHiveStore.getState().order.length;

        run(`spawn ${reference} do the thing`);

        const state = useHiveStore.getState();
        expect(state.order).toHaveLength(before + 1);
        /*
          The **resolved id**, never what was typed. `entity.project` is how
          every other surface finds this session's project, and a session
          recorded under an alias would point at nothing the moment that alias
          was edited.
        */
        expect(state.entities[state.order.at(-1)!]).toMatchObject({
          project: 'the-hive',
          task: 'do the thing',
        });
      });

      /**
       * Two projects with the same display name refuse rather than race.
       *
       * Names are never uniqueness-checked, so this is ordinary — two folders
       * both called `api`, a monorepo split, a pair of worktrees. Starting an
       * agent in whichever sat first in the file is the "wrong repository,
       * discovered later" failure exactness exists to prevent, and the refusal
       * names the ids so the user can say which one they meant.
       */
      it('refuses an ambiguous name and names the candidates', () => {
        const current = projectConfigSnapshot()!;
        const entry = (id: string, key: string) => ({
          id,
          key,
          name: 'api',
          path: `/repos/${id}`,
          icon: 'ph-folder',
          origin: 'local' as const,
          status: 'ok' as const,
          isRepo: true,
        });
        setProjectConfigForTest({
          ...current,
          projects: [entry('client-api', 'ca'), entry('server-api', 'sa')],
        });
        const before = useHiveStore.getState().order.length;

        run('spawn api do things');

        expect(useHiveStore.getState().order).toHaveLength(before);
        expect(lastLine()).toMatchObject({
          text: '  api names 2 projects (client-api, server-api) — use a key',
          color: 'red',
        });

        // And the key is the way out, so it must still resolve.
        run('spawn sa do things');
        expect(useHiveStore.getState().order).toHaveLength(before + 1);
      });

      it('does not announce the spawn by id — the rail is where the session is met (HIVE-91)', () => {
        run('spawn nova-web tidy the footer');

        const id = useHiveStore.getState().order.at(-1)!;
        // The name does not exist yet, so the only line possible would carry
        // `sess-0x` — the one label the user never sees anywhere else.
        expect(transcript()).not.toContain('spawned');
        expect(transcript()).not.toContain(id);
      });

      it('rejects a project reference that matches nothing, listing the keys', () => {
        const before = useHiveStore.getState().order.length;
        run('spawn not-a-repo do things');

        expect(useHiveStore.getState().order).toHaveLength(before);
        /*
          The **keys**, in config order (HIVE-94). Listing ids here would answer
          "what could I have typed?" with the long strings the key exists to
          replace, and the keys are what the Settings row shows.
        */
        expect(lastLine()).toMatchObject({
          text: `  unknown project: not-a-repo — try a key from Settings › Projects (${projectKeys().join(', ')})`,
          color: 'red',
        });
      });

      /**
       * Exactness is the whole safety property (HIVE-94).
       *
       * A spawn lands in a folder and starts an agent in it, so a prefix match
       * turns a typo into work done in the wrong repository — discovered later,
       * after it has happened. Refusing costs a retype.
       */
      it('refuses a prefix rather than guessing which project was meant', () => {
        const before = useHiveStore.getState().order.length;
        run('spawn nova do things');

        expect(useHiveStore.getState().order).toHaveLength(before);
        expect(lastLine()?.text).toContain('unknown project: nova');
      });

      /**
       * The verb reads the config, not the store's `projects` slice.
       *
       * A regression guard with a real failure behind it. `spawn` used to
       * validate against `state.projects`, which was authoritative only because
       * it booted pre-seeded with five demo projects. Emptying that seed left
       * the slice permanently empty, so the console answered "unknown project" for
       * every project the user could see in the Projects panel — a verb that
       * refused everything, on a screen listing the things it was refusing.
       */
      it('accepts a project the config declares', () => {
        const before = useHiveStore.getState().order.length;

        run('spawn nova-web do things');

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

        run('spawn nova-web do things');

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
      it('refuses any project in a browser, where no refusal could ever arrive', () => {
        vi.mocked(isDesktop).mockReturnValue(false);
        resetProjectConfig();
        const before = useHiveStore.getState().order.length;

        run('spawn anything at all');

        expect(useHiveStore.getState().order).toHaveLength(before);
        // No keys to list, so the refusal points at the only thing that would
        // help: adding a project in the first place.
        expect(lastLine()?.text).toContain(
          'unknown project: anything — add one in Settings › Projects',
        );
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
          run('spawn nova-web tidy the footer');

          expect(requestSpawn).toHaveBeenCalledWith(
            expect.any(String),
            'nova-web',
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
          run('spawn nova-web tidy the footer');

          expect(requestSpawn).toHaveBeenCalledWith(
            expect.any(String),
            'nova-web',
            expect.objectContaining({ model: 'opus', effort: 'high' }),
          );
        });

        /**
         * The app's theme no longer rides along (HIVE-82).
         *
         * It used to, because `claude` paints its own UI from its settings file
         * rather than from the terminal's palette — without it a light-themed
         * Hive started dark-themed agents and the user's own submitted prompt
         * came back as a near-black bar across a white terminal.
         *
         * Claude is pinned to `dark-ansi` now, which emits ANSI *indices*. The
         * palette in `ansi.ts` decides what those mean, and it is re-read at
         * paint time — so the thing a spawn used to have to state is now simply
         * true, for running sessions as much as new ones.
         */
        it('sends no theme — the palette decides, at paint time', () => {
          useAppearanceStore.setState({ theme: 'light' });

          run('spawn nova-web tidy the footer');

          expect(requestSpawn).toHaveBeenCalledWith(
            expect.any(String),
            'nova-web',
            expect.not.objectContaining({ theme: expect.anything() }),
          );
        });

        it('sends the picker’s choice, not the defaults', () => {
          useHiveStore
            .getState()
            .spawnSession('nova-web', 'tidy the footer', 'haiku', 'low');

          expect(requestSpawn).toHaveBeenCalledWith(
            expect.any(String),
            'nova-web',
            expect.objectContaining({ model: 'haiku', effort: 'low' }),
          );
        });

        it("prints main's refusal verbatim, in red", async () => {
          vi.mocked(requestSpawn).mockResolvedValue({
            ok: false,
            reason: 'nova-web is not mapped — add it to /tmp/hive.json',
          });

          run('spawn nova-web tidy the footer');

          await vi.waitFor(() =>
            expect(lastLine()).toEqual({
              text: '  nova-web is not mapped — add it to /tmp/hive.json',
              color: 'red',
            }),
          );
        });

        it('says nothing extra when the spawn is accepted', async () => {
          run('spawn nova-web tidy the footer');
          await vi.waitFor(() => expect(requestSpawn).toHaveBeenCalled());

          expect(lastLine()?.color).not.toBe('red');
        });
      });

      it('asks for no process on the browser target', () => {
        run('spawn nova-web tidy the footer');

        expect(requestSpawn).not.toHaveBeenCalled();
      });

      it('rejects a missing task as a usage error', () => {
        run('spawn nova-web');
        expect(lastLine()).toMatchObject({
          text: '  usage: spawn <project> <task>',
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

      /**
       * `null` means the whole buffer went — the echo of a Clear all, which the
       * renderer that issued it has already applied locally. This is what makes
       * a *second* window agree with the first.
       */
      it('empties the list for a null id', () => {
        useHiveStore
          .getState()
          .hydrateNotifs([notif2({ id: 'a' }), notif2({ id: 'b' })]);

        useHiveStore.getState().applyDismiss(null);

        expect(useHiveStore.getState().notifs).toEqual([]);
      });
    });

    /**
     * The bulk gesture. Unlike `applyDismiss` it **does** write to main, for the
     * same reason `dismissNotif` does: `list()` is the hydration source, so a
     * locally-emptied inbox comes straight back on the next reload.
     */
    describe('clearNotifs', () => {
      afterEach(() => {
        delete window.hive;
      });

      it('empties the list and tells the hub once', () => {
        const clear = vi.fn();
        const dismiss = vi.fn();
        window.hive = {
          notifications: { clear, dismiss },
        } as unknown as Window['hive'];

        useHiveStore
          .getState()
          .hydrateNotifs([
            notif2({ id: 'a' }),
            notif2({ id: 'b' }),
            notif2({ id: 'c' }),
          ]);

        useHiveStore.getState().clearNotifs();

        expect(useHiveStore.getState().notifs).toEqual([]);
        expect(clear).toHaveBeenCalledTimes(1);
        // Not a loop of dismissals: one gesture, one invoke, one broadcast.
        expect(dismiss).not.toHaveBeenCalled();
      });

      it('survives a browser build with no bridge', () => {
        delete window.hive;
        useHiveStore.getState().hydrateNotifs([notif2({ id: 'a' })]);

        expect(() => {
          useHiveStore.getState().clearNotifs();
        }).not.toThrow();
        expect(useHiveStore.getState().notifs).toEqual([]);
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
      const id = useHiveStore.getState().spawnSession('nova-web');
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
      const id = useHiveStore.getState().spawnSession('nova-web');
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
      const id = useHiveStore.getState().spawnSession('nova-web');
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
      const id = useHiveStore.getState().spawnSession('nova-web');
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
      const id = useHiveStore.getState().spawnSession('nova-web');
      useHiveStore.getState().setSessionStatus(id, 'idle', 'agents');
      expect(detailOf(id)).toBe('agents');

      useHiveStore.getState().setSessionStatus(id, 'working');

      const entity = useHiveStore.getState().entities[id];
      expect(isSession(entity) && 'idleDetail' in entity).toBe(false);
    });

    it('clears a stale detail on a same-status update that drops it', () => {
      const id = useHiveStore.getState().spawnSession('nova-web');
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
      expect(statusWord('idle', 'agents')).toBe('working (agents)');
      expect(statusWord('idle', 'script')).toBe('working (scripts)');
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
      project: 'nova-web',
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

      expect(statusOf('sess-01')).toBe('done');
    });

    it('treats every live status the same way', () => {
      useHiveStore.getState().hydrateSessions([
        record({ id: 'a', status: 'working' }),
        record({ id: 'b', status: 'waiting' }),
        record({ id: 'c', status: 'idle' }),
      ]);

      expect(statusOf('a')).toBe('done');
      expect(statusOf('b')).toBe('done');
      expect(statusOf('c')).toBe('done');
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
        project: 'nova-web',
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
        .hydrateSessions([record({ id: live, project: 'nova-web', status: 'done' })]);

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
      expect(statusOf('sess-05')).toBe('done');
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

    /**
     * The pin comes back with the name it defends (HIVE-107).
     *
     * `namePinned` was left out of the record on the grounds that an ended row
     * has no title stream to defend against. Resume made that false: reopening
     * a restored row starts a real `claude`, which repaints the only name it
     * knows — the id — several times a second, and an unpinned row takes it. So
     * the mid-session `HIVE-104` survived the quit and was lost to the recovery.
     */
    it('restores a pinned name, and the pin that defends it', () => {
      useHiveStore
        .getState()
        .hydrateSessions([record({ id: 'p', name: 'HIVE-104', namePinned: true })]);

      expect(useHiveStore.getState().entities['p']).toMatchObject({
        name: 'HIVE-104',
        namePinned: true,
      });

      // And it holds against the resumed agent's own idea of the name.
      useHiveStore.getState().renameSession('p', 'sess-0i');

      expect(useHiveStore.getState().entities['p']).toMatchObject({
        name: 'HIVE-104',
      });
    });

    it('leaves a row nobody pinned open to its agent', () => {
      useHiveStore
        .getState()
        .hydrateSessions([record({ id: 'q', name: 'troubleshooting-crawling' })]);

      expect(useHiveStore.getState().entities['q']).not.toHaveProperty('namePinned');
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
      expect(statusOf('old-01')).toBe('done');
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
  /**
   * `/done` in the renderer (HIVE-93).
   *
   * The mirror of `clearSession`, and every assertion here is about a way the
   * two differ: no successor, a conversation kept, and the centre stage getting
   * out of the way of a terminal that no longer exists.
   */
  describe('finishSession', () => {
    const finished = (id: string) => {
      const entity = useHiveStore.getState().entities[id];
      return entity && isSession(entity) ? entity : undefined;
    };

    it('ends the row without minting a successor', () => {
      useHiveStore.getState().spawnSession('the-hive');
      const id = useHiveStore.getState().order.at(-1)!;
      const before = useHiveStore.getState().order.length;

      useHiveStore.getState().finishSession(id, true);

      /*
        The one difference from `/clear` that the user sees immediately: a
        cleared terminal carries on under a new row, a finished one does not.
      */
      expect(useHiveStore.getState().order).toHaveLength(before);
      expect(finished(id)).toMatchObject({
        status: 'done',
        endedBy: 'finished',
        resumable: true,
      });
    });

    it('keeps the conversation, where a clear drops it', () => {
      useHiveStore.getState().spawnSession('the-hive');
      const kept = useHiveStore.getState().order.at(-1)!;
      useHiveStore.getState().spawnSession('the-hive');
      const dropped = useHiveStore.getState().order.at(-1)!;

      useHiveStore.getState().finishSession(kept, true);
      useHiveStore.getState().clearSession(dropped);

      /*
        Main keeps the uuid on `/done` and drops it on `/clear`, so only one of
        these has anything to reopen — and `resumable` is also what exempts a
        row from `DONE_CAP`.
      */
      expect(finished(kept)?.resumable).toBe(true);
      expect(finished(dropped)?.resumable).toBe(false);
    });

    it('falls back to the orchestrator when it was the visible tab', () => {
      useHiveStore.getState().spawnSession('the-hive');
      const id = useHiveStore.getState().order.at(-1)!;
      useHiveStore.getState().openEntity(id);
      expect(useUiStore.getState().activeTab).toBe(id);

      useHiveStore.getState().finishSession(id, true);

      // Its terminal is gone; leaving the user staring at a dead pty would be
      // the whole feature failing at the last step.
      expect(useUiStore.getState().activeTab).toBe('orch');
    });

    it('leaves the visible tab alone when some other session finishes', () => {
      useHiveStore.getState().spawnSession('the-hive');
      const watched = useHiveStore.getState().order.at(-1)!;
      useHiveStore.getState().spawnSession('the-hive');
      const other = useHiveStore.getState().order.at(-1)!;
      useHiveStore.getState().openEntity(watched);

      useHiveStore.getState().finishSession(other, true);

      /*
        Bouncing unconditionally would throw the user out of whatever they were
        reading because a background session finished — precisely the attention
        theft the fleet view exists to prevent.
      */
      expect(useUiStore.getState().activeTab).toBe(watched);
    });

    it('is a no-op on a row that has already ended', () => {
      useHiveStore.getState().spawnSession('the-hive');
      const id = useHiveStore.getState().order.at(-1)!;
      useHiveStore.getState().finishSession(id, true);
      useHiveStore.getState().openEntity('orch');

      /*
        The exit that follows `/done` can reach `settleExit` by two routes —
        `ptyExit` and `ptyLost` — so a second pass must not bounce a user who
        has since moved on.
      */
      useHiveStore.getState().finishSession(id, true);

      expect(finished(id)).toMatchObject({ status: 'done' });
    });

    it('takes resumability from main rather than inferring it', () => {
      /*
        A terminal that was cleared and then finished has had its uuid withdrawn
        and cannot get another — the only hook carrying the successor's id never
        reaches the receiver. Inferring `resumable` from the fact of a finish
        would offer Resume there and start a brand-new conversation under the
        promise of continuing the old one.
      */
      useHiveStore.getState().spawnSession('the-hive');
      const id = useHiveStore.getState().order.at(-1)!;

      useHiveStore.getState().finishSession(id, false);

      expect(finished(id)).toMatchObject({
        status: 'done',
        endedBy: 'finished',
        resumable: false,
      });

      // And the row is therefore cappable, like a cleared one.
      useHiveStore.getState().resumeSession(id);
      expect(useUiStore.getState().activeTab).not.toBe(id);
    });

    it('ends the terminal\'s current row, not the id main happens to name', () => {
      /*
        Main always names the *terminal*: `HIVE_SESSION_ID` is baked into the
        pty's environment at spawn and never changes, so after a `/clear` it is
        still calling the row that was retired. Reading that id directly left
        the successor `idle` on a pty that had exited — stdin enabled, no
        "terminal has died" notice, and no ending for any cap to reap.
      */
      useHiveStore.getState().spawnSession('the-hive');
      const original = useHiveStore.getState().order.at(-1)!;
      const successor = useHiveStore.getState().clearSession(original)!;

      useHiveStore.getState().finishSession(original, true);

      expect(finished(successor)).toMatchObject({
        status: 'done',
        endedBy: 'finished',
      });
    });

    it('spares a resumable row from the done cap', () => {
      /*
        Capping `done` was justified by "a cleared session's successor is right
        there". A finished row has no successor and keeps a transcript the user
        can reopen, so dropping it would delete the only visible route back to
        something that still exists on disk.
      */
      useHiveStore.getState().spawnSession('the-hive');
      const survivor = useHiveStore.getState().order.at(-1)!;
      useHiveStore.getState().finishSession(survivor, true);

      for (let i = 0; i < 25; i += 1) {
        useHiveStore.getState().spawnSession('the-hive');
        const id = useHiveStore.getState().order.at(-1)!;
        useHiveStore.getState().clearSession(id);
      }

      expect(useHiveStore.getState().entities[survivor]).toBeDefined();
    });
  });

  describe('reviving a restored session', () => {
    const record = (over: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry => ({
      id: 'old-01',
      project: 'nova-web',
      task: '',
      status: 'working',
      createdAt: 1,
      ...over,
    });

    const restoredOf = (id: string) => {
      const entity = useHiveStore.getState().entities[id];
      return entity && isSession(entity) ? entity.restored : 'missing';
    };

    /**
     * `restored` is read off the entities rather than from a selector.
     *
     * There used to be a `useRestoredSessions()` here, feeding the table's
     * PREVIOUS RUN group. That group is gone — a recency sort answers the
     * question it was drawn for — but the *flag* is not: Resume and
     * `endedReason` both read it, and `reviveIfLive` clearing it is still the
     * thing these tests are about. So the provenance is asserted directly,
     * which is where it now lives.
     */
    const partition = () => {
      const { result } = renderHook(() => ({
        active: useActiveSessions(),
        ended: useEndedSessions(),
        nav: useNavOrder(),
      }));
      const state = useHiveStore.getState();
      const restored = state.order.filter((id) => {
        const entity = state.entities[id];
        return entity !== undefined && isSession(entity) && entity.restored === true;
      });
      return { ...result.current, restored };
    };

    it('stops being marked restored the moment a live status lands', () => {
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

    it('stays marked restored when only an ended status is written', () => {
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

    it('restores how a session ended, not just that it did', () => {
      /*
        `publishStatus` never writes `done` and `onCleared` writes no status, so
        the only way a record holds `done` is a declared `/done`. Without the
        recorded `endedBy`, every one of those came back reading "was cleared —
        its terminal continues as a new session" — the one sentence that is
        false for all of them, shown beside a Resume button, so the tooltip and
        the control contradicted each other.
      */
      useHiveStore.getState().hydrateSessions([
        record({ id: 'fin-01', status: 'done', endedBy: 'finished' }),
        record({ id: 'clr-01', status: 'done' }),
        record({ id: 'old-02' }),
      ]);

      const entities = useHiveStore.getState().entities;
      expect(entities['fin-01']).toMatchObject({ endedBy: 'finished' });
      /*
        A `done` record with no `endedBy` predates the field, and every one of
        those was a `/clear` — nothing else produced the status then. Main can
        no longer write `cleared` at all: after a `/clear` that same record goes
        on describing the successor, so stamping an ending on it would be a lie
        about a session still running.
      */
      expect(entities['clr-01']).not.toHaveProperty('endedBy');
      // A record still claiming to be live ended when the app did.
      expect(entities['old-02']).toMatchObject({ endedBy: 'app-closed' });
    });

    it('refuses to open any ended row, restored ones included', () => {
      /*
        A restored row used to be the exception, because clicking it *was* the
        resume (HIVE-88). Resume is its own control now (HIVE-93), so the gate
        can say the honest thing about every ending: that terminal is gone, or
        it belongs to a successor.
      */
      useHiveStore.getState().hydrateSessions([
        record({ id: 'closed-01', resumable: true }),
        record({ id: 'term-01', status: 'terminated' }),
        record({ id: 'done-01', status: 'done' }),
      ]);

      expect(useHiveStore.getState().openEntity('closed-01')).toBe(false);
      expect(useHiveStore.getState().openEntity('term-01')).toBe(false);
      expect(useHiveStore.getState().openEntity('done-01')).toBe(false);
    });

    it('resumes a restored row instead, and opens it live', () => {
      useHiveStore.getState().hydrateSessions([
        record({ id: 'closed-01', resumable: true }),
      ]);

      useHiveStore.getState().resumeSession('closed-01');

      /*
        Live *before* the tab opens, and both halves matter: `center-stage`
        reads `isTerminated` on mount to decide whether to disable stdin, so a
        row still marked ended would mount a read-only surface over the very
        session this was asked to reopen.
      */
      const revived = useHiveStore.getState().entities['closed-01'];
      expect(revived).toMatchObject({ status: 'idle', resumable: true });
      expect(revived).not.toHaveProperty('endedBy');
      expect(useUiStore.getState().activeTab).toBe('closed-01');
    });

    it('actually starts a process — the store update alone is not a resume', () => {
      /*
        The bug this exists for: `resumeSession` used to only mutate the row and
        open the tab. The pty had exited, so the renderer's channel was latched
        closed and no spawn was ever requested — the surface re-enabled stdin
        over a dead process and swallowed every keystroke, with the Resume
        control now gone because it is gated on the row being ended. There was
        no way back from that state.
      */
      vi.mocked(requestSpawn).mockClear();
      vi.mocked(reopenChannel).mockClear();

      useHiveStore.getState().hydrateSessions([
        record({ id: 'closed-01', resumable: true }),
      ]);
      useHiveStore.getState().resumeSession('closed-01');

      // The latch first, or the request below hands back the previous answer.
      expect(reopenChannel).toHaveBeenCalledWith('closed-01');
      /*
        And `resume: true`, which is why this goes through the spawn path rather
        than `pty.restart` — a restart deliberately never forwards it, so it
        would begin a new conversation while promising the old one.
      */
      expect(requestSpawn).toHaveBeenCalledWith(
        'closed-01',
        expect.any(String),
        expect.objectContaining({ resume: true }),
      );
    });

    it('stops being marked as a previous run, so nothing calls it one', () => {
      /*
        While the table drew a PREVIOUS RUN divider this was a double-draw: the
        restored list keyed on `restored` and `useActiveSessions` on the status,
        so a resumed row satisfied both and appeared twice under one selection
        index — the bug HIVE-88 fixed. The divider is gone; the flag still feeds
        `endedReason`, which would otherwise describe a live session as one the
        app outlived.
      */
      useHiveStore.getState().hydrateSessions([
        record({ id: 'closed-01', resumable: true }),
      ]);
      useHiveStore.getState().resumeSession('closed-01');

      expect(useHiveStore.getState().entities['closed-01']).not.toHaveProperty(
        'restored',
      );
    });

    it('resumes from the keyboard, not only from the control', () => {
      /*
        `openEntity` refuses every ended row now, so routing the keyboard
        through it alone left a user able to arrow onto a finished session,
        press Enter and get silence — the resume button reachable only by mouse.
      */
      useHiveStore.getState().hydrateSessions([
        record({ id: 'closed-01', resumable: true }),
        record({ id: 'term-01', status: 'terminated' }),
      ]);

      expect(openOrResume('closed-01')).toBe(true);
      expect(useUiStore.getState().activeTab).toBe('closed-01');

      // And a row with nothing to resume is still refused.
      expect(openOrResume('term-01')).toBe(false);
    });

    it('refuses to resume a row with no conversation behind it', () => {
      /*
        A cleared row drops its uuid in main, so there is nothing to reopen.
        Opening the tab anyway would put the user in front of a terminal this
        action has not arranged to exist.
      */
      useHiveStore.getState().hydrateSessions([
        record({ id: 'done-01', status: 'done' }),
      ]);

      useHiveStore.getState().resumeSession('done-01');

      expect(useHiveStore.getState().entities['done-01']).toMatchObject({
        status: 'done',
      });
      expect(useUiStore.getState().activeTab).not.toBe('done-01');
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

    it('keeps a genuinely previous-run row marked restored', () => {
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

/**
 * PR search ordering (review of PR 124).
 *
 * The guard used to compare the *term*, which is not enough: the debounce
 * re-runs on a scope change too, so two requests can be in flight for one term
 * and the narrow one landing last would leave narrow results sitting under a
 * checked "All repos".
 */
describe('searchPrs — which answer wins', () => {
  beforeEach(() => {
    // The file's global setup pins this to `false` (the browser preview), where
    // a search short-circuits before it ever reaches the bridge.
    vi.mocked(isDesktop).mockReturnValue(true);
  });

  afterEach(() => {
    delete window.hive;
  });

  const record = (number: number) => ({
    number,
    repo: 'the-hive',
    owner: 'behiques',
    title: `pr ${String(number)}`,
    state: 'open' as const,
    findings: 0,
    checks: { state: 'none' as const },
    url: `https://github.com/behiques/the-hive/pull/${String(number)}`,
    branch: `b${String(number)}`,
    author: 'someone',
    updatedAt: '2026-08-10T10:00:00Z',
    mergedAt: null,
  });

  it('drops a slow answer for the same term at a different scope', async () => {
    let releaseNarrow: (() => void) | undefined;
    const searchPrs = vi
      .fn()
      // The narrow request, held open.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseNarrow = () => {
              resolve({ ok: true, value: [record(1)] });
            };
          }),
      )
      // The wide one, asked second and answering first.
      .mockResolvedValueOnce({ ok: true, value: [record(2)] });

    window.hive = { github: { searchPrs } } as unknown as Window['hive'];

    const narrow = useHiveStore.getState().searchPrs('carapace', 'the-hive');
    const wide = useHiveStore.getState().searchPrs('carapace');

    await wide;
    expect(
      useHiveStore.getState().prSearch.results?.map((pr) => pr.number),
    ).toEqual([2]);

    releaseNarrow?.();
    await narrow;

    // Same term, so a term comparison would have let this through and left the
    // narrow list under a checked "All repos".
    expect(
      useHiveStore.getState().prSearch.results?.map((pr) => pr.number),
    ).toEqual([2]);
  });

  it('retires an answer still in flight when the search is cleared', async () => {
    let release: (() => void) | undefined;
    const searchPrs = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ ok: true, value: [record(1)] });
          };
        }),
    );
    window.hive = { github: { searchPrs } } as unknown as Window['hive'];

    const pending = useHiveStore.getState().searchPrs('carapace', 'the-hive');
    useHiveStore.getState().clearPrSearch();

    release?.();
    await pending;

    // Results landing into an empty box would be a list with nothing to
    // explain it.
    expect(useHiveStore.getState().prSearch).toEqual({
      term: '',
      results: null,
      searching: false,
      error: null,
    });
  });

  it('is emptied by reset', () => {
    useHiveStore.setState({
      prSearch: { term: 'carapace', results: [], searching: false, error: null },
    });

    useHiveStore.getState().reset();

    expect(useHiveStore.getState().prSearch).toEqual({
      term: '',
      results: null,
      searching: false,
      error: null,
    });
  });

/**
 * When a row started and when it stopped — the two fields the fleet table
 * sorts on (the "most recent at the top" fix).
 *
 * Every list in this store used to be `order`, which is insertion order, so the
 * newest session was at the bottom of the live group and the ended half read
 * oldest-first from the top. There was no field anywhere that could answer
 * "which of these two finished more recently", which is the question a fleet
 * table is for.
 */
describe('lifecycle timestamps', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoProjectConfig();
  });

  afterEach(() => {
    useHiveStore.getState().reset();
  });

    const sessionAt = (id: string) => {
      const entity = useHiveStore.getState().entities[id];
      if (!entity || !isSession(entity)) throw new Error(`no session ${id}`);
      return entity;
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-26T09:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stamps a spawn with the moment it happened', () => {
      const id = useHiveStore.getState().spawnSession('the-hive');

      expect(sessionAt(id).createdAt).toBe(Date.parse('2026-08-26T09:00:00Z'));
      expect(sessionAt(id)).not.toHaveProperty('endedAt');
    });

    it('stamps an ending as the status crosses into it', () => {
      const id = useHiveStore.getState().spawnSession('the-hive');

      vi.setSystemTime(new Date('2026-08-26T10:00:00Z'));
      useHiveStore.getState().setSessionStatus(id, 'terminated');

      expect(sessionAt(id).endedAt).toBe(Date.parse('2026-08-26T10:00:00Z'));
    });

    /**
     * An ending is reached by more paths than it looks like — `/done` and the
     * pty exit that follows it both arrive, and `settleExit` can be reached
     * twice. Re-stamping would make a row's ending drift later every time
     * something re-observed it, which is exactly the value the table sorts on.
     */
    it('stamps once, however many writes observe the same ending', () => {
      const id = useHiveStore.getState().spawnSession('the-hive');
      useHiveStore.getState().setSessionStatus(id, 'terminated');
      const first = sessionAt(id).endedAt;

      vi.setSystemTime(new Date('2026-08-26T11:00:00Z'));
      useHiveStore.getState().appendEntityLines(id, [], 'terminated');

      expect(sessionAt(id).endedAt).toBe(first);
    });

    it('stamps /done and /clear, which never pass through setSessionStatus', () => {
      const finished = useHiveStore.getState().spawnSession('the-hive');
      const cleared = useHiveStore.getState().spawnSession('the-hive');

      vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));
      useHiveStore.getState().finishSession(finished, true);
      const successor = useHiveStore.getState().clearSession(cleared);

      const at = Date.parse('2026-08-26T12:00:00Z');
      expect(sessionAt(finished).endedAt).toBe(at);
      expect(sessionAt(cleared).endedAt).toBe(at);
      // A successor is a new session on an old terminal — new *now*, not when
      // its predecessor opened.
      expect(sessionAt(successor!).createdAt).toBe(at);
      expect(sessionAt(successor!)).not.toHaveProperty('endedAt');
    });

    it('clears the stamp when a row comes back to life', () => {
      useHiveStore.getState().hydrateSessions([
        {
          id: 'old-01',
          project: 'nova-web',
          task: '',
          status: 'terminated',
          createdAt: 1,
          endedAt: 2,
          resumable: true,
        },
      ]);
      expect(sessionAt('old-01').endedAt).toBe(2);

      useHiveStore.getState().resumeSession('old-01');

      expect(sessionAt('old-01')).not.toHaveProperty('endedAt');
      expect(sessionAt('old-01').createdAt).toBe(1);
    });

    /**
     * A resume is the row mattering *again*, and the sort has to see that.
     *
     * Clearing `endedAt` alone sent a resumed row back to `createdAt` — when
     * the conversation first started — so resuming a session from this morning
     * put it below everything spawned since: the row the user had just acted
     * on, furthest from the header, which is the exact failure newest-first
     * exists to remove.
     */
    it('sorts a resumed row by when it was resumed, not when it began', () => {
      useHiveStore.getState().hydrateSessions([
        {
          id: 'old-05',
          project: 'nova-web',
          task: '',
          status: 'terminated',
          createdAt: Date.parse('2026-08-26T06:00:00Z'),
          endedAt: Date.parse('2026-08-26T07:00:00Z'),
          resumable: true,
        },
      ]);
      // Spawned after the resumed session first began, but before the resume.
      const newer = useHiveStore.getState().spawnSession('the-hive');

      vi.setSystemTime(new Date('2026-08-26T11:00:00Z'));
      useHiveStore.getState().resumeSession('old-05');

      expect(sessionAt('old-05').resumedAt).toBe(
        Date.parse('2026-08-26T11:00:00Z'),
      );
      // `createdAt` is untouched: it is when the session began, and the ledger's
      // retention sorts on it.
      expect(sessionAt('old-05').createdAt).toBe(
        Date.parse('2026-08-26T06:00:00Z'),
      );

      const { result } = renderHook(() => useActiveSessions());
      expect(result.current.indexOf('old-05')).toBeLessThan(
        result.current.indexOf(newer),
      );
    });

    /**
     * The times the row really had, not the moment it was restored — otherwise
     * every launch would file last week's endings as though they had all just
     * happened, in whatever order the ledger listed them.
     */
    it('restores the times a record carried rather than stamping at hydrate', () => {
      useHiveStore.getState().hydrateSessions([
        {
          id: 'old-02',
          project: 'nova-web',
          task: '',
          status: 'terminated',
          createdAt: 111,
          endedAt: 222,
        },
      ]);

      expect(sessionAt('old-02')).toMatchObject({
        createdAt: 111,
        endedAt: 222,
      });
    });

    /**
     * A record main is still running is not history, whatever the file says
     * (HIVE-88). It must not sort as though it had finished.
     */
    it('drops a restored endedAt from a row main still runs', () => {
      useHiveStore.getState().hydrateSessions([
        {
          id: 'old-03',
          project: 'nova-web',
          task: '',
          status: 'working',
          createdAt: 111,
          endedAt: 222,
          live: true,
        },
      ]);

      expect(sessionAt('old-03').status).toBe('working');
      expect(sessionAt('old-03')).not.toHaveProperty('endedAt');
    });

    /** The remembered PR rides back with the rest of the record. */
    it('restores the pull request the record was carrying', () => {
      useHiveStore.getState().hydrateSessions([
        {
          id: 'old-04',
          project: 'nova-web',
          task: '',
          status: 'terminated',
          createdAt: 1,
          pr: {
            number: 118,
            repo: 'nova-web',
            url: 'https://github.com/demo/nova-web/pull/118',
          },
        },
      ]);

      expect(sessionAt('old-04')).toMatchObject({
        lastPr: { number: 118, url: 'https://github.com/demo/nova-web/pull/118' },
      });
    });
  });
});

/**
 * The console's word and the panels' word are two mappings, and they must not
 * disagree.
 *
 * `stores/` may not import `components/`, so `statusWord` and `statusLabel` are
 * genuinely separate functions with a comment between them asking them to
 * match. The comment failed: `statusLabel` was renamed to `working (agents)`
 * and `statusWord` was not, so the fleet table, the rails and the meta bar read
 * one thing while `status` typed into the maestro console printed another for
 * the same row. A test is the only thing that can hold two copies in step.
 */
describe('statusWord agrees with statusLabel', () => {
  const STATUSES: SessionStatus[] = [
    'working',
    'waiting',
    'idle',
    'done',
    'terminated',
  ];
  const DETAILS: (IdleDetail | undefined)[] = [undefined, 'agents', 'script'];

  it.each(
    STATUSES.flatMap((status) =>
      DETAILS.map((detail) => [status, detail] as const),
    ),
  )('says the same thing for %s / %s', (status, detail) => {
    expect(statusWord(status, detail)).toBe(statusLabel(status, detail));
  });

  /**
   * And paints it the same way. The console is the fourth surface printing this
   * word, and it got the rename without the colour — so `status` listed
   * `working (agents)` in idle's grey while the fleet table, the projects rail
   * and the meta bar all showed it green.
   */
  it('paints a quiet session with something running as working, not idle', () => {
    const rows = () => {
      useHiveStore.getState().runOrchCommand(parseCommand('status'));
      return useHiveStore.getState().orchLines;
    };

    const id = useHiveStore.getState().spawnSession('the-hive');
    useHiveStore.getState().setSessionStatus(id, 'idle', 'agents');

    const row = rows().find((l) => l.text.includes('working (agents)'));
    expect(row).toBeDefined();
    // `dim` is what `STATUS_COLOR.idle` gives, and what this used to print.
    expect(row?.color).toBe('green');
  });
});

/**
 * Names, resolved rather than remembered (HIVE-110).
 *
 * Two consumers, one fact. `useDisplayName` is what an inbox row asks so that a
 * notification stops naming a session by an id the user has never seen;
 * `useSessionNameReports` is what tells main the same thing, so a desktop toast
 * about that session says what the rail says.
 */
describe('session names for the world outside the rail', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
  });

  describe('useDisplayName', () => {
    it('answers with the id while nothing has named the session', () => {
      const { result } = renderHook(() => useDisplayName('lead-form'));

      expect(result.current).toBe('lead-form');
    });

    it('answers with the name once one arrives', () => {
      useHiveStore.getState().renameSession('lead-form', 'Mutex explanation');

      const { result } = renderHook(() => useDisplayName('lead-form'));

      expect(result.current).toBe('mutex-explanation');
    });

    /*
      A terminal belongs to the successor after a `/clear`, which is the mapping
      the row's click already uses. The words have to follow it or the row names
      one session and opens another.
    */
    it('follows a /clear to the successor', () => {
      const successor = useHiveStore.getState().clearSession('lead-form')!;
      useHiveStore.getState().renameSession(successor, 'Mutex explanation');

      const { result } = renderHook(() => useDisplayName('lead-form'));

      expect(result.current).toBe('mutex-explanation');
    });

    it('answers with the id it was given for a terminal it knows nothing about', () => {
      const { result } = renderHook(() => useDisplayName('sess-nowhere'));

      expect(result.current).toBe('sess-nowhere');
    });

    /*
      A row about no session at all calls this with `''`, because a hook cannot
      be conditional. It must answer without walking the fleet, and the card
      discards the answer either way.
    */
    it('answers an empty id with itself, taking no other reading', () => {
      const { result } = renderHook(() => useDisplayName(''));

      expect(result.current).toBe('');
    });

    /*
      Once every session on a terminal has ended, `currentSessionIn` falls back to
      the id it was given — the original row — so this names the predecessor. The
      click resolves through the identical function, so words and destination
      still agree, which is the property that actually matters.
    */
    it('names the row the click would open once the lineage has ended', () => {
      useHiveStore.getState().renameSession('lead-form', 'Mutex explanation');
      const successor = useHiveStore.getState().clearSession('lead-form')!;
      useHiveStore.getState().finishSession(successor, false);

      const { result } = renderHook(() => useDisplayName('lead-form'));

      // The words describe the row the click resolves to — the same row, not
      // merely a plausible name.
      const row = useHiveStore.getState().entities[currentRowFor('lead-form')];
      expect(row && isSession(row) ? row.name : undefined).toBe(result.current);
      expect(result.current).toBe('mutex-explanation');
    });
  });

  describe('useSessionNameReports', () => {
    const nameFor = (
      reports: { terminalId: string; name: string }[],
      terminalId: string,
    ) => reports.find((entry) => entry.terminalId === terminalId)?.name;

    it('reports the string the rail is showing, id included', () => {
      const { result } = renderHook(() => useSessionNameReports());

      expect(nameFor(result.current, 'lead-form')).toBe('lead-form');
    });

    it('reports a renamed session under its new name', () => {
      const { result, rerender } = renderHook(() => useSessionNameReports());

      useHiveStore.getState().renameSession('lead-form', 'Mutex explanation');
      rerender();

      expect(nameFor(result.current, 'lead-form')).toBe('mutex-explanation');
    });

    /*
      Live rows only. An ended row keeps its own name and shares its terminal
      with the successor a `/clear` minted, so including both would report two
      names for one terminal and let the retired one win by list order.
    */
    it('drops a row once it has ended, and keeps its successor', () => {
      const successor = useHiveStore.getState().clearSession('lead-form')!;
      useHiveStore.getState().renameSession(successor, 'Mutex explanation');

      const { result } = renderHook(() => useSessionNameReports());

      const forTerminal = result.current.filter(
        (entry) => entry.terminalId === 'lead-form',
      );
      expect(forTerminal).toHaveLength(1);
      expect(forTerminal[0].name).toBe('mutex-explanation');
    });

    /*
      The identity of the array has to survive a store write that changed no
      name, or the effect that sends these would fire on every transcript line.
    */
    it('keeps its identity across a write that renamed nothing', () => {
      const { result, rerender } = renderHook(() => useSessionNameReports());
      const before = result.current;

      useHiveStore.getState().setSessionStatus('lead-form', 'working');
      rerender();

      expect(result.current).toBe(before);
    });
  });
});
