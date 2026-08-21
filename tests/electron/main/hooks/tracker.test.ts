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
    // The only observable end: the agent is re-invoked with the result.
    expect(t.apply({ entityId: e, event: 'UserPromptSubmit' })).toEqual({
      status: 'working',
    });
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
});
