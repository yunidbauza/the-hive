/**
 * What a packaged build actually carries, computed the way the packager does.
 *
 * ## The bug this exists to prevent
 *
 * `@slack/socket-mode@3` needs `undici` and declares it as a **peer**
 * dependency, not a dependency. pnpm auto-installs peers, so `pnpm dev`,
 * `pnpm desktop:dev` and every test resolve it and nothing looks wrong.
 * electron-builder collects production modules by walking `dependencies` and
 * `optionalDependencies` only, so it never saw `undici`, never packed it, and
 * v0.10.0 shipped an app that died at launch on
 * `Error: Cannot find module 'undici'` before a single window appeared.
 *
 * A peer dependency is the one edge in the graph that a dev tree satisfies and
 * a packaged tree does not. That is why this walk is deliberately **two
 * passes**, and why the second one is the whole point:
 *
 * 1. Walk `dependencies` from the root manifest, exactly as the packager does.
 *    That set is what lands in `app.asar`.
 * 2. Ask every package in that set whether its required peers are *in* the set.
 *    Anything missing is a module the app will require at runtime and not find.
 *
 * Checking resolvability alone would pass in the repo — pnpm put `undici` right
 * next to `@slack/socket-mode` — which is precisely how this reached a release.
 *
 * ## One walker, two trees
 *
 * The same code runs against the repo's `node_modules` (`pnpm test`, so the
 * failure is seen on the commit that introduces it) and against the packed
 * `app.asar` (`afterPack`, so a release cannot ship without the modules it
 * needs). Both reach it through the small `io` seam below rather than through
 * `node:fs`, because an asar is not a filesystem.
 */

import nodePath from 'node:path';

/**
 * @typedef {object} ClosureIo
 * @property {string} root                       Directory the walk starts and stops at.
 * @property {(dir: string) => object | null} readManifest  `<dir>/package.json`, or null.
 * @property {(dir: string) => string} [realpath]  Resolve symlinks. pnpm's tree is
 *   almost entirely symlinks into `.pnpm/`, and a walk that does not follow them
 *   climbs to the repo root and sees only the *root's* dependencies — every
 *   transitive edge would report as missing. An asar has no symlinks, so it
 *   passes identity.
 * @property {{ join: Function, dirname: Function, basename: Function }} [path]
 *   Path flavour. An asar is always POSIX, whatever the host is.
 */

/**
 * Node's module resolution, minus everything a manifest walk cannot hit.
 *
 * No `exports`, no extensions, no index files: the only question asked here is
 * "which directory does package `name` resolve to from `fromDir`", and the
 * answer is the first `node_modules/<name>` with a `package.json` walking up.
 * Directories already named `node_modules` are skipped as ancestors, which is
 * Node's own rule and the reason a nested copy (`p-queue/node_modules/
 * eventemitter3`) resolves to itself rather than to its parent's.
 */
function resolvePackageDir(name, fromDir, io, path) {
  let dir = fromDir;

  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      if (io.readManifest(candidate)) return candidate;
    }

    if (dir === io.root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Peers a package can live without.
 *
 * `peerDependenciesMeta.optional` is the publisher saying "works fine unless
 * you use the feature that needs this". Treating those as required would flag
 * half of npm.
 */
function requiredPeers(manifest) {
  const meta = manifest.peerDependenciesMeta ?? {};
  return Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => !meta[name]?.optional)
    .map(([name, range]) => ({ name, range }));
}

/**
 * The production closure, as the packager computes it.
 *
 * `optionalDependencies` are followed but never reported missing: a package
 * that lists one is stating it can run without it, and electron-builder prunes
 * the ones that do not apply to the target platform.
 *
 * @param {ClosureIo} io
 * @returns {{
 *   packages: Array<{ name: string, version: string, dir: string, peers: Array<{ name: string, range: string }> }>,
 *   names: Set<string>,
 *   unresolved: Array<{ name: string, from: string }>,
 * }}
 */
export function collectDependencyClosure(io) {
  const path = io.path ?? nodePath;
  const realpath = io.realpath ?? ((dir) => dir);

  const packages = [];
  const names = new Set();
  const unresolved = [];
  const seen = new Set();

  /** @param {string} name @param {string} fromDir @param {string} why */
  function visit(name, fromDir, why) {
    const dir = resolvePackageDir(name, fromDir, io, path);
    if (!dir) {
      // Deduplicated by (name, blamed package): a dependency shared by twelve
      // packages is one problem, not twelve, but the same name missing from two
      // different parents is worth seeing twice.
      if (!unresolved.some((u) => u.name === name && u.from === why)) {
        unresolved.push({ name, from: why });
      }
      return;
    }

    const real = realpath(dir);
    if (seen.has(real)) return;
    seen.add(real);

    const manifest = io.readManifest(dir);
    const label = `${manifest.name ?? name}@${manifest.version ?? '?'}`;

    packages.push({
      name: manifest.name ?? name,
      version: manifest.version ?? '?',
      dir: real,
      peers: requiredPeers(manifest),
    });
    names.add(manifest.name ?? name);

    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      visit(dep, real, label);
    }
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
      if (resolvePackageDir(dep, real, io, path)) visit(dep, real, label);
    }
  }

  const rootManifest = io.readManifest(io.root);
  if (!rootManifest) {
    throw new Error(`No package.json at ${io.root} — nothing to walk.`);
  }
  for (const dep of Object.keys(rootManifest.dependencies ?? {})) {
    visit(dep, io.root, 'package.json dependencies');
  }

  return { packages, names, unresolved };
}

/**
 * Required peers that the closure does not contain.
 *
 * The second pass, and the one that catches the class of bug this file is
 * named after. A peer is satisfied here only by being *in the shipped set* —
 * not by being resolvable from disk, which a pnpm tree always makes it.
 *
 * @param {ReturnType<typeof collectDependencyClosure>} closure
 * @returns {Array<{ dependent: string, peer: string, range: string }>}
 */
export function findUnsatisfiedPeers({ packages, names }) {
  const findings = [];

  for (const pkg of packages) {
    for (const peer of pkg.peers) {
      if (names.has(peer.name)) continue;
      findings.push({
        dependent: `${pkg.name}@${pkg.version}`,
        peer: peer.name,
        range: peer.range,
      });
    }
  }

  return findings;
}

/**
 * The whole verdict as one sentence per problem, and the remediation with it.
 *
 * Kept here rather than at each call site so both callers say the same thing,
 * and asserted verbatim in the tests: a message that drifts into "dependency
 * problem detected" is the failure this file exists to prevent.
 */
export function describeClosure({ unresolved, unsatisfiedPeers, subject }) {
  const problems = [
    ...unresolved.map(
      ({ name, from }) =>
        `${name} is required by ${from} and is not in ${subject} — the app will throw "Cannot find module '${name}'" the moment that code runs.`,
    ),
    ...unsatisfiedPeers.map(
      ({ dependent, peer, range }) =>
        `${peer} is a peer dependency of ${dependent} and is not in ${subject} — add "${peer}": "${range}" to dependencies in package.json, because a peer is never packed for you.`,
    ),
  ];

  if (problems.length === 0) {
    return { ok: true, message: `Every module ${subject} requires is present.` };
  }

  return { ok: false, message: problems.join('\n') };
}
