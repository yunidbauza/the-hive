import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TitleBar } from '@components/layout/title-bar';
import { TITLEBAR_HEIGHT } from '@shared/window';

/**
 * The window-controls row.
 *
 * Two things are worth pinning and neither is cosmetic: the strip must not
 * appear on a target that has no floating traffic lights, and its height must
 * come from the same constant the main process positions the lights against.
 * Both failures look like a rendering bug and are actually a geometry one.
 */

/** Pretend the bridge is there, which is how `isDesktop()` answers. */
function asDesktop(): void {
  (window as { hive?: unknown }).hive = { appInfo: () => Promise.resolve({}) };
}

function asMac(mac: boolean): void {
  vi.stubGlobal('navigator', { userAgentData: { platform: mac ? 'macOS' : 'Windows' } });
}

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
  vi.unstubAllGlobals();
});

describe('TitleBar', () => {
  it('renders the strip on desktop macOS', () => {
    asDesktop();
    asMac(true);

    render(<TitleBar />);

    expect(screen.getByTestId('title-bar')).toBeInTheDocument();
  });

  it('is exactly as tall as the constant the traffic lights are placed against', () => {
    asDesktop();
    asMac(true);

    render(<TitleBar />);

    /**
     * The assertion that stops the lights straddling the border. The main
     * process derives `TRAFFIC_LIGHT_POSITION.y` from this same number, so a
     * hard-coded Tailwind height here would be a second literal free to drift.
     */
    expect(screen.getByTestId('title-bar')).toHaveStyle({
      height: `${TITLEBAR_HEIGHT}px`,
    });
  });

  it('is the window’s drag region', () => {
    asDesktop();
    asMac(true);

    render(<TitleBar />);

    // The strip's entire functional content: without it the row is dead space.
    expect(screen.getByTestId('title-bar')).toHaveClass(
      '[-webkit-app-region:drag]',
    );
  });

  it('renders nothing off macOS, where the frame is native', () => {
    // Electron ignores `hiddenInset` on Windows and Linux and draws a real
    // title bar. A second, empty bar under it would be the regression.
    asDesktop();
    asMac(false);

    const { container } = render(<TitleBar />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing in the browser, which has no window controls', () => {
    // Both halves of the guard matter: `isDesktop()` alone would put an empty
    // 32px band at the top of the demo surface on any Mac.
    asMac(true);

    const { container } = render(<TitleBar />);

    expect(container).toBeEmptyDOMElement();
  });
});
