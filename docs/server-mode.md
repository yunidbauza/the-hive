# Server mode

The Hive can run as a headless server on a Mac mini. Manage it over SSH; no
window or tray interaction is required for routine operation.

## Updating a served machine

When the fleet is idle, connect to the machine and run:

```sh
the-hive --update
```

The command prints its outcome to stdout:

| Exit code | Meaning |
| --- | --- |
| `0` | A signed update downloaded and installation has started. The app relaunches. |
| `2` | The installed version is current. |
| `3` | The build needs a manual download or does not have an update channel. Use the printed release URL from a machine with a browser. |
| `1` | The update failed, including when this machine is still serving. |

`--update` refuses while the local server is running so installation cannot
drop attached clients or PTYs. Stop the server, wait for it to exit, and then
run the command again.
