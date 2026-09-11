# Updates

The Hive updates itself, but never without asking.

**On this page:** [Automatic updates](#automatic-updates) · [Check by hand](#check-by-hand) ·
[Update from the command line](#update-from-the-command-line) ·
[Cutting a release](#cutting-a-release)

## Automatic updates

- The app checks 30 seconds after launch, then every 6 hours. When there is nothing new, you
  hear nothing.
- A new version raises one inbox card per version. Nothing downloads until you say yes, and
  nothing installs until a second yes.
- A server ([Remote](remote.md)) downloads on its own and installs once no session or agent run
  is live.
- A build without a Developer ID signature cannot install itself; its card opens the release
  page instead.

## Check by hand

The app menu's **Check for Updates…**, or **Settings › Advanced › Updates › Check now**. Every
outcome gets a dialog.

## Update from the command line

Useful over SSH on a server Mac:

```sh
the-hive --update
```

| Exit | Meaning |
| --- | --- |
| 0 | downloaded, install started |
| 1 | failed, with the reason |
| 2 | already current |
| 3 | no update channel; prints where to download |
| 4 | a newer version needs a manual install |
| 5 | refused while the local server is running |

On a server, stop the LaunchAgent, update, then start it again:

```sh
launchctl bootout gui/$(id -u)/com.behiques.the-hive.server
the-hive --update
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.behiques.the-hive.server.plist
```

`the-hive` is a small shim for the app binary; [Server mode](../server-mode.md) shows how to
install it.

## Cutting a release

For maintainers:

```sh
pnpm version minor
git push --follow-tags
```

The tag runs CI (lint, type-check, test, build) and publishes the `.dmg`, the `.zip` the
updater uses, and `latest-mac.yml`. Never move a published tag. The details are in
[Packaging and updates](../packaging-and-updates.md).
