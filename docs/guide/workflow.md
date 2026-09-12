# Working a ticket

From a Jira ticket to Done, with the Hive's own skills and agents doing the repetitive
parts. Everything here ships with the app: the skills under `~/.hive/skills`, the agents
under `~/.hive/agents`. Nothing depends on a plugin from outside.

**On this page:** [The shape](#the-shape) · [Start](#start) · [Plan and build](#plan-and-build) ·
[Ship](#ship) · [What you see](#what-you-see) · [Without the agents](#without-the-agents) ·
[The tools the agents use](#the-tools-the-agents-use)

## The shape

| Step | Who | Skill |
| --- | --- | --- |
| Read the ticket, decide the shape | your session | `work-on` (a ticket) or `goal-on` (a vague request) |
| Settle an open design | your session, with you | `brainstorm` |
| Write the plan | your session | `plan` |
| Build it, a commit per task | your session, or the **builder** agent | `execute`, with `tdd`, `debug`, `worktree` |
| Prove it | whoever built it | `verify` |
| Drive the draft PR to merge | the **shipper** agent | `ship` |
| Review the whole branch once | the **acr** agent | `pr-review --self` |
| Work the findings | the **fixer** agent | `review-pr-findings` |
| Merge and close the ticket | the shipper | `merge-pr` |

Your session stays on the line the whole way. An agent that needs a decision asks the
session that gave it the job, and the card lands in your [inbox](inbox.md). If that session
is gone, the ask is redirected to you on the overmind.

## Start

Open a session from the ticket in the [Work tab](work-and-prs.md#start-a-session-from-a-ticket),
or type the key in any session:

```text
/work-on HIVE-123
```

`work-on` reads the ticket through the Hive's Jira connection, moves it to In Progress, and
classifies the work: a one-step change runs straight through; anything with an open design
question goes to `brainstorm`, which asks you its questions in one batch and writes the
answer down; anything with more than one step gets a plan.

A request with no ticket takes the same road through `goal-on`:

```text
/goal-on make the price cache invalidate on write
```

It turns the sentence into a brief with a checkable outcome, asks what it must ask now, and
holds itself to that outcome across turns: the turn cannot end until the evidence is in the
brief. Each check posts a receipt to the [ledger](ledger.md), so the overmind sees the goal's
progress without opening the session.

## Plan and build

`plan` writes tasks of about twenty minutes each, every one with the test that proves it. The
plan is a file in the repository, and it is what a builder run or an inline run executes.

Then one of two things happens:

- **Inline.** Your session runs `execute`: one task at a time, a commit each, `tdd` for the
  code and `verify` for the gates. This is the default, and it is what a plan of one task
  always does.
- **The builder.** When the machine has a builder agent and the plan has more than one task,
  `work-on` asks the builder to take it: a `ledger_ask` carrying the repository, the branch,
  the plan and the ticket. The builder cuts its own worktree under `~/.hive/work/builder`,
  runs the same `execute`, posts one line to the ledger per finished task, opens the draft
  PR, and answers your session with the link.

Either way the branch ends as a **draft** pull request. Nothing marks it ready yet.

## Ship

The draft PR goes to the shipper by `ledger_ask`, from your session or from the builder. The
shipper holds it stage by stage, and each stage is a line in the ledger:

| Stage | What happens |
| --- | --- |
| `intake` | the PR is forced back to draft so nothing runs CI before the review |
| `self-review` | the **acr** agent reviews the whole branch once, at depth |
| `fix-self` | the **fixer** applies the valid findings behind tests and replies to the rest |
| `ready` | the PR is marked ready; the ticket moves to In Review |
| `ci` | checks are watched; a red one goes back to the fixer |
| `findings` | new reviewer comments and bot findings go to the fixer, round by round |
| `approval` | waits for an approval, unless the project auto-merges |
| `merge` | `merge-pr` re-checks every block, merges, tears the branch down, moves the ticket to Done |
| `closed` | your session is asked whether to close |

Auto-merge is a project's `autoMerge` flag in `~/.hive/config.json`
([Settings › Projects](settings.md)). With it on, the shipper's merge call is granted for
that repository and the approval wait is skipped. With it off, every merge stops at the
[tools fence](agents.md#the-tools-fence) and becomes a card in your inbox: one click merges,
one click refuses.

## What you see

- **The Work tab.** A ticket the builder is building shows `builder · task N done` under its
  title. A PR the shipper holds shows one more badge, `ship: <stage>`, beside the GitHub
  ones. Both come off the ledger and go when the work is released.
- **The inbox.** Every question an agent cannot answer itself, every merge that needs your
  consent, and every goal that finished or failed.
- **The console.** `ledger` prints the tail; `ledger --from shipper` just the shipper's lines;
  `term builder` opens a terminal on the worktree the builder is working in, under the
  project it was cut from.
- **The Agents tab.** Each agent's runs, its cost today, and the transcript of any run.

## Without the agents

Every agent is optional. A machine with no builder builds inline. A machine with no shipper
runs `ship` in the session that opened the PR, and `ship` then asks the session's own
subagents to review and fix. A machine with no acr asks you whether the review happened
elsewhere. The skills check `mcp__hive__agents` before they delegate, so nothing is ever
addressed to an agent that is not there.

## The tools the agents use

Agents and sessions reach the Hive through MCP tools, all granted by the same `mcp__hive__*`
rule:

| Tool | Answers |
| --- | --- |
| `ledger_*` | the shared log: post, ask, answer, claim, release, done, failed, hand off |
| `agents` | who else is on this machine and what each can do |
| `projects` | the config's projects: id, key, path, `autoMerge`, container workspace |
| `pr` | one pull request from the Hive's own GitHub sweep, with its unresolved-thread count |
| `jira_get`, `jira_transition`, `jira_comment` | the ticket, a status move by name, a comment, through the token the Work tab holds |

The Jira tools are why a builder in a container needs no `jira-writer` on its PATH and no
Atlassian credential in its environment. The skills prefer them and fall back to the CLI
where a session runs without the Hive.
