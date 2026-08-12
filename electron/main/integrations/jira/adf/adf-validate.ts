import type { AdfDoc, AdfNode } from '../../../../shared/jira-contract';

/**
 * Local ADF validation, before anything is POSTed (HIVE-71).
 *
 * Ported from `jira-writer`'s `adf-validate.mjs`, to TypeScript and without its
 * CLI, for the same two reasons as its sibling.
 *
 * ## Why this exists at all
 *
 * An ADF document Jira rejects comes back as a 400 whose message **does not say
 * which node was wrong**. Every rule below is one Jira enforces silently, so
 * checking locally is the difference between "the comment could not be posted"
 * and "the text node at content[3].content[1] has both `code` and `strong`".
 *
 * It is deliberately not a full schema. It checks the four rules that are
 * actually easy to violate while building a document, and says nothing about
 * the rest — a partial validator that names a real problem beats a complete one
 * nobody finishes.
 */

/** What may appear inside a paragraph. */
const INLINE_TYPES = new Set([
  'text',
  'hardBreak',
  'mention',
  'emoji',
  'inlineCard',
]);

export interface AdfViolation {
  ok: false;
  /** Where, as a path into the document — `content[3].content[1]`. */
  path: string;
  /** Which rule fired, for a caller that wants to branch rather than print. */
  rule:
    | 'doc_shape'
    | 'node_shape'
    | 'mark_exclusivity'
    | 'missing_localId'
    | 'missing_table_attrs'
    | 'inline_in_block';
  message: string;
  /** The index of the top-level block the problem is inside. */
  blockIndex?: number;
}

export type AdfValidation = { ok: true } | AdfViolation;

const fail = (
  path: string,
  rule: AdfViolation['rule'],
  message: string,
): AdfViolation => ({ ok: false, path, rule, message });

function checkNode(node: unknown, path: string): AdfViolation | null {
  if (node === null || typeof node !== 'object') {
    return fail(path, 'node_shape', 'node is not an object');
  }

  const current = node as AdfNode;

  if (current.type === 'text') {
    const marks = current.marks ?? [];
    const hasCode = marks.some((mark) => mark.type === 'code');
    if (hasCode && marks.some((mark) => mark.type !== 'code')) {
      const types = marks.map((mark) => mark.type).join(',');
      return fail(
        path,
        'mark_exclusivity',
        `text node has marks [${types}] — code is exclusive with strong, em and link`,
      );
    }
  }

  if (current.type === 'taskList' || current.type === 'taskItem') {
    const localId = current.attrs?.localId;
    if (typeof localId !== 'string' || localId === '') {
      return fail(
        path,
        'missing_localId',
        `${current.type} is missing its required localId attr`,
      );
    }
  }

  if (current.type === 'tableCell' || current.type === 'tableHeader') {
    if (current.attrs === undefined || typeof current.attrs !== 'object') {
      return fail(
        path,
        'missing_table_attrs',
        `${current.type} requires an attrs object, which may be empty`,
      );
    }
  }

  if (current.type === 'paragraph' && Array.isArray(current.content)) {
    for (const [index, child] of current.content.entries()) {
      if (child?.type !== undefined && !INLINE_TYPES.has(child.type)) {
        return fail(
          `${path}.content[${index}]`,
          'inline_in_block',
          `paragraph content must be inline; got ${child.type}`,
        );
      }
    }
  }

  if (Array.isArray(current.content)) {
    for (const [index, child] of current.content.entries()) {
      const violation = checkNode(child, `${path}.content[${index}]`);
      if (violation !== null) return violation;
    }
  }

  return null;
}

export function validateAdf(doc: unknown): AdfValidation {
  if (
    doc === null ||
    typeof doc !== 'object' ||
    (doc as AdfDoc).type !== 'doc' ||
    typeof (doc as AdfDoc).version !== 'number' ||
    !Array.isArray((doc as AdfDoc).content)
  ) {
    return fail(
      '',
      'doc_shape',
      'the top level must be { type: "doc", version: number, content: array }',
    );
  }

  const content = (doc as AdfDoc).content;
  for (const [index, block] of content.entries()) {
    const violation = checkNode(block, `content[${index}]`);
    // The block index is what makes a violation locatable in a long comment:
    // "the fourth thing you wrote" is actionable, a path alone is not.
    if (violation !== null) return { ...violation, blockIndex: index };
  }

  return { ok: true };
}
