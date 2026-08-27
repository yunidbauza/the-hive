import { CheckCircle, WarningCircle } from '@phosphor-icons/react';

import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';

import { SettingsGroup } from '@features/settings/components/settings-group';
import type { LoginEnvStatus } from '@shared/ipc-contract';

/**
 * Which environment this app is searching, and where it came from.
 *
 * ## Why this lives in Runtime and not in Integrations
 *
 * It was written for story 106's Integrations pane, where it answered a
 * question that pane genuinely raises: `gh` was not found, and the reason is
 * the `PATH`. But the fact it reports is not about GitHub at all — it is the
 * environment *every* session spawns into, and the switch that decides it
 * (`Login shell environment`) has always been one group above this one, in
 * Runtime. So the pane that owned the answer could not own the control, and had
 * to send the reader to Runtime by name to change anything.
 *
 * Now it sits directly under the switch it reports on, and Integrations points
 * here instead — the direction that costs one link rather than one round trip.
 *
 * Extracted to its own file on the way, because two panes read the same IPC and
 * a copy in each is how two screens start describing the same `PATH`
 * differently — the reasoning `path-probes.tsx` already records.
 */
export function PathSourceGroup({
  loginEnv,
}: {
  /**
   * The environment, `null` while the read is still out, or `'unavailable'`
   * once it has failed.
   *
   * Three states, not two. The reader answers `null` both for "no bridge" and
   * for "the channel threw", so a group that treated `null` as "still waiting"
   * would sit on its checking line for the lifetime of the window — no error,
   * no retry, and nothing on screen distinguishing a broken channel from a slow
   * one. The caller collapses the failure into `'unavailable'` and this says so.
   */
  loginEnv: LoginEnvStatus | 'unavailable' | null;
}) {
  const probing = useSwarmPhrase('loading.diagnostics');

  return (
    <SettingsGroup
      title="PATH source"
      description="Which environment this app searched when it started, and where it came from."
    >
      <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
        {loginEnv === null ? (
          <p data-probing className="text-[12.5px] text-subtle">
            {probing}
          </p>
        ) : loginEnv === 'unavailable' ? (
          <p className="flex items-start gap-2 text-[12.5px]">
            <WarningCircle size={14} className="mt-px shrink-0 text-amber" />
            <span className="text-amber">
              This app could not be asked what environment it is using. Nothing
              is broken by that beyond this box — reopening Settings asks again.
            </span>
          </p>
        ) : (
          <PathSourceLine loginEnv={loginEnv} />
        )}
      </div>
    </SettingsGroup>
  );
}

function PathSourceLine({ loginEnv }: { loginEnv: LoginEnvStatus }) {
  const counts = (
    <span className="text-subtle">
      {loginEnv.effectiveEntries}{' '}
      {loginEnv.effectiveEntries === 1 ? 'entry' : 'entries'}
      {loginEnv.imported
        ? ` · the inherited PATH had ${loginEnv.inheritedEntries}`
        : null}
      .
    </span>
  );

  // The failure case first: it is the only one that changes what the user
  // should do next.
  if (loginEnv.error !== null) {
    return (
      <>
        <p className="flex items-start gap-2 text-[12.5px]">
          <WarningCircle size={14} className="mt-px shrink-0 text-amber" />
          <span className="text-amber">
            Your login shell could not be read: {loginEnv.error}.
          </span>
        </p>
        <p className="text-[11.5px] text-subtle">
          The app kept the environment it was launched with — {counts} Nothing is
          broken by this beyond what it could not find.
        </p>
      </>
    );
  }

  if (!loginEnv.enabled) {
    return (
      <>
        <p className="text-[12.5px] text-ink">
          Inherited from whatever launched this app. {counts}
        </p>
        {/*
          Past tense, and deliberately.

          This whole group reports what happened *at startup*, while the switch
          one group above reports the config as it stands now — and that switch
          says of itself that it takes effect on the next launch. Written in the
          present ("is turned off in the group above") the two disagree the
          instant someone flips it on: a switch reading ON, directly above a
          sentence claiming it is off. Naming the launch instead makes both
          true, and says the thing the reader actually needs — that what they
          just changed has not happened yet.
        */}
        <p className="text-[11.5px] text-subtle">
          The login-shell import was off when this app started. The switch above
          controls it, and takes effect on the next launch.
        </p>
      </>
    );
  }

  if (!loginEnv.imported) {
    return (
      <>
        <p className="flex items-start gap-2 text-[12.5px]">
          <CheckCircle size={14} className="mt-px shrink-0 text-green" />
          <span className="text-ink">
            Already your login shell&rsquo;s. {counts}
          </span>
        </p>
        <p className="text-[11.5px] text-subtle">
          <code className="font-mono">{loginEnv.shell ?? 'Your shell'}</code> was
          asked and had nothing to add — which is the normal answer when the app
          was started from a terminal.
        </p>
      </>
    );
  }

  return (
    <>
      <p className="flex items-start gap-2 text-[12.5px]">
        <CheckCircle size={14} className="mt-px shrink-0 text-green" />
        <span className="text-ink">
          Imported from your login shell (
          <code className="font-mono text-muted">{loginEnv.shell}</code>). {counts}
        </span>
      </p>
      {loginEnv.varsImported.some((name) => name !== 'PATH') ? (
        <p className="text-[11.5px] text-subtle">
          Also taken from it:{' '}
          {loginEnv.varsImported
            .filter((name) => name !== 'PATH')
            .map((name) => (
              <code key={name} className="font-mono">
                {name}{' '}
              </code>
            ))}
          — the app records that these are set, never what they contain.
        </p>
      ) : null}
    </>
  );
}
