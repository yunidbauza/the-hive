/*
  `patchFrontmatter` moved into the contract so the Settings form can call it —
  `src/**` may not import `electron/main/**`. Re-exported here because main-side
  callers and this story's tests already address it by this path, and the
  argument for what it does lives with the function.
*/
export { patchFrontmatter } from '@shared/agent-contract';
