import { useState } from 'react';

import { TextField } from '@components/ui/text-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { setReceiverConfig } from '@lib/project-config';
import { DEFAULT_RECEIVER } from '@shared/config-contract';

/**
 * How a containerised session addresses this app (HIVE-131).
 *
 * A container cannot reach `127.0.0.1` — inside one that is the container's own
 * loopback. Every mainstream runtime proxies the connection from the host side,
 * so the socket is already reachable and only the *name* has to change; this
 * field is that name.
 *
 * Placed in the Advanced pane's top half, beside `Config file`, because
 * everything from `About` onward answers questions rather than setting
 * anything — an editable field down there would be the only one of its kind.
 *
 * Committed on blur or Enter, like every other settings field
 * (`text-field.tsx:24`) — these write to a file, so a commit per keystroke would
 * be a whole-file atomic write per character.
 */

interface ContainerAliasGroupProps {
  /** The resolved alias from the snapshot. Never empty — the block is defaulted. */
  hostAlias: string;
}

export function ContainerAliasGroup({ hostAlias }: ContainerAliasGroupProps) {
  const [draft, setDraft] = useState(hostAlias);

  /**
   * An emptied field restores the default rather than committing `""`.
   *
   * Unlike the Jira fields, there is no "unset" state to fall back to: the
   * substitution always needs a name, and `""` would produce `http://:63999`.
   * The draft is written back either way, so the field shows what was saved
   * rather than the whitespace that was typed.
   */
  const commit = () => {
    const next =
      draft.trim() === '' ? DEFAULT_RECEIVER.hostAlias : draft.trim();
    setDraft(next);
    if (next === hostAlias) return;
    void setReceiverConfig({ hostAlias: next });
  };

  return (
    <SettingsGroup
      title="Containers"
      description="How a session running inside a container addresses this app."
    >
      <TextField
        label="Host alias"
        value={draft}
        onChange={setDraft}
        onCommit={commit}
        placeholder={DEFAULT_RECEIVER.hostAlias}
        hint="The name a container resolves to reach the host. Docker Desktop, OrbStack and Rancher use host.docker.internal; podman uses host.containers.internal."
      />
    </SettingsGroup>
  );
}
