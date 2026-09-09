import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `config:set-remote`'s body, extracted from `registerIpcHandlers` by Ruling 28
 * so that `registerRemoteProxy` can answer the same verb from a process whose
 * local handlers are gone (HIVE-144).
 *
 * The extraction is what these tests are for. The behaviour itself is not new
 * — `remote-composition.test.ts` and the settings pane's own suite already
 * drive it through the local handler — but "the same verb, from two surfaces"
 * is a property only a directly-callable function can be asked about, and the
 * failure it guards against is a copy in the proxy drifting from the copy in
 * the handler.
 *
 * `../config` is mocked rather than run: `getConfig`/`setRemote` reach a real
 * file, and nothing here is a claim about config writing — that is
 * `config/index.ts`'s own suite, which owns the Ruling 19 invariant this
 * function merely honours the *timing* of.
 */

const getConfig = vi.fn();
const setRemote = vi.fn();

vi.mock('../../../../electron/main/config', () => ({ getConfig, setRemote }));

const { applySetRemote } = await import('../../../../electron/main/ipc/set-remote');

/** The stored block a partial payload merges onto. */
const stored = { mode: 'local' as const, host: 'mini.tail.ts.net', port: 7433 };

beforeEach(() => {
  // `restoreMocks` (vitest.config.ts) restores spies; these are module-scope
  // `vi.fn()`s, whose call history would otherwise carry across cases — and
  // the assertions below are about *how many times* `setRemote` was called.
  getConfig.mockReset();
  setRemote.mockReset();
  getConfig.mockReturnValue({ remote: { ...stored }, projects: [], marker: 'OLD_SNAPSHOT' });
  setRemote.mockReturnValue({ remote: { ...stored }, projects: [], marker: 'NEW_SNAPSHOT' });
});

describe('applySetRemote', () => {
  it('switches to the requested mode against the requested target', async () => {
    const switchMode = vi.fn().mockResolvedValue({ ok: true });

    await applySetRemote({ mode: 'remote', host: '127.0.0.1', port: 9000 }, switchMode);

    expect(switchMode).toHaveBeenCalledExactlyOnceWith('remote', {
      target: { host: '127.0.0.1', port: 9000 },
    });
  });

  /*
    Settings commits one field at a time — the address field on blur, the
    switch on a click — so a payload naming `host` alone must not reset `mode`
    and `port` to whatever a default says. Each `??` in the function is one of
    these three fields, and a partial payload is the only shape that can tell
    a missing `??` apart from a present one.
  */
  it('merges a partial payload onto the stored block rather than replacing it', async () => {
    const switchMode = vi.fn().mockResolvedValue({ ok: true });

    await applySetRemote({ host: '10.0.0.9' }, switchMode);

    expect(switchMode).toHaveBeenCalledExactlyOnceWith('local', {
      target: { host: '10.0.0.9', port: 7433 },
    });
  });

  it('writes the request and answers the fresh snapshot when the switch succeeds', async () => {
    const switchMode = vi.fn().mockResolvedValue({ ok: true });

    const result = await applySetRemote({ mode: 'remote', host: '127.0.0.1' }, switchMode);

    expect(setRemote).toHaveBeenCalledExactlyOnceWith({ mode: 'remote', host: '127.0.0.1' });
    expect(result).toEqual({
      switched: { ok: true },
      config: expect.objectContaining({ marker: 'NEW_SNAPSHOT' }),
    });
  });

  /*
    Ruling 19, and the assertion that matters is `setRemote` never being
    called: a version that wrote first and reverted on failure would satisfy
    a snapshot check and still leave the file naming a target the app was just
    told it cannot reach, for as long as the revert took.
  */
  it('writes nothing and answers the old snapshot when the switch is refused', async () => {
    const switchMode = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'connect-failed', message: 'ECONNREFUSED' });

    const result = await applySetRemote({ mode: 'remote', host: '127.0.0.1' }, switchMode);

    expect(setRemote).not.toHaveBeenCalled();
    expect(result).toEqual({
      switched: { ok: false, reason: 'connect-failed', message: 'ECONNREFUSED' },
      config: expect.objectContaining({ marker: 'OLD_SNAPSHOT' }),
    });
  });

  it('refuses a malformed payload before it reaches the switch', async () => {
    const switchMode = vi.fn();

    await expect(applySetRemote({ mode: 'sideways' }, switchMode)).rejects.toThrow();
    expect(switchMode).not.toHaveBeenCalled();
    expect(setRemote).not.toHaveBeenCalled();
  });
});
