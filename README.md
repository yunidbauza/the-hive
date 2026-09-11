<img src="docs/assets/splash.webp" alt="The Hive, overmind and swarm awakening" width="100%">

[![Latest release](https://img.shields.io/github/v/release/yunidbauza/the-hive?style=flat-square&labelColor=141a33&color=334fa9&label=release)](https://github.com/yunidbauza/the-hive/releases/latest)
[![Downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fyunidbauza%2F404ec74f87cbfb9939bb78482eff9719%2Fraw%2Fthe-hive-downloads.json&style=flat-square&labelColor=141a33)](https://github.com/yunidbauza/the-hive/releases)
[![Open issues](https://img.shields.io/github/issues/yunidbauza/the-hive?style=flat-square&labelColor=141a33&color=ffac47&label=open%20issues)](https://github.com/yunidbauza/the-hive/issues)
[![License](https://img.shields.io/github/license/yunidbauza/the-hive?style=flat-square&labelColor=141a33&color=74b79c)](LICENSE)

# The Hive

**Inspired by the alien race Zerg, of Blizzard's StarCraft masterpiece: one swarm, many
strains, an overmind keeping them in check.**

The Hive is a command center for many Claude Code sessions on one Mac. Every session is a
real `claude` in a real terminal, unchanged: same keys, same output, same conversation.
Around it sits everything you would otherwise leave the terminal for: an inbox that
surfaces the session waiting on you, Jira tickets, pull requests, a file explorer and
editor, custom skills, and background agents.

Built for Claude Code.

<img src="docs/assets/screenshot.png" alt="The Hive: the projects rail, a live Claude Code session on the centre stage, and the inbox" width="100%">

## Contents

**On this page**

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [How it fits together](#how-it-fits-together)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Stack](#stack)
- [License](#license)

**Guides** (using The Hive)

| Start here | Everyday work | Automation | Setup and reference |
| --- | --- | --- | --- |
| [Getting started](docs/guide/getting-started.md) | [Sessions and terminals](docs/guide/sessions.md) | [Agents](docs/guide/agents.md) | [Settings](docs/guide/settings.md) |
| [A tour of the window](docs/guide/tour.md) | [The overmind console](docs/guide/overmind-console.md) | [The ledger](docs/guide/ledger.md) | [The config file](docs/guide/configuration.md) |
| [Troubleshooting](docs/guide/troubleshooting.md) | [The inbox](docs/guide/inbox.md) | [Slack](docs/guide/slack.md) | [Themes](docs/guide/themes.md) |
| | [Jira and pull requests](docs/guide/work-and-prs.md) | [Containers](docs/guide/containers.md) | [Updates](docs/guide/updates.md) |
| | [Files and the editor](docs/guide/explorer.md) | [Server mode and remote attach](docs/guide/remote.md) | |
| | [Custom skills](docs/guide/skills.md) | | |

**Internals** (working on The Hive): [architecture](docs/architecture.md) ·
[contributing](docs/contributing.md) · [every deep dive](docs/README.md#internals)

## What it does

<img src="src/components/ui/swarm/hive.webp" alt="" width="120" align="right">

| | |
| --- | --- |
| **Runs the terminals** | One real PTY per session. Start one from a project, a Jira ticket, or the console: `spawn the-hive "fix the lead form"`. [Sessions](docs/guide/sessions.md) |
| **Notices when one needs you** | Claude Code's hooks report in, so a permission prompt or a finished turn raises an inbox card instead of scrolling past in a tab you were not watching. [Inbox](docs/guide/inbox.md) |
| **Keeps the work in view** | Jira tickets and `gh` pull requests, matched to the session that made them. [Jira and PRs](docs/guide/work-and-prs.md) |
| **Opens the repository** | A project explorer over the active session's checkout, opening files into a CodeMirror editor. [Files](docs/guide/explorer.md) |
| **Carries your skills** | Skill folders under `~/.hive/skills` reach every session The Hive starts, and no other `claude`. [Skills](docs/guide/skills.md) |
| **Runs agents in the background** | Headless `claude` runs that wake on a schedule, a message or a Slack mention, and ask you before they act. [Agents](docs/guide/agents.md) |
| **Serves from another Mac** | Run sessions on one always-on Mac and drive them from another over Tailscale. [Remote](docs/guide/remote.md) |
| **Follows a theme all the way down** | Chrome, terminal and editor all take their colours from one theme file. [Themes](docs/guide/themes.md) |
| **Ends cleanly** | `/done` finishes a session and closes its terminal. The row stays readable, with Resume. [Sessions](docs/guide/sessions.md#finish-with-done) |

<br clear="all">

## Quick start

1. Download the `.dmg` from [the latest release](https://github.com/yunidbauza/the-hive/releases/latest)
   (macOS, Apple silicon). It updates itself.
2. Open it, click **+ new project** in the left rail, and choose a repository folder.
3. Click **New session**, type the project's name, and press Enter.

That is a live Claude Code session. The full walkthrough is in
[Getting started](docs/guide/getting-started.md).

Linux has no release build yet. Run it from source:

```sh
pnpm install
pnpm desktop:dev
```

## Requirements

| Need | Why | Without it |
| --- | --- | --- |
| **Claude Code** on your `PATH` | every session is a real `claude` | nothing starts. Override per project with `claudeCommand` |
| **git** | the branch each session is on | branches read as a dash |
| **[`gh`](https://cli.github.com)**, signed in | the PRs tab | the PRs tab stays empty |
| **A Jira account** (optional) | the Work tab | the tab says how to connect |

Building from source also needs Node 22 ([`.nvmrc`](.nvmrc)) and pnpm (pinned in
`package.json`). Windows is not supported. See
[Run from source](docs/guide/getting-started.md#run-from-source).

## How it fits together

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/overview.dark.svg">
  <img src="docs/assets/diagrams/overview.light.svg" alt="You drive The Hive; its main process runs claude sessions through the PTY host, wakes agents, and hears back through hooks">
</picture>

Sessions report their state back through Claude Code's hooks. That is how the inbox knows
which one needs you. The long version is in [Architecture](docs/architecture.md).

## Documentation

Everything lives in [`docs/`](docs/README.md), in two layers:

- **[Guides](docs/README.md#guides)**: short, task-first pages with screenshots and examples.
- **[Internals](docs/README.md#internals)**: the deep dives on how each part is built, for
  contributors.

## Contributing

```sh
pnpm install
pnpm desktop:dev     # the Electron app with hot reload
pnpm lint && pnpm type-check && pnpm test
```

`pnpm lint` and `pnpm type-check` must both pass before any change is done. The commands,
the test layers and the architecture rules are in [Contributing](docs/contributing.md) and
[`AGENTS.md`](AGENTS.md).

## Stack

React 19 · TypeScript (strict) · Vite · Electron · xterm.js · CodeMirror 6 · Zustand ·
Tailwind v4 · shadcn/ui · pnpm

## License

[Apache 2.0](LICENSE) © Yunid Bauza
