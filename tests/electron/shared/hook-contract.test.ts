import { describe, expect, it } from 'vitest';

import { HOOK_EVENTS, HOOK_STATUS, hookContextReply } from '@shared/hook-contract';

describe('hook contract', () => {
  it('types the context reply a hook may carry (HIVE-138)', () => {
    expect(hookContextReply('entry a12 in full')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'entry a12 in full',
      },
    });
  });

  it('subscribes the events the tracker needs', () => {
    for (const event of ['PreToolUse', 'SubagentStart', 'SubagentStop'] as const) {
      expect(HOOK_EVENTS).toContain(event);
    }
  });

  it('gives every status-bearing event a status', () => {
    for (const event of HOOK_EVENTS) {
      if (event === 'SessionEnd') continue;
      expect(HOOK_STATUS[event]).toBeDefined();
    }
  });
});
