import { describe, expect, it } from 'vitest';

import {
  contextMeter,
  contextPct,
  modelLabel,
  utilisationPct,
} from '@/lib/session-metrics';

describe('session metrics', () => {
  describe('modelLabel', () => {
    it('maps every model id to its display name', () => {
      expect(modelLabel('opus')).toBe('Opus 4.5');
      expect(modelLabel('sonnet')).toBe('Sonnet 4.5');
      expect(modelLabel('haiku')).toBe('Haiku 4.5');
      expect(modelLabel('fable')).toBe('Fable 1');
    });

    it('falls back to Opus when a session carries no model', () => {
      expect(modelLabel()).toBe('Opus 4.5');
    });
  });

  describe('contextPct', () => {
    it('is deterministic — the same session always reads the same', () => {
      expect(contextPct('hero-refresh', 'feat/hero-refresh')).toBe(
        contextPct('hero-refresh', 'feat/hero-refresh'),
      );
    });

    it('differs between sessions', () => {
      expect(contextPct('hero-refresh', 'feat/hero-refresh')).not.toBe(
        contextPct('nplusone', 'feat/nplusone'),
      );
    });

    it('stays inside the 5–64% band for any input', () => {
      for (const id of ['a', 'hero-refresh', 'x'.repeat(120), '']) {
        const pct = contextPct(id, `feat/${id}`);
        expect(pct).toBeGreaterThanOrEqual(5);
        expect(pct).toBeLessThanOrEqual(64);
      }
    });
  });

  describe('utilisationPct', () => {
    it('stays inside the 1–8% band for any input', () => {
      for (const id of ['a', 'hero-refresh', 'x'.repeat(120), '']) {
        const pct = utilisationPct(id);
        expect(pct).toBeGreaterThanOrEqual(1);
        expect(pct).toBeLessThanOrEqual(8);
      }
    });
  });

  describe('contextMeter', () => {
    it('renders a ten-character bar proportional to the percentage', () => {
      expect(contextMeter(0)).toBe('░░░░░░░░░░');
      expect(contextMeter(32)).toBe('███░░░░░░░');
      expect(contextMeter(50)).toBe('█████░░░░░');
      expect(contextMeter(100)).toBe('██████████');
    });

    it('never changes width, whatever the input', () => {
      for (const pct of [-40, 0, 4, 47, 99, 100, 250]) {
        expect([...contextMeter(pct)]).toHaveLength(10);
      }
    });

    it('clamps out-of-range percentages rather than repeating negatively', () => {
      expect(contextMeter(-10)).toBe('░░░░░░░░░░');
      expect(contextMeter(160)).toBe('██████████');
    });
  });
});
