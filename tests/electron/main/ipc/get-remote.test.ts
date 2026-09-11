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

    expect(readLocalRemote(false)).toEqual({
      mode: 'remote',
      host: 'mini.tail1234.ts.net',
      port: 7433,
      paired: false,
    });
  });

  it('re-reads on every call, so a mode switch is visible to the next caller', () => {
    getConfig
      .mockReturnValueOnce(snapshotWith({ mode: 'local', host: '', port: 7433 }))
      .mockReturnValueOnce(
        snapshotWith({ mode: 'remote', host: '100.101.102.103', port: 7500 }),
      );

    expect(readLocalRemote(false).mode).toBe('local');
    expect(readLocalRemote(false)).toEqual({
      mode: 'remote',
      host: '100.101.102.103',
      port: 7500,
      paired: false,
    });
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  /**
   * HIVE-140 audit, gap 6: Settings' "Paired" chip used to know only what it
   * watched happen in the same session. Whether a credential is stored now
   * rides on this answer, as a yes or no and never the credential.
   */
  it('says whether a credential is stored, and nothing more about it', () => {
    getConfig.mockReturnValue(snapshotWith({ mode: 'remote', host: 'mini', port: 7433 }));

    const answer = readLocalRemote(true);

    expect(answer.paired).toBe(true);
    expect(Object.keys(answer).sort()).toEqual(['host', 'mode', 'paired', 'port']);
  });
});
