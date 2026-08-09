import { useEffect, useState } from 'react';

import { SettingsGroup } from '@features/settings/components/settings-group';
import { useProjectConfig } from '@hooks/use-project-config';
import { readIntegrationsStatus, setNotificationPrefs } from '@lib/project-config';
import type { IntegrationsStatus } from '@shared/ipc-contract';
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

const DELIVERY_OPTIONS: { value: NotificationDelivery; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'both', label: 'Inbox + desktop' },
];

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
  const name = `notification-${kind}`;

  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="flex min-w-0 flex-col">
        <span className="text-[12.5px] text-ink">{spec.label}</span>
        <span className="text-[11.5px] leading-[1.4] text-subtle">
          {spec.description}
        </span>
      </div>

      {/*
        A radio group, not a select. Three options is below the count where a
        dropdown earns its extra click, and the states are worth reading at a
        glance when scanning ten rows for the one that is switched off.
      */}
      <div
        role="radiogroup"
        aria-label={spec.label}
        className="flex shrink-0 gap-1"
      >
        {DELIVERY_OPTIONS.map((option) => {
          /*
            The desktop option is disabled rather than hidden when the OS cannot
            present one. Hiding it would silently change what the control means
            between two machines; disabling it says the option exists and this
            box cannot honour it.
          */
          const unavailable = option.value === 'both' && !desktopAvailable;

          return (
            <label
              key={option.value}
              className={
                option.value === value
                  ? 'cursor-pointer rounded-md bg-active px-2 py-1 text-[11px] text-ink'
                  : unavailable
                    ? 'cursor-not-allowed rounded-md px-2 py-1 text-[11px] text-subtle opacity-50'
                    : 'cursor-pointer rounded-md px-2 py-1 text-[11px] text-muted hover:bg-hover'
              }
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={option.value === value}
                disabled={unavailable}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function NotificationsSection() {
  const snapshot = useProjectConfig();
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);

  useEffect(() => {
    let live = true;
    void readIntegrationsStatus().then((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
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
  const desktopAvailable = status === null || status.notificationsSupported;

  return (
    <div className="flex flex-col gap-6">
      {status !== null && !status.notificationsSupported ? (
        <p className="text-[12.5px] text-amber">
          This system cannot show desktop notifications, so the
          &ldquo;Inbox&nbsp;+&nbsp;desktop&rdquo; option would have no effect. On
          Linux this usually means no notification daemon is running — the inbox
          itself still works.
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
