/**
 * What the app knows about its own newer self.
 *
 * Types and constants only — both processes import this, and the renderer
 * imports it type-only, so nothing in `electron-updater` can reach the bundle.
 *
 * ## Why "capability" is a first-class idea here
 *
 * On every other platform this file would be smaller. A packaged Windows or
 * Linux build downloads a newer version and installs it, and the only question
 * is whether the network answered.
 *
 * macOS asks a second question first. Electron's `autoUpdater` is Squirrel.Mac,
 * and Squirrel.Mac verifies an update against the running app's **designated
 * requirement** before it will swap anything.
 *
 * For a Developer ID signature that requirement names the certificate, and it
 * holds across every build you ever sign. For an **ad-hoc** signature — which is
 * what this app has, because no Developer ID exists to sign it with — the
 * designated requirement is the binary's `cdhash`:
 *
 *     $ codesign -d -r- "The Hive.app"
 *     # designated => cdhash H"4070118b4071c5c37facee2a4e06c36b9a79dd4c"
 *
 * A new version has a different cdhash by construction, so it can never satisfy
 * the old one's requirement. **Measured, not assumed** — 0.1.0 was published,
 * then 0.1.1, and the packaged 0.1.0 was driven through the whole flow:
 *
 *     [Error: Code signature at URL file:///…/The Hive.app/ did not pass
 *      validation: code failed to satisfy specified code requirement(s)]
 *       code: -1, domain: 'SQRLCodeSignatureErrorDomain'
 *
 * The download and the staging both *succeed* — that is the trap. Squirrel
 * validates at the swap, not at the download, so an app that trusted
 * `update-downloaded` would tell the user an update was ready, take the restart,
 * and come back on the old version with nothing to explain it.
 *
 * So {@link UpdateCapability} sends ad-hoc builds down the **manual** path from
 * the start: no 130MB download that was never going to install. The self-install
 * path stays for the day a Developer ID appears, and {@link demoteToManual}
 * remains the runtime safety net for a signed build refused for some other
 * reason.
 */

/** Where a user goes when the app cannot update itself. */
export const RELEASES_URL = 'https://github.com/yunidbauza/the-hive/releases';

/** The release page for one specific version. */
export const releaseUrlFor = (version: string): string =>
  `${RELEASES_URL}/tag/v${version.replace(/^v/, '')}`;

/**
 * Why this build can or cannot replace itself in place.
 *
 * `reason` is always populated, including on the happy path, because it is
 * rendered in the Settings pane. A user who wonders why their app sends them to
 * a web page deserves the sentence, not a disabled button.
 */
export interface UpdateCapability {
  /**
   * Whether asking the server is meaningful at all.
   *
   * False for an unpackaged run: `electron-updater` refuses outright there, and
   * there is no bundle to replace even if it did. Separate from `mode` because
   * "cannot check" and "can check but cannot install" are different sentences
   * to show a user, and collapsing them produces the worst one for both.
   */
  canCheck: boolean;
  /**
   * `self-install` — download and swap the bundle, then relaunch.
   * `manual` — open the release page and let the user do it.
   */
  mode: 'self-install' | 'manual';
  /** One sentence, shown to the user. Never a stack trace. */
  reason: string;
}

/**
 * Where the app is in the update cycle.
 *
 * `unsupported` is distinct from `error`: it means this build was never going
 * to be able to check — a development run, most often — and saying "error"
 * about it would send someone looking for a fault that is not there.
 */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unsupported';

/** Everything a consumer needs to render the update surface. */
export interface UpdateStatus {
  state: UpdateState;
  /**
   * Whether a check has actually completed since launch.
   *
   * Distinct from `state: 'idle'`, and the distinction is not pedantic: idle is
   * *also* the state before the first check has run, thirty seconds of every
   * launch. Rendering that as "up to date" tells the user something the app has
   * not established — and it was doing exactly that, observed in Settings with
   * a newer release already published.
   *
   * A boolean rather than a timestamp because nothing displays *when*; the pane
   * only needs to tell "nothing newer exists" from "nobody has looked".
   */
  checked: boolean;
  /** What is running now. `app.getVersion()`. */
  currentVersion: string;
  /** What is on the server, when something newer exists. */
  availableVersion: string | null;
  /** 0–100 while `downloading`, otherwise null. */
  percent: number | null;
  capability: UpdateCapability;
  /** The page to send someone to for `availableVersion`, or the releases index. */
  releaseUrl: string;
  /** Populated only in `error`. One line, already made human. */
  error: string | null;
}

/** The status of a build that has not looked yet. */
export function idleUpdateStatus(
  currentVersion: string,
  capability: UpdateCapability,
): UpdateStatus {
  return {
    state: capability.canCheck ? 'idle' : 'unsupported',
    checked: false,
    currentVersion,
    availableVersion: null,
    percent: null,
    capability,
    releaseUrl: RELEASES_URL,
    error: null,
  };
}

/**
 * How often a running app looks, in milliseconds.
 *
 * Six hours. The check is one HTTPS request for a small YAML file, so the cost
 * is not the concern — the concern is that an update is not urgent, and an app
 * that notices a release within a working day has noticed it soon enough. The
 * first check runs shortly after launch, which is when most people would think
 * to ask anyway.
 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How long after launch the first check waits.
 *
 * Not zero. Launch is the busiest moment this process has — window creation,
 * config read, the pty host's first fork — and a network round trip racing all
 * of that buys nothing. Thirty seconds is invisible to a user and well clear of
 * the startup burst.
 */
export const UPDATE_FIRST_CHECK_DELAY_MS = 30_000;
