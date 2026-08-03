/**
 * Types for `check-native-abi.mjs`.
 *
 * The script itself stays `.mjs` because `predesktop:dev` and `postinstall`
 * run it with bare `node`, before any build step exists to compile a `.ts`.
 * This declaration is what lets its pure half be unit-tested from the
 * TypeScript test tree (story 084).
 */

export type NativeState =
  | { kind: 'ok'; electronAbi: number | null }
  | { kind: 'module-missing' }
  | { kind: 'binary-missing'; expected: string }
  | { kind: 'abi-mismatch'; builtAbi: number; electronAbi: number }
  | { kind: 'helper-not-executable'; helperPath: string }
  | { kind: 'load-failed'; detail: string };

export function describeNativeState(state: NativeState): {
  ok: boolean;
  message: string;
};

export function parseAbiError(
  stderr: string,
): { builtAbi: number; electronAbi: number } | null;

export function isExecutable(mode: number): boolean;

export function parseAbiOutput(stdout: string): number | null;

export function prebuildDir(platform?: string, arch?: string): string;
