import { describe, expect, it } from 'vitest';

import {
  describeNativeState,
  isExecutable,
  parseAbiError,
  parseAbiOutput,
  prebuildDir,
} from '../../scripts/check-native-abi.mjs';

/**
 * Story 084's point is that native breakage must name itself. The remediation
 * strings are therefore asserted verbatim: a message that drifts into
 * vagueness is the failure this script exists to prevent, and nothing else
 * would catch it.
 */
describe('describeNativeState', () => {
  it('reports a healthy tree with the Electron ABI it verified against', () => {
    const { ok, message } = describeNativeState({ kind: 'ok', electronAbi: 148 });

    expect(ok).toBe(true);
    expect(message).toBe(
      'node-pty loads under Electron (ABI 148) and spawn-helper is executable.',
    );
  });

  it('names the ABI pair and the exact remediation on a mismatch', () => {
    const { ok, message } = describeNativeState({
      kind: 'abi-mismatch',
      builtAbi: 127,
      electronAbi: 148,
    });

    expect(ok).toBe(false);
    expect(message).toBe(
      'node-pty was built for ABI 127, this Electron needs 148 — run `pnpm rebuild:pty`.',
    );
  });

  it('explains the spawn-helper exec bit, because posix_spawnp does not', () => {
    const { ok, message } = describeNativeState({
      kind: 'helper-not-executable',
      helperPath: '/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    });

    expect(ok).toBe(false);
    // The literal error a developer would otherwise search for.
    expect(message).toContain('posix_spawnp failed');
    expect(message).toContain('pnpm check:abi --fix');
  });

  it('points a missing binary at the pnpm allowlist, not at node-gyp', () => {
    const { ok, message } = describeNativeState({
      kind: 'binary-missing',
      expected: 'prebuilds/darwin-arm64/pty.node',
    });

    expect(ok).toBe(false);
    expect(message).toContain('prebuilds/darwin-arm64/pty.node');
    expect(message).toContain('pnpm.onlyBuiltDependencies');
  });

  it('tells you to install when the module is absent entirely', () => {
    const { ok, message } = describeNativeState({ kind: 'module-missing' });

    expect(ok).toBe(false);
    expect(message).toContain('pnpm.onlyBuiltDependencies');
    expect(message).toContain('pnpm install');
  });

  it('passes an unrecognised load failure through rather than guessing', () => {
    const { ok, message } = describeNativeState({
      kind: 'load-failed',
      detail: 'Symbol not found: _uv_pipe_open',
    });

    expect(ok).toBe(false);
    expect(message).toContain('Symbol not found: _uv_pipe_open');
  });
});

describe('parseAbiError', () => {
  it('extracts both ABI numbers from a real ERR_DLOPEN_FAILED message', () => {
    // Captured shape of Node's actual error text.
    const stderr = [
      'Error: The module \'/repo/node_modules/node-pty/build/Release/pty.node\'',
      'was compiled against a different Node.js version using',
      'NODE_MODULE_VERSION 127. This version of Node.js requires',
      'NODE_MODULE_VERSION 148. Please try re-compiling or re-installing',
    ].join('\n');

    expect(parseAbiError(stderr)).toEqual({ builtAbi: 127, electronAbi: 148 });
  });

  it('returns null for an error that is not an ABI mismatch', () => {
    expect(parseAbiError('Error: Cannot find module \'node-pty\'')).toBeNull();
  });

  it('returns null when only one ABI number is present', () => {
    expect(parseAbiError('requires NODE_MODULE_VERSION 148')).toBeNull();
  });
});

describe('parseAbiOutput', () => {
  it('reads a bare integer', () => {
    expect(parseAbiOutput('148\n')).toBe(148);
  });

  it('ignores the Electron download notice postinstall prints ahead of it', () => {
    // The regression that shipped "ABI NaN" in the success line.
    expect(parseAbiOutput('Downloading Electron binary...\n148\n')).toBe(148);
  });

  it('returns null rather than NaN when there is no number to read', () => {
    expect(parseAbiOutput('Downloading Electron binary...')).toBeNull();
    expect(parseAbiOutput('')).toBeNull();
  });
});

describe('describeNativeState with an unknown ABI', () => {
  it('drops the number instead of printing "ABI null"', () => {
    const { ok, message } = describeNativeState({ kind: 'ok', electronAbi: null });

    expect(ok).toBe(true);
    expect(message).toBe(
      'node-pty loads under Electron and spawn-helper is executable.',
    );
  });
});

describe('isExecutable', () => {
  it('accepts any of the three executable bits', () => {
    expect(isExecutable(0o755)).toBe(true);
    expect(isExecutable(0o700)).toBe(true);
    expect(isExecutable(0o111)).toBe(true);
  });

  it('rejects the 0644 mode node-pty actually publishes', () => {
    expect(isExecutable(0o644)).toBe(false);
  });
});

describe('prebuildDir', () => {
  it('is <platform>-<arch>, matching node-pty’s layout', () => {
    expect(prebuildDir('darwin', 'arm64')).toBe('prebuilds/darwin-arm64');
    expect(prebuildDir('linux', 'x64')).toBe('prebuilds/linux-x64');
  });
});
