import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The PTY conformance runner (story 098).
 *
 *     ELECTRON_RUN_AS_NODE=1 electron scripts/run-pty-conformance.mjs
 *
 * `ELECTRON_RUN_AS_NODE=1` runs the Electron binary as a plain Node process:
 * Electron's ABI, so the rebuilt `node-pty` loads (story 084), but no Chromium,
 * no window, no display. That is what makes this layer cheap enough to run on
 * every push, and it is why the suite lives here rather than in Vitest — where
 * `node-pty` is mocked and must be — or in Playwright, where every assertion
 * would round-trip through IPC, xterm's parser and the DOM, turning a
 * signal-delivery question into a text-scraping question with a timeout
 * attached.
 *
 * Output is TAP-ish plus a summary table, so a CI failure names the property
 * that broke — `signals › ctrl-c interrupts the foreground job` — rather than a
 * line number. `--filter <substring>` runs one group locally.
 */

const MODULES = [
  'identity',
  'environment',
  'signals',
  'resize',
  'rendering',
  'throughput',
  'lifecycle',
  'descendants',
  'bootstrap',
];

const BUILT = join(import.meta.dirname, '../out/main/session-manager.js');

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const RESET = '[0m';

function parseArgs(argv) {
  const filter = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--filter') {
      const value = argv[i + 1];
      if (!value) {
        console.error('--filter needs a value');
        process.exit(2);
      }
      filter.push(value);
      i += 1;
    } else if (argv[i].startsWith('--filter=')) {
      filter.push(argv[i].slice('--filter='.length));
    }
  }
  return { filter };
}

/**
 * Refuse early, with the command to run.
 *
 * The suite drives the **built** session manager, so a stale or missing `out/`
 * is the one failure mode that has nothing to do with terminal semantics. A
 * module-not-found stack trace here would send someone looking for a bug in
 * their pty.
 */
function requireBuild() {
  if (existsSync(BUILT)) return;
  console.error(
    `${RED}✗${RESET} ${BUILT} is missing.\n` +
      '  The conformance suite drives the built session manager under ' +
      "Electron's ABI.\n" +
      '  Run `pnpm desktop:build` first, or use `pnpm test:pty`, which does it ' +
      'for you.',
  );
  process.exit(2);
}

/**
 * Refuse to run outside Electron.
 *
 * Under plain Node the prebuilt `node-pty` is the wrong ABI and fails to load
 * with an error that names neither Electron nor the ABI. Saying so here costs
 * one line and saves an afternoon.
 */
function requireElectronAbi() {
  if (process.versions.electron) return;
  console.error(
    `${RED}✗${RESET} not running under Electron.\n` +
      '  Run `ELECTRON_RUN_AS_NODE=1 electron scripts/run-pty-conformance.mjs`,' +
      ' or `pnpm test:pty`.',
  );
  process.exit(2);
}

const formatMs = (ms) => `${ms.toString().padStart(5)}ms`;

async function main() {
  requireElectronAbi();
  requireBuild();

  const { filter } = parseArgs(process.argv.slice(2));

  const harness = await import(
    pathToFileURL(join(import.meta.dirname, '../tests/conformance/harness.mjs'))
  );

  for (const name of MODULES) {
    await import(
      pathToFileURL(
        join(import.meta.dirname, `../tests/conformance/${name}.conformance.mjs`),
      )
    );
  }

  const groups = harness.groups.filter(
    (group) =>
      filter.length === 0 ||
      filter.some((needle) => group.name.includes(needle)),
  );

  if (groups.length === 0) {
    console.error(`no groups matched --filter ${filter.join(' ')}`);
    process.exit(2);
  }

  const total = groups.reduce((sum, group) => sum + group.tests.length, 0);
  console.log(`TAP version 13`);
  console.log(`1..${total}`);

  const failures = [];
  const summary = [];
  const startedAll = Date.now();
  let index = 0;

  for (const group of groups) {
    console.log(`${DIM}# ${group.name}${RESET}`);
    let passed = 0;

    for (const test of group.tests) {
      index += 1;
      const context = harness.createContext();
      const started = Date.now();
      let error = null;

      try {
        await test.fn(context);
      } catch (cause) {
        error = cause;
      }

      /**
       * Teardown runs whether or not the test passed, and **its own failure is
       * a test failure**. A leaked process group is exactly the defect this
       * layer exists to catch, and swallowing it here would hide the one thing
       * no other layer can see.
       */
      try {
        await context.dispose();
      } catch (cause) {
        error ??= cause;
      }

      const elapsed = Date.now() - started;
      const title = `${group.name} › ${test.name}`;

      if (error) {
        console.log(`not ok ${index} - ${title}`);
        console.log(`  ---`);
        for (const line of String(error.message ?? error).split('\n')) {
          console.log(`  ${line}`);
        }
        console.log(`  ...`);
        failures.push({ title, error });
      } else {
        console.log(`ok ${index} - ${title} ${DIM}(${elapsed}ms)${RESET}`);
        passed += 1;
      }
    }

    summary.push({ name: group.name, passed, total: group.tests.length });
  }

  const elapsedAll = Date.now() - startedAll;

  console.log('');
  console.log(`${DIM}property group            passed${RESET}`);
  for (const row of summary) {
    const ok = row.passed === row.total;
    console.log(
      `${ok ? GREEN : RED}${ok ? '✓' : '✗'}${RESET} ${row.name.padEnd(22)} ` +
        `${row.passed}/${row.total}`,
    );
  }

  console.log('');
  if (failures.length > 0) {
    console.log(`${RED}${failures.length} failed${RESET}, ${total - failures.length} passed ${DIM}(${formatMs(elapsedAll).trim()})${RESET}`);
    for (const failure of failures) {
      console.log(`\n${RED}✗${RESET} ${failure.title}`);
      console.log(String(failure.error.stack ?? failure.error.message));
    }
    process.exit(1);
  }

  console.log(
    `${GREEN}${total} passed${RESET} ${DIM}(${formatMs(elapsedAll).trim()})${RESET}`,
  );
}

await main();
