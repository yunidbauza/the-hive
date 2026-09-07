import type {
  ConfigSnapshot,
  SetSlackRequest,
  SetSlackTokensRequest,
} from '@shared/config-contract';
import type {
  SlackSocketState,
  SlackSocketStatus,
  SlackSocketTestResult,
  SlackStatus,
  SlackTokensState,
} from '@shared/slack-contract';

/**
 * The renderer's half of the Slack bridge (HIVE-123, HIVE-124).
 *
 * Mirrors `jira.ts` in the two ways that matter: **no bridge returns `null`**
 * — that is the browser demo, not a failure, so the bridge is feature-detected
 * rather than the user agent — and **a rejected read returns `null` too**,
 * logged once, because a settings section that throws when IPC hiccups is
 * worse than one that says it does not know.
 *
 * The **writes** are the exception, and {@link SlackWrite} is why: a read the
 * pane could not fetch is a status it does not know, but a write main *refused*
 * is something the user typed, and collapsing that to `null` made the pane
 * blame its own plumbing for a stray space in a text field.
 *
 * Type-only imports from `@shared`: the unions here describe, they never pull
 * main-process behaviour into the renderer bundle.
 */

/**
 * What the pane says when the failure is the bridge itself.
 *
 * Exported because two modules need the same sentence: this one, when a verb
 * cannot be reached at all, and `slack-group.tsx`, which reports it in the
 * pill. Written once so a reader cannot be shown two different phrasings of
 * "the app is broken".
 */
export const SLACK_BRIDGE_ERROR = 'The app could not reach its own main process.';

/**
 * A rejected write, in the words main actually used.
 *
 * `ipcRenderer.invoke` wraps a handler's throw twice on the way back — once as
 * `Error invoking remote method '<channel>':` and once as the error's own class
 * name — so the guard's sentence arrives buried inside a message that reads as
 * a plumbing fault. Both wrappers are peeled here, because the whole point of
 * surfacing a rejection is that it names what the user typed wrongly.
 */
const INVOKE_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_CLASS = /^[A-Za-z]*Error:\s*/;

const reasonOf = (cause: unknown): string => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const reason = raw.replace(INVOKE_WRAPPER, '').replace(ERROR_CLASS, '').trim();

  return reason === '' ? SLACK_BRIDGE_ERROR : reason;
};

/**
 * A write whose refusal is worth reading (HIVE-124, fix-round-3).
 *
 * The `call` wrapper below collapses every rejection to `null`, which is right
 * for a read — a status the pane could not fetch is a status it does not know —
 * and wrong for a write the *user* caused. `assertCommanderId` refuses an id
 * with whitespace in it, and ordinary typing reaches that guard, so collapsing
 * it made the pane blame the main process for a stray space in a text field.
 */
export type SlackWrite<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

async function write<T>(
  verb: string,
  run: (bridge: NonNullable<Window['hive']>) => Promise<T>,
): Promise<SlackWrite<T>> {
  const bridge = window.hive;
  if (!bridge) return { ok: false, message: SLACK_BRIDGE_ERROR };

  try {
    return { ok: true, value: await run(bridge) };
  } catch (cause) {
    console.error(`[hive] slack.${verb} failed:`, cause);

    return { ok: false, message: reasonOf(cause) };
  }
}

async function call<T>(
  verb: string,
  run: (bridge: NonNullable<Window['hive']>) => Promise<T>,
): Promise<T | null> {
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

/**
 * Store one or both socket-mode tokens (HIVE-124).
 *
 * Merged in main, not replaced, so the pane may commit one field at a time. The
 * answer carries **presence only** — there is no wrapper here that reads a
 * token back, because there is no channel that returns one.
 */
export const setSlackTokens = (
  request: SetSlackTokensRequest,
): Promise<SlackWrite<SlackTokensState>> =>
  write('setTokens', (bridge) => bridge.slack.setTokens(request));

/**
 * Forget both. They come from one Slack app and are useless apart.
 *
 * A {@link SlackWrite} like its sibling above, and for a sharper reason: this
 * is the only way a stored token can be removed, and `save`/`clear` throw when
 * the machine has no keyring. A user told "the app could not reach its own main
 * process" would go looking in the wrong place entirely.
 */
export const clearSlackTokens = (): Promise<SlackWrite<SlackTokensState>> =>
  write('clearTokens', (bridge) => bridge.slack.clearTokens());

/**
 * The socket-mode switch and the commander allow-list (HIVE-124).
 *
 * On `config`, not `slack`, because it writes the config file — the same split
 * `setJira` is on, and the reason the tokens above are not. Kept in this module
 * anyway: the pane that calls it is the Slack pane, and a caller should not
 * have to know which namespace main filed the verb under.
 */
export const setSlackConfig = (
  request: SetSlackRequest,
): Promise<SlackWrite<ConfigSnapshot>> =>
  write('setSlack', (bridge) => bridge.config.setSlack(request));

/**
 * One `auth.test` against the stored bot token.
 *
 * Not {@link testSlack}, which spends a model turn proving Claude Code's OAuth
 * connection to Slack's MCP server. This opens no socket.
 */
export const testSlackSocket = (): Promise<SlackSocketTestResult | null> =>
  call('socketTest', (bridge) => bridge.slack.socketTest());

/**
 * Token presence and the last socket status, for a pane that just mounted.
 *
 * The half {@link subscribeSlackSocketStatus} cannot supply: the push is not
 * buffered and main suppresses a repeat of the last status, so after a restart
 * a subscriber alone learns nothing about a bridge that is already connected —
 * and token presence has no push at all. Read it in the same effect that
 * subscribes, exactly as `jira.ts`'s `readJiraStatus` is read on mount.
 */
export const readSlackSocketState = (): Promise<SlackSocketState | null> =>
  call('socketState', (bridge) => bridge.slack.socketState());

/**
 * What the socket is doing, as main reports it. Returns its own unsubscribe.
 *
 * Not routed through {@link call}: a subscription has no answer to swallow and
 * nothing to log. With no bridge it returns a disposer that does nothing, so a
 * caller's cleanup path is the same in the browser demo as in the app.
 */
export const subscribeSlackSocketStatus = (
  callback: (status: SlackSocketStatus) => void,
): (() => void) => {
  const bridge = window.hive;
  if (!bridge) return () => {};

  return bridge.slack.onSocketStatus(callback);
};
