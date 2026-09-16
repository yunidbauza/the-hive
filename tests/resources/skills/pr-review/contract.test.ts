// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The posting contract, held by test.
 *
 * An audit of 24 acr approvals (Sep 3-16 2026) found 0 inline comments, 0 of 31
 * posted bodies carrying the mandatory `Reviewed by pr-review:` line, and one PR
 * approved two hours after an unanswered external Security finding. `posting.md`
 * was correct as written and was not being followed, and nothing anywhere failed
 * when it drifted. These assertions are that missing failure: the clauses a
 * review's verdict and body depend on cannot be softened without a red test.
 */
const resources = fileURLToPath(new URL('../../../../resources', import.meta.url));
const skill = join(resources, 'skills', 'pr-review');
const read = (...parts: string[]) => readFileSync(join(skill, ...parts), 'utf8');

const posting = read('references', 'posting.md');
const skillMd = read('SKILL.md');
const scorer = read('prompts', 'confidence-scorer.md');
const acr = readFileSync(join(resources, 'agents', 'acr', 'AGENT.md'), 'utf8');

/** The text under one `## heading`, up to the next one. */
const section = (markdown: string, heading: string) => {
  const start = markdown.indexOf(`## ${heading}\n`);
  expect(start, `posting.md has a "## ${heading}" section`).toBeGreaterThan(-1);
  const rest = markdown.slice(start + heading.length + 4);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
};

describe('pr-review verdict gate', () => {
  const verdict = section(posting, 'Verdict');

  it('withholds an approval on a Should Fix, not only on a Block', () => {
    expect(verdict).toContain('all six hold');
    expect(verdict).toMatch(/zero \*\*Should Fix\*\* findings survived Stage 3/);
  });

  it('treats an unanswered external finding as a Block', () => {
    expect(verdict).toMatch(/no `still-open` or `reopened` item/);
    expect(verdict).toContain('is not yours to waive');
    expect(verdict).toMatch(/Otherwise it is a Block\./);
  });

  it('no longer says Should Fix and Note never withhold an approval', () => {
    expect(verdict).not.toContain('never withhold an approval');
  });

  it('fails the review when prior findings was dispatched and did not return', () => {
    expect(verdict).toContain('the prior-findings reviewer did not return');
    expect(verdict).toContain('It is not a clean review.');
  });

  it('refuses an approval that argues with an open finding in the body', () => {
    expect(verdict).toContain('Never approve while disagreeing with an open finding');
  });

  it('resolves both unknowns against the PR', () => {
    expect(verdict).toContain('it is Block');
    expect(verdict).toContain('it is open');
  });
});

describe('pr-review body contract', () => {
  const body = section(posting, 'Body');

  it('is three parts, and puts every finding inline', () => {
    expect(body).toContain('Exactly three parts');
    expect(body).toContain('Every finding is an\ninline comment on its own line');
    expect(body).toContain('The body never explains one.');
  });

  it('names the counts line, the ticket tally and the feedback tally', () => {
    expect(body).toMatch(/Block · .* Should Fix · .* Note — see inline comments\./);
    expect(body).toMatch(/Ticket HIVE-123: 4 of 6 covered/);
    expect(body).toMatch(/Earlier feedback: 3 fixed/);
  });

  it('keeps the reviewed-by line, without which a clean review reads as unlooked-at', () => {
    expect(body).toContain('Reviewed by pr-review: <the reviewers that ran>.');
    expect(body).toContain('Not run: <reviewer> (<reason>)');
  });

  it('bans the prose that replaced the findings', () => {
    expect(body).toContain('Banned in the body, without exception');
    for (const banned of [
      'narrating what you traced, verified, confirmed or checked',
      'any sentence arguing the code is correct, safe, sound or well-tested',
      'praise, and summaries of the test coverage',
    ]) {
      expect(body).toContain(banned);
    }
  });

  it('gives the orchestrator a length check it can apply before posting', () => {
    expect(body).toMatch(/longer than 600\ncharacters with zero Block findings is wrong by construction/);
    expect(body).toContain('rewrite it, do not\npost it');
  });
});

describe('pr-review SKILL.md', () => {
  it('sends Stage 4 to posting.md rather than trusting memory', () => {
    expect(skillMd).toContain('open `references/posting.md` now and follow it');
    expect(skillMd).toContain('Do not compose a\nbody from memory');
    expect(skillMd).toContain('the payload is the review');
    expect(skillMd).toContain('no\nfile outside `$RUN_DIR` is written');
  });

  it('gives review mode the borderline band self mode already had', () => {
    expect(skillMd).toContain('**Drop anything below 60.**');
    expect(skillMd).toContain('Keep 60–74 as **borderline** in both modes');
    expect(skillMd).toContain('posted inline as **Note**');
    expect(skillMd).toMatch(/a\n\s+miss on someone else's PR costs an incident/);
  });
});

describe('confidence scorer', () => {
  it('scores a thread duplicate on its own evidence instead of zeroing it', () => {
    expect(scorer).toContain('`"duplicateOfThread": true`');
    expect(scorer).toContain('a 0 here loses it entirely if the prior-findings reviewer did not return');
    expect(scorer).not.toContain('If an existing thread already raised this exact issue, score 0.');
  });

  it('carries duplicateOfThread in the output shape', () => {
    expect(scorer).toContain('"duplicateOfThread"');
  });
});

describe('acr agent', () => {
  it('may not compose a review body or leave one in its work folder', () => {
    expect(acr).toContain('A review-mode job writes nothing outside the skill');
    expect(acr).toContain('never compose one yourself');
    expect(acr).toContain('`review-<pr>.md` at the top of your work folder means the contract\nwas bypassed');
  });
});
