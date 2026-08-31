/**
 * Course categories, mirroring backend/edtech/constants/courseCategories.js.
 *
 * The five built-ins are duplicated rather than fetched: the filter bar renders
 * on first paint, and a round trip for five fixed strings would leave it empty
 * for a moment on every load.
 *
 * Teachers can add their own, and those exist only in the database. So the
 * built-ins are a starting point, not the whole list — anything that renders
 * the bar should merge in what the API sent (`/home` and `/courses/categories`
 * both return the full set) via `mergeCategories`.
 *
 * The ids must match the backend exactly. If you add a built-in, add it in both.
 */
export const COURSE_CATEGORIES = [
  { id: 'hp_board', label: 'HP Board' },
  { id: 'neet', label: 'NEET' },
  { id: 'jee', label: 'JEE' },
  { id: 'cbse', label: 'CBSE' },
  { id: 'test_series', label: 'Test Series' },
];

/**
 * Reduce a typed label to the id the server will store.
 *
 * Kept in step with slugifyCategory in the backend module of the same name.
 * Duplicated for one reason: the teacher needs to be told what their category
 * will be called *before* they save, and asking the server on every keystroke
 * to answer a question that is pure string manipulation is not worth the
 * round trip. The server slugifies again regardless, so a drift here shows up
 * as a preview that differs from the result, never as a bad write.
 */
export function slugifyCategory(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/g, '');
}

/**
 * The categories to render, from the server when it has answered.
 *
 * Two things this must get right, both learned the hard way.
 *
 * It preserves every field. An earlier version rebuilt each entry as
 * `{ id, label }`, silently dropping `is_builtin` and `course_count` — so the
 * delete confirmation said "No classes are using it" about a tag with classes
 * in it, and the built-in guard read `undefined` and let everything through.
 * Rebuilding an object field by field is how a column added on the server
 * quietly fails to arrive.
 *
 * And it distinguishes "not asked yet" from "asked, and there are none".
 * `undefined` means the fetch is still in flight, so the shipped five are shown
 * to avoid a flash of empty filter bar. `[]` means the server genuinely has no
 * categories — every one deleted — and re-adding the built-ins there would
 * resurrect tags a teacher had just removed.
 */
export function mergeCategories(fromServer) {
  if (!Array.isArray(fromServer)) return COURSE_CATEGORIES.map((c) => ({ ...c }));

  const out = [];
  const seen = new Set();
  for (const c of fromServer) {
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    // Spread, not a rebuild: whatever the server sends travels with it.
    out.push({ ...c, label: c.label || c.id });
  }
  return out;
}

/**
 * Label for a stored id, falling back to the raw value rather than blank.
 *
 * `known` lets a caller pass the merged list so a custom category reads as
 * "Foundation" rather than "foundation". Without it the fallback still shows
 * the id, which is ugly but never blank — a course filed under a category
 * nobody can see the name of is worse than a slug.
 */
export function categoryLabel(id, known = COURSE_CATEGORIES) {
  if (!id) return '';
  return (known || COURSE_CATEGORIES).find((c) => c.id === id)?.label ?? id;
}
