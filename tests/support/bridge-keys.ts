import type { HiveBridge } from '../../electron/shared/ipc-contract';

/**
 * The exact key sets of `window.hive` and each namespace on it. Test-only:
 * `bridge.test.ts` asserts the preload exposes precisely these and nothing
 * more. The `satisfies` clauses make a renamed or removed verb a type error
 * here, so the arrays cannot drift from the contract silently.
 */

export const BRIDGE_KEYS = [
  'agents', 'appInfo', 'config', 'fs', 'github', 'integrations', 'jira', 'ledger',
  'notifications', 'plans', 'pty', 'remote', 'server', 'session', 'skills', 'slack', 'ui',
  'updates',
] as const satisfies readonly (keyof HiveBridge)[];

export const BRIDGE_SKILLS_KEYS = [
  'list', 'read', 'write', 'remove', 'rename', 'pathToken', 'fileRead', 'fileWrite',
  'fileMkdir', 'fileRemove', 'fileMove', 'fileImport', 'fileDrop', 'import',
] as const satisfies readonly (keyof HiveBridge['skills'])[];

export const BRIDGE_AGENTS_KEYS = [
  'list', 'read', 'write', 'remove', 'rename', 'onChanged', 'run', 'kill', 'pause', 'resume',
  'rotate', 'onStatus', 'onLines',
] as const satisfies readonly (keyof HiveBridge['agents'])[];

export const BRIDGE_SESSION_KEYS = [
  'onStatus', 'onName', 'onCleared', 'onFinished', 'onReady', 'onBranch', 'onTicketIntent',
  'onMetrics', 'onForeground', 'onTerminalEnded', 'history', 'note', 'pr',
] as const satisfies readonly (keyof HiveBridge['session'])[];

export const BRIDGE_INTEGRATIONS_KEYS = [
  'loginEnv', 'status',
] as const satisfies readonly (keyof HiveBridge['integrations'])[];

export const BRIDGE_FS_KEYS = [
  'readDir', 'root', 'resolve', 'readFile', 'writeFile', 'search', 'watch', 'unwatch',
  'onChanged',
] as const satisfies readonly (keyof HiveBridge['fs'])[];

export const BRIDGE_GITHUB_KEYS = [
  'prs', 'searchPrs',
] as const satisfies readonly (keyof HiveBridge['github'])[];

export const BRIDGE_JIRA_KEYS = [
  'status', 'setToken', 'clearToken', 'test', 'search', 'issue', 'transitions',
  'applyTransition', 'comments', 'links', 'addComment',
] as const satisfies readonly (keyof HiveBridge['jira'])[];

export const BRIDGE_SLACK_KEYS = [
  'status', 'signIn', 'signOut', 'test', 'setTokens', 'clearTokens', 'socketTest',
  'socketState', 'onSocketStatus',
] as const satisfies readonly (keyof HiveBridge['slack'])[];

export const BRIDGE_NOTIFICATIONS_KEYS = [
  'onActivate', 'onRead', 'onNew', 'list', 'markRead', 'dismiss', 'clear', 'onDismissed',
  'delivery', 'act', 'badge',
] as const satisfies readonly (keyof HiveBridge['notifications'])[];

export const BRIDGE_LEDGER_KEYS = [
  'list', 'post', 'answer', 'onChanged',
] as const satisfies readonly (keyof HiveBridge['ledger'])[];

export const BRIDGE_PLANS_KEYS = [
  'list', 'onChanged',
] as const satisfies readonly (keyof HiveBridge['plans'])[];

export const BRIDGE_UPDATES_KEYS = [
  'status', 'check',
] as const satisfies readonly (keyof HiveBridge['updates'])[];

export const BRIDGE_UI_KEYS = [
  'reportForeground', 'reportSessionName',
] as const satisfies readonly (keyof HiveBridge['ui'])[];

export const BRIDGE_CONFIG_KEYS = [
  'get', 'reload', 'chooseDirectory', 'browseDirectory', 'addProject', 'removeProject',
  'renameProject', 'repointProject', 'reorderProjects', 'setProjectKey', 'setProjectAutoMerge',
  'setSessionPlugin', 'startClone', 'cancelClone', 'onCloneDone', 'onConfigChanged',
  'setRuntime', 'setProjectRuntime', 'diagnoseCommand', 'diagnoseEnv', 'setNotifications',
  'revealConfig', 'resetConfig', 'setJira', 'setSlack', 'setReceiver', 'setServer', 'setRemote',
  'getRemote',
] as const satisfies readonly (keyof HiveBridge['config'])[];

export const BRIDGE_SERVER_KEYS = [
  'pair', 'revoke',
] as const satisfies readonly (keyof HiveBridge['server'])[];

export const BRIDGE_REMOTE_KEYS = [
  'pair', 'forget', 'onLinkStatus',
] as const satisfies readonly (keyof HiveBridge['remote'])[];

export const BRIDGE_PTY_KEYS = [
  'ack', 'spawn', 'spawnTerminal', 'write', 'resize', 'kill', 'onData', 'onExit', 'onLost',
  'restart', 'prompt',
] as const satisfies readonly (keyof HiveBridge['pty'])[];
