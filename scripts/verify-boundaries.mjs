/**
 * Proves the architecture fences actually fire.
 *
 * Story 014's acceptance criteria require each import zone to be demonstrated,
 * not assumed: a clean `pnpm lint` is equally consistent with "no violations"
 * and "rule silently disabled". This script plants one deliberate violation at
 * a time, runs ESLint over the planted files, asserts the expected rule fired,
 * and removes the file again.
 *
 * It also asserts the inverse for the cases that must stay legal — a slice
 * importing itself, and a slice importing `features/shared` — because the
 * per-slice zone formulation exists precisely to keep those working.
 *
 * Run with `pnpm verify:boundaries`. Exits non-zero if any case misbehaves.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { aliases } from '../vite.aliases.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Story 080 cut the alias map from four hand-synced copies to two:
 * `vite.aliases.mjs` (imported by every bundler config) and `tsconfig.json`'s
 * `paths` (TypeScript cannot import a JS module to build its config).
 *
 * Two copies is one more than zero, so it gets a check rather than a promise.
 * The failure this catches is the quiet one: an alias that resolves in the
 * editor and fails at runtime, or vice versa.
 */
function verifyAliasesAgree() {
  /**
   * Parsed with TypeScript's own JSONC reader rather than a regex.
   * `tsconfig.json` carries both comments and alias keys like `"@/*"`. A naive
   * comment stripper treats the slash-star inside that string as the start of a
   * block comment and silently swallows the file up to the next real comment
   * terminator, which yields a parse error a hundred lines from the cause.
   */
  const configPath = join(appRoot, 'tsconfig.json');
  const { config, error } = ts.parseConfigFileTextToJson(
    configPath,
    readFileSync(configPath, 'utf8'),
  );
  if (error) throw new Error(`could not parse tsconfig.json: ${error.messageText}`);
  const { paths } = config.compilerOptions;

  /** `"@components/*": ["./src/components/*"]` → `@components` → absolute dir. */
  const fromTsconfig = Object.fromEntries(
    Object.entries(paths).map(([key, [target]]) => [
      key.replace(/\/\*$/, ''),
      resolve(appRoot, target.replace(/\/\*$/, '')),
    ]),
  );
  const fromVite = Object.fromEntries(
    Object.entries(aliases).map(([key, target]) => [
      key,
      resolve(target.replace(/\/$/, '')),
    ]),
  );

  const problems = [];
  for (const key of new Set([
    ...Object.keys(fromTsconfig),
    ...Object.keys(fromVite),
  ])) {
    const ts = fromTsconfig[key];
    const vite = fromVite[key];
    if (!ts) problems.push(`${key}: in vite.aliases.mjs, missing from tsconfig.json`);
    else if (!vite)
      problems.push(`${key}: in tsconfig.json, missing from vite.aliases.mjs`);
    else if (ts !== vite) problems.push(`${key}: tsconfig ${ts} !== vite ${vite}`);
  }
  return problems;
}

/** @type {{name: string, files: Record<string,string>, rule: string|null}[]} */
const CASES = [
  {
    name: 'zone: feature slice may not import another feature slice',
    rule: 'import/no-restricted-paths',
    files: {
      'src/features/shared/probe-target.ts': 'export const shared = 1;\n',
      'src/features/work/probe-target.ts': 'export const work = 1;\n',
      'src/features/projects/probe.ts':
        "import { work } from '@features/work/probe-target';\nexport const probe = work;\n",
    },
  },
  {
    name: 'zone: components/ may not import features/',
    rule: 'import/no-restricted-paths',
    files: {
      'src/features/work/probe-target.ts': 'export const work = 1;\n',
      'src/components/ui/probe.ts':
        "import { work } from '@features/work/probe-target';\nexport const probe = work;\n",
    },
  },
  {
    name: 'zone: THE SEAM — components/terminal/ may not import data/',
    rule: 'import/no-restricted-paths',
    files: {
      'src/data/probe-target.ts': 'export const fixture = 1;\n',
      'src/components/terminal/probe.ts':
        "import { fixture } from '@/data/probe-target';\nexport const probe = fixture;\n",
    },
  },
  {
    name: 'zone: THE SEAM — components/terminal/ may not import stores/',
    rule: 'import/no-restricted-paths',
    files: {
      'src/stores/probe-target.ts': 'export const store = 1;\n',
      'src/components/terminal/probe.ts':
        "import { store } from '@stores/probe-target';\nexport const probe = store;\n",
    },
  },
  {
    name: 'zone: lib/ may not import features/',
    rule: 'import/no-restricted-paths',
    files: {
      'src/features/work/probe-target.ts': 'export const work = 1;\n',
      'src/lib/probe.ts':
        "import { work } from '@features/work/probe-target';\nexport const probe = work;\n",
    },
  },
  {
    name: 'zone: hooks/ may not import features/',
    rule: 'import/no-restricted-paths',
    files: {
      'src/features/work/probe-target.ts': 'export const work = 1;\n',
      'src/hooks/probe.ts':
        "import { work } from '@features/work/probe-target';\nexport const probe = work;\n",
    },
  },
  {
    name: 'zone: stores/ may not import features/',
    rule: 'import/no-restricted-paths',
    files: {
      'src/features/work/probe-target.ts': 'export const work = 1;\n',
      'src/stores/probe.ts':
        "import { work } from '@features/work/probe-target';\nexport const probe = work;\n",
    },
  },
  /**
   * The splash is a standalone document, and the fence is about load time
   * rather than layering: anything it imports from the app is a chunk it has to
   * parse before it can paint. `stores/` stands in for the whole app here — the
   * zone lists six directories and one planted violation is enough to prove the
   * rule fires, which is what this script exists to show.
   */
  {
    name: 'zone: splash/ may not import the app',
    rule: 'import/no-restricted-paths',
    files: {
      'src/splash/probe.ts':
        "import { useHiveStore } from '@stores/hive-store';\nexport const probe = useHiveStore;\n",
    },
  },
  /**
   * The About panel: the splash's rule with its reason removed.
   *
   * It is a standalone document too, but it opens on demand rather than before
   * the app's bundle exists — so a chunk shared with the app costs it nothing,
   * and `lib/` is deliberately **allowed** (that allowance is how it takes its
   * copy from the app's phrase pools instead of carrying a second one).
   * `stores/` stands in for the runtime the zone does ban.
   */
  {
    name: 'zone: about/ may not import the app’s runtime',
    rule: 'import/no-restricted-paths',
    files: {
      'src/about/probe.ts':
        "import { useHiveStore } from '@stores/hive-store';\nexport const probe = useHiveStore;\n",
    },
  },
  /**
   * The other half of that zone, and the half a ban-only probe cannot show: if
   * `lib/` were added to the `from` list by mistake, About would lose its
   * phrases and nothing above would notice.
   */
  {
    name: 'ALLOWED: about/ may import lib/',
    rule: null,
    files: {
      'src/about/probe-allowed.ts':
        "import { pickPhrase } from '@lib/swarm/phrases';\nexport const probe = pickPhrase;\n",
    },
  },
  /**
   * Test scaffolding never ships.
   *
   * `tests/support/demo-fleet.ts` holds the sample fleet the store used to seed
   * itself with at boot. Moving it out of `src/data/` is what made the app open
   * empty instead of claiming ten sessions nobody started — and this fence is
   * what stops it walking back in one convenient import at a time.
   */
  {
    name: 'zone: src/ may not import tests/',
    rule: 'import/no-restricted-paths',
    files: {
      'tests/support/probe-target.ts': 'export const scaffolding = 1;\n',
      'src/features/work/probe.ts':
        "import { scaffolding } from '@tests/support/probe-target';\nexport const probe = scaffolding;\n",
    },
  },
  {
    name: 'zone: electron/ may not import tests/',
    rule: 'import/no-restricted-paths',
    files: {
      'tests/support/probe-target.ts': 'export const scaffolding = 1;\n',
      'electron/main/probe.ts':
        "import { scaffolding } from '@tests/support/probe-target';\nexport const probe = scaffolding;\n",
    },
  },
  {
    name: 'zone: electron/main/ may not import src/',
    rule: 'import/no-restricted-paths',
    files: {
      'src/utils/probe-target.ts': 'export const renderer = 1;\n',
      'electron/main/probe.ts':
        "import { renderer } from '@/utils/probe-target';\nexport const probe = renderer;\n",
    },
  },
  {
    name: 'zone: electron/preload/ may not import electron/main/',
    rule: 'import/no-restricted-paths',
    files: {
      'electron/main/probe-target.ts': 'export const main = 1;\n',
      'electron/preload/probe.ts':
        "import { main } from '../main/probe-target';\nexport const probe = main;\n",
    },
  },
  {
    name: 'zone: electron/preload/ may not import src/',
    rule: 'import/no-restricted-paths',
    files: {
      'src/utils/probe-target.ts': 'export const renderer = 1;\n',
      'electron/preload/probe.ts':
        "import { renderer } from '@/utils/probe-target';\nexport const probe = renderer;\n",
    },
  },
  {
    name: 'zone: src/ may not import electron/main/',
    rule: 'import/no-restricted-paths',
    files: {
      'electron/main/probe-target.ts': 'export const main = 1;\n',
      'src/utils/probe.ts':
        "import { main } from '../../electron/main/probe-target';\nexport const probe = main;\n",
    },
  },
  {
    name: 'zone: src/ may not import electron/preload/',
    rule: 'import/no-restricted-paths',
    files: {
      'electron/preload/probe-target.ts': 'export const preload = 1;\n',
      'src/utils/probe.ts':
        "import { preload } from '../../electron/preload/probe-target';\nexport const probe = preload;\n",
    },
  },
  {
    /**
     * The fence that made story 094 a change to `src/lib/terminal/` and not a
     * component rewrite.
     *
     * `PtyTransport` reaches a real process through the preload bridge. If a
     * terminal component could reach the same bridge directly, the seam would be
     * decorative: the shortest path to "make the terminal interactive" would be
     * to call `window.hive.pty.write` from the surface, and every later backend
     * change would be a component change again. Proven as its own case rather
     * than left to the generic `src/ may not import electron/preload/` above,
     * because this is the specific regression the terminal invites.
     */
    name: 'zone: THE SEAM — components/terminal/ may not import electron/preload/',
    rule: 'import/no-restricted-paths',
    files: {
      'electron/preload/probe-target.ts': 'export const preload = 1;\n',
      'src/components/terminal/probe.ts':
        "import { preload } from '../../../electron/preload/probe-target';\nexport const probe = preload;\n",
    },
  },
  {
    name: 'zone: electron/pty-host/ may not import electron/main/ (story 091)',
    rule: 'import/no-restricted-paths',
    files: {
      'electron/main/probe-target.ts': 'export const main = 1;\n',
      'electron/pty-host/probe.ts':
        "import { main } from '../main/probe-target';\nexport const probe = main;\n",
    },
  },
  {
    name: 'zone: electron/pty-host/ may not import src/ — no config, no fixtures',
    rule: 'import/no-restricted-paths',
    files: {
      'src/utils/probe-target.ts': 'export const renderer = 1;\n',
      'electron/pty-host/probe.ts':
        "import { renderer } from '@/utils/probe-target';\nexport const probe = renderer;\n",
    },
  },
  {
    name: 'zone: src/ may not import electron/pty-host/',
    rule: 'import/no-restricted-paths',
    files: {
      'electron/pty-host/probe-target.ts': 'export const host = 1;\n',
      'src/utils/probe.ts':
        "import { host } from '../../electron/pty-host/probe-target';\nexport const probe = host;\n",
    },
  },
  {
    name: 'PascalCase folder name is rejected under electron/ too',
    rule: 'check-file/folder-naming-convention',
    files: { 'electron/main/ProbeFolder/probe.ts': 'export const probe = 1;\n' },
  },
  {
    name: 'no circular dependencies',
    rule: 'import/no-cycle',
    files: {
      'src/utils/probe-a.ts':
        "import { b } from '@utils/probe-b';\nexport const a = b;\n",
      'src/utils/probe-b.ts':
        "import { a } from '@utils/probe-a';\nexport const b = a;\n",
    },
  },
  {
    name: 'PascalCase file name is rejected',
    rule: 'check-file/filename-naming-convention',
    files: { 'src/utils/ProbeFile.ts': 'export const probe = 1;\n' },
  },
  {
    name: 'PascalCase folder name is rejected',
    rule: 'check-file/folder-naming-convention',
    files: { 'src/utils/ProbeFolder/probe.ts': 'export const probe = 1;\n' },
  },
  {
    name: 'unordered imports are rejected',
    rule: 'import/order',
    files: {
      'src/utils/probe.ts':
        "import { cn } from '@lib/utils';\nimport { useState } from 'react';\n\nexport const probe = cn(String(useState));\n",
    },
  },

  // Inverse cases — these must stay legal.
  {
    name: 'ALLOWED: a slice may import itself',
    rule: null,
    files: {
      'src/features/projects/probe-target.ts': 'export const own = 1;\n',
      'src/features/projects/probe.ts':
        "import { own } from '@features/projects/probe-target';\nexport const probe = own;\n",
    },
  },
  {
    name: 'ALLOWED: a slice may import features/shared',
    rule: null,
    files: {
      'src/features/shared/probe-target.ts': 'export const shared = 1;\n',
      'src/features/projects/probe.ts':
        "import { shared } from '@features/shared/probe-target';\nexport const probe = shared;\n",
    },
  },
  {
    name: 'ALLOWED: components/layout/ (the composition root) may import features/',
    rule: null,
    files: {
      'src/features/work/probe-target.ts': 'export const work = 1;\n',
      'src/components/layout/probe.ts':
        "import { work } from '@features/work/probe-target';\nexport const probe = work;\n",
    },
  },
  {
    name: 'ALLOWED: stores/ may import data/',
    rule: null,
    files: {
      'src/data/probe-target.ts': 'export const fixture = 1;\n',
      'src/stores/probe.ts':
        "import { fixture } from '@/data/probe-target';\nexport const probe = fixture;\n",
    },
  },
  {
    name: 'ALLOWED: electron/main/ may import electron/shared/',
    rule: null,
    files: {
      'electron/shared/probe-target.ts': 'export const contract = 1;\n',
      'electron/main/probe.ts':
        "import { contract } from '@shared/probe-target';\nexport const probe = contract;\n",
    },
  },
  {
    name: 'ALLOWED: src/ may import electron/shared/ (the contract types)',
    rule: null,
    files: {
      'electron/shared/probe-target.ts': 'export const contract = 1;\n',
      'src/utils/probe.ts':
        "import { contract } from '@shared/probe-target';\nexport const probe = contract;\n",
    },
  },
];

/** Run ESLint over the given paths and return its JSON report. */
function lint(paths) {
  try {
    const stdout = execFileSync(
      'pnpm',
      ['exec', 'eslint', '--no-warn-ignored', '--format', 'json', ...paths],
      { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(stdout);
  } catch (error) {
    // ESLint exits non-zero when it reports errors; the JSON is still on stdout.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

let failures = 0;
const results = [];

for (const testCase of CASES) {
  const written = [];
  for (const [relativePath, contents] of Object.entries(testCase.files)) {
    const absolutePath = join(appRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
    written.push({ relativePath, absolutePath });
  }

  let firedRules = [];
  try {
    firedRules = lint(written.map((f) => f.absolutePath))
      .flatMap((file) => file.messages)
      .map((message) => message.ruleId)
      .filter(Boolean);
  } finally {
    for (const { absolutePath } of written) rmSync(absolutePath, { force: true });
    for (const dir of ['src/utils/ProbeFolder', 'electron/main/ProbeFolder']) {
      rmSync(join(appRoot, dir), { recursive: true, force: true });
    }
  }

  const unique = [...new Set(firedRules)];
  const ok = testCase.rule ? unique.includes(testCase.rule) : unique.length === 0;
  if (!ok) failures += 1;

  results.push({
    ok,
    name: testCase.name,
    expected: testCase.rule ?? '(no error)',
    fired: unique.length ? unique.join(', ') : '(none)',
  });
}

const aliasProblems = verifyAliasesAgree();
results.push({
  ok: aliasProblems.length === 0,
  name: 'aliases: vite.aliases.mjs and tsconfig.json paths agree',
  expected: '(identical alias maps)',
  fired: aliasProblems.length ? aliasProblems.join('; ') : '(none)',
});
if (aliasProblems.length) failures += 1;

for (const result of results) {
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}\n      expected: ${result.expected}\n      fired:    ${result.fired}`,
  );
}

console.log(
  `\n${results.length - failures}/${results.length} boundary checks behaved as specified.`,
);
process.exit(failures === 0 ? 0 : 1);
