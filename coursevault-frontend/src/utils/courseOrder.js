/**
 * The order courses are shown in, on the client, defined once.
 *
 * Three places sorted course lists and no two agreed. The dashboard sorted by
 * display_order (the teacher's arrows), Explore sorted classes by the number in
 * the title and did not sort subjects at all, and the server returned
 * created_at DESC. So a teacher arranged their classes, saw the new order on
 * the dashboard, and students got something else — which is the bug this fixes,
 * one layer up from the one already fixed in the home screen's SQL.
 *
 * The keys, in order:
 *   1. display_order   — the teacher's arrangement, set by the up/down arrows
 *   2. the class number — "9th Class" before "10th Class"
 *   3. the title        — anything still tied
 *
 * The tie-break is not decoration. display_order defaults to 0, so before
 * anything is dragged every row is tied, and a comparator that returns 0 leaves
 * the order to whatever the array happened to hold — which is server order,
 * which is arrival order. Two students can then see two different lists.
 *
 * This mirrors classOrderSql() in backend/edtech/utils/courseOrder.js. The two
 * must agree; the server sorts so the list is right on arrival, and this sorts
 * so a client-side filter or merge cannot quietly undo it.
 */

/**
 * The number in a title like "9th Class", "12th Class Physics".
 * Returns null when there isn't one, so "NEET" sorts after "10th Class".
 */
export function classNumber(title = '') {
  const t = String(title);

  // "9th Class", "12th Class (CBSE)" — the number before the word.
  const withWord = t.match(/(\d+)\s*(?:st|nd|rd|th)?\s*Class/i);
  if (withWord) return parseInt(withWord[1], 10);

  // "Class 10" — the same thing said the other way round.
  const afterWord = t.match(/\bClass\s*(\d{1,2})\b/i);
  if (afterWord) return parseInt(afterWord[1], 10);

  /*
   * "12th Physics (HPBOSE)-2027" — the form subjects are actually named in.
   *
   * The pattern above demanded the literal word "Class", so every subject
   * returned null and none of them grouped under their year. That is most of
   * the catalogue: subjects are titled "<year>th <subject>", not
   * "<year>th Class <subject>".
   *
   * Anchored to the start and requiring the ordinal suffix, so the 2027 in
   * "-2027" cannot be read as a year — it is neither leading nor ordinal.
   */
  const leadingOrdinal = t.match(/^\s*(\d{1,2})\s*(?:st|nd|rd|th)\b/i);
  if (leadingOrdinal) return parseInt(leadingOrdinal[1], 10);

  return null;
}

/**
 * Comparator for two course rows, usable on classes or on the subjects inside
 * one class — a subject's display_order is its position within its own class,
 * so the same three keys apply to both lists.
 */
export function compareCourses(a, b) {
  const orderA = a?.display_order ?? 0;
  const orderB = b?.display_order ?? 0;
  if (orderA !== orderB) return orderA - orderB;

  const numA = classNumber(a?.title);
  const numB = classNumber(b?.title);
  if (numA !== null && numB !== null) return numA - numB;
  if (numA !== null) return -1;
  if (numB !== null) return 1;

  return String(a?.title || '').localeCompare(String(b?.title || ''));
}

/** Sort without mutating the caller's array. */
export const sortCourses = (list) => [...(list || [])].sort(compareCourses);
