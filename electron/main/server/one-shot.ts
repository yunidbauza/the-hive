import type { ServerDevice } from '@shared/config-contract';

import type { Invocation } from '../cli';

import {
  mintDevice,
  pairDevice,
  pairOutcomeMessage,
  revokeDevice,
  revokeOutcomeMessage,
  type MintedDevice,
} from './devices';

/**
 * The CLI one-shots' effects, factored out so `runOneShot` stays pure
 * (HIVE-142).
 *
 * `readDevices`/`writeDevices` are the whole device list, not a single
 * record — a one-shot always reads the current list, decides, and writes the
 * list back whole, the same shape `setServer({ devices })` takes. `writeDevices`
 * reports whether the write actually landed (HIVE-142 review, C1) — see
 * `DeviceStore.writeDevices`'s own doc comment in `devices.ts`, which this
 * interface is shape-identical to. `print` is terminal output, not logging:
 * `--pair`'s token line is read once by a human and copied, not filed away.
 */
export interface OneShotIo {
  readDevices: () => readonly ServerDevice[];
  writeDevices: (devices: readonly ServerDevice[]) => boolean;
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
    case 'update':
      // `index.ts` routes this asynchronous command through `runHeadlessUpdate`.
      return 1;
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
    reduced to translating the outcome into the CLI's exit code — the message
    itself is `pairOutcomeMessage`'s, the same one the tray and the Settings
    pane show (HIVE-142 review, I1/minor).
  */
  const outcome = pairDevice(name, io, now, mint);

  if (!outcome.ok) {
    io.print(pairOutcomeMessage(outcome, name));
    return 1;
  }

  /*
    The device id, right after the token (HIVE-142 review, I5) — `AttachRequest`
    needs both, and until now the id was readable only inside `config.json`.
    A distinct, greppable prefix rather than a bare second line: this line and
    the token line both need to survive being read back apart from each
    other (the live suite parses stdout by line index), and "Device id: " is
    unambiguous next to a token that is itself four dash-separated groups.
  */
  io.print(outcome.token);
  io.print(`Device id: ${outcome.device.id}`);
  io.print(`This token grants "${name}" access to this Hive over the network.`);
  io.print(`Revoke it any time with: the-hive --revoke "${name}"`);
  return 0;
}

function runRevoke(name: string, io: OneShotIo): number {
  const outcome = revokeDevice(name, io);

  if (!outcome.revoked) {
    io.print(revokeOutcomeMessage(outcome, name));
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

  // The id, so an operator holding only a token minted earlier (HIVE-142
  // review, I5) can find the id `AttachRequest` also needs without opening
  // `config.json` by hand.
  for (const device of devices) {
    io.print(
      `${device.name}  ${device.id}  ${device.revoked ? 'revoked' : 'active'}  paired ${device.paired}`,
    );
  }
  return 0;
}
