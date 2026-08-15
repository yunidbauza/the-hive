import { execFileSync } from 'node:child_process';

/**
 * Give the packaged bundle a real ad-hoc signature (electron-builder `afterPack`).
 *
 * ## What is wrong without it
 *
 * `mac.identity: null` tells electron-builder not to look for a Developer ID,
 * and it then does not sign at all. What is left is the signature Electron's own
 * executable already carried — and reading it back is instructive:
 *
 *     Identifier=Electron
 *     Signature=adhoc, linker-signed
 *     Sealed Resources=none
 *
 * Three problems in three lines. The bundle identifies itself as *Electron*
 * rather than as this app. `linker-signed` is the minimal signature the linker
 * emits so Apple Silicon will consent to execute the file at all — it covers the
 * Mach-O, nothing else. And `Sealed Resources=none` means the `.app` around it
 * is not covered by any signature, so the bundle has no integrity at all: the
 * Info.plist, the framework, the asar and the unpacked `node-pty` are all
 * outside it.
 *
 * That is not a signed app; it is an unsigned app containing one signed file.
 * Gatekeeper treats it as such, TCC has no stable identity to attach a
 * permission grant to, and `codesign --verify` fails on the bundle.
 *
 * ## What this does and does not buy
 *
 * `codesign --force --deep --sign -` produces a genuine ad-hoc *bundle*
 * signature: sealed resources, the identifier from `CFBundleIdentifier`, and a
 * bundle that verifies. That is worth having on its own.
 *
 * It does **not** make the app self-updating, and it is important not to imply
 * otherwise. Squirrel.Mac verifies an update against the running app's
 * *designated requirement*, and for an ad-hoc signature the designated
 * requirement is its `cdhash` — a hash of that exact build. Version 0.1.1 has a
 * different cdhash from 0.1.0 by construction, so it cannot satisfy 0.1.0's
 * requirement, and no amount of correct ad-hoc signing changes that. Only a
 * certificate-based identity produces a requirement that survives a rebuild.
 *
 * The app knows this and routes around it: `electron/main/updates/capability.ts`
 * probes the signature, attempts the swap anyway when it might work, and
 * degrades to the download page the moment macOS refuses. See
 * `docs/packaging-and-updates.md`.
 */
/**
 * Is a real signing identity going to be used for this build?
 *
 * Asked because this hook now has to **stand aside**, and asked from the same
 * inputs electron-builder itself uses rather than from a flag someone has to
 * remember to set:
 *
 * - `CSC_IDENTITY_AUTO_DISCOVERY=false` is the explicit "do not sign" switch,
 *   and it wins over everything below.
 * - `CSC_LINK` is how CI supplies a certificate that is not in the keychain
 *   yet. It is checked *before* the keychain because at the moment this hook
 *   runs the import may not have happened.
 * - Otherwise the keychain is asked directly, which is exactly what
 *   electron-builder's auto-discovery does.
 *
 * Answering "no" wrongly would ad-hoc sign a bundle that is about to be signed
 * properly — wasted work rather than damage, since `afterPack` runs *before*
 * electron-builder signs and the real signature would overwrite this one. The
 * reason to get it right anyway is honesty: a build log that says "ad-hoc
 * signed" about a Developer ID build teaches the reader something false, and
 * this project's update path is built on knowing which signature it has.
 */
function developerIdAvailable() {
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return false;
  if (process.env.CSC_LINK) return true;

  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    return out.includes('Developer ID Application');
  } catch {
    // No `security`, or a keychain that cannot be read. Neither is an error
    // worth failing a build over: it simply means nothing was found, which is
    // the same answer as an empty keychain.
    return false;
  }
}

export default async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  if (developerIdAvailable()) {
    console.log('  • Developer ID present — skipping the ad-hoc signature');
    return;
  }

  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;

  /**
   * `--deep` is deprecated for distribution signing and correct here.
   *
   * Apple's objection to it is that it applies *one* set of options to nested
   * code that often needs different entitlements per component. With an ad-hoc
   * identity and no entitlements there is nothing to get wrong, and the
   * alternative — walking the framework, the three helper apps and the
   * unpacked native module by hand — would be a list that goes stale the next
   * time Electron changes its bundle layout.
   */
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], {
    stdio: 'inherit',
  });

  // Verified immediately, because a signature that did not take is invisible
  // until something else refuses the app for a reason that names neither.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], {
    stdio: 'inherit',
  });

  console.log(`  • ad-hoc signed and verified  ${app}`);
}
