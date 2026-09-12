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
    switch on a click — so a payload naming `host` alone must not reset `port`
    to whatever a default says. Each `??` under `target` is one of those
    fields, and a partial payload is the only shape that can tell a missing
    `??` apart from a present one.
  */
  it('merges a partial payload onto the stored block rather than replacing it', async () => {
    const switchMode = vi.fn().mockResolvedValue({ ok: true });

    await applySetRemote({ mode: 'local', host: '10.0.0.9' }, switchMode);

    expect(switchMode).toHaveBeenCalledExactlyOnceWith('local', {
      target: { host: '10.0.0.9', port: 7433 },
    });
  });

  /**
   * The blur that used to dial (HIVE-144 review, I6).
   *
   * `applySetRemote` read `request.mode ?? current.mode`, and Ruling 19
   * deliberately leaves this machine's `remote.mode` at `'remote'` after a
   * failed boot attach so the next launch retries — which is exactly when
   * someone is in the address field fixing it. So a blur called
   * `switchIpcMode('remote')`: local IPC unbound, a socket dialled, no
   * "Attaching…" rendered, and the outcome `void`ed, so every refusal arm was
   * invisible. On success the window attached on a blur, which is the live
   * connection behind a toggle `handleAttach` exists to prevent.
   *
   * The assertion is on the switcher's argument — that it is never reached at
   * all — because that is the only thing that distinguishes a write from a
   * dial. A version that switched to `'local'` instead would still tear down
   * a real attachment.
   */
  it('performs no switch at all when the payload names no mode, even with the file saying remote', async () => {
    getConfig.mockReturnValue({
      remote: { mode: 'remote', host: 'mini.tail.ts.net', port: 7433 },
      marker: 'OLD_SNAPSHOT',
    });
    const switchMode = vi.fn().mockResolvedValue({ ok: true });

    const result = await applySetRemote({ host: '10.0.0.9' }, switchMode);

    expect(switchMode).not.toHaveBeenCalled();
    // And it is still a write: the address the user typed reaches the file,
    // which is what the blur was for.
    expect(setRemote).toHaveBeenCalledExactlyOnceWith({ host: '10.0.0.9' });
    expect(result.switched).toEqual({ ok: true });
  });

  it('performs no switch for a bare port commit either', async () => {
    const switchMode = vi.fn().mockResolvedValue({ ok: true });

    await applySetRemote({ port: 9000 }, switchMode);

    expect(switchMode).not.toHaveBeenCalled();
    expect(setRemote).toHaveBeenCalledExactlyOnceWith({ port: 9000 });
  });

  it('writes the request and answers the fresh snapshot when the switch succeeds', async () => {
    const switchMode = vi.fn().mockResolvedValue({ ok: true });

    const result = await applySetRemote({ mode: 'remote', host: '127.0.0.1' }, switchMode);

    expect(setRemote).toHaveBeenCalledExactlyOnceWith({ mode: 'remote', host: '127.0.0.1' });
    expect(result).toEqual({
      switched: { ok: true },
      config: expect.objectContaining({ marker: 'NEW_SNAPSHOT' }),
      // No socket either side of the switch — see the `what changed` suite
      // below, which is where this field is actually exercised.
      changed: null,
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
      changed: null,
    });
  });

  it('refuses a malformed payload before it reaches the switch', async () => {
    const switchMode = vi.fn();

    await expect(applySetRemote({ mode: 'sideways' }, switchMode)).rejects.toThrow();
    expect(switchMode).not.toHaveBeenCalled();
    expect(setRemote).not.toHaveBeenCalled();
  });
});

/**
 * `SetRemoteResult.changed` (HIVE-144 review, I1).
 *
 * The whole attach-snapshot path used to end here. `RemoteClient.snapshot()`
 * had no production caller, so a server built seven `SNAPSHOT_CHANNELS` reads on
 * every accept, bounded them, sent them — and the client dropped them. And
 * nothing cleared entities across a switch, so the departed mode's metrics
 * rendered against the newly attached session wearing the same `sess-01`.
 *
 * This is where both are answered, and the property that makes it correct is
 * that `changed` is derived from **the socket**, before and after, never from
 * `mode`. The three `null` cases below are each a state a `mode`-derived
 * answer gets wrong.
 */
describe('applySetRemote — what changed', () => {
  /** A snapshot accessor that answers `before` first and `after` after. */
  const socket = (
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ) => {
    let asked = 0;
    return () => {
      asked += 1;
      return asked === 1 ? before : after;
    };
  };

  it('reports an attach, carrying the fleet the server sent', async () => {
    const switchMode = vi.fn().mockResolvedValue({ ok: true });
    const fleet = { 'session:history': [{ id: 'sess-01' }] };

    const result = await applySetRemote(
      { mode: 'remote', host: '127.0.0.1' },
      switchMode,
      socket(null, fleet),
    );

    expect(result.changed).toEqual({ to: 'remote', snapshot: fleet });
  });

  it('reports a detach, which carries nothing to seed', async () => {
    const switchMode = vi.fn().mockResolvedValue({ ok: true });

    const result = await applySetRemote(
      { mode: 'local' },
      switchMode,
      socket({ 'session:history': [] }, null),
    );

    expect(result.changed).toEqual({ to: 'local' });
  });

  /**
   * The address field blurring: a payload naming no mode, which now performs
   * no switch at all (see the case above). The socket is the one it was, and
   * a `mode`-derived answer would still have reported a change.
   */
  it('reports nothing when the socket did not move', async () => {
    const switchMode = vi.fn().mockResolvedValue({ ok: true });

    const result = await applySetRemote({ host: '10.0.0.9' }, switchMode, socket(null, null));

    expect(result.changed).toBeNull();
  });

  /**
   * Ruling 19 leaves this machine's `remote.mode` at `'remote'` after a failed
   * boot attach, precisely so the next launch retries — and that window is
   * bound **local**, showing its own sessions. Turning the switch off there
   * must write, and must not clear a fleet that is the right one.
   */
  it('reports nothing when the file says remote but no socket was ever open', async () => {
    getConfig.mockReturnValue({
      remote: { mode: 'remote', host: 'mini.tail.ts.net', port: 7433 },
      marker: 'OLD_SNAPSHOT',
    });
    const switchMode = vi.fn().mockResolvedValue({ ok: true });

    const result = await applySetRemote({ mode: 'local' }, switchMode, socket(null, null));

    expect(setRemote).toHaveBeenCalledExactlyOnceWith({ mode: 'local' });
    expect(result.changed).toBeNull();
  });

  it('reports nothing when the switch was refused', async () => {
    const switchMode = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'connect-failed', message: 'ECONNREFUSED' });

    const result = await applySetRemote(
      { mode: 'remote', host: '127.0.0.1' },
      switchMode,
      socket(null, null),
    );

    expect(result.changed).toBeNull();
  });
});
