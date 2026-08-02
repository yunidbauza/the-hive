# 082 — Preload Bridge & IPC Security

| | |
|---|---|
| **ID** | HIVE-082 |
| **Epic** | Desktop shell |
| **Depends on** | [080-electron-scaffold.md](080-electron-scaffold.md), [081-main-process-window.md](081-main-process-window.md) |
| **Blocks** | [083](083-runtime-target-transport.md), [093](093-pty-ipc-protocol.md) |
| **Points** | 5 |
| **Location** | `app/electron/preload/`, `app/electron/shared/ipc-contract.ts`, `app/electron/main/ipc/` |

## Story

> As a developer, I want the renderer to reach the main process through one narrow,
> typed, allowlisted bridge, so that adding a capability later is a deliberate edit to a
> contract rather than an incremental widening of what a web page can do to this machine.

This app runs a shell. The blast radius of a sloppy bridge is the user's filesystem, so
the posture is decided once, here, before there is anything worth attacking.

## Posture

```ts
webPreferences: {
  contextIsolation: true,      // non-negotiable
  nodeIntegration: false,      // non-negotiable
  sandbox: true,               // non-negotiable
  webSecurity: true,
  allowRunningInsecureContent: false,
  preload: join(__dirname, '../preload/index.js'),
}
```

`sandbox: true` deliberately constrains the preload script itself: it may `require`
only `electron` and a small polyfill set, and has no `fs`, no `child_process`, no
`process.env`. That is the correct amount of power for a bridge. Any temptation to do
real work in preload is a signal that the work belongs in main behind a channel.

## The contract is a module, not a convention

`electron/shared/ipc-contract.ts` is the single source of truth for channel names and
payload shapes. Both processes import it ([080](080-electron-scaffold.md) gives the
renderer `@shared`), so a renamed channel or a changed payload is a **type error on
both sides** rather than a runtime silence.

```ts
export const CH = {
  ptySpawn:  'pty:spawn',
  ptyWrite:  'pty:write',
  ptyResize: 'pty:resize',
  ptyKill:   'pty:kill',
  ptyData:   'pty:data',     // main → renderer, stream
  ptyExit:   'pty:exit',     // main → renderer
  appInfo:   'app:info',
} as const;

export type Channel = (typeof CH)[keyof typeof CH];

export interface SpawnRequest { sessionId: string; projectId: string; cols: number; rows: number }
export interface WriteRequest { sessionId: string; data: string }
export interface ResizeRequest { sessionId: string; cols: number; rows: number }
export interface DataEvent   { sessionId: string; chunk: string }
export interface ExitEvent   { sessionId: string; exitCode: number; signal?: number }
```

The PTY channels are declared here but **not implemented in this story** — [093](093-pty-ipc-protocol.md)
owns their handlers and their flow control. This story ships the bridge, its security
properties, and `app:info` as the one working channel that proves the whole path.

## The bridge

```ts
// electron/preload/index.ts
contextBridge.exposeInMainWorld('hive', {
  appInfo: () => ipcRenderer.invoke(CH.appInfo),
  pty: {
    spawn:  (req: SpawnRequest)  => ipcRenderer.invoke(CH.ptySpawn, req),
    write:  (req: WriteRequest)  => ipcRenderer.send(CH.ptyWrite, req),
    resize: (req: ResizeRequest) => ipcRenderer.send(CH.ptyResize, req),
    kill:   (sessionId: string)  => ipcRenderer.invoke(CH.ptyKill, sessionId),
    onData: (cb: (e: DataEvent) => void) => subscribe(CH.ptyData, cb),
    onExit: (cb: (e: ExitEvent) => void) => subscribe(CH.ptyExit, cb),
  },
});
```

Three rules the review must enforce:

1. **`ipcRenderer` is never exposed**, in whole or in part. Not as `ipcRenderer.invoke`
   bound to a channel argument, not behind a wrapper that takes a channel name. The
   renderer gets *verbs*, and the set of verbs is the allowlist.
2. **Every subscription returns its own unsubscribe.** `subscribe()` wraps
   `ipcRenderer.on` and returns a disposer that calls `removeListener`. This mirrors
   `TerminalTransport.onData`'s contract exactly ([042](042-terminal-surface.md)), which
   is what lets `PtyTransport` ([094](094-pty-transport.md)) be a thin adapter.
3. **The raw `IpcRendererEvent` never crosses the bridge.** `subscribe` invokes the
   callback with the payload only. Passing the event hands the renderer a `sender`
   handle and defeats the isolation.

### Listener accounting

Thirteen live terminals mean thirteen `pty:data` subscriptions on one channel. Two
consequences:

- The disposer discipline above is not tidiness — a surface that unmounts without
  unsubscribing leaks a listener per mount/unmount cycle, and tab switching is
  frequent.
- Node's default 10-listener warning will fire. Raise the cap explicitly on the
  emitter with a comment saying why, rather than letting a legitimate warning become
  background noise that hides a real leak later.

An alternative design — one channel per session (`pty:data:<id>`) — is rejected: it
makes the channel set dynamic, which is precisely what an allowlist cannot be.

## Main-side validation

Every handler validates before acting. The renderer is treated as untrusted input,
because terminal output is untrusted input and it renders there.

```ts
ipcMain.handle(CH.ptySpawn, (event, req: unknown) => {
  assertSender(event);
  const parsed = parseSpawnRequest(req);   // hand-written guard in shared/
  …
});
```

- **`assertSender(event)`** — reject anything whose `event.senderFrame` is not the main
  frame of the app's own window. Without it, any frame that ends up in the process can
  invoke the channel.
- **Payload guards are hand-written type guards** in `electron/shared/`, not casts. A
  cast is a lie the compiler agrees to; `parseSpawnRequest` returns a typed value or
  throws. No new runtime dependency is introduced for this — the payload set is small
  and closed, and the guards are directly unit-testable.
- **`sessionId` is validated against the live session registry**, never used to index
  anything before that check. It arrives from the renderer and reaches process control
  in [092](092-pty-session-manager.md); it is the highest-value field in the contract.

## Content Security Policy

Set on `session.defaultSession` via `onHeadersReceived`, not only as a `<meta>` tag —
a meta tag does not cover every load path.

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self';
object-src 'none';
frame-src 'none';
```

`style-src 'unsafe-inline'` is required: xterm writes inline styles for cell colours,
and Tailwind v4 injects a style element. Every other directive is closed. `connect-src
'self'` matters more than it looks — it is what stops rendered terminal content from
becoming an exfiltration path.

The dev target needs the Vite HMR websocket; apply the relaxed policy only when
`ELECTRON_RENDERER_URL` is set, and assert in tests that the production policy is the
strict one.

## Tests

`tests/electron/preload/` and `tests/electron/main/ipc/`:

- The exposed object's key set equals the contract's expected surface — a snapshot
  test whose failure means someone widened the bridge.
- `ipcRenderer` is not reachable from the exposed object at any depth.
- `subscribe` returns a disposer; calling it removes exactly one listener.
- Callbacks receive the payload, not the event.
- `assertSender` rejects a foreign frame.
- Each payload guard rejects: wrong type, missing field, extra field, prototype-polluting
  key (`__proto__`), and a non-string `sessionId`.
- The production CSP contains no `unsafe-eval` and no wildcard host.

## Acceptance criteria

- [ ] All three `webPreferences` flags are set as above and a test fails if any regresses.
- [ ] `window.hive.appInfo()` round-trips from renderer to main and back.
- [ ] `window.hive` exposes only the documented verbs; `ipcRenderer` is unreachable.
- [ ] Every guard rejects every malformed payload in the test matrix above.
- [ ] The production CSP is applied and asserted; the dev relaxation is dev-only.
- [ ] `pnpm lint` passes with the [080](080-electron-scaffold.md) zones enforcing that
      `src/**` imports nothing from `electron/main/**` or `electron/preload/**`.

## Out of scope

- PTY handler implementations and flow control — [093](093-pty-ipc-protocol.md).
- Reading files, git, or settings from the renderer. If a later story needs it, it
  gets a new verb and a new guard, deliberately.
