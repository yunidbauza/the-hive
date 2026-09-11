# Server mode and remote attach

Run The Hive on an always-on Mac and drive its sessions from your laptop. The
sessions, agents, ledger and inbox all live on the server; the laptop is a window onto them.

This page is the overview. The step-by-step runbook is [Server mode](../server-mode.md).

**On this page:** [How it fits together](#how-it-fits-together) ·
[Serve from an always-on Mac](#serve-from-an-always-on-mac) · [Pair a device](#pair-a-device) ·
[Attach from a laptop](#attach-from-a-laptop) · [When the connection drops](#when-the-connection-drops) ·
[What a remote device cannot do](#what-a-remote-device-cannot-do)

## How it fits together

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/diagrams/remote-topology.dark.svg">
  <img src="../assets/diagrams/remote-topology.light.svg" alt="A server Mac holds sessions, agents and the ledger; laptops attach to its listener over Tailscale">
</picture>

Same version on both ends, one Tailscale network. Tailscale is the first line of defence;
device tokens are the second.

## Serve from an always-on Mac

Short version (the runbook has every command):

1. Keep the server Mac awake and logged in: automatic login, `pmset` sleep off, Tailscale
   key expiry off.
2. Add a `server` block to its config with the server's Tailscale address:

```json
"server": {
  "enabled": true,
  "bind": { "host": "100.101.102.103", "port": 7433, "allowedOrigins": [] }
}
```

3. Start it at login with a LaunchAgent, so it restarts itself and after updates.

`0.0.0.0` is refused on purpose: bind the tailnet address only. **Serve this machine** in
**Settings › Advanced** edits the same block.

## Pair a device

On the server, over SSH:

```sh
the-hive --pair "MacBook"     # prints a one-time token and a device id
the-hive --devices            # list paired devices
the-hive --revoke "MacBook"   # cut a device off
```

Pairing works while the server runs, with no restart. Only a hash of each token is kept in
the config.

## Attach from a laptop

**Settings › Advanced › Attach to a server**: enter the server address, port, device id and
token, then **Attach**. The token is stored in the laptop's Keychain.

You cannot attach while sessions are running locally; the refusal lists them.

## When the connection drops

The header chip turns amber and the laptop redials after 1, 2, 4, 8, 15 and 30 seconds, then
every 30 seconds, forever. Terminals pick up where they left off. **Work locally** is the way
out. A revoked token or a version mismatch is shown in red and not retried.

## What a remote device cannot do

Pairing grants everything a local user can do, except things tied to one machine's window or
process: native folder pickers (use drag and drop), importing a skill from disk, revealing the
config in Finder, update checks, and pairing other devices. Settings edits the server's config,
and says so.
