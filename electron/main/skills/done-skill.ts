import { doneCommand } from '@shared/hook-contract';

/**
 * The built-in `/done`, owned by the app and rewritten on every launch.
 *
 * ## What it does, and why it cannot do it alone
 *
 * A skill is prompt text. It can make the model reach for tools it already has
 * and nothing else — and **no tool ends an interactive Claude Code session**.
 * Not even Claude Code's own `EndConversation`, which ends the *conversation*
 * and leaves the process running; only its non-interactive branch shuts down.
 * `/exit` is a REPL input-handler built-in, so the model cannot reach that
 * either: it never enters the tool space, and nothing can type into its own
 * stdin.
 *
 * So this skill does the one thing a skill can do — make a request — and the
 * app does the rest. The POST says "this session is finished"; `sessions/index.ts`
 * writes `/exit\r` into the pty at the end of the turn, which is the *only*
 * clean shutdown available and the one `bootstrap.ts`'s `&&` requires: a signal
 * would make `claude` exit non-zero, the `&&` would short-circuit, and the login
 * shell would sit there alive with a dead agent in it.
 *
 * ## Why there is no summary
 *
 * An earlier draft had the agent write one and post it. It was dropped because
 * `/done` has two callers and only one of them can write prose: a user typing it
 * wants the session closed, not narrated, and a skill handing off has already
 * said whatever it had to say. A summary would also make the request's success
 * depend on the model composing something first — turning "close this session"
 * into a generation that can fail, ramble, or be refused.
 *
 * ## Why `disable-model-invocation` is gone
 *
 * It shipped with the inert version, reasoning that "the agent decided we were
 * finished" is not a behaviour anyone asked for. That reasoning was right about
 * the risk and wrong about the cost, because Claude Code enforces the flag
 * exactly as it reads:
 *
 * ```
 * Skill "/done" is user-invocable only (disable-model-invocation)
 * done cannot be used with Skill tool due to disable-model-invocation.
 * Do not replicate this skill's workflow by other means — it is reserved for
 * explicit user invocation.
 * ```
 *
 * The third line is the decisive one: with the flag set, a finishing skill can
 * neither hand off to `/done` **nor** work around it. Handoff is half of what
 * this exists for, so the flag had to go. What replaces it is not a guard but a
 * consequence — the description below says when to use it, and the transcript
 * survives, so a session closed in error costs a reopen rather than the work.
 */

/**
 * The skill, pointed at a receiver that is listening.
 *
 * `doneUrl` is baked in at write time rather than read from the environment at
 * run time, which is the same trade `metricsScript` takes in `hooks/settings.ts`
 * and for the same reason: the port is known before this file is written, and
 * threading it through a third variable would put a value in every pty for
 * something no session needs to see.
 *
 * `null` writes a body that promises nothing. A built-in whose first act is a
 * failed request is worse than one that is honestly inert — the app said it
 * could not finish the session, which is true and actionable, rather than
 * appearing to work and leaving a terminal open.
 */
export const doneSkill = (doneUrl: string | null): string =>
  doneUrl === null ? INERT : active(doneUrl);

/**
 * The frontmatter, with the skill's own tool grant when it has a command to run.
 *
 * ## Why `allowed-tools` here rather than a permission in the settings file
 *
 * The first version of this authorised the `curl` with a `permissions.allow`
 * entry in the app-generated `--settings` file. That file merges **above** the
 * user's own scope, so the grant was one the user could neither see in their
 * settings nor revoke — and it applied to every session, for a command only this
 * one skill ever runs.
 *
 * `allowed-tools` is scoped to the skill that needs it, which is both narrower
 * and legible: the authorisation sits three lines above the command it
 * authorises, in a file the user can read. HIVE-93 specified it this way from
 * the start; the settings-file detour was a mistake, and a self review found it
 * had also been written as a **prefix** rule — which for `curl` is not a small
 * over-grant. `-K` reads a config file that redefines the target and the output,
 * `-o` and `-D` write to a chosen path, `--upload-file` sends one. None need a
 * shell operator, so none are caught by the `&&`/`;` handling that makes prefix
 * rules safe for ordinary commands.
 *
 * So the rule is the **exact** command, built from {@link doneCommand} — the same
 * builder the body below runs, which is what stops the grant and the command from
 * drifting into a permission prompt inside the app's own built-in.
 *
 * Omitted entirely when there is no endpoint: the inert body runs nothing, and a
 * grant for a command that is not there would be a claim with no purpose.
 */
const frontmatter = (allowedTools?: string): string =>
  `---
name: done
description: >-
  Finish this session — mark it done in The Hive and close its terminal. Use it
  when the work a session was opened for is complete, either because the user
  asked to finish or because a skill has finished its task and is handing off.
  Closing is recoverable; the transcript stays readable afterwards.
${allowedTools === undefined ? '' : `allowed-tools: ${allowedTools}\n`}---
`;

/**
 * What the skill says when the app can actually close the session.
 *
 * Written as an instruction with the command spelled out rather than as a
 * description of one, because the agent has to reproduce it closely enough to
 * match the permission prefix the settings file grants — see `hooks/settings.ts`.
 * Anything it adds after the URL still matches; anything it changes *inside* it
 * produces the prompt that rule exists to prevent.
 *
 * The closing line matters as much as the command. Without it the model tends to
 * narrate what it just did, and a paragraph written after the request has landed
 * is a paragraph the user reads in a terminal that is already closing.
 */
const active = (doneUrl: string): string => `${frontmatter(
  `Bash(${doneCommand(doneUrl)})`,
)}
Run exactly this command:

\`\`\`sh
${doneCommand(doneUrl)}
\`\`\`

That request tells The Hive this session is finished. The app closes the
terminal itself once the turn ends — you cannot close it yourself, and you do
not need to.

Then stop. Do not summarise, do not explain, and do not run anything else.
`;

/**
 * What it says when no receiver is listening.
 *
 * Reports the fact rather than failing quietly or pretending. A session whose
 * app cannot hear it is a session the user has to close by hand, and knowing
 * that is the difference between one keystroke and a stare.
 */
const INERT = `${frontmatter()}
This session cannot be closed automatically: The Hive is not reachable from it,
so there is nowhere to report that the work is finished.

Tell the user exactly that, in one line, and suggest they type \`/exit\` to close
the terminal themselves. Do not run any command.
`;
