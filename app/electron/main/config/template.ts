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
    '//shell': 'Optional. The login shell every session runs. Defaults to $SHELL.',
    '//claudeCommand': `Optional. The command a session bootstraps with. Defaults to "${DEFAULT_CLAUDE_COMMAND}".`,
    /**
     * Story 090 required `id` to match a fixture project id. Story 101 reverses
     * that — the config now *declares* projects — so the template must stop
     * teaching the old rule, or a fresh install ships documentation that is
     * false the moment it is written.
     */
    '//projects':
      'id is stable and referenced by sessions; name is what you see. "~" is expanded; the path must be an existing directory.',
    '//example': [
      {
        id: 'apfm-web',
        name: 'APFM Web',
        path: '~/repos/apfm-web',
        icon: 'ph-folder',
        origin: 'local',
      },
    ],
    projects: [],
  },
  null,
  2,
)}\n`;
