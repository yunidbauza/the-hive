import { randomUUID } from 'node:crypto';

import type { AdfDoc, AdfMark, AdfNode } from '../../../../shared/jira-contract';

import {
  marked,
  type MarkedListItem,
  type MarkedToken,
} from './vendor/marked/marked.esm.mjs';

/**
 * Markdown to Atlassian Document Format (HIVE-71).
 *
 * ## Where this came from
 *
 * Ported from `claude-kit/plugins/jira-writer/skills/jira-writer/scripts/
 * markdown-to-adf.mjs`, which the epic identified as the one part of that
 * plugin worth taking. The logic is upstream's — every rule below was learned
 * from Jira rejecting a document — and the deviations are two, both deliberate:
 *
 * 1. **TypeScript, not `.mjs`.** This repo's `tsconfig` is `strict` with
 *    `erasableSyntaxOnly`; a `.mjs` file sits outside `pnpm type-check`
 *    entirely, which for the module that builds the payload of a write is the
 *    wrong place to have no compiler.
 * 2. **No CLI.** Upstream is a script with a `main()`; this is a library. The
 *    argv handling and the file I/O went with the port.
 *
 * `marked` is **vendored** rather than added as a dependency, in
 * `./vendor/marked/`, with its licence and version alongside. That keeps the
 * property the epic was protecting when it rejected the bash client: no new
 * runtime dependency, nothing to resolve at install time.
 *
 * ## Why markdown at all
 *
 * Jira Cloud's v3 API takes and returns ADF. Posting a markdown string produces
 * a comment with literal `**` in it — which is the entire reason this file
 * exists rather than the app sending what the user typed.
 */

const HTML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
};

function unescapeHtml(value: string): string {
  return value.replace(
    /&(?:lt|gt|amp|quot|#39);/g,
    (match) => HTML_ENTITIES[match] ?? match,
  );
}

/**
 * ADF's `code` mark is **exclusive** — it may not share a text node with
 * `strong`, `em` or `link`.
 *
 * Jira rejects the document outright rather than dropping the extra mark, so
 * this resolves the conflict here: an incoming non-code mark is dropped when
 * code is already present, and an incoming code mark clears whatever was there.
 * `adf-validate.ts` asserts the same rule, which is what makes a violation a
 * local failure rather than an opaque 400.
 */
function addMark(node: AdfNode, mark: AdfMark): void {
  if (node.type !== 'text') return;
  const existing = node.marks ?? [];
  const hasCode = existing.some((m) => m.type === 'code');
  const isCode = mark.type === 'code';
  if (hasCode && !isCode) return;
  if (isCode && existing.length > 0) node.marks = [];
  node.marks = [...(node.marks ?? []), mark];
}

function inlineTokens(tokens: MarkedToken[] | undefined): AdfNode[] {
  const out: AdfNode[] = [];
  for (const token of tokens ?? []) {
    if (token.type === 'text') {
      out.push({ type: 'text', text: unescapeHtml(token.text ?? '') });
    } else if (token.type === 'strong') {
      const inner = inlineTokens(token.tokens);
      for (const node of inner) addMark(node, { type: 'strong' });
      out.push(...inner);
    } else if (token.type === 'em') {
      const inner = inlineTokens(token.tokens);
      for (const node of inner) addMark(node, { type: 'em' });
      out.push(...inner);
    } else if (token.type === 'del') {
      const inner = inlineTokens(token.tokens);
      for (const node of inner) addMark(node, { type: 'strike' });
      out.push(...inner);
    } else if (token.type === 'codespan') {
      out.push({
        type: 'text',
        text: unescapeHtml(token.text ?? ''),
        marks: [{ type: 'code' }],
      });
    } else if (token.type === 'link') {
      const inner = inlineTokens(token.tokens);
      for (const node of inner) {
        addMark(node, { type: 'link', attrs: { href: token.href ?? '' } });
      }
      out.push(...inner);
    } else if (token.type === 'br') {
      out.push({ type: 'hardBreak' });
    } else if (token.type === 'escape' || token.type === 'html') {
      // Raw HTML becomes literal text. ADF has no HTML node, and inventing one
      // would post markup Jira renders as prose anyway.
      out.push({ type: 'text', text: token.text ?? '' });
    }
  }
  return out;
}

/**
 * `tokenToAdf` may answer with one node or several — `taskList` splits around
 * blocks that cannot live inside a task item. This flattens either shape.
 */
function blocksFromTokens(tokens: MarkedToken[] | undefined): AdfNode[] {
  return (tokens ?? []).flatMap((token) => {
    const result = tokenToAdf(token);
    if (result === null) return [];
    return Array.isArray(result) ? result : [result];
  });
}

function listItem(item: MarkedListItem): AdfNode {
  const blocks = (item.tokens ?? []).flatMap((token) => {
    if (token.type === 'text') {
      return [
        {
          type: 'paragraph',
          content: inlineTokens(
            token.tokens ?? [{ type: 'text', text: token.text ?? '' }],
          ),
        } satisfies AdfNode,
      ];
    }
    const result = tokenToAdf(token);
    if (result === null) return [];
    return Array.isArray(result) ? result : [result];
  });

  return {
    type: 'listItem',
    content: blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [] }],
  };
}

/**
 * ADF's `taskItem` content is **inline only**.
 *
 * So a sublist or a follow-on paragraph under a checkbox cannot live inside the
 * item. Rather than drop them, the list is split: the trailing blocks are
 * emitted immediately after the segment containing their item, which preserves
 * reading order and loses nothing.
 */
function taskList(items: MarkedListItem[]): AdfNode | AdfNode[] {
  const out: AdfNode[] = [];
  let current: AdfNode | null = null;

  const flush = (): void => {
    if (current !== null) out.push(current);
    current = null;
  };

  for (const item of items) {
    const tokens = item.tokens ?? [];
    const inner = tokens.find((token) => token.type === 'text');

    current ??= {
      type: 'taskList',
      attrs: { localId: randomUUID() },
      content: [],
    };
    current.content = [
      ...(current.content ?? []),
      {
        type: 'taskItem',
        attrs: {
          localId: randomUUID(),
          state: item.checked === true ? 'DONE' : 'TODO',
        },
        content:
          inner === undefined
            ? []
            : inlineTokens(
                inner.tokens ?? [{ type: 'text', text: inner.text ?? '' }],
              ),
      },
    ];

    const trailing: AdfNode[] = [];
    for (const token of tokens) {
      if (token === inner) continue;
      if (token.type === 'text') {
        trailing.push({
          type: 'paragraph',
          content: inlineTokens(
            token.tokens ?? [{ type: 'text', text: token.text ?? '' }],
          ),
        });
        continue;
      }
      const result = tokenToAdf(token);
      if (result !== null) {
        trailing.push(...(Array.isArray(result) ? result : [result]));
      }
    }

    if (trailing.length > 0) {
      flush();
      out.push(...trailing);
    }
  }

  flush();
  return out.length === 1 ? (out[0] as AdfNode) : out;
}

function tokenToAdf(token: MarkedToken): AdfNode | AdfNode[] | null {
  switch (token.type) {
    case 'heading':
      return {
        type: 'heading',
        attrs: { level: token.depth ?? 1 },
        content: inlineTokens(token.tokens),
      };
    case 'paragraph':
      return { type: 'paragraph', content: inlineTokens(token.tokens) };
    case 'list': {
      const items = token.items ?? [];
      /**
       * A mixed task/plain list falls back to a bullet list.
       *
       * `taskList` would force the plain items into checkbox `taskItem` nodes
       * they never had, which changes what the document says.
       */
      const isTaskList =
        items.length > 0 && items.every((item) => item.task === true);
      if (isTaskList) return taskList(items);
      return {
        type: token.ordered === true ? 'orderedList' : 'bulletList',
        content: items.map(listItem),
      };
    }
    case 'code':
      return {
        type: 'codeBlock',
        // `language` must be a string when present, so an unlabelled fence
        // omits `attrs` entirely rather than emitting `language: null`.
        ...(token.lang !== undefined && token.lang !== ''
          ? { attrs: { language: token.lang } }
          : {}),
        content:
          token.text !== undefined && token.text !== ''
            ? [
                {
                  type: 'text',
                  text: token.text.endsWith('\n')
                    ? token.text
                    : `${token.text}\n`,
                },
              ]
            : [],
      };
    case 'blockquote':
      return { type: 'blockquote', content: blocksFromTokens(token.tokens) };
    case 'hr':
      return { type: 'rule' };
    case 'table': {
      const headerRow: AdfNode = {
        type: 'tableRow',
        content: (token.header ?? []).map((cell) => ({
          type: 'tableHeader',
          // Required, and may be empty. Jira rejects a cell without it.
          attrs: {},
          content: [{ type: 'paragraph', content: inlineTokens(cell.tokens) }],
        })),
      };
      const bodyRows: AdfNode[] = (token.rows ?? []).map((row) => ({
        type: 'tableRow',
        content: row.map((cell) => ({
          type: 'tableCell',
          attrs: {},
          content: [{ type: 'paragraph', content: inlineTokens(cell.tokens) }],
        })),
      }));
      return {
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: [headerRow, ...bodyRows],
      };
    }
    // `space` is markdown's blank line. ADF has no node for it, and emitting an
    // empty paragraph would put visible gaps in the comment.
    case 'space':
      return null;
    default:
      return null;
  }
}

export function convertMarkdown(markdown: string): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: blocksFromTokens(marked.lexer(markdown)),
  };
}
