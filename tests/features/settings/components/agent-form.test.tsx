import { useState } from 'react';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ICON_NAMES } from '@components/ui/icon';
import {
  AGENT_ICON_GROUPS,
  AgentForm,
  FIELD_HELP,
  RENDERED_PATHS,
} from '@features/settings/components/agent-form';
import { readFrontmatter } from '@shared/agent-contract';

const SOURCE = `---
name: slack-watcher
description: Watches #incorp-dev for build failures
icon: ph-slack-logo
wake:
  every: 5m
  on: [ledger]
autonomy: ask
---

You are a watcher.
`;

/**
 * The form, driven the way `AgentsSection` drives it — one buffer in state.
 *
 * A bare `vi.fn()` for `onChange` is not equivalent: every control here is
 * controlled off `source`, so a mock that never feeds the patched buffer back
 * makes React reset the input after each keystroke, and a two-character edit
 * lands as one. The harness is what lets a test type a whole name.
 */
function Harness({
  initial,
  taken,
  onSource,
}: {
  initial: string;
  taken: readonly string[];
  onSource: (source: string) => void;
}) {
  const [source, setSource] = useState(initial);

  return (
    <AgentForm
      source={source}
      problems={[]}
      taken={taken}
      onChange={(next) => {
        setSource(next);
        onSource(next);
      }}
    />
  );
}

const setup = (
  over: { source?: string; taken?: readonly string[] } = {},
) => {
  const onChange = vi.fn();

  render(
    <Harness
      initial={over.source ?? SOURCE}
      taken={over.taken ?? []}
      onSource={onChange}
    />,
  );

  return onChange;
};

/** What the last `onChange` produced, read back through the real parser. */
const patched = (onChange: ReturnType<typeof vi.fn>, path: string) => {
  const next = onChange.mock.calls.at(-1)?.[0] as string;

  return readFrontmatter(next)?.fields.get(path)?.value;
};

describe('AgentForm', () => {
  describe('the name field', () => {
    it('renders the name as an input, filled from the frontmatter', () => {
      setup();

      expect(screen.getByRole('textbox', { name: 'name' })).toHaveValue(
        'slack-watcher',
      );
    });

    /*
      The form and the Source tab are two views of one buffer, so the name has
      to travel the same way every other field does: read out of the frontmatter
      and patched back into it. That is what makes the two views agree without
      any syncing code.
    */
    it('patches name: in the buffer as it is typed', async () => {
      const onChange = setup();

      await userEvent.type(
        screen.getByRole('textbox', { name: 'name' }),
        '-2',
      );

      expect(patched(onChange, 'name')).toBe('slack-watcher-2');
    });

    it('leaves the rest of the file untouched', async () => {
      const onChange = setup();

      await userEvent.type(screen.getByRole('textbox', { name: 'name' }), 'x');

      const next = onChange.mock.calls.at(-1)?.[0] as string;

      expect(next).toContain('description: Watches #incorp-dev for build failures');
      expect(next).toContain('You are a watcher.');
      expect(next.split('\n')).toHaveLength(SOURCE.split('\n').length);
    });

    /*
      The whole point of the change: a duplicate used to be a red box that
      disabled Save with no way out of the form. It is numbered instead, the way
      a colliding session name is — and said out loud, because silently writing
      something other than what was typed would be its own bug.
    */
    it('renumbers a taken name on blur rather than refusing it', async () => {
      const onChange = setup({ taken: ['watcher', 'watcher-2'] });
      const field = screen.getByRole('textbox', { name: 'name' });

      await userEvent.clear(field);
      await userEvent.type(field, 'watcher');
      await userEvent.tab();

      expect(patched(onChange, 'name')).toBe('watcher-3');
    });

    it('says what it renamed, once it has', async () => {
      setup({ source: SOURCE.replace('slack-watcher', 'watcher'), taken: ['watcher'] });

      await userEvent.click(screen.getByRole('textbox', { name: 'name' }));
      await userEvent.tab();

      expect(await screen.findByRole('status')).toHaveTextContent(
        /watcher was taken/,
      );
    });

    /*
      The form is not remounted when another agent is opened — `AgentEditor`
      swaps the `source` prop — so a notice cleared by keystroke alone outlived
      its subject and read "watcher was taken — using <the other agent's name>".
      False, not merely stale.
    */
    it('drops the rename notice when the buffer becomes another agent', async () => {
      const { rerender } = render(
        <AgentForm
          source={SOURCE.replace('slack-watcher', 'watcher')}
          problems={[]}
          taken={['watcher']}
          onChange={vi.fn()}
        />,
      );

      await userEvent.click(screen.getByRole('textbox', { name: 'name' }));
      await userEvent.tab();

      rerender(
        <AgentForm
          source={SOURCE.replace('slack-watcher', 'someone-else')}
          problems={[]}
          taken={['watcher']}
          onChange={vi.fn()}
        />,
      );

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('leaves a free name alone', async () => {
      const onChange = setup({ taken: ['someone-else'] });

      await userEvent.click(screen.getByRole('textbox', { name: 'name' }));
      await userEvent.tab();

      expect(onChange).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    /*
      `name` is required, so an emptied box must stay an empty `name:` line the
      user can type back into. Every other text field deletes its line when
      cleared, because absence is a legal value for those; deleting this one
      would have `patchFrontmatter` re-add it later at the bottom of the
      frontmatter, below the `wake:` block it was declared above.
    */
    it('keeps the name: line when the box is emptied', async () => {
      const onChange = setup();

      await userEvent.clear(screen.getByRole('textbox', { name: 'name' }));

      const next = onChange.mock.calls.at(-1)?.[0] as string;

      expect(readFrontmatter(next)?.fields.has('name')).toBe(true);
      expect(patched(onChange, 'name')).toBe('');
    });
  });

  /*
    `row`'s label carries no `htmlFor` — it cannot, because the control beside
    it is an arbitrary node — so every input but `name` used to reach the
    accessibility tree anonymous: thirteen fields announced as "edit text".
  */
  it('gives every text field the accessible name the pane shows', () => {
    setup();

    for (const label of [
      'name',
      'description',
      'quiet hours',
      'wake on',
      'skills',
      'integrations',
      'tools',
      'turns',
      'budget $',
      'rotate after',
    ]) {
      expect(screen.getByRole('textbox', { name: label })).toBeInTheDocument();
    }
  });

  describe('the icon field', () => {
    it('is a picker, not a text box', () => {
      setup();

      expect(screen.getByRole('radiogroup', { name: 'Icon' })).toBeInTheDocument();
      expect(screen.getAllByRole('radio').length).toBeGreaterThan(1);
    });

    it('shows the icon the file names as the chosen one', () => {
      setup();

      expect(screen.getByRole('radio', { name: 'slack logo' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    it('patches icon: when one is picked', async () => {
      const onChange = setup();

      await userEvent.click(screen.getByRole('radio', { name: 'lightning' }));

      expect(patched(onChange, 'icon')).toBe('ph-lightning');
    });

    /*
      Every option must resolve, or the picker reproduces exactly the bug it
      replaces: `GLYPHS` is keyed `ph-robot`, the old free-text field accepted
      `Robot`, and the agent's row drew the fallback question mark with nothing
      anywhere to say why.
    */
    it('offers only names the Icon atom can draw', () => {
      for (const group of AGENT_ICON_GROUPS) {
        for (const name of group.names) {
          expect(ICON_NAMES).toContain(name);
        }
      }
    });
  });

  describe('field explanations', () => {
    /*
      The structural guarantee, rather than thirteen assertions that drift: a
      field cannot be added to the form without a sentence saying what it wants.
    */
    it('has a sentence for every field it renders', () => {
      for (const path of RENDERED_PATHS) {
        expect(FIELD_HELP[path]).toBeTruthy();
      }
    });

    it('draws them under the controls', () => {
      setup();

      expect(
        screen.getByText(FIELD_HELP['wake.on'] as string),
      ).toBeInTheDocument();
      expect(screen.getByText(FIELD_HELP.tools as string)).toBeInTheDocument();
      expect(
        screen.getByText(FIELD_HELP['limits.turns'] as string),
      ).toBeInTheDocument();
    });

    it('names the other values wake on accepts', () => {
      setup();

      const help = FIELD_HELP['wake.on'] as string;

      expect(help).toContain('slack.mention');
      expect(help).toContain('slack.channel:#name');
    });

    /*
      `daily` parses to a 24-hour *interval*, not a time of day, so an agent set
      to it drifts on every restart. The word implies otherwise, which is what
      sent this whole change back to the drawing board — the help says so
      outright until the grammar can express a fixed time.
    */
    it('says that daily is an interval, not a time of day', () => {
      setup();

      expect(FIELD_HELP['wake.every']).toMatch(/rather than a fixed time of day/);
    });

    it('names the default for every limit', () => {
      setup();

      expect(FIELD_HELP['limits.turns']).toMatch(/Default 40\./);
      expect(FIELD_HELP['limits.budget_usd']).toMatch(/Default 0\.50\./);
      expect(FIELD_HELP['limits.rotate_after']).toMatch(/Default 50\./);
    });
  });

  describe('the wake schedule', () => {
    const CAL = SOURCE.replace('  every: 5m\n', '  at: [09:00]\n');

    it('reads the mode off the buffer', () => {
      setup();

      expect(screen.getByRole('radio', { name: 'every…' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    it('reads the calendar mode off the buffer', () => {
      setup({ source: CAL });

      expect(
        screen.getByRole('radio', { name: 'on a schedule' }),
      ).toHaveAttribute('aria-checked', 'true');
    });

    it('shows no schedule controls when the file has neither key', () => {
      setup({ source: SOURCE.replace('  every: 5m\n', '') });

      expect(screen.getByRole('radio', { name: 'off' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(
        screen.queryByRole('radiogroup', { name: 'Wake every' }),
      ).not.toBeInTheDocument();
    });

    /*
      The parser refuses a definition naming both keys, so switching modes has
      to clear the other one in the same edit — three separate onChange calls
      would each start from a `source` prop that had not moved yet, and the
      last would win over the first two.
    */
    it('swaps every: for at: when the mode changes, leaving neither behind', async () => {
      const onChange = setup();

      await userEvent.click(
        screen.getByRole('radio', { name: 'on a schedule' }),
      );

      const next = onChange.mock.calls.at(-1)?.[0] as string;
      const fields = readFrontmatter(next)?.fields;

      expect(fields?.has('wake.every')).toBe(false);
      expect(fields?.get('wake.at')?.value).toBe('[09:00]');
    });

    it('swaps at: and days: back for every:', async () => {
      const onChange = setup({
        source: CAL.replace('  at: [09:00]\n', '  at: [09:00]\n  days: [mon]\n'),
      });

      await userEvent.click(screen.getByRole('radio', { name: 'every…' }));

      const fields = readFrontmatter(
        onChange.mock.calls.at(-1)?.[0] as string,
      )?.fields;

      expect(fields?.has('wake.at')).toBe(false);
      expect(fields?.has('wake.days')).toBe(false);
      expect(fields?.get('wake.every')?.value).toBe('5m');
    });

    /*
      Any `<n>m` / `<n>h` is legal, but only nine are on the control. An
      unlisted one used to show `5m` selected while the file said `2h` — not a
      missing option but a false statement about the agent's schedule.
    */
    it('shows an unlisted but legal interval as itself', () => {
      setup({ source: SOURCE.replace('every: 5m', 'every: 2h') });

      expect(screen.getByRole('radio', { name: '2h' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByRole('radio', { name: '5m' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });

    it('drops the improvised option once a listed one is picked', async () => {
      const onChange = setup({
        source: SOURCE.replace('every: 5m', 'every: 2h'),
      });

      await userEvent.click(screen.getByRole('radio', { name: '1h' }));

      expect(patched(onChange, 'wake.every')).toBe('1h');
    });

    it('offers intervals the old control left out', () => {
      setup();

      for (const label of ['30m', '3h', '6h', '12h']) {
        expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
      }
    });

    it('adds a time to at: when its chip is pressed', async () => {
      const onChange = setup({ source: CAL });

      await userEvent.click(screen.getByRole('button', { name: '17:00' }));

      expect(patched(onChange, 'wake.at')).toBe('[09:00, 17:00]');
    });

    /* `days:` with no `at:` names no wake, and the parser says so. */
    it('refuses to remove the last time', async () => {
      const onChange = setup({ source: CAL });

      await userEvent.click(screen.getByRole('button', { name: '09:00' }));

      expect(onChange).not.toHaveBeenCalled();
    });

    it('shows a time the file names that is not a preset', () => {
      setup({ source: CAL.replace('[09:00]', '[07:30]') });

      expect(screen.getByRole('button', { name: '07:30' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('writes days: when one is deselected', async () => {
      const onChange = setup({ source: CAL });

      await userEvent.click(screen.getByRole('button', { name: 'sun' }));

      expect(patched(onChange, 'wake.days')).toBe('[mon, tue, wed, thu, fri, sat]');
    });

    /*
      All seven and none mean the same thing — every day — so the key goes away
      rather than spelling out a list that says nothing.
    */
    it('drops days: when every day is selected again', async () => {
      const onChange = setup({
        source: CAL.replace('  at: [09:00]\n', '  at: [09:00]\n  days: [mon]\n'),
      });

      await userEvent.click(screen.getByRole('button', { name: 'mon' }));

      const fields = readFrontmatter(
        onChange.mock.calls.at(-1)?.[0] as string,
      )?.fields;

      expect(fields?.has('wake.days')).toBe(false);
    });
  });

  describe('the four groups', () => {
    it('sorts thirteen fields into four titled groups', () => {
      setup();

      for (const title of [
        'Identity',
        'When it wakes',
        'What it can do',
        'Limits',
      ]) {
        expect(
          screen.getByRole('heading', { name: title }),
        ).toBeInTheDocument();
      }
    });

    it('gives each group a sentence of its own', () => {
      setup();

      expect(
        screen.getByText(/An agent sleeps until a schedule or a message/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Anything not listed is refused/),
      ).toBeInTheDocument();
    });
  });

  describe('problems', () => {
    it('renders a name problem beside the name field, not in the banner', () => {
      render(
        <AgentForm
          source={SOURCE}
          problems={[{ field: 'name', reason: 'That name is reserved.' }]}
          taken={[]}
          onChange={vi.fn()}
        />,
      );

      const alert = screen.getByRole('alert');

      expect(alert).toHaveTextContent('That name is reserved.');
      // The banner prefixes with the field path; the inline one does not.
      expect(alert).not.toHaveTextContent('name:');
    });

    it('still banners a problem naming a field it does not render', () => {
      render(
        <AgentForm
          source={SOURCE}
          problems={[{ field: 'wobble', reason: 'Unknown key.' }]}
          taken={[]}
          onChange={vi.fn()}
        />,
      );

      const alert = screen.getByRole('alert');

      /*
        The path and the sentence are separate nodes, so the sentence stays
        addressable on its own — which is what lets a problem about a field the
        form is not currently drawing still be found by what it says.
      */
      expect(alert).toHaveTextContent('wobble:');
      expect(within(alert).getByText('Unknown key.')).toBeInTheDocument();
    });
  });

  /*
    A path can be in RENDERED_PATHS and still have no row on screen, because the
    wake modes are exclusive. Without this fallback such a problem is excluded
    from the banner for being renderable and excluded from the form for being in
    the other mode — refused Save, no visible reason, which is the exact failure
    the banner exists to prevent.
  */
  it('banners a wake problem the current mode is not showing', () => {
    render(
      <AgentForm
        source={SOURCE.replace('  every: 5m\n', '')}
        problems={[
          { field: 'wake.every', reason: 'Cannot be faster than 1m.' },
        ]}
        taken={[]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Cannot be faster than 1m.')).toBeInTheDocument();
  });

  it('says what is wrong when the file has no frontmatter', () => {
    setup({ source: 'no fences here\n' });

    expect(
      screen.getByText('This file has no frontmatter.'),
    ).toBeInTheDocument();
  });
});
