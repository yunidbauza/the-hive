import {
  ArrowDown,
  ArrowUp,
  ArrowsClockwise,
  ArrowsInSimple,
  CalendarCheck,
  CaretDown,
  CaretRight,
  ChatCircleDots,
  CheckCircle,
  Cube,
  DownloadSimple,
  File,
  FileCode,
  FileCss,
  FileHtml,
  FileImage,
  FileJs,
  FileJsx,
  FileMd,
  FilePy,
  FileSql,
  FileText,
  FileTs,
  FileTsx,
  FileZip,
  FloppyDisk,
  Folder,
  FolderOpen,
  Gear,
  GitPullRequest,
  GlobeHemisphereWest,
  HandPalm,
  Keyboard,
  Lightning,
  Moon,
  PaperPlaneTilt,
  PlusCircle,
  ArrowCircleUp,
  ArrowClockwise,
  Question,
  Repeat,
  RepeatOnce,
  Robot,
  SlackLogo,
  Stack,
  Swatches,
  Terminal,
  UsersThree,
  Warning,
  X,
  XCircle,
  type Icon as PhosphorIcon,
  type IconWeight,
} from '@phosphor-icons/react';

/**
 * Phosphor icon names as the fixtures spell them, mapped to components.
 *
 * The fixtures carry icons as strings (`'ph-slack-logo'`) because they were
 * ported verbatim from the concept, which used the phosphor **webfont** and
 * could put the name straight into a class. This app ships the React package
 * instead — there is no webfont — so something has to bridge the two, and a
 * lookup table beats scattering `<SlackLogo />` imports through feature slices
 * that only ever learn the name at runtime.
 *
 * Every name here appears in `src/data/fixtures.ts`. Adding a fixture icon means
 * adding it here, or it renders as the fallback.
 */
const GLYPHS: Record<string, PhosphorIcon> = {
  // Disclosure — the projects panel's caret (031).
  'ph-caret-down': CaretDown,
  'ph-caret-right': CaretRight,

  // Projects (031).
  'ph-globe-hemisphere-west': GlobeHemisphereWest,
  'ph-cube': Cube,
  'ph-folder': Folder,
  'ph-users-three': UsersThree,
  'ph-swatches': Swatches,
  'ph-stack': Stack,

  // Agents (033).
  'ph-slack-logo': SlackLogo,
  'ph-git-pull-request': GitPullRequest,
  'ph-calendar-check': CalendarCheck,

  // Notifications and feed (051, 053).
  'ph-hand-palm': HandPalm,
  'ph-chat-circle-dots': ChatCircleDots,
  'ph-check-circle': CheckCircle,
  'ph-plus-circle': PlusCircle,
  'ph-paper-plane-tilt': PaperPlaneTilt,
  'ph-lightning': Lightning,
  'ph-arrows-clockwise': ArrowsClockwise,
  'ph-robot': Robot,

  /*
    HIVE-75's kinds. Every one of these is named by a
    `NOTIFICATION_KIND_SPECS` entry rather than by a fixture — which is what
    the note above now means by "adding a fixture icon means adding it here":
    the registry is the list, and a kind whose glyph is missing renders the
    fallback question mark in plain sight.
  */
  'ph-moon': Moon,
  'ph-x-circle': XCircle,
  'ph-download-simple': DownloadSimple,

  // A session that has run out of instructions and is waiting
  // on the user to type. A keyboard, because that is what it wants.
  'ph-keyboard': Keyboard,

  /*
    The app's own two kinds. Caught by the fallback in exactly the way the note
    above promises: the packaged app showed a question mark where the update
    row's glyph should have been, because registering a kind in
    `notification-contract.ts` does not register its icon here.
  */
  'ph-arrow-circle-up': ArrowCircleUp,
  'ph-arrow-clockwise': ArrowClockwise,

  /**
   * The project explorer and the editor.
   *
   * The file glyphs are keyed by *language*, not by extension: `.ts`,
   * `.mts` and `.cts` all resolve to one language upstream and therefore to
   * one icon here. Phosphor has no glyph for most languages, which is why
   * `ph-file-code` is the fallback and only the handful it does have get a
   * distinct one — a made-up icon per language would be noise in a 316px rail.
   */
  // `ph-folder` is already above, as a project icon — one glyph, two uses.
  'ph-folder-open': FolderOpen,
  'ph-file': File,
  'ph-file-code': FileCode,
  'ph-file-text': FileText,
  'ph-file-js': FileJs,
  'ph-file-jsx': FileJsx,
  'ph-file-ts': FileTs,
  'ph-file-tsx': FileTsx,
  'ph-file-css': FileCss,
  'ph-file-html': FileHtml,
  'ph-file-md': FileMd,
  'ph-file-py': FilePy,
  'ph-file-sql': FileSql,
  'ph-file-image': FileImage,
  'ph-file-zip': FileZip,
  'ph-gear': Gear,
  'ph-terminal': Terminal,
  'ph-floppy-disk': FloppyDisk,
  'ph-arrows-in-simple': ArrowsInSimple,
  'ph-warning': Warning,
  'ph-x': X,
  'ph-arrow-up': ArrowUp,
  'ph-arrow-down': ArrowDown,
  'ph-repeat': Repeat,
  'ph-repeat-once': RepeatOnce,
};

interface IconProps {
  /** A phosphor name as the fixtures spell it, e.g. `'ph-slack-logo'`. */
  name: string;
  /** Pixel size. Phosphor defaults to `1em`; every caller here is explicit. */
  size?: number;
  weight?: IconWeight;
  className?: string;
}

/**
 * A fixture-named phosphor icon.
 *
 * **Always decorative.** Every icon in this app sits beside the text it
 * illustrates — a project name, an agent id, a status label — so it is hidden
 * from the accessibility tree rather than announcing a duplicate. An icon that
 * needs to carry meaning on its own needs a labelled sibling, not an `alt` here.
 *
 * An unknown name renders a question mark rather than throwing or rendering
 * nothing: a missing glyph should be visible in review, not a silent gap.
 */
export function Icon({ name, size, weight, className }: IconProps) {
  const Glyph = GLYPHS[name] ?? Question;

  return (
    <Glyph aria-hidden="true" size={size} weight={weight} className={className} />
  );
}
