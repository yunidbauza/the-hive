// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createReceiver } from '../../electron/main/hooks/receiver';
import { hookSettings } from '../../electron/main/hooks/settings';
import {
  createNotifier,
  createNotificationHub,
} from '../../electron/main/notifications';
import { NOTIFICATION_TYPE_STATUS } from '../../electron/shared/hook-contract';
import { CH } from '../../electron/shared/ipc-contract';
import type { HiveNotification } from '../../electron/shared/notification-contract';
import type { SessionStatusEvent } from '../../electron/shared/session-contract';

/**
 * Hook conformance: the whole chain against a real `claude`.
 *
 * ## Why this is not a unit test, and not deleted either
 *
 * Everything below the receiver is already covered by tests that post a body
 * *this file's author wrote*. That is the weakness: the entire defect this
 * story fixes was a wrong belief about what Claude Code actually sends. A test
 * built on the same belief would have passed happily on the broken build.
 *
 * So this one asks Claude. It spawns the real binary in a real pty with the
 * app's own settings file, waits for the sixty-second idle prompt, and asserts
 * on what came out the far end of the receiver, the notifier and the hub — the
 * same wiring `ipc/index.ts` and `sessions/index.ts` build.
 *
 * ## Why it is opt-in
 *
 * It needs the binary, a network, an authenticated account and about three and
 * a half minutes, none of which CI has. `describe.skipIf` makes the default
 * cost one skipped suite. Run it with `pnpm test:hooks`, and run it whenever
 * the Claude Code version this app targets moves — it is the only thing here
 * that can notice the vocabulary changing under it.
 *
 * ## What it proved on the build that introduced it
 *
 * The two scenarios no longer converge on the same status (HIVE-81). `say ok`
 * ends the turn — `Stop` already set `idle`, and the `idle_prompt` sixty
 * seconds later is not a session blocked on anything, so it stays `idle`; the
 * inbox row is what carries the signal instead, off the hook *event* rather
 * than the status. `AskUserQuestion` really is blocked on a human — a tool is
 * waiting for a yes — and that is `waiting`, unchanged.
 *
 * ```
 * say ok            -> UserPromptSubmit working
 *                   -> Stop             idle
 *                   -> Notification     idle     idle_prompt        (+60s)
 *                   => 1 row: session.input_needed, presented, badge 1
 *
 * AskUserQuestion   -> UserPromptSubmit  working
 *                   -> PermissionRequest waiting
 *                   -> Notification      waiting  permission_prompt (+6s)
 *                   -- driver answers the question --
 *                   -> PostToolUse       working                    (the fix)
 *                   => 1 row: session.waiting, presented, badge 1   (not two)
 * ```
 *
 * ## Why the driver answers the question (the review's second finding)
 *
 * It used to kill `claude` with the permission still outstanding, which meant
 * no tool ever completed and `PostToolUse` — the load-bearing half of Part 3
 * and the first high-frequency hook this app subscribes — was never exercised
 * against a real binary at all. Nothing proved a session ever *leaves*
 * `waiting`, which is the entire bug Part 3.4 fixes.
 *
 * So the driver presses Enter on the question after the `Notification` that
 * follows it has had time to arrive, and the scenario's own deadline is short
 * enough that the `idle_prompt` sixty seconds after the resulting `Stop` lands
 * well outside the run — otherwise this scenario would race a second inbox row
 * and the exactly-one assertion would flake. That is why `deadline` and
 * `answerAt` are per-scenario rather than one shared budget.
 */
const RUN = process.env.HIVE_LIVE_HOOK_PROOF === '1';

describe.skipIf(!RUN)('real claude -> receiver -> notifier -> hub', () => {
  it.each([
    {
      scenario: 'a turn that ended with nobody typing',
      prompt: 'say ok, nothing else',
      type: 'idle_prompt',
      /**
       * Asserted as a literal, not read back out of `NOTIFICATION_TYPE_STATUS`
       * (the review's third point).
       *
       * This file's whole job is to pin the app's beliefs against what the real
       * binary does, and a test that derives its expectation from the constant
       * under test can only ever prove the constant equals itself — edit
       * `idle_prompt` back to `'waiting'` and it would stay green while the bug
       * it exists to catch came straight back. The literal is the belief; the
       * cross-check below then asserts the shared constant still agrees with
       * it, so the constant is pinned rather than consulted.
       */
      status: 'idle',
      kind: 'session.input_needed',
      /** Long enough for `Stop`, then the idle prompt sixty seconds later. */
      deadline: 105,
      /** Nothing to answer — no tool ever runs in this one. */
      answerAt: null,
      /** No block to leave, so no `PostToolUse` to expect. */
      completesTool: false,
    },
    {
      scenario: 'a tool blocked on a human, then answered',
      prompt:
        'Use the AskUserQuestion tool right now to ask me whether I prefer tabs or spaces. Do nothing else.',
      type: 'permission_prompt',
      status: 'waiting',
      kind: 'session.waiting',
      /**
       * Deliberately short. The answer lands at 45s and `Stop` a few seconds
       * later, so the `idle_prompt` this session would eventually get is due
       * around 110s — comfortably outside the run. Stretching this to the other
       * scenario's 105s would let a second inbox row race the assertions below.
       */
      deadline: 65,
      /**
       * After the `Notification/permission_prompt` that trails the
       * `PermissionRequest` by about six seconds, with room to spare: the row
       * and the badge are asserted for the *blocked* session, so the question
       * must be seen before it is answered.
       */
      answerAt: 45,
      completesTool: true,
    },
  ])(
    '$scenario: reports $status via $type and raises exactly one notification',
    { timeout: 300_000 },
    async ({
      prompt,
      type: expectedType,
      status: expectedStatus,
      kind: expectedKind,
      deadline,
      answerAt,
      completesTool,
    }) => {
      const statuses: SessionStatusEvent[] = [];
      const raised: HiveNotification[] = [];
      const presented: string[] = [];
      let badge = -1;

      const hub = createNotificationHub({
        prefs: () => ({}),
        present: ({ title }) => presented.push(title),
        broadcast: (n) => raised.push(n),
        activate: () => undefined,
        announceRead: () => undefined,
        announceUnread: (count) => {
          badge = count;
        },
        announceDismissed: () => undefined,
        now: () => Date.now(),
      });
      const notifier = createNotifier({ hub, isForeground: () => false });

      // Exactly what `sessions/index.ts` does: publish the status, and tap the
      // same broadcast the notifier observes.
      const publish = (event: SessionStatusEvent): void => {
        statuses.push(event);
        notifier.observe(
          CH.sessionStatus,
          event as unknown as Record<string, unknown>,
        );
      };

      const receiver = createReceiver({
        knowsSession: (id) => id === 'sess-live',
        onMetrics: () => {},
        onEvent: (e) =>
          publish({
            entityId: e.entityId,
            status: e.status,
            event: e.event,
            ...(e.notificationType === undefined
              ? {}
              : { notificationType: e.notificationType }),
          }),
        onTicketIntent: () => undefined,
        onCleared: () => undefined,
      });

      const url = await receiver.start();
      expect(url).not.toBeNull();

      const dir = mkdtempSync(join(tmpdir(), 'hive-live-'));
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify(hookSettings(url as string)));

      // A real pty, so the TUI behaves as it does in a session.
      const driver = [
        'import os, pty, time, select',
        `env = dict(os.environ, HIVE_SESSION_ID='sess-live', HIVE_HOOK_TOKEN=${JSON.stringify(receiver.token)}, TERM='xterm-256color')`,
        "env.pop('CLAUDE_CODE_CHILD_SESSION', None)",
        `argv = ['claude', '--settings', ${JSON.stringify(settingsPath)}, '--model', 'haiku']`,
        'pid, fd = pty.fork()',
        "if pid == 0: os.execvpe('claude', argv, env)",
        `answer_at = ${answerAt === null ? 'None' : String(answerAt)}`,
        'start = time.time(); step = 0',
        `while time.time() - start < ${deadline}:`,
        '    r, _, _ = select.select([fd], [], [], 0.3)',
        '    if r:',
        '        try: d = os.read(fd, 65536)',
        '        except OSError: break',
        '        if not d: break',
        '    now = time.time() - start',
        `    if step == 0 and now > 8: os.write(fd, ${JSON.stringify(prompt)}.encode()); step = 1`,
        "    elif step == 1 and now > 11: os.write(fd, b'\\r'); step = 2",
        // Enter on the highlighted option: the answer the tool was blocked on.
        "    elif step == 2 and answer_at is not None and now > answer_at: os.write(fd, b'\\r'); step = 3",
        'try: os.kill(pid, 9)',
        'except Exception: pass',
      ].join('\n');

      await new Promise<void>((resolve) => {
        const child = spawn('python3', ['-c', driver], { stdio: 'ignore' });
        child.on('exit', () => resolve());
      });

      await receiver.stop();

      console.info('STATUSES  ', JSON.stringify(statuses));
      console.info(
        'RAISED    ',
        JSON.stringify(
          raised.map((n) => ({ kind: n.kind, title: n.title, body: n.body })),
        ),
      );
      console.info('PRESENTED ', JSON.stringify(presented), 'BADGE', badge);

      // The turn ran, and the `Notification` hook is what carries the type in
      // both scenarios — but not the same status any more (HIVE-81).
      // `permission_prompt` is a session genuinely blocked on a human, so it is
      // still `waiting`; `idle_prompt` fires a minute after `Stop` already set
      // `idle`, with nothing blocked, so it stays `idle` and the inbox row is
      // what carries the signal instead.
      expect(statuses.map((s) => s.status)).toContain('working');
      const waited = statuses.findIndex(
        (s) => s.status === expectedStatus && s.event === 'Notification',
      );
      expect(statuses[waited]?.notificationType).toBe(expectedType);

      /*
        The shared mapping still agrees with what the binary just did. Asserted
        against the literal above rather than used to derive it, so editing the
        constant fails here instead of quietly moving the expectation with it.
      */
      expect(
        NOTIFICATION_TYPE_STATUS[
          expectedType as keyof typeof NOTIFICATION_TYPE_STATUS
        ],
      ).toBe(expectedStatus);

      /**
       * A session **leaves** `waiting`, and what takes it out is `PostToolUse`
       * (Part 3.4).
       *
       * The stuck-amber bug was that nothing lowered a permission block until
       * the turn ended: approve, watch the agent work for minutes, and the dot
       * still says "needs input". Only a scenario whose tool actually completes
       * can prove this, which is why the driver answers the question rather
       * than killing `claude` with it outstanding.
       */
      if (completesTool) {
        const after = statuses.slice(waited + 1);
        expect(after.map((s) => s.status)).toContain('working');
        expect(after.find((s) => s.event === 'PostToolUse')?.status).toBe(
          'working',
        );
      }

      /**
       * **One** row, whichever route got here.
       *
       * The `permission_prompt` case is the one that could have gone wrong:
       * `PermissionRequest` raises `session.waiting`, and the `Notification`
       * that follows it six seconds later must move the status and say nothing.
       * Answering the question afterwards must stay silent too — `PostToolUse`
       * reports `working`, which is not an event class.
       */
      expect(raised.map((n) => n.kind)).toEqual([expectedKind]);
      expect(presented).toHaveLength(1);
      expect(badge).toBe(1);
    },
  );
});
