import {
  CalendarCheck,
  CaretDown,
  CaretRight,
  ChatCircleDots,
  CheckCircle,
  Cube,
  GitPullRequest,
  GlobeHemisphereWest,
  HandPalm,
  Lightning,
  PaperPlaneTilt,
  PlusCircle,
  Question,
  SlackLogo,
  Stack,
  Swatches,
  UsersThree,
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
