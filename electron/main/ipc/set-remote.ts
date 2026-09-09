import type {
  ModeChange,
  RemoteMode,
  SetRemoteResult,
  SwitchOutcome,
} from '@shared/config-contract';
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
 * The attached socket's own accept-frame snapshot, or `null` when this
 * process is not attached (HIVE-144 review, I1).
 *
 * Injected for the reason {@link ModeSwitcher} is: `router.ts` owns the
 * client, this module may not import it back, and the one capability the
 * handler needs crosses the seam as an argument. It is called **twice** per
 * switch — once before and once after — so it has to be the live reading and
 * not a captured value.
 *
 * Defaulted to "not attached" so the eight suites that call
 * {@link applySetRemote} with two arguments still describe a local machine,
 * which is what they were written about.
 */
export type AttachedSnapshot = () => Readonly<Record<string, unknown>> | null;

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
  attachedSnapshot: AttachedSnapshot = () => null,
): Promise<SetRemoteResult> {
  const request = parseSetRemoteRequest(payload);
  const current = getConfig().remote;
  /*
    Read before the switch, so `changed` below can be derived from what
    actually happened to the socket rather than from what the payload asked
    for (HIVE-144 review, I1). Neither `request.mode` nor `current.mode` can
    answer that question: the first is absent on a write-only commit, and the
    second is this machine's file, which Ruling 19 deliberately leaves saying
    `'remote'` on a window that is bound local.
  */
  const before = attachedSnapshot() !== null;
  const switched = await switchMode(request.mode ?? current.mode, {
    target: {
      host: request.host ?? current.host,
      port: request.port ?? current.port,
    },
  });
  // The old snapshot, unchanged, on every refusal — the file was never
  // opened. `getConfig()` rather than the `current` block above, because a
  // pane needs the whole snapshot back either way. Nothing switched, so there
  // is nothing for the renderer to re-seed.
  if (!switched.ok) return { switched, config: getConfig(), changed: null };
  return { switched, config: setRemote(request), changed: modeChange(before, attachedSnapshot()) };
}

/**
 * What the socket did across the switch, in the shape the renderer acts on.
 *
 * `null` when it did nothing, which covers three real cases and not one of
 * them is a failure: a write-only commit that never called the switcher, a
 * detach on a window that was already local (`switchIpcMode`'s own "already
 * local" guard), and a re-attach that landed on the same kind of surface it
 * left. Reporting a change in any of them would clear a fleet that is still
 * the right one.
 */
function modeChange(
  before: boolean,
  after: Readonly<Record<string, unknown>> | null,
): ModeChange | null {
  if ((after !== null) === before) return null;
  return after === null ? { to: 'local' } : { to: 'remote', snapshot: after };
}
