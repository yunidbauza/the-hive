# App icon

The desktop icon is the app in miniature: a terminal window in the app's own
chrome, and on the screen a prompt line — a pale-blue chevron and the hive mark
standing on a cursor underscore, the mark playing the character the caret is
holding.

Nothing here is hand-drawn. Everything is cut from `public/hive-mark.png` — the
same file the header renders — and painted in tokens from
`src/styles/tokens.css`: ink `#10152A` for the chrome, Serenity `#334FA9` for
the screen, `#8FA7F2` for the chevron and two of the title-bar dots, `#74B79C`
for the live one. If a colour changes in the tokens it must change in the
generator too; the icon has no palette of its own.

## What is here

| File | For |
| --- | --- |
| `icon.png` | 1024px master, full-bleed. The source electron-builder resamples from. |
| `icon.icns` | macOS. Inset to 82.4% of the canvas so the dock sizes it like a native app. |
| `icon.ico` | Windows. 16 · 24 · 32 · 48 · 64 · 128 · 256. |
| `icons/<n>x<n>.png` | The Linux ladder, 16 → 1024. |

`public/favicon.png` and `public/apple-touch-icon.png` come off the same master,
so the browser tab and the desktop app show one icon rather than two designs.

## Regenerating

    python3 scripts/icon/generate-app-icon.py

A one-off asset step, not part of `pnpm build` — run it when the mark or the
design changes and commit what it writes. It needs Pillow (`pip install
pillow`); the `.icns` additionally needs macOS's `iconutil`, and the script says
so and skips that one file rather than failing on another platform.

The script also floors `public/hive-mark.png`'s alpha: the original carried a
baked-in transparency checkerboard at alpha 17, which printed a faint grid
behind the mark wherever it was composited, the header tile included.

## Wiring the installer

There is no packaging config in the repo yet. When electron-builder lands, this
directory is what it should be pointed at — the file names above are already the
ones it looks for:

```yaml
directories:
  buildResources: resources
mac:
  icon: resources/icon.icns
win:
  icon: resources/icon.ico
linux:
  icon: resources/icons
```

## Where the icon comes from at runtime

| | Packaged app | `pnpm desktop:dev` |
| --- | --- | --- |
| macOS | the bundle's `.icns` | `app.dock.setIcon`, from `electron/main/app-icon.ts` |
| Windows | the `.ico` compiled into the `.exe` | `BrowserWindow`'s `icon` option |
| Linux | the `.desktop` entry | `BrowserWindow`'s `icon` option |

The packaged column is entirely the installer's doing — none of it can be set
from inside a running process, which is why `app-icon.ts` returns nothing at all
when `app.isPackaged`. The dev column exists only so a development run does not
sit in the dock under Electron's default icon; it reads `resources/icon.png`
straight from the working tree.
