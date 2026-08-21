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

  it('drops phantom agents on reset, so a cleared session starts clean', () => {
    const t = createStatusTracker();
    const e = 'sess-8';

    t.apply({ entityId: e, event: 'UserPromptSubmit' });
    t.apply({ entityId: e, event: 'SubagentStart', agentId: 'X' });
    t.apply({ entityId: e, event: 'Stop' });
    t.reset(e);
    expect(t.apply({ entityId: e, event: 'Stop' })).toEqual({ status: 'idle' });
  });
});
