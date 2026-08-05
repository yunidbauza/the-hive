# 108 — The live session: focus, geometry, and the end of a session

| | |
|---|---|
| **ID** | HIVE-108 |
| **Epic** | — (defect batch against [096](096-session-lifecycle-claude.md), [095](095-interactive-terminal-surface.md)) |
| **Depends on** | [095-interactive-terminal-surface.md](095-interactive-terminal-surface.md), [096-session-lifecycle-claude.md](096-session-lifecycle-claude.md) |
| **Points** | 5 |
| **Location** | `app/src/components/terminal/`, `app/src/components/layout/center-stage.tsx`, `app/src/lib/terminal/keymap.ts`, `app/src/stores/hive-store.ts`, `app/electron/main/sessions/activity.ts`, `app/electron/shared/session-contract.ts` |

## Story

> As someone driving a fleet of Claude Code sessions, I want a session I open to
> take my keystrokes, keep its transcript intact when I leave and come back, and
> let me out with the key I use everywhere else — so that the terminal at the
> centre of this app behaves like a terminal.

Five defects, reported together. They look like five and are really three:
**who owns the keyboard**, **when a terminal may be measured**, and **what it
means for a session to be over**.

## The defects

| # | Symptom | Root cause |
|---|---|---|
| 1 | A new session opens without focus; the user must click inside it | Nothing focused the terminal, and `MessageInput` autofocused itself instead |
| 2 | Leaving a session and returning shows a scrambled transcript | The hidden surface's `ResizeObserver` fitted a zero box and resized the pty to ~11 columns |
| 3 | A text box sits under a live Claude session | `MessageInput` was mounted for every entity view |
| 4 | After `/exit`, `←` no longer returns to the orchestrator | Bare `←` is only claimed at an empty Claude prompt, and an exited shell shows neither |
| 5 | A finished session can be re-entered, showing a dead terminal | A pty exit was reported as `done`, which is also a fixture state, and nothing gated re-entry |

## 2 is the important one

The others are papercuts. This one destroys work the user was reading.

Hiding a kept-alive surface sets `display: none`, which fires its
`ResizeObserver` with a zero box. An element in a `display: none` subtree has no
used values, so `getComputedStyle` returns the **specified** `height: 100%` /
`width: 100%`, and `FitAddon` parses that as the number `100`. Not `NaN` — so
its own guard passes — and not the real size either. It proposes roughly
**11×5**.

Two things then happen, and only together do they produce the reported symptom:

1. `fit()` reflows the existing buffer to eleven columns.
2. The new geometry is forwarded to the pty, so `claude` repaints its entire TUI
   at eleven columns.

Coming back re-fits to the true width and restores nothing, because the wide rows
no longer exist anywhere. That is the ribbon in the bug report.

The fix is one line in the observer, and the interesting part is the guard.
`visible` is read through a ref **written during render**, not updated in an
effect: React commits `display: none` → the browser lays out → the observer fires
→ *then* passive effects run, so an effect-updated ref is still `true` at exactly
the moment that matters. A `clientWidth` check would be synchronous but is wrong
in the other direction — a visible surface briefly measuring zero mid-layout
would skip its fit and never get another, because no further resize is coming.
Visibility is the condition with a guaranteed follow-up.

The appearance effect already carried this guard and a comment describing it
(story 105); the observer never did. The comment also estimated the damage as the
addon's 2×1 floor, which is wrong — the floor is never reached, because 100 is
not zero. It has been corrected.

## 1 and 3 are one decision

A live session **is** Claude Code's prompt. Mounting a second text box beneath it
gave one session two inputs, with different keybindings, different history, and
no way to tell from the caret which would receive the next character — and their
autofocuses were racing on every newly opened session, which is defect 1.

So the row is now mounted only where the surface above it cannot be typed into:
the browser demo and the agent tabs, both recordings with no prompt of their own.
`CenterStage` already computed `activeIsLive` for its click-to-focus guard; the
row reuses it.

The keyboard goes to the terminal instead. `TerminalSurface` focuses itself when
it **becomes visible** and is interactive — reveal rather than mount, because
`TerminalHost` creates instances lazily and keeps them alive hidden, so the two
coincide only the first time. Read-only surfaces are excluded, and that exclusion
is load-bearing rather than tidy: the orchestrator console is read-only and owns
a *separate* command row that autofocuses itself.

`MessageInput`'s live-terminal branch — the `⌘←` hint and its `isBackChord`
handler — became unreachable and was deleted rather than left as dead code.

## 4: the way out of a dead terminal

Story 095's governing rule is that **a focused interactive terminal wins every
bare key**, because the child process needs them. After `/exit` there is no child
process. Every keystroke lands in a pty that will never answer, so the rule
protects nothing and costs the user the only key they are likely to press.

`decideTerminalKey` gains one condition — `ended && isBareBack` → `app-chord` —
checked *before* `isEmptyClaudePrompt` because the two ask unrelated questions.
That one asks whether Claude would have navigated; this applies when Claude is
gone and the last rows are a shell's `logout` and an exit notice, which is
prompt-shaped for neither test.

Deliberately narrow: every other key still goes to the terminal, because a dead
terminal is still a *readable* one and reading it is why the tab stays open.

The surface also sets `disableStdin` and stops the cursor blinking. Both are live
xterm options, which is what lets this be an effect rather than the rebuild
`readOnly` requires — and a rebuild would dispose the buffer, throwing away the
exit notice, the most useful thing on the screen.

## 5: `terminated` is not `done`

`done` already existed and meant two incompatible things. In the fixtures it is a
*judgement*: this work finished, here is the merged PR. From main it was an
*observation*: a pty exited. Story 096 mapped the second onto the first, and
`bootstrap.ts` recorded the decision explicitly — "There is no new status."

That was wrong, and defect 5 is the consequence. Main cannot evaluate the
judgement: `/exit` after an abandoned attempt and `/exit` after a merged PR
produce byte-identical evidence. And the two endings need different affordances —
a `done` fixture is a recording that reads fine, while a `terminated` session has
a real, dead pty behind it.

So `SessionStatus` gains `terminated`, and `DerivedStatus` — the type main sends —
**loses `done` entirely**, which is what stops a later edit making that claim by
accident. The same discipline the type already applied to `waiting`.

### Where the distinction is drawn, and where it is not

Four selectors used to spell `status === 'done'` independently, which is exactly
how a fifth state gets silently forgotten in three of them. They now share
`isEnded(status)`. The orchestrator's divider says **ENDED** rather than
COMPLETED, because the group holds two different endings and only one of them was
completed; the row's own status word says which. The header sums them, because
fleet-wide the question is only "how much is no longer running".

### Re-entry is gated once

`hive-store`'s `openEntity` is the single gate every "show me this session" path
now goes through — six components called `ui-store`'s `openTab` directly, which
is fine while every entity is openable and becomes six independent bugs the
moment one is not. Whether a session can be entered is a fact about the domain,
so the domain store decides it; the view store keeps its one job.

An unknown id is **passed through**, not refused: `resolve-view` already sends an
unknown `activeTab` to the orchestrator so that a session removed while its tab is
open leaves the user somewhere, and duplicating that decision here would put two
answers to one question in two files.

The console prints its refusal rather than swallowing it. A console that answered
`opened sess-02` and then did not open it would be worse than one that said
nothing.

### Refusing to re-enter is not the same as ejecting

A session that ends **while the user is watching it** stays on screen. The exit
notice is the most useful thing in the transcript, and yanking the view out from
under someone the instant their agent quits would make the ending impossible to
read. The gate is about coming back, and defect 4 is what makes leaving possible.

The table row becomes `disabled` rather than silently inert — a button that looks
live and does nothing is worse than one that says it is spent, and `disabled` is
the only version of that a screen reader hears too. The `title` carries the why.

## Not in this story

- **Restarting a terminated session.** `restartSession` and `reopenChannel`
  already exist (096) and nothing in the UI calls them. A terminated row is the
  obvious place to put that button; deciding what it does to the transcript, and
  to a `done` fixture that has no process, is its own story.
- **`waiting` from a real session.** Still not derivable from a pty. Unchanged.
- **Renaming the `sessionDone` notification preference.** The key is written into
  the user's config file; renaming it would silently reset the preference of
  everyone who had already turned it off. The status it answers to is now
  `terminated` and the wording changed to "Session ended"; the key did not.
