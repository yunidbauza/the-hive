// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createReceiver } from '../../electron/main/hooks/receiver';
import { hookSettings } from '../../electron/main/hooks/settings';
import { createStatusTracker } from '../../electron/main/hooks/tracker';
import {
  createNotifier,
  createNotificationHub,
} from '../../electron/main/notifications';
import {
  NOTIFICATION_TYPE_STATUS,
  type HookNotificationType,
  type IdleDetail,
  type ObservedStatus,
} from '../../electron/shared/hook-contract';
import { CH } from '../../electron/shared/ipc-contract';
import type {
  HiveNotification,
  NotificationKind,
} from '../../electron/shared/notification-contract';
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
 *                   -> Stop             idle      => row: session.idle (HIVE-89)
 *                   -> Notification     idle     idle_prompt        (+60s)
 *                   => 2 rows: session.idle (presented), session.input_needed
 *                      (inbox only), badge 2
 *
 * AskUserQuestion   -> UserPromptSubmit  working
 *                   -> PermissionRequest waiting
 *                   -> Notification      waiting  permission_prompt (+6s)
 *                   -- driver answers the question --
 *                   -> PostToolUse       working                    (the fix)
 *                   -> Stop              idle      => row: session.idle
 *                   => 2 rows: session.blocked, session.idle — both presented,
 *                      badge 2 (and not a second blocked row)
 * ```
 *
 * ## The fifth row (HIVE-89)
 *
 * Every scenario types a prompt and every scenario's turn ends inside the run
 * with nothing left running, so every scenario now raises exactly one
 * `session.idle` — the edge the notifier arms on `UserPromptSubmit` and spends
 * on the first `Stop` that is `idle` with no `idleDetail`. The two
 * detail scenarios are the ones that earn the kind, and both land the row on
 * the `Stop` after the internal re-invoke that collects the result — not on
 * the main agent's own earlier `Stop`, which still carries a detail, and not
 * on `SubagentStop` either. The first cut of this story raised at
 * `SubagentStop` too, and this file's run is what caught it: measured,
 * `SubagentStop` idle -> internal `UserPromptSubmit` -> `Stop` idle, so that
 * produced two rows for one fact. `kinds` below is the ordered list the run
 * must produce, and is a literal for the same reason `status` is.
 *
 * `session.input_needed` reads "inbox only" rather than "presented" — its
 * `defaultDelivery` is `'inbox'`, not `'both'` (HIVE-83's Task 5: what makes
 * this kind chatty is the toast, not the row, and that matters more once a
 * session can sit in `idle (agents)` for a long time). This corrects the
 * belief this comment held when it was written against 47f0984, before that
 * change shipped — this file's live run is what caught the drift.
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
 *
 * ## Two more scenarios, and why the wiring below now includes the tracker
 * (HIVE-83, HIVE-85)
 *
 * The two scenarios above only ever have one tool outstanding, so nothing
 * distinguishes "the status derived per-event" from "the status derived from
 * what the session actually is" — `receiver.ts`'s own `HOOK_STATUS` fallback
 * happens to agree with `hooks/tracker.ts` in both of them. A **parallel**
 * batch is the only thing that can tell them apart: `PostToolUse` maps to
 * `working` unconditionally at the receiver, so a test that reads status
 * straight off the receiver would report the sibling's completion as
 * `working` even while the other tool is still blocked on a human — the exact
 * bug Part 3 fixes. So the wiring below now runs every event through a real
 * `createStatusTracker()`, exactly as `sessions/index.ts` does, and the
 * `PostToolUse` assertion is **id-aware**: only the `PostToolUse` whose
 * `toolUseId` matches the blocked tool's may report `working`; any other
 * tool's completion must still read `waiting`.
 *
 * The fourth scenario proves the other half of HIVE-83: a subagent still
 * running after the main agent's `Stop` reports `idle (agents)` rather than
 * plain `idle`, and the detail clears once the subagent's own `SubagentStop`
 * lands — not on some *other* `SubagentStop`. Claude Code emits
 * `SubagentStop` for internal helper agents that never announced a
 * `SubagentStart`; the tracker only clears an agent id it saw start, so a
 * phantom stop leaves `idleDetail` exactly where it was.
 *
 * The fifth scenario is spec §8's background-shell case: a `Bash` tool run
 * with `tool_input.run_in_background: true` reports `idle (script)` once the
 * main agent's `Stop` lands, with the shell itself still alive. The brief
 * this scenario was written against assumed nothing would clear the detail
 * inside the run, since it tells the agent not to wait for the shell — but
 * the measured trace disagreed: Claude Code sent its own internal
 * `UserPromptSubmit` once `sleep 30` exited, well inside the deadline, and
 * that is exactly the re-invoke spec §2.3 documents. The assertion below is
 * written to the measurement, not the brief.
 *
 * ## The sixth scenario, and the field the fifth one's run never looked at
 * (HIVE-90)
 *
 * The fifth scenario only ever exercises a shell that **outlives** its turn,
 * which is the case the tracker's inference happens to get right. A shell that
 * finishes *inside* its turn — started, waited for, collected, turn ended —
 * gets no re-invoke, so nothing ever cleared `bgShells` and the `Stop` reported
 * `idle (script)` about a process that had already exited. After HIVE-89 that
 * stopped being a wrong dot and became silence: a live detail suppresses
 * `session.idle` and `session.input_needed` alike, so the one session that was
 * genuinely the user's announced nothing until they typed.
 *
 * What the sixth scenario measured is that Claude Code was already saying so.
 * `Stop` and `SubagentStop` carry a `background_tasks` array — the live list,
 * `[{id, type, status: 'running', …}]` while the shell runs and `[]` once it
 * has exited, in **both** scenarios. It is the only observation of a
 * backgrounded process *ending* that exists, since no hook fires when one dies,
 * and `receiver.ts` now reads it and `tracker.ts` replaces `bgShells` from it.
 * The two scenarios below are therefore a pair: the fifth pins that a live
 * shell still reads `idle (script)` at `Stop`, and the sixth that a finished
 * one does not.
 *
 * And this file earned its keep again on the way: the first cut read
 * `background_tasks` whole, and the **subagent** scenario went red. The array
 * is a union — a live subagent sits in it as
 * `{ id: '<agent id>', type: 'subagent', status: 'running', agent_type: … }`,
 * alongside the shells — so an unfiltered read turned that scenario's
 * `idle (agents)` into `idle (script)` on its `SubagentStop`. Two things
 * followed. `receiver.ts` filters to `type: 'shell'`, and subagents keep being
 * tracked from `SubagentStart` / `SubagentStop`, which is also the *fresher*
 * signal: the same run shows a subagent still listed as `running` in the
 * `background_tasks` of its own `SubagentStop`, the list being a snapshot taken
 * before the stop is applied. A unit test could not have found either, because
 * both are facts about a body this file's author would otherwise have written
 * from the same wrong belief.
 *
 * The residual limitation is on the wire order, and this file cannot catch it:
 * `last_assistant_message` precedes `background_tasks`, so a final message over
 * `HOOK_MAX_BODY_BYTES` truncates the list away and the tracker falls back to
 * inferring. `receiver.test.ts` pins that case with a body it builds itself,
 * which is the right tool for it — the belief being tested there is about a
 * byte cap this app chose, not about what Claude Code sends.
 */
const RUN = process.env.HIVE_LIVE_HOOK_PROOF === '1';

/**
 * One scenario driven end to end against the real binary.
 *
 * Widened past the two original scenarios' shape (HIVE-83, HIVE-85): `type`
 * and `kind` are nullable because the subagent scenario raises no
 * `Notification` and no inbox row at all, and `idleDetail` is optional
 * because only that scenario asserts one.
 */
interface Scenario {
  scenario: string;
  prompt: string;
  type: HookNotificationType | null;
  status: ObservedStatus;
  idleDetail?: IdleDetail;
  /** Every inbox row the run raises, in order (HIVE-89 widened this from one). */
  kinds: NotificationKind[];
  /**
   * How many toasts this scenario's row is expected to produce.
   *
   * Not derivable from `kinds` inside this file — see the literal-not-derived
   * discipline `NOTIFICATION_TYPE_STATUS` follows above. `session.blocked` is
   * `defaultDelivery: 'both'`; `session.input_needed` is deliberately
   * `'inbox'` only (HIVE-83's Task 5) — a row still lands and the badge still
   * counts it, but no toast. The live run is what caught this file's own
   * belief going stale when that shipped. `session.idle` is `'both'` (HIVE-89)
   * and every scenario raises one, so every count below is one higher than it
   * was.
   */
  presentedCount: number;
  deadline: number;
  answerAt: number | null;
  completesTool: boolean;
  /**
   * The event whose status must be the first, after `Stop`, with no
   * `idleDetail` — proving the detail cleared on the right trigger and not a
   * phantom one (HIVE-83).
   *
   * Both scenarios that carry this field clear inside the run: the subagent
   * one on its own `SubagentStop`, and — measured, not assumed, see the
   * background-shell scenario's own comment — the background-shell one on
   * the *internal* `UserPromptSubmit` Claude Code sends itself once the
   * backgrounded process is inferred to have finished, per spec §5.2/§2.3.
   * That re-invoke landed well inside this scenario's deadline even though
   * the prompt told the agent not to wait for the shell.
   */
  clearedBy?: 'SubagentStop' | 'UserPromptSubmit' | 'Stop';
  /**
   * This scenario really did background a shell (HIVE-90).
   *
   * Without it the sixth scenario could pass vacuously: "the `Stop` carried no
   * `idleDetail`" is trivially true of a run where no shell was ever started,
   * which is the one way an agent could disobey the prompt and still look
   * green. Asserted off a `PostToolUse` carrying `run_in_background`, which is
   * the event the tracker's own inference feeds on.
   */
  backgroundsAShell?: true;
}

/**
 * A published status, widened with the tool identity the tracker needs to
 * pair a `PostToolUse` with the `PreToolUse` that opened it.
 *
 * `toolUseId` never reaches the real renderer — `sessions/index.ts`'s own
 * `publishHookStatus` does not forward it, and `SessionStatusEvent` has no
 * field for it — this is test-only bookkeeping so the assertions below can
 * tell the blocked tool's own completion from a sibling's.
 */
interface TestStatusEvent extends SessionStatusEvent {
  toolUseId?: string;
  /** Also test-only, and for the same reason — see `Scenario.backgroundsAShell`. */
  runInBackground?: boolean;
}

const scenarios: Scenario[] = [
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
    kinds: ['session.idle', 'session.input_needed'],
    /** `session.idle` toasts; `session.input_needed` is `inbox` only — see `Scenario.presentedCount`. */
    presentedCount: 1,
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
    kinds: ['session.blocked', 'session.idle'],
    /** Both `defaultDelivery: 'both'` — a toast each. */
    presentedCount: 2,
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
  {
    scenario: 'a parallel batch with one tool blocked on a human',
    prompt:
      "In one single message make two parallel tool calls: first the Bash tool running the command 'sleep 20 && echo done', and second the AskUserQuestion tool asking whether I prefer tabs or spaces. Both must be in the same assistant message so they run in parallel.",
    type: 'permission_prompt',
    status: 'waiting',
    kinds: ['session.blocked', 'session.idle'],
    presentedCount: 2,
    /**
     * The measured trace: `Bash`'s `PostToolUse` lands at ~27s while the
     * `AskUserQuestion` permission is still outstanding, and the answer lands
     * at 70s. 90s gives `Stop` room after that with no risk of the
     * `idle_prompt` sixty seconds later racing the assertions below.
     */
    deadline: 90,
    answerAt: 70,
    completesTool: true,
  },
  {
    scenario: 'a subagent still working after the main agent stopped',
    prompt:
      "Call the Agent tool now with subagent_type 'general-purpose' and this exact prompt: 'Run the bash command: echo hello-from-subagent and report what it printed.' Do not do the work yourself.",
    type: null,
    status: 'idle',
    idleDetail: 'agents',
    /** No `Notification` fires; the one row is the `Stop` after the re-invoke (HIVE-89). */
    kinds: ['session.idle'],
    presentedCount: 1,
    /**
     * Measured trace: `PreToolUse Agent` and `SubagentStart` ~23s, the main
     * agent's own `Stop` ~25s, the subagent's own tool events ~25-29s,
     * `SubagentStop` ~31s. 75s leaves room for the main agent to resume and
     * finish without brushing against the `idle_prompt` this session would
     * otherwise eventually get.
     */
    deadline: 75,
    answerAt: null,
    completesTool: false,
    clearedBy: 'SubagentStop',
  },
  {
    scenario: 'a background shell still open after the main agent stopped',
    prompt:
      "Use the Bash tool with run_in_background set to true to run the command 'sleep 30; echo finished-bg'. Do not wait for it — start it, tell me you started it, and end your turn.",
    type: null,
    status: 'idle',
    idleDetail: 'script',
    /** No `Notification` fires; the one row is the `Stop` after the re-invoke (HIVE-89). */
    kinds: ['session.idle'],
    presentedCount: 1,
    /**
     * Measured trace, timings from the driver's Enter at ~12s: `PreToolUse
     * Bash` with `tool_input.run_in_background: true` ~5s later -> `PostToolUse`
     * ~7s (returns immediately, the process still alive) -> `Stop` ~9s — so
     * `Stop` lands around 21s absolute. 70s leaves comfortable room for that
     * and the assertions below with no risk of the `idle_prompt` sixty seconds
     * after `Stop` (~81s) racing them, since the run ends at the deadline.
     *
     * **Measured divergence from the brief this scenario was written against**:
     * the prompt says "do not wait for it", but Claude Code sends an internal
     * `UserPromptSubmit` on its own once `sleep 30` exits — the exact
     * re-invoke spec §2.3 documents — and it landed well inside this deadline
     * (real run: `Stop` idle/script -> a phantom `SubagentStop` that leaves
     * the detail untouched -> `UserPromptSubmit` working, clearing it -> a
     * second `Stop` idle with no detail). `clearedBy: 'UserPromptSubmit'`
     * below asserts that real behaviour rather than the "never clears inside
     * the run" belief this scenario started from.
     */
    deadline: 70,
    /** Nothing to answer — the shell is fire-and-forget. */
    answerAt: null,
    completesTool: false,
    clearedBy: 'UserPromptSubmit',
    backgroundsAShell: true,
  },
  {
    scenario: 'a background shell that finished inside its turn',
    /**
     * Every tool named, and no others — the one prompt here that has to
     * over-specify.
     *
     * "Poll it until it finishes" is the natural phrasing and it is too open:
     * a real run took it as licence to reach for `Monitor`, which needs a
     * permission this driver never answers, so the turn never ended and the
     * scenario failed on a shape that had nothing to do with what it tests.
     * The other scenarios can be loose because their assertions are about the
     * *first* thing the agent does; this one asserts on the `Stop`, so
     * everything between the prompt and it has to be reachable without a
     * human. A foreground `sleep` is the wait, and `Read` is the collection —
     * both auto-approved in this pty, as scenario three's `Bash` sibling
     * already demonstrates.
     */
    prompt:
      "Use the Bash tool with run_in_background set to true to run this exact command: 'sleep 12; echo finished-bg'. Then use the Bash tool a second time, in the foreground and without run_in_background, to run 'sleep 20'. Then use the Read tool on the background shell's output file and tell me exactly what it printed. Use only the Bash and Read tools.",
    type: null,
    /**
     * `idle` with **no detail** on the main agent's own `Stop` — the assertion
     * HIVE-90 exists for, and the one that fails on the build before it.
     */
    status: 'idle',
    kinds: ['session.idle'],
    presentedCount: 1,
    /**
     * Measured trace, 2.1.245, timings from the driver's Enter at ~11s:
     *
     * ```
     * 13.84  PreToolUse   Bash   tool_input.run_in_background: true
     * 14.63  PostToolUse  Bash   tool_response.backgroundTaskId: 'bnnydgra2'
     * 18.02  PreToolUse   Read   tasks/bnnydgra2.output      <- the collection
     * 18.04  PostToolUse  Read
     *   … the wait, then a Read that finds the output …
     * 30.61  PostToolUse  Read   content: 'finished-bg\n\n[exited with code 0]\n'
     * 32.71  Stop                background_tasks: []
     * 37.00  SubagentStop        background_tasks: []        <- phantom, agent_type ''
     * 92.82  Notification        idle_prompt
     * ```
     *
     * Two things that trace settles. The collecting tool is a **`Read` of the
     * task's output file**, not a tool with the shell's identity in its name —
     * so "retire the shell when the tool that collects it finishes" had
     * nothing to key on, and the design that keys on `background_tasks`
     * instead is the measurement's, not the brief's. And `Stop` carries that
     * list at all, which the ticket did not know: it asked whether *anything*
     * was observable, and the answer is the whole live account, on the one
     * event where it is needed.
     *
     * 70s puts the assertions comfortably after a `Stop` at ~40s and well
     * before the `idle_prompt` sixty seconds later, which would otherwise race
     * the exactly-one-row assertion.
     */
    deadline: 70,
    /** Nothing to answer — the agent waits for the shell itself. */
    answerAt: null,
    /**
     * No permission is ever requested, so there is no blocked tool to prove
     * leaves `waiting`. The `Read` pairs still exercise `PostToolUse`, and
     * `held.outstanding` below is what proves they all paired.
     */
    completesTool: false,
    /**
     * The `Stop` itself — there is no later clearing event, because there is
     * nothing left to clear. That is the difference from the scenario above,
     * and stating it as `'Stop'` rather than omitting the field keeps the
     * assertion a claim about *which* event rather than an absence of one.
     */
    clearedBy: 'Stop',
    backgroundsAShell: true,
  },
];

describe.skipIf(!RUN)('real claude -> receiver -> notifier -> hub', () => {
  it.each(scenarios)(
    '$scenario: reports $status',
    { timeout: 300_000 },
    async ({
      prompt,
      type: expectedType,
      status: expectedStatus,
      idleDetail: expectedIdleDetail,
      kinds: expectedKinds,
      presentedCount,
      deadline,
      answerAt,
      completesTool,
      clearedBy,
      backgroundsAShell,
    }) => {
      const statuses: TestStatusEvent[] = [];
      const raised: HiveNotification[] = [];
      /** Index into `statuses` of the event each row was raised on (HIVE-89). */
      const raisedAtIndex: number[] = [];
      const presented: string[] = [];
      let badge = -1;

      const hub = createNotificationHub({
        prefs: () => ({}),
        present: ({ title }) => presented.push(title),
        broadcast: (n) => {
          raised.push(n);
          raisedAtIndex.push(statuses.length - 1);
        },
        activate: () => undefined,
        announceRead: () => undefined,
        announceUnread: (count) => {
          badge = count;
        },
        announceDismissed: () => undefined,
        now: () => Date.now(),
      });
      const notifier = createNotifier({ hub, isForeground: () => false });

      /**
       * A real tracker, one per run. `receiver.ts`'s own `HOOK_STATUS` is a
       * per-event fallback only — the honest, id-paired status is what
       * `hooks/tracker.ts` derives, which is what `sessions/index.ts` publishes
       * (HIVE-83). Reading `e.status` straight off the receiver here would
       * report every `PostToolUse` as `working` regardless of what else is
       * still blocked, which is precisely the bug this file exists to catch.
       */
      const statusTracker = createStatusTracker();

      // Exactly what `sessions/index.ts` does: publish the status, and tap the
      // same broadcast the notifier observes.
      const publish = (event: TestStatusEvent): void => {
        statuses.push(event);
        notifier.observe(
          CH.sessionStatus,
          event as unknown as Record<string, unknown>,
        );
      };

      const receiver = createReceiver({
        onDone: () => {},
        onReady: () => {},
        knowsSession: (id) => id === 'sess-live',
        onMetrics: () => {},
        onEvent: (e) => {
          const derived = statusTracker.apply({
            entityId: e.entityId,
            event: e.event,
            ...(e.toolUseId === undefined ? {} : { toolUseId: e.toolUseId }),
            ...(e.toolName === undefined ? {} : { toolName: e.toolName }),
            ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
            ...(e.runInBackground === undefined
              ? {}
              : { runInBackground: e.runInBackground }),
            ...(e.backgroundShells === undefined
              ? {}
              : { backgroundShells: e.backgroundShells }),
            ...(e.notificationType === undefined
              ? {}
              : { notificationType: e.notificationType }),
          });

          publish({
            entityId: e.entityId,
            status: derived.status,
            event: e.event,
            ...(e.notificationType === undefined
              ? {}
              : { notificationType: e.notificationType }),
            ...(e.toolName === undefined ? {} : { toolName: e.toolName }),
            ...(derived.detail === undefined
              ? {}
              : { idleDetail: derived.detail }),
            // Test-only: never forwarded past this point, see `TestStatusEvent`.
            ...(e.toolUseId === undefined ? {} : { toolUseId: e.toolUseId }),
            ...(e.runInBackground === undefined
              ? {}
              : { runInBackground: e.runInBackground }),
          });
        },
        onTicketIntent: () => undefined,
        onCleared: () => undefined,
        onLedgerRead: () => ({ entries: [], openAsks: [], claims: {} }),
        onLedgerPost: () => ({ ok: false, status: 503, reason: 'not exercised by this test' }),
      });

      const url = await receiver.start();
      expect(url).not.toBeNull();

      const dir = mkdtempSync(join(tmpdir(), 'hive-live-'));
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify(hookSettings(url as string)));

      // A real pty, so the TUI behaves as it does in a session.
      const driver = [
        'import os, pty, time, select',
        `env = dict(os.environ, HIVE_SESSION_ID='sess-live', HIVE_HOOK_TOKEN=${JSON.stringify(receiver.tokenFor('sess-live'))}, TERM='xterm-256color')`,
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

      const held = statusTracker.held('sess-live');
      console.info('HELD      ', JSON.stringify(held));

      // Every scenario types a prompt, so every scenario starts working.
      expect(statuses.map((s) => s.status)).toContain('working');

      /**
       * Nothing is still being held for a tool that finished (HIVE-86).
       *
       * The unit tests pin this against events *this file's author wrote*,
       * which is the same weakness the whole file exists to answer: the leak
       * they describe is a claim about what the real binary emits and when.
       * Here every tool in the scenario ran to completion against a real
       * `claude`, so an entry surviving the run means a pairing rule stopped
       * matching what Claude Code actually sends — the regression a fixture
       * cannot notice.
       *
       * Deliberately not asserted on `agents` or `bgShells`: two scenarios end
       * with one of those genuinely still open, which is the point of them.
       */
      expect(held.outstanding).toBe(0);

      if (expectedType !== null) {
        // The turn ran, and the `Notification` hook is what carries the type
        // in these scenarios — but not the same status any more (HIVE-81).
        // `permission_prompt` is a session genuinely blocked on a human, so it
        // is still `waiting`; `idle_prompt` fires a minute after `Stop`
        // already set `idle`, with nothing blocked, so it stays `idle` and the
        // inbox row is what carries the signal instead.
        const waited = statuses.findIndex(
          (s) => s.status === expectedStatus && s.event === 'Notification',
        );
        expect(statuses[waited]?.notificationType).toBe(expectedType);

        /*
          The shared mapping still agrees with what the binary just did.
          Asserted against the literal above rather than used to derive it, so
          editing the constant fails here instead of quietly moving the
          expectation with it.
        */
        expect(NOTIFICATION_TYPE_STATUS[expectedType]).toBe(expectedStatus);

        /**
         * A session **leaves** `waiting`, and what takes it out is the
         * `PostToolUse` for the **blocked tool specifically** (Part 3.4).
         *
         * The stuck-amber bug was that nothing lowered a permission block
         * until the turn ended: approve, watch the agent work for minutes,
         * and the dot still says "needs input". A sibling tool completing in
         * the same parallel batch must not lower it either — that was the
         * *replacement* bug Part 3 introduced and the reason this assertion
         * is id-aware rather than "any `PostToolUse` is `working`": the
         * `Bash` sibling's own `PostToolUse` lands at ~27s while
         * `AskUserQuestion` is still outstanding, and the session must still
         * read `waiting` there.
         */
        if (completesTool) {
          const after = statuses.slice(waited + 1);
          expect(after.map((s) => s.status)).toContain('working');

          // `PermissionRequest` carries the blocked tool's name; the newest
          // `PreToolUse` with that name carries the id it was opened under
          // (`hooks/tracker.ts`'s own `resolve()` does the same walk).
          const blockedName = statuses.find(
            (s) => s.event === 'PermissionRequest',
          )?.toolName;
          const blockedToolUseId = statuses.find(
            (s) => s.event === 'PreToolUse' && s.toolName === blockedName,
          )?.toolUseId;
          expect(blockedToolUseId).toBeDefined();

          const postToolUseEvents = after.filter(
            (s) => s.event === 'PostToolUse',
          );
          // The blocked tool really did complete — otherwise the loop below
          // would pass vacuously on a run where nothing ever answered it.
          expect(
            postToolUseEvents.some((s) => s.toolUseId === blockedToolUseId),
          ).toBe(true);
          for (const post of postToolUseEvents) {
            expect(post.status).toBe(
              post.toolUseId === blockedToolUseId ? 'working' : 'waiting',
            );
          }
        }

        /**
         * **One** row, whichever route got here.
         *
         * The `permission_prompt` case is the one that could have gone wrong:
         * `PermissionRequest` raises `session.blocked`, and the
         * `Notification` that follows it six seconds later must move the
         * status and say nothing. A sibling tool completing, and answering
         * the question afterwards, must both stay silent too — `PostToolUse`
         * reports a status, which is not an event class.
         *
         * The toast is a separate question from the row, and
         * `presentedCount` is what tells the two `session.blocked` scenarios
         * (`both`, one toast) apart from `idle_prompt`'s `session.input_needed`
         * (`inbox` only, zero toasts, HIVE-83's Task 5) — see
         * `Scenario.presentedCount`.
         */
        expect(raised.map((n) => n.kind)).toEqual(expectedKinds);
        expect(presented).toHaveLength(presentedCount);
        expect(badge).toBe(expectedKinds.length);
      } else {
        /**
         * The subagent and background-shell scenarios (HIVE-83). Neither ever
         * blocks on a human and no `Notification` fires inside either run, so
         * the only row is the `session.idle` edge (HIVE-89) — raised once,
         * and only once the detail has cleared.
         */
        expect(raised.map((n) => n.kind)).toEqual(expectedKinds);
        expect(presented).toHaveLength(presentedCount);
        expect(badge).toBe(expectedKinds.length);

        // The main agent's own `Stop`, while the subagent or the background
        // shell is still running.
        const stopIdx = statuses.findIndex((s) => s.event === 'Stop');
        expect(stopIdx).toBeGreaterThanOrEqual(0);
        expect(statuses[stopIdx]?.status).toBe(expectedStatus);
        expect(statuses[stopIdx]?.idleDetail).toBe(expectedIdleDetail);

        /*
          The shell really was backgrounded (HIVE-90). Without this the sixth
          scenario's "no `idleDetail` on `Stop`" is trivially true of a run
          where the agent ignored the prompt and ran the command in the
          foreground — see `Scenario.backgroundsAShell`.
        */
        if (backgroundsAShell === true) {
          expect(
            statuses.some(
              (s) => s.event === 'PostToolUse' && s.runInBackground === true,
            ),
          ).toBe(true);
        }

        /**
         * `idleDetail` clears once, on the right trigger — not a phantom one.
         *
         * The subagent scenario's trigger is the subagent's **own**
         * `SubagentStop`: Claude Code emits `SubagentStop` for internal
         * helper agents that never announced a `SubagentStart`, and
         * `hooks/tracker.ts` only clears an agent id it saw start, so a
         * phantom stop leaves `idleDetail` exactly where it was. The
         * background-shell scenario's trigger is the internal
         * `UserPromptSubmit` Claude Code sends itself once the backgrounded
         * process is inferred to have finished (spec §5.2/§2.3) — measured to
         * land well inside this scenario's deadline even though the prompt
         * told the agent not to wait for it (see the scenario's own comment).
         * Either way, the first status with no `idleDetail` after `Stop` is
         * necessarily the real clearing event.
         */
        expect(clearedBy).toBeDefined();
        /*
          From `stopIdx`, not `stopIdx + 1` (HIVE-90). The sixth scenario's
          clearing event *is* the `Stop` — its background shell had already
          exited, so the list on that body is empty and the detail never
          stands at all. For the two scenarios whose `Stop` does carry a
          detail, that first element fails the predicate and the search is
          the one it always was.
        */
        const cleared = statuses
          .slice(stopIdx)
          .find((s) => s.idleDetail === undefined);
        expect(cleared).toBeDefined();
        expect(cleared?.event).toBe(clearedBy);

        /**
         * The `session.idle` row landed on a true idle, never on the main
         * agent's own `Stop` while the detail was still live (HIVE-89). The
         * notifier observes the same published sequence, so the row's raise
         * must coincide with a status that is `idle` with no detail, at or
         * after the clearing event.
         */
        const raisedAt = raisedAtIndex[0];
        expect(raisedAt).toBeDefined();
        const edge = statuses[raisedAt as number];
        expect(edge?.event).toBe('Stop');
        expect(edge?.status).toBe('idle');
        expect(edge?.idleDetail).toBeUndefined();
        expect(raisedAt as number).toBeGreaterThanOrEqual(
          statuses.indexOf(cleared as TestStatusEvent),
        );
      }
    },
  );
});
