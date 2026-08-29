// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  assertAgentName,
  IpcValidationError,
  parseAgentNameRequest,
  parseAgentRenameRequest,
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
