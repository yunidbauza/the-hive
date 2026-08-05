import { isDesktop } from '@config/runtime';
import { isMacPlatform } from '@lib/platform';
import { TITLEBAR_HEIGHT } from '@shared/window';

/**
 * The strip the window controls live in — nothing else.
 *
 * `titleBarStyle: 'hiddenInset'` (story 081) removes the native title bar and
 * floats the traffic lights over whatever the renderer paints at the top of the
 * content area. That used to be the 56px header, and the result was three
 * system buttons sitting immediately beside the wordmark: they read as part of
 * the brand cluster rather than as window chrome, and the header had to carry a
 * 78px inset to keep the logo out from under them.
 *
 * Giving them their own row fixes both. The header goes back to holding only
 * the app's own controls, and the inset disappears — the brand starts at the
 * same 16px the lights do.
 *
 * ## Why this renders nothing
 *
 * A drag region and 32px of panel is the entire component. The temptation is to
 * put the window title in it, which is what a native bar would have shown — but
 * the header directly below already says `The Hive`, and repeating it 32px
 * higher is two answers to one question. An empty strip is the honest shape of
 * "this row belongs to the OS".
 *
 * ## Why macOS only
 *
 * `hiddenInset` is a macOS style; Electron ignores it elsewhere and Windows and
 * Linux get the default frame, which already puts window controls in their own
 * row. Painting this strip there would add a second, empty bar under a real
 * one. The browser target has no window controls at all.
 *
 * So the strip is desktop-**and**-mac, and both halves matter: `isDesktop()`
 * alone would put an empty 32px band at the top of the demo surface on any Mac.
 */
export function TitleBar() {
  if (!isDesktop() || !isMacPlatform()) return null;

  return (
    <div
      /*
       * `-webkit-app-region: drag` is the whole functional content. The header
       * below keeps its own drag region — losing a second grab handle when the
       * window is busy would be a regression, and there is no cost to having
       * both.
       */
      className="shrink-0 border-b border-border-soft bg-panel [-webkit-app-region:drag]"
      /*
       * Height comes from the shared constant rather than a Tailwind class,
       * because the main process positions the traffic lights against the same
       * number (`TRAFFIC_LIGHT_POSITION`). Two independent literals would drift
       * and the lights would end up straddling the border.
       */
      style={{ height: TITLEBAR_HEIGHT }}
      data-testid="title-bar"
    />
  );
}
