import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { JiraConnectionGroup } from '@features/settings/components/jira-connection-group';
import { JiraCredentialGroup } from '@features/settings/components/jira-credential-group';
import { JiraQueryGroup } from '@features/settings/components/jira-query-group';
import { PathProbes } from '@features/settings/components/path-probes';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { SettingsSectionHeader } from '@features/settings/components/settings-section-header';
import { useProjectConfig } from '@hooks/use-project-config';
import { readJiraStatus } from '@lib/jira';
import { readIntegrationsStatus } from '@lib/project-config';
import type {
  GhStatus,
  IntegrationsStatus,
  LoginEnvStatus,
} from '@shared/ipc-contract';
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

/**
 * Why `gh` was not found — which depends on *which* `PATH` was searched.
 *
 * Before HIVE-84 this was one fixed sentence explaining that a desktop app
 * inherits launchd's environment. That sentence was true, and it is now the
 * wrong advice in the ordinary case: the app imports the login shell's `PATH`
 * at startup, so a failed search usually means `gh` really is not installed —
 * and telling that user to "install it where the PATH can see it" sends them
 * looking for a problem they do not have.
 *
 * Three genuinely different situations, three answers.
 *
 * **Branch on why the PATH is what it is, never on `imported`.** A first pass
 * led with `imported`, which quietly misfiled the most ordinary state of all:
 * launched from a terminal, the login shell is asked, and it has nothing to
 * add — so `imported` is `false` with no error, and the PATH is nonetheless
 * exactly the shell's. That fell through to the failure copy, so this pane
 * said "the import did not run" directly above PATH source saying "already
 * your login shell's", and sent a user who had simply not installed `gh` off
 * hunting an environment problem. The two states that mean *the PATH is the
 * login shell's* — imported, and identical-so-nothing-to-import — must give
 * the same answer, so `error` and `enabled` are what the branches test.
 */
function NotFoundReason({ loginEnv }: { loginEnv: LoginEnvStatus }) {
  if (loginEnv.error !== null) {
    return (
      <p className="text-[11.5px] text-subtle">
        The <code className="font-mono">PATH</code> below is the one this app was
        launched with, not your shell&rsquo;s — the import did not run, and PATH
        source says why.
      </p>
    );
  }

  if (!loginEnv.enabled) {
    return (
      <p className="text-[11.5px] text-subtle">
        The <code className="font-mono">PATH</code> below is the one this app was
        launched with — for a desktop app opened from Finder, launchd&rsquo;s
        four entries rather than your shell&rsquo;s. Switch the login-shell
        import on in Settings → Runtime, or install{' '}
        <code className="font-mono">gh</code> where this PATH can see it.
      </p>
    );
  }

  // Enabled, and the probe succeeded — whether or not it had anything to add.
  return (
    <p className="text-[11.5px] text-subtle">
      This is your login shell&rsquo;s own <code className="font-mono">PATH</code>
      {loginEnv.imported ? ', imported at startup' : ''} — the same one a terminal
      would search. So <code className="font-mono">gh</code> is not installed
      anywhere this app can reach:{' '}
      <code className="font-mono">brew install gh</code> is the fix.
    </p>
  );
}

/**
 * Where the `PATH` came from (HIVE-84).
 *
 * The pane's job here is to make an invisible difference visible: launchd's
 * environment and a login shell's differ by everything a developer installed,
 * and a user who cannot tell which is in force cannot distinguish a broken
 * import from a genuinely missing binary. The entry counts are shown as a
 * *pair* for the same reason — "38 entries" alone means nothing; "38, and the
 * inherited one had 4" is the whole story in one line.
 *
 * Never renders a value. `varsImported` is names only, by contract.
 */
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
        <p className="text-[11.5px] text-subtle">
          Importing your login shell&rsquo;s environment is turned off in Settings →
          Runtime.
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
        <SettingsSectionHeader
          title="Integrations"
          description="Integrations are only available in the desktop app."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <SettingsSectionHeader
        title="Integrations"
        description="What this app can see outside itself, and when it should interrupt you."
      />

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
            <GhSummary gh={status.gh} loginEnv={status.loginEnv} />
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="PATH source"
        description="Which environment this app is searching, and where it came from."
      >
        <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
          {status === null ? (
            <p className="text-[12.5px] text-subtle">Checking…</p>
          ) : (
            <PathSourceLine loginEnv={status.loginEnv} />
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
