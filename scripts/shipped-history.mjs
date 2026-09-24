/**
 * Every version of every shipped AGENT.md and SKILL.md, as part hashes.
 *
 * The seed merges a shipped file into the user's copy one part at a time
 * (`electron/main/seed/merge.ts`), from the hash of what it shipped last. A
 * `~/.hive` seeded before that merge existed has no such base: its manifest
 * holds a whole-file hash, or nothing at all for the agents that predate the
 * manifest. This index is where their base comes from. A packaged app has no
 * git history to read, so the index is generated here and committed as
 * `resources/shipped-history.json`.
 *
 * Only the versions before the part manifest matter: a file seeded by a build
 * that records parts never needs the index again. Re-run `pnpm seed:history`
 * when a shipped file changes anyway, so the index stays whole.
 *
 * Run with `--experimental-strip-types`: it imports the seed's own parser, so
 * a part is split and hashed exactly the way the seed splits it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { baseOf } from '../electron/main/seed/merge.ts';

const root = join(import.meta.dirname, '..');
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const SHIPPED = /^resources\/((?:agents\/[^/]+\/AGENT|skills\/[^/]+\/SKILL)\.md)$/;

/** @type {Record<string, { file: string; keys: Record<string, string>; body: string }[]>} */
const history = {};

const commits = git('log', '--format=%H', '--reverse', 'HEAD', '--', 'resources/agents', 'resources/skills')
  .split('\n')
  .filter(Boolean);

for (const sha of commits) {
  const paths = git('ls-tree', '-r', '--name-only', sha, 'resources/agents', 'resources/skills').split('\n');

  for (const path of paths) {
    const rel = SHIPPED.exec(path)?.[1];

    if (rel === undefined) continue;

    const text = git('show', `${sha}:${path}`);
    const file = createHash('sha256').update(text).digest('hex');
    const versions = (history[rel] ??= []);

    if (versions.some((version) => version.file === file)) continue;
    versions.push({ file, ...baseOf(text) });
  }
}

const sorted = Object.fromEntries(Object.entries(history).sort(([a], [b]) => a.localeCompare(b)));

writeFileSync(join(root, 'resources/shipped-history.json'), `${JSON.stringify(sorted)}\n`);
console.info(`shipped-history: ${Object.keys(sorted).length} files, ${commits.length} commits`);
