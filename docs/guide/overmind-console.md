# The overmind console

The **overmind** is the home screen: a fleet table of every session and agent, a transcript,
and a command line. Press `⌘[` (or `←` at an empty Claude prompt) from any session to come
back here.

**On this page:** [The fleet table](#the-fleet-table) · [Commands](#commands) ·
[Examples](#examples) · [Errors you may see](#errors-you-may-see)

![The overmind: the fleet table, an agent row, and the help output](../assets/guide/08-overmind-console.png)

## The fleet table

Columns: **SESSION · STATUS · PROJECT · BRANCH · LAST USED · PR**, then a resume button on
rows that can be resumed. Live rows sit above an **ENDED** divider; agents have their own
group. Drag the handle under the table to give the transcript more room.

| Key | Does |
| --- | --- |
| `↑` `↓` | move the selection |
| `→` or `Enter` on an empty input | open the selected row |
| `Enter` | run the command |
| `Shift+Enter` | new line |

## Commands

`help` prints a shorter version of this list.

| Command | Does |
| --- | --- |
| `status` | one line per session |
| `open <session>` | put a session on the centre stage |
| `send <session> <message>` | type a message into a session and press Enter for you |
| `spawn <project> <task>` | start a new session on a project |
| `term [<project>]` | open a terminal in a project, or beside the selected session |
| `ledger [--open] [--events] [--from p] [--to p] [-n 20]` | print the tail of the [ledger](ledger.md) |
| `ask <agent> <message>` | ask an agent a question |
| `agents` | one line per agent |
| `run <agent> [prompt]` | wake an agent now, optionally saying why |
| `pause <agent>` / `resume <agent>` | stop or allow an agent's wakes |
| `kill <agent>` | stop the run in progress |
| `rotate <agent>` | have the agent hand off, then start a fresh session |
| `clear` | empty the transcript |

`<project>` is a key, an id or a name: `hive`, `the-hive` or `"The Hive"`. A name with
spaces needs quotes. `<session>` is an id or a name, in any case.

## Examples

```text
overmind ❯ spawn hive fix the flaky login test
overmind ❯ spawn "The Hive" add a dark-mode toggle to settings
overmind ❯ send ABC-123 run the e2e suite again
routed → ABC-123
overmind ❯ open ABC-123
opened ABC-123
overmind ❯ ask pr-patrol is PR 1234 safe to merge?
asked pr-patrol (a12)
overmind ❯ run pr-patrol review PR 1234
overmind ❯ ledger --open -n 10
```

## Errors you may see

| Line | Meaning |
| --- | --- |
| `usage: spawn <project> <task>` | a part of the command is missing |
| `unknown project: X` | no project has that key, id or name |
| `no such session: X` | no session has that id or name |
| `agents are asked, not sent: try ask …` | `send` is for sessions, `ask` is for agents |
| `terminals are typed into, not sent: open <id>` | open the terminal and type |
| `command not found: X — try help` | a typo |

The agent and ledger commands need the desktop app. The browser preview says so.
