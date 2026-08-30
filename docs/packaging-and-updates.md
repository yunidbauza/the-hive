# Packaging and updates

How The Hive becomes something you install, how a new version gets published,
and how a running copy finds out about it.

Load this when working on `electron-builder.yml`, `.github/workflows/release.yml`,
`electron/main/updates/**`, or anything to do with the app's version or name.

## Cutting a release

```bash
pnpm version minor        # writes package.json and creates the tag v0.2.0
git push --follow-tags
```

The tag is the trigger; `package.json`'s version is the source of truth.
`pnpm version` writes both in one step, which is the only reason they cannot
disagree — electron-builder reads the version out of `package.json` and never
looks at the tag.

CI then runs `lint`, `type-check` and `test` before it builds anything, and
publishes three assets to a GitHub Release:

| Asset | For |
| --- | --- |
| `The Hive-<v>-arm64.dmg` | A human downloading the app. |
| `The Hive-<v>-arm64-mac.zip` | **The updater.** Squirrel.Mac swaps a zip, never a dmg. |
| `latest-mac.yml` | How a running app learns a newer version exists, and its SHA-512. |

**Never move a published tag.** `latest-mac.yml` pins a checksum per asset, so
re-cutting a release under the same tag fails the integrity check on any client
that is mid-download. `workflow_dispatch` exists for rebuilds.

### The download badge counts dmgs, and only dmgs

That table is also why the README's badge is not the obvious one. GitHub counts
an asset download on **every** GET, including the updater's own — and the
updater fetches `latest-mac.yml` on each check. Shields'
`github/downloads/<owner>/<repo>/total` sums every asset of every release, so it
reports mostly robot traffic: at v0.7.1 it read **165**, of which **121** were
manifest polls and only **9** were installers.

The dmg is the one asset with no machine reason to be fetched — Squirrel swaps a
zip and never touches it — so counting dmgs alone gives a number that means
something. It undercounts anyone who takes the zip by hand, which is the right
way to be wrong: a floor, not a guess.

Shields cannot compute that itself. It matches asset names **exactly**, with no
globbing, and electron-builder puts the version in every filename — so there is
no static shields URL that sums dmgs across releases.
`.github/workflows/downloads-badge.yml` does the sum daily and parks it in a
gist that shields reads as an endpoint badge. It needs two things it cannot
create for itself, both one-time:

| Setting | Value |
| --- | --- |
| `DOWNLOADS_GIST_ID` (repo variable) | the gist's id, also visible in the README's badge URL |
| `GIST_TOKEN` (repo secret) | a PAT with `gist` scope — `GITHUB_TOKEN` cannot write a gist at any permission level |

A gist rather than a file in this repo, deliberately: the job runs daily, and a
committed counter would interleave bot commits with real history on `main`.

### Who publishes the release, and why it is not electron-builder

**electron-builder runs two publishers concurrently, and each does a
check-then-create on the GitHub release.** That single fact caused two
different production failures, so the workflow now takes the decision away from
it entirely.

The first symptom was duplicates. With the provider's `draft` default, both
publishers created a release — drafts have no tag until published, so GitHub
cannot dedupe them — and the assets split across the two.

Switching to `releaseType: release` replaced that with something worse. Now the
loser's create is rejected and **throws**:

```
• publishing  publisher=Github …               (twice, 8ms apart)
• creating GitHub release  reason=release doesn't exist  tag=v0.1.4
• creating GitHub release  reason=release doesn't exist  tag=v0.1.4
HttpError: 422 … {"code":"already_exists","field":"tag_name"}
```

The throw aborts the publish *after* the dmg and zip have uploaded and *before*
`latest-mac.yml` does. The result is a release with no `latest-mac.yml` sitting
at the top of the list as `latest` — and since that is the only file the updater
reads, **every installed copy's update check 404s**. v0.1.4 shipped exactly that
and had to be deleted by hand.

So the sequence is now:

| Step | Who | What |
| --- | --- | --- |
| 1 | workflow | Create the release **as a draft**, before the build |
| 2 | electron-builder | Upload dmg, zip, `latest-mac.yml` into it (`releaseType: draft` — it creates nothing and flips nothing) |
| 3 | workflow | Assert `latest-mac.yml` is present, then publish (`--draft=false --latest`) |
| 4 | workflow | Tidy: keep the release carrying `latest-mac.yml`, delete any other for this tag |

Two properties fall out of that, and both are the point:

- **Nothing races**, because `reason=release doesn't exist` is never true.
- **A failed build cannot break a running app.** What it leaves behind is a
  draft — invisible to the updater and to `releases/latest` — and step 4 sweeps
  it up. The window in which an incomplete release is visible is zero, not
  "short".

Step 4's rule is worth stating on its own, because it is what makes every
failure mode converge: *keep exactly the release that carries `latest-mac.yml`,
delete every other release for this tag.* A release without that file cannot
serve an update, so it is never worth keeping — and a good release from an
earlier run is never at risk, because it has the file.

## What is in the bundle, and one thing that is not

`asarUnpack` pulls `node-pty` out of the archive. This is not an optimisation —
it is the difference between a working app and one that opens no terminals.
`node-pty` *spawns* a helper executable by path, and a path inside `app.asar` is
not a path `posix_spawn` can execute: asar is a virtual filesystem Electron's
`fs` shims understand and the kernel does not. Packed, the app launches
perfectly and throws `posix_spawnp failed` the first time anyone opens a
terminal.

Unpacking also preserves the executable bit, which matters because the published
`node-pty` tarball ships `spawn-helper` at `0644`. `scripts/check-native-abi.mjs
--fix` repairs that at install time — so it must run *before* packaging, which
is why CI's build step comes after a plain `pnpm install` rather than an
`--ignore-scripts` one.

## The app's name

The screenshot that started this: the menu bar read **Electron**, and the
submenu read **About the-hive**. Those are two different bugs.

| What you see | Where it comes from | Fixed by |
| --- | --- | --- |
| Leftmost menu title | `CFBundleName` in the **running bundle's** `Info.plist` | `productName` in `electron-builder.yml` |
| `About …`, `Quit …` | `app.getName()`, falling back to `package.json`'s `name` | `app.setName('The Hive')` |

`app.setName` cannot fix the first. Under `pnpm desktop:dev` the running bundle
is `node_modules/electron/dist/Electron.app`, and macOS reads that title from
the bundle before any JavaScript runs. **Dev will always say `Electron`, and the
packaged app says `The Hive`.** Patching Electron's `Info.plist` from a
postinstall would make dev *look* right while changing nothing that ships; it is
deliberately not done.

`setName` moves `userData`, so `electron/main/index.ts` pins the development
path back to `the-hive`. That keeps the encrypted Jira credential and the window
state where they already are, and — more usefully — keeps a development run and
the installed app as two separate instances that can run side by side. Sharing
one `userData` would make `requestSingleInstanceLock` treat them as the same app.

## Updating

Two entry points, one code path, two ways of answering:

- **Background** — thirty seconds after launch, then every six hours. Silent
  when there is nothing. Raises an `app.update_available` Inbox row when there
  is, keyed on the *version* so six-hourly checks cannot re-announce one release.
- **"Check for Updates…"** (app menu, and the button in Settings → Advanced) —
  a human asked, so every outcome gets a dialog, including "You're up to date".
  A found release gets a confirm dialog rather than an Inbox row; the user is
  right there.

Nothing downloads without a yes (`autoDownload: false`) and nothing installs
without a second one (`autoInstallOnAppQuit: false`). The second flag matters
more than it looks: left at its default, an update the user declined would swap
itself in at the next quit — including a quit caused by a crash.

### The ad-hoc signature problem

**Historically the load-bearing constraint. It is solved by the Developer ID
setup described in "Signing and notarization" below — this section is kept
because it explains why the update code is shaped the way it is, and because a
build made without a certificate still lands here.**

The bundle is ad-hoc signed (`scripts/adhoc-sign.mjs`). Ad-hoc is the floor
rather than a choice: Apple Silicon refuses to execute an unsigned binary at all.

Squirrel.Mac — what Electron's `autoUpdater` is, and what `electron-updater`
drives on macOS — verifies an update against the running app's **designated
requirement**. For a Developer ID that names the certificate and holds across
every build you ever sign. For an ad-hoc signature it is the binary's cdhash:

```
$ codesign -d -r- "The Hive.app"
# designated => cdhash H"4070118b4071c5c37facee2a4e06c36b9a79dd4c"
```

A successor has a different cdhash by construction, so it can never satisfy its
predecessor's requirement.

**This was measured, not reasoned about.** 0.1.0 and 0.1.1 were published and the
packaged 0.1.0 was driven through the whole flow. The check found 0.1.1, the
130MB zip downloaded, Squirrel staged it, `update-downloaded` fired, the app
reported the update **ready** — and the swap failed:

```
[Error: Code signature at URL file:///…/The Hive.app/ did not pass validation:
 code failed to satisfy specified code requirement(s)]
  code: -1, domain: 'SQRLCodeSignatureErrorDomain'
```

Two consequences shaped the code, and both are counter-intuitive enough to be
worth stating plainly:

1. **Squirrel validates at the swap, not at the download.** Everything up to and
   including `update-downloaded` succeeds. An implementation that trusted that
   event would promise a restart it cannot deliver.
2. **`quitAndInstall` does not throw.** It returns immediately and the refusal
   arrives later on the `error` event. A synchronous `try`/`catch` around it
   catches nothing — the first cut of this code had exactly that, and the
   observed behaviour was a user clicking "restart to install" and *nothing
   happening at all*.

So:

- `probeUpdateCapability()` classifies ad-hoc as **`manual`** up front. There is
  no point downloading 130MB for a swap that cannot succeed, and no point
  claiming readiness that cannot be honoured. The Inbox row opens the release
  page instead, which works.
- `engine.install()` returns a promise that **only ever rejects** — on success
  the process is replaced, so nothing resolves — and `updater.install()` awaits
  it. A Developer ID build refused for some other reason still degrades to the
  download page via `demoteToManual` rather than going silent.
- A Developer ID signature is classified `self-install` and the whole path
  works. Nothing in the app changes if one ever appears.

### Signing and notarization

The certificate is a **Developer ID Application** certificate issued to Behiques
Consulting LLC. Not "Apple Distribution" and not "Developer ID Installer": the
first is for the App Store, the second signs `.pkg` installers, and this app
ships a `.dmg` and a `.zip`. Only `Developer ID Application` produces the
`Authority=Developer ID Application` line that `capability.ts` looks for.

**The build configures itself from what is present**, so there is one command
either way:

| On a machine with… | `pnpm desktop:dist` produces |
| --- | --- |
| a Developer ID and Apple credentials | signed, notarized, self-updating |
| a Developer ID only | signed, not notarized — updates work, a downloaded dmg warns |
| neither | the ad-hoc build, exactly as before |

Nothing branches on a flag. Both switches in `electron-builder.yml` degrade on
their own, which was read out of electron-builder 26's source rather than
assumed:

- **`identity` is absent, not `null`.** `null` means "do not look for one" —
  that is what produced the unsigned bundle this document used to describe.
  Absent enables auto-discovery, which signs when the keychain has a certificate
  and logs `skipped macOS application code signing` when it does not.
- **`notarize: true` is safe with no credentials.** `notarizeIfProvided` asks
  for options, and when the environment supplies none it logs
  `skipped macOS notarization` and returns. It is also only called from inside
  the signing step, so an unsigned build never reaches it.

`hardenedRuntime: true` is required by notarization, and it is what makes
entitlements matter. electron-builder's default `entitlements.mac.plist` already
grants the three this app needs — `allow-jit` and
`allow-unsigned-executable-memory` for V8, and `disable-library-validation` for
`node-pty`, whose `.node` and `spawn-helper` are loaded and executed out of
`app.asar.unpacked`. No custom plist is carried until one proves insufficient.

`scripts/adhoc-sign.mjs` skips itself when a real identity is available. It runs
in `afterPack`, which electron-builder documents as happening *before* signing,
so a stale ad-hoc signature would be overwritten rather than left behind — the
skip is about not logging something false, in a project whose update path turns
on knowing which signature it has.

Credentials never live in this repo. Locally:

```bash
export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
pnpm desktop:dist
```

`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` is the supported
alternative when an App Store Connect key is not available.

**`APPLE_API_KEY` is a filesystem path to the `.p8`, not the key itself.**
`@electron/notarize` types it as "file system path to the `.p8` private key",
so a secret cannot hold it directly — the release workflow decodes
`APPLE_API_KEY_P8` (base64) into `$RUNNER_TEMP` and exports the *path*. Passing
the base64 through as `APPLE_API_KEY` looks correct, survives the whole build,
and fails at notarization on a file that does not exist.

The repository secrets are therefore:

| Secret | Holds |
| --- | --- |
| `CSC_LINK` | base64 `.p12` — the certificate **and** its private key |
| `CSC_KEY_PASSWORD` | the password set when exporting that `.p12` |
| `APPLE_API_KEY_P8` | base64 of the `.p8` |
| `APPLE_API_KEY_ID` | the key's ID |
| `APPLE_API_ISSUER` | the team's issuer UUID |

The three `APPLE_API_*` values are all-or-nothing: `getNotarizeOptions` throws
when some are present and others are not. All unset is the skip path; a
half-configured repository is the case worth failing on.

Verify a build rather than trusting it:

```bash
codesign -d --verbose=2 "dist/mac-arm64/The Hive.app"   # Authority=Developer ID Application: …
xcrun stapler validate  "dist/mac-arm64/The Hive.app"   # the notarization ticket
```

And then verify the thing those two cannot prove: publish a later version and
let an installed copy update **itself**. Signing is what the commands above
check; the swap is where this app failed before, and only a real update exercises
it.

#### The bundle identifier is part of this

`appId` is `com.behiques.the-hive`, changed from `dev.yunidbauza.the-hive` in the
release that introduced signing. For a Developer ID build the identifier is part
of the designated requirement Squirrel enforces, so changing it breaks in-place
updating across exactly one release. That release required a manual install
anyway — the only moment the change is free.

Two consequences of moving to a certificate, both one-time and both expected:

- The first signed release must be installed by hand. The ad-hoc copy in
  `/Applications` cannot self-update to it, by the cdhash argument above.
- macOS may prompt for Keychain access on first launch. The `safeStorage` key
  protecting the stored Jira credential is bound by ACL to the app's code
  signature, and that identity has changed. Allowing it, or re-entering the
  token once, resolves it permanently.

### Gatekeeper

Quarantine is applied by whatever *downloads* a file. A dmg pulled from a
browser is quarantined, and macOS then checks what is inside it:

- **Signed and notarized** — opens normally. This is what notarization buys, and
  it is the only reason to care about it: signing alone is enough for updates.
- **Signed but not notarized** — "cannot be opened because Apple cannot check it
  for malicious software". Right-click → Open, once, gets past it.
- **Unsigned or ad-hoc** — "damaged and can't be opened", which is a lie, but a
  load-bearing one. The escape:

```bash
xattr -dr com.apple.quarantine "/Applications/The Hive.app"
```

An update the app fetches itself is never quarantined, which was a real argument
for the in-app path even back when the swap was refused.

## Where the code lives

| File | Owns |
| --- | --- |
| `electron/shared/update-contract.ts` | Types, the release URLs, the two intervals. Imported type-only by the renderer. |
| `electron/main/updates/capability.ts` | The `codesign` probe and the demotion. |
| `electron/main/updates/updater.ts` | Every decision. Imports no Electron and no `electron-updater`, which is what makes it testable. |
| `electron/main/updates/engine.ts` | The only file that touches `electron-updater`. |
| `electron/main/updates/index.ts` | The singleton, the dialogs, the wiring. |

`autoUpdater` is read **inside** `createElectronUpdaterEngine`, never at module
scope. It is a lazy getter that constructs a `MacUpdater` on first access, which
reads `app.getVersion()` on the spot — at module scope that ran at import time
and broke three unrelated test suites with `Cannot read properties of undefined
(reading 'getVersion')` from inside `ElectronAppAdapter`.
