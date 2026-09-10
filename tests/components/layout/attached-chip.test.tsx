import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AttachedChip } from '@components/layout/attached-chip';
import type { RemoteLinkStatus } from '@shared/ipc-contract';

vi.mock('@stores/hive-store', () => ({ useRemoteLink: vi.fn() }));
import { useRemoteLink } from '@stores/hive-store';

const link = (over: Partial<RemoteLinkStatus> = {}): RemoteLinkStatus => ({
  state: 'attached',
  serverName: 'mini',
  attempt: 0,
  nextAttemptAt: null,
  reason: null,
  epoch: 0,
  ...over,
});

/** Installs a link status as the pushed one, or `null` for no attachment. */
const showing = (status: RemoteLinkStatus | null): void => {
  vi.mocked(useRemoteLink).mockReturnValue(status);
};

describe('AttachedChip', () => {
  /*
    A positive control, run first and asserted independently: this proves the
    query below actually finds the chip when there is a link, so the "renders
    nothing" test's own empty assertion cannot be passing for the wrong reason
    (a thrown render, a mis-mocked hook, a typo in the query).
  */
  it('names the server it is attached to', () => {
    showing(link());

    render(<AttachedChip />);

    expect(screen.getByText('attached · mini')).toBeInTheDocument();
  });

  it('renders nothing in local mode', () => {
    showing(null);

    const { container } = render(<AttachedChip />);

    expect(container).toBeEmptyDOMElement();
    // Restated against the exact text the positive control above proved this
    // same query can find, rather than only the coarser `toBeEmptyDOMElement`
    // — belt and braces against a future sibling being added to this chip
    // that would make the container non-empty for an unrelated reason while
    // this specific string still correctly never appears.
    expect(screen.queryByText('attached · mini')).not.toBeInTheDocument();
  });

  it('names where the socket goes', () => {
    showing(link());
    render(<AttachedChip />);
    expect(screen.getByTitle(/attached to mini over a socket/)).toBeInTheDocument();
  });

  /*
    A healthy attachment is as deliberate as serving, so it keeps the brand
    token `ServingChip` uses; amber stays `ExposureChip`'s signal for
    accidental exposure. Without this assertion, dropping the prop passes every
    other test here, since none of the others look past the text and title.
  */
  it('uses the brand token while it holds — this attachment is on purpose', () => {
    showing(link());
    render(<AttachedChip />);
    expect(screen.getByText('attached · mini')).toHaveClass('text-brand');
  });

  /**
   * The three states this chip exists to tell apart (HIVE-150).
   *
   * Before it had them, a socket that died left the chip reading
   * "attached · mini" for as long as the window stayed open, while every call
   * behind it rejected into a swallowed `console.error`.
   */
  describe('once the link stops holding', () => {
    it('goes amber while it is being rebuilt', () => {
      showing(link({ state: 'reconnecting', attempt: 3 }));

      render(<AttachedChip />);

      const chip = screen.getByText('reconnecting · mini');
      expect(chip).toBeInTheDocument();
      /*
        Amber, overruling this component's own earlier "brand, not amber" rule.
        That rule was about a *healthy* attachment, and it still governs the
        case above; a link that has dropped is the design system's "waiting".
      */
      expect(chip).toHaveClass('text-amber');
    });

    it('goes red once it is given up, and says why', () => {
      showing(
        link({ state: 'disconnected', reason: 'That device was revoked.' }),
      );

      render(<AttachedChip />);

      const chip = screen.getByText('disconnected · mini');
      expect(chip).toHaveClass('text-red');
      /*
        Red rather than a second shade of amber, because "still trying" versus
        "stopped trying" is the one thing a user needs from this chip before
        deciding whether to wait or to work locally.
      */
      expect(screen.getByTitle(/That device was revoked\./)).toBeInTheDocument();
    });

    it('still names the machine it lost', () => {
      showing(link({ state: 'disconnected', reason: null }));

      render(<AttachedChip />);

      /*
        The name rides on every status for exactly this: by the time the link is
        given up, the client that could answer `serverName()` is gone, and a
        chip that said only "disconnected" would leave the user guessing which
        of their machines had stopped answering.
      */
      expect(screen.getByText('disconnected · mini')).toBeInTheDocument();
    });
  });
});
