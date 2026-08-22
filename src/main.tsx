import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app';

import { loadProjectConfig } from '@lib/project-config';
import { readSessionHistory } from '@lib/session-history';
import { useHiveStore } from '@stores/hive-store';
import '@/styles/tokens.css';
import '@/styles/global.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

/**
 * Kick off the workspace config read (story 090).
 *
 * Not awaited, and rendering does not wait for it: the config only decides
 * whether a project may host a *session*, and every surface treats "no
 * snapshot yet" as permissive. Blocking the first paint on an IPC round trip
 * would trade a visible app for a guarantee nothing needs.
 *
 * A no-op in the browser demo, where there is no bridge to ask.
 */
void loadProjectConfig();

/**
 * Put last run's fleet back on the table (HIVE-87).
 *
 * Unawaited for the same reason the config read is, and with even less at
 * stake: these rows are history. Every one of them is already over, so arriving
 * a tick after the first paint is invisible — whereas holding the paint on an
 * IPC round trip to show a list of finished work would not be.
 *
 * Wired here rather than inside `lib/session-history.ts` because this file is
 * the composition root. Every other `lib/` reader is called *by* the store; a
 * lib module reaching back into the store would point the dependency arrow both
 * ways.
 *
 * A no-op in the browser demo, where there is no bridge to ask.
 */
void readSessionHistory().then((records) => {
  if (records.length > 0) useHiveStore.getState().hydrateSessions(records);
});

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
