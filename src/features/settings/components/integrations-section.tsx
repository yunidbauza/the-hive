import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';

import { JiraConnectionGroup } from '@features/settings/components/jira-connection-group';
import { JiraCredentialGroup } from '@features/settings/components/jira-credential-group';
import { JiraQueryGroup } from '@features/settings/components/jira-query-group';
import { PathProbes } from '@features/settings/components/path-probes';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { SettingsProviderGroup } from '@features/settings/components/settings-provider-group';
import { SettingsSectionHeader } from '@features/settings/components/settings-section-header';
import { SlackGroup } from '@features/settings/components/slack-group';
import { useAgents } from '@hooks/use-agents';
import { useProjectConfig } from '@hooks/use-project-config';
import { readJiraStatus } from '@lib/jira';
import { readIntegrationsStatus } from '@lib/project-config';
import type {
  GhStatus,
  IntegrationsStatus,
  LoginEnvStatus,
} from '@shared/ipc-contract';
import type { JiraStatus } from '@shared/jira-contract';
import { SLACK_SERVER_KEY } from '@shared/slack-contract';

/**
 * Integrations (story 106).
 *
 * The outside services this app can see but does not own — `gh`, and Jira.
 *
 * ## Why this reports a token source and offers nowhere to type one
 *
 * The epic asks this story to settle "the token source for the PR panel". The
 * PR panel is fixture-backed — nothing in this app fetches from GitHub — so a
 * token typed here would be a credential no code reads, stored in a plaintext
 * file the product encourages hand-editing. What is genuinely useful now is the
 * answer to *which source would be used*, which is the thing people get wrong
 * and the same answer the future real-PR story needs. So: reported, never
 * stored, and the pane says so rather than leaving the user to wonder where
 * their token went.
 *
 * ## Where the notification switches went
 *
 * Out, to their own section (HIVE-75). Three switches about the OS notification
 * centre belonged under the integration that produced them; ten kinds across
 * three sources, generated from a registry, are a section of their own — and
 * leaving them here would have made the longest list in Settings a footnote
 * under somebody else's heading.
 *
 * ## The pane is two bands now, not six groups
 *
 * It used to be a flat run of six equal `SettingsGroup`s — three about GitHub,
 * three about Jira — with nothing but the reading order saying which was which,
 * and the word "Jira" spelled out in three separate titles because the layout
 * could not say it once. `SettingsProviderGroup` says it once, in `brand`, and
 * the titles beneath it shed the prefix: "Jira site" is "Site" under a heading
 * that already said Jira.
 *
 * Two other things moved with that:
 *
 * - **Token source rose above the `gh` probe's siblings**, because the token is
 *   what a reader opens this pane to check; where `gh` lives is the supporting
 *   fact, not the headline.
 * - **PATH source left the pane entirely**, for Runtime — see
 *   `path-source-group.tsx`. It answered a question this pane raises, but it
 *   describes the environment every session spawns into, and the switch that
 *   decides it was always in Runtime. What stays here is `PathProbes`: the list
 *   of directories `gh` was actually looked for in, which is about `gh` and
 *   nothing else.
 */

function TokenSourceLine({ gh }: { gh: GhStatus }) {
  if (gh.tokenSource === 'env' && gh.envVar !== null) {
    return (
      <p className="text-[12.5px] text-ink">
        <code className="font-mono">{gh.envVar}</code> is set in this app&rsquo;s
        environment, so that is the token that would be used.
      </p>
    );
  }

  if (gh.tokenSource === 'keyring') {
    return (
      <p className="text-[12.5px] text-ink">
        <code className="font-mono">gh</code> holds the credential itself, in your
        system keychain. Nothing needs to be configured here.
      </p>
    );
  }

  // Advising `gh auth login` to someone who does not have `gh` would send them
  // to a command that does not exist. The Command line group says it is
  // missing — below this one, since the token is what the pane is opened to
  // check — so this only has to say what the remaining option is.
  if (!gh.installed) {
    return (
      <p className="text-[12.5px] text-amber">
        No token source. Without <code className="font-mono">gh</code>, the only
        one left is <code className="font-mono">GH_TOKEN</code> in this
        app&rsquo;s environment.
      </p>
    );
  }

  return (
    <p className="text-[12.5px] text-amber">
      No token source. Run <code className="font-mono">gh auth login</code>, or set{' '}
      <code className="font-mono">GH_TOKEN</code> in this app&rsquo;s environment.
    </p>
  );
}

/**
 * Why `gh` was not found, in terms of the environment that was searched.
 *
 * Each branch used to end by pointing *down* the pane at the PATH source group.
 * That group is in Runtime now, so every one of them points there instead —
 * which is also where the switch is, so a reader following the sentence lands
 * somewhere they can act rather than somewhere they can only read.
 */
function NotFoundReason({ loginEnv }: { loginEnv: LoginEnvStatus }) {
  if (loginEnv.error !== null) {
    return (
      <p className="text-[11.5px] text-subtle">
        This app searched the <code className="font-mono">PATH</code> it was
        launched with, not your shell&rsquo;s — the import did not run.{' '}
        <strong className="font-normal text-muted">
          Settings → Runtime → PATH source
        </strong>{' '}
        says why.
      </p>
    );
  }

  if (!loginEnv.enabled) {
    return (
      <p className="text-[11.5px] text-subtle">
        This app searched the <code className="font-mono">PATH</code> it was
        launched with — for a desktop app opened from Finder, launchd&rsquo;s
        four entries rather than your shell&rsquo;s. Switch the login-shell
        import on in{' '}
        <strong className="font-normal text-muted">Settings → Runtime</strong>,
        or install <code className="font-mono">gh</code> where this PATH can see
        it.
      </p>
    );
  }

  // Enabled, and the probe succeeded — whether or not it had anything to add.
  return (
    <p className="text-[11.5px] text-subtle">
      This app searched your login shell&rsquo;s own{' '}
      <code className="font-mono">PATH</code>
      {loginEnv.imported ? ', imported at startup' : ''} — the same one a
      terminal would search. So <code className="font-mono">gh</code> is not
      installed anywhere this app can reach:{' '}
      <code className="font-mono">brew install gh</code> is the fix.
    </p>
  );
}

function GhSummary({
  gh,
  loginEnv,
}: {
  gh: GhStatus;
  loginEnv: LoginEnvStatus;
}) {
  if (!gh.installed) {
    return (
      <>
        <p className="flex items-start gap-2 text-[12.5px]">
          <WarningCircle size={14} className="mt-px shrink-0 text-amber" />
          <span className="text-amber">
            <code className="font-mono">gh</code> was not found.
          </span>
        </p>
        <NotFoundReason loginEnv={loginEnv} />
        <PathProbes probes={gh.probes} />
      </>
    );
  }

  return (
    <>
      <p className="flex items-start gap-2 text-[12.5px]">
        <CheckCircle size={14} className="mt-px shrink-0 text-green" />
        <span className="text-ink">
          <code className="font-mono text-muted">{gh.resolved}</code>
          {gh.version === null ? null : (
            <span className="text-subtle"> · version {gh.version}</span>
          )}
        </span>
      </p>

      {gh.error === null ? null : (
        <p className="text-[11.5px] text-amber">
          Asking <code className="font-mono">gh</code> about its auth status failed:{' '}
          {gh.error}
        </p>
      )}

      {gh.authenticated ? (
        <p className="text-[12.5px] text-ink">
          Signed in as <span className="text-muted">{gh.account ?? 'unknown'}</span>.
        </p>
      ) : gh.error === null ? (
        <p className="text-[12.5px] text-amber">
          Installed, but not signed in. Run{' '}
          <code className="font-mono">gh auth login</code> in any terminal.
        </p>
      ) : null}
    </>
  );
}

export function IntegrationsSection() {
  const snapshot = useProjectConfig();
  /**
   * One phrase for the whole section, not one per probe. Four different verbs
   * stacked down a settings pane reads as noise; the same one four times reads
   * as a system doing four things.
   */
  const probing = useSwarmPhrase('loading.diagnostics');
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const [jira, setJira] = useState<JiraStatus | null>(null);
  /**
   * Only the agents that actually name Slack under `mcp:` — the Slack
   * group's own "Used by" line, and its "no slack tools granted" hint (each
   * via `grantsSlackTools`, which only `tools:` can satisfy).
   */
  const slackAgents = (useAgents()?.agents ?? []).filter((agent) =>
    agent.mcp.includes(SLACK_SERVER_KEY),
  );

  /**
   * Asked once, when the pane opens — and keyed on *whether* there is a
   * snapshot, never on the snapshot itself.
   *
   * That distinction is load-bearing. Every mutating verb installs a fresh
   * `ConfigSnapshot` object, so an effect depending on `snapshot` would re-run
   * on each save, and each re-run spawns two `gh` subprocesses from main. Every
   * click of a switch would pay for an answer that cannot have changed —
   * nothing in this pane installs `gh` or signs into it.
   *
   * Not polled either, for the same reason.
   */
  const hasSnapshot = snapshot !== null;

  useEffect(() => {
    if (!hasSnapshot) return;

    let cancelled = false;
    void readIntegrationsStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    void readJiraStatus().then((next) => {
      if (!cancelled) setJira(next);
    });

    return () => {
      cancelled = true;
    };
  }, [hasSnapshot]);

  /**
   * Re-read after a Jira write.
   *
   * Unlike `gh`, this answer *does* change from inside the pane — all four
   * verbs can change it — so the "asked once" rule above governs the initial
   * read, not the lifetime.
   */
  const refreshJira = () => {
    void readJiraStatus().then(setJira);
  };

  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
        <SettingsSectionHeader
          title="Integrations"
          description="Integrations are only available in the desktop app."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
      <SettingsSectionHeader
        title="Integrations"
        description="The services this app can see outside itself, and how it reaches them."
      />

      {snapshot.errors.map((error) => (
        <p
          key={error}
          className="rounded-[5px] border border-red px-2.5 py-1.5 text-[11.5px] text-red"
        >
          {error}
        </p>
      ))}

      <SettingsProviderGroup name="GitHub">
        <SettingsGroup
          title="Token source"
          description="Which credential a GitHub request would use."
        >
          <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
            {status === null ? (
              <p data-probing className="text-[12.5px] text-subtle">{probing}</p>
            ) : (
              <TokenSourceLine gh={status.gh} />
            )}
            <p className="text-[11.5px] text-subtle">
              The pull-request list is still sample data — nothing in the app calls
              GitHub yet. This reports which source would be used when it does. The
              Hive <strong className="font-normal text-muted">does not store a token</strong>;
              it never reads the value of these variables, only whether they are set.
            </p>
          </div>
        </SettingsGroup>

        <SettingsGroup
          title="Command line"
          description="Where gh is, and whether it is signed in."
        >
          <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
            {status === null ? (
              <p data-probing className="text-[12.5px] text-subtle">{probing}</p>
            ) : (
              <GhSummary gh={status.gh} loginEnv={status.loginEnv} />
            )}
          </div>
        </SettingsGroup>
      </SettingsProviderGroup>

      <SettingsProviderGroup name="Jira">
        {jira === null ? (
          <SettingsGroup
            title="Connection"
            description="Real tickets in the WORK tab."
          >
            <p data-probing className="text-[12.5px] text-subtle">{probing}</p>
          </SettingsGroup>
        ) : (
          <>
            <JiraConnectionGroup status={jira} onChanged={refreshJira} />
            <JiraCredentialGroup status={jira} onChanged={refreshJira} />
            <JiraQueryGroup
              jql={snapshot.jira.jql}
              /*
                A test is only meaningful once a request could actually be made.
                Offering the button before then would report "no site configured"
                as though it were a problem with the query.
              */
              canTest={
                jira.site !== null &&
                jira.email !== null &&
                (jira.credential.kind === 'stored' ||
                  jira.credential.kind === 'env')
              }
            />
          </>
        )}
      </SettingsProviderGroup>

      <SettingsProviderGroup name="Slack">
        <SlackGroup agents={slackAgents} />
      </SettingsProviderGroup>
    </div>
  );
}
