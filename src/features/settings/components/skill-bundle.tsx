import { useMemo, useState } from 'react';

import { Icon } from '@components/ui/icon';
import type {
  BundleEntry,
  BundleExclusion,
  SkillSummary,
} from '@shared/skills-contract';

/**
 * One skill's files, in the column its name came from (HIVE-148).
 *
 * ## Why the tree needs no IPC of its own
 *
 * `SkillSummary.manifest` is a complete flat list of relative paths, walked in
 * main before this ever renders. Expansion is therefore `String.split` and a
 * lookup, not a round trip — which is why the explorer's `tree-node.tsx` would
 * be the wrong thing to reach for even if the slice fence allowed it. That tree
 * is lazy by design, one `fs:read-dir` per opened folder, keyed on a project.
 * This one already holds everything it will ever show.
 *
 * ## Why an excluded row is dimmed and not disabled
 *
 * It carries a two-word chip, and its sentence appears in the panel when the
 * row is selected — which requires the row to be selectable. `skills-section`
 * learned the other way round: an *invalid skill* row is `disabled`, so
 * Chromium delivers it no pointer events and the `title` holding its reason was
 * unreachable. An excluded file is not broken. It ships or it does not, the
 * user needs to read why, and they need to be able to delete it.
 *
 * The chip comes from `excluded.code`, never from `excluded.reason`. The reason
 * is prose main owns and may reword; the code is the contract.
 */

/**
 * Two words, keyed by the code and never parsed out of the sentence beside it.
 *
 * Typed as a total `Record` over `BundleExclusion` on purpose: adding a code in
 * `skills-contract.ts` without a chip for it then fails the build here, rather
 * than rendering a blank corner of a row nobody notices until a user asks why
 * their file is greyed out.
 */
const CHIP: Record<BundleExclusion, string> = {
  skipped: 'skipped',
  'too-large': 'too large',
  symlink: 'symlink',
};

interface Node {
  entry: BundleEntry;
  depth: number;
}

/**
 * `SKILL.md`, whether or not the manifest lists it.
 *
 * The walk stops at 200 files in `localeCompare` order, and `assets` and
 * `scripts` both sort before `SKILL.md` — so a large bundle's manifest can
 * genuinely lack it. The mirror already writes it regardless; without this the
 * pane would show a skill whose own file has no row, and the user could not
 * open the one file that makes it a skill.
 */
const MANIFEST: BundleEntry = {
  path: 'SKILL.md',
  kind: 'file',
  size: 0,
  executable: false,
  excluded: null,
};

interface SkillBundleProps {
  skill: SkillSummary;
  /** Which file is open, so its row reads as selected. */
  openPath: string | null;
  /**
   * Is the open buffer unsaved?
   *
   * Shown on the crumb rather than on a row, because the crumb is the control
   * that leaves. While the list was always visible an `edited` flag beside the
   * skill's name did that job; drilled in, the place a user is about to lose
   * work from is the way out.
   */
  dirty: boolean;
  onBack: () => void;
  onOpen: (path: string) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  /** Open main's own picker. No source path is ever named by the renderer. */
  onImport: (dir: string) => void;
  /** Files dropped onto the tree root, or onto one folder row. */
  onDrop: (dir: string, files: readonly File[]) => void;
}

export function SkillBundle({
  skill,
  openPath,
  dirty,
  onBack,
  onOpen,
  onNewFile,
  onNewFolder,
  onImport,
  onDrop,
}: SkillBundleProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** Is the Add menu showing? Closed on every choice. */
  const [adding, setAdding] = useState(false);
  /** The folder a drag is currently over, for the drop target's outline. */
  const [over, setOver] = useState<string | null>(null);

  /**
   * The manifest, grouped by parent path.
   *
   * Built once per manifest rather than filtered per row: a 200-entry bundle
   * rendered by scanning the whole list for every row is 40,000 comparisons on
   * each keystroke elsewhere in the pane.
   */
  const children = useMemo(() => {
    const byParent = new Map<string, BundleEntry[]>();
    const entries = skill.manifest.entries.some((e) => e.path === 'SKILL.md')
      ? skill.manifest.entries
      : [MANIFEST, ...skill.manifest.entries];

    for (const entry of entries) {
      const cut = entry.path.lastIndexOf('/');
      const parent = cut === -1 ? '' : entry.path.slice(0, cut);
      const bucket = byParent.get(parent);
      if (bucket === undefined) byParent.set(parent, [entry]);
      else bucket.push(entry);
    }
    return byParent;
  }, [skill.manifest.entries]);

  /** Depth-first, folders before files, and only under an opened folder. */
  const rows = useMemo(() => {
    const out: Node[] = [];

    const walk = (parent: string, depth: number): void => {
      const bucket = children.get(parent) ?? [];
      const sorted = [...bucket].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.path.localeCompare(b.path);
      });

      for (const entry of sorted) {
        out.push({ entry, depth });
        if (entry.kind === 'directory' && open.has(entry.path)) {
          walk(entry.path, depth + 1);
        }
      }
    };

    walk('', 0);
    return out;
  }, [children, open]);

  const toggle = (path: string): void => {
    setOver(null);
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /*
    A drop needs `preventDefault` on dragover or no drop event fires at all,
    and the browser navigates to the dropped file instead. The two handlers
    below are the whole reason this component owns its own drag state rather
    than delegating to a shared row.
  */
  const accept = (event: React.DragEvent, dir: string | null): void => {
    event.preventDefault();
    setOver(dir);
  };

  const receive = (event: React.DragEvent, dir: string): void => {
    event.preventDefault();
    // Dropping on a folder targets that folder, not the bundle root. Without
    // this the outer handler would also fire and the file would land twice.
    event.stopPropagation();
    setOver(null);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onDrop(dir, files);
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-[7px] border border-border">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 border-b border-border-soft px-2.5 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-ink"
      >
        <Icon name="ph-caret-left" size={12} />
        <span className="truncate">Skills</span>
        {dirty ? (
          <span className="ml-auto shrink-0 text-[11px] text-brand">edited</span>
        ) : null}
      </button>

      {/*
        A labelled group of buttons, deliberately **not** `role="tree"`.

        ARIA's tree widget promises a roving tabindex and arrow-key navigation.
        This has neither: every row is a real `<button>`, so Tab already reaches
        each one and Enter already activates it. Claiming the role would
        announce an interaction model that is not here, which is worse for a
        screen-reader user than the plain list of buttons this actually is.
        `jsx-a11y` catches exactly that, and it is right.
      */}
      <div
        aria-label={`Files in ${skill.name}`}
        onDragOver={(event) => {
          accept(event, '');
        }}
        onDragLeave={() => {
          setOver(null);
        }}
        onDrop={(event) => {
          receive(event, '');
        }}
        className={`flex min-h-0 flex-1 flex-col overflow-y-auto ${
          over === '' ? 'bg-active' : ''
        }`}
      >
        {rows.map(({ entry, depth }) => {
          const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
          const excluded = entry.excluded;
          const folder = entry.kind === 'directory';

          return (
            <button
              key={entry.path}
              type="button"
              aria-expanded={folder ? open.has(entry.path) : undefined}
              aria-current={entry.path === openPath ? 'true' : undefined}
              onClick={() => {
                if (folder) toggle(entry.path);
                else onOpen(entry.path);
              }}
              onDragOver={
                folder
                  ? (event) => {
                      event.stopPropagation();
                      accept(event, entry.path);
                    }
                  : undefined
              }
              onDrop={
                folder
                  ? (event) => {
                      receive(event, entry.path);
                    }
                  : undefined
              }
              style={{ paddingLeft: `${String(10 + depth * 10)}px` }}
              className={`flex items-center justify-between gap-1.5 border-b border-border-soft py-1.5 pr-2.5 text-left text-[12.5px] last:border-b-0 hover:bg-hover ${
                entry.path === openPath ? 'bg-active text-ink' : 'text-muted'
              } ${over === entry.path ? 'bg-active' : ''}`}
            >
              <span
                className={`flex min-w-0 items-center gap-1.5 ${
                  excluded === null ? '' : 'opacity-55'
                }`}
              >
                <Icon
                  name={
                    folder
                      ? open.has(entry.path)
                        ? 'ph-folder-open'
                        : 'ph-folder'
                      : 'ph-file'
                  }
                  size={12}
                  className="shrink-0"
                />
                <span className="truncate font-mono">{name}</span>
              </span>
              {excluded === null ? null : (
                <span className="shrink-0 text-[11px] text-subtle">
                  {CHIP[excluded.code]}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/*
        Said once, at the bottom, rather than on a row — a truncated walk has no
        row to hang it on, which is the whole reason `capped` is separate from
        an entry's own `excluded`.
      */}
      {skill.manifest.capped === null ? null : (
        <p className="border-t border-border-soft px-2.5 py-1.5 text-[11px] text-amber">
          {skill.manifest.capped}
        </p>
      )}

      {adding ? (
        /*
          Three plain buttons rather than a dropdown primitive. The column is
          190px and the menu has three items that never grow; a popover would
          add a layer, a portal and a dismissal rule to a list that fits.
        */
        <div className="flex flex-col border-t border-border-soft">
          {(
            [
              ['New file', onNewFile],
              ['New folder', onNewFolder],
              ['Add from your computer', onImport],
            ] as const
          ).map(([label, act]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                setAdding(false);
                act('');
              }}
              className="px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-hover hover:text-ink"
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setAdding(false);
            }}
            className="border-t border-border-soft px-2.5 py-1.5 text-left text-[11.5px] text-subtle hover:bg-hover"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setAdding(true);
          }}
          className="border-t border-border-soft px-2.5 py-1.5 text-left font-mono text-[12.5px] text-brand hover:bg-hover"
        >
          + Add
        </button>
      )}
    </div>
  );
}
