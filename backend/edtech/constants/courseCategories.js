/**
 * The course categories students filter by on the home screen.
 *
 * Five ship with the app; a teacher can add their own. What is NOT allowed is
 * raw free text on the course, because "HP Board", "HP board" and "Hp  Board"
 * would become three chips that each hide two thirds of the courses — a filter
 * that quietly lies is worse than no filter.
 *
 * The reconciliation is a slug. A teacher types a label, it is reduced to a
 * stable id, and every spelling of the same thing lands on the same id. The
 * label is stored once in `course_categories`, not per course, so two courses
 * cannot disagree about how one category is written.
 *
 * `null` is a legitimate value: courses created before this existed have no
 * category and appear under "All" only. That is deliberate, so adding the
 * field does not silently file old courses under a board they may not belong
 * to.
 */
export const COURSE_CATEGORIES = [
    { id: "hp_board", label: "HP Board" },
    { id: "neet", label: "NEET" },
    { id: "jee", label: "JEE" },
    { id: "cbse", label: "CBSE" },
    { id: "test_series", label: "Test Series" },
];

/** Alias used by the schema seeder, where "builtin" is the meaningful word. */
export const BUILTIN_COURSE_CATEGORIES = COURSE_CATEGORIES;

export const CATEGORY_IDS = COURSE_CATEGORIES.map((c) => c.id);

/** Longest a custom label may be — the column is VARCHAR(64). */
export const MAX_CATEGORY_LABEL = 40;

/**
 * Reduce a human label to a stable id.
 *
 * Case, spacing and punctuation are all normalised away, which is the entire
 * point: this is what stops one category becoming several. Accented characters
 * are stripped to their base form first so "Odisha" typed two ways still
 * matches.
 *
 * @param {string} raw
 * @returns {string} a slug, or "" if nothing usable remains
 */
export function slugifyCategory(raw) {
    return String(raw ?? "")
        .normalize("NFKD")
        // Drop combining marks left behind by the decomposition above.
        // Written as escapes, not literal marks: the literal range is invisible
        // in an editor and survives a copy-paste only by luck.
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .trim()
        // Any run of non-alphanumerics becomes a single underscore, so
        // "HP  Board", "hp-board" and "hp/board" all land on hp_board.
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 64)
        // A trailing underscore can reappear after the slice.
        .replace(/_+$/g, "");
}

/**
 * Validate a category id coming in over the wire.
 *
 * Accepts the built-ins and any well-formed slug, because a custom category
 * created by another teacher is a legitimate value this server has never seen
 * in its constants. The shape is checked here; whether the row exists is
 * settled by ensureCategory, which creates it when a label came with it.
 *
 * Empty string and null both mean "uncategorised" — the form sends "" when the
 * teacher picks the blank option, and treating that as invalid would make the
 * category impossible to clear once set.
 *
 * @returns {{ ok: true, value: string|null } | { ok: false, error: string }}
 */
export function parseCategory(raw) {
    if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };

    if (typeof raw !== "string") {
        return { ok: false, error: "category must be a string" };
    }
    if (CATEGORY_IDS.includes(raw)) return { ok: true, value: raw };

    /*
     * Compared against the slug of itself rather than tested with a pattern.
     * An id that does not survive slugifying is one the client built by some
     * other rule, and letting it through would create a category that no
     * future submission of the same label can ever match.
     */
    const slug = slugifyCategory(raw);
    if (!slug) {
        return { ok: false, error: "category must contain at least one letter or number" };
    }
    if (slug !== raw) {
        return { ok: false, error: `category id must be a slug, e.g. "${slug}"` };
    }
    return { ok: true, value: slug };
}

/**
 * Validate a label a teacher typed for a new category.
 *
 * @returns {{ ok: true, id: string, label: string } | { ok: false, error: string }}
 */
export function parseCategoryLabel(raw) {
    const label = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!label) return { ok: false, error: "Enter a name for the category." };
    if (label.length > MAX_CATEGORY_LABEL) {
        return { ok: false, error: `Category name must be ${MAX_CATEGORY_LABEL} characters or fewer.` };
    }
    const id = slugifyCategory(label);
    if (!id) {
        return { ok: false, error: "Category name must contain at least one letter or number." };
    }
    return { ok: true, id, label };
}

/**
 * Create a custom category if it does not already exist.
 *
 * Never overwrites an existing row. Two teachers typing "Foundation" and
 * "foundation" must end up on one category, and the first spelling wins rather
 * than the label flipping under the other teacher's courses. Built-ins are
 * likewise left alone: they are shipped in the frontend for first paint, so a
 * renamed one would read differently before and after the page loads.
 *
 * @returns {Promise<string>} the id actually stored
 */
export async function ensureCategory(pool, id, label, userId = null) {
    await pool.query(
        `INSERT INTO course_categories (id, label, is_builtin, created_by)
              VALUES ($1, $2, FALSE, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, label, userId]
    );
    return id;
}

/**
 * Does this category id actually exist?
 *
 * parseCategory only checks the shape, and a well-formed slug is not the same
 * as a real category. Without this, a client could tag a course "physics" —
 * valid-looking, saved happily, and filed under a chip that does not exist, so
 * the course would be findable by search and by nothing else. That is the exact
 * failure custom categories were meant to remove, not introduce.
 */
export async function categoryExists(pool, id) {
    if (CATEGORY_IDS.includes(id)) return true;
    const { rows } = await pool.query(
        `SELECT 1 FROM course_categories WHERE id = $1`, [id]
    );
    return rows.length > 0;
}

/**
 * Every category, built-ins first and custom ones alphabetically after.
 *
 * Falls back to the shipped constants if the table is missing, so an API that
 * has not run its migration yet degrades to the old five rather than returning
 * nothing and emptying the filter bar.
 */
export async function listCategories(pool) {
    try {
        const { rows } = await pool.query(
            /*
             * sort_order first, because a teacher can rearrange the chips and
             * students must see that arrangement. NULLS LAST so a category
             * created before the column existed sits at the end rather than
             * jumping to the front, and label breaks ties so the order is
             * stable rather than whatever the heap returns.
             */
            /*
             * course_count travels with the list so the teacher can be told
             * what deleting one would untag, before they do it rather than
             * after. Counting active courses only: a soft-deleted course is
             * not something anyone is about to lose.
             */
            `SELECT c.id, c.label, c.is_builtin, c.sort_order,
                    (SELECT COUNT(*)::int FROM courses co
                      WHERE co.category = c.id AND co.is_active = true) AS course_count
               FROM course_categories c
              ORDER BY c.sort_order ASC NULLS LAST, c.label ASC`
        );
        return rows.length ? rows : COURSE_CATEGORIES;
    } catch (err) {
        console.error("[categories] falling back to built-ins:", err.message);
        return COURSE_CATEGORIES;
    }
}
