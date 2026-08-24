import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillsSection } from '@features/settings/components/skills-section';
import { resetSkills, setSkillsForTest } from '@lib/skills';

import type { SkillsSnapshot } from '@shared/skills-contract';

const loadSkills = vi.fn();
const readSkill = vi.fn();
const saveSkill = vi.fn();
const deleteSkill = vi.fn();

vi.mock('@/lib/skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skills')>();
  return {
    ...actual,
    loadSkills: () => loadSkills(),
    readSkill: (name: string) => readSkill(name),
    saveSkill: (name: string, body: string) => saveSkill(name, body),
    deleteSkill: (name: string) => deleteSkill(name),
  };
});

const file = (name: string): string =>
  `---\nname: ${name}\ndescription: does a thing\n---\nDo the thing.\n`;

const snapshot = (
  over: Partial<SkillsSnapshot> = {},
): SkillsSnapshot => ({
  skills: [],
  invalid: [],
  skillsRoot: '/home/u/.hive/skills',
  ...over,
});

const withSkills = (...names: string[]): SkillsSnapshot =>
  snapshot({
    skills: names.map((name) => ({
      name,
      description: 'does a thing',
      valid: true as const,
    })),
  });

beforeEach(() => {
  loadSkills.mockResolvedValue(undefined);
  // `null` is success — the mutators resolve with the reason they failed.
  saveSkill.mockResolvedValue(null);
  deleteSkill.mockResolvedValue(null);
  readSkill.mockImplementation((name: string) =>
    Promise.resolve({
      name,
      body: file(name),
      path: `/home/u/.hive/skills/${name}/SKILL.md`,
    }),
  );
});

afterEach(() => {
  resetSkills();
  vi.clearAllMocks();
});

describe('SkillsSection', () => {
  it('says custom skills need the desktop app when there is no bridge', () => {
    // The browser demo has no disk to write to. A pane of dead controls would
    // teach the user the app is broken.
    setSkillsForTest(null);

    render(<SkillsSection />);

    expect(
      screen.getByText(/only available in the desktop app/i),
    ).toBeInTheDocument();
  });

  it('shows the empty state and the CTA with no skills', () => {
    setSkillsForTest(snapshot());

    render(<SkillsSection />);

    expect(screen.getByText('No skills yet.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '+ New skill' }),
    ).toBeInTheDocument();
  });

  it('lists one row per skill, each named as its command', () => {
    setSkillsForTest(withSkills('ship-it', 'standup'));

    render(<SkillsSection />);

    expect(screen.getByRole('button', { name: '/ship-it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '/standup' })).toBeInTheDocument();
  });

  it('never lists the built-in /done', () => {
    /*
      The app rewrites `done` on every launch, so an edit here would be silently
      reverted. Main leaves it out of the snapshot; this asserts the pane does
      not invent it back.
    */
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);

    expect(screen.queryByRole('button', { name: '/done' })).toBeNull();
  });

  it('marks an invalid skill and refuses to open it', async () => {
    setSkillsForTest(
      snapshot({
        invalid: [
          { name: 'Bad Name', reason: 'Folder name must be lowercase.', valid: false },
        ],
      }),
    );

    render(<SkillsSection />);
    const row = screen.getByRole('button', { name: /Bad Name/ });

    expect(screen.getByText('invalid')).toBeInTheDocument();
    expect(row).toBeDisabled();
    await userEvent.click(row);
    expect(readSkill).not.toHaveBeenCalled();
  });

  it('opens a skill into the editor', async () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));

    expect(readSkill).toHaveBeenCalledWith('standup');
    expect(await screen.findByLabelText('Skill source')).toHaveValue(
      file('standup'),
    );
  });

  it('starts a new skill from a template with a blank name', async () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));

    // Blank on purpose: the folder is named from this field, and a default
    // would invite a tree full of `new-skill`.
    const box = screen.getByLabelText<HTMLTextAreaElement>('Skill source');
    expect(box.value).toContain('name:\n');
    expect(box.value).toMatch(/^---\n/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/give the skill a name/i)).toBeInTheDocument();
  });

  it('refuses the reserved name inline, with Save disabled', async () => {
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    const box = screen.getByLabelText('Skill source');
    await userEvent.clear(box);
    await userEvent.type(box, '---{enter}name: done{enter}---{enter}Body.');

    expect(screen.getByText(/reserved/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses a name with a space or uppercase', async () => {
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    const box = screen.getByLabelText('Skill source');
    await userEvent.clear(box);
    await userEvent.type(box, '---{enter}name: Stand Up{enter}---{enter}Body.');

    expect(screen.getByText(/lowercase letters/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses a duplicate name', async () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    const box = screen.getByLabelText('Skill source');
    await userEvent.clear(box);
    await userEvent.type(box, '---{enter}name: standup{enter}---{enter}Body.');

    expect(screen.getByText(/already have a skill/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves under the name typed in the frontmatter', async () => {
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    const box = screen.getByLabelText('Skill source');
    await userEvent.clear(box);
    await userEvent.type(box, '---{enter}name: triage{enter}---{enter}Body.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSkill).toHaveBeenCalledWith(
      'triage',
      '---\nname: triage\n---\nBody.',
    );
  });

  it('marks the open row edited while the buffer is dirty', async () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    await userEvent.type(await screen.findByLabelText('Skill source'), ' more');

    expect(screen.getByText('edited')).toBeInTheDocument();
    expect(screen.getByText('unsaved')).toBeInTheDocument();
  });

  it('asks before abandoning an edit, and Keep editing stays put', async () => {
    setSkillsForTest(withSkills('standup', 'triage'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    await userEvent.type(await screen.findByLabelText('Skill source'), ' more');
    readSkill.mockClear();
    await userEvent.click(screen.getByRole('button', { name: '/triage' }));

    expect(
      screen.getByRole('alertdialog', { name: /Discard changes/ }),
    ).toBeInTheDocument();
    // The switch has not happened yet — that is the whole point of asking.
    expect(readSkill).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(readSkill).not.toHaveBeenCalled();
  });

  it('switches after the discard is confirmed', async () => {
    setSkillsForTest(withSkills('standup', 'triage'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    await userEvent.type(await screen.findByLabelText('Skill source'), ' more');
    readSkill.mockClear();
    await userEvent.click(screen.getByRole('button', { name: '/triage' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(readSkill).toHaveBeenCalledWith('triage');
  });

  it('switches without asking when nothing is dirty', async () => {
    setSkillsForTest(withSkills('standup', 'triage'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    await screen.findByLabelText('Skill source');
    await userEvent.click(screen.getByRole('button', { name: '/triage' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(readSkill).toHaveBeenCalledWith('triage');
  });

  it('claims Escape, so backing out of a confirm does not close settings', async () => {
    /*
      `settings-overlay.tsx` reads this attribute on a document-capture
      listener that runs before anything focused sees the key. Without it,
      Escape here would close the whole overlay and lose the edit.
    */
    setSkillsForTest(withSkills('standup', 'triage'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    await userEvent.type(await screen.findByLabelText('Skill source'), ' more');
    await userEvent.click(screen.getByRole('button', { name: '/triage' }));

    expect(screen.getByRole('alertdialog')).toHaveAttribute('data-escape-scope');
  });

  it('asks before deleting, then removes the folder', async () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    await screen.findByLabelText('Skill source');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const confirm = screen.getByRole('alertdialog', { name: 'Delete /standup?' });
    expect(deleteSkill).not.toHaveBeenCalled();

    // Scoped to the confirmation: the editor's own Delete is still on screen
    // behind it, and clicking that one would be reopening the question.
    await userEvent.click(
      within(confirm).getByRole('button', { name: 'Delete' }),
    );

    expect(deleteSkill).toHaveBeenCalledWith('standup');
  });

  it('says why an invalid skill is invalid, in readable text', async () => {
    /*
      This was a `title` on the row — unreachable, because the row is disabled
      and Chromium delivers no pointer events to a disabled control, so the
      tooltip never appeared. The whole reason main returns its rejects rather
      than logging them is that the user can act on them.
    */
    setSkillsForTest(
      snapshot({
        invalid: [
          {
            name: 'Bad Name',
            reason: 'Folder name must be lowercase letters, digits and dashes.',
            valid: false,
          },
        ],
      }),
    );

    render(<SkillsSection />);

    expect(
      screen.getByText(/Bad Name: Folder name must be lowercase/),
    ).toBeInTheDocument();
  });

  it('counts an invalid skill as a taken name, so a save cannot clobber it', async () => {
    /*
      An invalid skill is still a folder with a SKILL.md in it. The commonest
      invalid case is a frontmatter name that disagrees with its folder — which
      is exactly the name the user then types.
    */
    setSkillsForTest(
      snapshot({
        invalid: [
          { name: 'standup', reason: 'Frontmatter name does not match.', valid: false },
        ],
      }),
    );

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    const box = screen.getByLabelText('Skill source');
    await userEvent.clear(box);
    await userEvent.type(box, '---{enter}name: standup{enter}---{enter}Body.');

    expect(screen.getByText(/already have a skill/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('reports a refused save instead of claiming it saved', async () => {
    saveSkill.mockResolvedValue('EACCES: permission denied');
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    const box = screen.getByLabelText('Skill source');
    await userEvent.clear(box);
    await userEvent.type(box, '---{enter}name: triage{enter}---{enter}Body.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'EACCES: permission denied',
    );
    // Still unsaved — the badge must not claim otherwise.
    expect(screen.getByText('unsaved')).toBeInTheDocument();
  });

  it('reports a refused delete and keeps the editor open', async () => {
    deleteSkill.mockResolvedValue('ENOTEMPTY');
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    await screen.findByLabelText('Skill source');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ENOTEMPTY');
    // Emptying the editor over a row that is still listed would tell the user a
    // destructive action succeeded while showing them that it did not.
    expect(screen.getByLabelText('Skill source')).toBeInTheDocument();
  });

  it('ignores a read that resolves after the user moved on', async () => {
    /*
      Two quick clicks race. The first leaves the buffer null, so the dirty
      guard does not stop the second, and whichever read resolves last wins —
      which could be the first row's body under the second row's name.
    */
    let resolveFirst: (file: unknown) => void = () => undefined;
    readSkill.mockImplementation((name: string) => {
      if (name === 'standup') {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        name,
        body: file(name),
        path: `/home/u/.hive/skills/${name}/SKILL.md`,
      });
    });
    setSkillsForTest(withSkills('standup', 'triage'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    await userEvent.click(screen.getByRole('button', { name: '/triage' }));
    expect(await screen.findByLabelText('Skill source')).toHaveValue(file('triage'));

    // The stale response lands last and must be dropped on the floor.
    resolveFirst({
      name: 'standup',
      body: file('standup'),
      path: '/home/u/.hive/skills/standup/SKILL.md',
    });

    await expect
      .poll(() => screen.getByLabelText<HTMLTextAreaElement>('Skill source').value)
      .toBe(file('triage'));
  });

  it('asks a sensible question about a skill that was never saved', async () => {
    // "Discard changes to /?" is nonsense on screen, and the question doubles
    // as the confirm's accessible name.
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    await userEvent.type(screen.getByLabelText('Skill source'), 'more');
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));

    expect(
      screen.getByRole('alertdialog', { name: 'Discard this new skill?' }),
    ).toBeInTheDocument();
  });

  it('cancels the confirm on Escape from the textarea', async () => {
    /*
      The caret is normally still in the editor when the confirm appears. Escape
      there reached neither button, and `data-escape-scope` had already told the
      overlay to decline — so the key did nothing at all.
    */
    setSkillsForTest(withSkills('standup', 'triage'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    const box = await screen.findByLabelText('Skill source');
    await userEvent.type(box, ' more');
    await userEvent.click(screen.getByRole('button', { name: '/triage' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    box.focus();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows where the files live', () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);

    expect(
      screen.getByText('Skills folder: /home/u/.hive/skills'),
    ).toBeInTheDocument();
  });
});
