/**
 * What the user changed in the agents and skills the app ships.
 *
 * The seed merges a shipped `AGENT.md` or `SKILL.md` into the user's copy one
 * frontmatter key at a time plus the body (`electron/main/seed/merge.ts`).
 * This is the renderer's view of that merge per agent or skill, and the three
 * things Settings can do about it: reset to the shipped file, take the
 * shipped prompt, or keep the user's version and stop flagging it.
 */

export const SHIPPED_KINDS = ['agents', 'skills'] as const;

export type ShippedKind = (typeof SHIPPED_KINDS)[number];

/** A frontmatter part the user holds at a value other than the shipped one. */
export interface ShippedPart {
  /** `model`, or `limits.parallel` for a child of a block. */
  path: string;
  yours: string;
  /** `null` when the app does not ship this key. */
  shipped: string | null;
}

export interface ShippedStatus {
  kind: ShippedKind;
  name: string;
  customised: ShippedPart[];
  /** Customised parts whose shipped value changed since the user's edit. */
  moved: string[];
  /** Other files in a skill's folder that differ from the shipped copy. */
  files: string[];
  bodyEdited: boolean;
  /** The body is the user's and a newer shipped one is waiting. */
  held: boolean;
  /** The shipped body, for Compare. */
  shippedBody: string;
}

export interface ShippedRequest {
  kind: ShippedKind;
  name: string;
}

/** Whether a status has anything for Settings to show. */
export const isCustomised = (status: ShippedStatus): boolean =>
  status.customised.length > 0 || status.bodyEdited || status.files.length > 0;
