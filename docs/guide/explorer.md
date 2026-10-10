# Files and the editor

The **Files** tab of the session panel shows the repository of the session you are looking at.
Click a file to open it in a CodeMirror editor on the stage.

**On this page:** [Browse the project](#browse-the-project) · [Search](#search) ·
[Edit a file](#edit-a-file) · [Preview markdown](#preview-markdown) ·
[When the file changes on disk](#when-the-file-changes-on-disk) ·
[Changed files](#changed-files) · [Editor layouts](#editor-layouts) · [Limits](#limits)

![The Files tab in the session panel, README.md open in the editor, the terminal one tab away](../assets/guide/04-explorer-editor.png)

## Browse the project

- The tree follows the active session. On the overmind it shows the last project you looked
  at. If a session moves into a worktree under `.claude/worktrees/`, the tree follows it.
- **Refresh** and **Collapse all** sit at the top of the tab, with the current branch.
- Build and dependency folders are always hidden: `.git`, `node_modules`, `dist`, `out`,
  `.next`, `coverage`, `.turbo`, `target`, `__pycache__`, `.venv`. Other dotfiles show.
- The tree is read-only: no create, rename, move or delete.
- A terminal on the stage gets Files too, for the project it was opened in.

## Search

**Search files** has two modes. **Name** matches file names; **Text** matches contents.
Both are literal and case-insensitive, never a regex.

**Example.** To find every file that mentions the ledger route, switch to **Text** and type
`/ledger`. Each matching file is listed with its matching lines; click one to open it.

Searches stop at 200 files or 500 matches and show `500+` when capped.

## Edit a file

Editing is on by default; turn off **Allow editing** in **Settings › Editor** for a
read-only viewer. Save with `⌘S`. Seventeen languages get syntax colours; anything else
opens as plain text.

## Preview markdown

A `.md` file opens rendered. **Source · Preview · Split**, at the right of the tab strip,
switches it: Split puts the source beside the preview, and the two scroll together.
`⇧⌘V` flips between Source and Preview. To open markdown as source, set
**Settings › Editor › Markdown** to Source; a choice made on a file wins until you close it.

The preview follows the buffer, so it changes as you type and as an agent rewrites the file.

- **Links.** A link to another file in the project opens it; one that names nothing in the
  project says so. `http(s)` links open in your browser. Other links show as text.
- **Not rendered.** Images show as a placeholder naming the file. HTML other than
  `<details>`, `<summary>`, `<br>`, `<kbd>`, `<sub>` and `<sup>` shows as its source.

## When the file changes on disk

Agents and git change files under you. The editor keeps up:

| Your buffer | What changed | What happens |
| --- | --- | --- |
| no unsaved edits | the file changed on disk | it reloads silently |
| unsaved edits | the file changed on disk | a banner offers **Reload**; ignore it to keep your edits |
| any | you press `⌘S` after the file changed | nothing is written; **Overwrite** replaces the file |

The tree refreshes too, a moment after the change.

## Changed files

**Changed in this session** sits above the tree: the files the
session edited or created, each with its `+added −removed` count. Click one to open
it. In the tree, those files carry an `M` (modified) or a green `A` (added). The
tab shows how many, as `Files 3`, and so does the closed strip.

The list comes from what the session itself did, not from git. Edits by a
subagent are left out, `/clear` does not empty it, and it goes when the session
ends. A plain terminal has neither the list nor the marks.

## Editor layouts

Set in **Settings › Editor**:

| Placement | Open files | Back to the terminal |
| --- | --- | --- |
| Full stage, Tabs | tab strip with a **Terminal** tab | select Terminal |
| Full stage, One at a time | filename bar with × | Escape or × |
| Split, Tabs | tabs over the editor pane | the terminal stays visible |
| Split, One at a time | filename bar with × | Escape or × |

Split can be side by side or stacked. Font, size, tab width, wrapping and line numbers are
there too.

![Settings › Editor: placement, split direction, open files, text](../assets/guide/13-settings-editor.png)

## Limits

- Files over 1 MB, and binary files, are refused rather than opened.
- Open files are not restored after a restart.
- The editor only reaches files inside the project. A path or symlink that leads outside it
  is refused.
