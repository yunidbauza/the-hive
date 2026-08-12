import { CheckCircle, Circle, WarningCircle, XCircle } from '@phosphor-icons/react';
import { useState } from 'react';

import { SecretField } from '@components/ui/secret-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { clearJiraToken, saveJiraToken, testJiraConnection } from '@lib/jira';
import { JIRA_TOKEN_ENV } from '@shared/jira-contract';
import type {
  JiraCredentialState,
  JiraIdentity,
  JiraResult,
  JiraStatus,
} from '@shared/jira-contract';

/**
 * The one secret this app stores (HIVE-67).
 *
 * `gh.ts` deliberately stores no token, because nothing read one. Something
 * reads this one, so the reasoning changes — but the *conclusion* about the
 * config file does not: the token goes to `safeStorage`, and this pane says so
 * rather than leaving the user to wonder where it went.
 *
 * The pane can write a token and clear one. It cannot read one back, and the
 * copy says that in those words: a user who wants to see their token has to
 * look at Atlassian, which is correct.
 */

interface JiraCredentialGroupProps {
  status: JiraStatus;
  /** Called after every verb, so the pane re-reads the status. */
  onChanged: () => void;
}

/** One line per state. The union is what decides; there is no default branch. */
function CredentialLine({ credential }: { credential: JiraCredentialState }) {
  if (credential.kind === 'stored') {
    return (
      <p className="flex items-start gap-2 text-[12.5px]">
        <CheckCircle size={14} className="mt-px shrink-0 text-green" />
        <span className="text-ink">
          A token is stored for{' '}
          <span className="text-muted">{credential.email || 'this app'}</span>.
        </span>
      </p>
    );
  }

  if (credential.kind === 'env') {
    return (
      <p className="flex items-start gap-2 text-[12.5px]">
        <CheckCircle size={14} className="mt-px shrink-0 text-green" />
        <span className="text-ink">
          <code className="font-mono">{credential.variable}</code> is set in this
          app&rsquo;s environment, so that is the token being used. Either a bare
          token or <code className="font-mono">email:token</code> works; saving
          one below overrides it.
        </span>
      </p>
    );
  }

  if (credential.kind === 'unavailable') {
    return (
      <p className="flex items-start gap-2 text-[12.5px]">
        <WarningCircle size={14} className="mt-px shrink-0 text-amber" />
        {/* Main composed this sentence and it names the variable. Shown
            verbatim rather than translated back from a code. */}
        <span className="text-amber">{credential.reason}</span>
      </p>
    );
  }

  return (
    <p className="flex items-start gap-2 text-[12.5px]">
      <Circle size={14} className="mt-px shrink-0 text-subtle" />
      <span className="text-subtle">
        No token stored. The WORK tab will keep showing sample tickets.
      </span>
    </p>
  );
}

/** The verdict from the last "Test connection", or nothing. */
function TestVerdict({ result }: { result: JiraResult<JiraIdentity> }) {
  if (result.ok) {
    return (
      <p className="flex items-start gap-2 text-[12.5px]">
        <CheckCircle size={14} className="mt-px shrink-0 text-green" />
        <span className="text-ink">
          Signed in as{' '}
          <span className="text-muted">{result.value.displayName}</span>.
        </span>
      </p>
    );
  }

  return (
    <p className="flex items-start gap-2 text-[12.5px]">
      <XCircle size={14} className="mt-px shrink-0 text-red" />
      <span className="text-red">{result.error.message}</span>
    </p>
  );
}

export function JiraCredentialGroup({
  status,
  onChanged,
}: JiraCredentialGroupProps) {
  const [draft, setDraft] = useState('');
  const [verdict, setVerdict] = useState<JiraResult<JiraIdentity> | null>(null);
  const [testing, setTesting] = useState(false);

  const save = () => {
    const token = draft.trim();
    if (token === '') return;
    void saveJiraToken(token).then(() => {
      // Cleared immediately. A token left in React state is a token in every
      // heap snapshot and every devtools component inspection from here on.
      setDraft('');
      setVerdict(null);
      onChanged();
    });
  };

  const clear = () => {
    void clearJiraToken().then(() => {
      setVerdict(null);
      onChanged();
    });
  };

  const test = () => {
    setTesting(true);
    void testJiraConnection().then((result) => {
      setTesting(false);
      /**
       * A `null` here is a broken channel, not a Jira verdict, so it is
       * reported as one rather than rendered as a connection failure the user
       * would go and debug on Atlassian's side.
       */
      setVerdict(
        result ?? {
          ok: false,
          error: {
            kind: 'unknown',
            message: 'The app could not reach its own main process.',
          },
        },
      );
      // A successful test proves nothing about the *state*, but a 401 on a
      // stored token is worth re-reading for: main leaves the credential alone,
      // and the pane should still show what it actually holds.
      onChanged();
    });
  };

  return (
    <SettingsGroup
      title="API token"
      description="The one secret this app stores."
    >
      <div className="flex flex-col gap-2.5 rounded-[7px] border border-border-soft p-3">
        <CredentialLine credential={status.credential} />

        {/* A control that cannot work is absent rather than disabled — the same
            rule the notification switches follow when the OS cannot show
            one. */}
        {status.encryptionAvailable ? (
          <>
            <SecretField
              label="API token"
              value={draft}
              onChange={setDraft}
              onCommit={save}
              placeholder={
                status.credential.kind === 'stored'
                  ? 'Paste a new token to replace it'
                  : 'Paste your Atlassian API token'
              }
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={save}
                disabled={draft.trim() === ''}
                className="rounded-[6px] border border-border bg-panel-2 px-2.5 py-1 text-[12px] text-ink hover:bg-hover disabled:cursor-not-allowed disabled:text-subtle disabled:hover:bg-panel-2"
              >
                Save
              </button>
              {status.credential.kind === 'stored' ? (
                <button
                  type="button"
                  onClick={clear}
                  className="rounded-[6px] border border-transparent px-2 py-1 text-[12px] text-subtle hover:bg-hover hover:text-ink"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-[11.5px] text-subtle">
            The Hive will not write a token in plaintext instead. Set{' '}
            <code className="font-mono">{JIRA_TOKEN_ENV}</code> in this
            app&rsquo;s environment and restart it.
          </p>
        )}

        <p className="text-[11.5px] text-subtle">
          Encrypted with a key the operating system holds, in this app&rsquo;s
          own data folder — never in{' '}
          <code className="font-mono">~/.hive/config.json</code>, which you are
          meant to hand-edit. The app can write it and clear it;{' '}
          <strong className="font-normal text-muted">
            there is no way to read it back
          </strong>
          . To see your token, look at Atlassian.
        </p>

        <div className="flex items-center gap-2 border-t border-border-soft pt-2.5">
          <button
            type="button"
            onClick={test}
            disabled={testing}
            className="rounded-[6px] border border-border bg-panel-2 px-2.5 py-1 text-[12px] text-ink hover:bg-hover disabled:cursor-not-allowed disabled:text-subtle disabled:hover:bg-panel-2"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <span className="text-[11.5px] text-subtle">
            Calls <code className="font-mono">/rest/api/3/myself</code>.
          </span>
        </div>

        {verdict === null ? null : <TestVerdict result={verdict} />}
      </div>
    </SettingsGroup>
  );
}
