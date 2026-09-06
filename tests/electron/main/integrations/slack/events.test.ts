// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  describeBurst,
  describeEvent,
  readEnvelope,
} from '../../../../../electron/main/integrations/slack/events';
import { SLACK_EVENT_TEXT_MAX } from '../../../../../electron/shared/slack-contract';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(__dirname, '../../../../fixtures/slack', `${name}.json`), 'utf8'),
  );

describe('readEnvelope', () => {
  it('reads a channel message', () => {
    expect(readEnvelope(fixture('message'))).toEqual({
      kind: 'slack.channel',
      channel: 'C0123ABCD',
      ts: '1757012345.001200',
      threadTs: '1757012345.001200',
      user: 'U08BA712189',
      text: 'can someone review https://github.com/x/y/pull/42',
    });
  });

  it('reads an app mention, keeping the thread it was posted in', () => {
    expect(readEnvelope(fixture('app-mention'))).toEqual({
      kind: 'slack.app_mention',
      channel: 'C0123ABCD',
      ts: '1757012400.002100',
      threadTs: '1757012345.001200',
      user: 'U08BA712189',
      text: '<@U09HIVEBOT> pr-patrol what did dana ask?',
    });
  });

  it('drops an edit, a bot post, a join and a reaction', () => {
    expect(readEnvelope(fixture('message-edited'))).toBeNull();
    expect(readEnvelope(fixture('message-bot'))).toBeNull();
    expect(readEnvelope(fixture('message-join'))).toBeNull();
    expect(readEnvelope(fixture('reaction'))).toBeNull();
  });

  it('drops anything that is not an events_api envelope', () => {
    expect(readEnvelope({ type: 'hello' })).toBeNull();
    expect(readEnvelope({ type: 'disconnect', reason: 'refresh_requested' })).toBeNull();
    expect(readEnvelope(null)).toBeNull();
    expect(readEnvelope('nonsense')).toBeNull();
  });

  it('drops a message with no author, which no agent could reply to', () => {
    expect(
      readEnvelope({
        type: 'events_api',
        payload: { event: { type: 'message', channel: 'C1', ts: '1.1', text: 'x' } },
      }),
    ).toBeNull();
  });
});

describe('describeEvent', () => {
  const event = readEnvelope(fixture('message'))!;

  it('names the channel, its id, the thread and the author', () => {
    expect(describeEvent(event, '#eng-code-review')).toBe(
      '#eng-code-review (C0123ABCD) · thread 1757012345.001200 · from U08BA712189: ' +
        'can someone review https://github.com/x/y/pull/42',
    );
  });

  it('falls back to the bare id when the name did not resolve', () => {
    expect(describeEvent(event, null)).toContain('(C0123ABCD)');
    expect(describeEvent(event, null)).not.toContain('#');
  });

  it('truncates a long message rather than filling the prompt with it', () => {
    const long = { ...event, text: 'x'.repeat(SLACK_EVENT_TEXT_MAX + 200) };
    const line = describeEvent(long, '#x');
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(SLACK_EVENT_TEXT_MAX + 120);
  });
});

describe('describeBurst', () => {
  it('is the single line when only one event arrived', () => {
    const one = readEnvelope(fixture('message'))!;
    expect(describeBurst([one], '#eng-code-review')).toBe(
      describeEvent(one, '#eng-code-review'),
    );
  });

  it('counts the burst and quotes the newest', () => {
    const a = readEnvelope(fixture('message'))!;
    const b = { ...a, ts: '1757012999.000100', text: 'and this one' };
    const c = { ...a, ts: '1757012888.000100', text: 'middle' };
    expect(describeBurst([a, c, b], '#eng-code-review')).toBe(
      '#eng-code-review (C0123ABCD) · 3 messages · newest thread ' +
        '1757012345.001200 from U08BA712189: and this one',
    );
  });
});
