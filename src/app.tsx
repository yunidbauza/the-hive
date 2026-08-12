import { AppShell } from '@components/layout/app-shell';

/**
 * Composition root.
 *
 * Everything the user sees lives under `<AppShell />` (story 020). This stays a
 * one-liner on purpose: providers belong here when they arrive, layout does
 * not.
 */
export function App() {
  return <AppShell />;
}
