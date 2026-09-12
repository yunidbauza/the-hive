# The Hive documentation

Two layers. **Guides** show you how to use The Hive, one task per section, with a
screenshot or a diagram on every page. **Internals** explain how each part is built, for
anyone changing the code.

New here? Start with [Getting started](guide/getting-started.md), then
[A tour of the window](guide/tour.md).

## Guides

### Start here

| Page | What you will learn |
| --- | --- |
| [Getting started](guide/getting-started.md) | Install, map a project, start your first session |
| [A tour of the window](guide/tour.md) | What every rail, tab and button is, plus keyboard shortcuts |
| [Troubleshooting](guide/troubleshooting.md) | The errors people hit first, and the fix for each |

### Everyday work

| Page | What you will learn |
| --- | --- |
| [Sessions and terminals](guide/sessions.md) | Start, watch, finish and resume sessions; plain terminals |
| [The overmind console](guide/overmind-console.md) | The fleet table and every console command, with examples |
| [The inbox](guide/inbox.md) | Why a card appears, how to answer it, and how to quiet it |
| [Jira and pull requests](guide/work-and-prs.md) | Connect Jira, start from a ticket, follow your PRs |
| [Working a ticket](guide/workflow.md) | From a ticket to Done: the skills, the agents, and what the cards show |
| [Files and the editor](guide/explorer.md) | Browse, search and edit the session's repository |
| [Custom skills](guide/skills.md) | Write slash commands that only Hive sessions get |

### Automation

| Page | What you will learn |
| --- | --- |
| [Agents](guide/agents.md) | Background `claude` runs that wake on their own |
| [The ledger](guide/ledger.md) | The shared log sessions and agents talk through |
| [Slack](guide/slack.md) | Let agents read Slack, and command them from it |
| [Containers](guide/containers.md) | Run sessions and agents inside a Docker container |
| [Server mode and remote attach](guide/remote.md) | Serve from an always-on Mac, drive it from another |

### Setup and reference

| Page | What you will learn |
| --- | --- |
| [Settings](guide/settings.md) | Every Settings section, what it changes |
| [The config file](guide/configuration.md) | `~/.hive/config.json`, key by key |
| [Themes](guide/themes.md) | Pick, import and write a theme |
| [Updates](guide/updates.md) | How updates arrive, and `the-hive --update` |

## Internals

Start with [Architecture](architecture.md) for the map, then open the deep dive for the
part you are changing. [Contributing](contributing.md) has the commands and test layers.

| Deep dive | Covers |
| --- | --- |
| [Architecture](architecture.md) | Processes, the bridge, the fences, where to look |
| [Contributing](contributing.md) | Commands, test layers, live suites, the definition of done |
| [Desktop architecture](desktop-architecture.md) | Main process, IPC, the PTY host, session status, names |
| [Terminal architecture](terminal-architecture.md) | The terminal seam, transports, colour, fitting |
| [Explorer and editor](explorer-and-editor.md) | The fs IPC surface, the watcher, the editor seam |
| [State and data](state-and-data.md) | The four stores, selectors, caps, the console grammar |
| [Component patterns](component-patterns.md) | The shell, the view-state machine, rails |
| [Agents and the ledger](agents-and-ledger.md) | Ledger format, delivery, the MCP host, agent definitions |
| [Server mode](server-mode.md) | The full server runbook: LaunchAgent, pairing, exposure |
| [Packaging and updates](packaging-and-updates.md) | Releases, signing, the bundle, the updater |
| [Design system](../.claude/DESIGN-SYSTEM.md) · [Components](../.claude/COMPONENTS.md) | Tokens, type scale, atoms |

