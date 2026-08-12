import { describe, expect, it } from 'vitest';

import { fileIconName, folderIconName } from '@lib/explorer/file-icon';

/**
 * Filename → icon.
 *
 * Keyed off the same language resolution the editor uses, which is the property
 * worth pinning: a `.mts` file with a TypeScript icon and no highlighting would
 * mean the two tables had drifted.
 */

describe('fileIconName', () => {
  it('uses a language glyph where Phosphor has one', () => {
    expect(fileIconName('store.ts')).toBe('ph-file-ts');
    expect(fileIconName('app.tsx')).toBe('ph-file-tsx');
    expect(fileIconName('index.js')).toBe('ph-file-js');
    expect(fileIconName('app.jsx')).toBe('ph-file-jsx');
    expect(fileIconName('tokens.css')).toBe('ph-file-css');
    expect(fileIconName('index.html')).toBe('ph-file-html');
    expect(fileIconName('AGENTS.md')).toBe('ph-file-md');
    expect(fileIconName('main.py')).toBe('ph-file-py');
    expect(fileIconName('schema.sql')).toBe('ph-file-sql');
  });

  /**
   * Phosphor has a glyph for nine of seventeen languages. The rest share one
   * rather than getting an invented shape apiece — seventeen silhouettes in a
   * 316px rail communicate less than the filename beside them already does.
   */
  it('falls back to a generic code glyph for a language with no icon', () => {
    expect(fileIconName('main.rs')).toBe('ph-file-code');
    expect(fileIconName('main.go')).toBe('ph-file-code');
    expect(fileIconName('ci.yml')).toBe('ph-file-code');
  });

  it('marks images and archives, which the editor will refuse', () => {
    expect(fileIconName('logo.png')).toBe('ph-file-image');
    expect(fileIconName('shot.JPEG')).toBe('ph-file-image');
    expect(fileIconName('bundle.zip')).toBe('ph-file-zip');
  });

  it('marks configuration by whole filename', () => {
    expect(fileIconName('.gitignore')).toBe('ph-gear');
    expect(fileIconName('.env.local')).toBe('ph-gear');
    expect(fileIconName('Dockerfile')).toBe('ph-gear');
    expect(fileIconName('Makefile')).toBe('ph-gear');
  });

  it('keeps a config filename ahead of its extension', () => {
    // `.env.example` would otherwise resolve through the extension table.
    expect(fileIconName('.env.example')).toBe('ph-gear');
  });

  it('uses a plain file glyph for anything unrecognised', () => {
    expect(fileIconName('LICENSE')).toBe('ph-file');
    expect(fileIconName('data.parquet')).toBe('ph-file');
  });

  it('marks plain text and logs as text', () => {
    expect(fileIconName('notes.txt')).toBe('ph-file-text');
    expect(fileIconName('build.log')).toBe('ph-file-text');
  });
});

describe('folderIconName', () => {
  it('has exactly two states', () => {
    expect(folderIconName(true)).toBe('ph-folder-open');
    expect(folderIconName(false)).toBe('ph-folder');
  });
});
