import { ArrowClockwise, FolderOpen } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';

import { ConfigResetConfirm } from '@features/settings/components/config-reset-confirm';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { useProjectConfig } from '@hooks/use-project-config';
import {
  readAppInfo,
  reloadProjectConfig,
  resetConfigToTemplate,
  revealConfigFile,
} from '@lib/project-config';
import type { AppInfo, PtyDiagnostics } from '@shared/ipc-contract';

/**
 * Advanced & diagnostics (story 107).
 *
 * The last of the epic's section slots, and the only one that answers questions
 * about the app rather than setting anything in it.
 *
 * ## Why there is a Reload button at all
 *
 * The epic declined a config-file watcher and named this story as the
 * alternative: "a config that changes under a live session raises questions
 * about the PTY already running in the old directory … the explicit reload in
 * 107 is the answer." So reload is not a convenience here — it is the whole
 * mechanism by which a hand-edited file reaches a running app. And it reports
 * what it found, because a button that flashes and says nothing leaves the user
 * unable to tell a successful reload from a broken one, which is precisely the
 * question they pressed it to answer.
 *
 * ## Why the counters have a Refresh and not an interval
 *
 * `appInfo()` is `invoke`-only and there is no push channel for the PTY
 * counters; this story does not add one. Polling would re-render a settings
 * pane every second for numbers nobody is watching, and the moment these become
 * useful is the moment the user deliberately asks for them.
 */

/**
 * What the reveal button is called, per platform.
 *
 * From `AppInfo.platform` — main's `process.platform` — rather than the user
 * agent, which in Electron is a Chrome UA and lies by design (story 083).
 */
function fileManager(platform: string | undefined): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Reveal in Explorer';
  // Linux and everything else: there is no one file manager to name.
  return 'Show in file manager';
}

/** One label/value row — the shape every fact in this pane takes. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[12px] text-subtle">{label}</span>
      <span className="truncate font-mono text-[11.5px] text-ink">{value}</span>
    </div>
  );
}

/**
 * The keys of {@link PtyDiagnostics} that hold a number.
 *
 * Narrower than `keyof PtyDiagnostics` deliberately. The union also contains
 * `sessionId` and `paused`, and **a boolean in JSX renders as nothing** — so a
 * later edit adding `paused` to the table below would produce a silently blank
 * cell rather than a type error. This makes that a type error.
 */
type CounterKey = {
  [K in keyof PtyDiagnostics]: PtyDiagnostics[K] extends number ? K : never;
}[keyof PtyDiagnostics];

/**
 * The counters, in the order that reads as a story.
 *
 * `in` and `acked` bracket `unacked`, which is the number the water marks
 * compare and the one a stall shows up in first.
 */
const COUNTERS: readonly { key: CounterKey; label: string }[] = [
  { key: 'bytesIn', label: 'in' },
  { key: 'bytesAcked', label: 'acked' },
  { key: 'unacked', label: 'unacked' },
  { key: 'pauses', label: 'pauses' },
  { key: 'batches', label: 'batches' },
  { key: 'dropped', label: 'dropped' },
];

function PtyCounters({ rows }: { rows: readonly PtyDiagnostics[] }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <div
          key={row.sessionId}
          className="flex flex-col gap-1 rounded-[7px] border border-border-soft p-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[11.5px] text-ink">
              {row.sessionId}
            </span>
            {row.paused ? (
              <span className="shrink-0 text-[11px] text-amber">paused</span>
            ) : null}
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
            {COUNTERS.map((counter) => (
              <div key={counter.key} className="flex items-baseline gap-1">
                <dt className="text-[11px] text-subtle">{counter.label}</dt>
                <dd className="font-mono text-[11px] text-muted">
                  {/*
                    Raw numbers, deliberately not humanised. The *ratio* between
                    them is what diagnoses a flow-control bug — `bytesIn /
                    batches` is the coalescing ratio, and `unacked` against the
                    water marks is the pause decision — and "2.1 MB" destroys
                    exactly the precision that makes them worth reading.
                  */}
                  {row[counter.key]}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

export function AdvancedSection() {
  const snapshot = useProjectConfig();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reloaded, setReloaded] = useState<string | null>(null);
  /** A reload has landed and its outcome has not been read off yet. */
  const [pending, setPending] = useState(false);

  /**
   * Keyed on *whether* there is a snapshot, never on the snapshot itself.
   *
   * The trap story 106 documents: every mutating verb installs a fresh
   * `ConfigSnapshot` object, so an effect depending on `snapshot` would re-run
   * on every save. Here that would re-ask main for versions that cannot have
   * changed, on each click of a button in this very pane.
   */
  const hasSnapshot = snapshot !== null;

  const refresh = useCallback(async (): Promise<void> => {
    setInfo(await readAppInfo());
  }, []);

  useEffect(() => {
    if (!hasSnapshot) return;

    let cancelled = false;
    void readAppInfo().then((next) => {
      if (!cancelled) setInfo(next);
    });

    return () => {
      cancelled = true;
    };
  }, [hasSnapshot]);

  /**
   * Report what the reload found, from the snapshot it installed.
   *
   * Two steps rather than one, and the split is the whole point: `snapshot`
   * read inside the click handler is that render's closure and is by definition
   * the *pre*-reload value, so counting there would always describe the config
   * the user was already looking at. Setting a marker and resolving it in an
   * effect keyed on the snapshot means the sentence names the file that was
   * actually just read.
   */
  useEffect(() => {
    if (!pending || !snapshot) return;
    setPending(false);

    const problems = snapshot.errors.length;
    if (problems > 0) {
      setReloaded(
        `Reloaded — ${problems === 1 ? '1 problem' : `${problems} problems`}, listed above.`,
      );
      return;
    }

    const count = snapshot.projects.length;
    setReloaded(`Reloaded — ${count === 1 ? '1 project' : `${count} projects`}.`);
  }, [pending, snapshot]);

  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <h2 className="text-[13px] text-ink">Advanced</h2>
        <p className="text-[11.5px] text-subtle">
          Diagnostics are only available in the desktop app.
        </p>
      </div>
    );
  }

  const onReload = async (): Promise<void> => {
    await reloadProjectConfig();
    setPending(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[13px] text-ink">Advanced</h2>
        <p className="text-[11.5px] text-subtle">
          The config file itself, and what this build is made of.
        </p>
      </div>

      {/*
        Verbatim, like every other section renders them. Main writes these in
        words the person editing the file can act on, so re-phrasing here would
        lose the detail that makes them fixable — and the reload message above
        says "listed above" meaning exactly these.
      */}
      {snapshot.errors.map((error) => (
        <p
          key={error}
          className="rounded-[5px] border border-red px-2.5 py-1.5 text-[11.5px] text-red"
        >
          {error}
        </p>
      ))}

      <SettingsGroup
        title="Config file"
        description="Everything Settings writes goes in this one file, and it is meant to stay hand-editable."
      >
        <p className="break-all font-mono text-[11.5px] text-muted">
          {snapshot.configPath}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void revealConfigFile()}
            className="flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
          >
            <FolderOpen size={12} weight="bold" />
            {fileManager(info?.platform)}
          </button>
          <button
            type="button"
            onClick={() => void onReload()}
            className="flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
          >
            <ArrowClockwise size={12} weight="bold" />
            Reload
          </button>
        </div>
        {reloaded === null ? (
          <p className="text-[11.5px] text-subtle">
            The file is deliberately not watched. Edit it by hand and reload here
            — a config that changed under a live session would leave the terminal
            already running in the old directory.
          </p>
        ) : (
          <p className="text-[11.5px] text-green">{reloaded}</p>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Reset"
        description="Put the file back to the commented template it started as."
      >
        {confirming ? (
          <ConfigResetConfirm
            projectCount={snapshot.projects.length}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              void resetConfigToTemplate();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="w-fit rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
          >
            Reset to template
          </button>
        )}
      </SettingsGroup>

      <SettingsGroup title="About" description="What this build is made of.">
        {info === null ? (
          <p className="text-[12.5px] text-subtle">Reading…</p>
        ) : (
          <div className="flex flex-col gap-1 rounded-[7px] border border-border-soft p-3">
            <Fact label="The Hive" value={info.version} />
            <Fact label="Electron" value={info.electron} />
            <Fact label="Chromium" value={info.chrome} />
            <Fact label="Node" value={info.node} />
            <Fact label="Platform" value={info.platform} />
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Diagnostics"
        description="Per-session flow control, and where to look when something goes wrong."
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11.5px] text-subtle">
            A snapshot, not a stream.
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
          >
            Refresh
          </button>
        </div>

        {/*
          Three states, and collapsing any two of them would make this pane lie.

          `info === null` means the question could not be *asked* — no bridge, or
          a failed channel. Saying "no session has run yet" there would assert a
          fact we do not have, in the one pane that exists to be honest.

          An absent `pty` means the question was asked and nothing has run. Main
          omits the field rather than sending an empty array precisely so this
          can be told apart from "sessions ran and moved no bytes", and that
          distinction survives to the screen here.
        */}
        {info === null ? (
          <p className="text-[12.5px] text-subtle">
            Could not read diagnostics from the app.
          </p>
        ) : info.pty === undefined ? (
          <p className="text-[12.5px] text-subtle">
            No session has run yet, so there is nothing to count.
          </p>
        ) : (
          <PtyCounters rows={info.pty} />
        )}

        {info === null ? null : (
          <div className="flex flex-col gap-0.5 border-t border-border-soft pt-2">
            <p className="text-[12px] text-subtle">Log location</p>
            <p className="break-all font-mono text-[11.5px] text-muted">
              {info.logPath}
            </p>
            <p className="text-[11.5px] text-subtle">
              This app writes no log file — it logs to the terminal it was
              launched from. That directory is Electron&rsquo;s, and is where a
              crash report would land.
            </p>
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
