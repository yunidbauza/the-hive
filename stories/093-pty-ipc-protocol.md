# 093 — PTY IPC Protocol & Flow Control

| | |
|---|---|
| **ID** | HIVE-093 |
| **Epic** | Real terminals |
| **Depends on** | [082-preload-ipc-security.md](082-preload-ipc-security.md), [092-pty-session-manager.md](092-pty-session-manager.md) |
| **Blocks** | [094](094-pty-transport.md) |
| **Points** | 5 |
| **Location** | `app/electron/main/ipc/pty.ts` |

## Story

> As a user, I want a session that produces a wall of output — a test run, a build, a
> long agent turn — to stay smooth and stay responsive, so the app never freezes because
> a terminal is busy.

## The problem

`pty:data` is the only high-volume channel in the app. A single `pnpm build` emits tens
of thousands of small writes. Forwarding each one as its own IPC message produces two
distinct failures, and they need different fixes:

1. **Message storm.** Electron IPC has meaningful per-message overhead — serialisation,
   a hop through the main process, structured clone into the renderer. Thousands of
   tiny messages per second saturate the main process, and main is also the thing
   drawing the window.
2. **Unbounded queueing.** A pty can produce output faster than xterm can parse and
   render it. With no backpressure the queue grows without limit: memory climbs, and
   the terminal falls further behind real time until Ctrl-C appears to do nothing
   because the user is watching output from ten seconds ago.

Batching fixes the first. Only acknowledgement fixes the second.

## Batching (main → renderer)

Coalesce `data` from the pty host into at most one IPC message per **8 ms** per session,
concatenating chunks in between, with an immediate flush when the pending buffer exceeds
**64 KB**.

8 ms is under a frame at 120 Hz, so no perceptible latency is added to interactive
typing — the echo of a keystroke still lands in the same frame it would have. The size
cap keeps a firehose from building a large string before the timer fires.

Batching is **per session**, not global: one noisy session must not delay another's
echo.

## Flow control (the ack loop)

Modelled on how VS Code paces its terminals, and for the same reason.

```
main ──data(seq, bytes)──► renderer
                              │  xterm.write(chunk, callback)
                              │  callback fires when PARSED
main ◄──ack(seq)──────────────┘
```

- Main tracks **unacknowledged bytes** per session.
- Above the high-water mark (**512 KB**) it calls `pause()` on the pty
  ([092](092-pty-session-manager.md)), which stops reading the fd; the kernel pty buffer
  fills and the producing process blocks on write. That is real, correct backpressure —
  the same thing that happens when you pipe to a slow consumer in a shell.
- Below the low-water mark (**128 KB**) it calls `resume()`.

The critical detail: **the ack is sent from xterm's write callback, not on receipt.**
`xterm.write` is asynchronous; its callback fires once the chunk has been parsed into
the buffer. Acking on arrival measures the IPC channel and learns nothing about whether
the terminal is keeping up, which is the entire question.

Acks are batched too — one ack per animation frame carrying the highest sequence number
— so the ack loop cannot itself become a message storm.

## Renderer → main

Low volume; different concerns.

- **`write`** uses `send`, not `invoke`. Keystrokes are fire-and-forget; awaiting a
  round-trip per character adds latency to the one interaction where latency is felt.
  Ordering is guaranteed on a single channel, which is what actually matters.
- **`resize`** is throttled to one message per **50 ms** per session, with a trailing
  call so the final geometry always lands. A window drag fires `ResizeObserver`
  continuously, and each resize is a `SIGWINCH` — an unthrottled drag sends a storm of
  signals to a process that redraws on every one.
- **`spawn`** and **`kill`** use `invoke`; both need a result.

## Sequencing and correctness

- Each session carries a monotonic `seq` on `data`. The renderer asserts monotonicity
  and, on a gap, writes a dim `── output gap detected ──` marker rather than silently
  rendering a corrupted stream.
- `data` arriving for an unknown or exited session is dropped in main with a counter, not
  forwarded. This is the ordinary race when a session is killed while output is in
  flight.
- `exit` is delivered **after** every pending `data` for that session is flushed.
  Delivering it early truncates the last output — usually the error message.

## Diagnostics

A dev-only counter set per session — bytes in, bytes acked, pauses, batches, dropped
messages — reachable through `app:info`. Flow-control bugs are otherwise diagnosed by
staring at a slow terminal and guessing.

## Tests

`tests/electron/main/ipc/pty.test.ts` (fake timers throughout — no real waits, per
`AGENTS.md`):

- Ten writes inside the window produce one message with concatenated payload.
- Exceeding the size cap flushes immediately without waiting for the timer.
- Batching is per session: a noisy A does not delay B's flush.
- Crossing the high-water mark calls `pause`; dropping below the low-water calls
  `resume`; between them, neither is called.
- No ack → pause; ack → resume. The ack path is driven by the write callback, and a
  test that acks on receipt instead must fail.
- Resize throttling emits leading and trailing calls, and at most one per 50 ms.
- A `seq` gap produces the marker.
- `data` for an exited session is dropped and counted.
- `exit` is emitted after the final `data` flush.

## Acceptance criteria

- [ ] `yes` in a session does not freeze the window; the app stays interactive and other
      terminals keep echoing.
- [ ] Ctrl-C during that flood stops it within a few hundred milliseconds — the proof
      that the renderer is not lagging behind real time.
- [ ] Memory is stable during a 60-second flood (sample RSS; no monotonic growth).
- [ ] Typing latency in an idle session is imperceptible; the diagnostic counter shows
      batches of 1 when idle.
- [ ] Dragging the window edge emits throttled resizes and the final geometry matches
      `stty size`.
- [ ] Unit tests above pass with fake timers.

## Out of scope

- The renderer-side transport that consumes this — [094](094-pty-transport.md).
- Persisting scrollback to disk.
- Compressing IPC payloads. Batching is sufficient at this scale; revisit with evidence.

## UPDATED SPECS

### 1. The contract this story needs did not exist yet

Story 082 declared the PTY channels and said they would be "implemented in story
093". They were declared **incompletely**: nothing in the shipped contract could
express this design.

Added here — `seq` on `DataEvent`, a `pty:ack` channel, `AckRequest` and its guard,
an `ack` verb on the bridge (so `BRIDGE_PTY_KEYS` and both surface tests grew), and
`PtyDiagnostics` on `AppInfo`. The surface-test failure that resulted is the
allowlist working, not a regression.

### 2. `pause` / `resume` are new host protocol commands

The story says main "calls `pause()` on the pty". The pty lives in the host process
(091), so this became two new `HostCommand`s, a `pause`/`resume` pair on
`SessionOperations`, and their implementation in the session manager against
`IPty.pause()` / `IPty.resume()`.

### 3. Resize throttling lives in main

The story lists resize throttling under "Renderer → main", which reads as
client-side. It is implemented in **main** instead, for two reasons: the harm the
story actually names is `SIGWINCH` storming the child, which main is the last place
able to prevent; and the story's own test list puts these assertions in
`tests/electron/main/ipc/pty.test.ts`. Story 094 may add a client-side throttle on
top; it would be an optimisation, not the guarantee.

### 4. An undeclared dependency on 090

The story's Depends-on names 082 and 092. Spawning also needs the **workspace
config**: `SpawnRequest` carries a `projectId`, and something has to turn that into
a `cwd`. That resolution happens in main's `pty:spawn` handler, which refuses a
project that is not mapped to a usable directory rather than starting a shell
somewhere arbitrary.

### Acceptance criteria

Per the reconciliation decision, the criteria that need a live terminal are
**deferred to 094/095** — they are unprovable here, because the ack that drives the
whole loop is supposed to come from xterm's write callback and there is no xterm on
this path yet:

- [ ] `yes` does not freeze the window; other terminals keep echoing.
- [ ] Ctrl-C during that flood stops it within a few hundred milliseconds.
- [ ] Memory is stable during a 60-second flood.
- [ ] Typing latency is imperceptible; the counter shows batches of 1 when idle.
- [ ] Dragging the window edge produces a final geometry matching `stty size`.

What *is* proven here: every batching, flow-control, throttling, sequencing and
ordering rule with fake timers (30 unit tests), plus an end-to-end Electron spec
that spawns a session from the renderer, runs a real shell, and receives sequenced
output and a correctly-ordered exit back through the whole stack.

### 5. Host errors and lost sessions are logged, not dropped

Found in self-review. The supervisor emits `error` (unknown session, session limit
reached, crash-loop guard tripped) and `sessionLost` (its host died), and **nothing
subscribed to either** — they vanished silently.

There is no renderer error channel in the contract, and the terminal that writes
`SESSION_LOST_NOTICE` is story 095's surface, so inventing one here would be
speculative. They are logged in main instead, and a lost session is marked exited so
in-flight output is not delivered to a terminal that is already dead. A session that
silently fails to start is indistinguishable from one that started and produced
nothing, and that is the harder bug to chase.
