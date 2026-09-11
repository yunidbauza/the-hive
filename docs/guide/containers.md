# Containers

Run a project's sessions, or an agent, inside a Docker (or Podman) container you already
have running. The Hive never starts, stops or names the container; it only runs `claude`
inside it.

**On this page:** [How it works](#how-it-works) · [A containerised session](#a-containerised-session) ·
[A containerised agent](#a-containerised-agent) · [Limits](#limits)

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/diagrams/containers.dark.svg">
  <img src="../assets/diagrams/containers.light.svg" alt="The Hive runs claude inside your container with docker exec; the container reports back to the receiver over HTTP">
</picture>

The container reaches the app through a host alias: `host.docker.internal` for Docker
Desktop, OrbStack and Rancher; `host.containers.internal` for Podman. Set it in
**Settings › Advanced › Containers**.

![Settings › Advanced: the container host alias and server mode](../assets/guide/19-settings-advanced.png)

## A containerised session

Add a `container` block to the project. Its presence is the switch.

```json
{
  "id": "incorpx",
  "path": "~/code/incorpx",
  "claudeCommand": "docker exec -it {env} devbox claude",
  "container": {
    "workspace": "/work",
    "hiveDir": "/hive",
    "probe": "docker exec devbox true"
  }
}
```

| Key | Means |
| --- | --- |
| `claudeCommand` | how to reach `claude` in the container; `{env}` is where identity goes |
| `workspace` | the container path of the project folder (required) |
| `hiveDir` | the container path where you mounted the app's `hive` data folder (required) |
| `envArg` | how one variable is passed, default `-e {name}={value}` |
| `probe` | must exit 0 before a session starts; its error is shown if not |
| `freshness` | `exec-env` (default, no secret on disk) or `rewrite` |
| `hostAlias` | overrides the global alias for this project |

The rail's terminal link reads **terminal · host**: a plain terminal still opens on your Mac.

## A containerised agent

Add a `container:` block to `AGENT.md` (snake_case here, unlike the config file):

```yaml
container:
  runtime: docker
  name: devbox
  workspace: /work        # container path of ~/.hive/work/<name>
  hive_dir: /hive         # container path of the app's hive data folder
```

`runtime`, `name`, `workspace` and `hive_dir` go together; `command`, `env_arg`, `freshness` and `host_alias` are optional. In the form, **Runs in a
container** writes or removes the whole block.

## Limits

- The container's home folder must persist between wakes: `--resume` reads the
  conversation from `~/.claude/projects/` inside it.
- A stopped container makes the run fail with the runtime's message; the next message retries.
- Container agents cannot use `mcp: [slack]` or `freshness: rewrite` yet.
- Docker on native Linux has no host alias. Turn on **Accept connections off loopback** and
  restart.
