# Component patterns

**Scope:** panels, atoms, the rails, and the center-stage view-state machine.

**Owned by stories 020–053.** This file is a placeholder until the shell and
panel stories land; it exists now so the routing table in `../AGENTS.md` never
points at a missing file.

## What already holds today

- Chrome lives in `src/components/layout/`, shared atoms in
  `src/components/ui/`, and domain surfaces in `src/features/<slice>/`.
- A feature slice follows the bulletproof-react shape: `components/`, `hooks/`,
  `stores/`, `types/`, `utils/`, plus an `index.ts` barrel that is the only thing
  outside code imports.
- Slices never import each other. Cross-slice communication goes through the
  store, or through `features/shared`.
- `src/components/**` may not import from `features/**` — chrome and atoms stay
  domain-agnostic.
- Colour comes from `--cc-*` tokens via Tailwind utilities. Raw hex literals in
  component code are banned.
- Only the shadcn primitives actually needed are installed: `dialog`, `tooltip`,
  `dropdown-menu`.

## What later stories add here

The three-column shell and its breakpoints (020), the header (021), the left rail
and its three panels (030–033), the center-stage view-state machine and session
meta bar (040), the activity rail and its three panels (050–053), and the atom
inventory those stories introduce.
