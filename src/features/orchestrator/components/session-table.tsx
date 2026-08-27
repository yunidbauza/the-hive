import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';
import { cn } from '@/lib/utils';
import {
  branchLabel,
  endedReason,
  entityLabel,
  isEnded,
  isSession,
} from '@/types/entity';

import { statusLabel, statusText } from '@components/ui/status-dot';
import { SwarmCreature } from '@components/ui/swarm-creature';
import { effectiveSelId } from '@features/orchestrator/utils/selection';
import { prStateText } from '@features/shared/pr-presentation';
import {
  useActiveSessions,
  useEndedSessions,
  useEntity,
  useHasResumable,
  useNavOrder,
  useOpenEntity,
  useResumeSession,
  useSessionPr,
} from '@stores/hive-store';
import { useActiveTab, useSelId, useSetSelId } from '@stores/ui-store';

/**
 * One definition per column, shared by the header row and every data row.
 *
 * These were duplicated class strings — the header's and the row's had to be
 * edited together or the columns silently stopped lining up, which is the one
 * defect a table cannot survive. Now a width can only be changed in one place.
 *
 * ## Why the three text columns are proportional rather than fixed
 *
 * `SESSION` used to be `basis-[130px]`, sized for ids like `hero-refresh` when
 * every session came from a fixture. Real names come from the *agent* now
 * (HIVE-61: Claude writes the session title and rewrites it on `/rename`), so
 * they are sentences like `completion-task-cleanup` — and 130px truncated them
 * to an ellipsis while a third of the table sat empty to their right.
 *
 * Each states a **preferred** width — the `88px`/`64px`/`76px` in
 * `flex-[2_1_88px]` and its siblings — chosen from what the value actually is:
 * a session name is a sentence, a project is a short slug, a branch is longer
 * than any column will ever hold. Surplus beyond those is shared 2:1:2, and a
 * shortfall is taken from them proportionally.
 *
 * The ratio governs the **surplus**, not the whole width, and the distinction is
 * worth stating because the sentence here used to claim the latter. `BRANCH`
 * takes as much of the extra as `SESSION` because it is the value that keeps
 * growing; `PROJECT` takes half, because past its slug there is nothing more to
 * show.
 *
 * ## Why those are a flex basis and not a `min-width`
 *
 * They were `min-w-[Npx]`, and that is a different claim: not "prefer this
 * width" but **"never go below it"**. A flex item that may not shrink does not
 * politely stop shrinking — it overflows its container, and the two containers
 * here are not the same box.
 *
 * The header's cells are direct children of the flex line. A row's five
 * leftmost cells live inside the row button, which is `flex-1` and therefore
 * the line minus `PR`, minus Resume, minus their gaps. Those two leftovers are
 * *equal* — which is exactly why the columns line up at every width where the
 * cells fit. Once the floors bind, the header's cells overflow the **line** and
 * the row's overflow the **button**, and `PR` and Resume — the cells outside
 * the button — stay where they are. The column comes apart by precisely the
 * amount of the overflow.
 *
 * And it comes apart *silently*. There is no scrollbar: the scroll container is
 * `overflow-y-auto`, but nothing here is wider than its own scroll box, so
 * `overflow-x` never triggers. The cells simply draw on top of one another.
 * Measured in the built app at `MIN_WINDOW_SIZE` (1100px,
 * `electron/shared/window.ts`) with one resumable row, the header's `PR` sat
 * **54px** right of the row's, and the `#124` link was painted over the middle
 * of the branch name — both unreadable, with nothing on screen to say so.
 *
 * A basis attacks the cause rather than buying headroom against it. `truncate`
 * already sets `overflow: hidden`, which makes a flex item's automatic minimum
 * size `0`, so with no explicit floor the three columns shrink proportionally
 * to their bases and **truncate** — which is what they are built to do, and
 * what every one of their `title` attributes exists for. Header and row shrink
 * identically, because they are dividing the same leftover.
 *
 * That is the point, because the previous rule was a budget — "the three floors
 * must sum to 236 or less" — and a budget only holds while every term in it
 * does. It had already failed twice: once when `BRANCH` was split into its own
 * column (300 against 278, undetected because no test looked below the default
 * 1440px window), and again for any table reserving the Resume column, which
 * spends another 62px no floor could find.
 *
 * ## Where it still breaks, because there is such a width
 *
 * Not "at no width at all" — that would be the same over-claim the budget made,
 * one threshold lower. Once the flexible three are at zero, what is left is the
 * `shrink-0` cells, and **they** overflow: 12 caret + 132 `STATUS` + 34 `PR` +
 * 52 Resume + 60 gaps + 16 `px-2` = **306px**. Below a 306px flex line the
 * header's fixed cells overflow the line while a row's overflow the button, and
 * `PR` and Resume diverge again by the difference.
 *
 * The basis moves that threshold from ~518px to 306px, which is what puts every
 * default layout — including the 1100px window with a Resume column, the case
 * this file was rewritten for — comfortably inside it. What remains outside is
 * a user's own doing: HIVE-105 made the rails draggable, and
 * `STAGE_MIN_FRACTION` (`lib/rail-width.ts`) promises the stage only 20% of the
 * window, so 1100px can be squeezed to a 220px stage and a ~168px line. No
 * arrangement of these columns survives that; the honest claim is that the
 * table holds together at every width the app *chooses*, and gives way
 * gracefully — truncating, in order — for a long way past it.
 *
 * ## What `STATUS` still costs, and why it is fixed
 *
 * `STATUS` was 90px, sized for `terminated` — the longest word the column could
 * hold while a quiet session with subagents running was called `idle (agents)`
 * and was allowed to clip. Renaming that to `working (agents)` and
 * `working (scripts)` made the longest value 17 characters, which the browser
 * measures at 127.9px in this face at 12.5px. A clipped status is worse than a
 * clipped branch: a branch truncates to a prefix that is still recognisably
 * itself, while `working (scr…` is a word the table has stopped saying. So it
 * is `w-[132px] shrink-0` and stays that width — four pixels of margin over a
 * measurement taken on one machine's font stack, because the fallback chain
 * ends in a generic `monospace` whose metrics are the operating system's
 * business.
 *
 * It and the two other fixed columns are what the flexible three shrink
 * *against*. `table-alignment.spec.ts` measures the result at 1100px, both with
 * and without a resumable row, because every claim in this block is arithmetic
 * and only a browser can settle it.
 *
 * ## Why `BRANCH` is its own column
 *
 * It used to be half of a single `PROJECT · BRANCH` cell — one string, one
 * header. That reads fine as a phrase and fails as a table: the header word
 * `BRANCH` sits wherever the phrase happens to put it, while every branch value
 * starts wherever its project name happens to end, so the label and the values
 * it names never line up on the same x. Two columns cost nothing (the `·` that
 * joined them is now the gap) and the header once again points at what is under
 * it.
 *
 * ## `action`, and why one header word ended up over the wrong column
 *
 * Resume arrived (HIVE-93) as a sibling of the row button rather than a cell
 * inside it — it has to be, since a button cannot contain a button. It was
 * given no column, so it took its width from the flex line directly: every cell
 * to its left shifted, and `PR` — the last and narrowest of them — ended up a
 * whole control away from the header word naming it. The screenshot that
 * reported this shows `PR` sitting squarely above a stack of `resume`s.
 *
 * So the control gets a column like everything else, and both rows and header
 * reserve it *together*, on {@link useHasResumable}'s single table-wide answer.
 * Per-row would be worse than nothing: rows with a resumable neighbour would
 * disagree with rows without one, and the header could not match either.
 *
 * It is reserved only when some row will use it, and that is now an economy
 * rather than a necessity: a 52px slot held open on a fleet that never resumes
 * anything is 52px the three text columns could have had. A fleet that *does*
 * have a resumable row spends it, and they give the width back by truncating —
 * which is why every one of them carries a `title`.
 *
 * It used to be more than an economy. While the columns had hard floors, this
 * 62px (the slot and its gap) was width nothing could find, so a restored fleet
 * at 1100px drew `PR` on top of `BRANCH`. That is what the basis above fixes,
 * and it is why reserving a seventh column is no longer a decision with a
 * layout budget behind it.
 */
const COL = {
  caret: 'w-3 shrink-0',
  session: 'flex-[2_1_88px] truncate',
  /*
    Wide enough for `working (scripts)`, and `whitespace-nowrap` rather than
    `truncate` — which is three declarations, and only two of them are wanted.

    `truncate` is what let the old width look survivable: `overflow-hidden` plus
    `text-overflow: ellipsis` clipped the parenthetical, so `idle (agen…` read
    as a status with something after it rather than as a value the column could
    not hold. Dropping the whole class also drops its `white-space: nowrap`,
    and the failure mode that leaves is worse than either: the cell wraps at the
    space, `working (scripts)` becomes two lines, and the row doubles in height
    and falls out of alignment with every other row and with the header.

    `whitespace-nowrap` keeps the one declaration that matters. A value too wide
    for the column overflows it — visibly, on one line, without disturbing the
    row — which is the honest failure and the one an e2e can measure. That
    matters because the 132px is measured against *one* machine's font stack and
    the fallback chain ends in a generic `monospace`.
  */
  status: 'w-[132px] shrink-0 whitespace-nowrap',
  project: 'flex-[1_1_64px] truncate',
  branch: 'flex-[2_1_76px] truncate',
  pr: 'w-[34px] shrink-0',
  action: 'w-[52px] shrink-0',
} as const;

/**
 * The orchestrator's fleet table (story 041).
 *
 * **DOM, not xterm.** The transcript below it goes through the terminal, but
 * these rows have to stay clickable and focusable, which a canvas of text
 * cannot be. That split is the whole reason the console is two surfaces rather
 * than one.
 *
 * Column widths mirror the concept: a fixed caret, status and PR, with the
 * session name, the project and the branch sharing whatever is left.
 *
 * ## The empty fleet
 *
 * This table used to open showing ten seeded sessions, so the orchestrator
 * always looked busy on a machine where nothing was running. With the seed gone
 * a fresh launch has no sessions at all, and the table says so in its own
 * register — monospace, `text-term-head`, inside the terminal surface — rather
 * than borrowing the rail's empty-state styling, which would read as a panel
 * dropped into a console.
 *
 * The header row stays. It is what makes the empty area legible as a table
 * awaiting rows instead of dead space, and it is where the eye returns to when
 * the first session arrives.
 */
export function SessionTable() {
  /**
   * Both newest-first, and both partitions of one list.
   *
   * The table paints them in exactly this order and `useNavOrder` flattens them
   * in exactly this order, which is what keeps the caret and the rows agreeing
   * about where "here" is.
   */
  const active = useActiveSessions();
  const ended = useEndedSessions();
  const empty = active.length === 0 && ended.length === 0;
  /**
   * Drawn unconditionally, though only rendered when the table is empty: a hook
   * cannot sit behind the `empty` branch. The cost is one array index on a
   * render that throws it away.
   */
  const phrase = useSwarmPhrase('empty.sessions');
  /**
   * Whether the header and every row hold the Resume column open (HIVE-100).
   *
   * Answered once, here, and handed down — see `COL.action`. A row cannot
   * decide this for itself without disagreeing with its neighbours.
   */
  const reserveAction = useHasResumable();

  return (
    <div
      data-testid="session-table"
      className="shrink-0 overflow-y-auto bg-term-bg px-[18px] pt-4 font-mono text-[12.5px]"
    >
      <div className="flex items-center gap-2.5 px-2 pb-1.5 text-[11px] tracking-[0.06em] text-term-head">
        <span className={COL.caret} />
        {/*
          `title` on the truncating header cells, for the reason every row cell
          carries one: these labels are the map, and a narrow window now
          shortens them rather than letting them overflow. `PROJE…` is still
          recognisable, but only the tooltip makes it certain.
        */}
        <span className={COL.session} title="SESSION">
          SESSION
        </span>
        {/*
          A second measurement handle, for `COL`'s width note. The status column
          is the only one that must never truncate — a branch cut to a prefix is
          still recognisably itself, while `working (scr…` is a word the table
          has stopped saying — so an e2e measures this cell against the widest
          label at the minimum window size. happy-dom performs no layout, so
          that claim is unassertable anywhere but a real browser.
        */}
        <span className={COL.status} data-col="status">
          STATUS
        </span>
        <span className={COL.project} title="PROJECT">
          PROJECT
        </span>
        <span className={COL.branch} title="BRANCH">
          BRANCH
        </span>
        {/*
          `data-col` is a measurement handle, not a style hook (HIVE-100). The
          header cell and every row's PR cell carry it, so one selector collects
          the whole column and an e2e can assert they share an x — which is the
          only kind of test that can see this defect at all. happy-dom performs
          no layout, so the misalignment that produced this column was invisible
          to all 4,386 unit tests while being the first thing a user saw.
        */}
        <span className={COL.pr} data-col="pr">
          PR
        </span>
        {/*
          The Resume column's header cell, deliberately wordless: the control
          below it is already labelled `resume` on every row that has one, and a
          header word for a column that is empty on most rows would read as a
          fourth thing the table tracks. It exists to hold the width, which is
          the only reason `PR` now sits over the PR values.
        */}
        {reserveAction ? (
          <span className={COL.action} data-col="action" aria-hidden="true" />
        ) : null}
      </div>

      {empty ? (
        /*
          The one place in the app a creature sits on the terminal ground. It is
          allowed here for the same reason the table keeps its column header
          above an empty body: this region owns the whole stage and has nothing
          else in it, so an illustration competes with nothing.
        */
        <div
          data-testid="session-table-empty"
          className="flex flex-col items-center gap-2 px-2 py-4"
        >
          <SwarmCreature creature="hive" size={96} />
          <p className="text-muted">{phrase}</p>
          <p className="text-term-head">
            No sessions running — start one with New session.
          </p>
        </div>
      ) : null}

      {active.map((id) => (
        <SessionTableRow key={id} id={id} reserveAction={reserveAction} />
      ))}

      {/*
        "ENDED", not "COMPLETED" (story 108). The group holds three different
        endings — work that finished, a process that quit, and a row the app
        outlived — and only one of them was ever completed. The row's own status
        word and its `title` say which.

        There used to be a fourth group above this one, PREVIOUS RUN, holding
        last run's fleet (HIVE-87). It is gone, and what it was really fixing is
        worth stating because the fix is now somewhere else. Its argument was
        that "what did I just finish?" is a question about *this* run, and that
        a launch or two would bury today's two endings under yesterday's twenty.
        Both true — but that burial was an artefact of the list being in
        insertion order, so the top of the ended half was always its oldest row.

        `useEndedSessions` sorts by recency now, so today's endings are at the
        top because they *are* the most recent, and last week's are below them
        without a heading having to say so. The divider was answering an
        ordering question with a layout device, and it answered it worse than
        ordering does: a session that ended thirty seconds before the app was
        quit spent the next launch filed under a heading called PREVIOUS RUN,
        below rows that had ended days earlier.
      */}
      {ended.length > 0 ? (
        <>
          <div className="flex items-center gap-2 px-2 pt-3.5 pb-1.5">
            <span className="shrink-0 text-[11px] tracking-[0.06em] text-term-head">
              ENDED
            </span>
            <span className="flex-1 border-t border-border" />
          </div>
          {ended.map((id) => (
            <SessionTableRow key={id} id={id} reserveAction={reserveAction} />
          ))}
        </>
      ) : null}
    </div>
  );
}

/**
 * One row.
 *
 * It owns its own subscription rather than taking the session as a prop: a
 * status change should repaint one row, not the whole table. Same rule the
 * header's chips follow.
 */
function SessionTableRow({
  id,
  reserveAction,
}: {
  id: string;
  reserveAction: boolean;
}) {
  const entity = useEntity(id);
  const navOrder = useNavOrder();
  const selId = useSelId();
  const setSelId = useSetSelId();
  const openEntity = useOpenEntity();
  const resumeSession = useResumeSession();
  const activeTab = useActiveTab();
  /**
   * The row's pull request, resolved from the live GitHub list (HIVE-100).
   *
   * Called before the guard below, because a hook cannot sit behind an early
   * return — `useSessionPr` takes the id for exactly that reason and answers
   * `null` for anything that is not a session.
   */
  const pr = useSessionPr(id);

  if (!entity || !isSession(entity)) return null;

  /*
    Compared by id, not by position. `useNavOrder` is sorted by recency, so a
    row's index changes whenever any session spawns or ends — the caret used to
    stay on the *slot* while the rows moved underneath it, which meant a
    background spawn could leave Enter pointed at a session the user had never
    selected.

    `navOrder` is still read, for one case only: `effectiveSelId` resolves an
    unset caret to the first row, which is what the index-based selection did by
    defaulting to `0` and what makes `→` work on a fresh launch.
  */
  const selected = id === effectiveSelId(selId, navOrder);
  /**
   * An ended row still reads, still selects, and does not open (story 108).
   *
   * `disabled` rather than a silently ignored click. The row's whole job on this
   * screen is to say what happened to a session, so it stays legible and stays
   * in the list — but a button that looks live and does nothing is worse than
   * one that says it is spent, and `disabled` is the only version of that a
   * screen reader hears too. The `title` supplies the *why*, which the status
   * word alone does not.
   *
   * **Both endings**, because `openEntity` refuses both. This keyed on
   * `terminated` alone while `done` was a fixture's recording that opened fine.
   * A cleared session does not open — its terminal belongs to the successor —
   * so leaving it enabled produced exactly the trap this paragraph rejects.
   *
   * The two reasons differ and the title says which: a terminated session's
   * process is gone, while a cleared one's is very much alive and simply is not
   * its own any more.
   */
  const ended = isEnded(entity.status);
  // The sentence itself moved to `types/entity.ts` (HIVE-93) — the console needs
  // the same one, and the store cannot import from `features/`.
  const reason = endedReason(entity);
  /**
   * **No ended row is clickable any more** (HIVE-93).
   *
   * A restored row used to be the exception, because clicking it *was* how a
   * conversation got picked back up. Resume is now its own control, so the row
   * itself can say the honest thing: this terminal is gone, or it belongs to a
   * successor.
   */
  const openable = !ended;
  /**
   * Offered only where there is something to reopen, and only once the session
   * is over.
   *
   * `resumable` is main's answer rather than a guess from the status — it holds
   * the uuid and knows whether that conversation is already open. Gating on
   * `ended` too keeps the control off a live row that merely *could* be resumed
   * later.
   */
  const resumable = ended && entity.resumable === true;

  return (
    /*
      The flex line the header mirrors, cell for cell.

      The row button no longer spans it: it holds the five cells that open a
      terminal, and `PR` and Resume sit outside as siblings. That is forced
      rather than chosen — `#123` is a link and Resume is a button, and neither
      may be nested inside the row's own button. The arithmetic still lines up
      with the header because the button is `flex-1` over the same gap: what it
      leaves for `SESSION`, `PROJECT` and `BRANCH` is the header's total minus
      the very same fixed columns.
    */
    <div
      data-testid="session-row"
      className={cn(
        'flex w-full items-center gap-2.5 rounded px-2',
        selected ? 'bg-term-row-active' : 'hover:bg-term-row-hover',
      )}
    >
    <button
      type="button"
      disabled={!openable}
      title={ended ? reason : undefined}
      onClick={() => {
        // Click both selects and opens: the caret should follow the user's
        // last action, or the keyboard and the mouse end up disagreeing about
        // where "here" is.
        setSelId(id);
        openEntity(id);
      }}
      aria-current={activeTab === id ? 'true' : undefined}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2.5 py-[3px] text-left',
        ended && 'opacity-60',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(COL.caret, 'text-green', selected ? 'visible' : 'invisible')}
      >
        ▸
      </span>
      {/*
        `title` on every truncating column, so a value the width cuts short is
        still readable on hover. Without it the ellipsis is a dead end — the
        agent picks these names and they can be longer than any column.
      */}
      <span className={cn(COL.session, 'text-ink')} title={entityLabel(entity)}>
        {entityLabel(entity)}
      </span>
      <span
        className={cn(COL.status, statusText(entity.status, entity.idleDetail))}
        data-col="status"
      >
        {statusLabel(entity.status, entity.idleDetail)}
      </span>
      <span className={cn(COL.project, 'text-subtle')} title={entity.project}>
        {entity.project}
      </span>
      <span
        className={cn(COL.branch, 'text-subtle')}
        title={branchLabel(entity)}
      >
        {branchLabel(entity)}
      </span>
    </button>
    {/*
      The PR cell, and the second thing this row cannot keep inside its button:
      `#123` opens GitHub, and an anchor nested in a button is invalid markup
      that browsers resolve by silently dropping one of the two.

      The column is 34px wide, so the PR *state* cannot be visible text here the
      way it is on the meta bar. It still must not be carried by colour alone —
      a hue is no signal to a colour-blind user, and none at all to a screen
      reader — so the state rides along as a title and an sr-only word.

      `opacity-60` is repeated from the button rather than lifted to the row,
      because Resume is the one thing on an ended row that is *not* spent:
      dimming it would say the opposite of what it does.
    */}
    <span className={cn(COL.pr, ended && 'opacity-60')} data-col="pr">
      {pr ? (
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          /*
            Underlined at rest, not on hover. In a monospace table `#123` is
            otherwise just the cell's value — the same weight and shape as the
            branch beside it — and nothing would suggest it leaves the app.
            `pr-card` can afford `hover:underline` because its `#123` sits next
            to a title and an arrow glyph; there is no room for either here.
          */
          className={cn(
            'underline underline-offset-2',
            /*
              Neutral for a **remembered** PR — one the current sweep cannot
              see, offered from `Session.lastPr`. Every colour in `prStateText`
              asserts something current about GitHub (green is "alive and not
              yet landed"), and a number the app wrote down days ago has no
              standing to assert any of them. `text-subtle` is the same
              treatment the `—` beside it gets, which is the honest neighbour:
              this cell knows a number and nothing else about it.
            */
            pr.state === undefined ? 'text-subtle' : prStateText(pr.state),
            'hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
          )}
          title={
            pr.state === undefined
              ? `#${String(pr.n)} · last seen on this session — open on GitHub`
              : `#${String(pr.n)} · ${pr.state} — open on GitHub`
          }
          /*
            The state is *in* the label rather than in an `sr-only` span beside
            it. An `aria-label` replaces an element's content for accessibility
            purposes, so the visually-hidden word the cell used to carry would
            have been computed away here and announced to nobody — the colour
            would then have been the only carrier of the state, which is the one
            thing this cell has always refused to do.
          */
          aria-label={
            pr.state === undefined
              ? `Open PR #${String(pr.n)} on GitHub — last seen on this session`
              : `Open PR #${String(pr.n)} on GitHub — ${pr.state}`
          }
        >
          #{pr.n}
        </a>
      ) : (
        <span className="text-subtle" title="no pull request">
          —<span className="sr-only"> no pull request</span>
        </span>
      )}
    </span>
    {/*
      A sibling of the row, not a child of it — a button inside a button is
      invalid markup, and browsers resolve it by dropping one of the two.
      `stopPropagation` is therefore unnecessary here, which is the point: the
      two controls are genuinely separate targets for both mouse and keyboard.

      The slot is drawn on **every** row once any row needs it, so this cell is
      frequently empty. That is what a reserved column is: the alternative is
      the misalignment `COL.action` describes.
    */}
    {reserveAction ? (
      <span className={cn(COL.action, 'flex justify-end')} data-col="action">
        {resumable ? (
          <button
            type="button"
            /*
              Named for its row, not just "resume". The visible word is enough
              beside the session it belongs to, but a screen reader reaching the
              fifth of five identical "resume" buttons has been told nothing
              about which conversation it reopens.
            */
            aria-label={`resume ${entityLabel(entity)}`}
            title={`resume ${entityLabel(entity)} — continues the conversation`}
            onClick={() => {
              setSelId(id);
              resumeSession(id);
            }}
            className={cn(
              'rounded px-1.5 py-[1px] text-[11px] text-subtle',
              'hover:bg-term-row-hover hover:text-ink',
            )}
          >
            resume
          </button>
        ) : null}
      </span>
    ) : null}
    </div>
  );
}
