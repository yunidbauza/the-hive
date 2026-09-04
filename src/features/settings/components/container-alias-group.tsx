import { useState } from 'react';

import { TextField } from '@components/ui/text-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { setReceiverConfig } from '@lib/project-config';
import { DEFAULT_RECEIVER, isHostAlias } from '@shared/config-contract';

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

const HINT =
  'The name a container resolves to reach the host. Docker Desktop, OrbStack and Rancher use host.docker.internal; podman uses host.containers.internal.';

const INVALID =
  'A hostname only — no scheme, port, path or credentials. Try host.docker.internal.';

interface ContainerAliasGroupProps {
  /** The resolved alias from the snapshot. Never empty — the block is defaulted. */
  hostAlias: string;
}

export function ContainerAliasGroup({ hostAlias }: ContainerAliasGroupProps) {
  const [draft, setDraft] = useState(hostAlias);
  const [invalid, setInvalid] = useState(false);

  /**
   * Follow the snapshot when it changes underneath us.
   *
   * This pane is never remounted — `AdvancedSection`'s `!snapshot` early return
   * only fires before the first load — so without this the field keeps whatever
   * it was first given. **Reload** and **Reset** both change the alias in the
   * store, and a stale draft is not merely cosmetic: focusing and blurring the
   * field would write the pre-reset value straight back into the file the user
   * just reset.
   *
   * Adjusting state during render rather than in an effect is React's own
   * recommendation for this: the re-render happens before the browser paints, so
   * the stale value is never shown.
   */
  const [seen, setSeen] = useState(hostAlias);
  if (seen !== hostAlias) {
    setSeen(hostAlias);
    setDraft(hostAlias);
    setInvalid(false);
  }

  /**
   * An emptied field restores the default rather than committing `""`.
   *
   * Unlike the Jira fields, there is no "unset" state to fall back to: the
   * substitution always needs a name, and `""` would produce `http://:63999`.
   *
   * A value the guard would refuse is **caught here instead of being sent**.
   * `mutate` swallows an IPC rejection into `console.error`
   * (`project-config.ts:117-119`), so a refused write is otherwise completely
   * silent — the field would go on showing a value that was never saved. The
   * draft is deliberately left alone in that case, so the user can correct what
   * they typed rather than watch it disappear.
   */
  const commit = () => {
    const next =
      draft.trim() === '' ? DEFAULT_RECEIVER.hostAlias : draft.trim();

    if (!isHostAlias(next)) {
      setInvalid(true);
      return;
    }

    setInvalid(false);
    setDraft(next);
    if (next === hostAlias) return;
    /*
      `seen` is deliberately NOT advanced here. It tracks the prop, and the prop
      is what the file actually holds — moving it optimistically would make the
      field revert to the old value for the render between this commit and the
      snapshot arriving, then jump forward again once it did.
    */
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
        onChange={(value) => {
          setDraft(value);
          if (invalid) setInvalid(false);
        }}
        onCommit={commit}
        placeholder={DEFAULT_RECEIVER.hostAlias}
        hint={invalid ? INVALID : HINT}
      />
    </SettingsGroup>
  );
}
