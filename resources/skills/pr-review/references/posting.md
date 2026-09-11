# Posting a review

Loaded by `SKILL.md` Stage 4 in review mode. Self mode never reads this file.

## Verdict

Nobody is asked. **Approve only when all four hold:**

1. the PR is `OPEN` and not a draft
2. zero **Block** findings survived Stage 3, prior findings included
3. the review ran to completion, meaning every dispatched reviewer returned
4. the PR's author is not the token's own user (`gh api user --jq .login`),
   because GitHub refuses that approval with HTTP 422

Should Fix and Note findings never withhold an approval; they go along as
comments. Anything else is a **comment** review. Never request changes. When you
cannot tell whether a finding is Block, it is Block.

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

In this order, and nothing else:

1. One sentence on what the change does.
2. The ticket, when there is one:
   `Ticket HIVE-123: 4 of 6 covered · 1 partial · 1 left (<the item left>)`,
   or the "could not be read" line when the fetch failed.
3. The findings summary, Block first. Findings that could not anchor inline go
   here in full.
4. Earlier feedback, when there was any: `Earlier feedback: 3 fixed · 1 marked
   fixed but not · 1 still open`, with a thread link for each item that is not
   fixed.
5. `Reviewed by pr-review`.

A clean review is one line: "No issues found." Padding a clean review with
nitpicks is how a reviewer stops being read.

## Clean up

`sh <skill-dir>/scripts/review-worktree.sh close "$RUN_DIR"`, whether the post
succeeded or not. It removes the worktree, the run's two refs and its folder.
