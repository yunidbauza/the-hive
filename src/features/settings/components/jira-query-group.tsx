import { CheckCircle, XCircle } from '@phosphor-icons/react';
import { useState } from 'react';

import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';

import { TextField } from '@components/ui/text-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { searchJiraIssues } from '@lib/jira';
import { setJiraConnection } from '@lib/project-config';
import { JIRA_DEFAULT_JQL } from '@shared/jira-contract';

/**
 * Which issues the WORK tab shows (HIVE-69).
 *
 * A third group rather than a field on either of the other two: this is not the
 * connection and it is not the credential. Site and token are things you set
 * once; a query is a thing you tune, and putting it beside a secret would make
 * the card about two different jobs.
 *
 * ## Validated by running it, not by parsing it
 *
 * "Test query" sends the draft to Jira and reports the match count, or Jira's
 * own parse error verbatim. A client-side JQL parser would be a thing to
 * maintain forever and would be wrong more often than Jira is — and it would be
 * wrong in the direction that matters, rejecting queries that actually work.
 */

interface JiraQueryGroupProps {
  /** The saved override, or `null` for the default query. */
  jql: string | null;
  /** True when the connection is complete enough for a test to mean anything. */
  canTest: boolean;
}

type Verdict =
  | { kind: 'matched'; count: number; capped: boolean }
  | { kind: 'refused'; message: string };

export function JiraQueryGroup({ jql, canTest }: JiraQueryGroupProps) {
  const testingPhrase = useSwarmPhrase('loading.connection');
  const [draft, setDraft] = useState(jql ?? '');
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [testing, setTesting] = useState(false);

  /**
   * An emptied field commits `null`, which restores the default.
   *
   * Not `""`: an empty override stored as a string would be a query matching
   * nothing, and the user who cleared the field meant the opposite.
   */
  const commit = () => {
    const next = draft.trim() === '' ? null : draft.trim();
    if (next === jql) return;
    setVerdict(null);
    void setJiraConnection({ jql: next });
  };

  const test = () => {
    setTesting(true);
    // The *draft*, not the saved value — the point is to check before saving.
    const query = draft.trim();
    void searchJiraIssues(query === '' ? {} : { jql: query }).then((result) => {
      setTesting(false);
      if (result === null) {
        setVerdict({
          kind: 'refused',
          message: 'The app could not reach its own main process.',
        });
        return;
      }
      setVerdict(
        result.ok
          ? {
              kind: 'matched',
              count: result.value.issues.length,
              capped: result.value.capped,
            }
          : { kind: 'refused', message: result.error.message },
      );
    });
  };

  return (
    <SettingsGroup
      title="Query"
      description="Which issues the WORK tab shows."
    >
      <div className="flex flex-col gap-2.5 rounded-[7px] border border-border-soft p-3">
        <TextField
          label="JQL override"
          value={draft}
          onChange={setDraft}
          onCommit={commit}
          placeholder={JIRA_DEFAULT_JQL}
          hint="Blank uses the default shown above. Yours replaces it entirely — it is not added to."
        />

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={test}
            disabled={testing || !canTest}
            className="rounded-[6px] border border-border bg-panel-2 px-2.5 py-1 text-[12px] text-ink hover:bg-hover disabled:cursor-not-allowed disabled:text-subtle disabled:hover:bg-panel-2"
          >
            {testing ? testingPhrase : 'Test query'}
          </button>
          {canTest ? null : (
            <span className="text-[11.5px] text-subtle">
              Configure the site, email and token first.
            </span>
          )}
        </div>

        {verdict === null ? null : verdict.kind === 'matched' ? (
          <p className="flex items-start gap-2 text-[12.5px]">
            <CheckCircle size={14} className="mt-px shrink-0 text-green" />
            <span className="text-ink">
              {verdict.count === 0
                ? 'Ran, and matched no issues.'
                : `Matched ${verdict.count} issue${verdict.count === 1 ? '' : 's'}.`}
              {verdict.capped ? ' The first 200 — there were more.' : ''}
            </span>
          </p>
        ) : (
          <p className="flex items-start gap-2 text-[12.5px]">
            <XCircle size={14} className="mt-px shrink-0 text-red" />
            {/* Jira's own words. It knows why better than any parser here would. */}
            <span className="text-red">{verdict.message}</span>
          </p>
        )}
      </div>
    </SettingsGroup>
  );
}
