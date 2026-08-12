import type {
  AdfBlock,
  AdfNode,
  AdfRun,
} from '../../../../shared/jira-contract';

/**
 * ADF back to something displayable (HIVE-71).
 *
 * The other direction from `markdown-to-adf.ts`, and its own problem: ADF is a
 * large format and a comment can contain anything Jira's editor can produce —
 * panels, media groups, status lozenges, mentions, tables.
 *
 * ## Blocks and runs, not HTML
 *
 * This produces a small structure the renderer maps to elements it owns. That
 * is a security decision as much as an architectural one: a comment is
 * arbitrary text written by anyone with access to the issue, and handing the
 * renderer markup to inject would make every Jira project a path into this app.
 * There is no `dangerouslySetInnerHTML` at the far end of this, and there is no
 * way to add one without changing this file's return type.
 *
 * ## Unknown nodes render as text, never as nothing
 *
 * Scoped to the node types the app will actually meet — paragraph, headings,
 * text with marks, lists, code blocks, quotes, links, rules — with everything
 * else flattened to its text under `kind: 'unknown'`. A comment the app cannot
 * fully render is still a comment the user needs to read, and losing it because
 * somebody used a Jira panel macro would be the worse failure by far.
 */

/** The marks this app renders. Anything else is dropped, never shown raw. */
const RENDERED_MARKS = new Set(['strong', 'em', 'code', 'strike']);

/** Flatten a node's inline content into runs, carrying marks and links. */
function runsOf(nodes: AdfNode[] | undefined): AdfRun[] {
  const runs: AdfRun[] = [];

  const walk = (node: AdfNode | undefined, inherited: AdfRun): void => {
    if (node === undefined) return;

    if (node.type === 'text') {
      const marks = node.marks ?? [];
      const link = marks.find((mark) => mark.type === 'link');
      const rendered = marks
        .map((mark) => mark.type)
        .filter((type): type is AdfRun['marks'][number] =>
          RENDERED_MARKS.has(type),
        );

      const href = link?.attrs?.href ?? inherited.href;
      runs.push({
        text: node.text ?? '',
        marks: [...new Set([...inherited.marks, ...rendered])],
        ...(href === undefined ? {} : { href }),
      });
      return;
    }

    if (node.type === 'hardBreak') {
      runs.push({ text: '\n', marks: [] });
      return;
    }

    /**
     * A mention or an emoji has no `text`, and dropping it would silently
     * remove the person a comment is addressed to. Jira puts the display form
     * in `attrs`, so the flattening below picks up whatever is there — and
     * where there is nothing, the node contributes nothing rather than an empty
     * artefact.
     */
    if (node.type === 'inlineCard') {
      const href = node.attrs?.href;
      if (href !== undefined) runs.push({ text: href, marks: [], href });
      return;
    }

    for (const child of node.content ?? []) walk(child, inherited);
  };

  for (const node of nodes ?? []) walk(node, { text: '', marks: [] });
  return runs;
}

/** Every bit of text under a node, for the unknown-node fallback. */
function textOf(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(textOf).join('');
}

function listBlocks(
  node: AdfNode,
  kind: 'bullet' | 'ordered',
  depth: number,
): AdfBlock[] {
  const out: AdfBlock[] = [];

  for (const item of node.content ?? []) {
    if (item.type !== 'listItem') continue;

    const inline: AdfNode[] = [];
    const nested: AdfBlock[] = [];

    for (const child of item.content ?? []) {
      if (child.type === 'bulletList') {
        nested.push(...listBlocks(child, 'bullet', depth + 1));
      } else if (child.type === 'orderedList') {
        nested.push(...listBlocks(child, 'ordered', depth + 1));
      } else {
        inline.push(child);
      }
    }

    out.push({ kind, runs: runsOf(inline), depth });
    out.push(...nested);
  }

  return out;
}

function blockOf(node: AdfNode): AdfBlock[] {
  switch (node.type) {
    case 'paragraph':
      return [{ kind: 'paragraph', runs: runsOf(node.content) }];
    case 'heading':
      return [
        {
          kind: 'heading',
          runs: runsOf(node.content),
          level: Math.min(Math.max(node.attrs?.level ?? 1, 1), 6),
        },
      ];
    case 'codeBlock':
      return [
        {
          kind: 'code',
          runs: [{ text: (node.content ?? []).map(textOf).join(''), marks: [] }],
          ...(node.attrs?.language === undefined
            ? {}
            : { language: node.attrs.language }),
        },
      ];
    case 'blockquote':
      // Flattened to one quote block rather than nested: a quoted list inside a
      // comment is rare, and a nesting model nobody exercises is a nesting model
      // that is wrong.
      return [
        {
          kind: 'quote',
          runs: runsOf(node.content?.flatMap((child) => child.content ?? [])),
        },
      ];
    case 'bulletList':
      return listBlocks(node, 'bullet', 0);
    case 'orderedList':
      return listBlocks(node, 'ordered', 0);
    case 'rule':
      return [{ kind: 'rule', runs: [] }];
    default: {
      // Everything the app has never met. Its text survives; its structure does
      // not, which is the right trade for a node type nobody has seen.
      const text = textOf(node);
      return text === '' ? [] : [{ kind: 'unknown', runs: [{ text, marks: [] }] }];
    }
  }
}

/**
 * A whole ADF document, or an empty list if it is not one.
 *
 * Never throws. A comment whose body this cannot read is a comment that renders
 * as empty, which the panel says out loud — far better than an exception that
 * takes the other forty comments with it.
 */
export function adfToBlocks(doc: unknown): AdfBlock[] {
  if (doc === null || typeof doc !== 'object') return [];
  const content = (doc as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  return content.flatMap((node) =>
    node !== null && typeof node === 'object' ? blockOf(node as AdfNode) : [],
  );
}
