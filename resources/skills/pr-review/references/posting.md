# Posting a review

Loaded by `SKILL.md` Stage 4 in review mode. Self mode never reads this file.

## Verdict

Nobody is asked. **Approve only when all six hold:**

1. the PR is `OPEN` and not a draft
2. zero **Block** findings survived Stage 3, prior findings included
3. zero **Should Fix** findings survived Stage 3, prior findings included
4. every external concern is closed: no `still-open` or `reopened` item in the
   prior-findings reviewer's return. A finding another reviewer raised and nobody
   answered is not yours to waive. It closes on an author reply, a resolved
   thread, or your own verification in source — recorded as a finding of its own
   when you are the one closing it. Otherwise it is a Block.
5. the review ran to completion, meaning every dispatched reviewer returned
6. the PR's author is not the token's own user (`gh api user --jq .login`),
   because GitHub refuses that approval with HTTP 422

Anything else is a **comment** review. Never request changes.

When you cannot tell whether a finding is Block, it is Block. When you cannot
tell whether an external thread is closed, it is open.

**`FEEDBACK` was true and the prior-findings reviewer did not return: that fails
condition 5.** It is not a clean review. Post a comment review that says so.

**Never approve while disagreeing with an open finding in the body.** If you
believe an external finding is wrong, that is a reply in its thread, posted as
part of this review, and the PR is a comment until someone answers it.

## Where each finding goes

- **New findings**, and prior findings that are **reopened** (marked fixed but
  not): one inline comment each.
- **Still-open** prior findings already have a thread, so a second inline
  comment would only duplicate it. List them in the body with a link to the
  thread.

## Post

**Once, as one review, from a file.** Write the payload with the Write tool to
`$RUN_DIR/review.json`, never on a command line. Review bodies carry
backticks and quotes that a shell mangles.

```json
{
  "commit_id": "<head sha from Stage 1>",
  "event": "APPROVE" | "COMMENT",
  "body": "<body>",
  "comments": [
    { "path": "src/x.ts", "line": 42, "side": "RIGHT", "body": "**Should Fix** · bug scan, git history\n\n<problem>\n\n**Suggested fix:** <fix>" }
  ]
}
```

```bash
gh api "repos/$SLUG/pulls/$PR/reviews" --method POST --input "$RUN_DIR/review.json" --jq .html_url
```

- `line` is an integer.
- A reopened comment opens with "Marked fixed in <thread url>, but …".
- `commit_id` pins the review to the head that was read. If someone pushed during
  the review, GitHub rejects it rather than anchoring comments to lines that
  moved. Report `failed` at `post: head moved`; the next request reviews the new
  head.
- **422 naming a comment line not in the diff:** move that finding into the body
  and resend once.
- **Any other failure:** keep the file, post nothing else, and report `failed` at
  `post: <status>`.

## Body

Exactly three parts, in this order, and nothing else. **Every finding is an
inline comment on its own line. The body never explains one.**

1. One sentence on what the change does, opening with the ticket key when there
   is one.
2. The counts line — always all three numbers — then the ticket and feedback
   tallies when they apply, one per line:

       1 Block · 2 Should Fix · 0 Note — see inline comments.
       Ticket HIVE-123: 4 of 6 covered · 1 partial · 1 left (<the item left>).
       Earlier feedback: 3 fixed · 1 marked fixed but not · 1 still open.

   The ticket line becomes the "could not be read" line when the fetch failed.
   Every `still-open` and `reopened` item gets its thread link on its own line
   under the feedback tally.
3. `Reviewed by pr-review: <the reviewers that ran>.`, then, when any did not,
   `Not run: <reviewer> (<reason>), …`, from the json block's `reviewers` and
   `skipped`. Without it a clean review reads the same as one where nothing
   looked.

A clean review is the one sentence, `0 Block · 0 Should Fix · 0 Note.`, and the
reviewed-by line. Nothing else. Padding a clean review with nitpicks is how a
reviewer stops being read; padding it with reassurance is how a reviewer stops
being believed.

**Banned in the body, without exception:**

- narrating what you traced, verified, confirmed or checked
- any sentence arguing the code is correct, safe, sound or well-tested
- a finding's explanation, its evidence or its fix — those go inline, on the line
- praise, and summaries of the test coverage

The only prose the body may carry is a finding that could not anchor inline
(its line is not in the diff), and it carries one line:

    `<path>:<line>` — **<severity>** <the problem in one sentence>

**Before posting, check `review.json` against this list. A body longer than 600
characters with zero Block findings is wrong by construction: rewrite it, do not
post it.**

## Clean up

`sh <skill-dir>/scripts/review-worktree.sh close "$RUN_DIR"`, whether the post
succeeded or not. It removes the worktree, the run's two refs and its folder.
