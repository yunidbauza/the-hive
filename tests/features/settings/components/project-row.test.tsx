import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '@shared/config-contract';

import { ProjectRow } from '@features/settings/components/project-row';

import { testProjectKey } from '@tests/support/project-key';

/**
 * One row of the settings projects list (stories 101, 103).
 *
 * This file closes a mirror gap rather than opening one: `project-row.tsx` has
 * existed since story 101 with no test of its own, covered only indirectly
 * through the section. `app/AGENTS.md` requires `tests/` to mirror `src/` with
 * no exceptions, and story 103 lands the grip, the menu and the inline editor
 * on exactly this component.
 *
 * (`tests/features/projects/components/project-row.test.tsx` is a different
 * component — the left rail's row.)
 */
const entry = (over: Partial<ProjectConfig> & { id: string }): ProjectConfig => ({
  name: over.id,
  path: `/repos/${over.id}`,
  icon: 'ph-folder',
  origin: 'local',
  status: 'ok',
  key: testProjectKey(over.id),
  isRepo: true,
  ...over,
});

function setup(overrides: Partial<Parameters<typeof ProjectRow>[0]> = {}) {
  const props = {
    project: entry({ id: 'the-hive', name: 'The Hive' }),
    isDragging: false,
    onDragStart: vi.fn(),
    onDragEnter: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
    editor: null,
    keyEditor: null,
    menu: <button type="button">menu</button>,
    ...overrides,
  };
  render(
    <ul>
      <ProjectRow {...props} />
    </ul>,
  );
  return props;
}

describe('ProjectRow', () => {
  it('shows the display name over the resolved path', () => {
    setup();

    expect(screen.getByText('The Hive')).toBeInTheDocument();
    expect(screen.getByText('/repos/the-hive')).toBeInTheDocument();
  });

  /**
   * The hierarchy pass, in its quieter form.
   *
   * The icon and not the name: every row in this list *is* a project, so a
   * coloured name would be twelve lines of brand with nothing to separate them
   * from. The icon is enough to tie the list to the rail and to the picker,
   * which already drew its project icons this way.
   */
  it('paints the project icon brand, and leaves the name alone', () => {
    setup();

    const row = screen.getByText('The Hive').closest('li');

    expect(row?.querySelector('.text-brand')).not.toBeNull();
    expect(screen.getByText('The Hive').className).not.toContain('text-brand');
  });

  it('says so when the path could not be resolved', () => {
    setup({ project: entry({ id: 'gone', path: null, status: 'missing' }) });

    expect(screen.getByText('unresolved')).toBeInTheDocument();
  });

  it('tags a directory that is not a git repository', () => {
    setup({ project: entry({ id: 'scratch', isRepo: false }) });

    expect(screen.getByText('no git')).toBeInTheDocument();
  });

  it('does not tag a directory that is one', () => {
    setup();

    expect(screen.queryByText('no git')).not.toBeInTheDocument();
  });

  it('renders the menu it is given', () => {
    setup();

    expect(screen.getByRole('button', { name: 'menu' })).toBeInTheDocument();
  });

  it('shows the editor in place of the name while renaming', () => {
    setup({ editor: <input aria-label="Project name" defaultValue="The Hive" /> });

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    // The name is now the input's value, not a label beside it.
    expect(screen.queryByText('The Hive')).not.toBeInTheDocument();
    // The path stays visible — it is the thing that identifies the row while
    // its name is being edited.
    expect(screen.getByText('/repos/the-hive')).toBeInTheDocument();
  });

  it('is draggable and reports the drag events the list needs', () => {
    const props = setup();
    const row = screen.getByRole('listitem');

    expect(row).toHaveAttribute('draggable', 'true');

    fireEvent.dragStart(row);
    expect(props.onDragStart).toHaveBeenCalledTimes(1);

    fireEvent.dragEnter(row);
    expect(props.onDragEnter).toHaveBeenCalledTimes(1);

    fireEvent.drop(row);
    expect(props.onDrop).toHaveBeenCalledTimes(1);

    fireEvent.dragEnd(row);
    expect(props.onDragEnd).toHaveBeenCalledTimes(1);
  });

  /**
   * The HTML drag-and-drop model needs `preventDefault` on **both** to declare
   * a drop target. With it on `dragover` alone the row still highlighted and
   * `dragenter` still fired, but the browser never sent `dragover` here, so
   * `drop` never arrived and every drag ended as if abandoned — which is
   * exactly how this shipped until the e2e caught it.
   */
  it.each(['dragenter', 'dragover'])(
    'accepts a drop by preventing the %s default',
    (type) => {
      setup();
      const row = screen.getByRole('listitem');

      const event = new Event(type, { bubbles: true, cancelable: true });
      fireEvent(row, event);

      expect(event.defaultPrevented).toBe(true);
    },
  );

  it('dims itself while it is the row being dragged', () => {
    setup({ isDragging: true });

    expect(screen.getByRole('listitem').className).toContain('opacity-45');
  });
});

/**
 * The key chip (HIVE-94).
 *
 * Visible at rest, and between the icon and the name. Both halves matter: a key
 * is only worth having if it can be read off the list and typed, so a chip
 * revealed on hover — the way the grip is — would defeat the point.
 */
describe('ProjectRow · the key chip', () => {
  it('shows the key without hovering', () => {
    setup({ project: entry({ id: 'the-hive', name: 'The Hive', key: 'hive' }) });

    expect(screen.getByText('hive')).toBeInTheDocument();
  });

  it('explains what the key is for', () => {
    setup({ project: entry({ id: 'the-hive', key: 'hive' }) });

    expect(screen.getByText('hive')).toHaveAttribute(
      'title',
      'type "hive" wherever a project is asked for',
    );
  });

  it('places the key between the icon and the name', () => {
    setup({ project: entry({ id: 'the-hive', name: 'The Hive', key: 'hive' }) });

    const row = screen.getByRole('listitem');
    expect(row.textContent?.indexOf('hive')).toBeLessThan(
      row.textContent?.indexOf('The Hive') ?? -1,
    );
  });

  /*
    The chip is what the key editor replaces, so the row must give up its space
    rather than render both — otherwise the key appears twice mid-edit.
  */
  it('gives way to the key editor when one is supplied', () => {
    setup({
      project: entry({ id: 'the-hive', key: 'hive' }),
      keyEditor: <input aria-label="Project key" defaultValue="hive" />,
    });

    expect(screen.getByRole('textbox', { name: 'Project key' })).toBeInTheDocument();
    expect(screen.queryByTitle(/wherever a project is asked for/)).toBeNull();
  });
});
