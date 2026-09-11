---
name: spec-deviation
description: Use when an implementation has deviated from its Jira ticket: a design decision changed mid-work, the plan diverged from the ticket, or the user says "update the ticket with the deviation", "add UPDATED SPECS", or "update the downstream tickets". Writes the deviation into the PR body, appends UPDATED SPECS to the ticket, and proposes edits to the downstream tickets for confirmation before writing them.
---

# Spec deviation

A deviation lands in three places: the PR, the ticket, and the downstream
tickets that inherit the changed assumption. The third is the one that gets
missed, and then sibling stories are built on the old spec.

Session only: step 4 needs a person to confirm. When the builder agent
discovers a deviation mid-build it does not run this skill; it asks its
`reply-to` party with the statement and continues on the answer, and the
person runs `hive:spec-deviation` when the tickets should be updated.

Every Jira write goes through `jira-writer` (the Atlassian MCP tools when it
is not installed); never raw REST. Workspace-agnostic: nothing here touches a
branch.

## Steps

1. **Write the statement once.** Two to five sentences: what the ticket said,
   what was done, why. Reuse it verbatim below.
2. **PR body.** Add or refresh a `## Deviation from spec` section. Write the
   whole new body to a file, then
   `jq -n --rawfile body pr-body.md '{body: $body}' | gh api
   repos/<owner>/<repo>/pulls/<N> -X PATCH --input -` (`gh pr edit` needs
   token scopes a `gh` login may not hold; the API call does not).
3. **The ticket.** Append a section titled `UPDATED SPECS` with the statement,
   the date and the PR link: `jira-writer update_issue <KEY> '{}' --desc-file
   <file> --append`. Never rewrite the original description.
4. **Downstream.** Fetch the Epic's not-Done stories and every issue linked to
   this one. In Jira's API `inwardIssue` is the blocker and `outwardIssue` the
   blocked, the reverse of how it reads; check against the rendered ticket.
   One subagent, a cheaper model, reads the candidates and flags which rely on
   the changed assumption. **Present the list and the proposed edits, and
   wait for confirmation before writing.** Then apply the same `UPDATED SPECS`
   append to each confirmed ticket.
5. **Report.** The statement, and every ticket and PR updated, with links.

## Formatting

ADF through jira-writer: the `code` mark is exclusive, and a fence needs a
language tag. `gh` bodies through `--body-file - <<'EOF'`, backticks plain.

## Red flags

- Only the current ticket updated.
- The original description rewritten.
- Downstream tickets edited without the confirmation.
- `inwardIssue` read as "blocked".
