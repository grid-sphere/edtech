import React from 'react';
import { resolveClasses } from '../../utils/classes';

/**
 * Any prop not named here used to be silently dropped — most importantly
 * `disabled`, which every caller passes to block double submissions. The
 * button stayed live while a request was in flight.
 */
export default function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  className = '',
  disabled = false,
  ...rest
}) {
  /*
   * min-h-11 is 44px, the smallest reliably tappable target. It is a minimum
   * rather than a height, so a caller shrinking the padding gets a button that
   * is still usable with a thumb instead of one that quietly becomes too small
   * to hit.
   */
  const baseStyles = "brutal-border rounded-xl px-6 py-4 min-h-11 font-bold text-xl flex items-center justify-center gap-2 transition-all shadow-[4px_4px_0px_0px_#111] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0px_0px_#111] active:shadow-none active:translate-x-[4px] active:translate-y-[4px]";
  const variants = {
    primary: "bg-[#F9E076] hover:bg-[#A7E2D1]",
    secondary: "bg-[#A7E2D1]",
    accent: "bg-[#F26B4D]",
  };
  const disabledStyles = disabled
    ? "opacity-50 cursor-not-allowed hover:translate-x-0 hover:translate-y-0 hover:shadow-[4px_4px_0px_0px_#111]"
    : "";

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={resolveClasses(`${baseStyles} ${variants[variant]} ${disabledStyles}`, className)}
      {...rest}
    >
      {children}
    </button>
  );
}