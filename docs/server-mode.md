# Server mode

The Hive can run on an always-on Mac, a Mac mini on a shelf, and hold the
sessions, the agents, the ledger and the hook receiver there. The desktop app on
any other machine attaches to it and becomes a window onto it, from home or from
a hotel four time zones away.

One binary, two modes. The mini runs the same app with a `server` block in its
config; it opens no window, shows a menu-bar item, and listens on a WebSocket
bound to its Tailscale address. The laptop runs the same app with a `remote`
block and routes every IPC call to that socket instead of to its own process.

This document takes a mini from unboxed to attachable, and to a server that
survives a reboot with nobody touching it. Follow it top to bottom once. After
that the machine looks after itself.

## Before you start

- **The same version on both ends.** The first frame carries
  `REMOTE_PROTOCOL_VERSION` (`electron/shared/remote-contract.ts`). A mismatch
  is refused with a message naming both versions and which side to update.
- **Tailscale on the mini and on every client, in one tailnet.** It is the
  primary security control, not a convenience. See [Exposure](#exposure).
- **Claude Code installed and logged in on the mini.** Sessions run there, so
  `claude` has to work in the mini's own shell.
- **Measure the floor first.** `ssh` into the mini over Tailscale from wherever
  "remote" actually means for you, and type. Echo in an attached terminal costs
  one round trip over the same link; nothing in this design beats that.

## The keychain requirement

**The server must run inside a logged-in GUI session whose login keychain is
unlocked.** This is a requirement of the deployment, chosen on purpose, not a
bug to work around.

Electron's `safeStorage` encrypts every credential the app keeps (Jira, Slack,
anything else stored through it) with a key held in the login keychain. Outside
a logged-in session, or with that keychain locked, `safeStorage` reports
encryption unavailable and every stored credential is unreadable. A
LaunchDaemon, a process started at the login window, or one started over SSH
before anyone logged in all hit exactly that. The design chose auto-login plus
a LaunchAgent over writing a second secret store; if the server ever has to run
as a true daemon (a Linux box, say), this is the decision to revisit first.

The paired-device tokens are not affected: the server stores only a SHA-256
digest of each, in the config file, and needs no keychain to check one.

## 1. Prepare the mini

1. **Install The Hive** from the dmg into `/Applications`, and open it once from
   Finder so Gatekeeper records it. Quit it again; launchd starts it from step 4
   on. Use a Developer ID signed build if you want the server to update itself
   (see [Updates](#updates)).
2. **Turn on automatic login.** System Settings, Users & Groups, *Automatically
   log in as*, pick the account that will run the server. macOS refuses this
   while FileVault is on, so FileVault has to be off: that is the cost of an
   unattended boot, and the reason the tailnet and the device tokens matter.
   Automatic login unlocks the login keychain as long as the keychain password
   is still the account password; if you ever changed one without the other,
   fix that now (Keychain Access, *Change Password for Keychain "login"*).
3. **Keep it awake and bring it back after a power cut.**

   ```sh
   sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1
   ```

   The app also holds its own sleep assertion while serving
   (`powerSaveBlocker`'s `prevent-app-suspension`, the same thing
   `caffeinate -i` does), so this line covers the minutes before it starts and
   any time it is not running. `autorestart 1` is the one that matters for a
   power cut: without it the mini stays off until someone presses the button.
4. **Install Tailscale, log in, and let it launch at login.** Then read the
   mini's tailnet address:

   ```sh
   /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
   ```

   In the Tailscale admin console, **disable key expiry** for the mini, or it
   drops off the tailnet when its node key expires and every client with it.
5. **Install the `the-hive` command**, so the one-shot commands below work over
   SSH:

   ```sh
   sudo mkdir -p /usr/local/bin
   sudo tee /usr/local/bin/the-hive >/dev/null <<'EOF'
   #!/bin/sh
   exec "/Applications/The Hive.app/Contents/MacOS/The Hive" "$@"
   EOF
   sudo chmod 755 /usr/local/bin/the-hive
   ```

   `/usr/local/bin` is on the default `PATH` of a macOS login shell, including
   an SSH one.

## 2. Write the server block

In the mini's `~/.hive/config.json` (or in Settings, Advanced, *Serve this
machine*, from a screen-sharing session):

```json
"server": {
  "enabled": true,
  "bind": { "host": "100.101.102.103", "port": 7433, "allowedOrigins": [] },
  "devices": []
}
```

- **`enabled: true`** is what makes a plain launch serve. The LaunchAgent below
  passes no flag. `the-hive --server` serves for one run without writing the
  file, which is for trying it out, not for the deployment. A `--server` run
  does not update itself either: only `enabled: true` means launchd is behind
  the process.
- **`bind.host`** is the mini's Tailscale address from step 4. `0.0.0.0` is
  refused in every spelling (`0`, `0x0`, `000.000.000.000` included); loopback
  is allowed so the link can be tried on one machine. A refused or malformed
  host does not stop the app: the config reader logs why and the server binds
  `127.0.0.1` instead, which from every other machine looks like a server that
  is not there. Check the log after any edit to this block.
- **Clients must dial the exact string in `bind.host`.** The listener's Host
  guard admits loopback and that one value, nothing else. A MagicDNS name that
  resolves to the same address is refused with a bare 403, and the mini's log
  says which name it refused and what it would have admitted. Bind the `100.x`
  literal and have clients use the literal. A `.ts.net` name works too, if both
  sides use the name.
- **`port`** is fixed, never OS-assigned: clients and the LaunchAgent have to
  know it ahead of time. 7433 is the default.
- **`allowedOrigins`** stays empty. The desktop client sends no `Origin`; a
  listed one exists only for a browser page someone points at the socket on
  purpose.

`CONFIG_VERSION` stays 2. An older build reads a file with a `server` block,
reports the key, and keeps it.

## 3. Start it at login, keep it running

A LaunchAgent, not a LaunchDaemon: it has to run inside the logged-in session
(see [The keychain requirement](#the-keychain-requirement)), and the menu-bar
item needs a menu bar.

```sh
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
cat > ~/Library/LaunchAgents/com.behiques.the-hive.server.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.behiques.the-hive.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>sleep 20; exec "/Applications/The Hive.app/Contents/MacOS/The Hive"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/the-hive-server.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/the-hive-server.log</string>
</dict>
</plist>
EOF
plutil -lint ~/Library/LaunchAgents/com.behiques.the-hive.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.behiques.the-hive.server.plist
```

The heredoc is unquoted on purpose: `$HOME` is expanded when the file is
written, because launchd expands nothing in a plist.

What each part is for:

- **No `--server`.** The config's `enabled: true` decides.
- **`KeepAlive`** relaunches the app after a crash, a `kill`, and an update.
  It also relaunches it after *Quit* in the menu-bar item. To stop the server
  for real, unload the agent (below).
- **`sleep 20`** is for updates. An install quits the app so Squirrel can swap
  the bundle, and launchd restarts a long-running job at once; the delay lets
  the swap finish before the new binary starts. At login it also gives
  Tailscale a head start, though nothing depends on that: a bind that fails
  because the tailnet address is not up yet is retried, after 5 s and then
  doubling to once a minute, until it lands.
- **Do not also add The Hive to Login Items.** Two copies at login means one
  loses the single-instance lock and quits, and launchd relaunches it every
  twenty seconds forever.

Day to day:

```sh
launchctl print gui/$(id -u)/com.behiques.the-hive.server | head -20   # state and pid
lsof -nP -iTCP:7433 -sTCP:LISTEN                                         # the socket
tail -f ~/Library/Logs/the-hive-server.log                               # the log
launchctl bootout gui/$(id -u)/com.behiques.the-hive.server             # stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.behiques.the-hive.server.plist  # start
```

A running server has a menu-bar item whose tooltip reads *The Hive · serving*.
Its menu shows the bound address (or *Not serving* with the reason), the paired
devices, *Pair a device…* and *Open The Hive*. The dock
icon is hidden, and no unread badge appears there: each attached client badges
its own dock.

## 4. Pair each client

On the mini, over SSH, once per device:

```sh
the-hive --pair "MacBook"
```

It prints the token once, then the device id and how to revoke it. The token is
never stored on the mini, only its digest, so copy it now. The command works
while the server is running; the running server sees the new device without a
restart. The menu-bar item's *Pair a device…* does the same thing.

```sh
the-hive --devices            # who is paired
the-hive --revoke "MacBook"   # cut one device off, at once
```

On the client: Settings, Advanced, *Attach to a server*. Fill in *Server
address* (the exact `bind.host`), *Port*, *Device id* and *Pairing token*, then
*Attach*. The token goes into the client's own keychain, never into its config
file. Two refusals you may meet:

- **A plaintext socket to anything but loopback or a tailnet address** (a
  `100.64.0.0/10` address or a `*.ts.net` name) is refused before it dials.
- **Attaching while local sessions are running** is refused and lists them, so
  nothing is left running unseen on the laptop.

Once attached, the whole fleet on the mini shows up in the client, Settings
edits the mini's config under copy that says so, and a dropped connection
reconnects by itself. A terminal survives the disconnect: the client names the
last output it saw and the server replays the rest, or marks a gap when its
buffer no longer reaches back that far.

## 5. Check it survives a reboot

```sh
sudo reboot
```

Leave the client attached. It says it is reconnecting while the mini is down,
and reattaches on its own once the mini has logged in, Tailscale is up and the
LaunchAgent has started the app. Nobody touches either machine. If it does not
come back, see [Troubleshooting](#troubleshooting).

## Updates

**The server updates itself.** It checks for a new release 30 s after launch
and every six hours after that. When a signed build finds one, it downloads it
in the background and installs it at the first moment **no session is live and
no agent run is in flight**, looking again every five minutes until then. An
install never cuts off a live session. Installing quits the app; launchd starts
the new version (Squirrel's own relaunch is off on a server, or there would be
two copies, one launchd cannot see).

Two consequences:

- **Update the clients too.** A client on a different protocol version is
  refused at attach with a message saying which side to update.
- **A fleet that is never idle never updates.** A session left open for days
  holds the update for days. Close it, or update by hand.
- **Any quit installs a downloaded update.** Once one is staged, a crash,
  *Quit* in the menu, or `launchctl bootout` also swaps it in, and the next
  start is the new version.

An ad-hoc signed build cannot install in place. It announces the release with a
row pointing at the release page instead, and changes nothing.

### By hand, over SSH

```sh
launchctl bootout gui/$(id -u)/com.behiques.the-hive.server
the-hive --update
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.behiques.the-hive.server.plist
```

`--update` refuses while the server is running, so installation cannot drop
attached clients or PTYs; that is why the agent is stopped first. It prints its
outcome and exits with one of:

| Exit code | Meaning |
| --- | --- |
| `0` | A signed update downloaded and installation has started. On a server, the app does not relaunch itself; the `bootstrap` line does. |
| `2` | The installed version is current. |
| `3` | The build needs a manual download or does not have an update channel. Use the printed release URL from a machine with a browser. |
| `1` | The update failed, including when this machine is still serving. |

## What an attached device can do

**Everything.** Pairing grants execute: `pty:spawn`, `pty:write`,
`fs:write-file`, `agents:run` and the rest of the surface. This is a remote
execution endpoint, not an app with a login, and every control below follows
from that.

A few calls are refused to every remote caller, each with its own reason in
the error frame, never a silent change on the server:

- **The native dialogs** (`WINDOW_BOUND`): `config:choose-directory`,
  `skills:file:import`, `config:reveal`. They would open on a screen nobody is
  watching. The shipped client browses the mini's folders with
  `config:browse-directory` and takes skill files by drag and drop instead.
- **`skills:file:drop`** (`REMOTE_REFUSED`): its safety argument, that preload
  minted every source path from a real drop on this device, cannot cross a
  socket.
- **The nine process-local channels** (`PROCESS_LOCAL`): `app:info`,
  `updates:status`, `updates:check`, `config:set-remote`, `config:get-remote`,
  `remote:pair`, `remote:forget`, `notifications:delivery` and
  `notifications:badge`. Each is about the machine that answers it. A shipped
  client answers them itself, so a hand-built frame asking the mini to forget
  its credential, change its attachment or run its updater is refused.
- **`notifications:act` carrying `url`, `update.download` or `update.install`.**
  The fleet actions (`ask`, `session`, `agent`, `none`) still cross.

## Exposure

The controls, in order of how much they carry:

1. **Tailscale.** Bind the tailnet address only. Use a Tailscale ACL to limit
   which of your devices can reach port 7433 at all. No port forward, no public
   DNS, no ngrok: those put a remote execution endpoint on the internet behind
   auth this app wrote itself. `ssh -L` over the tailnet is a good break-glass
   path.
2. **Device tokens.** One per device, compared in constant time, revocable one
   at a time with `--revoke`. A laptop that joins the tailnet, or is stolen, is
   not trusted by being there.
3. **The refusals above.**

What an unauthenticated peer on the tailnet can cost the mini: a first frame is
held to 8 KiB (`ATTACH_FRAME_MAX_BYTES`), but a socket's receiver is built with
the post-attach ceiling of 8 MiB (`POST_ATTACH_FRAME_MAX_BYTES`), at most eight
sockets may be mid-handshake at once (more get a 503), and each has 5 s to
attach before it is closed. So strangers can make the server buffer about
64 MiB for a few seconds, and nothing past that. Attached sockets are not
capped in number; only paired devices get there. That bound is why the bind
address matters: on the tailnet it is a small exposure, on every interface it
would not be.

The hook receiver stays on loopback. Everything that calls it (the sessions,
the agents, any containers) runs on the mini.

Over a slow link: terminal output is framed as JSON, about 5 % over the raw
bytes at normal flush sizes.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The menu reads *Not serving* | `bind.host` is not an address of this machine yet (Tailscale still starting) or is wrong. It retries by itself; if it never lands, check `Tailscale ip -4` against the config. The log names the error. |
| Server listens on `127.0.0.1` instead of the tailnet address | `bind.host` was refused (a wildcard, or not a valid host) and the reader fell back to the default. The log names the key and the reason. |
| Client gets a 403 | It dialed a name the server did not bind. Use the exact `bind.host` string. The mini's log names the refused host. |
| Client says the versions differ | Update whichever side the message names. |
| Jira or Slack shows signed out after a reboot | The login keychain is locked: automatic login is off, or the keychain password differs from the account password. |
| Log says another server is already running for this config | Two copies started. Remove The Hive from Login Items; keep only the LaunchAgent. |
| Server never updates | Something is always live. Check for a long-lived session or a busy agent schedule, or update by hand. |
| Menu-bar item shows the text "Hive" | The bundle is missing `Contents/Resources/tray/`. Reinstall. |
