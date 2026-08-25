import {
  CONFIG_VERSION,
  DEFAULT_CLAUDE_COMMAND,
} from '@shared/config-contract';

/**
 * The first-run template (story 090).
 *
 * Writing a **commented** template beats writing an empty file, and beats
 * writing nothing at all: the user opens the path we logged and can see the
 * shape without going to find documentation. An empty `{}` teaches nothing and
 * an absent file leaves them guessing at both the location and the schema.
 *
 * JSON has no comment syntax, so the comments are `"//"`-prefixed keys, which
 * `parse.ts` ignores by rule. This repo's own `package.json` already documents
 * its `pnpm.onlyBuiltDependencies` block the same way — the convention is
 * borrowed rather than invented, and it survives a round trip through any
 * editor's JSON formatter, which a `//` line comment would not.
 */
export const CONFIG_TEMPLATE = `${JSON.stringify(
  {
    '//': 'The Hive — workspace config. Declares the repositories you can open a session in.',
    '//docs': 'You do not have to edit this by hand: Settings → Projects adds and removes entries, and preserves these comments when it writes.',
    version: CONFIG_VERSION,
    '//shell': 'Optional. The login shell every session runs. Defaults to your account login shell.',
    '//claudeCommand': `Optional. The command a session bootstraps with. Defaults to "${DEFAULT_CLAUDE_COMMAND}".`,
    '//env':
      'Optional. { "NAME": "value" } applied to every session, under any project\'s own env, before the shell starts. A login shell\'s rc file runs afterward and can override these — Settings has a diagnostic that shows when it does.',
    /**
     * Story 090 required `id` to match a fixture project id. Story 101 reverses
     * that — the config now *declares* projects — so the template must stop
     * teaching the old rule, or a fresh install ships documentation that is
     * false the moment it is written.
     */
    '//subscriptionAuth':
      'Optional, default true. Sessions drop ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so `claude` authenticates on your Claude.ai plan — which is what makes the header\'s session and weekly gauges work at all, since rate limits are reported only for subscriptions. Set false to inherit whatever you export and bill the API instead.',
    '//sessionMetrics':
      'Optional, default true. The app injects a blank status line into each session so it can read context and rate-limit usage for the header. Set false to keep your own status line and Claude Code\'s footer key hints; the header\'s gauges then stay empty.',
    '//importLoginEnv':
      'Optional, default true. At startup the app runs your login shell once and adopts its PATH (plus GH_TOKEN / GITHUB_TOKEN if it has them, and this process does not). Without it a Finder-launched app inherits launchd\'s four-entry PATH and cannot find gh, claude, or anything else you installed. Set false if you would rather this app never ran your rc file.',
    '//projects':
      'id is stable and referenced by sessions; name is what you see; key is the 2-4 letter alias you type into the console ("spawn <key> <task>"), generated for you if you leave it out. "~" is expanded; the path must be an existing directory.',
    '//example': [
      {
        id: 'nova-web',
        key: 'aw',
        name: 'NOVA Web',
        path: '~/repos/nova-web',
        icon: 'ph-folder',
        origin: 'local',
      },
    ],
    projects: [],
  },
  null,
  2,
)}\n`;
