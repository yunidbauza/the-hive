import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names, resolving conflicting Tailwind utilities in
 * favour of the last one supplied.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * What a renderer surface says when the bridge call itself failed, as opposed
 * to main refusing it. One sentence, so no surface phrases "the app is broken"
 * its own way.
 */
export const BRIDGE_ERROR = 'The app could not reach its own main process.';
