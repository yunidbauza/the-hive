import type { LanguageSupport } from '@codemirror/language';

/**
 * Extension → a CodeMirror language, loaded on demand.
 *
 * ## Why every entry is a `() => import(...)`
 *
 * Fourteen grammars is roughly a megabyte of parser tables. Statically
 * importing them would put all of it in the renderer's initial bundle — the
 * bundle whose job is to paint a terminal quickly — to support a panel the user
 * may never open. Behind a dynamic import, a language the user never opens
 * costs nothing but the entry in this table.
 *
 * The consequence, stated so nobody treats it as a bug: opening a file of a
 * language not yet loaded takes one extra tick before it is highlighted. The
 * text is rendered immediately either way; highlighting arrives when the chunk
 * does.
 *
 * ## Why `null` is a supported outcome
 *
 * An extension that is not here resolves to `null` and the file opens as plain
 * text — with line numbers, wrapping and search intact. That is a normal
 * result, not a gap to be filled. A `Dockerfile`, a `.env`, a `.gitignore` and
 * a `CHANGELOG` all read perfectly well unhighlighted, and adding a grammar per
 * file type anybody might have is not a finishable task.
 */
export type LanguageId =
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'json'
  | 'css'
  | 'html'
  | 'markdown'
  | 'yaml'
  | 'python'
  | 'sql'
  | 'rust'
  | 'go'
  | 'java'
  | 'php'
  | 'xml'
  | 'shell';

export interface LanguageDef {
  id: LanguageId;
  /** What the editor's status line calls it. */
  label: string;
  load: () => Promise<LanguageSupport>;
}

const LANGUAGES: Record<LanguageId, LanguageDef> = {
  javascript: {
    id: 'javascript',
    label: 'JavaScript',
    load: async () =>
      (await import('@codemirror/lang-javascript')).javascript(),
  },
  jsx: {
    id: 'jsx',
    label: 'JSX',
    load: async () =>
      (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  },
  typescript: {
    id: 'typescript',
    label: 'TypeScript',
    load: async () =>
      (await import('@codemirror/lang-javascript')).javascript({
        typescript: true,
      }),
  },
  tsx: {
    id: 'tsx',
    label: 'TSX',
    load: async () =>
      (await import('@codemirror/lang-javascript')).javascript({
        jsx: true,
        typescript: true,
      }),
  },
  json: {
    id: 'json',
    label: 'JSON',
    load: async () => (await import('@codemirror/lang-json')).json(),
  },
  css: {
    id: 'css',
    label: 'CSS',
    load: async () => (await import('@codemirror/lang-css')).css(),
  },
  html: {
    id: 'html',
    label: 'HTML',
    load: async () => (await import('@codemirror/lang-html')).html(),
  },
  markdown: {
    id: 'markdown',
    label: 'Markdown',
    load: async () => (await import('@codemirror/lang-markdown')).markdown(),
  },
  yaml: {
    id: 'yaml',
    label: 'YAML',
    load: async () => (await import('@codemirror/lang-yaml')).yaml(),
  },
  python: {
    id: 'python',
    label: 'Python',
    load: async () => (await import('@codemirror/lang-python')).python(),
  },
  sql: {
    id: 'sql',
    label: 'SQL',
    load: async () => (await import('@codemirror/lang-sql')).sql(),
  },
  rust: {
    id: 'rust',
    label: 'Rust',
    load: async () => (await import('@codemirror/lang-rust')).rust(),
  },
  go: {
    id: 'go',
    label: 'Go',
    load: async () => (await import('@codemirror/lang-go')).go(),
  },
  java: {
    id: 'java',
    label: 'Java',
    load: async () => (await import('@codemirror/lang-java')).java(),
  },
  php: {
    id: 'php',
    label: 'PHP',
    load: async () => (await import('@codemirror/lang-php')).php(),
  },
  xml: {
    id: 'xml',
    label: 'XML',
    load: async () => (await import('@codemirror/lang-xml')).xml(),
  },
  /**
   * Shell is the one language here without a Lezer grammar of its own.
   *
   * `@codemirror/legacy-modes` carries the old CodeMirror 5 stream parser, and
   * `StreamLanguage.define` adapts it. Highlighting is coarser than a real
   * grammar's — no structural folding, no indentation — and that is fine for
   * what shell scripts are read for here.
   */
  shell: {
    id: 'shell',
    label: 'Shell',
    load: async () => {
      const [{ LanguageSupport, StreamLanguage }, { shell }] =
        await Promise.all([
          import('@codemirror/language'),
          import('@codemirror/legacy-modes/mode/shell'),
        ]);
      return new LanguageSupport(StreamLanguage.define(shell));
    },
  },
};

/**
 * Extension (no dot, lowercased) → language id.
 *
 * `.mts`/`.cts` map to TypeScript and not to TSX, because the module variants
 * cannot contain JSX — and the JSX grammar changes how `<` parses, which turns
 * a generic type argument into an unclosed tag.
 */
const BY_EXTENSION: Record<string, LanguageId> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  pyi: 'python',
  sql: 'sql',
  rs: 'rust',
  go: 'go',
  java: 'java',
  php: 'php',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
};

/**
 * Whole filenames that carry no extension but are unambiguous.
 *
 * Kept deliberately short. The temptation is to grow it until every dotfile is
 * covered, and the reason not to is that most of them have no grammar worth
 * loading: `.gitignore` and `.env` are line-oriented text, and highlighting
 * them as something else is worse than not highlighting them.
 */
const BY_FILENAME: Record<string, LanguageId> = {
  '.zshrc': 'shell',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell',
};

/** The extension of a filename, lowercased, or `''` when it has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // `<= 0` and not `< 0`: a leading dot is a hidden file, not an extension —
  // `.gitignore` has no extension, it has a name that starts with a dot.
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** The language for a filename, or `null` to open it as plain text. */
export function languageFor(name: string): LanguageDef | null {
  const byName = BY_FILENAME[name.toLowerCase()];
  if (byName) return LANGUAGES[byName];

  const id = BY_EXTENSION[extensionOf(name)];
  return id ? LANGUAGES[id] : null;
}
