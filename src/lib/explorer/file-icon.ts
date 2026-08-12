import { extensionOf, languageFor } from '@lib/explorer/language';

/**
 * Filename → the icon name `components/ui/icon.tsx` understands.
 *
 * Keyed off the same language resolution the editor uses, so a file's icon and
 * its highlighting can never disagree about what it is. That is the whole
 * reason this is not its own extension table: two tables drift, and the visible
 * symptom is a `.mts` file with a TypeScript icon and no highlighting.
 *
 * Phosphor has a glyph for six of the seventeen languages. The rest fall back
 * to `ph-file-code`, which is honest — inventing a distinguishable icon per
 * language would put seventeen shapes in a 316px rail to communicate something
 * the filename already says.
 */

/** Languages Phosphor actually has a glyph for. */
const LANGUAGE_ICONS: Record<string, string> = {
  javascript: 'ph-file-js',
  jsx: 'ph-file-jsx',
  typescript: 'ph-file-ts',
  tsx: 'ph-file-tsx',
  css: 'ph-file-css',
  html: 'ph-file-html',
  markdown: 'ph-file-md',
  python: 'ph-file-py',
  sql: 'ph-file-sql',
};

/**
 * Extensions with no language but a recognisable *kind*.
 *
 * These exist because the editor will refuse most of them — an image is
 * binary, an archive is binary — and an icon that says so before the click is
 * worth more than one that promises code and delivers a refusal.
 */
const KIND_ICONS: Record<string, string> = {
  png: 'ph-file-image',
  jpg: 'ph-file-image',
  jpeg: 'ph-file-image',
  gif: 'ph-file-image',
  webp: 'ph-file-image',
  ico: 'ph-file-image',
  avif: 'ph-file-image',
  zip: 'ph-file-zip',
  gz: 'ph-file-zip',
  tgz: 'ph-file-zip',
  tar: 'ph-file-zip',
  txt: 'ph-file-text',
  log: 'ph-file-text',
  lock: 'ph-file-text',
};

/**
 * Whole filenames that are configuration whatever their extension.
 *
 * A gear rather than a code glyph: what these have in common is that you open
 * them to change how something runs, not to read logic.
 */
const CONFIG_FILES = new Set([
  '.env',
  '.env.local',
  '.env.example',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.editorconfig',
  '.prettierrc',
  'dockerfile',
  'makefile',
  'procfile',
]);

export function fileIconName(name: string): string {
  const lower = name.toLowerCase();
  if (CONFIG_FILES.has(lower)) return 'ph-gear';

  const language = languageFor(name);
  if (language) return LANGUAGE_ICONS[language.id] ?? 'ph-file-code';

  return KIND_ICONS[extensionOf(name)] ?? 'ph-file';
}

/** Open or closed — the only two states a directory row has. */
export function folderIconName(expanded: boolean): string {
  return expanded ? 'ph-folder-open' : 'ph-folder';
}
