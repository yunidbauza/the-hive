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

**This is the load-bearing constraint, and it cannot be solved without an Apple
Developer ID.**

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

### Gatekeeper

Quarantine is applied by whatever *downloads* a file. A dmg pulled from a
browser is quarantined, and an unsigned app inside it is refused with "damaged
and can't be opened" — which is a lie, but a load-bearing one. The escape:

```bash
xattr -dr com.apple.quarantine "/Applications/The Hive.app"
```

An update the app fetches itself is not quarantined, which is a real argument
for the in-app path even while the swap is refused.

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
