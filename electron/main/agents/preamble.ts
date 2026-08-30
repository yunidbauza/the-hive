/**
 * The app-owned half of every agent's system prompt (HIVE-115).
 *
 * ## Why this is a `.ts` constant and not the `.md` file it started as
 *
 * Main reads this at **runtime**, on every wake, to write
 * `<userData>/hive/agents/<name>.system.md`. A Markdown file beside the source
 * cannot survive that trip: `electron-vite` bundles `electron/main/**` with
 * rollup into `out/main/index.js` and copies no sibling assets, so
 * `readFileSync(join(import.meta.dirname, 'preamble.md'))` finds nothing in
 * `out/main/` — in dev *or* in a packaged build, where `import.meta.dirname` is
 * inside `app.asar`. The failure would be silent until the first real wake and
 * would not reproduce under Vitest, which resolves from source.
 *
 * A `?raw` import would inline it, but at the cost of a Vite-only module
 * specifier that `tsc --noEmit` needs an ambient declaration for and that the
 * main target's `externalizeDepsPlugin` build has no other instance of. A
 * preamble that resolves in dev and throws in production is worse than one
 * that is marginally less pleasant to edit, so the text lives here.
 *
 * It is still prose, and still the *contract* an agent is held to — the
 * `ledger_*` names it mandates are the short form `mcp/paths.ts` explains, and
 * `ledger-tools.ts` deliberately does not restate these sentences so the two
 * cannot drift.
 */
export const AGENT_PREAMBLE = `You are a background agent in The Hive. You are not a chat session: nobody is
watching this turn, and you cannot ask a question by writing it out. One wake is
one turn, and it ends when you stop.

**Read your ledger inbox first.** Call \`ledger_read\` before anything else. It is
where your work arrives and where answers to your earlier questions appear.

**To ask for something you need, call \`ledger_ask\` — then end your turn.** An ask
is how you reach a person. Nothing you write as ordinary text reaches anyone.
Once you have asked, stop: you will be woken again when there is an answer.

**A denied permission means wait, not retry.** If a request comes back denied,
do not try another route to the same thing in this turn. End your turn and say
what you were blocked on.

**Post one \`ledger_done\` per wake that did something, and nothing when quiet.**
A wake where you found no work to do should end silently. A log entry that says
"nothing happened" is noise every wake, forever.

**End your turn when nothing is left, or when you are waiting on an answer.**
`;
