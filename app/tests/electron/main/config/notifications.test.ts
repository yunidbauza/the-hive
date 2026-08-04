// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../../electron/main/config/parse';
import { DEFAULT_NOTIFICATIONS } from '../../../../electron/shared/config-contract';

/**
 * Reading notification preferences (story 106).
 *
 * The block is optional on every existing file, so the load-bearing case is the
 * one where it is absent: every v1 and v2 config in the wild predates this
 * story, and none of them may change meaning or get rewritten because of it.
 */

const LABEL = 'config';

describe('DEFAULT_NOTIFICATIONS', () => {
  it('has the chatty class off and the two discrete ones on', () => {
    expect(DEFAULT_NOTIFICATIONS).toEqual({
      sessionDone: true,
      sessionIdle: false,
      cloneDone: true,
    });
  });
});

describe('parseConfig — notifications', () => {
  it('is absent on a file that has never had one', () => {
    const parsed = parseConfig('{"version":2}', LABEL);

    expect(parsed.notifications).toBeUndefined();
    expect(parsed.errors).toEqual([]);
  });

  it('is absent on a v1 file, which cannot have had one', () => {
    const parsed = parseConfig('{"version":1,"projects":[]}', LABEL);

    expect(parsed.notifications).toBeUndefined();
    expect(parsed.errors).toEqual([]);
  });

  it('reads a partial block without inventing the keys it omits', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"sessionIdle":true}}',
      LABEL,
    );

    expect(parsed.notifications).toEqual({ sessionIdle: true });
    expect(parsed.errors).toEqual([]);
  });

  it('reads all three when the file names all three', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"sessionDone":false,"sessionIdle":true,"cloneDone":false}}',
      LABEL,
    );

    expect(parsed.notifications).toEqual({
      sessionDone: false,
      sessionIdle: true,
      cloneDone: false,
    });
    expect(parsed.errors).toEqual([]);
  });

  it('no longer reports notifications as an unknown top-level key', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"cloneDone":false}}',
      LABEL,
    );

    expect(parsed.errors).toEqual([]);
  });

  it('reports a non-boolean rather than coercing it', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"sessionDone":"yes"}}',
      LABEL,
    );

    expect(parsed.errors).toContain(
      'config.notifications.sessionDone: expected a boolean — using the default',
    );
    expect(parsed.notifications).toEqual({});
  });

  it('keeps the good keys when one is bad — a typo is not a reason to lose the rest', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"sessionDone":1,"cloneDone":false}}',
      LABEL,
    );

    expect(parsed.notifications).toEqual({ cloneDone: false });
  });

  it('reports an unknown key inside the block', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"waiting":true}}',
      LABEL,
    );

    expect(parsed.errors).toContain(
      'config.notifications: unknown key "waiting" — ignored',
    );
  });

  it('reports a block that is not an object', () => {
    const parsed = parseConfig('{"version":2,"notifications":true}', LABEL);

    expect(parsed.errors).toContain(
      'config.notifications: expected an object — ignored',
    );
    expect(parsed.notifications).toBeUndefined();
  });

  it('rejects the whole file for a forbidden key inside the block', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":' + JSON.stringify(JSON.parse('{"__proto__":{"x":1}}')) + '}',
      LABEL,
    );

    expect(parsed.notifications).toBeUndefined();
  });

  it('is advisory, never fatal — a bad block still lets the app launch', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"sessionDone":"yes"},"projects":[]}',
      LABEL,
    );

    expect(parsed.fatal).toBe(false);
  });
});
