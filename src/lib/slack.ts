import type { SlackStatus } from '@shared/slack-contract';

/**
 * The renderer's half of the Slack bridge (HIVE-123).
 *
 * Mirrors `jira.ts` in the two ways that matter: **no bridge returns `null`**
 * — that is the browser demo, not a failure, so the bridge is feature-detected
 * rather than the user agent — and **a rejected channel returns `null` too**,
 * logged once, because a settings section that throws when IPC hiccups is
 * worse than one that says it does not know.
 *
 * Type-only import from `@shared`: the union `SlackStatus` describes, it never
 * pulls main-process behaviour into the renderer bundle.
 */

async function call(
  verb: string,
  run: (bridge: NonNullable<Window['hive']>) => Promise<SlackStatus>,
): Promise<SlackStatus | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await run(bridge);
  } catch (cause) {
    console.error(`[hive] slack.${verb} failed:`, cause);
    return null;
  }
}

/** `claude mcp get slack`, parsed. No model turn — answers in well under a second. */
export const readSlackStatus = (): Promise<SlackStatus | null> =>
  call('status', (bridge) => bridge.slack.status());

/** `claude mcp add` then `claude mcp login slack`, then a re-read of status. */
export const signIn = (): Promise<SlackStatus | null> =>
  call('signIn', (bridge) => bridge.slack.signIn());

/** `claude mcp remove slack`, which drops the credential entry with it. */
export const signOut = (): Promise<SlackStatus | null> =>
  call('signOut', (bridge) => bridge.slack.signOut());

/** The Test button — the only one of the four that spends a model turn. */
export const testSlack = (): Promise<SlackStatus | null> =>
  call('test', (bridge) => bridge.slack.test());
