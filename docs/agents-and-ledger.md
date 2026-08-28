# Agents and the ledger

**Scope:** the ledger — one append-only log every party in The Hive reads from
and writes to. **Owned by story HIVE-111.**

Load this when working on `electron/main/ledger/`, `electron/shared/ledger-*`,
the hook receiver's two ledger routes, or the renderer's mirror of the log
(`use-ledger-sync.ts`, the `useLedger*` selectors in `hive-store.ts`).

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

## Related reading

- [`docs/state-and-data.md`](state-and-data.md) — *The ledger slice is a mirror,
  not a source*: the shape backing `useLedgerEntries` / `useOpenAsks` /
  `useThread`, the 500-entry cap, why `hydrateLedger` merges rather than
  replaces, and why derived values live in selectors rather than in the store.
- [`docs/desktop-architecture.md`](desktop-architecture.md) — the `~/.hive/`
  vs. `userData` split the ledger's location follows, and the receiver's
  broader security posture (loopback-only, per-launch token, closed route
  set).
