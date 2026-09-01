# Agents and the ledger

**Scope:** two things that belong together — the **ledger**, one append-only log
every party in The Hive reads from and writes to, and the **agent definition**,
the file that makes a party an agent in the first place. **Owned by stories
HIVE-111 (the log), HIVE-112 (the MCP tools), HIVE-113 (delivery and the
console verbs), HIVE-114 (definitions) and HIVE-116 (the Agents tab and the
agent view).**

Load this when working on `electron/main/ledger/`, `electron/main/agents/`,
`electron/mcp-host/`, `electron/shared/{ledger,agent}-*`, the hook receiver's
two ledger routes, the renderer's mirrors of either (`use-ledger-sync.ts`,
`use-agents-sync.ts`, the `useLedger*` and `useAgent*` selectors in
`hive-store.ts`), the `ledger` / `ask` / `answer` console verbs, Settings ›
Agents, or the agents rail and `src/features/agents/`.

## What the ledger is

The overmind (the renderer, voiced through the coordinator identity
`OVERMIND`), every terminal session, and — from HIVE-112 on — every background
agent are all *parties*. A party posts, asks, answers, claims and releases by
appending one line to a single log. Nothing is ever edited: an `answer` closes
an `ask` by naming it, it does not rewrite it, and a `claim` is undone by a
later `release` rather than by deleting the claim. The log is the only record
of what happened, in the order it happened, and every reader — the console,
a resumed session catching up, a future skill — is reading the same document.

This is also why the log has no delete and no update verb at the IPC layer or
the HTTP one: giving either side a way to mutate history would make "what did
party X actually say" a question with more than one honest answer.

## On disk

Entries live under `~/.hive/ledger/`, one file per **local calendar day**:
`YYYY-MM-DD.jsonl`, one JSON object per line. Local time, not UTC, because
"today" is the user's day, not the server's — there is no server.

This sits beside `~/.hive/config.json`, not under Electron's `userData`. The
same reasoning `desktop-architecture.md` gives for the config file applies
here with more force: a correspondence log between a person and their agents
belongs somewhere the person can open, `grep`, and back up, not inside an
app-private directory they'd need Finder's "Show Package Contents" instinct to
find.

`createLedgerStore` (`electron/main/ledger/store.ts`) loads **today's file and
yesterday's** on start, in that order, then sorts by id. Yesterday matters
because an ask made late last night is still open the next morning — dropping
it from memory the moment the calendar rolls over would silently retire every
overnight question. The write path is synchronous `appendFileSync`, on
purpose: the session history writer nearby debounces because it rewrites a
whole document and the last write wins, but the ledger *adds a line*, and a
debounce here would mean a caller is told an entry's id before that entry is
actually on disk. A ledger whose reader and writer can disagree about what
happened has stopped being a ledger.

A malformed line — most likely the tail of a file the app was killed
mid-write, or a hand-edit of a file the user is invited to open — is
**skipped, not fatal**. It's collected in `malformed()` and reported on the
console (the file and the count, never the line: a ledger body is
correspondence) rather than thrown, because a half-written last line must not
cost the user every entry that came before it.

"Malformed" means *not an entry*, not merely *not JSON*. `null`, `123` and
`"x"` are all valid JSON, and one of them reaching the loaded array is worse
than a parse error: the sequence reseed reads `newest.id`, so a bare number
sorting last throws inside the store's constructor — which runs inside
`registerIpcHandlers()`, unguarded, at startup — and the app would boot with no
IPC handlers at all. So a line must also *be* an object with a string `id`, a
numeric `ts`, a string `from`, a known `kind` and a string `body` before it is
accepted, and its `to`, `ref` and `thread` must each be absent or a string:
`nextRef` calls `ref.startsWith(...)` over every loaded entry on each `ask`, so
a hand-edited `"ref": 3` would make *every* ask come back `500` — a worse
symptom to diagnose than a crash, now that a failed write is a refusal. `meta`
is left unchecked on purpose; it is free-form, and every consumer already reads
it defensively. Anything that fails joins the same skipped-and-warned list.

A read that fails for any reason other than the file not existing (EACCES, EIO)
is warned about rather than treated as an empty day, because "empty" would also
leave the sequence counter at zero while ids for this second already exist in
the file, which is precisely the collision the reseed exists to prevent. And a
*write* that fails — ENOSPC, a `~/.hive` moved out from under the app — comes
back from `Ledger.append` as a refusal value (`500`, with the cause named)
rather than as a throw, for the reason `LedgerResult` is a value at all: a
throw reaches the HTTP caller as a bodyless 500 and the IPC caller as a
rejected promise, and both were built to hand a model a readable reason.

## The two ids

Every entry carries a canonical `id`: `${yyyymmdd}-${hhmmss}-${seq4}`, e.g.
`20260828-141530-0001`. It's monotonic within a launch (the store seeds its
per-second counter from the newest id already on disk, so a restart inside the
same wall-clock second can't collide with what it just wrote) and it sorts as
a string in write order — which is what makes `since` a plain string
comparison rather than a parse-and-compare. `id` is what `thread` and `since`
always name. It is not something a person is expected to type.

`ask` entries additionally get a `ref` — a short handle like `a12`, allocated
by counting the highest existing ref among the entries the store already has
loaded (today plus yesterday) and adding one. This exists for exactly one
reason: a human answering a question in the console can hold `a12` in their
head; nobody holds `20260828-141530-0001-1` in theirs. Refs are cheap to reuse
across a quiet day because a ref only has to be unambiguous among *currently
open* asks, and an ask that's aged out no longer needs one.

`ledger.answer` accepts **either** form in its `thread` field —
`resolveRef` (`electron/shared/ledger-derive.ts`) checks for an exact id match
first, then a ref match — and always stores the resolved canonical id, never
the ref, in the written entry's `thread`. That's what keeps `thread()` (the
function that reconstructs a whole conversation) a simple `id === x || thread
=== x` filter: if refs could also appear in a stored `thread`, every reader of
history would need to know how to resolve them too, forever, even after the
ref itself has been forgotten.

## The party rule

`from` is never read out of a request body — on **either** path in.

- **Over IPC**, the renderer's `window.hive.ledger.post` and `.answer` don't
  even have a `from` parameter in their type (`Omit<LedgerPostRequest,
  'from'>`). `electron/main/ipc/index.ts` supplies `OVERMIND` itself when it
  calls `ledger.append` / `ledger.answer`. The renderer is the overmind's only
  mouth, and there is nothing to strip because there is nowhere to put it.
- **Over the receiver** (`electron/main/hooks/receiver.ts`), a session or
  agent process posts JSON that *may* contain a `from` field, and
  `parseLedgerPostBody` (`electron/shared/guards.ts`) throws it away before it
  reaches the handler. The caller's real identity comes from the
  `x-hive-session` header, which `handleLedgerPost` and `handleLedgerRead`
  read and pass down as `caller` — the same header, the same discipline, every
  route on this socket already uses to attribute a hook event.

Put together: no party can post, or answer, as another party. A compromised or
merely buggy caller can misbehave as *itself*, and the log will say so
truthfully — it can never misbehave as someone else.

Two rules in `Ledger.append` exist because an entry written truthfully as
yourself can still change *someone else's* derived state, which would defeat
that guarantee from the other side:

- **Only a party to a thread may answer it.** `openAsks` retires an ask on any
  answer naming it, so a session that merely saw a question could close it and
  the party it was addressed to would never see it. The answerer must be the
  ask's recipient, its author, or the overmind; a broadcast ask (no `to`) is
  addressed to everyone, so anyone may answer it. Refused `403` otherwise.
- **Only the holder may release a claim.** `claims()` deletes on any `release`
  naming the task regardless of who wrote it, so a release from a third party
  moves the task exactly as if it had posted as the holder. Refused `403`.

There is deliberately no matching rule for `claim` itself — see *Derived state*
below.

And one for the same reason on the way out: `Ledger.answer` addresses its entry
`to` the asker rather than leaving it absent. An absent `to` is a broadcast, and
`visibleTo` in the receiver treats a broadcast as readable by everyone, so an
answer with no addressee would publish the overmind's reply to one session's
private question to every other session.

### A live run stays a party even while its file is broken

`knowsParty` answers out of `knownAgents` — a `Set` in `ipc/index.ts`, because
`Ledger.append` is synchronous and cannot await a folder listing. It is rebuilt
from the registry on every `agents.onChange`, keeping only definitions that
currently parse, **plus every name in `runs.live()`**.

That last clause is not defensive coding, it is the epic's own premise: an
agent is meant to be edited in a text editor while it works, and a save
mid-edit routinely lands a file that does not parse. Without it the name leaves
the set the instant that file is saved, and everything the running child does
next is refused as an unknown party — its hooks 404, its `ledger_*` tool calls
come back refused, and at close the tracker's own `run.ended` append is
rejected, leaving a `run.started` with no end in a log that is supposed to be
the record of what happened. A refused append from the tracker is therefore
also logged rather than discarded, because that failure is otherwise completely
silent.

## Delivery

The ledger records; it does not tell anyone. `electron/main/ledger/deliver.ts`
is the first rule on top of it (HIVE-113): an `ask` or an `answer` addressed to
a **live session** is written into that session's terminal as one line, through
the same `sessions.write` primitive `send` uses. The trailing `\r` submits it,
which is the intent — the nudge becomes a turn the agent takes.

Two constraints shape it.

It writes **only at an empty prompt**. Main learns this from the hook stream:
`SessionsOptions.onIdle` fires when a derived status of `idle` coincides with
`held(id).bgShells === 0`, and `Sessions.isIdle` answers the same question for a
caller arriving between events. Both halves are load-bearing. A session showing
a permission prompt derives `waiting`, not `idle`, so it is excluded — that is
the whole of "never write mid-turn". And a turn that ended while a backgrounded
shell is still running *does* derive `idle`, with `detail: 'script'`, so the
status alone would say yes to a session that is still working.

And it **never loses a nudge**. Every line that lands is recorded as an `event`
entry carrying `meta.delivered`, which turns "what does this session still owe a
reading of" into a query against the log rather than a queue in memory. That
choice pays for itself three times: a restart cannot drop a pending nudge;
`publishReady` is deliberately not idempotent — `/clear` fires a second one —
and the duplicate costs a read rather than a second line in the terminal; and
the log answers who was told what, and when.

The receipt is written **after** the write and only if the write landed, which
is why `DeliverOptions.write` returns a boolean rather than `void`. The session
layer is reached through a nullable binding in `ipc/index.ts` — it is
constructed after the ledger — and a receipt for a nudge that never reached a
terminal would suppress the retry forever, leaving a question nobody was asked
and a log claiming they were.

`onEntry` ignores every kind but `ask` and `answer`. **That is a loop guard, not
a filter**: deliver subscribes to `ledger.onChange` and also appends to the same
log, so without the gate each receipt would re-enter it and it would feed
itself.

An entry addressed to the overmind is an inbox card (HIVE-118), not a terminal
line; one addressed to an agent is a wake (see below); a broadcast wakes nobody,
because parties read those on their own schedule.

### Wakes

`electron/main/agents/scheduler.ts` is the third consumer of that same
`ledger.onChange` — an agent has no terminal to nudge, so an entry addressed to
one starts a run instead. The decision itself is a pure function in
`scheduler-rules.ts`, so every state × kind pair is a test rather than a
scenario:

| Agent status | An addressed entry |
| --- | --- |
| `sleeping`, `asking`, `failed` | wakes it now |
| `working` | queues on `pendingWake`; flushed when the run closes |
| `paused` | held on `pendingWake`; flushed on resume |

The waking kinds are `ask`, `answer`, `done`, `failed` and `post`. `done` and
`failed` are there because they are how an asker takes its question back, so an
agent waiting on a thread learns it was abandoned. `event` is excluded, and the
exclusion is the same loop guard `deliver.ts` applies: the scheduler appends to
the log it subscribes to, and every wake writes a `run.started` and a
`run.ended`.

**`wake.on: [ledger]` is a gate, and it is checked first.** Settings promises
that unticking it means "a question addressed to it waits unread until then", so
an agent without it is neither woken nor queued against. The subscribed names are
cached in `ledgerAgents` beside `knownAgents`, because the scheduler is consulted
synchronously from inside `Ledger.append`. Unlike `knownAgents`, a live run does
not widen it: that exception exists to keep a running agent's writes accepted when
its file stops parsing mid-edit, and says nothing about what its author asked for.

Nothing stops two agents waking each other through `post` — A posting to B, which
posts back to A, is bounded only by each run's `--max-turns` and
`--max-budget-usd`. A cooldown is the obvious answer if it is ever seen in
practice; it is not built.

Wakes go through `RunTracker.run`, never the waker directly. That method is the
one door every trigger passes and it is where a paused agent is refused; a
second entrance would let a ledger entry start an agent the user had just
stopped.

**A run that closes into `paused` keeps its queue.** HIVE-117 lets a pause land
mid-run — the turn finishes and `finalizeRun` holds `paused` — so an entry
queued while the agent was `working` can face a paused agent by the time the run
closes. `onRunClosed` therefore re-reads the status from `agents.json` rather
than trusting what the queue was filed under: flushing there would reach
`refused: 'paused'` and drop entries whose asks are still open. `onResume`
delivers them instead.

The queue is persisted rather than held in memory, because the failure it
prevents is silent — a quit drops an in-memory queue and nothing would ever
bring the agent back. That makes one more flush necessary: `agents.json` is read
at boot through `wakeFromWorking`, which rewrites `working` to `sleeping`, so a
queue left by a crashed run has no run to close and no resume coming.
`scheduler.start()` is what delivers it, and it is armed **behind**
`mcp.start()` — a wake needs an argv, and `buildWakeCommand` refuses to build one
until the MCP config is on disk, so arming it synchronously would put every
restored queue through a refusal at the one moment that refusal is guaranteed.

Every flush clears the queue **before** waking, so a synchronous spawn failure
re-entering `onRunClosed` finds nothing rather than looping — and **puts it back
when the wake is refused**, because `RunTracker.run` refuses `working`, `paused`
and an unbuildable command without ever reaching `onRunClosed`. A refusal is a
delivery deferred, not a question lost; an immediate wake that is refused queues
for the same reason.

`stop()` sets a flag that every entry point honours, not just the interval. Both
teardowns call it **before** `RunTracker.closeAll`, which finalizes each live run
synchronously and so re-enters `onRunClosed` — where a flush would spawn a fresh
`claude` after `closeAll` had finished iterating, leaving an orphan with nobody
left to signal it.

### Time passed (HIVE-121)

The other half of the same module, on the same timer. `onEntry` answers
*something happened*; `tickSchedules` answers *the clock moved*, and it runs
inside the sweep's existing sixty-second interval — one timer, two jobs, in the
module that already owned it.

**It polls `nextRunAt` rather than arming a timer per agent, and that is the
load-bearing decision.** `nextRunAt` is already persisted in `agents.json` as a
wall-clock timestamp. A per-agent `setTimeout` keeps that same truth a second
time, in memory, where a quit or a lid-shut sleep makes the two disagree — and
the persisted one is the one that survives. Polling leaves exactly one
representation of when a wake is due, so four requirements stop being code:

- a missed window wakes **once**, however long the app was closed, because one
  overdue timestamp is one wake rather than a backlog to replay;
- pause and resume are a status the tick already declines to act on;
- `stop()` clears one interval, which it already did.

Two things it does **not** make free, and both were found by review rather than
by reasoning:

**A definition change still needs reconciling.** Re-reading the schedule each
tick is not the same as re-arming: a persisted `nextRunAt` outlives the interval
that produced it, so shortening `every: 6h` to `every: 5m` would otherwise sit
out the original six hours. The tick therefore clamps `nextRunAt` **down** to
one interval of the current schedule — downward only, because a *lengthened*
interval still owes the wake it already armed. The clamp sits below the quiet
and cap branches, which both `continue`, so it can never fight a deliberate
deferral.

**The tick has to know the difference between "no schedule" and "not listed
yet".** The schedule map is filled from an unawaited `agents.list()` — a folder
walk parsing every `AGENT.md` — while `scheduler.start()` ticks synchronously,
and the walk routinely loses. Read as "nothing is scheduled", an empty map would
have the clearing branch destroy every agent's overdue `nextRunAt` on the launch
right after a missed window, which is precisely the one it exists to spend. So
`schedules()` answers `undefined` until the registry has answered once, and the
tick does nothing at all until it has.

**And the roster is the schedule map, not `agents.json`.** That file gains an
entry when an agent *runs*, is paused, or is queued against — never when a
definition is merely saved. A tick walking run state alone would never see an
agent authored in Settings and left alone, which is this feature's main path, so
the tick walks the union of both.

The cost is that a wake can be up to `LEDGER_SWEEP_MS` late. The grammar's floor
is one minute, so no precision a definition is able to *express* is lost.

**Who takes a scheduled wake.** `sleeping` and `failed` do — a failed run is not
a paused agent. `working` skips rather than queues: one run at a time, and the
next tick is a minute away. `paused` is the user's decision. `asking` ended its
turn waiting on a reply, and the reply is its wake, which is why
`describeNextRun` draws `on answer` for it. An `asking` agent keeps its stale
`nextRunAt` deliberately: when the answer moves it, the next tick finds one
overdue time and spends it as a single catch-up wake.

**Quiet hours defer to the window's end**, not to the next interval, so a
five-minute agent does not spend the night re-deciding to stay asleep. A
deferral is **not** a skip — a silence the author asked for is not the fact
"nothing changed", and counting it would have a nightly agent reading
`skipped 96` every morning for working perfectly. Only interval mode can reach
that branch: `parseAgent` refuses a `wake.at` time inside the window, so a
calendar agent's times are outside it by construction.

**`check: onchange` looks for an addressed entry newer than `lastRunAt`, or a
standing `pendingWake`.** It is deliberately not gated on `wake.on: [ledger]`.
That gate decides whether an entry *wakes* the agent; it does not decide whether
the entry is a change worth waking for on a schedule the author did set — the
field's own help promises a question "waits unread until the next scheduled
wake", and this is that wake arriving to read it. HIVE-124's pending-event
counter is a third source when it lands; Slack search-on-schedule agents set
`check: always` because their change lives outside the log entirely.

**A refused wake arms the next time and leaves the skip count alone**, because a
refusal is a wake deferred rather than a quiet tick. That refusal is also what
keeps this tick from racing HIVE-119's deferred permission wake: both doors are
`RunTracker.run`, so whichever arrives first leaves the agent `working` and the
other is turned away.

**Every tick that changes a row pushes it.** `RunTracker` pushes when a run
starts and ends, which covered everything the ledger half caused — but the tick
changes rows with no run attached, and those are exactly the changes somebody
watching an idle agent is waiting to see. A tick that finds nothing due writes
nothing and pushes nothing.

### The day's ceiling

`limits.daily_usd` is enforced by the tick, not on the command line:
`--max-budget-usd` caps one wake, and the binary knows nothing about days.

The number it is compared against is **accumulated** in `agents.json`
(`AgentRunState.today`), not summed from `runs[]`. That array is capped at
`AGENT_RUN_HISTORY` — twenty — and a five-minute agent takes 288 wakes between
midnights, so a ceiling derived from it would stop biting exactly where it
matters. This is a departure from the rule stated on `AgentSummary.runs`, that
main never precomputes "today": the rule holds for *display* and cannot hold for
*enforcement*, because a ceiling cannot be derived from a truncated array. What
is stored is the day the totals belong to, never the claim that it is today, so
`runsToday` still decides that on read from the shared `dayKey`.

The accumulator is replaced wholesale when the day turns over, which is the
entire reset mechanism — nothing anywhere arms a midnight timer, and `capped`
rides along only as long as the day does. A capped agent's `nextRunAt` is the
next local midnight, and the card is posted once rather than every minute for
the rest of the day.

**Scheduled wakes only.** A ledger entry and a manual run still reach a capped
agent, because this is a budget for unattended work rather than a lock. The card
is an `agent.failed` titled "Hit its daily cap" — its own branch in `notify.ts`,
above the run-receipt path, because that path consumes `spokenFor` on any
outcome and this event is not a run receipt.

The event is posted by the **overmind**, not by the agent, and `notify.ts` gates
on that. `meta` is a free-form rider any party can write, so a card keyed off an
agent's own `from` would be one any agent could mint for itself — with a body it
also writes — by posting a single event. It is the same reason the expiry event
is the overmind's: main is what took the decision, so main is what reports it,
and the agent it concerns rides in `meta.agent`.

### Expiry

An ask nobody answers dies on a timer. `LEDGER_ASK_TTL_MS` is a day, and an ask
may shorten its own deadline with `meta.ttlMs` — never lengthen it, or an entry
could keep the inbox from ever emptying. `ttlOf` in `ledger-derive.ts` is the
one answer both `openAsks` and the sweep read, so the inbox and the sweep cannot
disagree about when a question stops being one.

The sweep runs once a minute and reads `expiredAsks`, **not** `openAsks` —
`openAsks` drops an ask the instant it crosses the ttl, so the entries the sweep
is looking for are precisely the ones that function hides. For each it appends
`event { from: 'overmind', to: <asker>, thread: <ask>, meta: { expired } }` and,
if the asker is an agent, wakes it — through the same wake-or-queue path an
arriving entry takes, rather than routing that event back through `onEntry`,
which would mean waking on events. Going through the queue matters: the expiry
event is on disk by then, so a wake refused because the asker was mid-run or
paused would lose the news permanently.

**The write is the dedup, so a failed append is not followed by a wake.**
`Ledger.append` reports failure as a value; ignoring it would re-expire the same
ask every sixty seconds for as long as the disk stayed unwritable.

The event does not close the ask; `expiredAsks` dedupes on the event's own
presence, which is what makes the sweep idempotent across restarts while keeping
no state of its own. Only an expiry **from the overmind** counts, in the derive
and in the notifier alike: `meta` is a free-form rider any writer controls, so
without that check a forged `meta.expired` would dismiss another party's card and
permanently suppress the real expiry. The card is dismissed rather than marked
expired in place: the thread is closed, so `Ledger.append` refuses every button
the card offers.

### Notifications

`electron/main/ledger/notify.ts` is `deliver.ts`'s counterpart for the
overmind's own copy: one function, `entry => void`, wired to the same
`ledger.onChange`, deciding what — if anything — becomes an inbox card. The
notification's id **is** the ask's entry id, which is what makes answering
cheap: an `answer` names its thread, the thread *is* the notification, and
there is no lookup table to keep in sync.

| Entry | Effect |
| --- | --- |
| `to === 'overmind'` and `kind === 'ask'` | raise `agent.ask`, or `agent.permission` when `meta.kind === 'permission'`; the notification's id is the entry's id, and its `subject` is the asker |
| `kind === 'answer'` with a thread | the ask's card is marked read |
| `kind === 'done'` or `kind === 'failed'` with a thread | the ask's card is dismissed — and `openAsks` closes the ask itself, so the two agree |
| `kind === 'done'` from an agent | raise `agent.done` |
| `kind === 'failed'` from an agent | raise `agent.failed`, and that agent is recorded as having spoken |
| `kind === 'event'` carrying `meta.expired` | the expired ask's card is dismissed — ahead of the row below, because this one comes from the overmind |
| `kind === 'event'` from an agent whose `meta.outcome` is `failed`, `budget` or `turns` | raise `agent.failed`, unless that agent already spoke |

`run.ended — done` and `run.ended — asking` mint nothing. `done` is covered by
the agent's own report rather than the run's receipt — an agent's report is
news because it chose to make it, and the receipt only speaks when the agent
could not (a turn cap, a budget cap, a kill, a stall) — and `asking` is already
the ask card raised above; a second notification for the same fact would be
noise, not news.

`ledger_ask` takes two optional arguments that together turn a bare question
into a draft awaiting approval: `options`, the closed set of answers offered
as buttons, and `quote` (HIVE-118), the draft itself — the exact text the
agent wants to send. Both fold into `meta` in the tool handler, guarded the
same way (`Array.isArray` for `options`, `typeof === 'string'` for `quote`) so
a malformed argument is dropped rather than written through. The inbox card
(`ask-card.tsx`) reads `meta.quote` to decide whether to render a plain
question or a quoted block above the buttons, and titles the card "Send this
reply?" instead of the asker's own title (`notify.ts`). Approving the draft
unedited answers with the clicked option's own text; clicking the option
named exactly `edit` (case-insensitive — not merely one that starts with
those letters, which would hijack a model's own more descriptive copy)
instead opens the quote in a text field seeded from it. Sending that answers
with the asker's **own** affirmative — the first option that is neither the
edit affordance nor a refusal, falling back to `approve` only when the ask
offered nothing usable — and carries `meta.edited` with what the overmind
changed it to, so the agent that reads its answer back can tell a rubber stamp
from a rewrite and can still match the body against the closed set it offered.

A click on an ask's **toast** does not answer it and does not dismiss its row:
it reveals the card. Main sends `{ type: 'ask' }` on `notifications:activate`
— the same channel a session's click uses, widened into a union — and the
renderer answers it with `revealRailTab('inbox')`, because main may not touch
the rail and the rail can be sitting on another tab or collapsed outright.

## The console verbs

The overmind's own mouth is three verbs in the orchestrator console —
`ledger`, `ask` and `answer` (`src/types/command.ts`,
`features/orchestrator/utils/parse-command.ts`, `runOrchCommand`).

`ledger` reads the renderer's **mirror**, not IPC: `runOrchCommand` is
synchronous and `use-ledger-sync.ts` already keeps that slice current, so an
`invoke` would make the verb async to fetch what is in memory. It filters
through the same `matches` and `openAsks` main uses, so the console and the log
cannot drift apart about what "open" means. Rows are drawn by
`src/lib/ledger/console-rows.ts` — its own module rather than three more helpers
in a five-thousand-line store, and column arithmetic worth asserting directly.

Delivery receipts are folded out of the default tail and shown by
`ledger --events`. The filter keys on `meta.delivered`, **not** on
`kind === 'event'`, so the expiry events HIVE-120 adds will not be swept up by
the same rule.

`ask` differs from `send` in one deliberate way: it does **not** refuse an ended
session. `send` must, because a cleared row's terminal is inherited by its
successor and the message would be typed into a different live agent's prompt.
An ask addresses an id in a log rather than a terminal, so it is held and
flushed when that id comes back — which is the one case the hold-and-flush rule
exists for.

## Derived state

Two questions get asked constantly and answered nowhere on disk: *is this ask
still open*, and *who holds this task*. Both are computed, not stored, by pure
functions in `electron/shared/ledger-derive.ts`:

- **`openAsks`** — an ask is open until something *closes* it, or until
  `LEDGER_ASK_TTL_MS` (24h) has passed since it was made, whichever comes
  first. Three kinds close a thread they name: an `answer` (the question got
  its reply), a `done` ("the ask this completes") and a `failed` ("the ask
  this abandons") — the asker taking its own question back. Both halves matter
  on their own: without the TTL, an ask whose asker died (a session that
  crashed, a terminal that was closed) stays open forever and the inbox never
  empties; without the closing check, a thread would close on a timer while
  someone is still owed a reply.

  `done` and `failed` are the same rule as `answer` on purpose, and
  `ledger/notify.ts` dismisses the card for all three symmetrically. Left
  apart, the two halves disagreed on screen: a `done` dismissed the card while
  the ask stayed open, so the left rail's Agents badge — counted off the
  ledger, immune to notification state — stayed lit with nothing behind it;
  and a `failed` closed nothing at all, so the user kept a live card whose
  buttons `append` would refuse.
- **`claims`** — a task is held by whichever party's `claim` entry (naming
  the task in `meta.task`) is the most recent one with no later `release` for
  that same task. **The ledger records claims; it does not arbitrate them.**
  Nothing here or in `append` refuses a second `claim` on a held task, and
  nothing should: the tool layer's `ledger_claim` (HIVE-112) reports the
  current holder back to the caller rather than failing, so a losing claim is
  a fact worth having on the record. First-writer-wins, where it applies, is
  that layer's policy — `claims()` reports the state it produced and has no
  opinion about who should have won. The one thing this layer *does* enforce
  is that a `release` comes from the holder, and it enforces it in
  `Ledger.append` rather than here, because `claims()` reads the log and
  `append` decides what may enter it.

`ledger-derive.ts` lives in `electron/shared/`, not beside `ledger/store.ts`
in `electron/main/`, for a structural reason rather than a stylistic one:
`src/**` may not import `electron/main/**` — that's an ESLint-enforced
boundary, not a convention — and the renderer's own selectors
(`useOpenAsks`, `useOpenAskCount`, `useThread` in `src/stores/hive-store.ts`)
need exactly these same rules to stay in sync with what main computes from the
authoritative log. Two copies of "what counts as open" would drift the first
time one of them changed; one function main and the renderer both import
cannot. It qualifies for `electron/shared/` the same way `guards.ts` does:
pure, dependency-free logic with no runtime imports and nothing Node- or
DOM-specific in it — see the note on that file below.

## The routes

The hook receiver (`electron/main/hooks/receiver.ts`) — the same loopback
HTTP socket Claude Code's hooks and the status line already post to — adds two
ledger paths:

| Route | Purpose | Success | Refusals |
| --- | --- | --- | --- |
| `POST /ledger` | Append an entry | `200 { id, ref? }` | `403` bad token, an `answer` from a non-party, or a `release` from a non-holder · `400` missing session header, unknown `kind`, unknown `thread`, or an `answer` whose thread is not an open ask · `404` unknown session or unknown party · `413` over `LEDGER_BODY_MAX` or the transport cap · `500` the write itself failed |
| `POST /ledger/read` | Read a filtered snapshot | `200 LedgerSnapshot` | `403` bad token · `400` missing session header or malformed query · `404` unknown session · `413` over the transport cap |

**Both are POST, including the read.** This server has never parsed a query
string, and every other route on it is POST-only too — a `LedgerReadQuery` is
a small typed shape, and sending it as a JSON body means the read route needs
no query-string parser and no method-specific routing that the rest of the
receiver doesn't already have. It also keeps the read symmetric with the
write: same headers required, same body-truncation handling, same reply
shape (`{ status, json }`).

There are two distinct `413`s worth telling apart. The **transport** cap
(`HOOK_MAX_BODY_BYTES`, 64 KiB) is enforced by the socket itself before a
handler ever runs — past it the body is truncated and the ledger routes
refuse outright, unlike the hook path's own route, which drains and proceeds
on a truncated body because losing a `waiting` flag there is worse than a
silent cut. The **domain** cap (`LEDGER_BODY_MAX`, 16 KiB) is enforced inside
`ledger/index.ts`'s `append`, against the parsed `body` field specifically —
a caller here is a model waiting on a result, and a write it believes
succeeded but was quietly truncated is the failure mode this route can't
accept.

## Who reaches it, and how

Two callers, one `append`:

- **The renderer**, over IPC (`CH.ledgerList` / `ledgerPost` / `ledgerAnswer`
  / `ledgerChanged`). This is the overmind's own path — no header, no token,
  because it's a same-process call already gated by `assertSender`, and
  `from` is supplied as `OVERMIND` by the handler rather than accepted from
  the payload (see *The party rule* above).
- **Out-of-process callers** — a terminal session's hooks today, and from
  HIVE-112 an MCP host acting for a background agent — over the receiver's
  two HTTP routes, authenticated by the per-launch token and identified by
  the `x-hive-session` header.

Both land on the same `Ledger.append` / `Ledger.read` in
`electron/main/ledger/index.ts`, which is deliberate: there is exactly one
place a rule about what may be written can be stated, and exactly one place
it can be broken. **Every** write rule therefore lives on `append` — including
the ask-openness rule, which `Ledger.answer` also states for the ref-naming
error message it can give but does not own: `answer` is reachable from IPC
alone, and the out-of-process party this log exists to serve arrives through
`append`. Since `openAsks` closes an ask on *any* answer naming it, a rule
enforced only on the IPC path would let a bogus or duplicate answer silently
retire a question.

`ledger.onChange` then pushes every entry, from either path, straight to every
window as `CH.ledgerChanged`. The renderer's `useLedgerSync` hook
(`src/features/shared/hooks/use-ledger-sync.ts`) subscribes to that channel and
hydrates from `ledger.list()` at the same time, letting the two overlap:
`hydrateLedger` **merges by `id`** rather than replacing, so an entry appended
after main took its snapshot is neither dropped nor duplicated. That matters
more than it looks — the hook mounts once at the composition root and never
remounts, so an entry a replace discarded would never be re-fetched.

### Read visibility is asymmetric, on purpose

`ledger.read` itself returns the *whole* matching slice — no party filtering.
Two very different things wrap it:

- **The IPC handler** hands that back to the renderer unfiltered. This is
  correct, not an oversight: the renderer *is* the overmind, and the overmind
  is a party to everything by definition — there is no entry in this log the
  coordinator isn't meant to see.
- **The receiver's `handleLedgerRead`** applies `visibleTo(caller, entry)`
  to the result before it goes back over the wire: an entry is visible to a
  caller if it's addressed to them (`to === caller`), broadcast
  (`to === undefined`), or from them (`from === caller`) — so a session can
  always see its own questions even though they're addressed `to: overmind`
  rather than to itself. This filter is applied at the receiver, independent
  of whatever the query itself asked for, so a query that names another
  party in its own `to` can narrow what a caller sees but can never widen it.
  An out-of-process party gets to read the correspondence it's part of; it
  does not get to read everyone else's.

  Which is why the query reaches `ledger.read` **unmodified** — `hooks/index.ts`
  passes it straight through rather than defaulting `to: caller`. That default
  is strictly narrower than `visibleTo` and drops the `from === caller` half of
  it, so with it in place no query at all let a session read back its own ask.
  Narrowing belongs to the caller's own query; the security filter is the one
  the receiver applies afterwards.

`claims`, however, is **never** filtered — every caller, on both paths, sees
the whole map. A claims map only prevents double-claiming if every party can
see every claim; filtering it down to "claims I can see" would let two
sessions each believe they're the only one holding a task that a third party
already has.

## The MCP host (HIVE-112)

Every `claude` session The Hive launches is handed `--mcp-config` pointing at
a generated file (`electron/main/mcp/config.ts`) naming one server: the built
output of `electron/mcp-host/`, run as `${execPath} out/main/mcp-host.js`
with `ELECTRON_RUN_AS_NODE=1` so the app's own binary runs it as plain Node
instead of booting Chromium. `claude` starts one host process per session and
keeps it for that session's life — it talks JSON-RPC over stdio, the same
protocol shape every MCP server speaks, hand-rolled here because the surface
is nine tools and did not justify a dependency.

**Identity comes from the environment, not from an argument the host could be
handed on the command line.** Three variables, all set on the session's own
`env` before `claude` is spawned — `HIVE_SESSION_ID`, `HIVE_HOOK_TOKEN`, and
`HIVE_RECEIVER_URL` (the receiver's `origin`, *not* its `url`: `url` is
`origin + '/hook'`, a fixed path for the hook route alone, while the host
builds its own request paths from `@shared/ledger-contract`'s
`LEDGER_POST_PATH` / `LEDGER_READ_PATH` onto whatever base it's given — handing
it `url` would make every ledger call 404). None of the host's tools accepts a
`from` argument, so a model calling them has no way to name a session other
than its own — that is a property of the **MCP tool surface**, reading
identity out of the environment the app itself controls, not a transport-level
guarantee: the receiver's per-launch token is shared by every session it
spawns (HIVE-111), so a model with shell access could still `curl` the
receiver directly using another session's header value. Closing that is
tracked separately, not attempted here. If any of the three is missing — the
process was started outside The Hive, or by hand in a plain terminal —
`createHandlers` still lists all nine tools (so
`/mcp` shows a connected server, not a broken one) but every *call* answers
with a sentence explaining why the ledger is out of reach, rather than the
server refusing to start.

The host reaches the ledger the same way a session's hooks do: **both
receiver routes are POST**, and the host's `ReceiverClient` (`client.ts`)
calls them with the same two headers the hook path uses
(`x-hive-session`, `x-hive-token`) and the same per-launch token.

**The nine tools, one ledger kind each:** `ledger_post` → `post`,
`ledger_ask` → `ask`, `ledger_answer` → `answer`, `ledger_claim` → `claim`,
`ledger_release` → `release`, `ledger_done` → `done`, `ledger_failed` →
`failed`, `ledger_handoff` → `handoff` (HIVE-122), and `ledger_read`, which
takes no kind — it is the one tool that reads rather than appends.
`ledger_claim` and `ledger_release` still write
through `client.post` under the hood; they are separate tools rather than
`kind` arguments to `ledger_post` because their argument shape (a bare `task`)
and their response text (naming the previous holder, if any) are specific
enough to earn their own schema.

**A refusal is a result, not a protocol error.** The MCP spec draws that line
deliberately: a JSON-RPC error tells the client the *call itself* was
malformed and the model never sees the text, while a tool result with
`isError: true` is handed to the model to read and act on. Every refusal the
receiver can give — `403` bad token, `400` unknown thread or missing session
header, `404` unknown session, `413` over the body cap, `500` a write that
failed — surfaces this way, worded with the receiver's own `reason` (`client.ts`
falls back to a transport-failure sentence if the receiver couldn't be reached
at all, and to a generic one if a refusal came back with no `reason` field).

**Naming: `mcp__hive__<tool>`, not `mcp__plugin_hive_hive__<tool>`.** Claude
Code derives the middle segment of every tool's fully-qualified name from how
the server was delivered — the short form is what a server named in
`--mcp-config` gets; a server delivered through `--plugin-dir` would double the
name (`hive` as the plugin, `hive` again as the server inside it). HIVE-115's
preamble and HIVE-119's `--permission-prompt-tool mcp__hive__approve` both
hardcode the short form, which is the whole reason `--mcp-config` was the
delivery mechanism this story chose over a plugin.

**The read cursor lives for the process, not the ledger.** `createToolHandlers`
(`tools.ts`) closes over one `cursor` variable — the id of the newest entry the
host has handed back — and defaults `since` to it on every `ledger_read` that
doesn't name its own. It is deliberately never persisted: since `claude`
starts one host per session and keeps it for that session's life, the cursor's
life is exactly the session's life, and a cursor that survived a restart would
mean a session coming back after a crash silently skipped whatever arrived
while it was down. The bound (`LEDGER_READ_DEFAULT_LIMIT`, 50) only applies
when there is no cursor yet and no explicit `since` — the very first read of a
process — so a session opened against months of ledger history isn't handed
all of it in one tool result.

Proved against a real `claude` binary in `tests/live/ledger-conformance.test.ts`
(`pnpm test:ledger`): that the binary actually loads the generated config and
finds nine tools named the short way, that the identity in the environment —
not anything the model typed — is what lands in a written line's `from`, and
that a refusal's reason reaches the model as readable text.

## Agent definitions

An agent is a file before it is anything else: `~/.hive/agents/<name>/AGENT.md`,
frontmatter over a markdown body, sitting beside `config.json`, `skills/` and
`ledger/` for the reason all of those do — a definition is a document the person
is invited to open, `grep` and back up, not an app-private artifact.

HIVE-114 defines the file, teaches main to read, validate and watch a folder of
them, and gives Settings a place to author them. HIVE-115 added the **waker**:
one headless `claude -p` child per wake (`electron/main/agents/waker.ts` spells
the argv, `runs.ts` tracks the process), its `stream-json` stdout folded into
run-log lines by `run-log.ts`, the run closed on the child's `'close'` event,
and the session uuid, cost, turn count and outcome persisted to
`~/.hive/ledger/agents.json` by `state.ts`.

HIVE-116 drew the run, and HIVE-121 made the schedule real: `wake.every`,
`wake.at`, `wake.days` and `wake.quiet` are no longer declaration only — the
scheduler's tick reads all four, and `wake.check` and `limits.daily_usd` joined
the grammar to bound what that costs. The sections below record what the command
line enforces, what the scheduler enforces, and the few things still waiting.

### One table, three requirements

`AGENT_FIELDS` in `electron/shared/agent-contract.ts` lists every legal key with
its kind and its validator. Three requirements that look separate collapse into
that one artifact:

- **An unknown key is rejected**, not ignored — which is simply *no entry
  matched*, rather than a second key-set to keep in step.
- **A problem names its field**, and the name is a table path, so a refusal can
  never point at a control the form does not render.
- **The form is generated from the same table**, so the two cannot drift.

The reader and the patcher live in the contract rather than under
`electron/main/agents/` because the Settings form needs both at runtime and
`src/**` may not import `electron/main/**`. One reader is what stops the pane
and main disagreeing about what a file says.

### The comment rule

**Two or more spaces before `#` begin a trailing comment. One space does not.**

This is the single most surprising line in the grammar and it is not arbitrary.
Three readings of `#` have to be correct at once, and the obvious "space-hash
starts a comment" silently truncates the first:

| Line | Correct reading |
| --- | --- |
| `description: Watches #incorp-dev and my mentions.` | part of the value |
| `icon: ChatCircleDots        # a Phosphor name` | a comment |
| `on: [ledger, slack.channel:#incorp-dev]` | part of the value |

### What `wake.on` names, and who names it

Three shapes, and all three strings are **The Hive's** rather than any external
service's — which matters most for the middle one, because it reads like a Slack
event name and is not one.

| Value | What it means |
| --- | --- |
| `ledger` | An `ask` or `answer` whose `to` is this agent wakes it, whoever wrote it: the overmind through the console's `ask` verb, a terminal session through `ledger_ask`, or another agent through the same tools. A broadcast (no `to`) wakes nobody — parties read those on their own schedule. |
| `slack.mention` | *Search my mentions on the wakes this agent already takes.* Slack's real `app_mention` fires for mentions of a Slack **app**, never of a person, so there is no push to subscribe to. It adds no wakes of its own. |
| `slack.channel:#name` | A genuine push trigger, requiring the optional Socket Mode bridge and the app being a member of that channel. Inert without the bridge. |

`ledger` is the one worth understanding before turning it off, because its
*absence* is easy to misread. Off does not mean "nobody can reach this agent" —
a manual wake still does, over `CH.agentsRun` (HIVE-115 built the channel; no
verb or button calls it yet). It means a question addressed to it sits unread
until the next scheduled wake, and if there is no schedule, until
`LEDGER_ASK_TTL_MS` retires it. The asker gets silence and then an expiry. The
form says so under the field.

`isWakeOn` in the contract is what closes the set. It exists because `wake.on`
was, until then, the one list `parseAgent` never checked: the strings were cast
straight to `WakeOn[]`, so `on: [bananna]` saved cleanly and then silently never
fired — a worse failure than a refusal, since nothing looks wrong and nothing
ever happens.

### The four things the wake grammar refuses

Every one of them is a contradiction the file can express and the scheduler
cannot resolve. The rule throughout is that `parseAgent` names the field and
says what to do, rather than picking a winner — a scheduler that chose would be
inventing intent the file failed to state, and would do it silently.

| Refused | Why |
| --- | --- |
| `every:` **and** `at:` | An interval measures from the last wake; a time fires on the clock. "Every 3 hours, and also at 09:00" has no honest reading. |
| `days:` with no `at:` | A day with no time names no wake. (`at:` without `days:` is fine — it means every day, the commonest calendar there is.) |
| `check:` beside `at:` | `check` modifies an interval. A fixed time is a promise to run then, and a 09:00 standup agent that skipped the one morning its ledger was quiet is the failure the fixed time exists to prevent. |
| an `at:` time inside `wake.quiet` | The author has asked for a wake inside hours they also called quiet. Suppressing it drops a schedule they explicitly set; honouring it makes quiet hours a lie. |

The last one is why the scheduler's quiet-hours branch never has to consider
calendar mode: a calendar agent's times are outside its own window by
construction. The window is **half-open** — `from` is inside it, `to` is not —
so `at: [07:00]` with `quiet: 23:00-07:00` is accepted, which matters because
first thing in the morning is exactly when people schedule things.

`every: 30s` is refused too, but by `parseDuration`'s shape check rather than by
`WAKE_EVERY_FLOOR_MS`: the grammar accepts only whole minutes, hours, or
`daily`. The floor catches `0m`, and `nextRunFrom` clamps to it again for a
`WakeSpec` that reached the scheduler without passing the parser.

### `skills`, `mcp` and `tools` are three layers, not three spellings of one

They are easy to read as redundant — an agent reaches everything through tools
in the end — and they are not. Each answers a different question and fails in a
different way.

| Field | Question | Mechanism |
| --- | --- | --- |
| `skills` | Which skills this agent may invoke | Names checked against what exists on the machine |
| `mcp` | Which outside systems are plugged in, and as whom | Entries in the agent's `--mcp-config`; whose OAuth token is used |
| `tools` | Which calls proceed **without stopping to ask** | `--allowedTools` grants; `permissions.ask` + `--permission-prompt-tool` fence |

`mcp` decides whether a system's tools exist in the process at all, and on whose
behalf — Claude Code holds the user's Slack OAuth in the Keychain, so the agent
posts **as them**, not as a bot. `tools` decides which of the tools that exist
may run unattended, and it is worth wording as *without asking* rather than
*allowed*. Naming a system while granting none of its tools is a legitimate
state (it can reach nothing until each call is approved); so is granting a tool
whose system was never named (it does not exist).

**HIVE-115 measured what `--allowedTools` actually does, and it is a grant, not
a fence.** Asked for Bash under `--allowedTools "Read"` at 2.1.251, the model
used Bash — with `--setting-sources ""`, and under `--permission-mode dontAsk`
too. There is no default-deny in `-p`, so a tool left out of `tools` is not
refused; it merely does not get the free pass. That sets the trap the live
suite has to avoid: an ungranted tool a wake reaches for now hits the fence and
ends its turn on a denial instead of completing the probe's assertion, which is
why `tests/live/agent-conformance.test.ts` names every tool its probe could
plausibly touch.

**`skills` is a declaration, not a sandbox.** This is the honest framing and it
was arrived at the hard way. It was validated against `~/.hive/skills` alone,
which was wrong in both directions: an agent is a `claude -p` process on the
user's machine, so it loads their `~/.claude/skills` and their installed plugins
whether or not the definition names them — and on a fresh install, where
`~/.hive/skills` is empty, the field refused *every* name a person could type.

`skills/available.ts` therefore resolves three roots — `~/.hive/skills`,
`~/.claude/skills`, and each `installPath` in
`~/.claude/plugins/installed_plugins.json`, whose skills are namespaced
`plugin:skill`. The registry rather than a glob over the plugin cache, because
several versions of one plugin sit there at once and only that file says which
is installed. What the field buys is a name that does not exist caught in the
editor; what it cannot do is stop a skill the machine has.

Making it a real sandbox would mean `--restricted`, which ignores the user's
settings sources entirely — and would therefore cut off exactly the external
skills the widening exists to allow. HIVE-115 declined that trade: the wake
command carries `--setting-sources ""` instead, which stops the user's own
`settings.json` (and the `permissions.defaultMode: "auto"` a developer machine
routinely carries) from leaking into an unattended turn, while `--settings`
still applies alongside it so the Hive's own hooks keep firing. The skills stay
reachable and the field stays a declaration.

Two details worth knowing before changing `available.ts`:

- **`isSkillFolder`, not `entry.isDirectory()`.** `readdir` reports `lstat`
  semantics, so a symlinked skill folder answers `false` — and a personal skills
  folder is *more* likely to be symlinked than the Hive's, because that is how
  dotfile repos carry skills. `read.ts` fixed this once and the helper is shared
  rather than copied, so it cannot be fixed twice and broken a third time.
- **A user-scoped install beats the array order.** `installed_plugins.json` lists
  installs per plugin unordered by relevance; a `project`-scoped entry for an
  unrelated repository can sit first, and the user-scoped root is the one an
  agent's process would load.

**Half-answered by HIVE-115:** the app's own generated plugin
(`<userData>/hive/plugin`, carrying the `done` skill as `hive:done`) is *not*
among the three roots, so a definition naming it is still refused. The waker
settled the first half of that question — every wake carries `--plugin-dir
<that directory>`, so the plugin *is* loaded — and left the second half where
it was: `/done` marks a *terminal session* finished, and it has no meaning for
a headless agent that has no pty to close. Widening `available.ts` before that
has an answer would let a definition name a skill whose effect on an agent is
undefined.

### The fence, measured (HIVE-119)

A fence needs **two halves**, and neither works alone. `permissions.ask:
["*"]`, written into the agent-only settings file (`agentSettings`,
`electron/main/hooks/settings.ts`) — never `hookSettings`, which carries no
`ask` rule and would run an agent with no fence at all — is the *trigger*: the
only thing, measured against `claude` 2.1.251, that makes a permission check
fire under `-p` at all. `--permission-prompt-tool mcp__hive__approve`
(`waker.ts`) is the *router*: it hands that check to an MCP tool instead of to
nobody. With the flag but no `ask` rule, nothing fires and the tool just runs.
With the `ask` rule but no flag, the call is refused: the model asks a human
who is not there. `--permission-prompt-tool` is itself **hidden from
`--help`**, but real and accepted.

**Precedence, measured: `ask` beats `allow` beats `--allowedTools`.** A tool
named in `ask` routes to the prompt tool even when `allow` or
`--allowedTools` also names it. This is why a one-shot grant cannot be
implemented by appending to `--allowedTools` — the blanket `ask: ["*"]` rule
would still win — and why `mcp__hive__approve` decides against `HIVE_GRANTS`
itself, via `matches()` in `electron/shared/permission-rules.ts`, rather than
the app trying to widen the command line per wake. A bare `*` is valid in
`ask` and in `deny`, but is silently skipped, with a warning, in `allow` — so
`allow` can never be a catch-all, which is part of why `def.tools` rides
`--allowedTools` and not `permissions.allow`.

`--permission-mode manual` and `dontAsk`, and `permissions.defaultMode:
"ask"`, are all **inert under `-p`** — the tool simply runs, unprompted.
`dontAsk` additionally skips the prompt tool and auto-denies, which is why
`wakeCommand` never sets `--permission-mode` at all. `permissions.deny` /
`--disallowedTools` are a different mechanism entirely: they remove the tool
from the model's toolset, so no prompt fires and the model reports it has no
such tool — that is a refusal, not the fence, and nothing here sets it.

**The payload the CLI sends `mcp__hive__approve`:** `{ tool_name, input,
tool_use_id }` — there is no `suggestions` field. **The return shape it
accepts:** `{"behavior":"deny","message":"…"}` or
`{"behavior":"allow","updatedInput":{…}}`, as JSON **text** in
`content[0].text` — which is exactly what `decision()` in
`electron/mcp-host/tools.ts` builds. Also setting `structuredContent` makes
the CLI reject the result outright with "The permission prompt tool is
returning an invalid result", so `decision()` deliberately never sets it. An
`isError: true` result is treated as a denial — measured, it fails closed —
which is why `approve` never lets a thrown error surface as an MCP error:
every path through `approve` itself returns a `decision(...)` instead. The one
place a permission prompt still answers with `isError: true` is the
unreachable-environment branch in `electron/mcp-host/host.ts`, which refuses
*every* call — `approve` included — when the host was started outside The Hive.
That is deliberate and safe precisely because `isError` fails closed: a Hive
that is not running denies rather than allows.

The prompt tool is consulted **once per tool use**, and `updatedPermissions`
does **not** make a grant sticky through this path — persistence has to be
the app's own. A permanent grant is written into `AGENT.md`'s `tools:` the
moment the answer arrives (`permissions.ts`), so the next wake carries it as
an ordinary `def.tools` entry; an `allow-once` writes nothing and is handed
only to the one wake that asked, as `WakeInput.grants` — never merged into
`def.tools`. That one-shot is composed by `oneShotRuleFor(meta.tool,
meta.input)` as a **literal** rule — `literal:Bash:touch /tmp/x`, not `Bash`
— because a bare tool name matches every call to that tool while the rung's
caption promises exactly one. `matches` recognises the `literal:` sentinel
first and compares the specifier text with `===`, skipping the glob, the
shell-operator guard and the `..` guard: those exist to stop a *pattern*
matching more than it names, and a literal names one call. That is why the
one-shot needs no fallback — the glob DSL's comma ban and wildcard semantics
are borrowed constraints on `HIVE_GRANTS`, not real ones, since a one-shot
travels as JSON and is parsed by `readGrants`. The sentinel is a one-shot
channel only and never reaches `tools:`.

**Four things the grant path does not trust.** Only the overmind may answer a
permission ask: the ledger deliberately lets an asker close its own thread and
every agent holds `mcp__hive__*`, so without an author check an agent could
deny-then-self-answer its way to a permanent `tools:` entry in two tool calls
with no human. The same check is on the `event` that marks a grant consumed,
or a forged one would spend a pending one-shot before the user ever saw the
card. The ladder is **recomputed** from `meta.tool` and `meta.input` rather
than read off `meta.rungs`, which is model-supplied text that passes through
the MCP host unfiltered — a rung captioned "runs this once" could otherwise
carry `rule: "*"`. And `meta.tool` is itself model-supplied, so it is checked
against `isToolName` before either road uses it: `'*'` would otherwise reach
`HIVE_GRANTS` as the blanket rule, and `Bash]\ntools: [Write` would give
`AGENT.md` a second `tools:` key that `readFrontmatter` lets win.

And the *rest* of a composed rule — the Bash head, the WebFetch host, the path
dirname — is model-supplied too, and reaches `approve` without any forged ask
at all, since the CLI hands it the model's raw `input`. `isSafeToCompose` is
therefore an **allowlist** (`[A-Za-z0-9 _-./:+@~]`), not a denylist of the two
characters the rule grammar reads: a `\n` or a `]` in a path composed a rule
that forged a *second* `tools:` line, which `readFrontmatter` lets win — the
agent silently gained a tool nobody granted and lost the one the user did.
`hostOf` rejects anything that is not a plausible hostname for the same
reason, and `permissions.ts` re-checks every entry it is about to write, on
purpose: a single shape check is what failed.

`meta.kind === 'permission'` is the single discriminator for "this is a
permission ask", shared by `ledger/notify.ts`, `agents/permissions.ts` and
`inbox/ask-card.tsx`; the import fence stops them sharing one validator, so
they share the predicate instead. Every refusal on either road appends an
`event` carrying `meta.grantFailed`, so an attempt is always legible in the
log.

A `Bash(...)` specifier never matches a command carrying a shell control
operator — `;`, `&`, `|`, a redirection (`>`, `<`), a backtick, `$(`, a
newline. Chaining and redirection both reach past what a family caption
promises: `Bash(git *)` would otherwise cover `git status; curl … | sh`, and
`Bash(echo *)` — a one-click default — would cover `echo x > ~/.zshrc`. Such
a command falls through to being asked.

Only the specifier text a grant is computed from is kept in the ledger. The
bulk fields of a call — `content`, `new_string`, `old_string` — are replaced
with a size marker before the ask is posted, because the log is append-only
JSONL that never rotates and `store.all()` holds all of it in memory; the
`updatedInput` an *allowed* call runs with is never trimmed.

**`ToolSearch` is granted unconditionally** — in `HIVE_GRANTS` beside
`mcp__hive__*`, never in `def.tools`. MCP tool schemas are deferred: the
model must call the built-in `ToolSearch` to load a schema like
`mcp__hive__ledger_read`'s before it can invoke that tool at all, so denying
`ToolSearch` strands a fenced agent on the preamble's first instruction,
unable to reach even the ledger tools it *is* granted. It is plumbing, not
capability: `ToolSearch` reveals only schemas, and every tool it surfaces is
still checked by the fence the moment it is actually called, so granting it
widens nothing an agent can do. This was found by `pnpm test:agent`, not by
any unit test — nothing in a mocked child process can show a real `claude`
binary refusing to call a tool it cannot yet describe.

Under `-p`, `Notification` and `PermissionRequest` hooks do not fire and the
status line does not run — there is no footer to write to and no human
sitting at one. The fence's only externally visible effect is the `ask` entry
`mcp__hive__approve` posts to the ledger.

### `autonomy` does not touch the fence

`autonomy` is a fourth layer next to `skills`, `mcp` and `tools`, and it is
easy to mistake for a looser version of the same thing. It is not: `tools:`
decides what proceeds without a prompt to `mcp__hive__approve`, and `autonomy`
never changes that decision either way. What it decides instead is a
different ask, one the agent's own instructions make of its own accord before
an outward action — `ask` posts that question to the ledger and waits for an
answer; `act` proceeds and reports afterwards. A tool outside `tools:` still
reaches the permission-fence inbox card under either setting, because that ask
belongs to `mcp__hive__approve`, not to the agent's judgement, and `act` has
no way to pre-answer a card it never sees coming.

### The two per-wake limits, and the flags that enforce them

Verified against `claude` 2.1.251 by running it, not by reading `--help`:
**both** flags are hidden from the help output, so the help output is evidence
of nothing here.

**`--max-budget-usd` fires under subscription auth.** A run capped at `$0.0001`
comes back `"terminal_reason": "budget_exhausted"`, `"subtype":
"error_max_budget_usd"`, `is_error: true`. What it is not is a billing control:
the same payload reports `"costBasis": "list"`, so the run is priced at list API
rates and compared against the cap whether or not a dollar is ever charged. On a
subscription it is therefore a **work ceiling denominated in dollars**; on an API
key it is that and a spend cap.

Which is why `budgetUsd` has **no default** and is optional on
`AgentDefinition`. Absence means unlimited and means no flag on the command
line. A default was tried at `$0.50` and is not defensible: measured on this
machine, a single trivial turn costs `$0.096` on `sonnet` and `$0.417` on the
default model — nearly all of it creating the system-prompt cache that every
wake pays for. A real wake carries a larger prompt than that (the body, the
ledger preamble, the MCP schemas) before doing any work, so `$0.50` would have
guaranteed the failure it was meant to prevent.

**`--max-turns` exists, and is merely undocumented.** It is absent from
`--help`, which is how it was first written up here as an Agent-SDK-only option
with no CLI counterpart — and why `electron/shared/agent-turns.ts` briefly
existed to count `assistant` events off the child's stdout and kill the process
past the limit. Measured at 2.1.251 the flag is real and the binary enforces it:
a run that hits the cap ends `{"subtype": "error_max_turns"}` and **exits 1**.

So `limits.turns` goes straight onto the argv (`waker.ts`), and the counter is
deleted. Do not re-add it, and do not "fix" the argv by dropping the flag
because `--help` does not list it: a second enforcement of a limit the binary
already applies is one that can only ever disagree with the binary.

**The exit code is the part that bites.** A capped run is not a crashed one,
but it leaves the same non-zero code a crash does — and so does
`--max-budget-usd`. `close()` in `runs.ts` therefore reads the terminal
`subtype` **before** the exit code: `error_max_turns` records the run `turns`,
a subtype naming a budget records it `budget`, and only a run with no
recognised subtype falls through to `failed` on a non-zero exit. Reverse that
ordering and every capped run in `agents.json` reads as a crash, which is the
failure mode that makes a cap look like a bug in the agent.

`rotate_after` is unaffected and worth stating plainly: every wake is
`claude -p --resume <uuid>`, so each one sees the last one's transcript. That is
the feature — it is how an agent remembers it already answered a thread — and
the cost is a transcript that only grows. Rotation is what bounds it, and
**HIVE-122 made it a handover rather than an amnesia**: an agent that forgets
without leaving a note forgets the open threads it was the only one watching,
and the first anyone learns of that is a reply that never comes. So the agent
is a participant in its own rotation, across two wakes.

**The crossing wake still resumes.** When `runsSinceRotate` reaches
`rotate_after`, `wake-command.ts` builds the same `--resume <uuid>` it always
did — a handoff written by an agent that has been made to forget everything
first would be worthless. What changes is the prompt: `wakePrompt` swaps the
usual "read your inbox, then do your job" for a last turn that asks the agent to
do that work and then call **`ledger_handoff`** with what a fresh copy of itself
must know — what it watches, which threads are open and their ids, what it has
learned about how this user wants things done. Swaps rather than appends,
because an agent handed two instructions reliably does the first one. That wake
resets nothing: the counter is still sitting at its old value when the run ends,
deliberately, which is why `lastTurn` rides from the command onto the run record
rather than being re-derived at close.

**The close is what decides whether the rotation happens.** `runs.ts` asks
`handoffFor` whether the run posted a `handoff` entry at or after its own
`run.started` — the same run-boundary comparison `openAsksFor` uses, because the
ledger has no other notion of which run an entry belongs to, and the last one
wins if the agent wrote several. If it did, main mints the next session's uuid
into `AgentRunState.pendingSession` beside the handoff body, zeroes
`runsSinceRotate` and clears `rotateFailures`. If it did not, nothing rotates
and the conversation is kept — a run cut off by its turn cap is not an agent
that chose to forget, and dropping its memory anyway is precisely the outcome
this design exists to prevent.

Declining to rotate is a **strike**, and three consecutive strikes are the
point at which a human is told. At exactly the third, main appends an `event`
`from` the overmind carrying `meta: { rotateFailed: 3, agent }`, which
`notify.ts` raises as an `agent.failed` card. The `from` is the overmind on
purpose, gated on that at the other end, for the daily cap's reason: `meta` is a
rider any party can write, so a card minted from an agent's own `from` is one
any agent could mint about itself. Main declined to rotate; main says so. Fired
at exactly three rather than three-or-more so it cannot repeat — the counter
keeps climbing and every later wake keeps asking. A run that never reached the
model takes no strike and does not advance the counter either: a spawn failure
is a broken config, not a disobedient agent.

**The next wake spends what the close parked.** `pendingSession` is a rotation
already decided, waiting for someone to start it: the wake spells
`--session-id <its uuid>` instead of resuming, and `wakePrompt` prefixes the
stored handoff onto the prompt — first, because it is the context the rest of
the prompt assumes. It is consumed only on the path that returns a command,
after the filesystem writes that can fail, since clearing it ahead of a
transient `mkdir` error would lose the handoff permanently — no run, and the
memory gone anyway.

`rotate <agent>` in the console brings all of that forward by hand, which is
what you want after editing a definition substantially enough that the running
conversation is about a different agent. It arms `forceRotate` and then goes
through the ordinary run door, so a busy or paused agent refuses it exactly as
it refuses a run — and the flag survives the refusal, so the wake that does land
is still the handoff wake. One guard in that arm is not obvious: `lastTurn`
requires a `sessionUuid` as well. Only a run writes that field, so the counter
could never reach the arm without it — but `rotate` on an agent installed a
minute ago could, and the result would be a last-turn prompt on a brand-new
`--session-id` session, asking for a summary of a conversation that never
happened. With the term, a forced rotation on a never-run agent degrades to the
ordinary first wake, which is already the fresh session the user was asking for.

### A run ends exactly once, and quitting is one of the ways

`runs.ts` finalizes on the child's **`'close'`**, not on `'exit'`. `'exit'` can
fire before stdio has drained, and the `result` JSON is the last thing `claude`
writes — precisely the bytes still in flight. Finalizing early would record a
healthy run as `failed` with no cost, no turns and no session uuid, which
silently breaks `--resume` on the next wake. `'exit'` still arms a 500 ms
backstop for the case where a grandchild inherits a pipe and `'close'` never
comes, and a `closed` flag makes whichever arrives first the only one that
counts.

Which leaves one path where no event can arrive at all: **quit**. `runShutdown`
awaits a synchronous hook, so a SIGTERM sent there is never followed by a
`'close'` this process is alive to see. Signalling alone would therefore leave
a `run.started` with no `run.ended` forever, no summary in `runs[]`, and a
`runsSinceRotate` that quietly under-counts until rotation drifts. So the
tracker has `closeAll(reason)` — signal, then finalize each live run in place,
without waiting — and the shutdown hook calls that rather than `killAll`,
before `agentState.flush()` writes the result synchronously. The escalation to
SIGKILL is not available on this path and is not missed: it is an `unref`'d
timer, and the event loop it would need is already going away.

`killAll` is still the right call where the process keeps running — the test
teardown in `resetIpcHandlers`, which drops the whole tracker rather than
recording anything.

### The form edits the file, not a model

`patchFrontmatter` rewrites one line's value and leaves every other byte alone,
re-aligning a trailing comment to its original column. Serialising a parsed
model would be far less code and would destroy every comment and the author's
key order — and a settings pane that reformats a file the user was invited to
hand-edit has broken the promise that it is *their* file. That is what makes
the editor's Form and Source tabs two views of one buffer in the strict sense:
switching between them cannot change a byte.

### Why this folder pushes where skills pull

`skills/index.ts` re-reads on demand and has no change channel, and
`ipc-contract.ts` says why: the Settings pane is a skill's only writer. An
agents folder has two writers — the pane and the person with a text editor — so
the registry watches and main pushes `agents:changed`, following the ledger's
precedent rather than skills'.

Two consequences worth knowing:

- `list()` **creates** the folder before watching it. `fs.watch` cannot attach
  to a path that does not exist and does not retry, so on a fresh install the
  watcher silently never bound and a hand-written definition did not appear
  until the next launch. A path the app names on screen is one it should be
  willing to make.
- The watch factory is injectable. `fs.watch` delivers on the OS event loop,
  which fake timers cannot advance, so a real watcher would make the debounce
  provable only with real waits.

### A broken definition is listed, and can be opened

An unparseable file is returned with its reason rather than dropped, and its row
is **not** disabled — which is where this pane deliberately parts company with
Settings › Skills. An invalid skill's row is disabled because main could not read
a name out of the file, so there was nothing for the pane to address. An agent's
*folder* names it, so there is always a file to open — and the user has to be
able to open it to fix the key they were just told about.

## The agent on screen (HIVE-116)

### Two fields the bridge had to grow

HIVE-115 shipped `AgentSummary` carrying the **latest** run's `cost` and nothing
else, on the reasoning that a row draws one number. An agent view draws more
than a row: its `Today` tile is a count and a sum over the day's runs, and its
`Session` tile is `runsSinceRotate` over the definition's ceiling. Neither is
derivable from one cost, so `runs: RunSummary[]` and `rotateAfter` now cross —
on `agents:list`, and on the status push.

The array rather than a precomputed `todayRuns` / `todayCost` pair, because
"today" is the user's calendar day and a stored pair would be wrong by morning.

**HIVE-121 revised half of that.** The reasoning held for the day boundary and
failed on the arithmetic: `runs` is capped at `AGENT_RUN_HISTORY` — twenty — and
a five-minute agent takes 288 wakes between midnights, so the sum stopped
growing part-way through any day the agent actually worked. Main now accumulates
`today` as it records each run, and the same number is what the scheduler's
daily ceiling is compared against; a tile deriving its own would be a second
opinion about one fact.

The day boundary is still decided on read. What is stored is the day the totals
belong to, never the claim that it is today — so a tile rendered after midnight
and before the day's first run reads `0 runs · $0.00` rather than yesterday's
number. `dayKey` in the contract is the one spelling of that boundary, read by
both processes for the reason everything else in that file is: two spellings
would put the tile and the ceiling a day apart at exactly the hour that
matters.

**`AgentStatusPush` carrying the history is a deliberate widening**, and its doc
comment used to say it never would. The alternative was emitting
`agents:changed` at every run close so the renderer re-lists, which re-reads and
re-parses every `AGENT.md` on disk to learn one number main already holds.
Twenty summaries on a push that fires a few times an hour is the cheaper
honesty.

**`sessionUuid` used to stay behind, and HIVE-122 is why it no longer does.**
The old argument was that the field moves on a first run and on a rotation, and
`agents:list` is soon enough for both. Rotation broke the second half of that.
`finalizeRun` writes the uuid off the `result` event, so it changes at the close
of the first run of every new session — once in an agent's life under the old
reading, but every `rotate_after` wakes in practice, on an agent the user may
well be watching. Nothing emits `agents:changed` on a run, so the `Session` fact
went on naming the conversation that had already been handed off until something
unrelated re-listed. It rides the status push now, and `setAgentStatus` applies
it only when the push carries one: absent means unchanged, never cleared,
because the scheduler pushes on a skip with no run and no uuid attached.

### An agent is not a terminal

Until this story, opening an agent mounted a `SessionMetaBar`, a read-only xterm
replaying `entity.lines`, and a `MessageInput` — terminal chrome around
something that owns no process, and a place to type that reached nothing. All
three are gone. `resolveView` still returns `'agent'`; what changed is that the
predicate deciding "is there a terminal here?" no longer says yes to it.

That predicate had to **split** rather than narrow, and the split is the part
worth remembering:

- `isEntityView` — *is the user already looking at this thing?* Still true for
  both kinds. The foreground gate (HIVE-81) suppresses notifications on it, and
  an agent view answers exactly as a session's terminal does.
- `isTerminalView` — *does a terminal and its meta bar belong here?* Session
  only.

Narrowing the single predicate silently un-gated notifications for an agent the
user was looking at. The suite caught it, which is the argument for the
foreground hook mirroring the stage's selectors rather than re-deriving them.

Agents also left `center-stage`'s terminal `ids`, so no transport is built for a
definition on disk. `resolveTransport` keeps its agent guard anyway: its
contract is "a transport for any id", and a defence removed the moment its
caller goes away is one that has to be rediscovered when the next caller
arrives.

### The split, and its three numbers

The run log and the ledger sit side by side under

```css
grid-template-columns: minmax(0, 1fr) clamp(280px, 22%, 380px);
```

with a container query stacking them below an 800px stage. Every number in that
line is derived rather than chosen:

- **The log is the elastic half** because it renders at the *terminal* type
  scale, which the user sets anywhere from 10px to 18px
  (`TERMINAL_FONT_SIZES`); the ledger is chrome at a fixed size showing short
  correspondence. Giving the moving one the remainder is what keeps both right
  at every size.
- **280px** is the activity rail's own text measure — 316px less 14px of padding
  either side. A ledger entry and an Inbox card show the same thing, and
  HIVE-118 turns one into the other.
- **380px** because a tool line is `<name> <arg>` with `ARG_LIMIT = 60` in
  `run-log.ts`, so the longest line main can emit is ~95 characters. Past ~110
  neither panel gains from more width.
- **800px** because below it the log falls under 70 characters, narrower than
  the prose the model writes into it. There it drops to the stacked layout the
  ticket started from, so nothing is lost.

`minmax(0, 1fr)` and never a bare `1fr`: `1fr` carries an `auto` minimum, so one
unbreakable 95-character tool line would push the grid past the stage and give
the whole app a horizontal scrollbar.

**A container query, not a media query**, and the first in this codebase. The
rails drag between 268px and 520px each, so a 1920px window can hold a 700px
stage — the viewport width simply is not the question being asked.

### Run-log colour comes from JS, and the run log is honest about history

`RunLineColor` names four terminal slots, and terminal colour deliberately never
reaches CSS (`tokens.css` says so at the top). A `--cc-run-*` group would have
been a second representation of values the theme already carries — and
`tests/lib/theme/built-in.test.ts` would have refused them, because it fails any
`--cc-*` colour that appears in no key list, on the grounds that an imported
theme could never set it. So `AgentRunLog` reads `useTerminalAppearance()` and
paints inline, exactly as the xterm surface is handed its palette.

Lines arrive as a flat stream with **no run id on them**. The log therefore
names a run only while one is *live* — the case where the buffer genuinely is
that run's output — and once it ends, every run becomes a one-line receipt and
the buffer is labelled for what it is. Receipts carry no chevron: `agents:lines`
is a live push that nothing writes to disk, so a disclosure control would open
onto nothing. Partitioning a finished buffer would mean sniffing the closing
line's colour, which breaks the moment the fold emits a second cyan line.

### The status palette, and the one shape that stayed

The five agent states each take the utility of the session state they mirror, so
one word means one colour across the app: `asking` is `waiting`'s amber,
`working` is `working`'s green and pulses by the same derivation, `sleeping` is
`idle`'s subtle, `paused` is `terminated`'s muted. Only `failed` needed a hue
the session vocabulary lacks.

`paused` is a **solid fill, not a hollow ring**, and it was drawn as a ring
first. `StatusDot` gates `hollow` on `status === 'idle' && detail !== undefined`
and records that narrowing as a deliberate review fix — "makes a hollow non-grey
dot unrepresentable regardless of what the caller passes". Reaching for the ring
would have reopened a settled invariant to buy a distinction the visible status
word already carries.

### Three badges, three different numbers

The Agents tab's badge is `useAgentAskCount` — open asks whose `from` is an
agent. It is neither of the other two on that screen: not `useOpenAskCount`,
which counts a session's asks as well, and not the Inbox's `useUnreadCount`,
which counts notifications. The three stay three different numbers — an agent
ask, a session ask and a raw notification count are never the same count — but
they converge on one *event* now that HIVE-118 turns an ask into an inbox
card: the moment an agent's ask lands, it is simultaneously counted by
`useAgentAskCount` and, as a card, by `useUnreadCount` — one write, read by
both badges, rather than a badge with nothing behind it until the user opens
the Inbox and finds the ask some other way.

The agent filter lives in the renderer rather than in `openAsks`, which main
also calls and which has no notion of which parties are agents. `OpenAsk`
spreads the entry, so `from` is already there; only `agentOrder` is missing, and
only the renderer has it.

## Related reading

- [`docs/state-and-data.md`](state-and-data.md) — *The ledger slice is a mirror,
  not a source*: the shape backing `useLedgerEntries` / `useOpenAsks` /
  `useThread`, the 500-entry cap, why `hydrateLedger` merges rather than
  replaces, and why derived values live in selectors rather than in the store.
- [`.claude/COMPONENTS.md`](../.claude/COMPONENTS.md) — why the disabled
  *Run now* button uses a native `title` rather than a Radix tooltip: the app
  mounts no `TooltipProvider`.
- [`docs/desktop-architecture.md`](desktop-architecture.md) — the `~/.hive/`
  vs. `userData` split the ledger's location follows, and the receiver's
  broader security posture (loopback-only, per-launch token, closed route
  set).
