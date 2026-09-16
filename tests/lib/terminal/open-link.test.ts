import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTerminalLinkHandler,
  handleWebLink,
  openTerminalLink,
  terminalLinkHandler,
} from '@lib/terminal/open-link';

/**
 * One claim, asserted three ways: **the URL is the first argument**.
 *
 * That reads like a tautology and is not. The bug this module fixes is xterm's
 * shipped handler calling `window.open()` with *nothing* and assigning
 * `location.href` to the result — a defence against reverse tabnabbing that
 * predates `noopener`, and one this app cannot support because main denies
 * every `window.open` and re-routes the URL it was given. Given `about:blank`,
 * it has nothing to route.
 *
 * So every test here checks the argument, not the effect. What happens after
 * main receives the URL is `electron/main/external-links.ts`'s business and has
 * its own tests.
 */
describe('openTerminalLink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const spy = () =>
    vi.spyOn(window, 'open').mockReturnValue(null as unknown as Window);

  it('opens the url itself, not a blank window', () => {
    const open = spy();

    openTerminalLink('https://example.com/path?q=1');

    expect(open).toHaveBeenCalledWith(
      'https://example.com/path?q=1',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('asks for noopener and noreferrer', () => {
    const open = spy();

    openTerminalLink('https://example.com');

    // What the blank-window dance existed to achieve, done declaratively.
    expect(open.mock.calls[0]?.[2]).toBe('noopener,noreferrer');
  });

  it('does not vet the scheme — main is the only side that may', () => {
    const open = spy();

    openTerminalLink('file:///etc/passwd');

    /*
      Deliberate. A second allowlist in the renderer is a second definition of
      "safe", and two definitions drift. `isSafeExternalUrl` in main refuses
      this, which is asserted where that function lives; duplicating the
      judgement here would mean a future widening of one had to be remembered
      in the other.
    */
    expect(open).toHaveBeenCalledWith(
      'file:///etc/passwd',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('ignores the mouse event the addon hands it', () => {
    const open = spy();

    handleWebLink(new MouseEvent('click'), 'https://example.com/a');

    expect(open).toHaveBeenCalledWith(
      'https://example.com/a',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('opens an OSC 8 hyperlink through the same call', () => {
    const open = spy();

    terminalLinkHandler.activate(
      new MouseEvent('click'),
      'https://claude.ai/code/artifact/dd055a06',
    );

    // Same arguments as the plain-text path: one behaviour, two entry points.
    expect(open).toHaveBeenCalledWith(
      'https://claude.ai/code/artifact/dd055a06',
      '_blank',
      'noopener,noreferrer',
    );
  });
});

/**
 * The scheme split.
 *
 * `file://` is a path the emitting program chose to mark up explicitly, so it
 * takes the road a printed path takes — the resolver, then the editor — and
 * never `window.open`, which main would refuse anyway: its allowlist is
 * `http:`/`https:`, so a `file://` link was previously detected, underlined,
 * and dead on click exactly as the bare-URL bug above.
 */
describe('createTerminalLinkHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const spy = () =>
    vi.spyOn(window, 'open').mockReturnValue(null as unknown as Window);

  it('hands a file:// link to the file opener and never to the browser', () => {
    const open = spy();
    const openFile = vi.fn();

    createTerminalLinkHandler(openFile).activate(
      new MouseEvent('click'),
      'file:///Users/me/a.ts',
    );

    expect(openFile).toHaveBeenCalledWith('/Users/me/a.ts');
    expect(open).not.toHaveBeenCalled();
  });

  it('hands everything else to the browser, as before', () => {
    const open = spy();
    const openFile = vi.fn();

    createTerminalLinkHandler(openFile).activate(
      new MouseEvent('click'),
      'https://claude.ai/x',
    );

    expect(open).toHaveBeenCalledWith(
      'https://claude.ai/x',
      '_blank',
      'noopener,noreferrer',
    );
    expect(openFile).not.toHaveBeenCalled();
  });

  it('a file:// link naming another host opens nothing at all', () => {
    const open = spy();
    const openFile = vi.fn();

    createTerminalLinkHandler(openFile).activate(
      new MouseEvent('click'),
      'file://server/a.ts',
    );

    expect(open).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });
});
