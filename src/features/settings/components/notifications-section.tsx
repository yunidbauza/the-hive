import { useEffect, useState } from 'react';

import {
  SegmentedControl,
  type SegmentedOption,
} from '@components/ui/segmented-control';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { SettingsSectionHeader } from '@features/settings/components/settings-section-header';
import { useProjectConfig } from '@hooks/use-project-config';
import {
  readNotificationDelivery,
  setNotificationPrefs,
} from '@lib/project-config';
import type { NotificationDeliveryStatus } from '@shared/ipc-contract';
import {
  NOTIFICATION_KIND_SPECS,
  NOTIFICATION_SOURCE_LABELS,
  NOTIFICATION_SOURCE_ORDER,
  kindsForSource,
  type NotificationDelivery,
  type NotificationKind,
} from '@shared/notification-contract';

/**
 * Notifications, generated from the registry (HIVE-75).
 *
 * ## Why this is its own section
 *
 * It used to be a group at the bottom of Integrations, which was right when it
 * held three switches about `gh` and the OS notification centre. It now answers
 * for every kind of event the app can raise, from three sources, and a settings
 * pane where the longest list is a footnote under someone else's heading is one
 * where people stop finding it.
 *
 * ## Why nothing here is hand-written
 *
 * The section iterates {@link NOTIFICATION_KIND_SPECS}. It does not know which
 * kinds exist, what they are called, or what they default to — the registry
 * does, and this renders it.
 *
 * That is the whole point of HIVE-75's shape, and it is worth stating as a
 * property rather than a convention: **a kind added to the registry gets a
 * control here without this file being edited, and a kind removed from it
 * cannot leave a dead switch behind.** The previous arrangement had the class
 * list in the contract, the copy in this file, and the defaults in a third
 * place; adding a fourth class meant remembering all three.
 *
 * ## Why three states and not a checkbox
 *
 * "Show me when I look" and "interrupt me" are different asks, and the boolean
 * could only express the second. A user who wants a record of idle sessions
 * without a desktop toast had no way to say so, and their only option was to
 * turn the whole class off — which is how a notification setting quietly
 * becomes a notification you never see.
 */

/**
 * The scale, in escalating order: nothing, a record, an interruption.
 *
 * `both` reads as **System** rather than "Inbox + desktop". The old label
 * described the implementation — two destinations — and made the third option
 * look like a different *kind* of thing from the first two rather than one more
 * step along the same axis. "System" names where the extra reach goes, and
 * every option stays one word wide, which is what lets ten of these stack
 * without the eye having to re-measure each row.
 *
 * The stored value is still `both`: this is a label, and renaming the wire
 * format would strand every config file already on disk.
 */
const DELIVERY_OPTIONS: readonly SegmentedOption<NotificationDelivery>[] = [
  { value: 'off', label: 'Off' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'both', label: 'System' },
];

/** Module scope so the ten rows share one array instead of each building its own. */
const NO_DESKTOP: readonly NotificationDelivery[] = ['both'];

/**
 * How often the pane re-asks main how the OS has been answering.
 *
 * Slow enough to be free — one property read per tick, only while the pane is
 * mounted — and fast enough that a user who opens Settings, watches a session
 * go quiet and sees nothing arrive is told why within a glance rather than
 * after closing and reopening the overlay.
 */
const STATUS_POLL_MS = 4_000;

interface DeliveryControlProps {
  kind: NotificationKind;
  value: NotificationDelivery;
  /** Whether the OS can show a notification at all. */
  desktopAvailable: boolean;
  onChange: (delivery: NotificationDelivery) => void;
}

function DeliveryControl({
  kind,
  value,
  desktopAvailable,
  onChange,
}: DeliveryControlProps) {
  const spec = NOTIFICATION_KIND_SPECS[kind];

  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="flex min-w-0 flex-col">
        <span className="text-[12.5px] text-ink">{spec.label}</span>
        <span className="text-[11.5px] leading-[1.4] text-subtle">
          {spec.description}
        </span>
      </div>

      {/*
        The same segmented control the appearance and editor panes use, rather
        than this section's own row of pills. Three options is below the count
        where a dropdown earns its extra click, the states are worth reading at
        a glance when scanning ten rows for the one that is switched off, and a
        pane where two sections draw the same choice two different ways is one
        where neither reads as the app's own.

        It also brings the keyboard behaviour this row never had: arrow keys,
        Home/End, and a single tab stop per group instead of three.

        The desktop option is disabled rather than hidden when the OS cannot
        present one. Hiding it would silently change what the control means
        between two machines; disabling it says the option exists and this box
        cannot honour it.
      */}
      <SegmentedControl
        label={spec.label}
        options={DELIVERY_OPTIONS}
        value={value}
        onChange={onChange}
        disabledValues={desktopAvailable ? undefined : NO_DESKTOP}
        className="shrink-0"
      />
    </div>
  );
}

export function NotificationsSection() {
  const snapshot = useProjectConfig();
  const [status, setStatus] = useState<NotificationDeliveryStatus | null>(null);

  /**
   * Re-read while the pane is open, not once on mount.
   *
   * `refused` is populated **lazily** in main — it cannot be known until a
   * `both`-delivery notification has actually been attempted and turned down.
   * A single read on mount therefore has a hole shaped exactly like the user
   * this note exists for: they open Settings → Notifications to find out why
   * nothing arrives, at which point nothing has been attempted this launch and
   * the field is `null`; a session raises one thirty seconds later, macOS
   * refuses it, and the pane they are still looking at goes on saying nothing.
   * They would have to close and reopen Settings to be told.
   *
   * **`notifications.delivery()`, not `integrations.status()`** — the two carry
   * the same pair of facts, and the second one *executes `gh`* to build the
   * rest of its answer. Polling that would spawn a subprocess every few seconds
   * to read a variable, which is a worse bug than the staleness it fixes. The
   * dedicated verb exists precisely so this loop is free.
   */
  useEffect(() => {
    let live = true;

    const read = (): void => {
      void readNotificationDelivery().then((next) => {
        if (live) setStatus(next);
      });
    };

    read();
    const timer = setInterval(read, STATUS_POLL_MS);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  /**
   * No snapshot is the browser demo, where there is no config file to write to.
   *
   * Registry defaults are shown rather than an error: the controls describe
   * what the desktop app *would* do, and a pane that refuses to render is a
   * worse answer than one that cannot save.
   */
  const prefs = snapshot?.notifications ?? {};
  const desktopAvailable = status === null || status.supported;

  return (
    /*
      The same shell every other pane uses (`appearance`, `editor`,
      `integrations`, …). The overlay mounts panes bare and adds no padding of
      its own, so a section that omits this runs its rows edge to edge and
      scrolls the wrong box — which is exactly what this one did.
    */
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
      <SettingsSectionHeader
        title="Notifications"
        description="Which events reach you, and which are allowed to interrupt."
      />

      {status !== null && !status.supported ? (
        <p className="text-[12.5px] text-amber">
          This system cannot show desktop notifications, so the
          &ldquo;System&rdquo; option would have no effect. On Linux this usually
          means no notification daemon is running — the inbox itself still works.
        </p>
      ) : null}

      {/*
        Only when support was *claimed* and delivery was then refused. The two
        notes are mutually exclusive by construction, and this is the one that
        describes the case the app used to hide: the API
        says notifications are supported, the OS drops every one of them, and
        without this the pane goes on offering a switch that has never done
        anything. The dock badge and bounce still fire, which is why the last
        sentence is the useful part rather than an apology.
      */}
      {status !== null && status.supported && status.refused !== null ? (
        <p className="text-[12.5px] text-amber">
          The system refused this app&rsquo;s last desktop notification
          &mdash;&nbsp;
          <span className="text-subtle">{status.refused}</span>
          . Notifications set to &ldquo;System&rdquo; still reach the inbox, and
          still badge and bounce the dock icon.
        </p>
      ) : null}

      {NOTIFICATION_SOURCE_ORDER.map((source) => {
        const kinds = kindsForSource(source);
        // A source with no registered kinds renders nothing rather than an
        // empty heading — which is what keeps `slack` out of the pane until
        // HIVE-77 gives it a producer.
        if (kinds.length === 0) return null;

        return (
          <SettingsGroup
            key={source}
            title={NOTIFICATION_SOURCE_LABELS[source]}
            description={SOURCE_DESCRIPTIONS[source]}
          >
            <div className="flex flex-col divide-y divide-border-soft">
              {kinds.map((kind) => (
                <DeliveryControl
                  key={kind}
                  kind={kind}
                  value={prefs[kind] ?? NOTIFICATION_KIND_SPECS[kind].defaultDelivery}
                  desktopAvailable={desktopAvailable}
                  onChange={(delivery) => {
                    // One kind per call, so saving one control cannot restate
                    // another — the write path is partial all the way down.
                    void setNotificationPrefs({ [kind]: delivery });
                  }}
                />
              ))}
            </div>
          </SettingsGroup>
        );
      })}
    </div>
  );
}

/** What each group is about. Not on the spec: it describes a source, not a kind. */
const SOURCE_DESCRIPTIONS: Record<string, string> = {
  session: 'The fleet asking for you, or telling you it is done.',
  github: 'Pull requests across the repositories your projects map to.',
  agent: 'Anything a background agent posts to the local notify endpoint.',
  app: 'The Hive itself.',
};
