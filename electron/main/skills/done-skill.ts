/**
 * The built-in `/done`, owned by the app and rewritten on every launch.
 *
 * ## Why it ships here without its behaviour
 *
 * HIVE-93 owns what `/done` *does*: the `POST /done` receiver route, the
 * `HIVE_HOOK_URL` that reaches it, `sessions.finish()`, and the row ending as
 * `done` rather than `terminated`. That story is **blocked by this one**,
 * because until this plugin directory exists there is nowhere to put a skill.
 *
 * So the file lands now and asks the agent to summarise and stop. That is
 * enough to satisfy this story's proof — a Hive session lists `/done`, a
 * terminal `claude` does not — without shipping a `curl` to an endpoint that
 * would answer 404 until HIVE-93 lands. A built-in whose first act is a failed
 * request is worse than one that is honestly inert.
 *
 * HIVE-93 replaces this body. It does not have to invent the file, the manifest
 * entry, or the reserved name — all three are here.
 *
 * `disable-model-invocation: true` because ending a session is the user's call.
 * Without it the model may reach for `/done` on its own, and "the agent decided
 * we were finished" is not a behaviour anyone asked for.
 */
export const DONE_SKILL = `---
name: done
description: Finish this session — mark it done in The Hive and close its terminal
disable-model-invocation: true
---

Post a one-line summary of what this session accomplished, then stop.
`;
