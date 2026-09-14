import type { ConfigSnapshot } from '@shared/config-contract';

/**
 * The config fields a reload cannot apply, and so has to name.
 *
 * Each is read once at launch and bound into something that cannot move under
 * a running app: the receiver's socket (`ipc/index.ts`, HIVE-134), the server's
 * socket and whether it serves at all (`main/index.ts`, HIVE-142), and the
 * login shell's environment imported before the first spawn. Every other
 * field is read per use, so a reload applies it by itself.
 *
 * `remote.mode` is deliberately absent, though it too looks bound at launch —
 * it is not. Attach/Detach mutates it live (`ipc/set-remote.ts`), and the
 * Settings switch for that exact flow says "Applies immediately." Naming it
 * here made every Reload after a live attach or detach for the rest of the
 * session report a restart that switch already told the user it did not need.
 *
 * Compared against the snapshot the app launched with, not the one the last
 * reload installed: a field edited and reloaded twice is still not running.
 */
const LAUNCH_ONLY: readonly [label: string, read: (config: ConfigSnapshot) => unknown][] = [
  ['receiver bind', (config) => config.receiver.bind],
  ['server mode', (config) => config.server.enabled],
  ['server bind', (config) => config.server.bind],
  ['login environment', (config) => [config.importLoginEnv, config.shell]],
];

/** The labels of every launch-only field that differs, in a fixed order. */
export function restartRequired(boot: ConfigSnapshot, now: ConfigSnapshot): string[] {
  return LAUNCH_ONLY.filter(
    ([, read]) => JSON.stringify(read(boot)) !== JSON.stringify(read(now)),
  ).map(([label]) => label);
}
