/**
 * The order classes are shown in, defined once.
 *
 * Teachers arrange their classes with the up/down arrows on the dashboard, and
 * PUT /courses/reorder writes the resulting position into courses.display_order.
 * Nothing on the student side read that column: every list ordered by
 * created_at, so the arrangement was saved faithfully and then ignored, and
 * students saw newest-first while the teacher saw their own arrangement.
 *
 * The tie-break matters as much as the column. display_order defaults to 0, so
 * until someone drags something every class is tied — and "ORDER BY
 * display_order" alone leaves Postgres free to return tied rows in any order it
 * likes, which can differ between two runs of the same query. A student
 * refreshing the page would watch the list reshuffle. So the tie is broken the
 * same way the dashboard breaks it, giving a total order in every case:
 *
 *   1. display_order          — the teacher's arrangement
 *   2. the number in the title — "9th Class" before "10th Class"
 *   3. the title itself       — anything still tied
 *
 * This mirrors compareCourses() in EducatorDashboardPage.jsx. The two must
 * agree; if that function changes, this has to change with it, or the teacher
 * and the student are once again looking at two different orders.
 *
 * Subjects are deliberately not covered here. A subject's display_order is its
 * position within its own class, set by the same endpoint on a different
 * sibling group, and courses.js already orders subjects by it. Class order and
 * subject order are separate arrangements that happen to share a column.
 *
 * @param {string} alias table alias for `courses` in the calling query
 * @returns {string} an ORDER BY body, without the words ORDER BY
 */
export function classOrderSql(alias = "c") {
    const c = `${alias}.`;
    return `
        COALESCE(${c}display_order, 0) ASC,
        /*
         * The same pattern the dashboard uses: a number, an optional ordinal
         * suffix, then the word "Class". Postgres returns the first capture
         * group, so this yields "9" from "9th Class (HPBOSE)" and NULL from
         * "NEET". Titles with no class number sort after those that have one,
         * which is what the JS comparator does when only one side matches.
         *
         * Case is handled by upper() rather than by an embedded (?i) flag.
         * Postgres does support (?i), but nothing in this sandbox can execute
         * SQL to prove it — pglast checks grammar, not regex semantics — and a
         * flag that silently failed to apply would sort "9th class" apart from
         * "9th Class" with no error anywhere. upper() is the version that needs
         * no engine to be sure of. POSIX has no \\d or (?:...), hence the
         * character classes.
         */
        NULLIF(substring(upper(${c}title) from '([0-9]+)[[:space:]]*(ST|ND|RD|TH)?[[:space:]]*CLASS'), '')::int
            ASC NULLS LAST,
        ${c}title ASC
    `.trim();
}
