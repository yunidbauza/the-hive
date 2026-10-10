/**
 * A heading's anchor, the way GitHub makes it (github-slugger's algorithm).
 *
 * One slugger per document: duplicates are numbered in document order, and a
 * heading whose own text is `A-1` cannot take the slug a duplicate `A` took.
 */
export function createSlugger(): (text: string) => string {
  const occurrences = new Map<string, number>();

  return (text) => {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');

    let slug = base;
    while (occurrences.has(slug)) {
      const count = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}
