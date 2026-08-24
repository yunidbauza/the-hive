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
  saveSkill.mockResolvedValue(undefined);
  deleteSkill.mockResolvedValue(undefined);
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

  it('shows where the files live', () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);

    expect(
      screen.getByText('Skills folder: /home/u/.hive/skills'),
    ).toBeInTheDocument();
  });
});
