import { PlugsConnected } from '@phosphor-icons/react';

import { Chip } from '@components/ui/chip';
import { useAttachedServer } from '@hooks/use-project-config';


/**
 * "This window is attached to another Hive's sessions over a socket"
 * (HIVE-144, Task 13).
 *
 * The other end of {@link ServingChip}'s socket — read that component's own
 * doc comment first; this one repeats the same three rules for the opposite
 * direction rather than re-deriving them.
 *
 * **Sourced from the running attachment, not the config snapshot.** This is
 * the one place the pair's shared rule has *two* live sides to get right
 * rather than one: `ConfigSnapshot.attachedServer` (Task 12) names the
 * machine whose config file `config:get` is answering right now, which while
 * attached is genuinely the far end — a *control's* readout, correct for
 * Settings. This chip claims a **live** attachment instead, which that field
 * would answer wrongly in both directions: Ruling 19 deliberately leaves
 * `config.json` saying `remote` after an already-remote re-switch fails and
 * rebinds local, so a config-derived chip would keep claiming an attachment
 * that is no longer there; and, symmetrically, would deny one on the next
 * launch before the boot attach has even been attempted. `AppInfo.attachedServerName`
 * is sourced from `electron/main/ipc/router.ts`'s own `attached` variable —
 * the socket `switchIpcMode` actually holds open — for exactly that reason;
 * see that field's own doc comment, and `ConfigSnapshot.attachedServer`'s,
 * for the full split stated from both sides. `useAttachedServer` does the
 * reading.
 *
 * **Renders nothing while not attached**, for the same reason `ServingChip`
 * renders nothing while unbound: there is no config flag this chip could read
 * to show an "off" state (`remote.mode` is a control for Settings, not a
 * status for this chip, per the split above), because the only question that
 * matters is whether a socket is actually open right now, and a Hive that
 * has never attached to anything should see no new furniture in its header.
 *
 * **Brand, not amber.** Attaching is exactly as deliberate as serving —
 * nothing opens this socket by accident, there is no "forgot to detach"
 * story, and painting it amber would spend the same signal `ExposureChip`
 * (HIVE-134) earns on "wider than you may have meant" on a state that isn't
 * that. See `ServingChip`'s own doc comment for the fuller argument; the two
 * chips are deliberately the same colour so the row reads "these two are
 * facts about what this Hive is doing on purpose" against `ExposureChip`'s
 * amber "this one might not be."
 *
 * It carries the server's **name** — `RemoteClient.serverName()` (Task 7),
 * the far end's own `hostname()` handed over in the attach handshake — rather
 * than its address, because the name is what the user who just attached
 * actually recognizes ("mini", not an IP). The address is
 * `ConfigSnapshot.attachedServer.host`'s job, for the pane that dials it.
 */
export function AttachedChip() {
  const serverName = useAttachedServer();
  if (serverName === null) return null;

  return (
    <Chip
      tone="brand"
      title={`This window is attached to ${serverName} over a socket — its sessions are what you are driving right now.`}
      className="shrink-0"
    >
      <PlugsConnected size={12} />
      attached · {serverName}
    </Chip>
  );
}
