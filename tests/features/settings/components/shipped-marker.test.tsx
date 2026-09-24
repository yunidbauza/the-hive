import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  HeldBanner,
  ShippedDot,
  ShippedStrip,
} from '@features/settings/components/shipped-marker';

import { shippedStatus } from '../../../support/shipped';

/**
 * The three marks a shipped agent or skill the user changed carries: a dot in
 * the list, a strip over the editor with Reset to shipped, and a banner only
 * when a newer shipped prompt is being held back.
 */

const customised = shippedStatus({
  customised: [
    { path: 'limits.parallel', yours: '5', shipped: '2' },
    { path: 'tools', yours: '[Read, SendMessage]', shipped: '[Read]' },
  ],
});
const held = shippedStatus({ name: 'fixer', bodyEdited: true, held: true, shippedBody: 'New prompt.\n' });

describe('ShippedDot', () => {
  it('draws nothing for an agent as shipped', () => {
    const { container } = render(<ShippedDot status={undefined} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('says which mark it is, brand for settings and amber for a held prompt', () => {
    render(
      <>
        <ShippedDot status={customised} />
        <ShippedDot status={held} />
      </>,
    );

    expect(screen.getByLabelText('Changed from the shipped version')).toHaveClass('bg-brand');
    expect(screen.getByLabelText('A newer shipped prompt is waiting')).toHaveClass('bg-amber');
  });
});

describe('ShippedStrip', () => {
  it('names the changed settings, and that the prompt still follows updates', () => {
    render(<ShippedStrip status={customised} onReset={vi.fn()} onKeepMine={vi.fn()} />);

    expect(screen.getByText(/2 settings differ from shipped: limits\.parallel, tools\./)).toBeInTheDocument();
    expect(screen.getByText(/The prompt follows updates\./)).toBeInTheDocument();
  });

  it('says when the prompt is the user\'s, and names edited skill files', () => {
    render(
      <ShippedStrip
        status={shippedStatus({ kind: 'skills', bodyEdited: true, files: ['prompts/x.md'] })}
        onReset={vi.fn()}
        onKeepMine={vi.fn()}
      />,
    );

    expect(screen.getByText(/Your prompt\./)).toBeInTheDocument();
    expect(screen.getByText(/Edited files: prompts\/x\.md\./)).toBeInTheDocument();
  });

  it('confirms a reset first, listing exactly what is lost', async () => {
    const onReset = vi.fn();
    render(<ShippedStrip status={{ ...customised, bodyEdited: true }} onReset={onReset} onKeepMine={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Reset to shipped' }));

    expect(onReset).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('limits.parallel: 5 → 2');
    expect(confirm).toHaveTextContent('tools: [Read, SendMessage] → [Read]');
    expect(confirm).toHaveTextContent('your prompt edits');

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('backs out of a reset without calling it', async () => {
    const onReset = vi.fn();
    render(<ShippedStrip status={customised} onReset={onReset} onKeepMine={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Reset to shipped' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(onReset).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('flags a setting whose shipped value moved, and offers to keep it', async () => {
    const onKeepMine = vi.fn();
    render(
      <ShippedStrip
        status={shippedStatus({ customised: [{ path: 'model', yours: 'haiku', shipped: 'sonnet' }], moved: ['model'] })}
        onReset={vi.fn()}
        onKeepMine={onKeepMine}
      />,
    );

    expect(screen.getByText(/Shipped value moved: model\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(onKeepMine).toHaveBeenCalledTimes(1);
  });

  it('draws nothing for an agent as shipped', () => {
    const { container } = render(
      <ShippedStrip status={undefined} onReset={vi.fn()} onKeepMine={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe('HeldBanner', () => {
  it('draws nothing unless a prompt is held', () => {
    const { container } = render(
      <HeldBanner status={customised} onTake={vi.fn()} onKeep={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('says what holding costs, and shows the shipped prompt on Compare', async () => {
    render(<HeldBanner status={held} onTake={vi.fn()} onKeep={vi.fn()} />);

    expect(screen.getByText(/fixer runs your version/)).toBeInTheDocument();
    expect(screen.queryByText('New prompt.')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Compare' }));

    expect(screen.getByText('New prompt.')).toBeInTheDocument();
  });

  it('takes the shipped prompt or keeps the user\'s', async () => {
    const onTake = vi.fn();
    const onKeep = vi.fn();
    render(<HeldBanner status={held} onTake={onTake} onKeep={onKeep} />);

    await userEvent.click(screen.getByRole('button', { name: 'Take shipped prompt' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }));

    expect(onTake).toHaveBeenCalledTimes(1);
    expect(onKeep).toHaveBeenCalledTimes(1);
  });
});
