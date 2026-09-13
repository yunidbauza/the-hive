# The ledger

The ledger is the shared notebook every session, every agent and you (the **overmind**)
write to. Nothing in it is ever edited: a question is answered by writing an answer that
names it.

**On this page:** [What the ledger is](#what-the-ledger-is) · [Entry kinds](#entry-kinds) ·
[Asks and answers](#asks-and-answers) · [Nudges into a live session](#nudges-into-a-live-session) ·
[The hive MCP tools](#the-hive-mcp-tools) · [Read it from the console](#read-it-from-the-console)

## What the ledger is

One append-only file per day at `~/.hive/ledger/YYYY-MM-DD.jsonl`. Every line is one entry:

```json
{"id":"20260828-141530-0001","ts":"2026-08-28T14:15:30Z","from":"pr-patrol","to":"overmind","kind":"ask","body":"PR 1234 has a failing check. Retry it?","ref":"a12","meta":{"options":["Retry","Leave it"]}}
```

Who wrote an entry is never taken from the entry itself. The app knows it from the session
token, so no one can post as someone else.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/diagrams/ledger.dark.svg">
  <img src="../assets/diagrams/ledger.light.svg" alt="You, sessions and agents write to the ledger; entries become inbox cards, agent wakes, or nudges at a live prompt">
</picture>

## Entry kinds

| Kind | Does |
| --- | --- |
| `post` | leaves a note; one addressed to a session shows in its terminal as a notice, a broadcast wakes nobody |
| `ask` | opens a thread and asks someone |
| `answer` | closes an ask and replies to the asker |
| `claim` / `release` | marks who is on a task (advisory, not a lock) |
| `done` / `failed` | reports finished or failed work; raises an inbox card |
| `handoff` | a note an agent leaves for its next session |
| `event` | receipts the app writes, like runs starting and nudges delivered |

## Asks and answers

- An ask gets a short ref like `a12`. That is what you type to answer it.
- An ask to you becomes an inbox card with its options as buttons. An ask with a `quote`
  shows a draft you can approve or edit.
- Only a party to the thread can answer. The answer wakes the asker.
- An open ask expires after 24 hours and wakes the asker so it can move on.

## Nudges into a live session

An ask or answer addressed to a running session is delivered as a one-line marker typed at
its prompt, like `📒 a12`. The full entry reaches Claude as hook context, not as typed text.

A nudge only lands at an idle prompt, and never into an input box where you have started
typing. Held nudges retry until they fit.

## The hive MCP tools

Every session and agent The Hive starts gets one MCP server, `hive`. The tools appear to
Claude as `mcp__hive__<name>`.

| Tool | Does |
| --- | --- |
| `ledger_read` | read your inbox: entries to you, new since your last read |
| `ledger_post` | leave a note |
| `ledger_ask` | ask a party and end the turn; optional options and a quoted draft |
| `ledger_answer` | answer an ask made of you |
| `ledger_claim` / `ledger_release` | take or give up a task |
| `ledger_done` / `ledger_failed` | report the result; raises an inbox card |
| `ledger_handoff` | leave a note for your next session |
| `agents` | list the other agents and what each accepts |
| `approve` | the permission handler; Claude Code calls it, the model never does |

**Example.** Inside any Hive session you can say:

```text
> Ask pr-patrol whether PR 1234 is safe to merge, and wait for the answer.
```

Claude calls `ledger_ask`, the agent wakes, and its answer comes back as a `📒` nudge.

## Read it from the console

```text
overmind ❯ ledger -n 20             # last 20 entries
overmind ❯ ledger --open            # only asks still waiting
overmind ❯ ledger --from pr-patrol  # one party
overmind ❯ ledger --events          # include delivery receipts
```

The full format, delivery rules and routes are in
[Agents and the ledger](../agents-and-ledger.md).
