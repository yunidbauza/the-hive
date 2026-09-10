import { CaretRight, Folder, FolderOpen } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui/dialog';
import { browseServerDirectory } from '@lib/project-config';
import type { BrowseListing } from '@shared/config-contract';

/**
 * Choosing a folder on a machine you are not sitting at (HIVE-146).
 *
 * While attached, `config:choose-directory` cannot be answered: a native dialog
 * needs a parent window and the server has none. So the renderer asks for a
 * listing over `config:browse-directory` and draws the picker itself, one
 * directory level at a time.
 *
 * ## Why a breadcrumb and a list, rather than a tree
 *
 * The task is "choose one folder", not "explore a hierarchy". A drill-down
 * stays a constant height however deep the path goes, costs exactly one call
 * per step, and needs no expansion state to hold or to assert in a test. The
 * explorer's tree is the other shape and was considered: it compares siblings
 * better, but its indentation runs out around four levels, and
 * `explorer/tree-node.tsx` could not have been reused anyway — it is bound to a
 * `projectId`, which is precisely what a folder that is not a project yet does
 * not have.
 *
 * ## The selection is where you are standing
 *
 * Clicking a row descends into it; it does not select it. What gets added is
 * the directory named in the breadcrumb, which is the one whose contents are on
 * screen. That removes a whole class of confusion — a highlighted row and a
 * separate "current folder" disagreeing about what the button will do — at the
 * cost of one extra click to choose a folder you can already see. Worth it: the
 * button says which path it will add, in full, at all times.
 */

export interface DirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the absolute path of the chosen folder. */
  onChoose: (path: string) => void;
  /** Named in the header, so the user knows whose disk they are looking at. */
  serverName: string;
}

/** What the breadcrumb renders: a label, and the path clicking it browses to. */
interface Crumb {
  label: string;
  path: string;
}

/**
 * Split an absolute path into breadcrumb segments, with home shown as `~`.
 *
 * Home is the root and is always the first crumb, so a path that somehow is not
 * under it still renders something navigable rather than an empty bar. That
 * cannot happen while main is doing its job — the fence guarantees containment
 * — which is exactly why it is handled quietly here rather than asserted.
 */
function crumbsFor(listing: BrowseListing): Crumb[] {
  const crumbs: Crumb[] = [{ label: '~', path: listing.home }];
  if (listing.path === listing.home) return crumbs;
  if (!listing.path.startsWith(`${listing.home}/`)) return crumbs;

  const rest = listing.path.slice(listing.home.length + 1).split('/');
  let walked = listing.home;
  for (const segment of rest) {
    walked = `${walked}/${segment}`;
    crumbs.push({ label: segment, path: walked });
  }
  return crumbs;
}

export function DirectoryPicker({
  open,
  onOpenChange,
  onChoose,
  serverName,
}: DirectoryPickerProps) {
  const [listing, setListing] = useState<BrowseListing | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The path of the most recent request.
   *
   * Two clicks in quick succession race, and without this the slower one wins
   * by arriving last — so a fast child directory could be overwritten by its
   * own slow parent. Compared on arrival rather than cancelled at the source
   * because there is nothing to cancel: an `invoke` is already in flight.
   */
  const latest = useRef<string | null>(null);

  const browse = useCallback(async (path: string) => {
    latest.current = path;
    setBusy(true);
    try {
      const result = await browseServerDirectory(path);
      if (latest.current !== path) return;

      // No bridge at all — the browser target, where this is unreachable.
      if (result === null) {
        setFailure('this needs the desktop app');
        return;
      }
      if (!result.ok) {
        // The last good listing stays on screen, so a refused step is one the
        // user can simply step back from rather than a dead modal.
        setFailure(result.error.message);
        return;
      }
      setFailure(null);
      setListing(result.value);
    } catch (cause) {
      if (latest.current !== path) return;
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (latest.current === path) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // `''` is home. Re-browsed on every open rather than kept, so the picker
    // never opens onto a folder that has since been moved or deleted.
    setListing(null);
    setFailure(null);
    void browse('');
  }, [open, browse]);

  const crumbs = listing ? crumbsFor(listing) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px] gap-0 border-border bg-panel p-0">
        <DialogHeader className="gap-[7px] border-b border-border-soft px-3.5 pt-3 pb-2.5">
          <DialogTitle className="text-[13px] font-semibold text-ink">
            Choose a project folder
          </DialogTitle>
          <DialogDescription className="sr-only">
            Browse folders on {serverName} and add one as a project.
          </DialogDescription>
          <span className="flex w-fit items-center gap-1.5 rounded-[3px] border border-border bg-chip px-[7px] py-0.5 text-[11px] text-muted">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-amber" />
            reading {serverName} · not this Mac
          </span>
          {crumbs.length > 0 && (
            <nav aria-label="Path" className="flex flex-wrap items-center gap-0.5">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="flex items-center gap-0.5">
                  {index > 0 && (
                    <span aria-hidden="true" className="text-subtle">
                      /
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void browse(crumb.path)}
                    aria-current={index === crumbs.length - 1 ? 'true' : undefined}
                    className="rounded-[3px] px-1.5 py-0.5 text-[11.5px] text-muted hover:bg-hover hover:text-ink aria-[current]:font-semibold aria-[current]:text-ink"
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
          )}
        </DialogHeader>

        <div
          role="listbox"
          aria-label="Folders"
          aria-busy={busy}
          className="flex max-h-56 flex-col gap-px overflow-y-auto p-1.5"
        >
          {failure !== null && (
            <p className="px-2 py-1.5 text-[11.5px] text-red">{failure}</p>
          )}
          {listing?.entries.map((entry) => {
            const unreadable = entry.childCount === null;
            return (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-selected={false}
                disabled={unreadable}
                title={unreadable ? 'this folder cannot be read' : undefined}
                onClick={() => void browse(entry.path)}
                className="flex w-full items-center gap-2 rounded-[3px] border border-transparent px-2 py-1.5 text-left text-ink hover:bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <Folder aria-hidden="true" className="size-3.5 shrink-0 text-subtle" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="shrink-0 text-[11px] text-subtle">
                  {unreadable
                    ? 'no access'
                    : entry.childCount === 0
                      ? 'empty'
                      : `${entry.childCount} items`}
                </span>
                {!unreadable && (
                  <CaretRight
                    aria-hidden="true"
                    className="size-3 shrink-0 text-subtle"
                  />
                )}
              </button>
            );
          })}
          {listing !== null && listing.entries.length === 0 && failure === null && (
            <p className="flex items-center gap-2 px-2 py-1.5 text-[11.5px] text-subtle">
              <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
              No folders here. You can still add this one.
            </p>
          )}
        </div>

        <DialogFooter className="flex-row flex-wrap items-center gap-2.5 border-t border-border-soft px-3.5 py-2.5">
          <p className="min-w-0 flex-1 truncate text-[11px] text-muted">
            {listing === null ? (
              'Reading…'
            ) : (
              <>
                Use <span className="font-semibold text-ink">{listing.path}</span>
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-[3px] border border-border bg-panel-2 px-[11px] py-[5px] text-[12px] text-ink hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={listing === null}
            onClick={() => {
              if (listing !== null) onChoose(listing.path);
            }}
            className="rounded-[3px] border border-brand-fill-strong bg-brand-fill-strong px-[11px] py-[5px] text-[12px] text-on-brand hover:border-brand-fill hover:bg-brand-fill disabled:opacity-60"
          >
            Add project
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
