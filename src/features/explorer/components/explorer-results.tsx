import { useState } from 'react';

import { Icon } from '@components/ui/icon';
import { fileIconName } from '@lib/explorer/file-icon';
import { parentPath } from '@lib/explorer/fs-client';
import type { SearchHit, SearchLine } from '@shared/fs-contract';

/**
 * What a search answers with.
 *
 * ## Grouped by file, because a flat list is unreadable here
 *
 * The rail is 316px. Five hundred lines in one column is a wall nobody reads,
 * and the file a hit is in is the first thing anyone wants to know about it —
 * so the file is the row, and its lines hang beneath. Groups start open,
 * because a closed group hides the only thing that distinguishes it from a
 * filename match.
 *
 * ## The path is a second line, not a prefix
 *
 * `src/components/ui/badge.tsx` truncated to fit reads as `src/compone…`,
 * which loses the filename — the one part that was searched for. So the name
 * gets the row and the directory gets a quieter line under it, clipped from
 * the *left*, which is where a path stops mattering.
 *
 * ## Highlighting is computed, never sent
 *
 * Main answers with a column, not with markup. Splitting here keeps the IPC
 * payload a plain string and keeps this the only place that knows what a match
 * looks like — the same rule the terminal seam follows for colour.
 */

interface ExplorerResultsProps {
  hits: readonly SearchHit[];
  query: string;
  onOpenFile: (relPath: string, name: string) => void;
}

export function ExplorerResults({ hits, query, onOpenFile }: ExplorerResultsProps) {
  return (
    <div className="flex flex-col gap-px">
      {hits.map((hit) => (
        <HitGroup
          key={hit.relPath}
          hit={hit}
          query={query}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

function HitGroup({
  hit,
  query,
  onOpenFile,
}: {
  hit: SearchHit;
  query: string;
  onOpenFile: (relPath: string, name: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const directory = parentPath(hit.relPath);
  const hasLines = hit.lines.length > 0;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => {
          // A name match has nothing to expand, so the row opens the file —
          // which is the only thing anyone wants from it.
          if (hasLines) setOpen((shown) => !shown);
          else onOpenFile(hit.relPath, hit.name);
        }}
        title={hit.relPath}
        className="flex w-full items-center gap-1.5 rounded-[5px] px-1.5 py-[3px] text-left hover:bg-hover"
      >
        {hasLines ? (
          <Icon
            name={open ? 'ph-caret-down' : 'ph-caret-right'}
            size={11}
            className="shrink-0 text-subtle"
          />
        ) : null}
        <Icon
          name={fileIconName(hit.name)}
          size={12}
          className="shrink-0 text-subtle"
        />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">
          <Marked text={hit.name} query={query} />
        </span>
        {hit.total > 1 ? (
          <span className="shrink-0 rounded-full bg-chip px-1.5 text-[9.5px] text-muted tabular-nums">
            {hit.total}
          </span>
        ) : null}
      </button>

      {directory === '' ? null : (
        <span
          className="truncate px-1.5 pb-0.5 pl-[26px] text-[10px] text-subtle"
          dir="rtl"
          title={directory}
        >
          {directory}/
        </span>
      )}

      {open && hasLines
        ? hit.lines.map((line) => (
            <LineRow
              key={line.line}
              line={line}
              query={query}
              onOpen={() => {
                onOpenFile(hit.relPath, hit.name);
              }}
            />
          ))
        : null}

      {/*
        Said out loud, because a group that silently showed twenty of a
        hundred hits is the same untruth as a total printed over a truncated
        set — the rule the PRs panel states for its own "200+".
      */}
      {open && hasLines && hit.total > hit.lines.length ? (
        <span className="px-1.5 pb-1 pl-[26px] text-[10px] text-subtle">
          + {hit.total - hit.lines.length} more in this file
        </span>
      ) : null}
    </div>
  );
}

function LineRow({
  line,
  query,
  onOpen,
}: {
  line: SearchLine;
  query: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-baseline gap-2 rounded-[5px] py-[2px] pr-1.5 pl-[26px] text-left hover:bg-hover"
    >
      <span className="w-6 shrink-0 text-right text-[10px] text-subtle tabular-nums">
        {line.line}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted">
        <Marked text={line.text} query={query} at={line.column} />
      </span>
    </button>
  );
}

/**
 * The query, picked out of the string it was found in.
 *
 * `at` is main's column when there is one, so a line highlights the hit main
 * actually counted rather than the first case-insensitive lookalike. Without it
 * — a filename match — the search is done here, on the one short string.
 */
function Marked({
  text,
  query,
  at,
}: {
  text: string;
  query: string;
  at?: number;
}) {
  const start =
    at ?? text.toLowerCase().indexOf(query.toLowerCase());
  if (start < 0 || query === '' || start + query.length > text.length) {
    return <>{text}</>;
  }

  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-[2px] bg-code-selection text-ink">
        {text.slice(start, start + query.length)}
      </mark>
      {text.slice(start + query.length)}
    </>
  );
}
