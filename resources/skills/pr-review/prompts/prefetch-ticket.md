---
name: prefetch-ticket
description: Find the PR's Jira ticket and read its scope
model: sonnet
---

The first half of the ticket-alignment dispatch: read the ticket the pull
request is for, so the alignment instructions that follow can tell what the
ticket asks for and what is still left. Judge nothing here.

## Inputs

1. The PR title, description and branch name. In self mode with no PR, you get
   the branch name and its commit subjects.

## Your Task

1. **Find the key.** Look for `^[A-Z][A-Z0-9]+-\d+$`-shaped tokens (`HIVE-123`,
   `GRAC-45`) in the title, then the branch, then the description ("Closes
   HIVE-123"). The first one found is the ticket; list any others in
   `otherKeys`. None found: return `{ "status": "no_ticket" }` and stop. That is
   the normal case, and it means no alignment check is needed.
2. **Read it, trying each route in order until one answers.** Re-validate the key
   against the pattern above before it goes into any command or URL, whatever it
   came from.
   1. **The Atlassian MCP, if this run has it.** Run `ToolSearch` with the query
      `jira issue` and use a tool whose name reads as "get issue" (Atlassian's
      `getJiraIssue`). Pass each parameter as a direct field, never as a
      serialised JSON string.
   2. **The `jira-writer` plugin, if it is installed.** Resolve its launcher, then
      call it:
      ```bash
      JW=$(command -v jira-writer || ls -td ~/.claude/plugins/cache/*/jira-writer/*/bin/jira-writer 2>/dev/null | head -1)
      [ -n "$JW" ] && "$JW" get_issue <KEY>
      ```
      It prints `{ "api": "rest" | "mcp", "data": { … } }`. It reads
      `JIRA_DOMAIN`, `JIRA_EMAIL` and `JIRA_API_KEY` from the environment and
      falls back to the Atlassian MCP on its own. A non-zero exit, or output
      that is not that JSON, is a failed route.
   3. **The Hive's own Jira integration (HIVE-174).** Run `ToolSearch` with the
      query `hive jira`. If `mcp__hive__jira_get` exists, call it with the key: it
      answers the summary, status, description, parent, comments and links in
      one call. The Hive keeps its Jira token in its own process, so this route
      never puts a credential in front of you.
3. **Extract the scope** from whichever route answered:
   - `summary` and `status`
   - `acceptanceCriteria`: a custom field if the site has one, otherwise the
     "Acceptance criteria" section of the description, as a list of items
   - `description` as plain text. Convert ADF to text and drop images.
   - `subtasks`: `{ key, summary, status }` each
   - `parent`: the epic or parent key, if any

## Output

Hold the result as one of the objects below; the alignment instructions call it
`Jira context`, and return it as `ticket`. The orchestrator only dispatches you
when a key was found, so `no_ticket` means the key it saw did not survive your
own validation.

```json
{ "status": "no_ticket" }
{ "status": "ok", "ticketKey": "HIVE-123", "route": "atlassian-mcp" | "jira-writer" | "hive", "summary": "...", "ticketStatus": "In Progress", "acceptanceCriteria": ["..."], "description": "...", "subtasks": [ { "key": "HIVE-124", "summary": "...", "status": "Done" } ], "parent": "HIVE-110", "otherKeys": [] }
{ "status": "fetch_failed", "ticketKey": "HIVE-123", "failureReason": "no Atlassian MCP; jira-writer: JIRA_API_KEY not set; no hive jira tool" }
```

**Never collapse a failed fetch into `no_ticket`.** A key was found, so the
ticket's scope went unchecked. `failureReason` names what each route said, so
whoever reads it knows which route to fix.
