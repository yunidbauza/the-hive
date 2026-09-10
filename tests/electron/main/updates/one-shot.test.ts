import { describe, expect, it, vi } from 'vitest';

import type { ServerLockClaim } from '../../../../electron/main/server/server-lock';
import {
  runUpdateOneShot,
  type UpdateOneShotDeps,
} from '../../../../electron/main/updates/one-shot';
import type { UpdateEngine } from '../../../../electron/main/updates/updater';
import type { UpdateCapability } from '../../../../electron/shared/update-contract';

const SELF_INSTALL: UpdateCapability = {
  canCheck: true,
  mode: 'self-install',
  reason: 'Signed with a Developer ID.',
};

const MANUAL: UpdateCapability = {
  canCheck: true,
  mode: 'manual',
  reason: 'This build needs a manual update.',
};

const UNAVAILABLE: UpdateCapability = {
  canCheck: false,
  mode: 'manual',
  reason: 'This is a development run.',
};

function harness({
  capability = SELF_INSTALL,
  found = { version: '0.2.0' } as { version: string } | null,
  serverActive = false,
}: {
  capability?: UpdateCapability;
  found?: { version: string } | null;
  serverActive?: boolean;
} = {}) {
  const lines: string[] = [];
  const installFailure = vi.fn();
  const release = vi.fn();
  const acquireLock = vi.fn<() => ServerLockClaim>(() =>
    serverActive ? { kind: 'active' } : { kind: 'claimed', release },
  );
  const engine = {
    check: vi.fn().mockResolvedValue(found),
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockReturnValue(new Promise<never>(() => undefined)),
  };
  const deps: UpdateOneShotDeps = {
    capability,
    currentVersion: '0.1.0',
    engine: engine as unknown as UpdateEngine,
    acquireLock,
    releaseUrlFor: (version) => `https://releases.example.test/v${version}`,
    releasesUrl: 'https://releases.example.test',
    print: (line) => lines.push(line),
    onInstallFailure: installFailure,
  };
  return { acquireLock, deps, engine, installFailure, lines, release };
}

describe('runUpdateOneShot', () => {
  it('refuses an active server before checking for updates', async () => {
    const h = harness({ serverActive: true });

    await expect(runUpdateOneShot(h.deps)).resolves.toBe(1);

    expect(h.engine.check).not.toHaveBeenCalled();
    expect(h.lines.join('\n')).toMatch(/server.*running/i);
  });

  it('reports an unavailable update channel without checking', async () => {
    const h = harness({ capability: UNAVAILABLE });

    await expect(runUpdateOneShot(h.deps)).resolves.toBe(3);

    expect(h.engine.check).not.toHaveBeenCalled();
    expect(h.lines.join('\n')).toContain('https://releases.example.test');
  });

  it('reports the current version when no release is found', async () => {
    const h = harness({ found: null });

    await expect(runUpdateOneShot(h.deps)).resolves.toBe(2);

    expect(h.release).toHaveBeenCalledOnce();
    expect(h.lines).toEqual(['The Hive 0.1.0 is already current.']);
  });

  it('prints a version-specific release URL instead of opening a browser for a manual build', async () => {
    const h = harness({ capability: MANUAL });

    await expect(runUpdateOneShot(h.deps)).resolves.toBe(3);

    expect(h.engine.download).not.toHaveBeenCalled();
    expect(h.lines.join('\n')).toContain('https://releases.example.test/v0.2.0');
  });

  it('downloads and launches installation for a self-installing build', async () => {
    const h = harness();

    await expect(runUpdateOneShot(h.deps)).resolves.toBeNull();

    expect(h.acquireLock).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.engine.download).toHaveBeenCalledOnce();
    expect(h.engine.install).toHaveBeenCalledOnce();
    expect(h.lines.join('\n')).toMatch(/installing/i);
  });

  it('reports check failures as a failed update', async () => {
    const h = harness();
    h.engine.check.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(runUpdateOneShot(h.deps)).resolves.toBe(1);

    expect(h.lines).toEqual(['Could not update The Hive: getaddrinfo ENOTFOUND']);
  });

  it('delegates an asynchronous install failure to the Electron adapter', async () => {
    const h = harness();
    h.engine.install.mockRejectedValue(new Error('code signature rejected'));

    await expect(runUpdateOneShot(h.deps)).resolves.toBeNull();
    await Promise.resolve();

    expect(h.installFailure).toHaveBeenCalledWith(new Error('code signature rejected'));
  });
});
