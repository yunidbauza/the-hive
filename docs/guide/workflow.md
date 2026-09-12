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
session that gave it the job: the question lands in that terminal as a ledger marker and the
session puts it to you. If that session is gone, the ask is redirected to your
[inbox](inbox.md) instead.

## Start

Open a session from the ticket in the [Work tab](work-and-prs.md#start-a-session-from-a-ticket),
or type the key in any session:

```text
/work-on HIVE-123
```

`work-on` reads the ticket through the Hive's Jira connection, reconciles it with the code,
reports, and stops for your go-ahead. Then `brainstorm` sorts the work, asking its questions
in one batch: a spike, a bounded change with a short design in the chat, or an architectural
one whose design is written down. Anything with more than one step gets a plan. The ticket
moves to In Progress when the build starts, and only from To Do.

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
plan is a file under the repository's `.hive/plans`, ignored by git, and it is what a builder
run or an inline run executes.

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
ends `work-on` at "the draft PR is ready", and `/ship` in a session prints the intake it would
have sent and stops; you review, mark ready and merge by hand, or add a shipper. A shipper
with no acr asks you whether the review happened elsewhere. The skills check
`mcp__hive__agents` before they delegate, so nothing is ever addressed to an agent that is
not there.

## The tools the agents use

Agents and sessions reach the Hive through MCP tools. The reads and the ledger are granted to
every agent; the two that write to your Jira are not, and an agent calls them only with a
`tools:` entry or your consent on a card:

| Tool | Answers | Grant |
| --- | --- | --- |
| `ledger_*` | the shared log: post, ask, answer, claim, release, done, failed, hand off | standing |
| `agents` | who else is on this machine and what each can do | standing |
| `projects` | the config's projects: id, key, path, `autoMerge`, container workspace | standing |
| `pr` | one pull request from the Hive's own GitHub sweep, with its unresolved-thread count | standing |
| `jira_get` | the ticket: description, parent, comments and links, through the token the Work tab holds | standing |
| `jira_transition` | a status move by name; never backwards | `tools:` entry or a card |
| `jira_comment` | a comment, from markdown | `tools:` entry or a card |
| `approve` | the fence's own prompt tool; the CLI calls it, you never do | standing |

The builder and the shipper list `jira_transition`; nobody shipped lists `jira_comment`. The
Jira tools are why a builder in a container needs no `jira-writer` on its PATH and no
Atlassian credential in its environment. The skills prefer them and fall back to the CLI
where a session runs without the Hive.
