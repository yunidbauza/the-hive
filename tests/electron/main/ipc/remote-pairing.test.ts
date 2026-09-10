import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  applyRemoteForget,
  applyRemotePair,
} from '../../../../electron/main/ipc/remote-pairing';
import { NO_ENCRYPTION_REASON, type TokenStore } from '../../../../electron/remote-client/token-store';

/**
 * `remote:pair` and `remote:forget`'s bodies, extracted from
 * `registerIpcHandlers` so that `registerRemoteProxy` can answer the same two
 * verbs from a process whose local handlers — and the `remoteTokenStore`
 * closed over by them — are gone (HIVE-153).
 *
 * The extraction is what these tests are for, exactly as in
 * `set-remote.test.ts`. What they guard against is a copy in the proxy
 * drifting from the copy in the handler, and the direction that drift goes is
 * a machine that forgets a different credential depending on which mode it
 * was in when it asked.
 *
 * The store is a stub rather than a real `createTokenStore`: that module's own
 * suite owns `safeStorage` behaviour, and nothing here is a claim about
 * encryption — only about which store gets called, with what, and what its
 * answer is turned into.
 */

/** A store that records, with `write`'s answer under the test's control. */
function stubStore(writeReturns = true): {
  read: Mock<TokenStore['read']>;
  write: Mock<TokenStore['write']>;
  clear: Mock<TokenStore['clear']>;
} {
  return {
    read: vi.fn<TokenStore['read']>().mockReturnValue(null),
    write: vi.fn<TokenStore['write']>().mockReturnValue(writeReturns),
    clear: vi.fn<TokenStore['clear']>(),
  };
}

describe('applyRemotePair', () => {
  it('writes the parsed credential through the store it was handed', () => {
    const store = stubStore();

    const result = applyRemotePair({ deviceId: 'laptop', token: 'sekret' }, store);

    expect(store.write).toHaveBeenCalledExactlyOnceWith('laptop', 'sekret');
    expect(result).toEqual({ paired: true });
  });

  /*
    The boolean is the whole reason this function has a return type. A store
    that no-ops on a machine with no keyring must not be reported as a
    pairing — that was a real fix-round finding on HIVE-144's handler, and the
    extraction has to carry it rather than quietly re-lose it.
  */
  it('reports the refusal sentence when the store could not persist', () => {
    const store = stubStore(false);

    const result = applyRemotePair({ deviceId: 'laptop', token: 'sekret' }, store);

    expect(result).toEqual({ error: NO_ENCRYPTION_REASON });
    expect(result).not.toEqual({ paired: true });
  });

  it('throws on a malformed payload, and writes nothing', () => {
    const store = stubStore();

    expect(() => applyRemotePair({ deviceId: 'laptop' }, store)).toThrow();
    expect(() => applyRemotePair(null, store)).toThrow();

    expect(store.write).not.toHaveBeenCalled();
  });
});

describe('applyRemoteForget', () => {
  it('clears the store it was handed', () => {
    const store = stubStore();

    applyRemoteForget(store);

    expect(store.clear).toHaveBeenCalledOnce();
  });

  it('is idempotent, and never reads the credential it is discarding', () => {
    const store = stubStore();

    applyRemoteForget(store);
    applyRemoteForget(store);

    expect(store.clear).toHaveBeenCalledTimes(2);
    expect(store.read).not.toHaveBeenCalled();
  });

  /*
    Each call answers exactly the store it was given. The proxy and the local
    handler build theirs through the same `remoteCredentialStore()` factory —
    that is the invariant keeping this honest — but the function itself must
    hold no module state that could outlive one of them.
  */
  it('holds no store of its own between calls', () => {
    const first = stubStore();
    const second = stubStore();

    applyRemoteForget(first);
    applyRemoteForget(second);

    expect(first.clear).toHaveBeenCalledOnce();
    expect(second.clear).toHaveBeenCalledOnce();
  });
});
