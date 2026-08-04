import { ArrowLeft, FolderOpen } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

import { TerminalSurface } from '@/components/terminal/terminal-surface';
import { cancelClone, onCloneDone, startClone } from '@/lib/clone-repo';
import { chooseProjectDirectory } from '@/lib/project-config';

import {
  createCloneTransport,
  resetCloneChannel,
} from '@lib/terminal/pty-transport';
import { useTheme } from '@stores/ui-store';

/**
 * Cloning a repository, as a focused sub-view of Settings (story 102).
 *
 * ## Why this replaces the Projects pane rather than expanding inside it
 *
 * Cloning is a task with a beginning and an end, and it is the one moment in
 * settings where the user may have to answer a question under time pressure —
 * a passphrase prompt on a large repository. Giving the terminal the whole pane
 * and putting nothing beside it is what makes that answerable.
 *
 * It deliberately does **not** put progress in the center stage, which is what
 * the ticket's prose asks for. `resolve-view.ts` puts settings above every
 * other state, and the epic forbids settings changing `activeTab` — so honouring
 * that phrase literally would mean closing settings and switching tabs
 * mid-task. Recorded as a deviation on HIVE-54.
 *
 * ## The terminal is writable, and that is the point
 *
 * `readOnly={false}` is load-bearing rather than a default. `git` asks for
 * credentials and host-key confirmation on its tty; a read-only progress view
 * would fail every private repository, which is most people's repositories.
 */

/** What the pane is doing. Failure is its own phase so Retry has somewhere to live. */
type Phase = 'compose' | 'cloning' | 'failed';

/**
 * The folder name this URL will produce, for display only.
 *
 * Main derives the real one and returns it on `startClone`, at which point that
 * answer replaces this preview. Deriving it here as well is a duplicate rule —
 * accepted knowingly, because the alternative is a form that cannot say what it
 * is about to create until after it has created it. Kept deliberately naive: it
 * previews, it never decides.
 */
function previewName(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  const segment = trimmed.split(/[/:]/).pop() ?? '';
  const name = segment.replace(/\.git$/i, '');
  return name === '' ? null : name;
}

export function CloneRepoView({ onDone }: { onDone: () => void }) {
  const theme = useTheme();

  const [url, setUrl] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('compose');
  const [error, setError] = useState<string | null>(null);
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  /**
   * Built once. A transport rebuilt on re-render would drop the surface's
   * subscription and take the transcript with it.
   */
  const transport = useMemo(() => createCloneTransport(), []);

  useEffect(
    () =>
      onCloneDone((event) => {
        if (event.ok) {
          // The project list behind us is already fresh — the event carried the
          // new snapshot — so there is nothing to do here but leave.
          onDone();
          return;
        }
        setError(event.reason);
        setPhase('failed');
      }),
    [onDone],
  );

  const preview = previewName(url);
  const ready = preview !== null && parentPath !== null;

  const onChoose = async () => {
    if (choosing) return;
    setChoosing(true);
    try {
      const chosen = await chooseProjectDirectory();
      // Cancelled, or no bridge to ask. The user closed a dialog they opened.
      if (chosen === null) return;
      setParentPath(chosen);
    } finally {
      setChoosing(false);
    }
  };

  const onClone = async () => {
    if (!ready || parentPath === null) return;
    setError(null);

    /**
     * Clear the previous clone's transcript and reopen its channel before the
     * new process can produce a byte. Every clone reuses one entity id, and the
     * channel closes when a clone exits — so without this the second clone of a
     * session shows an empty terminal.
     */
    resetCloneChannel();

    const result = await startClone({ url: url.trim(), parentPath, cols: 80, rows: 24 });
    if (!result.ok) {
      // A refusal is a thing to fix in the field above, not a failed clone —
      // so it stays in `compose` with everything the user typed intact.
      setError(result.reason);
      return;
    }

    setTargetPath(result.targetPath);
    setPhase('cloning');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
      {phase === 'cloning' ? null : (
        <button
          type="button"
          onClick={onDone}
          className="flex w-fit items-center gap-1.5 text-[12px] text-muted hover:text-ink"
        >
          <ArrowLeft size={12} weight="bold" />
          Projects
        </button>
      )}

      <div className="flex flex-col gap-0.5">
        <h2 className="text-[14px] text-ink">
          {phase === 'compose' ? 'Clone a repository' : `Cloning ${preview ?? ''}`}
        </h2>
        <p className="text-[11.5px] text-subtle">
          {phase === 'compose'
            ? 'The Hive runs git in a terminal, so it can ask you for credentials'
            : (targetPath ?? '')}
        </p>
      </div>

      {phase === 'compose' ? (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="clone-url" className="text-[11.5px] text-muted">
              Repository URL
            </label>
            <input
              id="clone-url"
              type="text"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/owner/repo.git"
              spellCheck={false}
              autoComplete="off"
              className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-subtle"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11.5px] text-muted">Clone into</span>
            <div className="flex items-stretch gap-2">
              <span className="flex-1 truncate rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-ink">
                {parentPath ?? (
                  <span className="text-subtle">Choose a folder…</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => void onChoose()}
                disabled={choosing}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink disabled:opacity-60"
              >
                <FolderOpen size={12} weight="bold" />
                Choose…
              </button>
            </div>
          </div>

          {/*
            Named before it exists, because "where did it go?" is the first
            question a clone raises. Main derives the real path from the URL —
            this only says what that will be.
          */}
          {ready ? (
            <p className="text-[11.5px] text-subtle">
              Creates <span className="text-green">{parentPath}/{preview}</span>
            </p>
          ) : null}
        </>
      ) : null}

      {error !== null ? (
        <p className="rounded-[5px] border border-red px-2.5 py-1.5 text-[11.5px] text-red">
          {error}
        </p>
      ) : null}

      {phase === 'compose' ? (
        <button
          type="button"
          onClick={() => void onClone()}
          disabled={!ready}
          className="flex w-fit items-center gap-1.5 rounded-md bg-brand-fill px-3 py-1.5 text-[12.5px] text-on-brand hover:bg-brand-fill-hover disabled:opacity-60"
        >
          Clone
        </button>
      ) : null}

      {phase === 'cloning' ? (
        <>
          <div className="min-h-0 flex-1 overflow-hidden rounded-[7px] border border-border">
            <TerminalSurface
              transport={transport}
              theme={theme}
              /* Load-bearing: git's credential and host-key prompts are
                 answered by typing into this surface. */
              readOnly={false}
              visible
            />
          </div>
          <button
            type="button"
            onClick={() => void cancelClone()}
            className="flex w-fit items-center gap-1.5 rounded-md bg-hover px-3 py-1.5 text-[12.5px] text-ink"
          >
            Cancel clone
          </button>
        </>
      ) : null}

      {phase === 'failed' ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setPhase('compose');
              setError(null);
            }}
            className="flex w-fit items-center gap-1.5 rounded-md bg-brand-fill px-3 py-1.5 text-[12.5px] text-on-brand hover:bg-brand-fill-hover"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onDone}
            className="flex w-fit items-center gap-1.5 rounded-md bg-hover px-3 py-1.5 text-[12.5px] text-ink"
          >
            Back
          </button>
        </div>
      ) : null}
    </div>
  );
}
