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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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
      'src/components/layout/probe.ts':
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
  {
    name: 'zone: only stores/ may import data/',
    rule: 'import/no-restricted-paths',
    files: {
      'src/data/probe-target.ts': 'export const fixture = 1;\n',
      'src/features/work/probe.ts':
        "import { fixture } from '@/data/probe-target';\nexport const probe = fixture;\n",
    },
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
    name: 'ALLOWED: stores/ may import data/',
    rule: null,
    files: {
      'src/data/probe-target.ts': 'export const fixture = 1;\n',
      'src/stores/probe.ts':
        "import { fixture } from '@/data/probe-target';\nexport const probe = fixture;\n",
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
    rmSync(join(appRoot, 'src/utils/ProbeFolder'), {
      recursive: true,
      force: true,
    });
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

for (const result of results) {
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}\n      expected: ${result.expected}\n      fired:    ${result.fired}`,
  );
}

console.log(
  `\n${results.length - failures}/${results.length} boundary checks behaved as specified.`,
);
process.exit(failures === 0 ? 0 : 1);
