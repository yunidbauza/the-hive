import { existsSync } from 'node:fs';
import path from 'node:path';
import posix from 'node:path/posix';

import { extractFile, listPackage } from '@electron/asar';

import {
  collectDependencyClosure,
  describeClosure,
  findUnsatisfiedPeers,
} from './module-closure.mjs';

/**
 * Prove the packed bundle can require everything it requires (electron-builder
 * `afterPack`).
 *
 * ## Why the artifact and not the repo
 *
 * `tests/scripts/module-closure.test.ts` runs the same walk over the repo's
 * `node_modules` on every commit, and that catches the peer-dependency trap
 * that cost v0.10.0 its launch. It cannot catch the other half: whether the
 * packager actually *put* the closure in the bundle. `files`, `asarUnpack` and
 * electron-builder's own pruning all sit between "declared" and "shipped", and
 * only the `.app` knows which side of that gap a module ended up on.
 *
 * So this reads `app.asar` itself — the exact file the dmg carries — and walks
 * it the way Node will at runtime. It runs in `afterPack`, which is **before**
 * the dmg and zip exist and long before anything is uploaded, so a build that
 * would crash on launch fails here instead of reaching a release.
 *
 * ## What it does not claim
 *
 * A manifest walk sees the module graph, not the code. A `require()` of a
 * package nobody declared is invisible to it, and impossible in practice:
 * `externalizeDepsPlugin` externalises exactly `dependencies` and bundles
 * everything else, so an undeclared import fails the *build*, not the launch.
 */

/** Where `pnpm desktop:dist` leaves the bundle. */
const DEFAULT_APP = 'dist/mac-arm64/The Hive.app';

/**
 * Read manifests straight out of the archive.
 *
 * The entry list is taken once and turned into a set, because the walk asks
 * "is there a package.json here" for every ancestor of every package and
 * `listPackage` is not free. `extractFile` transparently reads the unpacked
 * copy for anything under `asarUnpack`, which is how `node-pty` — the one
 * module that lives outside the archive — is still seen by this walk.
 */
function asarIo(archive) {
  const entries = new Set(listPackage(archive));
  const cache = new Map();

  return {
    root: '/',
    path: posix,
    readManifest(dir) {
      if (cache.has(dir)) return cache.get(dir);

      const file = posix.join(dir, 'package.json');
      let manifest = null;
      if (entries.has(file)) {
        try {
          manifest = JSON.parse(extractFile(archive, file.slice(1)).toString('utf8'));
        } catch {
          // A package.json that will not parse is a broken package, and the
          // walk should say so by treating it as absent rather than by
          // throwing something with no path in it.
          manifest = null;
        }
      }

      cache.set(dir, manifest);
      return manifest;
    },
    has: (file) => entries.has(file),
  };
}

/**
 * The verdict for one archive: unresolved modules, unsatisfied peers, and
 * whether the entry point named by `main` is even in there.
 */
export function verifyArchive(archive) {
  const io = asarIo(archive);
  const closure = collectDependencyClosure(io);
  const unsatisfiedPeers = findUnsatisfiedPeers(closure);

  const manifest = io.readManifest('/');
  const entry = posix.join('/', manifest.main ?? '');
  const unresolved = [...closure.unresolved];
  if (!io.has(entry)) {
    unresolved.push({ name: manifest.main, from: 'the "main" field of package.json' });
  }

  const { ok, message } = describeClosure({
    unresolved,
    unsatisfiedPeers,
    subject: 'app.asar',
  });

  return { ok, message, packageCount: closure.packages.length };
}

/** `dist/mac-arm64/The Hive.app` → the archive inside it. */
function archiveFor(target) {
  if (target.endsWith('.asar')) return target;
  return path.join(target, 'Contents', 'Resources', 'app.asar');
}

function run(target) {
  const archive = archiveFor(target);
  if (!existsSync(archive)) {
    throw new Error(`No app.asar at ${archive} — nothing to verify.`);
  }

  const { ok, message, packageCount } = verifyArchive(archive);
  if (!ok) {
    throw new Error(`Packaged module check failed for ${archive}:\n${message}`);
  }

  console.log(`  • ${packageCount} packages packed, every module resolves  ${archive}`);
}

/** electron-builder `afterPack`. */
export default async function verifyPackagedModules(context) {
  run(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
}

// Also runnable on its own: `pnpm verify:bundle [path to .app or .asar]`, which
// is how a shipped release can be checked without rebuilding it.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    run(process.argv[2] ?? DEFAULT_APP);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
