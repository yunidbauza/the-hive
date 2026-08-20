import { useEffect } from 'react';

import { isEntityView, resolveView } from '@/lib/resolve-view';

import { useEditorLayout } from '@stores/appearance-store';
import { useActiveFileKey } from '@stores/editor-store';
import { terminalIdFor, useActiveEntity } from '@stores/hive-store';
import { useActiveTab, usePickerState, useSettingsOpen } from '@stores/ui-store';

/**
 * Tell main which session's terminal is on the centre stage (HIVE-81).
 *
 * The renderer half of the foreground gate. Main owns window focus and owns the
 * notification hub, but has no idea what the window is *showing* — `activeTab`
 * and `resolveView` are renderer state, and there was no channel carrying them.
 * Without this, the app raises a toast, a dock bounce and an unread badge about
 * the session whose terminal the user is watching answer the question.
 *
 * **This mirrors `center-stage.tsx` rather than re-deriving.** Same selectors,
 * same `editorFull` derivation, same `resolveView` call. "What is on screen"
 * must have exactly one answer, and the surest way to grow a second one that
 * drifts is to compute it twice from the same inputs in two places. If the
 * stage's inputs change, this has to change with them — that is a feature.
 *
 * A `split` editor still shows the terminal, so it stays foreground; a `full`
 * one does not. That distinction is the entire reason `resolveView` takes one
 * `editorFull` boolean instead of `placement`.
 *
 * An **agent** tab counts. `isEntityView` already groups `'session'` and
 * `'agent'`, and the rule the gate encodes is "you can already see it", which
 * has nothing to do with which kind of entity it is.
 *
 * Publishes a **terminal** id, not a row id. A notification's action carries a
 * terminal id, so main compares like with like; a row id would silently never
 * match after a `/clear` and the gate would be a no-op.
 *
 * Mounted once at the composition root, like `useSessionStatus` and
 * `useNotificationStream`. The payload is a property of the stage, not of any
 * component, and there is exactly one stage.
 */
export function useForegroundSession(): void {
  const activeTab = useActiveTab();
  const entity = useActiveEntity();
  const { picker } = usePickerState();
  const settings = useSettingsOpen();
  const activeFileKey = useActiveFileKey();
  const { placement } = useEditorLayout();

  const editorFull = activeFileKey !== null && placement === 'full';
  const view = resolveView({ activeTab, picker, settings, entity, editorFull });
  const terminalId = isEntityView(view) ? terminalIdFor(activeTab) : null;

  useEffect(() => {
    // No bridge is the browser demo, where there is no main process to tell.
    window.hive?.ui.reportForeground(terminalId);
  }, [terminalId]);
}
