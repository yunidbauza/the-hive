import type { Tone } from '@/types/notification';

/** One line in the orchestrator's activity feed. */
export interface FeedItem {
  time: string;
  txt: string;
  tone: Tone;
  icon: string;
}
