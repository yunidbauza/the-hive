import { getConfig, setServer } from '../config';

import type { OneShotIo } from './one-shot';

/**
 * The real {@link OneShotIo} — reads and writes the actual config file, and
 * prints to the actual terminal (HIVE-142).
 *
 * Kept out of `one-shot.ts` on purpose: that module's whole value is being
 * testable without a real config file, and out of `index.ts` so that file
 * stays lifecycle-only, per its own header comment. This is the one place
 * that touches Electron's config and `process.stdout` for the one-shots.
 */
export function fileBackedIo(): OneShotIo {
  return {
    readDevices: () => getConfig().server.devices,
    writeDevices: (devices) => {
      setServer({ devices });
    },
    print: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}
