import type { Model } from '@/types/entity';

/**
 * The numbers behind the header's model chip.
 *
 * In this phase they are mock: there is no token meter to read, so the values
 * are *derived* from the session's own identifiers rather than stored. That is
 * a deliberate choice carried over from the concept — a stored percentage
 * would need a fake clock to move it, and a random one would jitter on every
 * render and make the header impossible to snapshot. Deriving keeps a session's
 * chip stable for its whole life while still differing between sessions.
 *
 * When real metering arrives it replaces the bodies here and nothing else:
 * `ctx` and `util` become fields on `Session`, and these functions read them.
 */

/** Model id → the name shown to the user. */
const MODEL_LABELS: Record<Model, string> = {
  opus: 'Opus 4.5',
  sonnet: 'Sonnet 4.5',
  haiku: 'Haiku 4.5',
  fable: 'Fable 1',
};

/** Sessions with no explicit model are Opus at high effort, as in the concept. */
export const DEFAULT_MODEL: Model = 'opus';
export const DEFAULT_EFFORT = 'high';

/** Width of the context meter, in characters. */
const METER_WIDTH = 10;

export function modelLabel(model: Model = DEFAULT_MODEL): string {
  return MODEL_LABELS[model];
}

/**
 * Context used, 5–64%.
 *
 * The formula is the concept's, kept verbatim so the prototype's chips read
 * exactly as the design did.
 */
export function contextPct(id: string, branch: string): number {
  return 5 + ((id.length * 7 + branch.length * 13) % 60);
}

/** Weekly-limit utilisation, 1–8%. */
export function utilisationPct(id: string): number {
  return 1 + ((id.length * 3) % 8);
}

/**
 * A 10-character bar: `███░░░░░░░`.
 *
 * Rounded to the nearest tenth, so the filled and empty runs always total
 * `METER_WIDTH` and the chip never changes width.
 */
export function contextMeter(pct: number): string {
  const filled = Math.round((pct / 100) * METER_WIDTH);
  const clamped = Math.min(Math.max(filled, 0), METER_WIDTH);
  return '█'.repeat(clamped) + '░'.repeat(METER_WIDTH - clamped);
}
