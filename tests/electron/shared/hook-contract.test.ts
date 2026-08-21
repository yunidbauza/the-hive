import { describe, expect, it } from 'vitest';

import { HOOK_EVENTS, HOOK_STATUS } from '@shared/hook-contract';

describe('hook contract', () => {
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
