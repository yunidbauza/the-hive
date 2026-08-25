# App icon

A stack of carapace plates carrying a prompt: three overlapping scutes — smooth
on the leading edge, two hooked spines trailing — receding up and to the right,
with a pale chevron and a white cursor on the front plate. One plate per
session, the front one live.

The hive this app is named for is the **Zerg** structure, not a beehive, and the
icon is drawn in that vocabulary. It replaced a terminal window wrapped around
the swarm insignia. The metaphor there was right and the arithmetic was not: the
insignia carries roughly forty hooks and curls, none of which survive being
sixteen pixels wide, so below 48px the dock showed a blue tile with grey soup in
it. Three plates, a chevron and a caret still resolve at 16.

Nothing is traced from a bitmap. The geometry in
`scripts/icon/generate-app-icon.py` *is* the mark, so there is no master image
for the ladder to drift from — and every colour is a token from
`src/styles/tokens.css`:

| | |
| --- | --- |
| `--cc-bg` `#10152A` | the ground, and the seam between plates |
| `--cc-active` `#222C55` | the rearmost plate |
| `--cc-brand-fill-strong` `#334FA9` | the middle plate |
| `--cc-brand-fill` `#5E76D0` | the front plate, the live one |
| `--cc-on-brand` `#FFFFFF` | the cursor |

The chevron is the one derived value — `--cc-brand` (#8FA7F2) is calibrated to
read as text on a panel and sits too close to the front plate's fill, so it is
lifted to `#C7D3FA`. If a colour changes in the tokens it must change in the
generator too; the icon has no palette of its own.

## What is here

| File | For |
| --- | --- |
| `icon.png` | 1024px master, full-bleed. The source electron-builder resamples from. |
| `icon-macos.png` | The same art on Apple's grid — 824 of 1024 points, margin around it. |
| `icon.icns` | macOS, cut from `icon-macos.png`. |
| `icon.ico` | Windows. 16 · 24 · 32 · 48 · 64 · 128 · 256. |
| `icons/<n>x<n>.png` | The Linux ladder, 16 → 1024. |

Two more come off the same master and land in `public/`, because the renderer
serves them: `favicon.png` and `apple-touch-icon.png` for the browser tab.
Browser tab and dock are one design at two sizes; neither can drift, because one
script writes both.

`public/hive-tile.png` used to be a third — the icon with its prompt line taken
out, drawn in the header's top-left. HIVE-100 retired it in favour of the live
hive sprite (`SwarmCreature`), and this script stopped writing it when the icon
was redrawn. The header and the dock are deliberately no longer the same image.

## Regenerating

    python3 scripts/icon/generate-app-icon.py

A one-off asset step, not part of `pnpm build` — run it when the design changes
and commit what it writes. It needs Pillow (`pip install pillow`); the `.icns`
additionally needs macOS's `iconutil`, and the script says so and skips that one
file rather than failing on another platform.

Two knobs are worth knowing before touching a coordinate. `FIT_SCALE` /
`FIT_FROM` / `FIT_TO` place the whole stack on the canvas — that is how the icon
grows or shrinks in the dock without a plate moving relative to its neighbours.
`SEAM` is the ink outline each plate is grown by before it is filled; without it
the three fills touch and the stack flattens into one shape with two stripes on
it.

## Wiring the installer

`electron-builder.yml` points `directories.buildResources` at this folder, and
the file names above are already the ones it looks for:

```yaml
directories:
  buildResources: resources
mac:
  icon: resources/icon.icns
```

Windows and Linux targets are not built today; `icon.ico` and `icons/` are
written anyway so that adding a target is a config change and not an asset run.

## Where the icon comes from at runtime

| | Packaged app | `pnpm desktop:dev` |
| --- | --- | --- |
| macOS | the bundle's `.icns` | `app.dock.setIcon` with `icon-macos.png` |
| Windows | the `.ico` compiled into the `.exe` | `BrowserWindow`'s `icon`, `icon.png` |
| Linux | the `.desktop` entry | `BrowserWindow`'s `icon`, `icon.png` |

The packaged column is entirely the installer's doing — none of it can be set
from inside a running process, which is why `electron/main/app-icon.ts` returns
nothing at all when `app.isPackaged`. The dev column exists only so a
development run does not sit in the dock under Electron's default icon; it
reads the masters straight from the working tree.

**Which master matters.** macOS lays the dock out on a grid where an icon
occupies 824 of 1024 points; the margin is how every icon lines up at the same
apparent size. Hand the dock a full-bleed tile and it obeys — the app then
stands a head taller than its neighbours, which is exactly what happened when
the dev dock was pointed at `icon.png`. Windows and Linux draw the file as
given and take the full-bleed master.
