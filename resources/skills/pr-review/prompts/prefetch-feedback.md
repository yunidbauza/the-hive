---
name: prefetch-feedback
description: Collect every earlier review, thread and comment on the PR
model: sonnet
---

The first half of the prior-findings dispatch: collect the feedback already on
the pull request before you check it. A re-review needs all of it: what was
raised, what the author said back, and which threads were closed. Judge nothing
here.

## Inputs

1. `OWNER`, `NAME`, `PR`, and the PR author's login

## Your Task

**Review bodies.** Every submitted review with a non-empty body:

```bash
gh api --paginate --slurp "repos/$OWNER/$NAME/pulls/$PR/reviews" \
  --jq 'add | [.[] | select((.body // "") != "") | {author:.user.login, bot:(.user.type=="Bot"), state:.state, commit:.commit_id, at:.submitted_at, body:.body}]'
```

`--slurp` then `add`, or only the first 30 reviews are seen.

**Every inline thread, resolved ones included.** Page until
`pageInfo.hasNextPage` is false:

```bash
gh api graphql \
  -f query='query($owner:String!,$repo:String!,$num:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100,after:$after){
          pageInfo{ hasNextPage endCursor }
          nodes{
            id isResolved isOutdated path line originalLine
            comments(first:50){
              pageInfo{ hasNextPage }
              nodes{ body url createdAt author{login __typename} }
            }
          }
        }
      }
    }
  }' \
  -F owner="$OWNER" -F repo="$NAME" -F num="$PR" \
  --jq '{ threads: [.data.repository.pullRequest.reviewThreads.nodes[] | { threadId:.id, resolved:.isResolved, outdated:.isOutdated, path:.path, line:(.line // .originalLine), url:.comments.nodes[0].url, comments:[.comments.nodes[] | {author:.author.login, bot:(.author.__typename=="Bot"), at:.createdAt, body:.body}] }], pageInfo:.data.repository.pullRequest.reviewThreads.pageInfo }'
```

Repeat with `-F after=<endCursor>`, accumulating every page.

**PR-level comments.** Page until a page returns fewer than 100:

```bash
gh api "repos/$OWNER/$NAME/issues/$PR/comments?per_page=100&page=$PAGE" \
  --jq '[.[] | {author:.user.login, bot:(.user.type=="Bot"), at:.created_at, body:.body, url:.html_url}]'
```

On every comment, set `"isAuthor": true` when its author is the PR author. The
author's replies are how a concern gets marked fixed.

## Output

Write this object with the Write tool to `$RUN_DIR/feedback.json`. The
verifier reads it later.

```json
{ "prAuthor": "login", "reviews": [ ], "inlineThreads": [ ], "rootComments": [ ] }
```

Then carry on with the review instructions that follow. They call this object
`PR_COMMENTS`.
