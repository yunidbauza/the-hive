import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isSession } from '@/types/entity';
import { isDesktop } from '@config/runtime';
import { peek } from '@lib/fake-clock';
import { resetProjectConfig } from '@lib/project-config';
import { requestSpawn } from '@lib/terminal/pty-transport';
import { sendToSession } from '@lib/terminal/session-input';

import { ACK_DELAY_MS, useHiveStore } from '@stores/hive-store';
import { parseCommand } from '@features/orchestrator/utils/parse-command';
import { useUiStore } from '@stores/ui-store';
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

/**
 * Reference pattern for store tests (story 013): call the action against a
 * fresh store and assert the resulting state. No React involved.
 *
 * Timer-based behaviour is driven with fake timers, never with real waits.
 */
describe('hive-store', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
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
      expect(state.prs).toHaveLength(4);
      expect(state.notifs).toHaveLength(5);
      expect(state.feed).toHaveLength(7);
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

    it('derives the branch from the generated id', () => {
      const id = useHiveStore.getState().spawnSession('referral-api');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.branch).toBe(`feat/${id}`);
      expect(isSession(session) && session.project).toBe('referral-api');
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

    it('pushes a feed item', () => {
      const before = useHiveStore.getState().feed.length;
      const id = useHiveStore.getState().spawnSession('design-system');

      const feed = useHiveStore.getState().feed;
      expect(feed).toHaveLength(before + 1);
      expect(feed[0].txt).toBe(`Spawned ${id} on design-system`);
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
      expect(last?.text).toBe('❯ [orchestrator] y');
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
      expect(entity.lines.at(-1)?.text).toBe('✱ Working…');
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
      expect(entity.lines.at(-1)?.text).toBe('❯ [orchestrator] y');
    });

    it('is a no-op for an unknown entity', () => {
      expect(useHiveStore.getState().sendToEntity('nope', 'hi')).toBeNull();
    });

    it('pushes a feed item', () => {
      useHiveStore.getState().sendToEntity('call-notes', 'immutable');
      expect(useHiveStore.getState().feed[0].txt).toBe(
        'Routed your reply to call-notes',
      );
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

      it('still logs the routing to the activity feed', () => {
        useHiveStore.getState().sendToEntity('lead-form', 'y');

        expect(useHiveStore.getState().feed[0].txt).toBe(
          'Routed your reply to lead-form',
        );
      });

      it('names the origin in the feed, as the demo path does', () => {
        useHiveStore.getState().sendToEntity('lead-form', 'y', 'session');

        expect(useHiveStore.getState().feed[0].txt).toBe(
          'Routed your message to lead-form',
        );
      });

      it('reports a refusal, writes nothing, and says so in the feed', () => {
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
        expect(useHiveStore.getState().feed[0].txt).toBe(
          'Could not route to lead-form — lead-form has exited — restart it to send again',
        );
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
        expect(entity.lines.at(-1)?.text).toBe('❯ [orchestrator] y please');
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
    it('markRead clears exactly one notification', () => {
      useHiveStore.getState().markRead(0);
      const notifs = useHiveStore.getState().notifs;

      expect(notifs[0].unread).toBe(false);
      expect(notifs[1].unread).toBe(true);
    });

    it('markAllRead clears every notification', () => {
      useHiveStore.getState().markAllRead();
      expect(
        useHiveStore.getState().notifs.every((n) => !n.unread),
      ).toBe(true);
    });
  });

  describe('pushFeed', () => {
    it('prepends, so the newest item reads first', () => {
      useHiveStore.getState().pushFeed({
        time: '15:00',
        txt: 'newest',
        tone: 'green',
        icon: 'ph-lightning',
      });
      expect(useHiveStore.getState().feed[0].txt).toBe('newest');
    });

    it('caps the feed at 24 items', () => {
      for (let i = 0; i < 40; i += 1) {
        useHiveStore.getState().pushFeed({
          time: '15:00',
          txt: `item ${i}`,
          tone: 'brand',
          icon: 'ph-lightning',
        });
      }

      const feed = useHiveStore.getState().feed;
      expect(feed).toHaveLength(24);
      // The cap drops the oldest, not the newest.
      expect(feed[0].txt).toBe('item 39');
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

  describe('the activity feed clock', () => {
    it('stamps a spawn with the fake clock, not the wall clock', () => {
      useHiveStore.getState().spawnSession('apfm-web', 'a task');

      expect(useHiveStore.getState().feed[0].time).toBe('14:38');
    });

    it('advances one minute per feed event', () => {
      useHiveStore.getState().spawnSession('apfm-web', 'first');
      useHiveStore.getState().spawnSession('apfm-web', 'second');

      const [newest, older] = useHiveStore.getState().feed;
      expect(newest.time).toBe('14:39');
      expect(older.time).toBe('14:38');
    });

    /** Otherwise the second test in any file inherits the first one's minutes. */
    it('rewinds the clock on reset', () => {
      useHiveStore.getState().spawnSession('apfm-web', 'a task');
      useHiveStore.getState().reset();
    seedDemoFleet();

      expect(peek()).toBe('14:38');
    });
  });

  describe('pushNotif', () => {
    const notif = (title: string) => ({
      icon: 'ph-hand-palm',
      tone: 'amber' as const,
      title,
      sub: 'a subtitle',
      time: 'now',
      unread: true,
      target: 'lead-form',
    });

    it('prepends, so the newest notification is first', () => {
      useHiveStore.getState().pushNotif(notif('newest'));

      expect(useHiveStore.getState().notifs[0].title).toBe('newest');
    });

    it('caps the list at eight, dropping the oldest', () => {
      const before = useHiveStore.getState().notifs;
      expect(before).toHaveLength(5);
      const oldest = before[before.length - 1].title;

      for (let i = 0; i < 4; i += 1) {
        useHiveStore.getState().pushNotif(notif(`extra ${i}`));
      }

      const after = useHiveStore.getState().notifs;
      expect(after).toHaveLength(8);
      expect(after.map((n) => n.title)).not.toContain(oldest);
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
});
