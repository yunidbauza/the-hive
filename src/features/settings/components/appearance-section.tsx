import { SegmentedControl, type SegmentedOption } from '@components/ui/segmented-control';
import { SelectField, type SelectFieldOption } from '@components/ui/select-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { SettingsSectionHeader } from '@features/settings/components/settings-section-header';
import {
  TERMINAL_FONTS,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACKS,
  formatScrollback,
  type TerminalFontId,
} from '@lib/terminal/fonts';
import {
  useAppearanceActions,
  useAppearanceSettings,
  type Density,
  type ThemePreference,
} from '@stores/appearance-store';

/**
 * Appearance — the second settings section (story 105).
 *
 * Every control here writes straight to `appearance-store`, which persists
 * itself. There is no save button and no error state, and that is the whole
 * difference from the Projects section: nothing crosses a process boundary, so
 * there is no refusal to report. A theme change is applied by the time the
 * mouse comes up.
 */

const THEME_OPTIONS: readonly SegmentedOption<ThemePreference>[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const DENSITY_OPTIONS: readonly SegmentedOption<Density>[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

const FONT_OPTIONS: readonly SelectFieldOption[] = TERMINAL_FONTS.map((font) => ({
  value: font.id,
  label: font.label,
}));

const SIZE_OPTIONS: readonly SelectFieldOption[] = TERMINAL_FONT_SIZES.map(
  (size) => ({ value: String(size), label: `${size} pt` }),
);

const SCROLLBACK_OPTIONS: readonly SelectFieldOption[] = TERMINAL_SCROLLBACKS.map(
  (lines) => ({ value: String(lines), label: formatScrollback(lines) }),
);

export function AppearanceSection() {
  const settings = useAppearanceSettings();
  const {
    setTheme,
    setTerminalFont,
    setTerminalFontSize,
    setTerminalScrollback,
    setDensity,
  } = useAppearanceActions();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <SettingsSectionHeader
        title="Appearance"
        description="Stored on this machine, applied immediately."
      />

      <SettingsGroup
        title="Theme"
        description="System follows your operating system and changes with it."
      >
        <SegmentedControl
          label="Theme"
          options={THEME_OPTIONS}
          value={settings.theme}
          onChange={setTheme}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Terminal"
        description="Applied to every open terminal without clearing its scrollback."
      >
        <div className="grid max-w-[420px] grid-cols-2 gap-3">
          <SelectField
            label="Font"
            value={settings.terminalFont}
            options={FONT_OPTIONS}
            onChange={(value) => setTerminalFont(value as TerminalFontId)}
            hint="A face your system does not have falls back to the default."
          />

          <SelectField
            label="Size"
            value={String(settings.terminalFontSize)}
            options={SIZE_OPTIONS}
            onChange={(value) => setTerminalFontSize(Number(value))}
          />

          <SelectField
            label="Scrollback"
            value={String(settings.terminalScrollback)}
            options={SCROLLBACK_OPTIONS}
            onChange={(value) => setTerminalScrollback(Number(value))}
            hint="Kept per open terminal, so this multiplies by your session count."
            className="col-span-2 max-w-[204px]"
          />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Density"
        description="Compact narrows both rails and tightens the rows inside them."
      >
        <SegmentedControl
          label="Density"
          options={DENSITY_OPTIONS}
          value={settings.density}
          onChange={setDensity}
        />
      </SettingsGroup>
    </div>
  );
}
