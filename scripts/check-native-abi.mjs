/**
 * Makes native-module breakage say what it is (story 084).
 *
 * `node-pty` is the only native addon in the tree, and every way it can fail
 * produces an error naming neither `node-pty` nor the actual cause. This script
 * runs before `pnpm desktop:dev` and after `pnpm install`, and turns each
 * failure into one actionable line.
 *
 * ## What story 084 predicted, and what is actually true
 *
 * The story expected an **ABI mismatch**: `node-pty` compiles against a
 * specific `NODE_MODULE_VERSION`, Electron's bundled Node has a different one,
 * so the binary must be rebuilt with `@electron/rebuild` after every install.
 *
 * That is not true of `node-pty@1.1.0`. It ships **N-API prebuilds**
 * (`prebuilds/<platform>-<arch>/pty.node`), and N-API is ABI-stable across both
 * Node versions and Electron. Verified on this tree: the same prebuild loads
 * and spawns a working PTY under plain Node (ABI 127) and under Electron 43
 * (ABI 148), with no rebuild at all.
 *
 * Running `electron-rebuild` unconditionally would *discard* that portable
 * prebuild and replace it with an ABI-locked `build/Release` binary —
 * introducing the coupling the story was trying to avoid. So it is not in
 * `postinstall`. `pnpm rebuild:pty` remains as the escape hatch for the case
 * that genuinely needs it: no prebuild exists for the platform (musl, some
 * Linux arches), `node-pty` falls back to `node-gyp rebuild`, and *that* build
 * is Node-ABI-locked.
 *
 * ## The failure that is actually real
 *
 * `node-pty@1.1.0` publishes `prebuilds/<platform>-<arch>/spawn-helper` with
 * mode `0644` — no executable bit. It is in the tarball that way, so every
 * package manager reproduces it, and the package's own `post-install.js` only
 * ever chmods `build/Release/`, which a prebuild install never populates.
 *
 * The symptom is `Error: posix_spawnp failed.` thrown from inside the addon on
 * the first spawn — after `require` has already succeeded. It names neither
 * node-pty nor permissions, and it looks like a PTY bug. `--fix` repairs it.
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants, chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where a prebuild lands for the current machine. */
export const prebuildDir = (platform = process.platform, arch = process.arch) =>
  `prebuilds/${platform}-${arch}`;

/**
 * The pure half: state in, one actionable line out.
 *
 * Kept free of I/O so the remediation strings are unit-testable against
 * synthetic states, which is the only way to know the message a developer
 * actually sees at 6pm is the one that was written.
 */
export function describeNativeState(state) {
  switch (state.kind) {
    case 'ok':
      return {
        ok: true,
        message: state.electronAbi
          ? `node-pty loads under Electron (ABI ${state.electronAbi}) and spawn-helper is executable.`
          : 'node-pty loads under Electron and spawn-helper is executable.',
      };

    case 'module-missing':
      return {
        ok: false,
        message:
          'node-pty is not installed. pnpm 10 blocks dependency install scripts unless allowlisted — check that "node-pty" is listed in pnpm.onlyBuiltDependencies, then run `pnpm install`.',
      };

    case 'binary-missing':
      return {
        ok: false,
        message: `node-pty installed but has no native binary at ${state.expected} — its install script did not run. Check pnpm.onlyBuiltDependencies contains "node-pty", then run \`pnpm install\`.`,
      };

    case 'abi-mismatch':
      return {
        ok: false,
        message: `node-pty was built for ABI ${state.builtAbi}, this Electron needs ${state.electronAbi} — run \`pnpm rebuild:pty\`.`,
      };

    case 'helper-not-executable':
      return {
        ok: false,
        message: `node-pty's spawn-helper is not executable (${state.helperPath}). Every PTY spawn will fail with "posix_spawnp failed", which names neither node-pty nor permissions — run \`pnpm check:abi --fix\`.`,
      };

    case 'load-failed':
      return {
        ok: false,
        message: `node-pty failed to load under Electron: ${state.detail}`,
      };

    /* c8 ignore next 2 */
    default:
      throw new Error(`unknown native state: ${JSON.stringify(state)}`);
  }
}

/**
 * Pulls the two ABI numbers out of Node's `ERR_DLOPEN_FAILED` text.
 *
 * The message reads "was compiled against a different Node.js version using
 * NODE_MODULE_VERSION <built>. This version of Node.js requires
 * NODE_MODULE_VERSION <required>." Returns null when the error is something
 * else entirely, so the caller can report it verbatim rather than guessing.
 */
export function parseAbiError(stderr) {
  const matches = [...String(stderr).matchAll(/NODE_MODULE_VERSION (\d+)/g)];
  if (matches.length < 2) return null;
  return { builtAbi: Number(matches[0][1]), electronAbi: Number(matches[1][1]) };
}

/** True when any of the executable bits are set. */
export const isExecutable = (mode) => (mode & 0o111) !== 0;

/**
 * Reads the ABI number out of the probe's stdout.
 *
 * Not `Number(stdout.trim())`: run from `postinstall`, the Electron shim can
 * still be printing "Downloading Electron binary…" ahead of the value, and a
 * naive parse yields `NaN` — which then renders as "ABI NaN" in a message
 * whose entire job is to be trustworthy. Take the last line that is a bare
 * integer, and report `null` rather than `NaN` if there isn't one.
 */
export function parseAbiOutput(stdout) {
  const lines = String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\d+$/.test(lines[i])) return Number(lines[i]);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The impure half — only runs when invoked as a script.               */
/* ------------------------------------------------------------------ */

function electronBinary() {
  const bin = join(appRoot, 'node_modules/.bin/electron');
  return existsSync(bin) ? bin : null;
}

function inspect({ fix }) {
  const moduleDir = join(appRoot, 'node_modules/node-pty');
  if (!existsSync(moduleDir)) return { kind: 'module-missing' };

  // Windows uses ConPTY and ships no spawn-helper; the exec-bit check is a
  // POSIX concern only.
  const isWindows = process.platform === 'win32';
  const prebuild = join(moduleDir, prebuildDir());
  const ptyNode = join(prebuild, 'pty.node');
  const legacyBuild = join(moduleDir, 'build/Release/pty.node');

  if (!existsSync(ptyNode) && !existsSync(legacyBuild)) {
    return { kind: 'binary-missing', expected: prebuildDir() + '/pty.node' };
  }

  if (!isWindows && existsSync(ptyNode)) {
    const helperPath = join(prebuild, 'spawn-helper');
    if (existsSync(helperPath) && !isExecutable(statSync(helperPath).mode)) {
      if (!fix) return { kind: 'helper-not-executable', helperPath };
      chmodSync(helperPath, 0o755);
      console.log(`  fixed: chmod +x ${helperPath}`);
    }
  }

  const electron = electronBinary();
  if (!electron) return { kind: 'module-missing' };
  try {
    accessSync(electron, constants.X_OK);
  } catch {
    return { kind: 'module-missing' };
  }

  try {
    const abi = execFileSync(
      electron,
      ['-p', "require('node-pty') && process.versions.modules"],
      {
        cwd: appRoot,
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { kind: 'ok', electronAbi: parseAbiOutput(abi) };
  } catch (error) {
    const stderr = error.stderr ?? error.message ?? '';
    const abi = parseAbiError(stderr);
    if (abi) return { kind: 'abi-mismatch', ...abi };
    return { kind: 'load-failed', detail: String(stderr).trim().split('\n')[0] };
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const fix = process.argv.includes('--fix');
  const { ok, message } = describeNativeState(inspect({ fix }));
  console.log(`${ok ? 'ok' : 'ERROR'}  ${message}`);
  process.exit(ok ? 0 : 1);
}
