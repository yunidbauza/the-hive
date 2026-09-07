// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { readCommand } from '../../../../../electron/main/integrations/slack/command';
import {
  SLACK_EVENT_TEXT_MAX,
  type SlackEvent,
} from '../../../../../electron/shared/slack-contract';

const KNOWN = ['pr-patrol', 'slack', 'acr'];
const ALLOWED = ['U08BA712189'];

const mention = (text: string, user = 'U08BA712189'): SlackEvent => ({
  kind: 'slack.app_mention',
  channel: 'C0123ABCD',
  ts: '1757012400.002100',
  threadTs: '1757012400.002100',
  user,
  text,
});

describe('readCommand', () => {
  it('refuses an author who is not on the list', () => {
    expect(
      readCommand(mention('<@U09HIVEBOT> pr-patrol go', 'U0STRANGER'), KNOWN, ALLOWED),
    ).toEqual({ kind: 'refused' });
  });

  it('refuses everybody when the list is empty, which is the default', () => {
    expect(readCommand(mention('<@U09HIVEBOT> pr-patrol go'), KNOWN, [])).toEqual({
      kind: 'refused',
    });
  });

  it('reads a named agent and the rest as the task', () => {
    expect(
      readCommand(mention('<@U09HIVEBOT> pr-patrol what did dana ask?'), KNOWN, ALLOWED),
    ).toEqual({ kind: 'command', agent: 'pr-patrol', task: 'what did dana ask?' });
  });

  it('strips every leading mention, not only the first', () => {
    expect(
      readCommand(mention('<@U09HIVEBOT> <@U08BA712189> acr review 42'), KNOWN, ALLOWED),
    ).toEqual({ kind: 'command', agent: 'acr', task: 'review 42' });
  });

  it('broadcasts when no agent is named', () => {
    expect(readCommand(mention('<@U09HIVEBOT> what is going on?'), KNOWN, ALLOWED)).toEqual({
      kind: 'broadcast',
    });
  });

  it('broadcasts a bare mention with nothing after it', () => {
    expect(readCommand(mention('<@U09HIVEBOT>'), KNOWN, ALLOWED)).toEqual({
      kind: 'broadcast',
    });
  });

  it('treats an unknown leading word as part of the task, not a failed name', () => {
    expect(
      readCommand(mention('<@U09HIVEBOT> summarise the thread'), KNOWN, ALLOWED),
    ).toEqual({ kind: 'broadcast' });
  });

  /**
   * The title was right and the assertion was not (fix-round-3, HIVE-124).
   *
   * A `command` with `task: ''` is accepted by the scheduler's `isJob`
   * (`'' !== undefined`) and reaches `waker.ts`, whose task-run prompt says "Do
   * the job named above and nothing else" — with nothing named. That is a real
   * model turn spent on an instruction to do nothing. `@hive pr-patrol` is
   * somebody saying an agent's name, which is what a broadcast is for.
   */
  it('broadcasts when an agent is named with no task, so the agent decides', () => {
    expect(readCommand(mention('<@U09HIVEBOT> pr-patrol'), KNOWN, ALLOWED)).toEqual({
      kind: 'broadcast',
    });
  });

  it('broadcasts when a named agent is followed only by whitespace', () => {
    expect(readCommand(mention('<@U09HIVEBOT> pr-patrol   '), KNOWN, ALLOWED)).toEqual({
      kind: 'broadcast',
    });
  });

  /**
   * The console path is bounded by `assertText`; this one was bounded by
   * nothing, and it is the one that arrives from off the machine. A 40 KB Slack
   * message became a 40 KB `extra` in an argv and in `agents.json`.
   */
  it('clips a task at the cap the rest of the feature uses', () => {
    const long = 'x'.repeat(SLACK_EVENT_TEXT_MAX + 500);
    const result = readCommand(
      mention(`<@U09HIVEBOT> pr-patrol ${long}`),
      KNOWN,
      ALLOWED,
    );

    expect(result).toEqual({
      kind: 'command',
      agent: 'pr-patrol',
      task: `${'x'.repeat(SLACK_EVENT_TEXT_MAX)}\u2026`,
    });
  });

  it('matches an agent name case-insensitively, as the console does', () => {
    expect(readCommand(mention('<@U09HIVEBOT> PR-Patrol go'), KNOWN, ALLOWED)).toEqual({
      kind: 'command',
      agent: 'pr-patrol',
      task: 'go',
    });
  });
});
