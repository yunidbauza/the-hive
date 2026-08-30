import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAgents } from '@/lib/agents';

import { AgentsSection } from '@features/settings/components/agents-section';

import { AGENT_NAME_POOL } from '@/lib/agents';

import type { AgentSummary } from '@shared/agent-contract';

const GOOD = `---
name: slack-watcher
description: Watches things.
icon: Ghost
---
Do the job.
`;

const agent = (name: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
  name,
  description: `${name} watches things`,
  icon: 'Ghost',
  status: 'sleeping',
  wake: { on: [] },
  rotateAfter: 50,
  runs: [],
  ...over,
});

const stub = (agents: AgentSummary[], over: Record<string, unknown> = {}) => {
  const bridge = {
    list: vi.fn(async () => ({ agents, agentsRoot: '/root/agents' })),
    read: vi.fn(async () => GOOD),
    write: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => ({ ok: true })),
    onChanged: vi.fn(() => () => {}),
    ...over,
  };

  (window as unknown as { hive?: unknown }).hive = { agents: bridge };

  return bridge;
};

const row = (name: string) => screen.getByRole('button', { name: new RegExp(name) });

beforeEach(() => {
  delete (window as unknown as { hive?: unknown }).hive;
  resetAgents();
  vi.restoreAllMocks();
});

describe('AgentsSection', () => {
  it('renders header-only without a bridge, which is the browser demo', () => {
    render(<AgentsSection />);

    expect(
      screen.getByText(/only available in the desktop app/i),
    ).toBeInTheDocument();
  });

  it('invites a first agent when the folder is empty', async () => {
    stub([]);
    render(<AgentsSection />);

    await screen.findByRole('button', { name: '+ New agent' });

    expect(screen.getByText(/Agents folder: \/root\/agents/)).toBeInTheDocument();
  });

  it('lists an agent with its state', async () => {
    stub([agent('slack-watcher')]);
    render(<AgentsSection />);

    expect(await screen.findByText('slack-watcher')).toBeInTheDocument();
    expect(screen.getByText('sleeping')).toBeInTheDocument();
  });

  it('names the agents folder', async () => {
    stub([agent('slack-watcher')]);
    render(<AgentsSection />);

    expect(
      await screen.findByText('Agents folder: /root/agents'),
    ).toBeInTheDocument();
  });

  describe('a broken definition', () => {
    it('is marked invalid', async () => {
      stub([agent('broken', { invalid: 'nope: Unknown key.' })]);
      render(<AgentsSection />);

      expect(await screen.findByText('invalid')).toBeInTheDocument();
    });

    it('can still be opened, so the user can fix it', async () => {
      // Unlike an invalid skill's row, which is disabled: an agent's folder
      // names it, so there is always a file to open.
      stub([agent('broken', { invalid: 'nope: Unknown key.' })]);
      render(<AgentsSection />);

      const target = await screen.findByRole('button', { name: /broken/ });

      expect(target).toBeEnabled();

      await userEvent.click(target);

      expect(
        await screen.findByRole('tab', { name: 'Source' }),
      ).toBeInTheDocument();
    });
  });

  describe('opening and editing', () => {
    it('loads the source into the editor', async () => {
      stub([agent('slack-watcher')]);
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /slack-watcher/ }));
      await userEvent.click(await screen.findByRole('tab', { name: 'Source' }));

      expect(screen.getByRole('textbox', { name: 'Agent source' })).toHaveValue(
        GOOD,
      );
    });

    it('marks the row edited once the buffer diverges', async () => {
      stub([agent('slack-watcher')]);
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /slack-watcher/ }));
      await userEvent.click(await screen.findByRole('tab', { name: 'Source' }));
      await userEvent.type(
        screen.getByRole('textbox', { name: 'Agent source' }),
        'x',
      );

      expect(await screen.findByText('edited')).toBeInTheDocument();
    });

    /*
      The template used to open with a blank `name:` and a red box telling the
      user to write one in the Source tab — the form had no name control at all,
      so the refusal was unanswerable from the form it appeared in. It opens
      named and editable instead.
    */
    it('starts a new agent already named, with no refusal to clear', async () => {
      stub([agent('slack-watcher')]);
      render(<AgentsSection />);

      await userEvent.click(
        await screen.findByRole('button', { name: '+ New agent' }),
      );

      const name = await screen.findByRole('textbox', { name: 'name' });

      expect(AGENT_NAME_POOL).toContain((name as HTMLInputElement).value);
      expect(
        screen.queryByText('Give the agent a name in its frontmatter.'),
      ).not.toBeInTheDocument();
    });

    it('never seeds a name the fleet already holds', async () => {
      // Everything but the last roster name is taken, so only one is free.
      stub(AGENT_NAME_POOL.slice(0, -1).map((name) => agent(name)));
      render(<AgentsSection />);

      await userEvent.click(
        await screen.findAllByRole('button', { name: '+ New agent' }).then((all) => all[0] as HTMLElement),
      );

      expect(await screen.findByRole('textbox', { name: 'name' })).toHaveValue(
        AGENT_NAME_POOL.at(-1) as string,
      );
    });

    /*
      `taken` excludes the currently open agent so its own name does not read as
      a duplicate of itself. Seeding the template from that same list could draw
      the open agent's name, producing a brand-new agent that arrives already
      refused — the exact state the name field exists to make unreachable.
    */
    it('never seeds the name of the agent that was open', async () => {
      // Only one roster name is free, and the other ten are all held — one of
      // them by the agent being viewed when New agent is clicked.
      const held = AGENT_NAME_POOL.slice(0, -1);

      stub(held.map((name) => agent(name)));
      render(<AgentsSection />);

      await userEvent.click(
        await screen.findByRole('button', { name: new RegExp(held[0] as string) }),
      );
      await userEvent.click(
        screen.getByRole('button', { name: '+ New agent' }),
      );

      expect(await screen.findByRole('textbox', { name: 'name' })).toHaveValue(
        AGENT_NAME_POOL.at(-1) as string,
      );
      expect(
        screen.queryByText(/You already have an agent called/),
      ).not.toBeInTheDocument();
    });

    /*
      Two new agents in a row must not collide. The second is seeded from a
      fleet that now contains the first, which is the whole reason the template
      is a function of `taken` rather than a constant.
    */
    it('gives two consecutive new agents distinct names', async () => {
      stub([agent('slack-watcher')]);
      render(<AgentsSection />);

      await userEvent.click(
        await screen.findByRole('button', { name: '+ New agent' }),
      );
      const firstName = (
        (await screen.findByRole('textbox', { name: 'name' })) as HTMLInputElement
      ).value;

      // The first one is saved, so the fleet now holds it. Remount against
      // that fleet, which is what the pane sees on the next visit.
      cleanup();
      resetAgents();
      stub([agent('slack-watcher'), agent(firstName)]);
      render(<AgentsSection />);

      await userEvent.click(
        await screen.findByRole('button', { name: '+ New agent' }),
      );

      expect(
        await screen.findByRole('textbox', { name: 'name' }),
      ).not.toHaveValue(firstName);
    });
  });

  describe('saving', () => {
    it('writes the buffer under the name its frontmatter declares', async () => {
      const bridge = stub([agent('slack-watcher')]);
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /slack-watcher/ }));
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(bridge.write).toHaveBeenCalledWith({
          name: 'slack-watcher',
          source: GOOD,
        }),
      );
    });

    it('shows a refusal beside the field it names, and does not claim success', async () => {
      const bridge = stub([agent('slack-watcher')], {
        write: vi.fn(async () => ({
          ok: false,
          problems: [
            { field: 'wake.every', reason: 'Cannot be faster than 1m.' },
          ],
        })),
      });
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /slack-watcher/ }));
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(
        await screen.findByText('Cannot be faster than 1m.'),
      ).toBeInTheDocument();
    });

    it('renames in one call, carrying the buffer being saved', async () => {
      /*
        The buffer travels with the move, so the definition validated is the
        one about to be written. Moving first and writing after validated the
        *stale* file — which refused a rename that also fixed a broken key,
        with problems the user had already resolved.
      */
      const bridge = stub([agent('slack-watcher')]);
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /slack-watcher/ }));
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());
      await userEvent.click(await screen.findByRole('tab', { name: 'Source' }));

      const renamed = GOOD.replace('slack-watcher', 'slack-bot');
      const box = screen.getByRole('textbox', { name: 'Agent source' });
      await userEvent.clear(box);
      await userEvent.type(box, renamed);
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(bridge.rename).toHaveBeenCalledWith({
          from: 'slack-watcher',
          to: 'slack-bot',
          source: renamed,
        }),
      );
      // One call, not a move followed by a write.
      expect(bridge.write).not.toHaveBeenCalled();
    });

    it('does not write when the rename is refused', async () => {
      const bridge = stub([agent('slack-watcher')], {
        rename: vi.fn(async () => ({
          ok: false,
          problems: [{ field: 'name', reason: 'slack-bot already exists.' }],
        })),
      });
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /slack-watcher/ }));
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());
      await userEvent.click(await screen.findByRole('tab', { name: 'Source' }));

      const box = screen.getByRole('textbox', { name: 'Agent source' });
      await userEvent.clear(box);
      await userEvent.type(box, GOOD.replace('slack-watcher', 'slack-bot'));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(
        await screen.findByText('slack-bot already exists.'),
      ).toBeInTheDocument();
      expect(bridge.write).not.toHaveBeenCalled();
    });

    it('refuses a name that collides with another agent', async () => {
      const bridge = stub([agent('slack-watcher'), agent('taken')]);
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /slack-watcher/ }));
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());
      await userEvent.click(await screen.findByRole('tab', { name: 'Source' }));

      const box = screen.getByRole('textbox', { name: 'Agent source' });
      await userEvent.clear(box);
      await userEvent.type(box, GOOD.replace('slack-watcher', 'taken'));

      expect(
        await screen.findByText('You already have an agent called taken.'),
      ).toBeInTheDocument();
    });

    it('refuses a reserved name before asking main', async () => {
      const bridge = stub([agent('slack-watcher')]);
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /slack-watcher/ }));
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());
      await userEvent.click(await screen.findByRole('tab', { name: 'Source' }));

      const box = screen.getByRole('textbox', { name: 'Agent source' });
      await userEvent.clear(box);
      await userEvent.type(box, GOOD.replace('slack-watcher', 'overmind'));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(
        await screen.findByText('"overmind" is reserved by The Hive.'),
      ).toBeInTheDocument();
      expect(bridge.write).not.toHaveBeenCalled();
    });
  });

  describe('discarding and deleting', () => {
    it('asks before abandoning an unsaved edit', async () => {
      const bridge = stub([agent('slack-watcher'), agent('other')]);
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /slack-watcher/ }));
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());
      await userEvent.click(await screen.findByRole('tab', { name: 'Source' }));
      await userEvent.type(
        screen.getByRole('textbox', { name: 'Agent source' }),
        'x',
      );
      await userEvent.click(row('other'));

      expect(
        await screen.findByText('Discard changes to slack-watcher?'),
      ).toBeInTheDocument();
    });

    it('asks before deleting, then removes the folder', async () => {
      const bridge = stub([agent('slack-watcher')]);
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /slack-watcher/ }));
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());
      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

      expect(await screen.findByText('Delete slack-watcher?')).toBeInTheDocument();

      // Two buttons say "Delete" now — the editor's and the confirm's. Scope to
      // the confirm, or the click lands back on the one that opened it.
      const confirm = screen.getByRole('alertdialog', {
        name: 'Delete slack-watcher?',
      });

      await userEvent.click(
        within(confirm).getByRole('button', { name: 'Delete' }),
      );

      await waitFor(() =>
        expect(bridge.remove).toHaveBeenCalledWith({ name: 'slack-watcher' }),
      );
    });
  });
});
