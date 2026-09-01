import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAgents } from '@/lib/agents';

import { AgentsSection } from '@features/settings/components/agents-section';

import { AGENT_NAME_POOL } from '@/lib/agents';

import { readSlackStatus } from '@lib/slack';

import type { AgentSummary } from '@shared/agent-contract';

/*
  R12: the brief's own test renders `<AgentsSection slack={…} agents={…} />`,
  but neither prop exists — `AgentsSection` reads `useAgents()` internally and
  is mounted from a bare component map with no props at all. It reads its own
  Slack status with `readSlackStatus()` in a mount effect instead, mirroring
  `slack-group.tsx`'s `useEffect`. So these tests mock `@lib/slack` (below)
  rather than passing a `slack` prop, and drive the agent roster through the
  same `stub()`/`window.hive` bridge every other test in this file already
  uses, rather than a second, competing mock of `@hooks/use-agents`.
*/
vi.mock('@lib/slack', () => ({
  readSlackStatus: vi.fn(async () => null),
}));

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
  mcp: [],
  tools: [],
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
  vi.mocked(readSlackStatus).mockResolvedValue(null);
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

  /*
    The waker landed in HIVE-117 and this button did not notice: it carried a
    literal `disabled` and a title reading "Agents do not run yet", on the one
    screen where a user has just finished configuring the agent.
  */
  describe('running from the editor', () => {
    const open = async (over: Record<string, unknown> = {}) => {
      const bridge = stub([agent('slack-watcher')], over);
      render(<AgentsSection />);

      await userEvent.click(
        await screen.findByRole('button', { name: /slack-watcher/ }),
      );
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());

      return bridge;
    };

    it('wakes the open agent by name', async () => {
      const run = vi.fn(async () => ({ started: true, run: 'r1' }));
      await open({ run });

      await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

      await waitFor(() =>
        expect(run).toHaveBeenCalledWith({ name: 'slack-watcher' }),
      );
    });

    /*
      The refusals only main knows — already working, paused, runtime down.
    */
    it('says why a refused run did not happen', async () => {
      const run = vi.fn(async () => ({ started: false, refused: 'paused' }));
      await open({ run });

      await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

      expect(
        await screen.findByText(/slack-watcher is paused/),
      ).toBeInTheDocument();
    });

    /**
     * A refusal must not disable the control that produced it.
     *
     * This reported through `problems` first, which is simultaneously why Save
     * refuses and the third gate in the editor's `cannotRun` — so the message
     * "slack-watcher is working" disabled Run now and relabelled it "this
     * definition cannot be read", which was false: the definition parsed, which
     * is why the call reached main at all. Escaping needed a reselect or a
     * no-op Save.
     *
     * Every refusal on this path is transient. `working` ends, `paused` is one
     * click away, and `unknown` is the runtime still coming up — the case where
     * retrying is *most* likely to work.
     */
    it('stays clickable after a refusal, so the retry is one click', async () => {
      const run = vi
        .fn()
        .mockResolvedValueOnce({ started: false, refused: 'working' })
        .mockResolvedValueOnce({ started: true, run: 'r2' });

      await open({ run });

      const button = screen.getByRole('button', { name: 'Run now' });

      await userEvent.click(button);
      expect(
        await screen.findByText(/slack-watcher is working/),
      ).toBeInTheDocument();

      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute(
        'title',
        expect.stringMatching(/cannot be read/i),
      );

      await userEvent.click(button);

      expect(run).toHaveBeenCalledTimes(2);
      expect(await screen.findByText('woke slack-watcher')).toBeInTheDocument();
    });

    /*
      Cleared when the pane changes what it is looking at, so a message about
      one agent is never read as being about the next.
    */
    it('drops the notice when another agent is opened', async () => {
      const run = vi.fn(async () => ({ started: false, refused: 'paused' }));
      const bridge = stub([agent('slack-watcher'), agent('other')], { run });
      render(<AgentsSection />);

      await userEvent.click(
        await screen.findByRole('button', { name: /slack-watcher/ }),
      );
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());
      await userEvent.click(screen.getByRole('button', { name: 'Run now' }));
      await screen.findByText(/slack-watcher is paused/);

      await userEvent.click(row('other'));

      await waitFor(() =>
        expect(screen.queryByText(/slack-watcher is paused/)).toBeNull(),
      );
    });

    /*
      A wake reads AGENT.md off disk, so running with unsaved edits would
      execute the previous version while the screen shows the new one.
    */
    it('refuses while the buffer is unsaved, and says so', async () => {
      const run = vi.fn(async () => ({ started: true, run: 'r1' }));
      await open({ run });

      await userEvent.click(await screen.findByRole('tab', { name: 'Source' }));
      await userEvent.type(
        screen.getByRole('textbox', { name: 'Agent source' }),
        'x',
      );

      const button = screen.getByRole('button', { name: 'Run now' });

      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', expect.stringMatching(/save first/i));

      await userEvent.click(button);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('the Slack watcher example (HIVE-123)', () => {
    it('is hidden when slack is not connected', async () => {
      vi.mocked(readSlackStatus).mockResolvedValue({ kind: 'not-added' });
      stub([]);
      render(<AgentsSection />);

      await screen.findByRole('button', { name: '+ New agent' });

      expect(
        screen.queryByRole('button', { name: /Slack watcher/ }),
      ).not.toBeInTheDocument();
    });

    it('appears once slack is connected and no slack-watcher agent exists', async () => {
      vi.mocked(readSlackStatus).mockResolvedValue({ kind: 'connected' });
      stub([]);
      render(<AgentsSection />);

      expect(
        await screen.findByRole('button', { name: /Slack watcher/ }),
      ).toBeInTheDocument();
    });

    it('is hidden again once an agent named slack-watcher already exists', async () => {
      vi.mocked(readSlackStatus).mockResolvedValue({ kind: 'connected' });
      stub([agent('slack-watcher')]);
      render(<AgentsSection />);

      await screen.findByText('slack-watcher');

      expect(
        screen.queryByRole('button', { name: /Slack watcher/ }),
      ).not.toBeInTheDocument();
    });

    it('the example grants the slack tools it needs, not just the server', async () => {
      vi.mocked(readSlackStatus).mockResolvedValue({ kind: 'connected' });
      stub([]);
      render(<AgentsSection />);

      await userEvent.click(
        await screen.findByRole('button', { name: /Slack watcher/ }),
      );
      await userEvent.click(await screen.findByRole('tab', { name: 'Source' }));

      const buffer = screen.getByRole('textbox', {
        name: 'Agent source',
      }) as HTMLTextAreaElement;

      expect(buffer.value).toEqual(expect.stringContaining('mcp: [slack]'));
      expect(buffer.value).toEqual(expect.stringContaining('mcp__slack__*'));
      expect(buffer.value).toEqual(expect.stringContaining('check: always'));
    });

    it('names the watched agent slack-watcher, ready to save as-is', async () => {
      vi.mocked(readSlackStatus).mockResolvedValue({ kind: 'connected' });
      stub([]);
      render(<AgentsSection />);

      await userEvent.click(
        await screen.findByRole('button', { name: /Slack watcher/ }),
      );

      const name = await screen.findByRole('textbox', { name: 'name' });
      expect((name as HTMLInputElement).value).toBe('slack-watcher');
      expect(
        screen.queryByText('You already have an agent called slack-watcher.'),
      ).not.toBeInTheDocument();
    });

    it('goes through the same unsaved-changes guard as New agent', async () => {
      vi.mocked(readSlackStatus).mockResolvedValue({ kind: 'connected' });
      const bridge = stub([agent('other')]);
      render(<AgentsSection />);

      await userEvent.click(await screen.findByRole('button', { name: /other/ }));
      await waitFor(() => expect(bridge.read).toHaveBeenCalled());
      await userEvent.click(await screen.findByRole('tab', { name: 'Source' }));
      await userEvent.type(
        screen.getByRole('textbox', { name: 'Agent source' }),
        'x',
      );

      await userEvent.click(
        await screen.findByRole('button', { name: /Slack watcher/ }),
      );

      expect(
        await screen.findByText('Discard changes to other?'),
      ).toBeInTheDocument();
    });
  });
});
