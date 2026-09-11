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
  /** Whether the app starts itself after the swap; `false` under launchd (HIVE-147). */
  relaunch: boolean;
}

/**
 * What `the-hive --update` exits with, one code per outcome a script can act on
 * (HIVE-158, made distinct after the HIVE-140 audit). `null` from
 * {@link runUpdateOneShot} is the fifth outcome: installation has started and
 * the process quits normally, exiting 0.
 */
export const UPDATE_EXIT = {
  failed: 1,
  current: 2,
  noChannel: 3,
  manual: 4,
  serving: 5,
} as const;

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
    relaunch,
  } = deps;

  let release: (() => void) | undefined;
  try {
    const lock = acquireLock();
    if (lock.kind === 'active') {
      print('Cannot update The Hive while the local server is running. Stop the server, then retry.');
      return UPDATE_EXIT.serving;
    }
    release = lock.release;

    if (!capability.canCheck) {
      print(`${capability.reason}\nDownload updates from: ${releasesUrl}`);
      return UPDATE_EXIT.noChannel;
    }

    const found = await engine.check();
    if (found === null) {
      print(`The Hive ${currentVersion} is already current.`);
      return UPDATE_EXIT.current;
    }

    if (capability.mode === 'manual') {
      print(`The Hive ${found.version} is available: ${releaseUrlFor(found.version)}`);
      return UPDATE_EXIT.manual;
    }

    print(`Downloading The Hive ${found.version}...`);
    await engine.download((percent) => {
      print(`Downloading The Hive ${found.version}: ${percent.toFixed(0)}%`);
    });
    print(
      relaunch
        ? `Installing The Hive ${found.version}; the app will relaunch.`
        : `Installing The Hive ${found.version}; start the server again to run it.`,
    );
    void engine.install().catch((cause: unknown) => {
      print(`Could not update The Hive: ${errorMessage(cause)}`);
      onInstallFailure(cause);
    });
    release = undefined;
    return null;
  } catch (cause) {
    print(`Could not update The Hive: ${errorMessage(cause)}`);
    return UPDATE_EXIT.failed;
  } finally {
    release?.();
  }
}
