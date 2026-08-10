/**
 * Merge a component's base classes with a caller's override.
 *
 * Tailwind utilities all carry the same CSS specificity, so a class list
 * containing both `py-4` and `py-2.5` does not give you py-2.5 — it gives you
 * whichever Tailwind emitted later in its stylesheet, which is py-4. Ordering
 * inside the class attribute is irrelevant.
 *
 * That made every attempt to shrink a shared component a silent no-op. Ten call
 * sites in this app passed `py-2`, `py-2.5`, `py-3` or `text-base` to a
 * <Button> and every one of them did nothing: the buttons all rendered at the
 * base `py-4 text-xl`, and no code looked wrong anywhere.
 *
 * Removing the conflicting base class makes `className` behave the way callers
 * already assumed it did.
 */

// Font-size utilities specifically. `text-` also begins `text-white` and
// `text-red-600`, and stripping the base font size whenever someone sets a
// colour would shrink the label for reasons nobody could trace.
const FONT_SIZES = 'xs|sm|base|lg|xl|[2-9]xl';

// Longest prefix first: `px-` and `py-` must be tested before the bare `p-`,
// or `p-` would also match and strip them.
const PREFIXES = ['px', 'py', 'p', 'rounded'];

const tokenRe = (prefix) =>
  new RegExp(`(?:^|\\s)${prefix}-[\\w.[\\]/-]+(?=\\s|$)`, 'g');

const fontRe = () =>
  new RegExp(`(?:^|\\s)text-(?:${FONT_SIZES})(?=\\s|$)`, 'g');

/**
 * @param {string} base component defaults
 * @param {string} override caller-supplied classes; these win
 * @returns {string} the merged list, with superseded base classes removed
 */
export function resolveClasses(base, override = '') {
  if (!override) return base.replace(/\s+/g, ' ').trim();

  let out = base;

  for (const prefix of PREFIXES) {
    /*
     * Only unprefixed utilities in the override count as replacements. A caller
     * passing just `md:py-8` is adding a rule above the md breakpoint and
     * saying nothing about small screens — stripping the base would leave the
     * element with no padding at all on a phone, the exact opposite of what
     * was asked for.
     */
    if (!tokenRe(prefix).test(override)) continue;
    out = out.replace(tokenRe(prefix), ' ');
  }

  if (fontRe().test(override)) out = out.replace(fontRe(), ' ');

  return `${out} ${override}`.replace(/\s+/g, ' ').trim();
}
