# The plan panel

While a session works through a plan, a slim rail beside its terminal shows the
tasks and how far along they are. Its session row carries the same count.

**On this page:** [What it shows](#what-it-shows) ·
[Where the tasks come from](#where-the-tasks-come-from) ·
[When it appears and leaves](#when-it-appears-and-leaves) ·
[The count on the session row](#the-count-on-the-session-row) ·
[Turn it off](#turn-it-off)

## What it shows

A 34px rail at the terminal's right edge:

| Part | Means |
| --- | --- |
| `3/7` at the top | tasks done, out of all of them |
| A numbered ring | a task not started yet |
| A green ring, pulsing | the task Claude is on now |
| A filled green check | a task that is done |
| `✓` at the top | every task is done |

**Peek:** hover over the rail, or tab to it, and a drawer slides out over the
terminal with every task by name. A long name is cut short; hover it to read the
whole thing. Peeking never resizes the terminal, so nothing in it reflows.

**Pin:** the pin button in the drawer's header docks the drawer beside the
terminal for good. The terminal narrows once to make room. Unpin with the same
button. The choice is remembered.

## Where the tasks come from

A session has one plan at a time. When more than one source offers one, the
higher one in this list wins:

1. **Claude's own task list.** When Claude breaks work into tasks with its task
   tools, those tasks are the plan, ticked as Claude works through them.
   A subagent's tasks are left out.
2. **A `hive:plan` file.** When the session writes or edits a plan in its
   repository's `.hive/plans/` folder, the plan's tasks show up. A builder
   agent working that plan ticks them off through the ledger as it goes:
   in progress when it starts a task, done when the task's commit lands.
3. **Plan mode.** When you approve Claude's plan in plan mode, its steps show
   up as proposed tasks, none started, until one of the sources above takes
   over.

## When it appears and leaves

The rail appears as soon as the session's plan has a task, and only in that
session's terminal view. When every task is done the count turns to `✓`, and a
few seconds later the rail leaves. It also leaves when the conversation ends: a
`/clear`, `/done`, a restart, or the terminal closing.

## The count on the session row

The same `done/total` sits in green after the session's status, both in the
Projects rail and in the overmind's fleet table. You can see how far a
background session has got without opening it.

## Turn it off

**Settings › Appearance › Plan panel › Show plan panel.** Off hides the rail
beside the terminal. The count on the session row stays, since it takes no
room from the terminal.
