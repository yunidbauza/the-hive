import type { CursorContext } from '@lib/terminal/keymap';

/**
 * Claude Code's input frame, captured from a real session (HIVE-79).
 *
 * **Every frame here came out of a live `claude` 2.1.245 driven through a real
 * pty**, rendered by a VT emulator into a window of right-trimmed rows around
 * the caret — the shape `terminal-surface.tsx` hands over. None of it is a
 * guess about how Claude Code draws itself, and that is the point: the ticket
 * this fixture exists for was opened because the rule that shipped before was
 * built on an *inferred* frame shape, and the inference was wrong.
 *
 * One thing these recordings cannot carry: **Claude's faint placeholder**. The
 * emulator used here records characters, not the SGR 2 attribute the surface
 * reads to tell `Try "…"` from a typed message, so every row arrives as if the
 * surface had already blanked it. The placeholder is covered where it can be
 * covered honestly — against the real binary, in
 * `tests/e2e/electron/bare-back-claim.spec.ts`, and against staged cell
 * attributes in the surface's own suite.
 *
 * The session was driven through each state in turn: type, send the caret home
 * with `Ctrl-A`, clear, cycle the mode with `Shift+Tab`, enter bash mode, start
 * a second line with `Shift+Enter`, then resize from 120 columns down to 18.
 *
 * Three of these are decided **differently** by the two-row rule that shipped
 * before, and they are the bug:
 *
 * | frame | before | after |
 * | --- | --- | --- |
 * | `bash mode, empty` | leaked to Claude | claimed |
 * | `empty prompt at 18x12` | leaked to Claude | claimed |
 * | `multi-line, caret on empty second row` | **claimed — user thrown out** | declined |
 *
 * The third mattered most: the old rule saw an empty caret row above a rule and
 * took the key, so a user who pressed `Shift+Enter` and then reached back with
 * `<-` lost a half-written message.
 *
 * Recordings, not a live harness. A suite that re-derived these on every run
 * would be asserting that today's `claude` agrees with today's `claude`, and
 * would spend a real session's tokens doing it.
 */

/** A frame edge, drawn the full width of the terminal. */
const rule = (width: number): string => '\u2500'.repeat(width);

export interface CapturedFrame extends Omit<CursorContext, 'caretText'> {
  /** The state the session was driven into. */
  name: string;
  /** What the app must decide for a bare `<-` at this frame. */
  claim: 'claim' | 'declined' | 'foreign';
}

/**
 * A recording, in the shape the surface hands over.
 *
 * `caretText` is the caret's row as the *user* typed it. These recordings carry
 * no rendition (see the note above), so it is the raw row — which is correct
 * for every frame here, none of which was showing Claude's faint placeholder.
 */
export const asCursorContext = (captured: CapturedFrame): CursorContext => ({
  rows: captured.rows,
  caretRow: captured.caretRow,
  caretText: captured.rows[captured.caretRow] ?? '',
});

export const CLAUDE_FRAMES: readonly CapturedFrame[] = [
  {
    name: "fresh empty prompt",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                                                                  ● high · /effort",
      rule(100),
      "❯",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --%",
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "text typed",
    claim: 'foreign',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                                                                  ● high · /effort",
      rule(100),
      "❯ hello there",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --%",
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "text typed, caret sent home with ctrl-a",
    claim: 'foreign',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                                                                  ● high · /effort",
      rule(100),
      "❯ hello there",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --%",
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "cleared",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                      Scroll wheel is sending arrow keys · use PgUp/PgDn to scroll",
      rule(100),
      "❯",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --%",
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "manual mode (shift+tab)",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                      Scroll wheel is sending arrow keys · use PgUp/PgDn to scroll",
      rule(100),
      "❯",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --% | 5% - 6:30 PM",
      "  ⏸ manual mode on",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "plan mode",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                      Scroll wheel is sending arrow keys · use PgUp/PgDn to scroll",
      rule(100),
      "❯",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --% | 5% - 6:30 PM",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "bash mode, empty",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                      Scroll wheel is sending arrow keys · use PgUp/PgDn to scroll",
      rule(100),
      "!",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  ! for shell mode",
      "",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "bash mode backspaced",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                                                                  ● high · /effort",
      rule(100),
      "❯",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --% | 5% - 6:30 PM",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "multi-line, caret on empty second row",
    claim: 'declined',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "                                                                             ctrl+g to edit in Vim",
      rule(100),
      "❯ hi there",
      "",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --% | 5% - 6:30 PM",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "multi-line, caret at end of row 2",
    claim: 'foreign',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "                                                                             ctrl+g to edit in Vim",
      rule(100),
      "❯ hi there",
      "  second line",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --% | 5% - 6:30 PM",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "multi-line, caret on row 1",
    claim: 'foreign',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                                                             ctrl+g to edit in Vim",
      rule(100),
      "❯ hi there",
      "  second line",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --% | 5% - 6:30 PM",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "",
      "",
      "",
    ],
  },
  {
    name: "cleared after multi-line",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                      Scroll wheel is sending arrow keys · use PgUp/PgDn to scroll",
      rule(100),
      "❯",
      rule(100),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_C…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --% | 5% - 6:30 PM",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "empty prompt at 120x40",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "",
      "",
      "",
      "",
      "",
      "",
      "                                                          Scroll wheel is sending arrow keys · use PgUp/PgDn to scroll",
      rule(120),
      "❯",
      rule(120),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PE…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --% | 5% - 6:30 PM",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "empty prompt at 80x24",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "╰──────────────────────────────────────────────────────────────────────────────╯",
      "",
      " ⚠ 1 MCP server needs authentication · run /mcp",
      "",
      "",
      "",
      "                  Scroll wheel is sending arrow keys · use PgUp/PgDn to scroll",
      rule(80),
      "❯",
      rule(80),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · r…",
      "  probe-repo | main | Opus 5 (1M context) - high | [----------] --% | 5% - 6:…",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "empty prompt at 60x20",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "│                        Claude Max                        │",
      "│                 /…/scratchpad/probe-repo                 │",
      "│                                                          │",
      "╰──────────────────────────────────────────────────────────╯",
      "",
      " ⚠ 1 MCP server needs authentication · run /mcp",
      "                                          ● high · /effort",
      rule(60),
      "❯",
      rule(60),
      "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHIL…",
      "  probe-repo | main | Opus 5 (1M context) - high | [-----…",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "empty prompt at 40x14",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "│       /…/scratchpad/probe-repo       │",
      "│                                      │",
      "╰──────────────────────────────────────╯",
      "",
      " ⚠ 1 MCP server needs authentication ·",
      "   run /mcp",
      "                      ● high · /effort",
      rule(40),
      "❯",
      rule(40),
      "  ⚠ Transcript saving is off — inheri…",
      "  probe-repo | main | Opus 5 (1M cont…",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "empty prompt at 30x12",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "│  /…/scratchpad/probe-repo  │",
      "│                            │",
      "╰────────────────────────────╯",
      "",
      " ⚠ 1 MCP server needs",
      "   authentication · run /mcp",
      "            ● high · /effort",
      rule(30),
      "❯",
      rule(30),
      "  ⚠ Transcript saving is of…",
      "  probe-repo | main | Opus …",
      "",
      "",
      "",
      "",
      "",
    ],
  },
  {
    name: "empty prompt at 18x12",
    claim: 'claim',
    caretRow: 8,
    rows: [
      "╰────────────────╯",
      "",
      " ⚠ 1 MCP server",
      "   needs",
      "   authentication",
      "   · run /mcp",
      "  ● high · /eff…",
      rule(18),
      "❯",
      rule(18),
      "  ⚠ Transcript …",
      "  probe-repo | …",
      "",
      "",
      "",
      "",
      "",
    ],
  },
];
