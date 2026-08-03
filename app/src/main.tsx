import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app';

import { loadProjectConfig } from '@lib/project-config';
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

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
