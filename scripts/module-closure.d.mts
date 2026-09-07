/**
 * Types for `module-closure.mjs`.
 *
 * The script stays `.mjs` for the same reason `check-native-abi.mjs` does: it
 * runs under bare `node` from an electron-builder hook, where no build step
 * exists to compile a `.ts`. This declaration is what lets it be unit-tested
 * from the TypeScript test tree.
 */

export interface ClosureIo {
  root: string;
  readManifest: (dir: string) => Record<string, unknown> | null;
  realpath?: (dir: string) => string;
  path?: {
    join: (...parts: string[]) => string;
    dirname: (p: string) => string;
    basename: (p: string) => string;
  };
}

export interface ClosurePackage {
  name: string;
  version: string;
  dir: string;
  peers: Array<{ name: string; range: string }>;
}

export interface Closure {
  packages: ClosurePackage[];
  names: Set<string>;
  unresolved: Array<{ name: string; from: string }>;
}

export interface UnsatisfiedPeer {
  dependent: string;
  peer: string;
  range: string;
}

export function collectDependencyClosure(io: ClosureIo): Closure;

export function findUnsatisfiedPeers(closure: Closure): UnsatisfiedPeer[];

export function describeClosure(input: {
  unresolved: Array<{ name: string; from: string }>;
  unsatisfiedPeers: UnsatisfiedPeer[];
  subject: string;
}): { ok: boolean; message: string };
