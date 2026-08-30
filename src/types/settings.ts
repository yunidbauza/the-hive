/**
 * The settings overlay's panes, as an id.
 *
 * Here rather than in `settings-overlay.tsx`, where the list itself lives,
 * because `ui-store` has to name one to honour `openSettings('agents')` — and
 * a store may not import a feature slice. The overlay derives its `SECTIONS`
 * and `PANES` records from this union, so a pane added there without a member
 * here does not compile, and the two cannot drift.
 *
 * The order below is the order the sidebar reads in, and it is argued for in
 * `settings-overlay.tsx`; this is the vocabulary, not the arrangement.
 */
export type SettingsSection =
  | 'projects'
  | 'runtime'
  | 'skills'
  | 'agents'
  | 'appearance'
  | 'editor'
  | 'integrations'
  | 'notifications'
  | 'advanced';
