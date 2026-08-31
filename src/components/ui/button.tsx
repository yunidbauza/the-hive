import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * The button this app has been writing by hand (HIVE-118).
 *
 * Not a new look: `primary` is the class string that already appears verbatim
 * in eleven settings panes, lifted unchanged so that adopting it there is a
 * no-op diff rather than a restyle. What the atom adds is one owner for the
 * three states every hand-rolled copy had to reinvent — focus ring, disabled,
 * and the danger tone.
 *
 * `type="button"` by default, and overridable. A bare `<button>` inside a
 * `<form>` submits it, which is never what a card's option row means.
 */
// `primary`'s border is transparent, not absent: the idiom it was lifted from
// has none, but this atom sits primary beside bordered secondary/danger
// buttons in one row, and a borderless primary would sit 2px shorter than its
// neighbours.
const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-fill text-on-brand hover:bg-brand-fill-hover border border-transparent',
  secondary:
    'border border-border text-muted hover:bg-hover hover:text-ink',
  danger:
    'border border-border-soft text-red hover:bg-hover',
  ghost: 'border border-transparent text-muted hover:bg-hover hover:text-ink',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'rounded-[6px] px-2.5 py-1 text-[11px]',
  md: 'rounded-md px-3 py-1.5 text-[12.5px]',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'shrink-0 leading-none disabled:opacity-60',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    />
  );
}
