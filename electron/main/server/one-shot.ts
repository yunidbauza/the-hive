import type { ServerDevice } from '@shared/config-contract';

import type { Invocation } from '../cli';

import { MAX_MINT_ATTEMPTS, mintDevice, pairDevice, revokeDevice, type MintedDevice } from './devices';

/**
 * The CLI one-shots' effects, factored out so `runOneShot` stays pure
 * (HIVE-142).
 *
 * `readDevices`/`writeDevices` are the whole device list, not a single
 * record — a one-shot always reads the current list, decides, and writes the
 * list back whole, the same shape `setServer({ devices })` takes. `print` is
 * terminal output, not logging: `--pair`'s token line is read once by a human
 * and copied, not filed away.
 */
export interface OneShotIo {
  readDevices: () => readonly ServerDevice[];
  writeDevices: (devices: readonly ServerDevice[]) => void;
  print: (line: string) => void;
}

/**
 * Runs one of the pre-`whenReady` CLI verbs — `--pair`, `--revoke`,
 * `--devices` — and returns the process exit code.
 *
 * Pure behind {@link OneShotIo}: no file, no `process`, no Electron import,
 * so every branch is testable without touching a real config file. `mint` is
 * an injected seam over {@link mintDevice} purely so a test can force an id
 * collision without stubbing the CSPRNG; every real caller takes the default.
 */
export function runOneShot(
  invocation: Invocation,
  io: OneShotIo,
  now?: Date,
  mint: (name: string, now?: Date) => MintedDevice = mintDevice,
): number {
  switch (invocation.kind) {
    case 'pair':
      return runPair(invocation.name, io, now, mint);
    case 'revoke':
      return runRevoke(invocation.name, io);
    case 'devices':
      return runDevices(io);
    case 'usage':
      io.print(invocation.message);
      return 1;
    case 'app':
      // Never reached: `index.ts` only calls `runOneShot` when
      // `invocation.kind !== 'app'`. Kept exhaustive so a fifth `Invocation`
      // variant fails this switch at compile time rather than falling
      // through silently.
      return 0;
  }
}

function runPair(
  name: string,
  io: OneShotIo,
  now: Date | undefined,
  mint: (name: string, now?: Date) => MintedDevice,
): number {
  /*
    The duplicate-name refusal, the collision-safe retry and "persist against
    the roster you just read" all live in `devices.ts` (`pairDevice`), shared
    with the tray's own "Pair a device…" path (HIVE-142 review, N2) — one
    implementation rather than two that can drift. This function's own job is
    reduced to translating the outcome into the CLI's messages and exit code.
  */
  const outcome = pairDevice(name, io, now, mint);

  if (!outcome.ok) {
    io.print(
      outcome.reason === 'duplicate-name'
        ? `A device named "${name}" already exists. Revoke it first, or choose another name.`
        : `Could not mint a unique device id after ${MAX_MINT_ATTEMPTS} attempts. Try again.`,
    );
    return 1;
  }

  io.print(outcome.token);
  io.print(`This token grants "${name}" access to this Hive over the network.`);
  io.print(`Revoke it any time with: the-hive --revoke "${name}"`);
  return 0;
}

function runRevoke(name: string, io: OneShotIo): number {
  const outcome = revokeDevice(name, io);

  if (!outcome.revoked) {
    io.print(`No device named "${name}" is paired.`);
    return 1;
  }

  io.print(`Revoked "${name}". It can no longer reach this Hive.`);
  return 0;
}

function runDevices(io: OneShotIo): number {
  const devices = io.readDevices();

  if (devices.length === 0) {
    io.print('No devices are paired.');
    return 0;
  }

  for (const device of devices) {
    io.print(`${device.name}  ${device.revoked ? 'revoked' : 'active'}  paired ${device.paired}`);
  }
  return 0;
}
