import adhocSign from './adhoc-sign.mjs';
import verifyPackagedModules from './verify-packaged-modules.mjs';

/**
 * The `afterPack` hook, which is now two jobs (electron-builder takes one).
 *
 * Order is load-bearing. The module check is a *gate*: if the bundle is missing
 * something it will require at launch, there is no point signing it, and the
 * build should fail while the only artifact is a directory nobody has seen. Ad
 * hoc signing comes second and only ever runs on a bundle worth shipping.
 *
 * Each half stays in its own file with its own reasoning. This exists because
 * `afterPack:` in `electron-builder.yml` is a single path, not because the two
 * have anything to do with each other.
 */
export default async function afterPack(context) {
  await verifyPackagedModules(context);
  await adhocSign(context);
}
