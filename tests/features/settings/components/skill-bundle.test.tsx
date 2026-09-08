import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SkillBundle } from '@features/settings/components/skill-bundle';

import type {
  BundleEntry,
  BundleManifest,
  SkillSummary,
} from '@shared/skills-contract';

/**
 * The bundle tree in Settings › Skills (HIVE-148).
 *
 * Every assertion here is about grouping a **flat** manifest into a tree, which
 * is the component's whole job: main walked the folder before this rendered, so
 * there is no IPC to mock and no loading state to wait on.
 */

const file = (path: string, excluded: BundleEntry['excluded'] = null): BundleEntry => ({
  path,
  kind: 'file',
  size: 10,
  executable: false,
  excluded,
});

const dir = (path: string, excluded: BundleEntry['excluded'] = null): BundleEntry => ({
  path,
  kind: 'directory',
  size: 0,
  executable: false,
  excluded,
});

const skill = (manifest: BundleManifest): SkillSummary => ({
  name: 'graphify',
  description: 'builds a graph',
  valid: true,
  manifest,
});

const manifest: BundleManifest = {
  entries: [
    file('SKILL.md'),
    dir('scripts'),
    file('scripts/build.py'),
    dir('node_modules', {
      code: 'skipped',
      reason: 'Skipped by name — this is never sent to a session.',
    }),
    file('big.bin', {
      code: 'too-large',
      reason: 'Larger than 5 MB — not sent.',
    }),
  ],
  capped: null,
};

const props = {
  openPath: null,
  dirty: false,
  onBack: vi.fn(),
  onOpen: vi.fn(),
  onNewFile: vi.fn(),
  onNewFolder: vi.fn(),
  onImport: vi.fn(),
  onDrop: vi.fn(),
};

const drop = (files: File[]) => ({ dataTransfer: { files } });

describe('SkillBundle', () => {
  it('nests a file under its folder, and only once the folder is opened', () => {
    render(<SkillBundle {...props} skill={skill(manifest)} />);

    expect(screen.getByRole('button', { name: /SKILL\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /build\.py/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /scripts/ }));

    expect(screen.getByRole('button', { name: /build\.py/ })).toBeInTheDocument();
  });

  it('renders only the last segment of a nested path', () => {
    render(<SkillBundle {...props} skill={skill(manifest)} />);
    fireEvent.click(screen.getByRole('button', { name: /scripts/ }));

    // `scripts/build.py` would be a path masquerading as a filename.
    expect(screen.getByRole('button', { name: /build\.py/ })).toHaveTextContent(
      /^build\.py$/,
    );
  });

  it('marks an excluded row by its code, and keeps it selectable', () => {
    render(<SkillBundle {...props} skill={skill(manifest)} />);

    const skipped = screen.getByRole('button', { name: /node_modules/ });
    // Not disabled: the user has to be able to open it to read why, and to
    // delete it. That is the lesson the invalid-skill row taught.
    expect(skipped).not.toBeDisabled();
    expect(skipped).toHaveTextContent('skipped');
    expect(
      screen.getByRole('button', { name: /big\.bin/ }),
    ).toHaveTextContent('too large');
  });

  it('opens a file rather than toggling it', () => {
    const onOpen = vi.fn();
    render(<SkillBundle {...props} skill={skill(manifest)} onOpen={onOpen} />);

    fireEvent.click(screen.getByRole('button', { name: /SKILL\.md/ }));

    expect(onOpen).toHaveBeenCalledWith('SKILL.md');
  });

  it('goes back to the skill list from the crumb', () => {
    const onBack = vi.fn();
    render(<SkillBundle {...props} skill={skill(manifest)} onBack={onBack} />);

    fireEvent.click(screen.getByRole('button', { name: /Skills/ }));

    expect(onBack).toHaveBeenCalled();
  });

  it('drops onto the tree itself, targeting the bundle root', () => {
    const onDrop = vi.fn();
    render(<SkillBundle {...props} skill={skill(manifest)} onDrop={onDrop} />);

    const tree = screen.getByLabelText('Files in graphify');
    fireEvent.dragOver(tree, drop([]));
    fireEvent.drop(tree, drop([new File(['x'], 'a.py')]));

    expect(onDrop).toHaveBeenCalledWith('', expect.any(Array));
  });

  it('drops onto a folder row, targeting that folder and not the root', () => {
    const onDrop = vi.fn();
    render(<SkillBundle {...props} skill={skill(manifest)} onDrop={onDrop} />);

    const folder = screen.getByRole('button', { name: /scripts/ });
    fireEvent.dragOver(folder, drop([]));
    fireEvent.drop(folder, drop([new File(['x'], 'a.py')]));

    // Once, for `scripts` — not twice with the root handler firing too.
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('scripts', expect.any(Array));
  });

  it('ignores a drop carrying no files', () => {
    const onDrop = vi.fn();
    render(<SkillBundle {...props} skill={skill(manifest)} onDrop={onDrop} />);

    fireEvent.drop(screen.getByLabelText('Files in graphify'), drop([]));

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('says once when the walk was capped, rather than on a row', () => {
    render(
      <SkillBundle
        {...props}
        skill={skill({
          entries: manifest.entries,
          capped: 'Stopped at 200 files — the rest of this folder is not listed or sent.',
        })}
      />,
    );

    expect(screen.getByText(/Stopped at 200 files/)).toBeInTheDocument();
  });

  it('shows SKILL.md even when the walk was capped before reaching it', () => {
    /*
      The walk stops at 200 files in localeCompare order, and `assets` sorts
      before `SKILL.md`. The mirror writes the manifest file regardless, so a
      pane without this row would hide the one file that makes it a skill.
    */
    render(
      <SkillBundle
        {...props}
        skill={skill({
          entries: [dir('assets'), file('assets/a.png')],
          capped: 'Stopped at 200 files.',
        })}
      />,
    );

    expect(screen.getByRole('button', { name: /SKILL\.md/ })).toBeInTheDocument();
  });

  it('carries the unsaved marker on the crumb, which is the way out', () => {
    const { rerender } = render(
      <SkillBundle {...props} skill={skill(manifest)} dirty={false} />,
    );

    expect(screen.queryByText('edited')).toBeNull();

    rerender(<SkillBundle {...props} skill={skill(manifest)} dirty />);

    // On the control that leaves, not on a row: leaving is when the edit is
    // about to cost something.
    expect(
      within(screen.getByRole('button', { name: /^Skills/ })).getByText('edited'),
    ).toBeInTheDocument();
  });

  it('offers three ways to add, and only after asking', () => {
    const onNewFile = vi.fn();
    render(
      <SkillBundle {...props} skill={skill(manifest)} onNewFile={onNewFile} />,
    );

    // The menu is closed until asked for, so the column is a file tree at rest.
    expect(screen.queryByRole('button', { name: 'New file' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    expect(screen.getByRole('button', { name: 'New folder' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add from your computer' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New file' }));

    // No argument: the menu is a single footer button, not a per-row target,
    // so there is no folder for it to name (HIVE-148 review).
    expect(onNewFile).toHaveBeenCalledWith();
    // Closed again, rather than left open over the question it just raised.
    expect(screen.getByRole('button', { name: '+ Add' })).toBeInTheDocument();
  });

  it('opens main\'s picker rather than naming a source path', () => {
    const onImport = vi.fn();
    render(
      <SkillBundle {...props} skill={skill(manifest)} onImport={onImport} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Add from your computer' }),
    );

    expect(onImport).toHaveBeenCalledWith();
  });
});
