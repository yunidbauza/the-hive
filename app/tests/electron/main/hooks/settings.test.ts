// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_EVENTS,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
} from '../../../../electron/shared/hook-contract';
import { hookSettings } from '../../../../electron/main/hooks/settings';

/**
 * The settings file and the receiver are two halves of one contract (HIVE-62).
 *
 * The file names the headers Claude will send; the receiver authenticates on
 * exactly those names. A mismatch is silent and total — every hook answers 403,
 * every session's status falls back to pty inference, and nothing anywhere says
 * why. So the halves are pinned against the shared constants here rather than
 * against string literals, which would agree with themselves and nothing else.
 */
describe('hookSettings', () => {
  const URL = 'http://127.0.0.1:51234/hook';
  const settings = hookSettings(URL);

  it('subscribes to exactly the events the app handles', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
  });

  it('does not subscribe SessionEnd', () => {
    /**
     * `/clear` fires it on a live session. Subscribing it and calling it
     * `terminated` locked the user out of a working agent — see the note on
     * `HOOK_EVENTS`.
     */
    expect(Object.keys(settings.hooks)).not.toContain('SessionEnd');
  });

  it('posts every event to the receiver over http', () => {
    for (const event of HOOK_EVENTS) {
      const [entry] = settings.hooks[event] as { hooks: { type: string; url: string }[] }[];
      expect(entry!.hooks[0]!.type).toBe('http');
      expect(entry!.hooks[0]!.url).toBe(URL);
    }
  });

  it('sends the two headers the receiver authenticates on', () => {
    const handler = (
      settings.hooks.Stop as {
        hooks: { headers: Record<string, string>; allowedEnvVars: string[] }[];
      }[]
    )[0]!.hooks[0]!;

    expect(handler.headers[HOOK_HEADER_SESSION]).toBe(`$${HOOK_ENV_SESSION}`);
    expect(handler.headers[HOOK_HEADER_TOKEN]).toBe(`$${HOOK_ENV_TOKEN}`);
  });

  it('allowlists both variables, without which they arrive as literal $NAME', () => {
    /**
     * Claude will not interpolate an environment variable into a header unless
     * it is named here. Omitted, the receiver sees the literal string `$HIVE_…`
     * and answers 403 to everything — which looks exactly like a wrong token.
     */
    const handler = (
      settings.hooks.Stop as { hooks: { allowedEnvVars: string[] }[] }[]
    )[0]!.hooks[0]!;

    expect(handler.allowedEnvVars).toEqual([HOOK_ENV_SESSION, HOOK_ENV_TOKEN]);
  });

  it('is serialisable — it is written to disk as JSON', () => {
    expect(() => JSON.stringify(settings)).not.toThrow();
    expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
  });
});
