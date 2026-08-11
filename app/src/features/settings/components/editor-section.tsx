import {
  SegmentedControl,
  type SegmentedOption,
} from '@components/ui/segmented-control';
import { SelectField, type SelectFieldOption } from '@components/ui/select-field';
import { Switch } from '@components/ui/switch';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { SettingsSectionHeader } from '@features/settings/components/settings-section-header';
import { TERMINAL_FONTS, type TerminalFontId } from '@lib/terminal/fonts';
import {
  EDITOR_FONT_SIZES,
  EDITOR_TAB_WIDTHS,
  useEditorSettingsActions,
  useEditorSettings,
  type EditorNav,
  type EditorPlacement,
  type EditorSplitAxis,
} from '@stores/appearance-store';

/**
 * Editor — the settings for the file viewer the explorer opens into.
 *
 * Its own section rather than a group inside Appearance. Appearance is about
 * how the app *looks*; three of the five controls here change what the editor
 * **does** — where it goes, how many files it holds, and whether it can write
 * to disk. Filing "can this edit my files" under a heading about fonts is how a
 * setting gets changed by someone who was not looking for it.
 *
 * Like Appearance, every control writes straight to `appearance-store` and
 * persists itself: nothing crosses a process boundary, so there is no save
 * button and no refusal to report.
 */

const PLACEMENT_OPTIONS: readonly SegmentedOption<EditorPlacement>[] = [
  { value: 'full', label: 'Full stage' },
  { value: 'split', label: 'Split' },
];

const AXIS_OPTIONS: readonly SegmentedOption<EditorSplitAxis>[] = [
  { value: 'vertical', label: 'Side by side' },
  { value: 'horizontal', label: 'Stacked' },
];

const NAV_OPTIONS: readonly SegmentedOption<EditorNav>[] = [
  { value: 'tabs', label: 'Tabs' },
  { value: 'single', label: 'One at a time' },
];

const FONT_OPTIONS: readonly SelectFieldOption[] = TERMINAL_FONTS.map((font) => ({
  value: font.id,
  label: font.label,
}));

const SIZE_OPTIONS: readonly SelectFieldOption[] = EDITOR_FONT_SIZES.map((size) => ({
  value: String(size),
  label: `${size} pt`,
}));

const TAB_WIDTH_OPTIONS: readonly SelectFieldOption[] = EDITOR_TAB_WIDTHS.map(
  (width) => ({ value: String(width), label: `${width} spaces` }),
);

export function EditorSection() {
  const settings = useEditorSettings();
  const {
    setEditorPlacement,
    setEditorSplitAxis,
    setEditorNav,
    setEditorEditable,
    setEditorFont,
    setEditorFontSize,
    setEditorWordWrap,
    setEditorLineNumbers,
    setEditorTabWidth,
  } = useEditorSettingsActions();

  const split = settings.editorPlacement === 'split';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <SettingsSectionHeader
        title="Editor"
        description="Opened from the Explorer tab in the right rail."
      />

      <SettingsGroup
        title="Placement"
        description="Full stage hides the terminal while a file is open, with a Terminal tab to get back. Split keeps both on screen."
      >
        <div className="flex flex-col gap-3">
          <SegmentedControl
            label="Placement"
            options={PLACEMENT_OPTIONS}
            value={settings.editorPlacement}
            onChange={setEditorPlacement}
          />

          {/*
            Present but disabled rather than hidden when placement is Full.

            Hiding it would make the Split option feel like it did nothing the
            first time it was clicked — the control it enables would appear
            somewhere the eye was not, one frame later. Disabled says "this
            belongs to the choice above" without moving anything.
          */}
          <SegmentedControl
            label="Split direction"
            options={AXIS_OPTIONS}
            value={settings.editorSplitAxis}
            onChange={setEditorSplitAxis}
            disabled={!split}
          />

          {split ? (
            <p className="text-[11.5px] text-subtle">
              Drag the divider to resize. Side by side leaves the terminal
              roughly half the stage — narrow enough that long agent output
              wraps.
            </p>
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Open files"
        description="Tabs keeps several files open. One at a time replaces the open file and closes on Escape."
      >
        <SegmentedControl
          label="Open files"
          options={NAV_OPTIONS}
          value={settings.editorNav}
          onChange={setEditorNav}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Editing"
        description="Off by default: in this app the thing editing your files is usually the agent in the terminal."
      >
        <Switch
          label="Allow editing"
          description="Adds ⌘S. A file changed on disk while you have unsaved edits is never overwritten without asking."
          checked={settings.editorEditable}
          onCheckedChange={setEditorEditable}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Text"
        description="Independent of the terminal's own font, so the two can differ."
      >
        <div className="grid max-w-[420px] grid-cols-2 gap-3">
          <SelectField
            label="Font"
            value={settings.editorFont}
            options={FONT_OPTIONS}
            onChange={(value) => setEditorFont(value as TerminalFontId)}
          />

          <SelectField
            label="Size"
            value={String(settings.editorFontSize)}
            options={SIZE_OPTIONS}
            onChange={(value) => setEditorFontSize(Number(value))}
          />

          <SelectField
            label="Tab width"
            value={String(settings.editorTabWidth)}
            options={TAB_WIDTH_OPTIONS}
            onChange={(value) => setEditorTabWidth(Number(value))}
            hint="How wide an existing tab character renders."
            className="col-span-2 max-w-[204px]"
          />
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <Switch
            label="Wrap long lines"
            checked={settings.editorWordWrap}
            onCheckedChange={setEditorWordWrap}
          />
          <Switch
            label="Show line numbers"
            checked={settings.editorLineNumbers}
            onCheckedChange={setEditorLineNumbers}
          />
        </div>
      </SettingsGroup>
    </div>
  );
}
