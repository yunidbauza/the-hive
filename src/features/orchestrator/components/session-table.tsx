import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';
import { cn } from '@/lib/utils';
import {
  branchLabel,
  endedReason,
  entityLabel,
  isEnded,
  isSession,
} from '@/types/entity';

import { STATUS_TEXT, statusLabel } from '@components/ui/status-dot';
import { SwarmCreature } from '@components/ui/swarm-creature';
import { prStateText } from '@features/shared/pr-presentation';
import {
  useActiveSessions,
  useEndedSessions,
  useEntity,
  useNavOrder,
  useOpenEntity,
  useResumeSession,
  useRestoredSessions,
} from '@stores/hive-store';
import { useActiveTab, useSelIdx, useSetSelIdx } from '@stores/ui-store';

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
 * The variable-width columns share the leftover space, 2:1:2. `BRANCH` takes as
 * much as `SESSION` because it is the value that grows with deep branch names;
 * `PROJECT` is a short slug and takes half of that. The floors matter as much as
 * the ratio: below them the columns truncate rather than collapsing to nothing,
 * which is what keeps the table readable in a narrow window.
 *
 * **The floors have a hard ceiling, and it is not a matter of taste.** Splitting
 * `PROJECT · BRANCH` in two added a second floor *and* a second `gap-2.5`, and
 * the first draft of this map (100/120) spent 90px more than the joined cell
 * did. That is enough to overflow the center stage at `MIN_WINDOW_SIZE` (1100px,
 * `electron/shared/window.ts`) in comfortable density, where the two rails leave
 * it 516px: the scroll container is `overflow-y-auto`, so `overflow-x` resolves
 * to `auto` and the table grows a horizontal scrollbar that hides the `PR` cell
 * and steals height from the terminal below. 80/100 is what fits exactly at that
 * width, measured rather than reasoned. Raising either floor re-breaks it, and
 * truncation is not the cost it looks like — every column carries a `title`.
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
 */
const COL = {
  caret: 'w-3 shrink-0',
  session: 'min-w-[120px] flex-[2] truncate',
  status: 'w-[90px] shrink-0 truncate',
  project: 'min-w-[80px] flex-[1] truncate',
  branch: 'min-w-[100px] flex-[2] truncate',
  pr: 'w-[34px] shrink-0',
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
  const active = useActiveSessions();
  const ended = useEndedSessions();
  /** Last run's fleet (HIVE-87). Fixed for the life of the app session. */
  const restored = useRestoredSessions();
  const empty =
    active.length === 0 && ended.length === 0 && restored.length === 0;
  /**
   * Drawn unconditionally, though only rendered when the table is empty: a hook
   * cannot sit behind the `empty` branch. The cost is one array index on a
   * render that throws it away.
   */
  const phrase = useSwarmPhrase('empty.sessions');

  return (
    <div className="shrink-0 overflow-y-auto bg-term-bg px-[18px] pt-4 font-mono text-[12.5px]">
      <div className="flex gap-2.5 px-2 pb-1.5 text-[11px] tracking-[0.06em] text-term-head">
        <span className={COL.caret} />
        <span className={COL.session}>SESSION</span>
        <span className={COL.status}>STATUS</span>
        <span className={COL.project}>PROJECT</span>
        <span className={COL.branch}>BRANCH</span>
        <span className={COL.pr}>PR</span>
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
        <SessionTableRow key={id} id={id} />
      ))}

      {/*
        Last run's fleet, **above** ENDED (HIVE-87).

        Above rather than below because of where the eye lands and when the
        group exists. At launch this is the only group on the table, so it sits
        directly under the column header; as work starts, live rows push it down
        and this run's endings collect beneath it. The ended half of the table
        then reads oldest to newest, top to bottom.

        Its own divider rather than a fourth kind of row inside ENDED: that
        group answers "what did I just finish?", about this session of the app,
        and a launch or two would bury the answer under rows from before.
      */}
      {restored.length > 0 ? (
        <>
          <div className="flex items-center gap-2 px-2 pt-3.5 pb-1.5">
            <span className="shrink-0 text-[11px] tracking-[0.06em] text-term-head">
              PREVIOUS RUN
            </span>
            <span className="flex-1 border-t border-border" />
          </div>
          {restored.map((id) => (
            <SessionTableRow key={id} id={id} />
          ))}
        </>
      ) : null}

      {/*
        "ENDED", not "COMPLETED" (story 108). The group now holds two different
        endings — work that finished and a process that quit — and only one of
        them was ever completed. The row's own status word says which.
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
            <SessionTableRow key={id} id={id} />
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
function SessionTableRow({ id }: { id: string }) {
  const entity = useEntity(id);
  const navOrder = useNavOrder();
  const selIdx = useSelIdx();
  const setSelIdx = useSetSelIdx();
  const openEntity = useOpenEntity();
  const resumeSession = useResumeSession();
  const activeTab = useActiveTab();

  if (!entity || !isSession(entity)) return null;

  const index = navOrder.indexOf(id);
  const selected = index === selIdx;
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
    <div
      className={cn(
        'flex w-full items-center rounded',
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
        setSelIdx(index);
        openEntity(id);
      }}
      aria-current={activeTab === id ? 'true' : undefined}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2.5 px-2 py-[3px] text-left',
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
      <span className={cn(COL.status, STATUS_TEXT[entity.status])}>
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
      {/*
        The column is 34px wide, so the PR *state* cannot be visible text here
        the way it is on the meta bar. It still must not be carried by colour
        alone — a hue is no signal to a colour-blind user, and none at all to a
        screen reader — so the state rides along as a title and an sr-only word.
      */}
      <span
        title={entity.pr ? `#${entity.pr.n} · ${entity.pr.state}` : 'no pull request'}
        className={cn(
          COL.pr,
          entity.pr ? prStateText(entity.pr.state) : 'text-subtle',
        )}
      >
        {entity.pr ? `#${entity.pr.n}` : '—'}
        <span className="sr-only">
          {entity.pr ? ` ${entity.pr.state}` : ' no pull request'}
        </span>
      </span>
    </button>
    {/*
      A sibling of the row, not a child of it — a button inside a button is
      invalid markup, and browsers resolve it by dropping one of the two.
      `stopPropagation` is therefore unnecessary here, which is the point: the
      two controls are genuinely separate targets for both mouse and keyboard.
    */}
    {resumable ? (
      <button
        type="button"
        /*
          Named for its row, not just "resume". The visible word is enough
          beside the session it belongs to, but a screen reader reaching the
          fifth of five identical "resume" buttons has been told nothing about
          which conversation it reopens.
        */
        aria-label={`resume ${entityLabel(entity)}`}
        title={`resume ${entityLabel(entity)} — continues the conversation`}
        onClick={() => {
          setSelIdx(index);
          resumeSession(id);
        }}
        className={cn(
          'mr-2 shrink-0 rounded px-1.5 py-[1px] text-[11px] text-subtle',
          'hover:bg-term-row-hover hover:text-ink',
        )}
      >
        resume
      </button>
    ) : null}
    </div>
  );
}
