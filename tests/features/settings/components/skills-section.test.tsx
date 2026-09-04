import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillsSection } from '@features/settings/components/skills-section';
import {
  appendSurfaceText,
  setSurfaceText,
  surfaceText,
} from '@tests/support/editor-surface';
import { resetSkills, setSkillsForTest } from '@lib/skills';

import type { SkillsSnapshot } from '@shared/skills-contract';

const loadSkills = vi.fn();
const readSkill = vi.fn();
const saveSkill = vi.fn();
const deleteSkill = vi.fn();
const renameSkill = vi.fn();

vi.mock('@/lib/skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skills')>();
  return {
    ...actual,
    loadSkills: () => loadSkills(),
    readSkill: (name: string) => readSkill(name),
    saveSkill: (name: string, body: string) => saveSkill(name, body),
    deleteSkill: (name: string) => deleteSkill(name),
    renameSkill: (from: string, to: string, body: string) =>
      renameSkill(from, to, body),
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
  // A rename resolves with what it *did*, not just whether it worked — the
  // middle outcome (moved, then failed to write) is what recovery hangs on.
  renameSkill.mockResolvedValue({ moved: true, error: null });
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

    expect(
      screen.getByText('Write one and every session you start will have it.'),
    ).toBeInTheDocument();
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
    await screen.findByLabelText('Skill source');
    expect(surfaceText('Skill source')).toBe(file('standup'));
  });

  it('starts a new skill from a template with a blank name', async () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));

    // Blank on purpose: the folder is named from this field, and a default
    // would invite a tree full of `new-skill`.
    const source = surfaceText('Skill source');
    expect(source).toContain('name:\n');
    expect(source).toMatch(/^---\n/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/give the skill a name/i)).toBeInTheDocument();
  });

  it('refuses the reserved name inline, with Save disabled', async () => {
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    setSurfaceText('Skill source', '---\nname: done\n---\nBody.');

    expect(screen.getByText(/reserved/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses a name with a space or uppercase', async () => {
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    setSurfaceText('Skill source', '---\nname: Stand Up\n---\nBody.');

    expect(screen.getByText(/lowercase letters/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses a duplicate name', async () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    setSurfaceText('Skill source', '---\nname: standup\n---\nBody.');

    expect(screen.getByText(/already have a skill/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves under the name typed in the frontmatter', async () => {
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    setSurfaceText('Skill source', '---\nname: triage\n---\nBody.');
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
    appendSurfaceText('Skill source', ' more');

    expect(screen.getByText('edited')).toBeInTheDocument();
    expect(screen.getByText('unsaved')).toBeInTheDocument();
  });

  it('asks before abandoning an edit, and Keep editing stays put', async () => {
    setSkillsForTest(withSkills('standup', 'triage'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    appendSurfaceText('Skill source', ' more');
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
    appendSurfaceText('Skill source', ' more');
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
    appendSurfaceText('Skill source', ' more');
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
    setSurfaceText('Skill source', '---\nname: standup\n---\nBody.');

    expect(screen.getByText(/already have a skill/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('reports a refused save instead of claiming it saved', async () => {
    saveSkill.mockResolvedValue('EACCES: permission denied');
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    setSurfaceText('Skill source', '---\nname: triage\n---\nBody.');
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
    await screen.findByLabelText('Skill source');
    expect(surfaceText('Skill source')).toBe(file('triage'));

    // The stale response lands last and must be dropped on the floor.
    resolveFirst({
      name: 'standup',
      body: file('standup'),
      path: '/home/u/.hive/skills/standup/SKILL.md',
    });

    await expect
      .poll(() => surfaceText('Skill source'))
      .toBe(file('triage'));
  });

  it('asks a sensible question about a skill that was never saved', async () => {
    // "Discard changes to /?" is nonsense on screen, and the question doubles
    // as the confirm's accessible name.
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    appendSurfaceText('Skill source', 'more');
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));

    expect(
      screen.getByRole('alertdialog', { name: 'Discard this new skill?' }),
    ).toBeInTheDocument();
  });

  it('cancels the confirm on Escape from the editor', async () => {
    /*
      The caret is normally still in the editor when the confirm appears. Escape
      there reached neither button, and `data-escape-scope` had already told the
      overlay to decline — so the key did nothing at all.
    */
    setSkillsForTest(withSkills('standup', 'triage'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    const box = await screen.findByLabelText('Skill source');
    appendSurfaceText('Skill source', ' more');
    await userEvent.click(screen.getByRole('button', { name: '/triage' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    // The caret is in CodeMirror's content, which is where it really is when
    // the confirm appears — the whole point of the test.
    box.focus();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  /*
    The pane is the explorer's own editor now, not a textarea. Three things
    that buys: a gutter under a footer that explains refusals about a *line*,
    the floating find panel, and ⌘S bound inside the view — the only place a
    save shortcut fires while CodeMirror holds focus.
  */
  describe('the editor', () => {
    it('numbers the lines', async () => {
      setSkillsForTest(withSkills('standup'));

      const { container } = render(<SkillsSection />);
      await userEvent.click(screen.getByRole('button', { name: '/standup' }));
      await screen.findByLabelText('Skill source');

      expect(container.querySelector('.cm-lineNumbers')).not.toBeNull();
    });

    it('saves on ⌘S, once, while the editor holds focus', async () => {
      setSkillsForTest(withSkills('standup'));

      render(<SkillsSection />);
      await userEvent.click(screen.getByRole('button', { name: '/standup' }));
      const box = await screen.findByLabelText('Skill source');
      appendSurfaceText('Skill source', ' more');

      fireEvent.keyDown(box, { key: 's', metaKey: true });

      /*
        Once, not twice. CodeMirror prevents the default when it handles the key
        and the event still bubbles to the frame's own listener — and a second
        save is not harmless here, because a renamed skill goes through
        `renameSkill` rather than `saveSkill`.
      */
      expect(saveSkill).toHaveBeenCalledTimes(1);
    });

    /*
      Save carries a literal `disabled` while the name is refused, so a shortcut
      that wrote anyway would be a louder route past the rule the visible
      control enforces. Doing nothing is not silence — the footer is showing the
      reason in red the whole time.
    */
    it('refuses ⌘S exactly where the Save button refuses', async () => {
      setSkillsForTest(withSkills('standup', 'ship-it'));

      render(<SkillsSection />);
      await userEvent.click(screen.getByRole('button', { name: '/standup' }));
      await screen.findByLabelText('Skill source');
      setSurfaceText('Skill source', '---\nname: ship-it\n---\nBody.');

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

      fireEvent.keyDown(screen.getByLabelText('Skill source'), {
        key: 's',
        metaKey: true,
      });

      expect(saveSkill).not.toHaveBeenCalled();
      expect(renameSkill).not.toHaveBeenCalled();
    });
  });

  /*
    150px ellipsised a `/name` of any length while the detail pane beside it sat
    on width it was not short of. 190 is the same number the agents pane took —
    the two are the same shape and are read one after the other, so the list
    must not move under a reader switching between them.
  */
  it('gives the list room for a command name', async () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);
    const target = await screen.findByRole('button', { name: '/standup' });

    expect(target.parentElement?.parentElement).toHaveClass(
      'grid-cols-[190px_minmax(0,1fr)]',
    );
  });

  it('shows where the files live', () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);

    expect(
      screen.getByText('Skills folder: /home/u/.hive/skills'),
    ).toBeInTheDocument();
  });
});

/**
 * Editing the frontmatter name is a rename, and it asks first (HIVE-99).
 *
 * Before this, Save wrote the new folder and left the old one — still valid,
 * still listed, still injected — so one action produced two live commands and
 * the user was left to find the fork. The asking is not politeness: moving a
 * file nobody asked to delete is the thing HIVE-96 refused to do silently, and
 * the confirm is what makes doing it now honest rather than a reversal.
 */
describe('SkillsSection renaming', () => {
  /** Open `name` and retype its whole body under `next`. */
  const retype = async (name: string, next: string): Promise<void> => {
    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: `/${name}` }));
    await screen.findByLabelText('Skill source');
    setSurfaceText('Skill source', `---\nname: ${next}\n---\nBody.`);
  };

  const renamed = (next: string): string =>
    `---\nname: ${next}\n---\nBody.`;

  it('asks before moving the folder, and has not moved it yet', async () => {
    setSkillsForTest(withSkills('standup'));

    await retype('standup', 'stand-up');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      screen.getByRole('alertdialog', {
        name: 'Rename /standup to /stand-up?',
      }),
    ).toBeInTheDocument();
    expect(renameSkill).not.toHaveBeenCalled();
    expect(saveSkill).not.toHaveBeenCalled();
  });

  it('says what the user will otherwise discover in a live terminal', async () => {
    /*
      A running session was started with the old plugin directory and keeps the
      command it was given. Without this line the user renames, tries the old
      command in the terminal they have open, watches it work, and concludes
      the rename did not happen.
    */
    setSkillsForTest(withSkills('standup'));

    await retype('standup', 'stand-up');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      screen.getByText(
        'The old command stops working. Sessions already running keep it until they end.',
      ),
    ).toBeInTheDocument();
  });

  it('moves the folder and writes the body once confirmed', async () => {
    setSkillsForTest(withSkills('standup'));

    await retype('standup', 'stand-up');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

    expect(renameSkill).toHaveBeenCalledWith(
      'standup',
      'stand-up',
      renamed('stand-up'),
    );
    // Never both: a `write` beside the rename is how the duplicate came back.
    expect(saveSkill).not.toHaveBeenCalled();
  });

  it('changes nothing when the rename is cancelled, and keeps the edit', async () => {
    setSkillsForTest(withSkills('standup'));

    await retype('standup', 'stand-up');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(renameSkill).not.toHaveBeenCalled();
    expect(saveSkill).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Still dirty — cancelling a question is not the same as discarding.
    expect(screen.getByText('unsaved')).toBeInTheDocument();
  });

  it('asks nothing when the name is unchanged', async () => {
    setSkillsForTest(withSkills('standup'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    appendSurfaceText('Skill source', 'One more line.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(renameSkill).not.toHaveBeenCalled();
    expect(saveSkill).toHaveBeenCalled();
  });

  it('asks nothing for a skill that has never been saved', async () => {
    // There is no folder to move. The first save of a new skill names it, and
    // asking "rename /?" about a file that does not exist is nonsense.
    setSkillsForTest(snapshot());

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '+ New skill' }));
    setSurfaceText('Skill source', '---\nname: triage\n---\nBody.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(renameSkill).not.toHaveBeenCalled();
    expect(saveSkill).toHaveBeenCalledWith('triage', renamed('triage'));
  });

  it('will not offer to rename onto a name that is taken', async () => {
    /*
      `taken` disables Save before the question is ever asked, so the confirm
      cannot be the thing that stops a collision. Main refuses it independently
      — see the runtime's own tests — because a boundary that is correct only
      while the UI in front of it is correct is not a boundary.
    */
    setSkillsForTest(withSkills('standup', 'ship-it'));

    await retype('standup', 'ship-it');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/already have a skill called ship-it/i)).toBeInTheDocument();
  });

  it('follows the skill to its new name once the move succeeds', async () => {
    setSkillsForTest(withSkills('standup'));

    await retype('standup', 'stand-up');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

    // The editor is over the new file, and the buffer is no longer dirty.
    expect(
      screen.getByText('/home/u/.hive/skills/stand-up/SKILL.md'),
    ).toBeInTheDocument();
    expect(screen.getByText('saved')).toBeInTheDocument();
  });

  it('reports a refused rename instead of claiming it moved', async () => {
    renameSkill.mockResolvedValue({
      moved: false,
      error: 'A skill called "stand-up" already exists.',
    });
    setSkillsForTest(withSkills('standup'));

    await retype('standup', 'stand-up');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A skill called "stand-up" already exists.',
    );
    // Still unsaved, so Save retries rather than the user losing the edit.
    expect(screen.getByText('unsaved')).toBeInTheDocument();
    // Nothing moved, so the editor stays over the file it is still editing.
    expect(
      screen.getByText('/home/u/.hive/skills/standup/SKILL.md'),
    ).toBeInTheDocument();
  });

  it('follows a move that landed before the write failed, so Save can retry', async () => {
    /*
      The half-done rename, and the one case where doing nothing traps the user.

      The folder is `stand-up` and the file inside still says `standup`, so main
      lists it invalid. If the editor stayed on `standup`, the pane's own
      `taken` list — which counts invalid rows — would contain `stand-up`, the
      name the user is trying to save. `skillNameProblem` answers "you already
      have a skill called stand-up", Save goes disabled, and the invalid row is
      `disabled` so it cannot be opened either: the only way out is a text
      editor. Following the file turns the retry back into an ordinary Save.
    */
    renameSkill.mockResolvedValue({ moved: true, error: 'EACCES' });
    setSkillsForTest(withSkills('standup'));

    await retype('standup', 'stand-up');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

    // Main's answer to the half-done move, as the pane would receive it.
    setSkillsForTest(
      snapshot({
        invalid: [
          {
            name: 'stand-up',
            reason: 'Frontmatter name "standup" does not match the folder.',
            valid: false,
          },
        ],
      }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('EACCES');
    // The editor followed the file, so the retry is a plain write.
    expect(
      screen.getByText('/home/u/.hive/skills/stand-up/SKILL.md'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    saveSkill.mockClear();
    renameSkill.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSkill).toHaveBeenCalledWith('stand-up', renamed('stand-up'));
    // Not a second rename: the folder already has the name it was asked for.
    expect(renameSkill).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('retires the question when the buffer it quotes is edited', async () => {
    /*
      The confirm is deliberately not modal — it sits beside a live textarea —
      and its question quotes the buffer ("Rename /standup to /stand-up?")
      while its action closes over it. Type on and it would answer for text
      that is no longer on screen: the stale body written, the stale name
      moved to, and a second rename queued behind it.
    */
    setSkillsForTest(withSkills('standup'));

    await retype('standup', 'stand-up');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    appendSurfaceText('Skill source', ' Extra.');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(renameSkill).not.toHaveBeenCalled();

    // Asking again asks about the text that is actually there.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));

    expect(renameSkill).toHaveBeenCalledWith(
      'standup',
      'stand-up',
      `${renamed('stand-up')} Extra.`,
    );
  });

  it('keeps the discard question up while the user keeps typing', async () => {
    // The counterpart, and the reason the rule is a flag rather than blanket.
    // "Discard changes to /standup?" quotes nothing from the buffer — more
    // typing only makes it more true — so it stays, and Escape still cancels.
    setSkillsForTest(withSkills('standup', 'triage'));

    render(<SkillsSection />);
    await userEvent.click(screen.getByRole('button', { name: '/standup' }));
    appendSurfaceText('Skill source', ' more');
    await userEvent.click(screen.getByRole('button', { name: '/triage' }));
    expect(
      screen.getByRole('alertdialog', { name: /Discard changes/ }),
    ).toBeInTheDocument();

    appendSurfaceText('Skill source', ' and more');

    expect(
      screen.getByRole('alertdialog', { name: /Discard changes/ }),
    ).toBeInTheDocument();
  });
});
