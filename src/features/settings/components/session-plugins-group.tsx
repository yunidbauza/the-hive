import { Switch } from '@components/ui/switch';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { useProjectConfig } from '@hooks/use-project-config';
import { useSkills } from '@hooks/use-skills';
import { setSessionPluginInConfig } from '@lib/project-config';

/**
 * "Plugins in Hive sessions" (HIVE-176): one switch per installed Claude Code
 * plugin. Off means a session the Hive starts does not load it, so its skills
 * cannot compete with the Hive's own; `claude` started anywhere else is
 * unchanged. Each switch sends its own plugin; main computes the list.
 */
export function SessionPluginsGroup() {
  const skills = useSkills();
  const config = useProjectConfig();

  // Nothing to list without a registry (the browser target) or a config.
  if (skills?.plugins === undefined || config === null) return null;

  const disabled = config.disabledSessionPlugins;
  const plugins = skills.plugins;

  return (
    <SettingsGroup
      title="Plugins in Hive sessions"
      description="A plugin switched off here does not load in the sessions The Hive starts, so its skills cannot compete with the Hive's own. On means The Hive does not block it; a plugin you disabled in Claude Code stays off. Claude started anywhere else is unchanged. Applies to the next session."
    >
      {plugins.length === 0 ? (
        <p className="text-[11.5px] text-subtle">No Claude Code plugins are installed.</p>
      ) : (
        /*
          Bounded and scrolling on its own: sixteen plugins at a switch row
          each would otherwise push the skills list and the editor out of a
          pane that does not scroll.
        */
        <div className="flex max-h-44 flex-col divide-y divide-border-soft overflow-y-auto pr-1">
          {plugins.map((name) => (
            <Switch
              key={name}
              label={name}
              checked={!disabled.includes(name)}
              onCheckedChange={(on) => void setSessionPluginInConfig({ plugin: name, off: !on })}
            />
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}
