import { describe, expect, it } from 'vitest';

import {
  parseSkillNameRequest,
  parseSkillRenameRequest,
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

/**
 * The only guard here with two name fields (HIVE-99).
 *
 * Which is the whole reason these cases exist in pairs. A guard that validated
 * the destination and trusted the source — on the grounds that the source came
 * from a list the renderer was *given* — would let a request name a folder main
 * never listed, and `rename(2)` is not fussy about which of its two arguments
 * was the dangerous one. Both run through the same `assertSkillName`, so every
 * refusal below holds in both positions.
 */
describe('parseSkillRenameRequest', () => {
  it('accepts two bare names', () => {
    expect(
      parseSkillRenameRequest({ from: 'standup', to: 'stand-up' }),
    ).toEqual({ from: 'standup', to: 'stand-up' });
  });

  it('refuses a traversal in the destination', () => {
    expect(() =>
      parseSkillRenameRequest({ from: 'standup', to: '../../../etc' }),
    ).toThrow();
  });

  it('refuses a traversal in the source, which is not the trusted one', () => {
    expect(() =>
      parseSkillRenameRequest({ from: '../../../etc/passwd', to: 'standup' }),
    ).toThrow();
  });

  it('refuses a separator in either position', () => {
    expect(() =>
      parseSkillRenameRequest({ from: 'a/b', to: 'standup' }),
    ).toThrow();
    expect(() =>
      parseSkillRenameRequest({ from: 'standup', to: 'a/b' }),
    ).toThrow();
  });

  it('refuses the reserved name in either position', () => {
    // Renaming *onto* `done` would shadow the built-in; renaming *away from*
    // it would move a file the app owns and rewrites on every launch.
    expect(() =>
      parseSkillRenameRequest({ from: 'standup', to: 'done' }),
    ).toThrow(/reserved/i);
    expect(() =>
      parseSkillRenameRequest({ from: 'done', to: 'standup' }),
    ).toThrow(/reserved/i);
  });

  it('refuses uppercase, which would collide on a case-insensitive disk', () => {
    expect(() =>
      parseSkillRenameRequest({ from: 'standup', to: 'Standup' }),
    ).toThrow();
  });

  it('refuses an empty name in either position', () => {
    expect(() => parseSkillRenameRequest({ from: '', to: 'standup' })).toThrow();
    expect(() => parseSkillRenameRequest({ from: 'standup', to: '' })).toThrow();
  });

  it('refuses a name that is not a string', () => {
    expect(() =>
      parseSkillRenameRequest({ from: 'standup', to: 42 }),
    ).toThrow();
  });

  it('refuses a missing key', () => {
    expect(() => parseSkillRenameRequest({ from: 'standup' })).toThrow();
    expect(() => parseSkillRenameRequest({ to: 'standup' })).toThrow();
  });

  it('refuses an unexpected key, like every other parser here', () => {
    expect(() =>
      parseSkillRenameRequest({ from: 'a', to: 'b', root: '/etc' }),
    ).toThrow();
  });

  it('refuses a prototype-polluting key', () => {
    expect(() =>
      parseSkillRenameRequest(
        JSON.parse('{"from":"a","to":"b","__proto__":{"x":1}}'),
      ),
    ).toThrow();
  });

  it('carries two equal names through — intent is not this guard\'s business', () => {
    /*
      Refusing this here would be the boundary holding an opinion about what the
      caller *meant* rather than about what the payload can *express*, which is
      the line every other parser in this file keeps. It is not an assertion
      that a self-rename works: main refuses it, because the destination exists
      — see the runtime's tests.
    */
    expect(parseSkillRenameRequest({ from: 'standup', to: 'standup' })).toEqual({
      from: 'standup',
      to: 'standup',
    });
  });
});
