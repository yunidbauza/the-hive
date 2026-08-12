import { useState } from 'react';

import { TextField } from '@components/ui/text-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { setJiraConnection } from '@lib/project-config';
import {
  JIRA_SITE_ENV,
  JIRA_TOKEN_ENV,
  type JiraStatus,
} from '@shared/jira-contract';

/**
 * Which Atlassian instance, and as whom (HIVE-67).
 *
 * Split from the credential group because the story's own security argument
 * splits here: these two are **ordinary settings** and live in
 * `~/.hive/config.json`, a file the product invites the user to hand-edit. The
 * token is the one thing that does not, and putting it in the same card would
 * blur exactly the line this design exists to draw.
 *
 * Committed on blur or Enter, like every other settings field
 * (`text-field.tsx:24`) — these write to a file, so a commit per keystroke would
 * be a whole-file atomic write per character.
 */

interface JiraConnectionGroupProps {
  status: JiraStatus;
  /** Called after a successful write, so the pane re-reads the status. */
  onChanged: () => void;
}

export function JiraConnectionGroup({
  status,
  onChanged,
}: JiraConnectionGroupProps) {
  const [site, setSite] = useState(status.site ?? '');
  const [email, setEmail] = useState(status.email ?? '');

  /**
   * Commit one field, and only when it actually changed.
   *
   * An emptied field commits `null` rather than `""`. The distinction is
   * carried all the way to the file: `null` removes the key, whereas `""` would
   * be a site named "" and a request to `https:///rest/api/3/myself`.
   *
   * Only the field being committed is named, so saving the site never restates
   * the email — the write path is partial all the way down, as it is for the
   * notification switches above.
   */
  const commit = (
    field: 'site' | 'email',
    draft: string,
    current: string | null,
  ) => {
    const next = draft.trim() === '' ? null : draft.trim();
    if (next === current) return;
    void setJiraConnection({ [field]: next }).then(onChanged);
  };

  /**
   * Say where a value came from when it was not typed here.
   *
   * Both fields show the value a request would *actually* use, which on a
   * machine set up for Atlassian is often one nobody typed — `JIRA_DOMAIN`, or
   * the address `JIRA_API_KEY` carries in its `email:token` form. Showing it
   * without saying so would look like a stored setting, and the user would go
   * looking in `~/.hive/config.json` for a line that is not there.
   */
  const siteHint =
    status.siteSource === 'environment'
      ? `From ${JIRA_SITE_ENV} in this app’s environment. Typing here overrides it.`
      : 'The host only — a pasted https:// address is trimmed to it.';

  const emailHint =
    status.emailSource === 'credential'
      ? `From ${JIRA_TOKEN_ENV}, which carries it as email:token. Typing here overrides it.`
      : 'Both are ordinary settings and live in ~/.hive/config.json.';

  return (
    <SettingsGroup
      title="Jira site"
      description="Which Atlassian instance, and as whom."
    >
      <div className="flex flex-col gap-3 rounded-[7px] border border-border-soft p-3">
        <TextField
          label="Site"
          value={site}
          onChange={setSite}
          onCommit={() => commit('site', site, status.site)}
          placeholder="your-team.atlassian.net"
          hint={siteHint}
        />
        <TextField
          label="Account email"
          value={email}
          onChange={setEmail}
          onCommit={() => commit('email', email, status.email)}
          placeholder="you@example.com"
          hint={emailHint}
        />
      </div>
    </SettingsGroup>
  );
}
