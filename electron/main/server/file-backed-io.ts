import { readFileSync } from 'node:fs';

import type { ServerDevice } from '@shared/config-contract';

import { getConfig, setServerReportingWrite } from '../config';
import { parseConfig } from '../config/parse';
import { configPath } from '../config/paths';

import type { DeviceStore } from './devices';
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
    // `getConfig()`, not `readServerDevicesFromDisk()` below: a one-shot is a
    // brand-new process every time it runs, so `getConfig()`'s cache is
    // empty and this is already a genuine first read off disk — the
    // staleness the narrow reader exists to avoid is a long-running-process
    // problem this function never has.
    readDevices: () => getConfig().server.devices,
    // `.ok`, not a discarded call (HIVE-142 review, C1): a one-shot that
    // minted or revoked a device in memory and then failed to write it must
    // say so, not exit 0 having told the operator a credential exists that
    // exists nowhere.
    writeDevices: (devices) => setServerReportingWrite({ devices }).ok,
    print: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}

/**
 * Reads just the paired-device roster off disk, without installing it as
 * this process's cached `ConfigSnapshot` (HIVE-142 review, N1).
 *
 * `getConfig()`/`reloadConfig()` both write the module-level `cached`
 * snapshot in `config/index.ts`, which every subsystem in this long-running
 * process reads through `getConfig()` — projects, `env`, `shell`,
 * `claudeCommand`, `jira`, `slack`, `receiver`, all of it. The server-mode
 * listener calls its `devices` getter on **every inbound handshake, before
 * `verifyDevice`** (`remote-host/listener.ts`) — an unauthenticated peer that
 * merely reaches the socket must not be able to swap process-wide config
 * state out from under every other subsystem, and `reloadConfig()` also
 * skips the invalidations a real reload performs
 * (`forgetProbedRoots()`, `slackBridge?.sync()` — see `ipc/index.ts`'s own
 * reload handler), so its result could visibly disagree with the rest of the
 * process until someone reloads by hand.
 *
 * So this reads the file itself, runs it through the same `parseConfig`
 * every other reader uses (identical structural validation — this block
 * follows no different rules here than `loadConfig` applies), and returns
 * just `server.devices`. Deliberately **not** what `loadConfig` does around
 * that same call: no `resolveProjects` (the per-project `realpath`/`stat`
 * work), no `backfillKeys` (which can rewrite the file), and no write to the
 * shared `cached` variable — an unauthenticated read forcing a single small
 * file read is proportionate (the socket is Tailscale-reachable only, and
 * already has a handshake deadline and a payload cap); forcing the full load
 * a real boot or reload does would not be. An unreadable or malformed file
 * answers `[]`, the same as a roster with nothing paired — `loadConfig`
 * treats "file absent" as "write the template", which is not a decision an
 * unauthenticated read (or a display-only tray refresh) should ever trigger.
 */
export function readServerDevicesFromDisk(): readonly ServerDevice[] {
  let text: string;
  try {
    text = readFileSync(configPath(), 'utf8');
  } catch {
    return [];
  }

  // A fresh `[]`, not a shared default array — every caller (`pairDevice`,
  // `revokeNamed`) spreads or maps over this result rather than mutating it
  // in place today, but a single shared array handed out on every call is
  // exactly the kind of thing that bites two stories later, once something
  // does (HIVE-142 review, minor).
  return parseConfig(text, 'config').server?.devices ?? [];
}

/**
 * The {@link DeviceStore} the running server process uses — for the
 * listener's own `devices` getter, for the tray's pairing and revoking
 * (HIVE-142 review, N1/N2), and for the `server:pair`/`server:revoke` IPC
 * handlers behind the Settings pane's device roster (HIVE-142). Reads never
 * touch the shared config cache ({@link readServerDevicesFromDisk}); writes
 * go through `setServer`, the same wholesale-replace-of-`devices` verb every
 * other config mutation in this app uses, which *does* update the cache —
 * appropriate here because, unlike a handshake, a write only ever happens
 * from the tray or from Settings, both reachable only by a human already at
 * (or screen-sharing into) this machine's own console.
 */
export function serverDeviceStore(): DeviceStore {
  return {
    readDevices: readServerDevicesFromDisk,
    // Same reporting as `fileBackedIo`'s own `writeDevices` above, and for
    // the same reason (HIVE-142 review, C1) — the tray's "Pair a device…"
    // and "Revoke" and the Settings pane's `server:pair`/`server:revoke`
    // handlers all go through this store, and none of them may report a
    // mutation that never reached disk.
    writeDevices: (devices) => setServerReportingWrite({ devices }).ok,
  };
}
