import {
  GH_MERGED_PAGE,
  GH_OPEN_PAGE,
  GH_THREAD_PAGE,
} from '../../../shared/github-contract';

/**
 * The GraphQL document, and how the user's own pull requests are asked for.
 *
 * ## Why `search` and not `repository.pullRequests`
 *
 * This used to be an aliased `repository` block per repo — `r0:`, `r1:`, … —
 * each asking for the fifty most recently updated open PRs, with "mine" applied
 * afterwards while reading the payload. The filter was in the wrong place.
 * `Repository.pullRequests` takes `states`, `labels`, `headRefName`,
 * `baseRefName` and `orderBy` and **no author argument at all**, so the only
 * place the author could be applied was after the page had already been chosen.
 * In a repository where fifty PRs are updated before any of the user's, theirs
 * were simply not in the answer, and the panel said "No open pull requests of
 * yours" with total confidence.
 *
 * `search` is the one connection that takes an author. Two of them — open and
 * merged — replace the whole alias scheme: one round trip regardless of how many
 * projects are configured, as before, but now the page GitHub chooses is a page
 * of *the user's* pull requests, so the cap can only be reached by someone who
 * genuinely has a hundred of their own.
 *
 * ## Why the repository names are still not concatenated into the document
 *
 * The old rule was that no config-derived value ever entered the query text, and
 * it still holds: the search expressions travel as the bound variables `$open`
 * and `$merged`, where they are data. The query text itself is now a **constant**
 * — there is no per-repo aliasing left to generate — which is a stronger version
 * of the same guarantee rather than a weaker one.
 *
 * What is new is that a repository name now lands inside a *search expression*,
 * which is a second, much weaker language: the worst a hostile name could do
 * there is smuggle another qualifier and widen the search. {@link repoQualifiers}
 * is the answer — a name is only emitted if it matches the character set GitHub
 * itself permits in an owner or repository, and one that does not is dropped
 * rather than escaped. Dropping is the safe direction: a repository missing from
 * the sweep shows fewer PRs, where a mis-escaped one could show anybody's.
 */

/** One repository to sweep. */
export interface RepoRef {
  owner: string;
  name: string;
}

/**
 * What GitHub allows in an owner or a repository name.
 *
 * Deliberately the *whole* permitted set and not a guess at a safe subset: a
 * pattern narrower than reality would silently drop real repositories, which is
 * the failure this file exists to stop. Every character here is inert inside a
 * search expression — no space, so a qualifier cannot be split; no colon, so one
 * cannot be introduced.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The `repo:` qualifiers for a sweep, one per repository GitHub can be asked
 * about safely.
 *
 * Repeated `repo:` qualifiers are **OR**ed by GitHub's search, which is what
 * makes a single query cover every configured project.
 *
 * An empty result is meaningful and the callers treat it as such: it means there
 * is nothing safe to scope the search to, and an *unscoped* `author:@me` search
 * would answer with the user's pull requests from every repository they have ever
 * touched. That is a far worse answer than none, so `client.ts` refuses the call
 * rather than sending a search with no scope.
 */
export function repoQualifiers(repos: readonly RepoRef[]): string[] {
  return repos
    .filter((repo) => SAFE_SEGMENT.test(repo.owner) && SAFE_SEGMENT.test(repo.name))
    .map((repo) => `repo:${repo.owner}/${repo.name}`);
}

/**
 * The fields read from one PR.
 *
 * `reviewThreads` is the whole reason this is GraphQL rather than
 * `gh pr list --json` or `gh search prs --json`: neither REST-shaped field set
 * has thread resolution in it, and "unresolved review threads" is what the
 * findings badge counts.
 *
 * `repository` is here because a search result is not addressed by repository
 * the way an aliased block was — the nodes arrive in one flat list spanning every
 * repo, so each one has to say which it came from.
 */
const PR_PARTS = `fragment PrParts on PullRequest {
  number
  title
  url
  isDraft
  state
  reviewDecision
  headRefName
  updatedAt
  mergedAt
  author { login }
  repository { name owner { login } }
  reviewThreads(first: ${String(GH_THREAD_PAGE)}) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

/**
 * The document. A constant, because nothing about it varies with the config any
 * more — the repositories live entirely in the two bound variables.
 *
 * ## Two searches rather than one
 *
 * The same reason the two connections existed before: a single search ordered by
 * `updated-desc` across both states would let a busy week of merges push the
 * user's open PRs off the page, and the open ones are the entire point of the
 * panel. Asking separately gives each state its own page and makes neither able
 * to starve the other.
 *
 * ## Why no date qualifier on the merged search
 *
 * The twenty-four hour window that decides which merged PRs are still worth
 * showing stays where it was, in `mapping.ts`, applied to `mergedAt`.
 *
 * `updated:` is the qualifier not to reach for: it filters on *when a PR was
 * last touched*, which is a different question, so an open PR left alone for a
 * week would disappear for being quiet. `merged:>=` is the one that would
 * genuinely match the window, and it is left out on purpose rather than
 * overlooked — it would bind the query to this machine's clock, where a laptop
 * running fast would silently ask GitHub to exclude pull requests that had in
 * fact just landed. The client-side filter compares two timestamps and can be
 * wrong about the boundary; a qualifier makes GitHub wrong about the contents.
 *
 * The cost of leaving it out is that the merged page is spent on the most
 * recently *updated* merged PRs rather than the most recently merged ones, so a
 * hundred old merged PRs with fresh comment activity could in principle push
 * out one merged an hour ago. At a hundred per sweep across a personal set of
 * projects that is a long way from reachable, and the failure is a missing row
 * rather than a wrong one.
 *
 * `viewer { login }` rides along because `client.ts` uses it as the signal that
 * the request genuinely succeeded — it is the one field here that cannot be null
 * for a working token. `author:@me` already does the filtering, so the login is
 * no longer what defines "mine"; it is kept as the sentinel, and as the second
 * check `mapping.ts` applies behind the search.
 */
export function buildPrQuery(): string {
  return [
    'query($open: String!, $merged: String!) {',
    '  viewer { login }',
    `  open: search(query: $open, type: ISSUE, first: ${String(GH_OPEN_PAGE)}) {`,
    '    nodes { ... on PullRequest { ...PrParts } }',
    '  }',
    `  merged: search(query: $merged, type: ISSUE, first: ${String(GH_MERGED_PAGE)}) {`,
    '    nodes { ... on PullRequest { ...PrParts } }',
    '  }',
    '}',
    PR_PARTS,
  ].join('\n');
}

/**
 * The two search expressions, keyed to match {@link buildPrQuery}'s parameters.
 *
 * Takes the qualifiers rather than the repositories so that the caller has
 * already had to confront the empty case — see {@link repoQualifiers}.
 *
 * `sort:updated-desc` is explicit because search defaults to relevance ordering,
 * and "most relevant" is not a thing a pull request panel means. A flat
 * `Record<string, string>` because that is what `gh api graphql` takes on the
 * command line, one `-f key=value` per entry.
 */
export function buildPrVariables(
  qualifiers: readonly string[],
): Record<string, string> {
  const scope = qualifiers.join(' ');

  return {
    open: `is:pr author:@me is:open ${scope} sort:updated-desc`,
    merged: `is:pr author:@me is:merged ${scope} sort:updated-desc`,
  };
}

/**
 * What survives from a user's search box into a search expression.
 *
 * GitHub search is a small language, and a bare term is only *data* in it by
 * convention. Three constructs in it can change **which** pull requests are
 * searched, and all three have to go — a term that could reach past the
 * `repo:` scope this app just chose would break the panel's promise from the
 * inside.
 *
 * - **The colon**, which is what makes a qualifier. `repo:someone/else` typed
 *   into the box is not a word, it is a scope.
 * - **The double quote**, which opens a phrase. This one is the sharp edge: the
 *   language has quoting and **no escape mechanism**, so a single unbalanced
 *   `"` runs to the end of the expression and swallows every `repo:` qualifier
 *   after it into literal text. The result is a valid, unscoped search across
 *   all of GitHub — exactly the outcome `repoQualifiers` exists to make
 *   impossible, reached from the other end.
 * - **Parentheses**, which group. Combined with the boolean operators GitHub
 *   honours (`AND`/`OR`/`NOT`), a group is the other way to get a disjunct that
 *   the scope does not apply to.
 *
 * Removed, not escaped — the same choice {@link repoQualifiers} makes about an
 * unsafe repository name, and for the same reason: there is no escape sequence
 * in this language, only quoting, and quoting is the thing being defended
 * against. Dropping is the safe direction; the cost is that a user cannot
 * search for a literal quote, which is a fair trade for one that cannot
 * silently search the whole of GitHub.
 *
 * The bare words `AND`, `OR` and `NOT` are deliberately **left alone**. They
 * cannot escape the scope on their own once the scope is emitted first (see
 * {@link buildSearchVariables}), and stripping them would mangle every search
 * for a PR with "or" in its title.
 *
 * Whitespace is collapsed and the result trimmed so that a term of nothing but
 * removed characters is empty rather than a search expression with a hole in
 * it. Multiple words stay multiple words: GitHub ANDs them, which is what a
 * user typing two words means.
 */
export function safeSearchTerm(term: string): string {
  return term.replace(/["():]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function buildSearchVariables(
  term: string,
  qualifiers: readonly string[],
): Record<string, string> {
  const scope = qualifiers.join(' ');
  const safe = safeSearchTerm(term);

  /*
    The scope goes **before** the term, and that ordering is load-bearing rather
    than cosmetic. GitHub honours `OR` between terms, so with the term first,
    `x OR y` splits the expression into two disjuncts and only the second
    carries the `repo:` qualifiers — the first would search all of GitHub.
    Emitting the scope ahead of anything the user typed keeps every qualifier on
    the left of any operator they can write.

    `safeSearchTerm` removes the characters that could defeat that anyway; this
    is the second of two independent defences, not a substitute for the first.
  */
  return {
    open: `is:pr is:open ${scope} ${safe} sort:updated-desc`,
    merged: `is:pr is:merged ${scope} ${safe} sort:updated-desc`,
  };
}
