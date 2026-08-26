import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NewProjectLink } from '@features/projects/components/new-project-link';

const chooseProjectDirectory = vi.fn();
const addProjectToConfig = vi.fn();

vi.mock('@lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/project-config')>();
  return {
    ...actual,
    chooseProjectDirectory: () => chooseProjectDirectory(),
    addProjectToConfig: (request: unknown) => addProjectToConfig(request),
  };
});

/**
 * Mapping a project from the rail, without a detour through Settings.
 *
 * The flow itself is `useAddProject`'s, and is asserted there. What this file
 * owes is the button: that the click reaches that flow, and that the visible
 * word is in the accessible name so a screen-reader user and a sighted user
 * are talking about the same control.
 */
describe('NewProjectLink', () => {
  beforeEach(() => {
    chooseProjectDirectory.mockReset();
    addProjectToConfig.mockReset();
    chooseProjectDirectory.mockResolvedValue(null);
    addProjectToConfig.mockResolvedValue(undefined);
  });

  it('maps the directory the user chooses', async () => {
    const user = userEvent.setup();
    chooseProjectDirectory.mockResolvedValue('/repos/nova-web');

    render(<NewProjectLink />);
    await user.click(screen.getByRole('button', { name: /new project/i }));

    await waitFor(() => {
      expect(addProjectToConfig).toHaveBeenCalledWith({
        path: '/repos/nova-web',
      });
    });
  });

  it('writes nothing when the dialog is cancelled', async () => {
    const user = userEvent.setup();
    chooseProjectDirectory.mockResolvedValue(null);

    render(<NewProjectLink />);
    await user.click(screen.getByRole('button', { name: /new project/i }));

    expect(addProjectToConfig).not.toHaveBeenCalled();
  });

  /**
   * Label in Name: the accessible name contains the visible text, so voice
   * control reaches this button by the word the user can read on it. It says
   * more than the visible text because a rail button reached out of context
   * has to name what kind of thing it adds.
   */
  it('keeps the visible word in the accessible name', () => {
    render(<NewProjectLink />);

    expect(
      screen.getByRole('button', { name: 'Add a new project' }),
    ).toHaveTextContent('new project');
  });

  /**
   * Two registers, one control. The border is the whole difference: same role,
   * same accessible name, same visible word — so nothing reached by name, by
   * voice or by a screen reader can tell the empty state's button from the
   * tree's ghost line, and nothing should, because they do the same thing.
   *
   * The `mb-2.5` is the other half of the pair: the panel's `gap-0.5` is the
   * rhythm between *rows*, and the line above the tree is not a row. What the
   * gap actually looks like is Playwright's to say; what is asserted here is
   * that the two registers stayed one control.
   */
  it('keeps the same control in both registers', () => {
    const { unmount } = render(<NewProjectLink />);

    const line = screen.getByRole('button', { name: 'Add a new project' });
    expect(line).toHaveTextContent('new project');
    expect(line.className).toContain('mb-2.5');
    expect(line.className).not.toContain('border');

    unmount();
    render(<NewProjectLink variant="cta" />);

    const cta = screen.getByRole('button', { name: 'Add a new project' });
    expect(cta).toHaveTextContent('new project');
    expect(cta.className).toContain('border-border');
  });

  it('cannot open a second dialog while one is open', async () => {
    const user = userEvent.setup();
    chooseProjectDirectory.mockReturnValue(new Promise<string | null>(() => {}));

    render(<NewProjectLink />);
    const button = screen.getByRole('button', { name: /new project/i });
    await user.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(chooseProjectDirectory).toHaveBeenCalledTimes(1);
  });
});
