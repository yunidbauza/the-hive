import type { ConfigSnapshot } from '@shared/config-contract';

/**
 * The config fields a reload cannot apply, and so has to name.
 *
 * Each is read once at launch and bound into something that cannot move under
 * a running app: the receiver's socket (`ipc/index.ts`, HIVE-134), the server's
 * socket and whether it serves at all (`main/index.ts`, HIVE-142), the login
 * shell's environment imported before the first spawn, and the boot attach.
 * Every other field is read per use, so a reload applies it by itself.
 *
 * Compared against the snapshot the app launched with, not the one the last
 * reload installed: a field edited and reloaded twice is still not running.
 */
const LAUNCH_ONLY: readonly [label: string, read: (config: ConfigSnapshot) => unknown][] = [
  ['receiver bind', (config) => config.receiver.bind],
  ['server mode', (config) => config.server.enabled],
  ['server bind', (config) => config.server.bind],
  ['login environment', (config) => [config.importLoginEnv, config.shell]],
  ['remote attach', (config) => config.remote.mode],
];

/** The labels of every launch-only field that differs, in a fixed order. */
export function restartRequired(boot: ConfigSnapshot, now: ConfigSnapshot): string[] {
  return LAUNCH_ONLY.filter(
    ([, read]) => JSON.stringify(read(boot)) !== JSON.stringify(read(now)),
  ).map(([label]) => label);
}
