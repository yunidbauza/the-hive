# Agents and the ledger

**Scope:** two things that belong together — the **ledger**, one append-only log
every party in The Hive reads from and writes to, and the **agent definition**,
the file that makes a party an agent in the first place. **Owned by stories
HIVE-111 (the log), HIVE-112 (the MCP tools), HIVE-113 (delivery and the
console verbs) and HIVE-114 (definitions).**

Load this when working on `electron/main/ledger/`, `electron/main/agents/`,
`electron/mcp-host/`, `electron/shared/{ledger,agent}-*`, the hook receiver's
two ledger routes, the renderer's mirrors of either (`use-ledger-sync.ts`,
`use-agents-sync.ts`, the `useLedger*` and `useAgent*` selectors in
`hive-store.ts`), the `ledger` / `ask` / `answer` console verbs, or
Settings › Agents.

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
line; one addressed to an agent is a wake (HIVE-120); a broadcast wakes nobody,
because parties read those on their own schedule.

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

- **`openAsks`** — an ask is open until it is answered *or* until
  `LEDGER_ASK_TTL_MS` (24h) has passed since it was made, whichever comes
  first. Both halves matter on their own: without the TTL, an ask whose asker
  died (a session that crashed, a terminal that was closed) stays open
  forever and the inbox never empties; without the answer check, a thread
  would close on a timer while someone is still owed a reply.
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
is eight tools and did not justify a dependency.

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
`createHandlers` still lists all eight tools (so
`/mcp` shows a connected server, not a broken one) but every *call* answers
with a sentence explaining why the ledger is out of reach, rather than the
server refusing to start.

The host reaches the ledger the same way a session's hooks do: **both
receiver routes are POST**, and the host's `ReceiverClient` (`client.ts`)
calls them with the same two headers the hook path uses
(`x-hive-session`, `x-hive-token`) and the same per-launch token.

**The eight tools, one ledger kind each:** `ledger_post` → `post`,
`ledger_ask` → `ask`, `ledger_answer` → `answer`, `ledger_claim` → `claim`,
`ledger_release` → `release`, `ledger_done` → `done`, `ledger_failed` →
`failed`, and `ledger_read`, which takes no kind — it is the one tool that
reads rather than appends. `ledger_claim` and `ledger_release` still write
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
preamble and HIVE-119's `--permission-prompt-tool` both hardcode the short
form, which is the whole reason `--mcp-config` was the delivery mechanism this
story chose over a plugin.

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
finds eight tools named the short way, that the identity in the environment —
not anything the model typed — is what lands in a written line's `from`, and
that a refusal's reason reaches the model as readable text.

## Agent definitions

An agent is a file before it is anything else: `~/.hive/agents/<name>/AGENT.md`,
frontmatter over a markdown body, sitting beside `config.json`, `skills/` and
`ledger/` for the reason all of those do — a definition is a document the person
is invited to open, `grep` and back up, not an app-private artifact.

Nothing *runs* one yet. HIVE-114 defines the file, teaches main to read,
validate and watch a folder of them, and gives Settings a place to author them;
the waker is HIVE-115. Every agent is therefore `sleeping`.

That matters for how the pane is worded. A field describing runtime behaviour
that has no implementation — and, in the case of `--max-turns` below, no
mechanism in the CLI to implement it with — is worse than a field that says "not
yet", so the sections below record what is enforced, what is merely declared,
and what is waiting on the waker.

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
`run <agent>` still wakes it by hand. It means a question addressed to it sits
unread until the next scheduled wake, and if there is no schedule, until
`LEDGER_ASK_TTL_MS` retires it. The asker gets silence and then an expiry. The
form says so under the field.

`isWakeOn` in the contract is what closes the set. It exists because `wake.on`
was, until then, the one list `parseAgent` never checked: the strings were cast
straight to `WakeOn[]`, so `on: [bananna]` saved cleanly and then silently never
fired — a worse failure than a refusal, since nothing looks wrong and nothing
ever happens.

### `skills`, `mcp` and `tools` are three layers, not three spellings of one

They are easy to read as redundant — an agent reaches everything through tools
in the end — and they are not. Each answers a different question and fails in a
different way.

| Field | Question | Mechanism |
| --- | --- | --- |
| `skills` | Which skills this agent may invoke | Names checked against what exists on the machine |
| `mcp` | Which outside systems are plugged in, and as whom | Entries in the agent's `--mcp-config`; whose OAuth token is used |
| `tools` | Which calls proceed **without stopping to ask** | `--allowedTools` |

`mcp` decides whether a system's tools exist in the process at all, and on whose
behalf — Claude Code holds the user's Slack OAuth in the Keychain, so the agent
posts **as them**, not as a bot. `tools` decides which of the tools that exist
may run unattended, and it is worth wording as *without asking* rather than
*allowed*: a wake is headless, so there is nobody to prompt, and the fallback is
refusal. Naming a system while granting none of its tools is a legitimate state
(it can reach nothing until each call is approved); so is granting a tool whose
system was never named (it does not exist).

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
skills the widening exists to allow. That trade is recorded here rather than
made silently; the waker (HIVE-115) is where it would be taken.

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

**Left open, for HIVE-115:** the app's own generated plugin (`<userData>/hive/plugin`,
carrying the `done` skill as `hive:done`) is *not* among the three roots, so a
definition naming it is refused. Whether it should be depends on a decision this
story does not own — whether an agent is handed that plugin directory at all, and
whether `/done`, which marks a *terminal session* finished, means anything to a
background agent. Guessing either way here would bake an answer into the
validator before the waker has one.

### Two limits the CLI can enforce, and one it cannot

Verified against `claude` 2.1.251 rather than assumed, because the epic's waker
command names a flag that does not exist.

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

**`--max-turns` does not exist.** It is an Agent SDK option, not a CLI flag;
2.1.251's flag set has `--max-budget-usd` and no turn cap. So `limits.turns`
cannot be handed to the binary, and the pane was drawing a control for a limit
nothing could apply. `electron/shared/agent-turns.ts` is the answer: the waker
already reads `--output-format stream-json` off the child's stdout to build the
run log, so it can count `assistant` events there and terminate the child past
the limit. It is a fold rather than a function over lines because a pipe splits
where it likes — a chunk boundary inside an event would otherwise undercount,
which is the direction that makes a limit useless rather than merely wrong.

`rotate_after` is unaffected and worth stating plainly: every wake is
`claude -p --resume <uuid>`, so each one sees the last one's transcript. That is
the feature — it is how an agent remembers it already answered a thread — and
the cost is a transcript that only grows. Rotation writes a handoff to the
ledger and starts the next run on a fresh session id carrying it. Deliberate
forgetting, with a note left behind.

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
