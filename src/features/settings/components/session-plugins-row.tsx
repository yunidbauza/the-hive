import { useState } from 'react';

import { Chip } from '@components/ui/chip';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@components/ui/dialog';
import { Switch } from '@components/ui/switch';
import { TextField } from '@components/ui/text-field';
import { useProjectConfig } from '@hooks/use-project-config';
import { useSkills } from '@hooks/use-skills';
import { setSessionPluginInConfig } from '@lib/project-config';
import { cn } from '@lib/utils';
import { DEFAULT_DISABLED_SESSION_PLUGINS } from '@shared/config-contract';

/**
 * How many off plugins the row names before it counts them instead, and the
 * width budget those names share, in characters (each chip's padding counts as
 * three). Past either, one "<n> plugins" chip replaces the names, so the row
 * never pushes the Manage button off the pane. Two or three short names fit;
 * three long ones (`svg-logo-designer`, `ui-ux-pro-max`, …) do not. A row too
 * narrow for even the names that fit shows the count too (a container query).
 */
const NAMED_MAX = 3;
const NAMED_CHARS = 36;
const CHIP_CHARS = 3;

const DESCRIPTION =
  "A plugin switched off here does not load in the sessions The Hive starts, so its skills cannot compete with the Hive's own. On means The Hive does not block it; a plugin you disabled in Claude Code stays off. Claude started anywhere else is unchanged. Applies to the next session.";

/** Whether the off plugins are named one chip each, or counted in one. */
export function namesFit(off: readonly string[]): boolean {
  const chars = off.reduce((sum, name) => sum + name.length + CHIP_CHARS, 0);
  return off.length <= NAMED_MAX && chars <= NAMED_CHARS;
}

/**
 * The installed Claude Code plugins a Hive session leaves out (HIVE-176),
 * as one row under the Skills header with a dialog behind it (HIVE-177).
 *
 * It was a switch list under the skills editor, and sixteen plugins took the
 * room the editor needs. Now the row says what is off and "Manage Installed
 * Plugins" opens the switches. Each switch sends its own plugin; main computes
 * the list.
 */
export function SessionPluginsRow() {
  const skills = useSkills();
  const config = useProjectConfig();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  // Nothing to list without a registry (the browser target) or a config.
  if (skills?.plugins === undefined || config === null) return null;

  const plugins = skills.plugins;
  const disabled = config.disabledSessionPlugins;
  // Only installed plugins: the config can name one that was since uninstalled.
  const off = plugins.filter((name) => disabled.includes(name));
  const query = filter.trim().toLowerCase();
  const shown = plugins.filter((name) => name.toLowerCase().includes(query));

  if (plugins.length === 0) {
    return <p className="text-[11.5px] text-subtle">No Claude Code plugins are installed.</p>;
  }

  return (
    <div className="@container flex items-center gap-2.5 rounded-[6px] border border-border-soft bg-panel px-2.5 py-1.5 text-[11.5px]">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
        <span className="shrink-0 text-subtle">Off in Hive sessions:</span>
        {off.length === 0 ? (
          <span className="text-subtle">none</span>
        ) : (
          <>
            {/*
              The names need the row at 620px or wider: the label and the
              button take ~360px, and NAMED_CHARS the rest. Narrower, the count
              stands in, so a name is never truncated.
            */}
            {namesFit(off) ? (
              <span className="hidden items-center gap-1.5 @min-[620px]:flex">
                {off.map((name) => (
                  <Chip key={name} className="px-2 py-0">
                    {name}
                  </Chip>
                ))}
              </span>
            ) : null}
            <Chip
              title={off.join(', ')}
              className={cn('px-2 py-0', namesFit(off) && '@min-[620px]:hidden')}
            >
              {off.length} {off.length === 1 ? 'plugin' : 'plugins'}
            </Chip>
          </>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFilter('');
        }}
      >
        {/* A trigger, so closing the dialog returns focus to this button. */}
        <DialogTrigger asChild>
          <button type="button" className="shrink-0 text-brand hover:underline">
            Manage Installed Plugins
          </button>
        </DialogTrigger>

        <DialogContent
          showCloseButton={false}
          className="gap-0 border-border bg-panel p-0 sm:max-w-[560px]"
        >
          <DialogHeader className="gap-1 border-b border-border-soft px-3.5 pt-3 pb-2.5">
            <DialogTitle className="text-[13px] font-semibold text-ink">
              Manage Installed Plugins
            </DialogTitle>
            <DialogDescription className="text-[11.5px] text-subtle">{DESCRIPTION}</DialogDescription>
          </DialogHeader>

          <div className="flex items-end gap-2.5 px-3.5 pt-2.5">
            <TextField
              label="Filter plugins"
              value={filter}
              onChange={setFilter}
              className="w-52"
            />
            <span className="pb-1.5 text-[11.5px] tabular-nums text-subtle">
              {plugins.length} installed · {off.length} off
            </span>
          </div>

          <div className="grid max-h-72 grid-cols-2 gap-x-6 overflow-y-auto px-3.5 py-2">
            {shown.length === 0 ? (
              <p className="col-span-2 py-1 text-[11.5px] text-subtle">
                No plugin matches “{filter.trim()}”.
              </p>
            ) : (
              shown.map((name) => (
                <Switch
                  key={name}
                  label={name}
                  description={
                    DEFAULT_DISABLED_SESSION_PLUGINS.includes(name)
                      ? "Off by default: its skills duplicate the Hive's."
                      : undefined
                  }
                  checked={!disabled.includes(name)}
                  onCheckedChange={(on) => void setSessionPluginInConfig({ plugin: name, off: !on })}
                />
              ))
            )}
          </div>

          <DialogFooter className="border-t border-border-soft px-3.5 py-2.5">
            <DialogClose className="rounded-[3px] border border-border bg-panel-2 px-[11px] py-[5px] text-[12px] text-ink hover:bg-hover">
              Done
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
