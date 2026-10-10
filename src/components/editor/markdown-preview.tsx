import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { MarkdownCode } from '@components/editor/markdown-code';
import { classifyHref, type RelativeHref } from '@lib/markdown/href';
import type { MdBlock, MdDocument, MdInline } from '@lib/markdown/model';

/**
 * A rendered markdown document (the spec: `.hive/specs/2026-10-09-markdown-preview.md`).
 *
 * Inside the editor fence: it knows its props and nothing about the app.
 * **There is no `dangerouslySetInnerHTML` here and there must never be one.**
 * The document is written by whoever can push to the repository and renders in
 * the app's own document, so every element below is made from the model —
 * which has already decided which raw HTML survives (`lib/markdown/html.ts`)
 * — and every link goes through `classifyHref`.
 */

interface MarkdownPreviewProps {
  /** `null` until the first parse lands. */
  doc: MdDocument | null;
  /** The editor's size; prose is set one pixel larger. */
  fontSize: number;
  /** A relative link was followed. The parent asks main whether it names a file. */
  onOpenLink: (link: RelativeHref) => void;
  /** Split view: scroll so the block holding this 0-based source line is at the top. */
  topLine?: number | null;
  /** Split view: the first block still visible, reported as the user scrolls. */
  onTopLineChange?: (line: number) => void;
}

interface LinkContext {
  onOpenLink: (link: RelativeHref) => void;
  scrollToAnchor: (id: string) => void;
}

const LINK = 'text-brand hover:underline';

/** Sizes in `em`, relative to the prose size the user chose for the editor. */
const HEADING: Record<number, string> = {
  1: 'mt-0 mb-2 border-b border-border-soft pb-2 text-[1.85em] font-semibold',
  2: 'mt-6 mb-2 border-b border-border-soft pb-1.5 text-[1.35em] font-semibold',
  3: 'mt-5 mb-2 text-[1.15em] font-semibold',
};
const HEADING_SMALL = 'mt-4 mb-2 text-[1em] font-semibold';

function Inlines({ nodes, ctx }: { nodes: MdInline[]; ctx: LinkContext }) {
  return (
    <>
      {nodes.map((node, index) => (
        // Index keys: nodes have no identity, and the tree is rebuilt per parse.
        <Fragment key={index}>{renderInline(node, ctx)}</Fragment>
      ))}
    </>
  );
}

function Link({ href, children, ctx }: { href: string; children: MdInline[]; ctx: LinkContext }) {
  const target = classifyHref(href);
  const label = <Inlines nodes={children} ctx={ctx} />;

  switch (target.kind) {
    case 'external':
      // Reaches main's window-open handler, which re-checks the scheme.
      return (
        <a href={target.url} target="_blank" rel="noreferrer" className={LINK}>
          {label}
        </a>
      );
    case 'anchor':
      return (
        <button type="button" className={LINK} onClick={() => ctx.scrollToAnchor(target.id)}>
          {label}
        </button>
      );
    case 'relative':
      // A button, not an href: a relative href would resolve against the
      // renderer's own origin, which in dev is an http URL main would open.
      return (
        <button
          type="button"
          className={LINK}
          title={target.path}
          onClick={() => ctx.onOpenLink(target)}
        >
          {label}
        </button>
      );
    case 'refused':
      return <span>{label}</span>;
  }
}

function renderInline(node: MdInline, ctx: LinkContext): ReactNode {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'strong':
      return (
        <strong className="font-semibold">
          <Inlines nodes={node.children} ctx={ctx} />
        </strong>
      );
    case 'em':
      return (
        <em>
          <Inlines nodes={node.children} ctx={ctx} />
        </em>
      );
    case 'del':
      return (
        <del>
          <Inlines nodes={node.children} ctx={ctx} />
        </del>
      );
    case 'code':
      return (
        <code className="rounded-xs bg-chip px-1 py-px font-mono text-[0.86em]">{node.text}</code>
      );
    case 'br':
      return <br />;
    case 'tag': {
      const Tag = node.tag;
      return (
        <Tag
          className={
            node.tag === 'kbd'
              ? 'rounded-xs border border-border px-1 font-mono text-[0.86em]'
              : undefined
          }
        >
          <Inlines nodes={node.children} ctx={ctx} />
        </Tag>
      );
    }
    case 'image':
      // A placeholder: the CSP admits no remote image, and repo images need a
      // contained fs verb that is a follow-up.
      return (
        <span
          title={node.src}
          className="inline-flex items-center rounded-xs border border-dashed border-border px-1.5 text-micro text-subtle"
        >
          {node.alt === '' ? node.src : node.alt}
        </span>
      );
    case 'link':
      return (
        <Link href={node.href} ctx={ctx}>
          {node.children}
        </Link>
      );
  }
}

function Blocks({
  blocks,
  ctx,
  top = false,
}: {
  blocks: MdBlock[];
  ctx: LinkContext;
  top?: boolean;
}) {
  return (
    <>
      {blocks.map((block, index) => (
        <Fragment key={index}>{renderBlock(block, ctx, top ? block.line : undefined)}</Fragment>
      ))}
    </>
  );
}

function renderBlock(block: MdBlock, ctx: LinkContext, line: number | undefined): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const depth = Math.min(Math.max(block.depth, 1), 6);
      const Tag = `h${String(depth)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      // `data-anchor`, not `id`: a heading called "root" must not collide with
      // an element id elsewhere in the app's document.
      return (
        <Tag data-line={line} data-anchor={block.id} className={HEADING[depth] ?? HEADING_SMALL}>
          <Inlines nodes={block.children} ctx={ctx} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p data-line={line} className="mb-3">
          <Inlines nodes={block.children} ctx={ctx} />
        </p>
      );
    case 'code':
      return <MarkdownCode lang={block.lang} text={block.text} line={line} />;
    case 'quote':
      return (
        <blockquote data-line={line} className="mb-3 border-l-[3px] border-border pl-3.5 text-muted">
          <Blocks blocks={block.blocks} ctx={ctx} />
        </blockquote>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li
          key={index}
          className={cn('my-1', item.task && '-ml-5 flex list-none items-baseline gap-2')}
        >
          {item.task ? (
            <input
              type="checkbox"
              checked={item.checked}
              disabled
              readOnly
              aria-label={item.checked ? 'Done' : 'Not done'}
              className="accent-green"
            />
          ) : null}
          <div className="min-w-0 [&>p]:mb-1">
            <Blocks blocks={item.blocks} ctx={ctx} />
          </div>
        </li>
      ));
      return block.ordered ? (
        <ol data-line={line} start={block.start} className="mb-3 list-decimal pl-6">
          {items}
        </ol>
      ) : (
        <ul data-line={line} className="mb-3 list-disc pl-6">
          {items}
        </ul>
      );
    }
    case 'table':
      return (
        <div data-line={line} className="mb-3.5 overflow-x-auto">
          <table className="border-collapse text-[0.93em] tabular-nums">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th
                    key={index}
                    style={{ textAlign: block.align[index] ?? undefined }}
                    className="border border-border-soft bg-panel px-2.5 py-1 font-semibold"
                  >
                    <Inlines nodes={cell} ctx={ctx} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      style={{ textAlign: block.align[index] ?? undefined }}
                      className="border border-border-soft px-2.5 py-1"
                    >
                      <Inlines nodes={cell} ctx={ctx} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr data-line={line} className="my-5 border-border-soft" />;
    case 'details':
      return (
        <details
          data-line={line}
          open={block.open}
          className="mb-3 rounded-lg border border-border-soft px-3 py-1.5"
        >
          <summary className="cursor-pointer text-muted">
            <Inlines nodes={block.summary} ctx={ctx} />
          </summary>
          <div className="mt-2">
            <Blocks blocks={block.blocks} ctx={ctx} />
          </div>
        </details>
      );
    case 'raw':
      return (
        <p data-line={line} className="mb-3 font-mono text-[0.86em] whitespace-pre-wrap text-subtle">
          {block.text}
        </p>
      );
  }
}

/** Top-level blocks in document order — the only ones carrying a source line. */
const topBlocks = (scroller: HTMLElement): HTMLElement[] =>
  Array.from(scroller.querySelectorAll<HTMLElement>('article > [data-line]'));

export function MarkdownPreview({
  doc,
  fontSize,
  onOpenLink,
  topLine = null,
  onTopLineChange,
}: MarkdownPreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Read at scroll time, so a new callback identity never re-binds anything. */
  const onTopLineChangeRef = useRef(onTopLineChange);
  onTopLineChangeRef.current = onTopLineChange;

  const ctx = useMemo<LinkContext>(
    () => ({
      onOpenLink,
      scrollToAnchor: (id) => {
        const headings = scrollRef.current?.querySelectorAll<HTMLElement>('[data-anchor]') ?? [];
        Array.from(headings)
          .find((heading) => heading.dataset.anchor === id)
          ?.scrollIntoView({ block: 'start' });
      },
    }),
    [onOpenLink],
  );

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || topLine === null) return;
    let target: HTMLElement | null = null;
    for (const block of topBlocks(scroller)) {
      if (Number(block.dataset.line) > topLine) break;
      target = block;
    }
    // The scroller is `relative`, so it is each block's offsetParent.
    if (target) scroller.scrollTop = target.offsetTop;
  }, [topLine, doc]);

  const onScroll = () => {
    const scroller = scrollRef.current;
    const report = onTopLineChangeRef.current;
    if (!scroller || !report) return;
    const visible = topBlocks(scroller).find(
      (block) => block.offsetTop + block.offsetHeight > scroller.scrollTop,
    );
    if (visible) report(Number(visible.dataset.line));
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-markdown-preview=""
      className="relative min-h-0 flex-1 overflow-auto bg-panel-2 px-10 pt-7 pb-16"
    >
      <article
        className="mx-auto max-w-[74ch] leading-[1.65] text-ink"
        style={{ fontSize: `${String(fontSize + 1)}px` }}
      >
        {doc ? <Blocks blocks={doc.blocks} ctx={ctx} top /> : null}
      </article>
    </div>
  );
}
