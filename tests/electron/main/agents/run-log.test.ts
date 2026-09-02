import { describe, expect, it } from 'vitest';

import type { RunLine } from '../../../../electron/shared/agent-contract';
import {
  NO_LOG,
  foldRunLog,
} from '../../../../electron/main/agents/run-log';

/** Fold every chunk in order and return the lines they produced. */
const foldAll = (...chunks: string[]): RunLine[] => {
  let state = NO_LOG;
  const lines: RunLine[] = [];

  for (const chunk of chunks) {
    const step = foldRunLog(state, chunk);

    state = step.state;
    lines.push(...step.lines);
  }

  return lines;
};

const assistant = (text: string) =>
  `${JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', content: [{ type: 'text', text }] },
  })}\n`;

const toolUse = (name: string, input: Record<string, unknown>) =>
  `${JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_2', content: [{ type: 'tool_use', name, input }] },
  })}\n`;

describe('foldRunLog', () => {
  it('renders assistant text as ink', () => {
    expect(foldAll(assistant('hello'))).toEqual([
      { text: 'hello', color: 'ink' },
    ]);
  });

  it('renders a tool call as a dim name and short argument', () => {
    expect(foldAll(toolUse('Bash', { command: 'echo hi' }))).toEqual([
      { text: 'Bash echo hi', color: 'dim' },
    ]);
  });

  it('renders a ledger ask in amber', () => {
    expect(
      foldAll(toolUse('mcp__hive__ledger_ask', { body: 'which repo?' })),
    ).toEqual([{ text: 'mcp__hive__ledger_ask which repo?', color: 'amber' }]);
  });

  it('reassembles an object split across two chunks', () => {
    const whole = assistant('split me');
    const at = 20;

    expect(foldAll(whole.slice(0, at), whole.slice(at))).toEqual([
      { text: 'split me', color: 'ink' },
    ]);
  });

  it('ignores a malformed line rather than throwing', () => {
    expect(() => foldAll('not json at all\n')).not.toThrow();
    expect(foldAll('not json at all\n')).toEqual([]);
  });

  it('leaves an unterminated final line uncounted', () => {
    expect(foldAll(assistant('kept').trimEnd())).toEqual([]);
  });

  it('captures the result event and renders it in cyan', () => {
    const result = `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      num_turns: 3,
      total_cost_usd: 0.0241,
      session_id: 'f9589d3c-8987-4f7d-ba2f-537952d2633c',
    })}\n`;

    const step = foldRunLog(NO_LOG, result);

    expect(step.state.result).toEqual({
      subtype: 'success',
      costUsd: 0.0241,
      turns: 3,
      sessionUuid: 'f9589d3c-8987-4f7d-ba2f-537952d2633c',
    });
    /*
      `endsTurn` is asserted here, not merely tolerated. The renderer splits the
      buffer on it to draw newest-turn-first, so this is the one place the
      boundary is written — and a fold emitted without it collapses several
      turns into one block with no test anywhere else to notice.
    */
    expect(step.lines).toEqual([
      { text: '● turn ended — success · $0.02', color: 'cyan', endsTurn: true },
    ]);
  });

  it('spells the cost with the contract formatter, not a second one', () => {
    // `formatRunCost` is the one formatter: two decimals above a cent, four
    // below it, so a sub-cent wake does not read as `$0.00`. The row and this
    // line show the same run's cost and must not disagree about it.
    const cheap = `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.0009,
    })}\n`;

    expect(foldRunLog(NO_LOG, cheap).lines).toEqual([
      { text: '● turn ended — success · $0.0009', color: 'cyan', endsTurn: true },
    ]);
  });

  it('skips system and rate-limit noise', () => {
    expect(
      foldAll(
        `${JSON.stringify({ type: 'system', subtype: 'thinking_tokens' })}\n`,
        `${JSON.stringify({ type: 'rate_limit_event' })}\n`,
      ),
    ).toEqual([]);
  });

  /**
   * Noise **after** the result, in the same chunk.
   *
   * A pipe decides where chunks split, so `result` and whatever the CLI writes
   * next routinely arrive together — and a non-event line that answered with
   * the result "as it was when this chunk started" reverted the accumulator,
   * losing the cost, the turns and the session uuid of a run that had reported
   * all three.
   */
  it('keeps a result reported earlier in the same chunk as trailing noise', () => {
    const chunk =
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        num_turns: 3,
        total_cost_usd: 0.02,
        session_id: 'uuid-1',
      })}\n` +
      `${JSON.stringify({ type: 'system', subtype: 'thinking_tokens' })}\n`;

    expect(foldRunLog(NO_LOG, chunk).state.result).toMatchObject({
      subtype: 'success',
      sessionUuid: 'uuid-1',
    });
  });

  it('keeps a result from an earlier chunk when a later one is only noise', () => {
    const afterResult = foldRunLog(
      NO_LOG,
      `${JSON.stringify({ type: 'result', subtype: 'success' })}\n`,
    ).state;

    expect(
      foldRunLog(
        afterResult,
        `${JSON.stringify({ type: 'system', subtype: 'x' })}\n`,
      ).state.result,
    ).toEqual({ subtype: 'success' });
  });

  it('records the mcp servers the init event named', () => {
    const chunk = `${JSON.stringify({
      type: 'system',
      subtype: 'init',
      mcp_servers: [
        { name: 'hive', status: 'connected' },
        { name: 'slack', status: 'needs-auth' },
      ],
    })}\n`;

    const { state } = foldRunLog(NO_LOG, chunk);

    expect(state.mcpServers).toEqual([
      { name: 'hive', status: 'connected' },
      { name: 'slack', status: 'needs-auth' },
    ]);
  });

  it('leaves mcpServers null when no init event has arrived', () => {
    expect(foldRunLog(NO_LOG, '{"type":"assistant"}\n').state.mcpServers).toBeNull();
  });
});
