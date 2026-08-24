import { describe, expect, it } from 'vitest';

import {
  parseSkillNameRequest,
  parseSkillWriteRequest,
} from '../../../electron/shared/guards';

/**
 * The skills payload guards (HIVE-96).
 *
 * These are stricter than the `fs` guards next door, and the difference is the
 * point. `assertRelPath` has to admit a *path* and then defend containment on
 * the resolved result, because the explorer legitimately navigates a tree. A
 * skill name is not a path and never becomes one: main joins it onto a
 * directory it owns, so the guard's job is to make a path **unrepresentable**
 * rather than to sanitise one.
 *
 * That is why the traversal cases below are not really about `..`. They assert
 * that the name pattern refuses everything that is not a bare name, which makes
 * the `join` in `skills/index.ts` total by construction.
 */
describe('parseSkillNameRequest', () => {
  it('accepts the pattern the pane accepts', () => {
    expect(parseSkillNameRequest({ name: 'ship-it' })).toEqual({
      name: 'ship-it',
    });
  });

  it('accepts digits, which a name may legitimately carry', () => {
    expect(parseSkillNameRequest({ name: 'triage-v2' })).toEqual({
      name: 'triage-v2',
    });
  });

  it('refuses a traversal', () => {
    expect(() => parseSkillNameRequest({ name: '../../etc/passwd' })).toThrow();
  });

  it('refuses a bare dot segment', () => {
    expect(() => parseSkillNameRequest({ name: '..' })).toThrow();
  });

  it('refuses a separator', () => {
    expect(() => parseSkillNameRequest({ name: 'a/b' })).toThrow();
  });

  it('refuses an absolute path', () => {
    expect(() => parseSkillNameRequest({ name: '/etc/passwd' })).toThrow();
  });

  it('refuses uppercase, which would collide on a case-insensitive disk', () => {
    expect(() => parseSkillNameRequest({ name: 'Standup' })).toThrow();
  });

  it('refuses a space', () => {
    expect(() => parseSkillNameRequest({ name: 'stand up' })).toThrow();
  });

  it('refuses the reserved name, so the built-in cannot be shadowed', () => {
    expect(() => parseSkillNameRequest({ name: 'done' })).toThrow(/reserved/i);
  });

  it('refuses an empty name', () => {
    expect(() => parseSkillNameRequest({ name: '' })).toThrow();
  });

  it('refuses a name that is not a string', () => {
    expect(() => parseSkillNameRequest({ name: 42 })).toThrow();
  });

  it('refuses an unexpected key, like every other parser here', () => {
    expect(() => parseSkillNameRequest({ name: 'ok', path: '/etc' })).toThrow();
  });

  it('refuses a missing key', () => {
    expect(() => parseSkillNameRequest({})).toThrow();
  });

  it('refuses a prototype-polluting key', () => {
    expect(() =>
      parseSkillNameRequest(JSON.parse('{"name":"ok","__proto__":{"x":1}}')),
    ).toThrow();
  });
});

describe('parseSkillWriteRequest', () => {
  it('carries the body through untouched — a SKILL.md is a document', () => {
    /*
      No control-character sweep, for the reason `parseWriteFileRequest` gives
      about source files: tabs and newlines are ordinary here, and what makes
      the write safe is where the bytes land, not what they are.
    */
    const body = '---\nname: x\n---\nLine one.\n\n\tIndented.\n';

    expect(parseSkillWriteRequest({ name: 'x', body })).toEqual({
      name: 'x',
      body,
    });
  });

  it('refuses a body that is not a string', () => {
    expect(() => parseSkillWriteRequest({ name: 'x', body: 42 })).toThrow();
  });

  it('applies the same name rule as the read verb', () => {
    expect(() =>
      parseSkillWriteRequest({ name: 'done', body: 'anything' }),
    ).toThrow(/reserved/i);
  });

  it('refuses a missing body', () => {
    expect(() => parseSkillWriteRequest({ name: 'x' })).toThrow();
  });
});
