import { Fragment } from 'react';

import { cn } from '@/lib/utils';

import type { AdfBlock, AdfRun } from '@shared/jira-contract';

/**
 * Rendered ADF (HIVE-71).
 *
 * Takes the block/run structure main produced and maps it to elements this file
 * owns. **There is no `dangerouslySetInnerHTML` here and there must never be
 * one**: a Jira comment is arbitrary text written by anyone with access to the
 * issue, and rendering it as markup would make every project this app can read
 * a path into the app. Main hands over text and mark names; this decides what
 * they look like.
 *
 * The `unknown` kind is a node type main had never met — a panel, a media
 * group, a status lozenge. Its text renders as an ordinary paragraph, slightly
 * muted, because a comment the app cannot fully render is still a comment the
 * user needs to read.
 */

function Run({ run }: { run: AdfRun }) {
  const className = cn(
    run.marks.includes('strong') && 'font-semibold text-ink',
    run.marks.includes('em') && 'italic',
    run.marks.includes('strike') && 'line-through',
    run.marks.includes('code') &&
      'rounded-[3px] bg-chip px-1 py-px font-mono text-[11px]',
  );

  if (run.href !== undefined) {
    return (
      <a
        href={run.href}
        target="_blank"
        rel="noreferrer"
        className={cn(className, 'text-brand hover:underline')}
      >
        {run.text}
      </a>
    );
  }

  // A hard break arrives as a run whose text is a newline; `whitespace-pre-wrap`
  // on the block is what makes it show.
  return className === '' ? (
    <>{run.text}</>
  ) : (
    <span className={className}>{run.text}</span>
  );
}

function Runs({ runs }: { runs: AdfRun[] }) {
  return (
    <>
      {runs.map((run, index) => (
        // Index keys: runs have no identity of their own, and the list is
        // replaced wholesale whenever the comment is re-read.
        <Fragment key={index}>
          <Run run={run} />
        </Fragment>
      ))}
    </>
  );
}

function Block({ block }: { block: AdfBlock }) {
  if (block.kind === 'rule') {
    return <hr className="my-1.5 border-border-soft" />;
  }

  if (block.kind === 'code') {
    return (
      <pre className="overflow-x-auto rounded-[5px] bg-term-bg px-2 py-1.5 font-mono text-[11px] text-ink">
        {block.runs.map((run) => run.text).join('')}
      </pre>
    );
  }

  if (block.kind === 'heading') {
    return (
      <p className="text-[12.5px] font-semibold text-ink">
        <Runs runs={block.runs} />
      </p>
    );
  }

  if (block.kind === 'quote') {
    return (
      <p className="border-l-2 border-border pl-2 text-[12px] whitespace-pre-wrap text-muted">
        <Runs runs={block.runs} />
      </p>
    );
  }

  if (block.kind === 'bullet' || block.kind === 'ordered') {
    return (
      <p
        className="text-[12px] whitespace-pre-wrap text-muted"
        style={{ paddingLeft: `${(block.depth ?? 0) * 12 + 10}px` }}
      >
        <span className="text-subtle">
          {block.kind === 'bullet' ? '• ' : '– '}
        </span>
        <Runs runs={block.runs} />
      </p>
    );
  }

  return (
    <p
      className={cn(
        'text-[12px] whitespace-pre-wrap',
        // Slightly muted, so a node the app could not structure is visibly
        // different from one it could — without hiding it.
        block.kind === 'unknown' ? 'text-subtle' : 'text-muted',
      )}
    >
      <Runs runs={block.runs} />
    </p>
  );
}

export function AdfBlocks({ blocks }: { blocks: AdfBlock[] }) {
  if (blocks.length === 0) {
    return (
      <p className="text-[12px] text-subtle">
        This comment has nothing this app can display.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {blocks.map((block, index) => (
        <Fragment key={index}>
          <Block block={block} />
        </Fragment>
      ))}
    </div>
  );
}
