import type { UpdateCapability } from '@shared/update-contract';

import type { ServerLockClaim } from '../server/server-lock';

import type { UpdateEngine } from './updater';

export interface UpdateOneShotDeps {
  capability: UpdateCapability;
  currentVersion: string;
  engine: UpdateEngine;
  acquireLock: () => ServerLockClaim;
  releaseUrlFor: (version: string) => string;
  releasesUrl: string;
  print: (line: string) => void;
  onInstallFailure: (cause: unknown) => void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function runUpdateOneShot(deps: UpdateOneShotDeps): Promise<number | null> {
  const {
    capability,
    currentVersion,
    engine,
    acquireLock,
    releaseUrlFor,
    releasesUrl,
    print,
    onInstallFailure,
  } = deps;

  let release: (() => void) | undefined;
  try {
    const lock = acquireLock();
    if (lock.kind === 'active') {
      print('Cannot update The Hive while the local server is running. Stop the server, then retry.');
      return 1;
    }
    release = lock.release;

    if (!capability.canCheck) {
      print(`${capability.reason}\nDownload updates from: ${releasesUrl}`);
      return 3;
    }

    const found = await engine.check();
    if (found === null) {
      print(`The Hive ${currentVersion} is already current.`);
      return 2;
    }

    if (capability.mode === 'manual') {
      print(`The Hive ${found.version} is available: ${releaseUrlFor(found.version)}`);
      return 3;
    }

    print(`Downloading The Hive ${found.version}...`);
    await engine.download((percent) => {
      print(`Downloading The Hive ${found.version}: ${percent.toFixed(0)}%`);
    });
    print(`Installing The Hive ${found.version}; the app will relaunch.`);
    void engine.install().catch((cause: unknown) => {
      print(`Could not update The Hive: ${errorMessage(cause)}`);
      onInstallFailure(cause);
    });
    release = undefined;
    return null;
  } catch (cause) {
    print(`Could not update The Hive: ${errorMessage(cause)}`);
    return 1;
  } finally {
    release?.();
  }
}
