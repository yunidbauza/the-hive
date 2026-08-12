import { ArrowSquareOut, CaretRight, ChatCircle } from '@phosphor-icons/react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

import { AdfBlocks } from '@features/work/components/adf-blocks';
import { addJiraComment, readJiraComments, readJiraLinks } from '@lib/jira';
import type { JiraComment, JiraLink } from '@shared/jira-contract';

/**
 * An issue's conversation and its links (HIVE-71).
 *
 * ## Why this is collapsed by default
 *
 * The WORK panel is a rail, and a rail is scanned. A card that opened with
 * forty comments in it would push every other ticket off screen — so the
 * conversation is one line until asked for, and reading it costs a request only
 * when somebody actually wants it. Same reasoning as the transition menu: fetch
 * on open, because opening is the moment the answer matters.
 *
 * ## Links live here too
 *
 * Remote links and Jira-to-Jira links arrive from main as one list, because a
 * user looking at "what else is this connected to" does not care which endpoint
 * an entry came from. What they do care about is **direction** — "blocks" and
 * "is blocked by" are opposite facts — so the relationship wording is rendered
 * beside every issue link rather than flattened away.
 */

interface TicketConversationProps {
  issueKey: string;
}

type Loaded = {
  comments: JiraComment[];
  links: JiraLink[];
};

type State =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'ready'; loaded: Loaded }
  | { kind: 'problem'; message: string };

/** `2026-08-07T00:41:13.497-0400` → `7 Aug, 00:41`. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TicketConversation({ issueKey }: TicketConversationProps) {
  const [state, setState] = useState<State>({ kind: 'closed' });
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postProblem, setPostProblem] = useState<string[] | null>(null);

  const load = () => {
    setState({ kind: 'loading' });
    void Promise.all([
      readJiraComments({ key: issueKey }),
      readJiraLinks({ key: issueKey }),
    ]).then(([comments, links]) => {
      if (comments === null || links === null) {
        setState({
          kind: 'problem',
          message: 'The app could not reach its own main process.',
        });
        return;
      }
      if (!comments.ok) {
        setState({ kind: 'problem', message: comments.error.message });
        return;
      }
      if (!links.ok) {
        setState({ kind: 'problem', message: links.error.message });
        return;
      }
      setState({
        kind: 'ready',
        loaded: { comments: comments.value, links: links.value },
      });
    });
  };

  const toggle = () => {
    if (state.kind === 'closed') load();
    else setState({ kind: 'closed' });
  };

  const post = () => {
    const markdown = draft.trim();
    if (markdown === '') return;

    setPosting(true);
    setPostProblem(null);
    void addJiraComment({ key: issueKey, markdown }).then((result) => {
      setPosting(false);
      if (result === null) {
        setPostProblem(['The app could not reach its own main process.']);
        return;
      }
      if (!result.ok) {
        // `details` is main's own diagnosis when the document failed local
        // validation, or Jira's named fields when it refused the request.
        setPostProblem([result.error.message, ...(result.error.details ?? [])]);
        return;
      }

      setDraft('');
      // Appended rather than re-read: the answer is the comment that was just
      // created, so asking Jira for the whole thread again would cost a request
      // to learn something already in hand.
      setState((current) =>
        current.kind === 'ready'
          ? {
              kind: 'ready',
              loaded: {
                ...current.loaded,
                comments: [...current.loaded.comments, result.value],
              },
            }
          : current,
      );
    });
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-border-soft pt-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={state.kind !== 'closed'}
        className="flex items-center gap-1 self-start text-[11px] text-subtle hover:text-ink"
      >
        <CaretRight
          size={10}
          className={cn(
            'transition-transform',
            state.kind !== 'closed' && 'rotate-90',
          )}
        />
        <ChatCircle size={11} />
        Conversation
      </button>

      {state.kind === 'loading' ? (
        <p className="text-[11.5px] text-subtle">Reading…</p>
      ) : null}

      {state.kind === 'problem' ? (
        <p className="text-[11.5px] text-amber">{state.message}</p>
      ) : null}

      {state.kind === 'ready' ? (
        <div className="flex flex-col gap-2">
          {state.loaded.links.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {state.loaded.links.map((link) => (
                <li
                  key={`${link.kind}-${link.url}-${link.relationship ?? ''}`}
                  className="flex items-baseline gap-1 text-[11.5px]"
                >
                  {/* The direction wording. Without it "blocks" and "is
                      blocked by" are the same row, which is worse than no
                      row at all. */}
                  {link.relationship === undefined ? null : (
                    <span className="shrink-0 text-subtle">
                      {link.relationship}
                    </span>
                  )}
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate text-brand hover:underline"
                  >
                    {link.title}
                  </a>
                  {link.status === undefined ? null : (
                    <span className="shrink-0 text-subtle">
                      ({link.status})
                    </span>
                  )}
                  <ArrowSquareOut size={9} className="shrink-0 text-subtle" />
                </li>
              ))}
            </ul>
          ) : null}

          {state.loaded.comments.length === 0 ? (
            <p className="text-[11.5px] text-subtle">No comments yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {state.loaded.comments.map((comment) => (
                <li key={comment.id} className="flex flex-col gap-0.5">
                  <p className="text-[11px] text-subtle">
                    <span className="text-muted">{comment.author}</span>
                    {' · '}
                    {when(comment.created)}
                    {comment.updated === undefined ? null : ' · edited'}
                  </p>
                  <AdfBlocks blocks={comment.body} />
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor={`${issueKey}-comment`} className="sr-only">
              Add a comment to {issueKey}
            </label>
            <textarea
              id={`${issueKey}-comment`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={2}
              placeholder="Add a comment — markdown works"
              className="resize-y rounded-[6px] border border-border bg-panel-2 px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-subtle focus-visible:ring-1 focus-visible:ring-brand"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={post}
                disabled={posting || draft.trim() === ''}
                className="self-start rounded-[6px] border border-border bg-panel-2 px-2 py-0.5 text-[11.5px] text-ink hover:bg-hover disabled:cursor-not-allowed disabled:text-subtle disabled:hover:bg-panel-2"
              >
                {posting ? 'Posting…' : 'Comment'}
              </button>
            </div>
            {postProblem?.map((line) => (
              <p key={line} className="text-[11.5px] text-red">
                {line}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
