import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SkillEditor } from '@features/settings/components/skill-editor';

/**
 * The editor half of Settings › Skills (HIVE-96, HIVE-148).
 *
 * CodeMirror is deliberately **not** mocked here, for the reason `AGENTS.md`
 * gives: it renders without measuring first, so `.cm-content` really holds the
 * text and an assertion about it is about the real editor. That is what makes
 * "the surface is mounted" and "the surface is replaced by a refusal" two
 * distinguishable facts rather than two spellings of the same mock.
 */

const props = {
  path: '/home/u/.hive/skills/graphify/SKILL.md',
  body: 'hello',
  dirty: false,
  problem: null,
  onChange: vi.fn(),
  onSave: vi.fn(),
  onDelete: vi.fn(),
};

describe('SkillEditor', () => {
  it('mounts the editor for a file it can render', () => {
    render(<SkillEditor {...props} refused={null} size={5} />);

    expect(screen.getByLabelText('Skill source')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('shows a font as a refusal, not as mojibake, and still offers Delete', () => {
    render(
      <SkillEditor
        {...props}
        path="/home/u/.hive/skills/graphify/assets/Inter.ttf"
        body=""
        refused="binary"
        size={412_000}
      />,
    );

    expect(screen.getByText('This file is not text.')).toBeInTheDocument();
    // The size is the fact that makes the row actionable — it is why the file
    // is there and what deleting it would recover.
    expect(screen.getByText(/412 KB/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    // Not disabled — absent. A disabled Save invites a hunt for the reason.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByLabelText('Skill source')).toBeNull();
  });

  it('distinguishes too-large from not-text', () => {
    render(
      <SkillEditor {...props} body="" refused="too-large" size={7_400_000} />,
    );

    expect(
      screen.getByText('This file is too large to show here.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/7\.4 MB/)).toBeInTheDocument();
  });

  it('says the refused file still ships, rather than showing the naming rule', () => {
    render(<SkillEditor {...props} body="" refused="binary" size={100} />);

    /*
      The footer's usual job is the frontmatter naming rule, which is about a
      SKILL.md and means nothing beside a font. What a user needs to know here
      is that the file is not broken — it reaches the session exactly as it is.
    */
    expect(screen.getByText(/Delivered to every session/)).toBeInTheDocument();
    expect(screen.queryByText(/names the folder and the command/)).toBeNull();
  });

  it('still deletes a refused file', () => {
    const onDelete = vi.fn();
    render(
      <SkillEditor
        {...props}
        body=""
        refused="binary"
        size={100}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onDelete).toHaveBeenCalled();
  });
});
