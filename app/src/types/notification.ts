export type Tone = 'amber' | 'green' | 'brand' | 'red';

/** An inbox entry — something that wants the user's attention. */
export interface Notification {
  icon: string;
  tone: Tone;
  title: string;
  sub: string;
  time: string;
  unread: boolean;
  target: string; // entity id to open on click
}
