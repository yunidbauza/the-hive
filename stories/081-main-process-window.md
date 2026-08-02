# 081 — Main Process & Window Lifecycle

| | |
|---|---|
| **ID** | HIVE-081 |
| **Epic** | Desktop shell |
| **Depends on** | [080-electron-scaffold.md](080-electron-scaffold.md) |
| **Blocks** | [082](082-preload-ipc-security.md), [085](085-electron-test-harness.md), [091](091-pty-host-process.md) |
| **Points** | 5 |
| **Location** | `app/electron/main/` |
| **Architecture reference** | `concept/` — header chrome; [020](020-app-shell-layout.md), [021](021-header.md) |

## Story

> As a user, I want The Hive to open as a proper desktop window — remembering where I
> left it, quitting cleanly, and behaving like a Mac app rather than a web page in a
> frame — so it reads as a tool I keep open all day.

## Window

```ts
new BrowserWindow({
  width, height, x, y,          // restored — see below
  minWidth: 1100, minHeight: 700,
  show: false,                  // revealed on ready-to-show
  backgroundColor: '#0b0d10',   // --cc-bg, see below
  titleBarStyle: 'hiddenInset', // macOS: traffic lights float over our header
  trafficLightPosition: { x: 16, y: 20 },
  webPreferences: { /* 082 owns every key here */ },
});
```

**`show: false` + `ready-to-show`** is not a nicety. Showing the window immediately
paints an empty frame while the renderer boots, and on a dark app that flash is a
white rectangle. Reveal on `ready-to-show`.

**`backgroundColor` must equal `--cc-bg`.** Electron paints the window background
before any CSS loads. The default is white. This is the same flash problem from the
other side, and it is the one people notice on every cold launch.

The value is duplicated from `src/styles/tokens.css` into main-process code, which is
the one place the "no raw hex" rule in `AGENTS.md` cannot apply — the main process has
no CSS. Declare it once in `electron/shared/` as `WINDOW_BACKGROUND` with a comment
pointing at the token, so the duplication is findable rather than lurking.

### `titleBarStyle: 'hiddenInset'`

The app already has a 56px header ([021](021-header.md)). A native title bar above it
would stack two bars. `hiddenInset` removes the bar and floats the traffic lights over
our own header, which is what VS Code, Linear and every app of this shape do.

Consequence for the renderer: the header needs `-webkit-app-region: drag` to stay
draggable, and every interactive element inside it needs `-webkit-app-region: no-drag`
or it becomes unclickable. This is the **only** change this epic makes to `src/`, it is
a CSS-class change in `header.tsx`, and it must be guarded so the browser target is
unaffected ([083](083-runtime-target-transport.md)).

Left inset for the traffic lights is applied in the same guarded class. On Windows and
Linux `hiddenInset` is not honoured; the story targets macOS chrome and accepts the
default frame elsewhere.

## Window state persistence

Size and position survive a restart. Stored as JSON in `app.getPath('userData')`,
written debounced on `resize`/`move` and on `close`.

Restore is **validated against currently attached displays** before use. A window
restored to the coordinates of a monitor that is no longer connected opens offscreen
and looks exactly like a hang. If the saved rect does not intersect any current
display's work area, fall back to centred defaults.

## Single-instance lock

```ts
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { /* focus the existing window */ });
```

Mandatory here, not optional. Once [092](092-pty-session-manager.md) lands, a second
instance means a second set of PTYs running `claude` against the same repositories —
two agents editing the same working tree. The lock is the cheapest possible guard
against that, and it must exist *before* PTYs do.

## Lifecycle

| Event | Behaviour |
|---|---|
| `whenReady` | create window; on macOS install the app menu (below) |
| `activate` | re-create the window if none are open (macOS dock click) |
| `window-all-closed` | quit on Windows/Linux; **stay alive on macOS** |
| `before-quit` | set a `quitting` flag, then await the shutdown hook |
| `will-quit` | shutdown hook completes — [096](096-session-lifecycle-claude.md) registers PTY teardown here |

The shutdown hook is defined in this story as an empty, awaited registry
(`onShutdown(fn)`). It exists now so that killing PTYs later is a registration rather
than a refactor of the quit path — and so `before-quit` is already async-correct
before anything needs it.

## The menu is not optional

An Electron app with no `Menu` gets no `Cmd+C`, `Cmd+V`, `Cmd+A` or `Cmd+Q` on macOS,
because those are menu accelerators rather than browser behaviour. In an app whose
entire point is a terminal you copy text out of, that is a broken product.

Minimum menu: App (About, Hide, Quit), Edit (Undo, Redo, Cut, Copy, Paste, Select All),
View (Reload, Toggle DevTools — dev only, Actual Size, Zoom In/Out, Full Screen),
Window (Minimize, Zoom, Close).

`Cmd+C` inside a focused terminal is revisited in [095](095-interactive-terminal-surface.md),
where copy-on-selection and Ctrl-C-as-SIGINT have to coexist.

## Loading the renderer

```ts
const devUrl = process.env.ELECTRON_RENDERER_URL;   // set by electron-vite dev
devUrl ? win.loadURL(devUrl) : win.loadFile(join(__dirname, '../renderer/index.html'));
```

DevTools open automatically only when `devUrl` is set. A production build that pops
DevTools is a shipped bug.

## Robustness

- `render-process-gone` and `unresponsive` are logged and surfaced, never swallowed.
  A silent renderer crash in an app full of live terminals looks like the terminals
  froze.
- `webContents.setWindowOpenHandler` denies every `window.open`. External links from
  the terminal's web-links addon go to `shell.openExternal` after an `https:`/`http:`
  scheme check — an unchecked `openExternal` will happily run a `file:` or custom-scheme
  URL that arrived as terminal output.

## Tests

`tests/electron/main/` (Vitest, node environment, `electron` module mocked):

- Restore validation: a saved rect outside all display work areas falls back to centred.
- `window-all-closed` quits on `win32`, does not on `darwin`.
- Second instance focuses rather than creating a window.
- `setWindowOpenHandler` denies; `openExternal` rejects a non-http(s) scheme.
- The shutdown registry awaits every registered hook before `will-quit` resolves.

Real-window behaviour (chrome, drag region, restore across a relaunch) belongs to
[085](085-electron-test-harness.md).

## Acceptance criteria

- [ ] `pnpm desktop:dev` opens a window with no white flash and no native title bar
      above the app header; traffic lights sit inside the header.
- [ ] The header drags the window; every control in it remains clickable.
- [ ] Resize, move, quit, relaunch — the window returns to the same place.
- [ ] Disconnecting the display the window was saved on still yields a visible window.
- [ ] `Cmd+C` / `Cmd+V` / `Cmd+Q` work.
- [ ] Launching a second instance focuses the first.
- [ ] `pnpm build` (browser target) is unaffected by the drag-region change.
- [ ] Unit tests above pass.

## Out of scope

- Tray icon, dock badge, notifications, global shortcuts, deep links.
- Auto-update.
- Multi-window — the Hive is one window by design ([000](000-overview.md)).
