# HIVE-53 — Live terminal intermittently stops receiving keystrokes under load

**Date:** 2026-08-10
**Ticket:** HIVE-53 (Bug) · relates to HIVE-48 (Done), HIVE-79 (raised from this work)

## Verdict

**Not a product defect.** The keyboard path is sound under parallel load: keys
reach the focused terminal, the terminal keeps focus, and the pty stays healthy
throughout. The flake belongs to the spec, which announces the wrong event as
"the job is running".

Both mechanisms the ticket proposed are refuted by captured evidence, not by
argument.

## Evidence

A probe spec reproduced the Ctrl-C failure under the ticket's own condition —
six Electron apps in parallel — and recorded state at the moment the keystrokes
stopped landing.

**14 reproductions in 48 runs (~29%).** Every one identical:

| Measurement at failure | Value |
| --- | --- |
| `document.activeElement` | `textarea.xterm-helper-textarea` |
| `document.hasFocus()` | `true` |
| `webglcontextlost` events | 0 |
| window `blur` events / `focusout` records | 0 / none |
| terminal surfaces, canvases | unchanged — 3 canvases, no remount |
| keydowns delivered to that textarea | 667, **including `Ctrl+c`** |

Focus is never lost. Hypothesis 1 (WebGL context loss) predicted a context-loss
event: none occurred. Hypothesis 2 (environment focus loss) predicted focus on
`body` or outside the document: focus never moved at all.

### Where the interrupt goes instead

The fault was localised through the preload bridge, bypassing the keyboard. At
the moment of failure:

- a plain `echo … > marker` written straight to the pty **does not run**;
- `\x03` followed by the same `echo` **does**.

So `sleep 100` is still the foreground job and the pty is healthy. The interrupt
that was typed never took effect on that job.

### The mechanism

The spec's readiness marker is written by a shell **builtin**:

```sh
echo started > "$started" && sleep 100 && echo finished > "$finished"
```

`echo` runs before `sleep` exists. The marker therefore proves *the command line
ran*, not *a foreground job is running*. `Control+c` pressed in that window sends
SIGINT at a process group that is not yet the job; `sleep 100` then starts, and
the typed follow-up sits in the tty input queue behind it for 100 seconds. Both
markers stay absent — precisely the signature recorded on the ticket (`started`
present, `finished` and `after` absent).

Under parallel load the window widens, which is why it only reproduces there.

### Two controlled variants confirm it

| Variant | Reproductions |
| --- | --- |
| Current spec construct | **14 / 48** |
| Wait 1 s after the marker before interrupting | **0 / 12** |
| Marker written *inside* the foreground child | **0 / 24** |

HIVE-48 added the `started` wait to fix this very race. It did not, because
`echo` is a builtin — the wait was for the wrong event.

### The retracted explanation, doubly refuted

HIVE-48's note (already retracted on HIVE-53) attributed the loss to a
status-driven re-render remounting the message row. Beyond the reasons already
recorded, `center-stage.tsx:325` renders `<MessageInput>` only when
`!activeIsLive`, and this spec drives a live session — so the message row is
never mounted at any point during the test. There is nothing to remount, and
nothing to steal focus.

## Design

### 1. Fix the spec's readiness signal

```sh
sh -c "echo started > '$started'; sleep 100" && echo finished > '$finished'
```

The marker is written by the child that **is** the foreground process group, so
its existence proves that group exists. SIGINT then lands on a real job whether
it arrives during the `echo` or during the `sleep`, and the `&&` short-circuits
either way so `finished` still stays absent.

This is a principled fix rather than an empirically quiet one: it changes what
the marker *means*, which is what was wrong.

### 2. Delete the `terminal.click()` retry loop and both wrong comments

The ticket allows the retry to be "removed (defect fixed) or justified by the
recorded evidence". The evidence removes it: the click was never re-asserting
lost focus, because focus was never lost. The assertion returns to single-shot
and exact — press `Control+c` once, type the follow-up once, assert the shell
runs it and that `sleep 100` did not survive. That is a strictly stronger claim
than the retry loop made.

Both copies of the "status change re-renders the stage" comment
(`interactive-terminal.spec.ts:196-206` and `:215-221`) are replaced with the
mechanism established above.

### 3. Harden `onContextLoss` — deliberately defensive

`terminal-surface.tsx`'s context-loss handler disposes the WebGL addon and does
not re-assert focus. A focused terminal that surrenders its GPU context should
still be typable, and that invariant is currently held by accident rather than
on purpose.

```ts
const lost = addon.onContextLoss(() => {
  const hadFocus = document.activeElement === terminal.textarea;
  addon?.dispose();
  addon = null;
  if (hadFocus) terminal.focus();
});
```

**Stated plainly: this fixes nothing that is currently broken.** A forced,
genuine `webglcontextlost` was driven against a live session (via
`WEBGL_lose_context`); the event fires, the handler runs, and focus survives —
`document.activeElement` stays on the xterm textarea and typed keystrokes still
reach the shell. The change makes an accidental property intentional and guards
it against a future renderer change.

Consequently the guard is asserted where it can genuinely fail — the unit suite —
and the e2e spec is written as a regression guard that passes both before and
after. No test in this change is claimed to fail without it except the unit test.

### 4. Correct the record

- `interactive-terminal.spec.ts` — comments carry the real mechanism.
- HIVE-48 — its "A defect found on the way" note gets a correction comment.
- HIVE-53 — the description's stale line references and its claim that the xterm
  instance effect depends on `fontSize` (removed by story 105; the deps are
  `[container, readOnly]`) are corrected, along with the verdict.

Propagated with the `spec-deviation` skill.

## Testing

**Unit** (`tests/components/terminal/terminal-surface.test.tsx`):

- After a context loss, the terminal is re-focused when its textarea held focus.
  **Fails without the change.**
- After a context loss, the terminal is *not* focused when it did not hold focus
  — a hidden or unfocused surface must not steal the caret.
- The existing `'falls back to DOM when the context is lost'` spec still passes
  untouched.

**Playwright** (`tests/e2e/electron/interactive-terminal.spec.ts`):

- The Ctrl-C spec, rewritten: single-shot, no retry loop, no click.
- A new spec: a focused live terminal keeps receiving keystrokes across a forced
  `webglcontextlost`. Regression guard; passes before and after.

**Verification:**

- The rewritten Ctrl-C spec, 10 consecutive clean runs.
- The spec under 6-way parallel load — the condition that produced the flake —
  at the sample size that reproduced it 14 times before.
- `pnpm test`, `pnpm test:coverage`, `pnpm lint`, `pnpm type-check`,
  `pnpm verify:boundaries`, `pnpm test:e2e:electron`.

## Out of scope

- The bare-`←` fallthrough into Claude Code's own agent list — **HIVE-79**,
  raised from this work. Different mechanism: there the keystroke reaches xterm
  and is handed on to the pty; here it reached xterm and the app behaved
  correctly throughout.
- Changing which surface owns focus (story 095).
- Permanent focus/context telemetry in the terminal surface. Nothing in the
  evidence justifies shipping instrumentation for an event that fired zero times
  in 48 runs.
