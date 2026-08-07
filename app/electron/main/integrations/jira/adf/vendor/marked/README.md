# Vendored `marked`

Version **13.0.3**. Upstream: <https://github.com/markedjs/marked>, MIT, licence
alongside in `LICENSE.md`.

## Why it is vendored rather than a dependency

HIVE-66 rejected reusing `jira-writer`'s bash client partly to avoid adding
things the app has to resolve at run time. Adding an npm dependency to get the
ADF pipeline would have given some of that back. Copying the one bundle keeps
the property: no new runtime dependency, nothing to resolve at install time, and
a parser whose exact bytes are in the repository and reviewable.

It is used by exactly one module, `../../markdown-to-adf.ts`, and only through
`marked.lexer`.

## Deviations from the upstream file

**One, and it is a deletion.** The trailing
`//# sourceMappingURL=marked.esm.js.map` comment is removed, because the map is
not vendored and Vite logs a failed-to-read warning on every test run that reads
this file. Nothing else is changed — no reformatting, no minification, no edits
to the code.

That matters for review: apart from that one line, this file is byte-identical
to the published bundle, so verifying it means diffing against upstream rather
than reading 2,700 lines.

## Types

`marked.esm.d.mts` is **ours**, not upstream's. It describes only the surface
this app uses — `marked.lexer` and the token fields the converter reads.
Declaring the whole library would be a second, worse copy of upstream's own
types with nothing keeping it honest.

## Lint and type-check

This directory is in `eslint.config.mjs`'s ignore list. Linting someone else's
bundle reports their style choices as our errors, and reformatting it would
destroy the one property that makes a vendored copy auditable.
