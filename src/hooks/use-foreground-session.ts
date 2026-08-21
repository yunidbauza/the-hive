import { useEffect } from 'react';

import { isEntityView, resolveView } from '@/lib/resolve-view';
import { isSession, terminalOf } from '@/types/entity';

import { useEditorLayout } from '@stores/appearance-store';
import { useActiveFileKey } from '@stores/editor-store';
import { useActiveEntity } from '@stores/hive-store';
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
 * Read off the **entity this hook is already subscribed to**, rather than
 * through `terminalIdFor(activeTab)`. That helper is a `getState()` read, which
 * `CLAUDE.md` bans from components and whose own doc comment says its callers
 * are event handlers, not render paths. It happened to be correct here only
 * because `useActiveEntity()` subscribes to the very entity it looks up — a
 * coupling with nothing at the call site to show for it, and one that would
 * break the moment either side moved. `terminalOf` is the same accessor the
 * helper uses, applied to a value React is already re-rendering us for.
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
  /*
    `entity` is non-null whenever the view is an entity view — `resolveView`
    falls back to the orchestrator without one — so the null check is a type
    narrowing rather than a case. An **agent** has no terminal of its own and
    its row id is what main knows it by, which is what `terminalIdFor` answered
    for the same input.
  */
  const terminalId =
    isEntityView(view) && entity !== null
      ? isSession(entity)
        ? terminalOf(entity)
        : entity.id
      : null;

  useEffect(() => {
    // No bridge is the browser demo, where there is no main process to tell.
    window.hive?.ui.reportForeground(terminalId);
  }, [terminalId]);
}
