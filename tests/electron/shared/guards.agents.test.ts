// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  assertAgentName,
  IpcValidationError,
  parseAgentNameRequest,
  parseAgentRenameRequest,
  parseAgentRunRequest,
  parseAgentWriteRequest,
} from '../../../electron/shared/guards';

describe('assertAgentName', () => {
  it('accepts a kebab name', () => {
    expect(assertAgentName('slack-watcher', 'x')).toBe('slack-watcher');
  });

  it('refuses anything that could name a path', () => {
    expect(() => assertAgentName('../etc', 'x')).toThrow(IpcValidationError);
    expect(() => assertAgentName('a/b', 'x')).toThrow(IpcValidationError);
  });

  it('refuses upper case and underscores', () => {
    expect(() => assertAgentName('Slack_Watcher', 'x')).toThrow(
      IpcValidationError,
    );
  });

  it('refuses a reserved name at the boundary, not only in the reader', () => {
    // The reservation is part of the contract, so it is refused whichever way
    // in — the same argument assertSkillName makes.
    expect(() => assertAgentName('overmind', 'x')).toThrow(IpcValidationError);
    expect(() => assertAgentName('done', 'x')).toThrow(IpcValidationError);
  });

  /**
   * The session-id shape is reserved too (HIVE-115).
   *
   * `hive-store.ts` mints `sess-01`, `sess-02`, … and every one of those passes
   * `AGENT_NAME_PATTERN`. An agent wearing a live terminal's id is not a
   * cosmetic clash: the hook receiver routes on which register a name is in and
   * lets the *session* win a collision, so that agent's headless hooks would
   * move a real terminal's status dot and write its history — and its `/done`
   * would arm `/exit` on it.
   */
  it('refuses the session-id shape', () => {
    expect(() => assertAgentName('sess-01', 'x')).toThrow(IpcValidationError);
    expect(() => assertAgentName('sess-1', 'x')).toThrow(IpcValidationError);
    // The prefix is what the fleet reads as "this is a terminal", so the whole
    // of it is reserved rather than only the two-digit base-36 form.
    expect(() => assertAgentName('sess-watcher', 'x')).toThrow(IpcValidationError);
  });

  it('still accepts a name that merely contains the prefix', () => {
    // Reserved at the start, not anywhere: `assess-risk` is an ordinary name.
    expect(assertAgentName('assess-risk', 'x')).toBe('assess-risk');
  });

  it('refuses a non-string', () => {
    expect(() => assertAgentName(3, 'x')).toThrow(IpcValidationError);
  });
});

describe('parseAgentWriteRequest', () => {
  it('accepts a well-formed write', () => {
    expect(parseAgentWriteRequest({ name: 'a', source: '---\n' })).toEqual({
      name: 'a',
      source: '---\n',
    });
  });

  it('refuses a non-string source', () => {
    expect(() => parseAgentWriteRequest({ name: 'a', source: 3 })).toThrow(
      IpcValidationError,
    );
  });

  it('refuses an unexpected key', () => {
    expect(() =>
      parseAgentWriteRequest({ name: 'a', source: 's', extra: 1 }),
    ).toThrow(IpcValidationError);
  });

  it('refuses a missing key', () => {
    expect(() => parseAgentWriteRequest({ name: 'a' })).toThrow(
      IpcValidationError,
    );
  });

  it('refuses a prototype-polluting key outright', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":1},"name":"a","source":"s"}',
    ) as unknown;

    expect(() => parseAgentWriteRequest(hostile)).toThrow(IpcValidationError);
    expect((({} as Record<string, unknown>).polluted)).toBeUndefined();
  });

  it('keeps a body with tabs and newlines, which an AGENT.md legitimately has', () => {
    const source = '---\nname: a\n---\n\tindented\nand a line\n';

    expect(parseAgentWriteRequest({ name: 'a', source }).source).toBe(source);
  });
});

describe('parseAgentNameRequest and parseAgentRenameRequest', () => {
  it('accepts a name request', () => {
    expect(parseAgentNameRequest({ name: 'a' })).toEqual({ name: 'a' });
  });

  it('refuses an empty name request', () => {
    expect(() => parseAgentNameRequest({})).toThrow(IpcValidationError);
  });

  it('accepts a rename request', () => {
    expect(parseAgentRenameRequest({ from: 'a', to: 'b' })).toEqual({
      from: 'a',
      to: 'b',
    });
  });

  it('validates both halves of a rename, not just the destination', () => {
    expect(() => parseAgentRenameRequest({ from: '../x', to: 'b' })).toThrow(
      IpcValidationError,
    );
  });

  it('refuses a half-formed rename', () => {
    expect(() => parseAgentRenameRequest({ from: 'a' })).toThrow(
      IpcValidationError,
    );
  });
});

/**
 * HIVE-115. The one guard in this file that stands in front of a **process**,
 * so what it refuses matters more than what it accepts.
 */
describe('parseAgentRunRequest', () => {
  it('accepts a name', () => {
    expect(parseAgentRunRequest({ name: 'slack-watcher' })).toEqual({
      name: 'slack-watcher',
    });
  });

  it('is bounded by the same grammar as the five verbs before it', () => {
    expect(() => parseAgentRunRequest({ name: '../../claude' })).toThrow(
      IpcValidationError,
    );
    expect(() => parseAgentRunRequest({ name: 'Slack Watcher' })).toThrow(
      IpcValidationError,
    );
    expect(() => parseAgentRunRequest({ name: 'overmind' })).toThrow(
      IpcValidationError,
    );
  });

  it('refuses a payload trying to say anything about the command line', () => {
    // The closed key set is the assertion: an extra field is *refused*, not
    // ignored, so a renderer that starts sending one fails at the boundary
    // rather than developing a belief that main is reading it.
    expect(() =>
      parseAgentRunRequest({ name: 'a', trigger: 'ledger' }),
    ).toThrow(IpcValidationError);
    expect(() =>
      parseAgentRunRequest({ name: 'a', env: { PATH: '/tmp' } }),
    ).toThrow(IpcValidationError);
  });

  it('refuses a request with no name at all', () => {
    expect(() => parseAgentRunRequest({})).toThrow(IpcValidationError);
    expect(() => parseAgentRunRequest(null)).toThrow(IpcValidationError);
  });
});
