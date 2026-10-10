/**
 * Whether a file gets Source · Preview · Split.
 *
 * `.mdx` is excluded: its JSX would render as junk in a markdown preview.
 */
export const isMarkdownFile = (name: string): boolean => /\.(md|markdown)$/i.test(name);
