import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchHive, startSession, writeProjectConfig } from './fixtures/hive-app';

/**
 * A session's branch is the repository's, never one the app invented (HIVE-78).
 *
 * ## Why this cannot be a unit test
 *
 * The unit suite proves each half — `sessions/git.ts` reads `rev-parse`
 * correctly, the store applies what arrives, the three surfaces render an em
 * dash without one. What none of them can prove is that the halves are
 * *connected*: that starting a real session in a real repository, through a
 * real main process, puts that repository's actual branch on screen.
 *
 * That is exactly the defect this story fixes. Every individual piece of the
 * old behaviour was also fine in isolation — `spawnSession` assigned a string
 * and the meta bar rendered it. The bug was that nothing in between ever
 * checked whether the string was true.
 *
 * ## Why the branch is deliberately not `main`
 *
 * A repository created with `git init` is on `main` or `master` depending on
 * the developer's `init.defaultBranch`, and both are plausible enough that a
 * passing assertion would prove very little. Checking out a distinctive name
 * first means the value on screen can only have come from `git`.
 *
 * ## What this spec does *not* exercise
 *
 * The hook-driven half. `claudeCommand` is stubbed across this suite (see
 * `STUB_CLAUDE_COMMAND`), so no agent runs and no hook ever fires — which makes
 * this a test of the spawn-time read, and of the honest floor the feature
 * promises for sessions with no hooks at all. Driving a worktree move
 * end-to-end needs a real agent in the loop, which this suite has no way to
 * stand up; `docs/branch-sync-note.md` records that gap.
 */

const BRANCH = 'feat/e2e-observed-branch';

/** A scratch repository on a branch no default could produce by accident. */
function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', path, ...args], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        // The suite must not depend on, or be affected by, the developer's own
        // git identity or hooks.
        GIT_AUTHOR_NAME: 'hive-e2e',
        GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
        GIT_COMMITTER_NAME: 'hive-e2e',
        GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });

  git('init', '--quiet');
  writeFileSync(`${path}/readme.md`, '# scratch\n');
  git('add', 'readme.md');
  git('commit', '--quiet', '-m', 'initial');
  /**
   * A commit first, then the branch. `git checkout -b` on an unborn HEAD works,
   * but `rev-parse --abbrev-ref HEAD` on a repository with no commits fails —
   * so a spec that skipped the commit would be asserting the em-dash path while
   * claiming to assert the branch one.
   */
  git('checkout', '--quiet', '-b', BRANCH);
}

test('the meta bar shows the repository branch, not a generated one', async ({}, testInfo) => {
  const repo = testInfo.outputPath('scratch-repo');
  makeRepo(repo);

  writeProjectConfig(testInfo.outputPath('hive-config.json'), {
    id: 'scratch',
    path: repo,
  });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath: testInfo.outputPath('hive-config.json'),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  const id = await startSession(page, 'scratch');

  /**
   * Polled, because the read is asynchronous by design: a spawn must not wait
   * on `git`, so the branch arrives a moment after the row does.
   *
   * Asserted on **both** surfaces rather than one. They are separate components
   * reading the same field through different selectors, and the first version
   * of this spec queried the page and hit a strict-mode violation for exactly
   * that reason — two elements, which is the correct answer. Naming them is
   * better than narrowing to one and losing the coverage.
   */
  const metaBar = page.getByTestId('session-meta-bar');
  await expect(metaBar.getByText(BRANCH)).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('button', { name: new RegExp(`${id}.*${BRANCH}`) }),
  ).toBeVisible();

  /**
   * The regression this whole story exists for. `feat/sess-01` was rendered
   * with complete confidence beside a session that was on `main` — so its
   * *absence* is the assertion that would have failed before, and the one that
   * fails again if anyone reintroduces a generated default.
   */
  await expect(page.getByText(`feat/${id}`)).toHaveCount(0);

  await app.close();
});

test('a project that is not a repository shows an em dash', async ({}, testInfo) => {
  /**
   * The honest floor. A directory in no repository has no branch, and the app
   * says so rather than inventing one — the same rule as the worktree case,
   * seen from the other side.
   *
   * ## Why this cannot use `testInfo.outputPath()`
   *
   * Playwright's output directory lives **inside this repository**, and
   * `git rev-parse` walks up: run in `test-results/…`, it cheerfully reports
   * the branch of the enclosing checkout. That is correct git behaviour and
   * correct app behaviour — a project mapped to a subdirectory of a repository
   * really is on that repository's branch — but it means an `outputPath` is not
   * a "not a repository" fixture.
   *
   * This spec passed against `outputPath` for a while purely because `git` was
   * failing to resolve at all, so *every* read answered `null`. Fixing the PATH
   * resolution is what exposed it. A genuine temp directory is the only place
   * with no repository above it.
   */
  const plain = mkdtempSync(join(tmpdir(), 'hive-plain-'));

  writeProjectConfig(testInfo.outputPath('hive-config.json'), {
    id: 'plain',
    path: plain,
  });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath: testInfo.outputPath('hive-config.json'),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  const id = await startSession(page, 'plain');

  // The meta bar's branch chip. Scoped to it rather than the page, because the
  // fleet table's PR column renders an em dash of its own for "no pull request".
  const metaBar = page.getByTestId('session-meta-bar');
  await expect(metaBar.getByText('—')).toBeVisible();
  await expect(page.getByText(`feat/${id}`)).toHaveCount(0);

  await app.close();
});
