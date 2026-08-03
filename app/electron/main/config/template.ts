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
    '//': 'The Hive — workspace config. Maps a project shown in the left rail to a real directory on this machine.',
    '//docs': 'A project listed here can host a real terminal session. One that is not still appears, marked "unmapped".',
    version: CONFIG_VERSION,
    '//shell': 'Optional. The login shell every session runs. Defaults to $SHELL.',
    '//claudeCommand': `Optional. The command a session bootstraps with. Defaults to "${DEFAULT_CLAUDE_COMMAND}".`,
    '//projects': 'id must match a project id shown in the left rail. "~" is expanded; the path must be an existing directory.',
    '//example': [{ id: 'apfm-web', path: '~/repos/apfm-web' }],
    projects: [],
  },
  null,
  2,
)}\n`;
