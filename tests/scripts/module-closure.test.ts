import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import * as posix from 'node:path/posix';

import { describe, expect, it } from 'vitest';

import {
  collectDependencyClosure,
  describeClosure,
  findUnsatisfiedPeers,
  type ClosureIo,
} from '../../scripts/module-closure.mjs';

/**
 * The walker itself, against hand-built trees.
 *
 * A fake tree is the right instrument here and only here: what is under test is
 * the *resolution rule*, and the rule's interesting cases (a nested copy
 * shadowing a hoisted one, a peer that resolves but was never packed) are
 * awkward to arrange in a real `node_modules` and trivial to state as data.
 * The real trees are asserted below and in `tests/package-manifest.test.ts`.
 */
function fakeIo(tree: Record<string, object>): ClosureIo {
  return {
    root: '/app',
    path: posix,
    readManifest: (dir) => (tree[dir] ? (tree[dir] as Record<string, unknown>) : null),
  };
}

describe('collectDependencyClosure', () => {
  it('walks dependencies transitively from the root manifest', () => {
    const { names, unresolved } = collectDependencyClosure(
      fakeIo({
        '/app': { dependencies: { a: '^1' } },
        '/app/node_modules/a': { name: 'a', version: '1.0.0', dependencies: { b: '^1' } },
        '/app/node_modules/b': { name: 'b', version: '1.0.0' },
      }),
    );

    expect([...names].sort()).toEqual(['a', 'b']);
    expect(unresolved).toEqual([]);
  });

  it('reports a dependency that is not in the tree, and blames the package that wants it', () => {
    const { unresolved } = collectDependencyClosure(
      fakeIo({
        '/app': { dependencies: { a: '^1' } },
        '/app/node_modules/a': { name: 'a', version: '1.2.3', dependencies: { gone: '^1' } },
      }),
    );

    expect(unresolved).toEqual([{ name: 'gone', from: 'a@1.2.3' }]);
  });

  it('prefers a nested copy over the hoisted one, which is Node’s own rule', () => {
    const { packages } = collectDependencyClosure(
      fakeIo({
        '/app': { dependencies: { a: '^1' } },
        '/app/node_modules/a': { name: 'a', version: '1.0.0', dependencies: { dep: '^2' } },
        '/app/node_modules/a/node_modules/dep': { name: 'dep', version: '2.0.0' },
        '/app/node_modules/dep': { name: 'dep', version: '1.0.0' },
      }),
    );

    expect(packages.find((p) => p.name === 'dep')?.version).toBe('2.0.0');
  });

  it('never climbs above the root, so a stray module outside the app is not counted', () => {
    const { unresolved } = collectDependencyClosure(
      fakeIo({
        '/app': { dependencies: { a: '^1' } },
        '/app/node_modules/a': { name: 'a', version: '1.0.0', dependencies: { outside: '^1' } },
        '/node_modules/outside': { name: 'outside', version: '1.0.0' },
      }),
    );

    expect(unresolved).toEqual([{ name: 'outside', from: 'a@1.0.0' }]);
  });

  it('follows an optional dependency that is present and stays silent about one that is not', () => {
    const { names, unresolved } = collectDependencyClosure(
      fakeIo({
        '/app': { dependencies: { a: '^1' } },
        '/app/node_modules/a': {
          name: 'a',
          version: '1.0.0',
          optionalDependencies: { here: '^1', absent: '^1' },
        },
        '/app/node_modules/here': { name: 'here', version: '1.0.0' },
      }),
    );

    expect(names.has('here')).toBe(true);
    expect(unresolved).toEqual([]);
  });
});

describe('findUnsatisfiedPeers', () => {
  it('flags a required peer that the packed set does not contain', () => {
    // The v0.10.0 crash in miniature: the peer sits next to its dependent in a
    // pnpm tree and resolves perfectly, and the packager still never packs it.
    const closure = collectDependencyClosure(
      fakeIo({
        '/app': { dependencies: { socket: '^3' } },
        '/app/node_modules/socket': {
          name: 'socket',
          version: '3.0.1',
          peerDependencies: { undici: '^7.0.0' },
        },
        '/app/node_modules/undici': { name: 'undici', version: '7.29.0' },
      }),
    );

    expect(findUnsatisfiedPeers(closure)).toEqual([
      { dependent: 'socket@3.0.1', peer: 'undici', range: '^7.0.0' },
    ]);
  });

  it('accepts a peer that something else in the closure already pulls in', () => {
    const closure = collectDependencyClosure(
      fakeIo({
        '/app': { dependencies: { socket: '^3', undici: '^7' } },
        '/app/node_modules/socket': {
          name: 'socket',
          version: '3.0.1',
          peerDependencies: { undici: '^7.0.0' },
        },
        '/app/node_modules/undici': { name: 'undici', version: '7.29.0' },
      }),
    );

    expect(findUnsatisfiedPeers(closure)).toEqual([]);
  });

  it('ignores a peer the publisher marked optional', () => {
    const closure = collectDependencyClosure(
      fakeIo({
        '/app': { dependencies: { a: '^1' } },
        '/app/node_modules/a': {
          name: 'a',
          version: '1.0.0',
          peerDependencies: { extra: '^1' },
          peerDependenciesMeta: { extra: { optional: true } },
        },
      }),
    );

    expect(findUnsatisfiedPeers(closure)).toEqual([]);
  });
});

describe('describeClosure', () => {
  it('names the module, the package that wants it and the fix', () => {
    const { ok, message } = describeClosure({
      unresolved: [],
      unsatisfiedPeers: [{ dependent: '@slack/socket-mode@3.0.1', peer: 'undici', range: '^7.0.0' }],
      subject: 'app.asar',
    });

    expect(ok).toBe(false);
    expect(message).toBe(
      'undici is a peer dependency of @slack/socket-mode@3.0.1 and is not in app.asar — ' +
        'add "undici": "^7.0.0" to dependencies in package.json, because a peer is never packed for you.',
    );
  });

  it('quotes the runtime error a missing module produces, so the log matches the dialog', () => {
    const { ok, message } = describeClosure({
      unresolved: [{ name: 'undici', from: '@slack/socket-mode@3.0.1' }],
      unsatisfiedPeers: [],
      subject: 'app.asar',
    });

    expect(ok).toBe(false);
    expect(message).toContain(`Cannot find module 'undici'`);
  });

  it('says so plainly when there is nothing wrong', () => {
    const { ok, message } = describeClosure({
      unresolved: [],
      unsatisfiedPeers: [],
      subject: 'app.asar',
    });

    expect(ok).toBe(true);
    expect(message).toBe('Every module app.asar requires is present.');
  });
});

/**
 * The repo's own tree, walked the way electron-builder walks it.
 *
 * This is the guard that runs on every commit. `pnpm test` is in the release
 * workflow's Verify step, so a dependency edge that only a dev tree satisfies
 * now fails before anything is built, let alone published.
 */
describe('this repository', () => {
  const io: ClosureIo = {
    root: process.cwd(),
    readManifest: (dir) => {
      const file = join(dir, 'package.json');
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8'));
    },
    // pnpm's tree is symlinks into `.pnpm/`. Without this the walk climbs to
    // the repo root from every package and sees only the root's dependencies.
    realpath: (dir) => realpathSync(dir),
  };

  it('resolves every production dependency it declares', () => {
    const { unresolved } = collectDependencyClosure(io);
    expect(unresolved).toEqual([]);
  });

  it('declares every required peer dependency of what it ships', () => {
    // v0.10.0 shipped without `undici`, which `@slack/socket-mode` needs and
    // declares as a peer. The app threw `Cannot find module 'undici'` at
    // launch. A peer is satisfied here only by being in the packed set.
    const closure = collectDependencyClosure(io);
    const findings = findUnsatisfiedPeers(closure);

    expect(
      describeClosure({ unresolved: [], unsatisfiedPeers: findings, subject: 'the packed app' })
        .message,
    ).toBe('Every module the packed app requires is present.');
  });
});
