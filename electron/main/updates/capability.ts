import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { app } from 'electron';

import type { UpdateCapability } from '@shared/update-contract';

/**
 * Can this bundle replace itself?
 *
 * The answer decides whether the Inbox row installs an update or sends the user
 * to a download page, so it is worth getting from evidence rather than from an
 * assumption compiled in at build time.
 *
 * ## What is actually being asked
 *
 * Electron's macOS `autoUpdater` is Squirrel.Mac, and Squirrel.Mac will not swap
 * a bundle it cannot verify. The check it performs is a code-signature check,
 * and it fails *late* — after the download, at the moment of the swap — with an
 * error that reads like a network fault. An app that cannot tell the difference
 * would burn a hundred megabytes and then tell the user to check their
 * connection.
 *
 * So the signature is read up front, with `codesign`, and three outcomes are
 * distinguished where a boolean would flatten them into one:
 *
 * | What `codesign` says | Verdict | Why |
 * | --- | --- | --- |
 * | `Authority=Developer ID Application: …` | self-install | The case Squirrel was designed for. |
 * | `Signature=adhoc` | manual | Cannot satisfy its own successor's requirement. Measured — see below. |
 * | not signed / command failed | manual | Squirrel has nothing to check. |
 *
 * ## Why ad-hoc is refused up front rather than attempted
 *
 * An earlier cut of this file let ad-hoc *try*, on the reasoning that reports in
 * the wild disagree and only a real update settles it. A real update settled it.
 *
 * 0.1.0 and 0.1.1 were published, and the packaged 0.1.0 was driven through the
 * whole flow. The check found 0.1.1, the 130MB zip downloaded, Squirrel staged
 * it, `update-downloaded` fired and the app reported the update **ready** — and
 * then the swap failed:
 *
 *     [Error: Code signature at URL file:///…/The Hive.app/ did not pass
 *      validation: code failed to satisfy specified code requirement(s)]
 *       code: -1, domain: 'SQRLCodeSignatureErrorDomain'
 *
 * The cause is structural, not a misconfiguration. An ad-hoc bundle's designated
 * requirement is its own `cdhash` (`codesign -d -r-` says so out loud), and the
 * successor has a different one by construction. No ad-hoc build can ever
 * satisfy its predecessor's requirement.
 *
 * So the cost of "attempt and demote" is not one cheap failure — it is a 130MB
 * download and a **false promise of readiness** every session, on a path that
 * cannot ever work. Manual from the start is the honest classification, and the
 * self-install path is still here in full for the day a Developer ID appears.
 */

const run = promisify(execFile);

/** Everything the probe touches, injected so a test needs no bundle. */
interface CapabilityProbeDeps {
  packaged: boolean;
  platform: NodeJS.Platform;
  /** The `.app` bundle, or whatever `codesign` should be pointed at. */
  bundlePath: string;
  /** Answers with `codesign`'s combined output, or throws if it failed. */
  codesign: (bundlePath: string) => Promise<string>;
}

/**
 * `codesign` writes its report to **stderr**, not stdout.
 *
 * A detail worth pinning down in code rather than rediscovering: reading
 * `stdout` here returns the empty string for a perfectly well-signed bundle,
 * and the probe would conclude "unsigned" about every app it was ever pointed
 * at. Both streams are concatenated so the parse cannot care.
 */
async function readSignature(bundlePath: string): Promise<string> {
  const { stdout, stderr } = await run('codesign', [
    '--display',
    '--verbose=2',
    bundlePath,
  ]);
  return `${stdout}\n${stderr}`;
}

function defaultProbeDeps(): CapabilityProbeDeps {
  return {
    packaged: app.isPackaged,
    platform: process.platform,
    /**
     * Up three levels from the executable.
     *
     * `app.getPath('exe')` inside a packaged mac app is
     * `…/The Hive.app/Contents/MacOS/The Hive`, and `codesign` must be handed
     * the `.app`, not the Mach-O inside it — pointed at the executable it
     * reports on that file's own signature, which is not the thing Squirrel
     * validates.
     */
    bundlePath: path.resolve(app.getPath('exe'), '..', '..', '..'),
    codesign: readSignature,
  };
}

export async function probeUpdateCapability(
  deps: CapabilityProbeDeps = defaultProbeDeps(),
): Promise<UpdateCapability> {
  if (!deps.packaged) {
    return {
      canCheck: false,
      mode: 'manual',
      reason:
        'This is a development run. Only an installed copy of the app can update itself.',
    };
  }

  if (deps.platform !== 'darwin') {
    return {
      canCheck: true,
      mode: 'self-install',
      reason: 'Updates install themselves and the app restarts.',
    };
  }

  let signature: string;
  try {
    signature = await deps.codesign(deps.bundlePath);
  } catch (cause) {
    /**
     * A failed `codesign` is not an app error, and must not be raised as one.
     *
     * The command is absent on a machine without the Command Line Tools, and it
     * exits non-zero for an unsigned bundle. Both mean the same thing for this
     * decision — nothing here can be verified — and neither is worth an error
     * dialog. The manual path still works perfectly.
     */
    return {
      canCheck: true,
      mode: 'manual',
      reason: `This copy has no readable code signature, so macOS will not let it replace itself. Updates open the download page instead (${String(cause)
        .split('\n')[0]
        .trim()}).`,
    };
  }

  if (/Authority=Developer ID Application/.test(signature)) {
    return {
      canCheck: true,
      mode: 'self-install',
      reason: 'Signed with a Developer ID. Updates install themselves.',
    };
  }

  if (/Signature=adhoc/.test(signature)) {
    return {
      canCheck: true,
      mode: 'manual',
      reason:
        'This copy is ad-hoc signed rather than signed with an Apple Developer ID, so macOS will not let a new version replace it in place. Updates open the download page instead.',
    };
  }

  return {
    canCheck: true,
    mode: 'manual',
    reason:
      'This copy is not code signed, so macOS will not let it replace itself. Updates open the download page instead.',
  };
}

/**
 * The demotion, applied after an attempt proved the probe optimistic.
 *
 * Reachable for a build the probe passed — a Developer ID one refused for some
 * other reason — and it is the reason `install()` awaits its engine rather than
 * firing and forgetting. Squirrel validates at the *swap*, long after the
 * download reported success, so a refusal that is not caught here is an app that
 * promises a restart and comes back on the old version saying nothing.
 */
export function demoteToManual(
  capability: UpdateCapability,
  cause: string,
): UpdateCapability {
  return {
    canCheck: capability.canCheck,
    mode: 'manual',
    reason: `macOS refused to install the update in place, so updates now open the download page (${cause}).`,
  };
}
