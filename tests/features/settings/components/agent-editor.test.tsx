import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AgentEditor } from '@features/settings/components/agent-editor';

import type { AgentProblem } from '@shared/agent-contract';

const SOURCE = `---
name: slack-watcher
description: Watches #incorp-dev and my mentions.
icon: ChatCircleDots                # a Phosphor name
wake:
  every: 5m                         # floor 1m
  on: [ledger]
autonomy: ask                       # ask | act
limits:
  turns: 40
---
You are the Slack watcher.
`;

interface Props {
  path: string | null;
  source: string;
  dirty: boolean;
  problems: AgentProblem[];
  onChange: (source: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

const props: Props = {
  path: '/root/agents/slack-watcher/AGENT.md',
  source: SOURCE,
  dirty: false,
  problems: [],
  onChange: vi.fn(),
  onSave: vi.fn(),
  onDelete: vi.fn(),
};

const setup = (over: Partial<Props> = {}) => {
  const onChange = vi.fn();
  const merged: Props = { ...props, onChange, ...over };

  render(<AgentEditor {...merged} />);

  return { ...merged, onChange: merged.onChange as ReturnType<typeof vi.fn> };
};

describe('AgentEditor', () => {
  it('opens on the Form tab', () => {
    setup();

    expect(screen.getByRole('tab', { name: 'Form' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByDisplayValue('Watches #incorp-dev and my mentions.'),
    ).toBeInTheDocument();
  });

  it('shows the path, which is where the bytes go', () => {
    setup();

    expect(
      screen.getByText('/root/agents/slack-watcher/AGENT.md'),
    ).toBeInTheDocument();
  });

  it('calls it a new agent before it has a path', () => {
    setup({ path: null });

    expect(screen.getByText('New agent')).toBeInTheDocument();
  });

  describe('the form patches the file', () => {
    it('changes only the value, keeping the trailing comment', async () => {
      const { onChange } = setup();

      await userEvent.click(screen.getByRole('radio', { name: 'act' }));

      const next = onChange.mock.calls[0]?.[0] as string;

      expect(next).toContain('autonomy: act');
      expect(next).toContain('# ask | act');
      // Every other line survives untouched — the whole point of patching.
      expect(next).toContain('icon: ChatCircleDots                # a Phosphor name');
      expect(next).toContain('You are the Slack watcher.');
    });

    it('writes a wake interval', async () => {
      const { onChange } = setup();

      await userEvent.click(screen.getByRole('radio', { name: '15m' }));

      expect(onChange.mock.calls[0]?.[0]).toContain('every: 15m');
    });

    it('removes the line entirely for wake off, since absence is the value', async () => {
      // `every: off` is not a value the grammar has — manual-only is expressed
      // by the key simply not being there.
      const { onChange } = setup();

      await userEvent.click(screen.getByRole('radio', { name: 'off' }));

      expect(onChange.mock.calls[0]?.[0]).not.toContain('every:');
    });

    it('edits a text field', async () => {
      const { onChange } = setup();

      await userEvent.type(screen.getByDisplayValue('ChatCircleDots'), '!');

      expect(onChange.mock.calls[0]?.[0]).toContain('ChatCircleDots!');
    });

    it('removes the line when a field is cleared, rather than leaving key:', async () => {
      /*
        Absence is a value in this grammar and there is no token that spells
        it. Writing an empty `skills:` produced a line the parser rejects, so
        clearing an optional field jammed the form with no way out but the
        Source tab.
      */
      const withSkills = SOURCE.replace(
        'autonomy: ask',
        'skills: [a]\nautonomy: ask',
      );
      const onChange = vi.fn();

      render(<AgentEditor {...props} source={withSkills} onChange={onChange} />);
      await userEvent.clear(screen.getByDisplayValue('[a]'));

      expect(onChange.mock.calls[0]?.[0]).not.toContain('skills:');
    });
  });

  describe('a file with no frontmatter', () => {
    const FENCELESS = 'name: a\ndescription: d\n';

    it('says so instead of rendering a form that does nothing', () => {
      // Every field would read blank and every keystroke would be a no-op,
      // because patchFrontmatter returns the source unchanged. This is exactly
      // the file the pane promises can be opened and fixed.
      render(<AgentEditor {...props} source={FENCELESS} />);

      expect(
        screen.getByText('This file has no frontmatter.'),
      ).toBeInTheDocument();
      expect(screen.getByText(/Fix it in the Source tab/)).toBeInTheDocument();
    });

    it('still lets the Source tab edit it', async () => {
      const onChange = vi.fn();

      render(<AgentEditor {...props} source={FENCELESS} onChange={onChange} />);
      await userEvent.click(screen.getByRole('tab', { name: 'Source' }));
      await userEvent.type(
        screen.getByRole('textbox', { name: 'Agent source' }),
        '-',
      );

      expect(onChange).toHaveBeenCalled();
    });
  });

  describe('the two tabs are one buffer', () => {
    it('shows the same bytes in Source that the form is editing', async () => {
      setup();

      await userEvent.click(screen.getByRole('tab', { name: 'Source' }));

      expect(screen.getByRole('textbox', { name: 'Agent source' })).toHaveValue(
        SOURCE,
      );
    });

    it('edits the buffer from the Source tab too', async () => {
      const { onChange } = setup();

      await userEvent.click(screen.getByRole('tab', { name: 'Source' }));
      await userEvent.type(
        screen.getByRole('textbox', { name: 'Agent source' }),
        'x',
      );

      expect(onChange).toHaveBeenCalled();
    });

    it('does not lose an edit made in the form when switching to Source', async () => {
      const edited = SOURCE.replace('autonomy: ask', 'autonomy: act');

      const { rerender } = render(<AgentEditor {...props} source={edited} />);

      rerender(<AgentEditor {...props} source={edited} />);
      await userEvent.click(screen.getByRole('tab', { name: 'Source' }));

      expect(screen.getByRole('textbox', { name: 'Agent source' })).toHaveValue(
        edited,
      );
    });
  });

  describe('problems', () => {
    it('renders a problem beside the field it names', () => {
      setup({
        problems: [
          { field: 'skills', reason: 'release-notes is not in ~/.hive/skills.' },
        ],
      });

      expect(
        screen.getByText('release-notes is not in ~/.hive/skills.'),
      ).toBeInTheDocument();
    });

    it('shows an unknown key, which has no field of its own', () => {
      setup({
        problems: [
          { field: 'nope', reason: 'Unknown key. Remove it or fix the spelling.' },
        ],
      });

      // Once, in the form's unmatched block — the footer only counts it.
      expect(screen.getAllByText(/nope: Unknown key/)).toHaveLength(1);
    });

    it('shows a whole-file problem in the footer, which owns it alone', () => {
      setup({
        problems: [
          { field: '', reason: 'AGENT.md must open and close with a --- line.' },
        ],
      });

      // Exactly once: it has no field to sit beside, so only the footer says it.
      expect(
        screen.getAllByText(/must open and close with a --- line/),
      ).toHaveLength(1);
    });

    it('counts field problems rather than repeating them in the footer', () => {
      setup({
        problems: [
          { field: 'skills', reason: 'release-notes is not in ~/.hive/skills.' },
          { field: 'wake.every', reason: 'Cannot be faster than 1m.' },
        ],
      });

      // Each sentence appears once, beside its own field.
      expect(
        screen.getAllByText('Cannot be faster than 1m.'),
      ).toHaveLength(1);
      expect(screen.getByText('2 problems — see the form.')).toBeInTheDocument();
    });

    it('states the naming rule when there is nothing wrong', () => {
      setup();

      expect(
        screen.getByText('The name in the frontmatter names the folder.'),
      ).toBeInTheDocument();
    });
  });

  describe('the footer', () => {
    it('offers Run now disabled, saying why', () => {
      setup();

      const run = screen.getByRole('button', { name: 'Run now' });

      expect(run).toBeDisabled();
      // Native title: the app mounts no TooltipProvider.
      expect(run).toHaveAttribute('title', expect.stringMatching(/do not run yet/i));
    });

    it('saves and deletes', async () => {
      const onSave = vi.fn();
      const onDelete = vi.fn();

      setup({ onSave, onDelete });

      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

      expect(onSave).toHaveBeenCalled();
      expect(onDelete).toHaveBeenCalled();
    });

    it('says whether the buffer is unsaved', () => {
      const { unmount } = render(<AgentEditor {...props} dirty />);

      expect(screen.getByText('unsaved')).toBeInTheDocument();
      unmount();

      render(<AgentEditor {...props} />);
      expect(screen.getByText('saved')).toBeInTheDocument();
    });
  });
});
