import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { JiraConnectionGroup } from '@features/settings/components/jira-connection-group';
import { JiraCredentialGroup } from '@features/settings/components/jira-credential-group';
import { JiraQueryGroup } from '@features/settings/components/jira-query-group';
import { PathProbes } from '@features/settings/components/path-probes';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { useProjectConfig } from '@hooks/use-project-config';
import { readJiraStatus } from '@lib/jira';
import { readIntegrationsStatus } from '@lib/project-config';
import type { GhStatus, IntegrationsStatus } from '@shared/ipc-contract';
import type { JiraStatus } from '@shared/jira-contract';

/**
 * Integrations & notifications (story 106).
 *
 * Two things the app can see but does not own: the `gh` CLI, and the OS's
 * notification centre.
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
  // to a command that does not exist. The group above already says it is
  // missing; this says what the remaining option is.
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

function GhSummary({ gh }: { gh: GhStatus }) {
  if (!gh.installed) {
    return (
      <>
        <p className="flex items-start gap-2 text-[12.5px]">
          <WarningCircle size={14} className="mt-px shrink-0 text-amber" />
          <span className="text-amber">
            <code className="font-mono">gh</code> was not found.
          </span>
        </p>
        <p className="text-[11.5px] text-subtle">
          This app searches its own <code className="font-mono">PATH</code>, which is
          usually not the one your login shell builds — a desktop app inherits the
          environment it was launched from. Installing{' '}
          <code className="font-mono">gh</code> where that PATH can see it is the fix.
        </p>
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
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const [jira, setJira] = useState<JiraStatus | null>(null);

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
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <h2 className="text-[13px] text-ink">Integrations</h2>
        <p className="text-[11.5px] text-subtle">
          Integrations are only available in the desktop app.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[13px] text-ink">Integrations</h2>
        <p className="text-[11.5px] text-subtle">
          What this app can see outside itself, and when it should interrupt you.
        </p>
      </div>

      {snapshot.errors.map((error) => (
        <p
          key={error}
          className="rounded-[5px] border border-red px-2.5 py-1.5 text-[11.5px] text-red"
        >
          {error}
        </p>
      ))}

      <SettingsGroup
        title="GitHub CLI"
        description="Where gh is, and whether it is signed in."
      >
        <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
          {status === null ? (
            <p className="text-[12.5px] text-subtle">Checking…</p>
          ) : (
            <GhSummary gh={status.gh} />
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Token source"
        description="Which credential a GitHub request would use."
      >
        <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
          {status === null ? (
            <p className="text-[12.5px] text-subtle">Checking…</p>
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

      {jira === null ? (
        <SettingsGroup title="Jira" description="Real tickets in the WORK tab.">
          <p className="text-[12.5px] text-subtle">Checking…</p>
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

    </div>
  );
}
