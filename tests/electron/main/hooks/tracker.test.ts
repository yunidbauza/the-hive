import { describe, expect, it } from 'vitest';

import { createStatusTracker } from '../../../../electron/main/hooks/tracker';

/**
 * The measured trace from HIVE-83, replayed. A sibling tool completing while a
 * permission is outstanding must not lower `waiting`.
 */
describe('createStatusTracker', () => {
  it('keeps waiting when a sibling tool finishes mid-block', () => {
    const t = createStatusTracker();
    const e = 'sess-1';

    expect(t.apply({ entityId: e, event: 'UserPromptSubmit' })).toEqual({
      status: 'working',
    });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'A', toolName: 'Bash' });
    t.apply({
      entityId: e,
      event: 'PreToolUse',
      toolUseId: 'B',
      toolName: 'AskUserQuestion',
    });
    expect(
      t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'AskUserQuestion' }),
    ).toEqual({ status: 'waiting' });

    // The sibling. This is the event that used to say `working`.
    expect(
      t.apply({ entityId: e, event: 'PostToolUse', toolUseId: 'A', toolName: 'Bash' }),
    ).toEqual({ status: 'waiting' });

    // The blocked tool itself. This one really does unblock.
    expect(
      t.apply({
        entityId: e,
        event: 'PostToolUse',
        toolUseId: 'B',
        toolName: 'AskUserQuestion',
      }),
    ).toEqual({ status: 'working' });

    expect(t.apply({ entityId: e, event: 'Stop' })).toEqual({ status: 'idle' });
  });

  it('reports idle (agents) when the turn ended and a subagent is live', () => {
    const t = createStatusTracker();
    const e = 'sess-2';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'SubagentStart', agentId: 'X' });
    expect(t.apply({ entityId: e, event: 'Stop' })).toEqual({
      status: 'idle',
      detail: 'agents',
    });
    expect(t.apply({ entityId: e, event: 'SubagentStop', agentId: 'X' })).toEqual({
      status: 'idle',
    });
  });

  it('ignores a SubagentStop that never started', () => {
    const t = createStatusTracker();
    const e = 'sess-3';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'SubagentStart', agentId: 'X' });
    t.apply({ entityId: e, event: 'Stop' });
    // An internal helper agent, never announced.
    expect(t.apply({ entityId: e, event: 'SubagentStop', agentId: 'phantom' })).toEqual({
      status: 'idle',
      detail: 'agents',
    });
  });

  /**
   * The fallback path: a `Stop` that carried no `background_tasks` list, so
   * the inference is all there is (HIVE-90). A body over
   * `HOOK_MAX_BODY_BYTES` is the case that still reaches here.
   */
  it('reports idle (script) for an open background shell', () => {
    const t = createStatusTracker();
    const e = 'sess-4';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'S', toolName: 'Bash' });
    t.apply({
      entityId: e,
      event: 'PostToolUse',
      toolUseId: 'S',
      toolName: 'Bash',
      runInBackground: true,
    });
    expect(t.apply({ entityId: e, event: 'Stop' })).toEqual({
      status: 'idle',
      detail: 'script',
    });
    // Without a list, the inference's only way out: the re-invoke that
    // collects the result.
    expect(t.apply({ entityId: e, event: 'UserPromptSubmit' })).toEqual({
      status: 'working',
    });
  });

  /**
   * HIVE-90's case: the shell finished *inside* the turn.
   *
   * The agent started it, waited for it, read the result and ended the turn —
   * so there is no re-invoke coming, and the inference alone would hold
   * `script` until the user typed. Measured against 2.1.245, that `Stop`
   * carries `background_tasks: []`, and an observed empty list is what retires
   * the shell. Announcing this turn is the whole point: with the detail still
   * standing, HIVE-89's `session.idle` never fires and `session.input_needed`
   * stays suppressed under the same detail.
   */
  it('retires a background shell that finished inside its turn', () => {
    const t = createStatusTracker();
    const e = 'sess-4a';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'S', toolName: 'Bash' });
    t.apply({
      entityId: e,
      event: 'PostToolUse',
      toolUseId: 'S',
      toolName: 'Bash',
      runInBackground: true,
    });
    // The agent collected the output itself, still inside the turn.
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'R', toolName: 'Read' });
    t.apply({ entityId: e, event: 'PostToolUse', toolUseId: 'R', toolName: 'Read' });

    expect(t.apply({ entityId: e, event: 'Stop', backgroundShells: [] })).toEqual({
      status: 'idle',
    });
    expect(t.held(e).bgShells).toBe(0);
  });

  it('keeps idle (script) when the list says the shell is still running', () => {
    const t = createStatusTracker();
    const e = 'sess-4b';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'S', toolName: 'Bash' });
    t.apply({
      entityId: e,
      event: 'PostToolUse',
      toolUseId: 'S',
      toolName: 'Bash',
      runInBackground: true,
    });

    expect(
      t.apply({ entityId: e, event: 'Stop', backgroundShells: ['bcy0lrc5b'] }),
    ).toEqual({ status: 'idle', detail: 'script' });
    // A phantom `SubagentStop` carries the same list and changes nothing.
    expect(
      t.apply({
        entityId: e,
        event: 'SubagentStop',
        agentId: 'phantom',
        backgroundShells: ['bcy0lrc5b'],
      }),
    ).toEqual({ status: 'idle', detail: 'script' });
    // And the `Stop` after the re-invoke, once it has exited.
    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    expect(t.apply({ entityId: e, event: 'Stop', backgroundShells: [] })).toEqual({
      status: 'idle',
    });
  });

  /**
   * The sibling defect, same root (HIVE-90).
   *
   * `UserPromptSubmit` clears the inference, so a prompt typed while a shell is
   * still running used to land the *next* `Stop` as a true idle — one
   * `session.idle` mid-shell, and a second one when the shell's own re-invoke
   * ended. The list on that `Stop` restores the shell inside the same event,
   * so the stretch produces exactly one true idle: the last one.
   */
  it('restores a shell the typed prompt cleared, so one stretch is one idle', () => {
    const t = createStatusTracker();
    const e = 'sess-4c';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'S', toolName: 'Bash' });
    t.apply({
      entityId: e,
      event: 'PostToolUse',
      toolUseId: 'S',
      toolName: 'Bash',
      runInBackground: true,
    });
    t.apply({ entityId: e, event: 'Stop', backgroundShells: ['bcy0lrc5b'] });

    // The user types while the shell runs. The inference forgets it here.
    expect(t.apply({ entityId: e, event: 'UserPromptSubmit' })).toEqual({
      status: 'working',
    });
    expect(t.held(e).bgShells).toBe(0);

    // …and this `Stop` would have read as a true idle. The list corrects it.
    expect(
      t.apply({ entityId: e, event: 'Stop', backgroundShells: ['bcy0lrc5b'] }),
    ).toEqual({ status: 'idle', detail: 'script' });

    // The shell's own re-invoke, and the one true idle of the stretch.
    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    expect(t.apply({ entityId: e, event: 'Stop', backgroundShells: [] })).toEqual({
      status: 'idle',
    });
  });

  /**
   * A shell the inference never saw open at all — its `PostToolUse` was
   * truncated past `tool_use_id`, so nothing was ever added. The list is an
   * account of what is running, not a diff against what this app recorded.
   */
  it('adopts a background shell the inference never recorded', () => {
    const t = createStatusTracker();
    const e = 'sess-4d';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    expect(
      t.apply({ entityId: e, event: 'Stop', backgroundShells: ['bnnydgra2'] }),
    ).toEqual({ status: 'idle', detail: 'script' });
    expect(t.held(e).bgShells).toBe(1);
  });

  /**
   * A live subagent never reaches this set (HIVE-90). `receiver.ts` filters
   * `type: 'subagent'` out of `background_tasks`, so what arrives here while
   * an agent runs is an empty shell list — and `agents` outranks `script` in
   * `derive()` anyway. Pinned because the first cut of HIVE-90 got this wrong
   * in the receiver and turned `idle (agents)` into `idle (script)`.
   */
  it('keeps idle (agents) when the shell list is empty', () => {
    const t = createStatusTracker();
    const e = 'sess-4f';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'SubagentStart', agentId: 'X' });
    expect(
      t.apply({ entityId: e, event: 'Stop', backgroundShells: [] }),
    ).toEqual({ status: 'idle', detail: 'agents' });
    expect(
      t.apply({
        entityId: e,
        event: 'SubagentStop',
        agentId: 'X',
        backgroundShells: [],
      }),
    ).toEqual({ status: 'idle' });
  });

  it('leaves the inference alone when an event carries no list', () => {
    const t = createStatusTracker();
    const e = 'sess-4e';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'S', toolName: 'Bash' });
    t.apply({
      entityId: e,
      event: 'PostToolUse',
      toolUseId: 'S',
      toolName: 'Bash',
      runInBackground: true,
    });
    // A truncated `Stop` body: no list reached the tracker.
    expect(t.apply({ entityId: e, event: 'Stop' })).toEqual({
      status: 'idle',
      detail: 'script',
    });
    // The `idle_prompt` a minute later carries no list either, and the detail
    // stands — this is the residual limitation armedIdle's doc records.
    expect(
      t.apply({
        entityId: e,
        event: 'Notification',
        notificationType: 'idle_prompt',
      }),
    ).toEqual({ status: 'idle', detail: 'script' });
  });

  it('stays waiting when a subagent blocks after the main agent stopped', () => {
    const t = createStatusTracker();
    const e = 'sess-5';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'SubagentStart', agentId: 'X' });
    t.apply({ entityId: e, event: 'Stop' });
    t.apply({
      entityId: e,
      event: 'PreToolUse',
      toolUseId: 'C',
      toolName: 'Bash',
      agentId: 'X',
    });
    expect(
      t.apply({
        entityId: e,
        event: 'PermissionRequest',
        toolName: 'Bash',
        agentId: 'X',
      }),
    ).toEqual({ status: 'waiting' });
  });

  it('releases an unpaired block when a tool finishes without an id', () => {
    const t = createStatusTracker();
    const e = 'sess-6';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    // No PreToolUse: the body was truncated past `tool_use_id`.
    expect(t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Write' })).toEqual(
      { status: 'waiting' },
    );
    expect(t.apply({ entityId: e, event: 'PostToolUse', toolName: 'Write' })).toEqual({
      status: 'working',
    });
  });

  it('does not double-count the permission_prompt echo', () => {
    const t = createStatusTracker();
    const e = 'sess-7';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'B', toolName: 'Bash' });
    t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Bash' });
    t.apply({
      entityId: e,
      event: 'Notification',
      notificationType: 'permission_prompt',
    });
    // One block, released by the one tool.
    expect(
      t.apply({ entityId: e, event: 'PostToolUse', toolUseId: 'B', toolName: 'Bash' }),
    ).toEqual({ status: 'working' });
  });

  /**
   * Review Fix 2. Measured against real Claude Code 2.1.238: approving a
   * permission ~3s after the request produced no `permission_prompt` echo at
   * all. The race this guards is the sub-second one — the echo already in
   * flight when the answer lands — where the echo arrives *after* the block
   * was already resolved by its own `PostToolUse`. Before this guard, that
   * stale echo re-asserted `UNPAIRED` and nothing but the next
   * `UserPromptSubmit` could ever clear it again.
   */
  it('does not re-assert a block the echo answers after it was already resolved', () => {
    const t = createStatusTracker();
    const e = 'sess-9';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'B', toolName: 'Bash' });
    t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Bash' });
    // Answered before the echo arrives.
    expect(
      t.apply({ entityId: e, event: 'PostToolUse', toolUseId: 'B', toolName: 'Bash' }),
    ).toEqual({ status: 'working' });

    // The delayed echo must not re-block a session that has moved on.
    expect(
      t.apply({
        entityId: e,
        event: 'Notification',
        notificationType: 'permission_prompt',
      }),
    ).toEqual({ status: 'working' });
  });

  it('still recovers a missed PermissionRequest with the echo', () => {
    const t = createStatusTracker();
    const e = 'sess-10';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    // No PermissionRequest was observed at all — the echo is the only signal.
    expect(
      t.apply({
        entityId: e,
        event: 'Notification',
        notificationType: 'permission_prompt',
      }),
    ).toEqual({ status: 'waiting' });
  });

  /**
   * The regression the session-wide guard introduced: tool A's PostToolUse
   * left `postToolUseSincePermissionRequest` true, and nothing reset it before
   * tool B's own PermissionRequest POST was dropped. The echo for B's request
   * then found the flag still set from A and stayed silent — a session
   * genuinely blocked on B reported `working`. A new `PreToolUse` (B's) must
   * re-arm the guard so the echo can recover the missed request.
   */
  it('lets a new PreToolUse re-arm the echo guard after an unrelated tool resolved', () => {
    const t = createStatusTracker();
    const e = 'sess-13';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'A', toolName: 'Bash' });
    t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Bash' });
    t.apply({ entityId: e, event: 'PostToolUse', toolUseId: 'A', toolName: 'Bash' });

    // B's own PermissionRequest POST never arrives.
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'C', toolName: 'Write' });

    expect(
      t.apply({
        entityId: e,
        event: 'Notification',
        notificationType: 'permission_prompt',
      }),
    ).toEqual({ status: 'waiting' });
  });

  /**
   * The case the guard was added for still holds: with no intervening
   * `PreToolUse` after A's request was answered, the echo has nothing new to
   * report and must stay suppressed.
   */
  it('keeps the echo guard suppressed with no intervening PreToolUse', () => {
    const t = createStatusTracker();
    const e = 'sess-14';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'A', toolName: 'Bash' });
    t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Bash' });
    t.apply({ entityId: e, event: 'PostToolUse', toolUseId: 'A', toolName: 'Bash' });

    expect(
      t.apply({
        entityId: e,
        event: 'Notification',
        notificationType: 'permission_prompt',
      }),
    ).toEqual({ status: 'working' });
  });

  /**
   * Review Fix 5 / spec §5.3: an id-less `PostToolUse` clears a blocked entry
   * by name only when exactly one matches. Without this, a truncated
   * `PostToolUse` for an unrelated tool clears *any* `UNPAIRED` block it finds
   * — including a live `Elicitation`'s, which carries no tool identity of its
   * own and so must never be assumed to match.
   */
  it('ignores an id-less PostToolUse for an unrelated tool, protecting a live Elicitation block', () => {
    const t = createStatusTracker();
    const e = 'sess-11';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    expect(t.apply({ entityId: e, event: 'Elicitation' })).toEqual({
      status: 'waiting',
    });

    // A large Write elsewhere in the batch, truncated past `tool_use_id`.
    expect(
      t.apply({ entityId: e, event: 'PostToolUse', toolName: 'Write' }),
    ).toEqual({ status: 'waiting' });
  });

  it('ignores an id-less PostToolUse when more than one blocked entry shares its name', () => {
    const t = createStatusTracker();
    const e = 'sess-12';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'A', toolName: 'Write' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'B', toolName: 'Write' });
    t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Write' });
    t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Write' });

    // Both blocked entries are named `Write` — ambiguous, so neither clears.
    expect(
      t.apply({ entityId: e, event: 'PostToolUse', toolName: 'Write' }),
    ).toEqual({ status: 'waiting' });
  });

  it('drops phantom agents on reset, so a cleared session starts clean', () => {
    const t = createStatusTracker();
    const e = 'sess-8';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'SubagentStart', agentId: 'X' });
    t.apply({ entityId: e, event: 'Stop' });
    t.reset(e);
    expect(t.apply({ entityId: e, event: 'Stop' })).toEqual({ status: 'idle' });
  });

  /**
   * HIVE-83's self-review bug, replayed end to end: a `Write` needing
   * permission carries the whole file in `tool_input`, so `PreToolUse`,
   * `PermissionRequest` and `PostToolUse` all truncate past
   * `HOOK_MAX_BODY_BYTES`. Measured wire order puts `tool_name` before
   * `tool_input` and `tool_use_id` after it, so every truncated event here
   * recovers a name and never an id — `PreToolUse` still records nothing (an
   * `outstanding` entry needs both), but `PermissionRequest` can still name
   * its block and the later id-less `PostToolUse` can still clear it by that
   * name. Without the name, the block is `UNPAIRED` with no name on record and
   * nothing but the next `UserPromptSubmit` would ever clear it — the session
   * would sit on `waiting` through `Stop` while genuinely idle.
   */
  it('resolves a fully id-less permission trace by name instead of stranding on waiting', () => {
    const t = createStatusTracker();
    const e = 'sess-15';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    // Truncated past tool_use_id *and* tool_name: nothing to record.
    t.apply({ entityId: e, event: 'PreToolUse' });
    expect(t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Write' })).toEqual(
      { status: 'waiting' },
    );

    // The user approves; the tool runs and finishes, also truncated.
    expect(t.apply({ entityId: e, event: 'PostToolUse', toolName: 'Write' })).toEqual({
      status: 'working',
    });

    expect(t.apply({ entityId: e, event: 'Stop' })).toEqual({ status: 'idle' });
  });

  /**
   * HIVE-86. The bookkeeping leaks below are deliberately invisible to
   * `derive()` — `resolve()` prefers the newest match, so a stale entry loses
   * every race it could enter and no status is ever wrong because of one.
   * That is exactly why they need `held()`: the defect is the growth itself,
   * and asserting on status could never catch it.
   */
  it('forgets a tool whose permission the user escaped', () => {
    const t = createStatusTracker();
    const e = 'sess-16';

    /*
      Measured against Claude Code 2.1.239: Escape at a permission prompt emits
      no event whatsoever — no PostToolUse, no PermissionDenied, not even Stop,
      though the TUI cancels the prompt and ends the turn. Fifty seconds of
      silence in the probe. So the `PreToolUse` entry can only be cleared at the
      next prompt, never by an event of its own.
    */
    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    for (const id of ['A', 'B', 'C']) {
      t.apply({ entityId: e, event: 'PreToolUse', toolUseId: id, toolName: 'Bash' });
      t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Bash' });
      // The user hits Escape. Nothing arrives. The next thing is them typing.
      t.apply({ entityId: e, event: 'UserPromptSubmit' });
    }

    // Three escaped prompts, nothing retained — not three entries, nor one.
    expect(t.held(e)).toEqual({ outstanding: 0, blocked: 0, agents: 0, bgShells: 0 });
  });

  /**
   * The hazard the naive fix would have introduced, and the reason a blanket
   * clear on `UserPromptSubmit` is wrong: the internal re-invoke that delivers
   * a subagent's result *is* a `UserPromptSubmit`, indistinguishable from a
   * typed one (measured — identical key sets, see the tracker's comment). Only
   * entries that are also `blocked` may be dropped there.
   */
  it('keeps a subagent tool in flight across the internal re-invoke', () => {
    const t = createStatusTracker();
    const e = 'sess-17';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'SubagentStart', agentId: 'S' });
    t.apply({
      entityId: e,
      event: 'PreToolUse',
      toolUseId: 'T',
      toolName: 'Bash',
      agentId: 'S',
    });
    t.apply({ entityId: e, event: 'Stop' });

    // A second subagent finishing re-invokes the agent while S's tool runs on.
    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    expect(t.held(e)).toEqual({
      outstanding: 1,
      blocked: 0,
      agents: 1,
      bgShells: 0,
    });

    // And it still pairs when it completes.
    t.apply({
      entityId: e,
      event: 'PostToolUse',
      toolUseId: 'T',
      toolName: 'Bash',
      agentId: 'S',
    });
    expect(t.held(e).outstanding).toBe(0);
  });

  /**
   * The sweep's known cost, pinned so it stays known: a subagent's blocked
   * tool *is* dropped by a re-invoke. `resolve()` matches on `agentId`, so a
   * subagent's `PermissionRequest` resolves to its own id and lands in
   * `blocked` — which the intersection then drops.
   *
   * This is not a regression: `blocked.clear()` already discarded that id
   * before HIVE-86, so the status is identical either way. The test exists so
   * that anyone widening the sweep sees what it already gives up.
   */
  it('drops a subagent block on the re-invoke, exactly as blocked.clear() already did', () => {
    const t = createStatusTracker();
    const e = 'sess-23';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'SubagentStart', agentId: 'S' });
    t.apply({
      entityId: e,
      event: 'PreToolUse',
      toolUseId: 'T',
      toolName: 'Bash',
      agentId: 'S',
    });
    expect(
      t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Bash', agentId: 'S' }),
    ).toEqual({ status: 'waiting' });
    expect(t.held(e)).toEqual({ outstanding: 1, blocked: 1, agents: 1, bgShells: 0 });

    // Another subagent's result re-invokes the agent. Nobody answered anything.
    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    expect(t.held(e)).toEqual({ outstanding: 0, blocked: 0, agents: 1, bgShells: 0 });
  });

  /**
   * Asymmetric truncation: a small `tool_input` keeps `tool_use_id` on the
   * `PreToolUse`, and a large `tool_response` truncates it off the matching
   * `PostToolUse` — a `Read` of a big file. `blocked` already recovers by
   * unique name; `outstanding` never did.
   */
  it('pairs an id-less PostToolUse with its outstanding entry by name', () => {
    const t = createStatusTracker();
    const e = 'sess-18';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'R', toolName: 'Read' });
    t.apply({ entityId: e, event: 'PostToolUse', toolName: 'Read' });

    expect(t.held(e).outstanding).toBe(0);
  });

  it('leaves an ambiguous id-less PostToolUse alone', () => {
    const t = createStatusTracker();
    const e = 'sess-19';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'R1', toolName: 'Read' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'R2', toolName: 'Read' });
    t.apply({ entityId: e, event: 'PostToolUse', toolName: 'Read' });

    // Two candidates: releasing either would be a guess about which finished.
    expect(t.held(e).outstanding).toBe(2);
  });

  /**
   * The trap in "exactly one match": uniqueness among *recorded* entries is not
   * uniqueness among *running tools*. A tool whose own `PreToolUse` was
   * truncated (a large `tool_input` — the documented `Write`/`Edit` case) was
   * never recorded at all, so the one match left is a different tool that is
   * still running, and retiring it strands the session.
   */
  it('leaves outstanding alone while a same-named unrecorded tool is in flight', () => {
    const t = createStatusTracker();
    const e = 'sess-22';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    // The small one: `tool_use_id` survives, so it is recorded.
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'SMALL', toolName: 'Write' });
    // The big one: truncated past `tool_use_id`, so nothing is recorded for it.
    t.apply({ entityId: e, event: 'PreToolUse', toolName: 'Write' });

    // The big one finishes first, also truncated. SMALL is the only *recorded*
    // Write — and it is emphatically not the one that just completed.
    t.apply({ entityId: e, event: 'PostToolUse', toolName: 'Write' });
    expect(t.held(e).outstanding).toBe(1);

    // Which matters because SMALL is what the permission is about. If it were
    // gone, this resolves to UNPAIRED and nothing can ever clear it.
    expect(t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Write' })).toEqual(
      { status: 'waiting' },
    );
    expect(
      t.apply({ entityId: e, event: 'PostToolUse', toolUseId: 'SMALL', toolName: 'Write' }),
    ).toEqual({ status: 'working' });
    expect(t.apply({ entityId: e, event: 'Stop' })).toEqual({ status: 'idle' });
  });

  /**
   * With a subagent live, an id-less `PostToolUse` retires nothing at all.
   *
   * Not because `agentId` distinguishes them — it cannot. `receiver.ts`
   * recovers no agent id from a truncated body, so `input.agentId` is
   * `undefined` on every event that reaches this branch, whether it came from
   * the main agent or from inside a subagent. Since whose completion this is
   * genuinely cannot be known, the only safe answer is to retire nothing and
   * let the entry leak.
   */
  it('retires nothing from an id-less PostToolUse while a subagent is live', () => {
    const t = createStatusTracker();
    const e = 'sess-20';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'SubagentStart', agentId: 'S' });
    // One tool in each: the subagent's, and the main agent's.
    t.apply({
      entityId: e,
      event: 'PreToolUse',
      toolUseId: 'SUB',
      toolName: 'Read',
      agentId: 'S',
    });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'MAIN', toolName: 'Read' });

    // Truncated, so indistinguishable in origin. Neither may be retired — and
    // in particular this must not retire MAIN, which is still running.
    t.apply({ entityId: e, event: 'PostToolUse', toolName: 'Read' });
    expect(t.held(e).outstanding).toBe(2);

    // Once the subagent is gone, the ambiguity is too.
    t.apply({ entityId: e, event: 'SubagentStop', agentId: 'S' });
    t.apply({ entityId: e, event: 'PostToolUse', toolUseId: 'SUB', toolName: 'Read' });
    t.apply({ entityId: e, event: 'PostToolUse', toolName: 'Read' });
    expect(t.held(e).outstanding).toBe(0);
  });

  /**
   * `resolve()` walks `outstanding` without copying it (HIVE-86). The property
   * that rewrite must preserve: the newest matching entry wins, and one
   * already blocked is skipped.
   */
  it('still resolves a permission to the newest unblocked tool of that name', () => {
    const t = createStatusTracker();
    const e = 'sess-21';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'OLD', toolName: 'Bash' });
    t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Bash' });
    // OLD is blocked. A second Bash starts and blocks too.
    t.apply({ entityId: e, event: 'PreToolUse', toolUseId: 'NEW', toolName: 'Bash' });
    t.apply({ entityId: e, event: 'PermissionRequest', toolName: 'Bash' });

    // Answering NEW leaves OLD blocked: two distinct blocks, not one.
    expect(
      t.apply({ entityId: e, event: 'PostToolUse', toolUseId: 'NEW', toolName: 'Bash' }),
    ).toEqual({ status: 'waiting' });
    expect(
      t.apply({ entityId: e, event: 'PostToolUse', toolUseId: 'OLD', toolName: 'Bash' }),
    ).toEqual({ status: 'working' });
  });
});
