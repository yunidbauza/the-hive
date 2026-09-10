import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfigSnapshot, RemoteConfig } from '@shared/config-contract';

const getConfig = vi.fn();

vi.mock('../../../../electron/main/config', () => ({ getConfig }));

const { readLocalRemote } = await import('../../../../electron/main/ipc/get-remote');

/**
 * `config:get-remote`'s answerer (HIVE-149).
 *
 * One expression, and the property worth pinning is not that it reads a field:
 * it is that it reads it from *this* process's config on every call rather than
 * from a value captured once. A memoised read would answer the mode this
 * process booted in for the life of the process, which is the same class of
 * staleness as the proxied read this channel exists to replace.
 */
describe('readLocalRemote', () => {
  beforeEach(() => {
    getConfig.mockReset();
  });

  const snapshotWith = (remote: RemoteConfig): ConfigSnapshot =>
    ({ remote }) as unknown as ConfigSnapshot;

  it("answers this process's own remote block", () => {
    getConfig.mockReturnValue(
      snapshotWith({ mode: 'remote', host: 'mini.tail1234.ts.net', port: 7433 }),
    );

    expect(readLocalRemote()).toEqual({
      mode: 'remote',
      host: 'mini.tail1234.ts.net',
      port: 7433,
    });
  });

  it('re-reads on every call, so a mode switch is visible to the next caller', () => {
    getConfig
      .mockReturnValueOnce(snapshotWith({ mode: 'local', host: '', port: 7433 }))
      .mockReturnValueOnce(
        snapshotWith({ mode: 'remote', host: '100.101.102.103', port: 7500 }),
      );

    expect(readLocalRemote().mode).toBe('local');
    expect(readLocalRemote()).toEqual({
      mode: 'remote',
      host: '100.101.102.103',
      port: 7500,
    });
    expect(getConfig).toHaveBeenCalledTimes(2);
  });
});
