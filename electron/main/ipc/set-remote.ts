import type { RemoteMode, SetRemoteResult, SwitchOutcome } from '@shared/config-contract';
import { parseSetRemoteRequest } from '@shared/guards';

import { getConfig, setRemote } from '../config';

/**
 * How `config:set-remote` asks this process to change mode (HIVE-144).
 *
 * Structural rather than an import of `router.ts`'s own `switchIpcMode`: both
 * modules that answer this channel already sit on `router.ts`'s import graph
 * in one direction or the other, and `import/no-cycle` is an error here. The
 * real switcher arrives as an argument — the router owns which mode is bound,
 * and a handler asks it rather than reaching into it.
 *
 * Only `target` is named of the switch's own options: it is the one a caller
 * of {@link applySetRemote} must pass, because Ruling 19 forbids writing the
 * address to disk until the switch has succeeded, so the stored config is the
 * wrong place for the switch to read it from.
 */
export type ModeSwitcher = (
  mode: RemoteMode,
  options?: { target?: { host: string; port: number } },
) => Promise<SwitchOutcome>;

/**
 * Everything `config:set-remote` does, in the one place both surfaces that
 * answer it can reach (HIVE-144, Ruling 28).
 *
 * ## Why this is a module and not a handler body
 *
 * It used to live inside `registerIpcHandlers`, which is the surface remote
 * mode **tears down**. That was fine while the channel was proxied — and being
 * proxied was the defect: an attached client's detach ran on the server, which
 * switched *itself*, wrote *its* `config.json`, and answered `{ ok: true }`
 * over a client that never detached and, because its own file still said
 * `remote`, reattached on the next launch. Ruling 28 puts the channel on
 * `PROCESS_LOCAL`, so `registerRemoteProxy` now has to answer it too — from a
 * process whose local handlers are gone.
 *
 * Nothing this function *calls* is gone, which is what makes that possible:
 * `getConfig`/`setRemote` are config-module functions and the switcher is
 * `router.ts`'s own `switchIpcMode`, alive in both modes. So the body moved
 * here rather than being copied into the proxy — two spellings of one verb
 * would be free to drift, and the direction they would drift in is a client
 * that detaches differently depending on which mode it was in when it asked.
 *
 * ## The contract, unchanged from the handler this replaces
 *
 * Ruling 19: the file is written **only** on a successful switch. A refusal
 * answers the old snapshot, untouched, so `config.json` can never name a
 * target this app has just been told it cannot reach. `request.mode ?? current.mode`
 * and the two `??`s under `target` are what make a partial payload — the
 * address field committing on blur, say — mean "change this field, leave the
 * rest", rather than resetting the fields it did not carry.
 */
export async function applySetRemote(
  payload: unknown,
  switchMode: ModeSwitcher,
): Promise<SetRemoteResult> {
  const request = parseSetRemoteRequest(payload);
  const current = getConfig().remote;
  const switched = await switchMode(request.mode ?? current.mode, {
    target: {
      host: request.host ?? current.host,
      port: request.port ?? current.port,
    },
  });
  // The old snapshot, unchanged, on every refusal — the file was never
  // opened. `getConfig()` rather than the `current` block above, because a
  // pane needs the whole snapshot back either way.
  if (!switched.ok) return { switched, config: getConfig() };
  return { switched, config: setRemote(request) };
}
