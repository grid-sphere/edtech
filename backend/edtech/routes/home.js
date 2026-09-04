/**
 * The student home screen, in one request.
 *
 * Everything here could be assembled from existing endpoints, but the home
 * screen is the first thing loaded after sign-in and on a phone connection
 * four round trips is the difference between "instant" and "loading". One
 * query set, one response.
 */
import express from "express";
import pool from "../config/database.js";
import { authOnly as authMiddleware } from "../middleware/auth.js";
import { activeEnrolmentSql } from "../utils/enrollmentAccess.js";
import { listCategories } from "../constants/courseCategories.js";
import { classOrderSql } from "../utils/courseOrder.js";
import { APP_TIMEZONE, todayInAppZone, dayToUtcMs, DAY_MS } from "../utils/appTime.js";

const router = express.Router();

/**
 * Consecutive days ending today or yesterday.
 *
 * Yesterday counts as unbroken: a streak that dies at midnight punishes
 * someone who studies every evening for looking at 11pm one day and 1am the
 * next. It breaks only once a full day has passed with nothing.
 *
 * @param {string[]} isoDays distinct activity days, newest first, as YYYY-MM-DD
 * @param {string} todayIso today in the platform's timezone, as YYYY-MM-DD
 */
export function streakFromDays(isoDays, todayIso = todayInAppZone()) {
    if (!isoDays || isoDays.length === 0) return 0;

    /*
     * Takes today as a YYYY-MM-DD string rather than a Date.
     *
     * A Date has no opinion about which calendar day it is until you pick a
     * zone, and the two obvious readings — the server's zone or UTC — are both
     * wrong for a school in India. Passing the day in makes the caller state
     * which calendar it means, and it is the same one the SQL bucketed on.
     */
    const todayNum = dayToUtcMs(todayIso);

    // Parsed as UTC midnights so a daylight-saving change cannot make two
    // adjacent dates 23 or 25 hours apart and break the arithmetic.
    const days = [...new Set(isoDays.map((d) => String(d).slice(0, 10)))]
        .map(dayToUtcMs)
        .sort((a, b) => b - a);

    const gapFromToday = (todayNum - days[0]) / DAY_MS;
    if (gapFromToday > 1) return 0;

    let streak = 1;
    for (let i = 1; i < days.length; i++) {
        if ((days[i - 1] - days[i]) / DAY_MS === 1) streak++;
        else break;
    }
    return streak;
}


/**
 * The last seven days, oldest first, each flagged active or not.
 *
 * Built here rather than in the browser on purpose. The day strings come out
 * of Postgres as YYYY-MM-DD with no zone, and `new Date('2026-08-06')` parses
 * as UTC midnight — so calling .getDay() on it in any timezone west of
 * Greenwich reports the previous day. Every dot would sit under the wrong
 * letter for half the world. Returning the weekday index alongside the flag
 * means the client never parses a date at all.
 *
 * @param {string[]} isoDays distinct activity days as YYYY-MM-DD
 * @returns {{day: string, active: boolean, dow: number}[]} dow: 0 = Sunday
 */
export function lastSevenDays(isoDays, todayIso = todayInAppZone()) {
    const active = new Set((isoDays ?? []).map((d) => String(d).slice(0, 10)));
    const todayNum = dayToUtcMs(todayIso);

    const out = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(todayNum - i * DAY_MS);
        const iso = d.toISOString().slice(0, 10);
        out.push({ day: iso, active: active.has(iso), dow: d.getUTCDay() });
    }
    return out;
}

/**
 * GET /api/home
 *
 * Scoped entirely to req.user.id. There is no id parameter anywhere in this
 * route by design — a home screen that can be asked about somebody else is a
 * data leak waiting for the first person who edits a URL.
 */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        /*
         * Activity days come from what students actually do: watch video and
         * take quizzes. Both tables already carry timestamps, so a streak needs
         * no new tracking — and one built on a fresh table would have started
         * at zero for everyone on the day it shipped.
         */
        const activity = await pool.query(`
            SELECT DISTINCT day::text AS day FROM (
                SELECT DATE(updated_at AT TIME ZONE 'UTC' AT TIME ZONE $2) AS day
                  FROM video_progress WHERE user_id = $1
                UNION
                SELECT DATE(completed_at AT TIME ZONE 'UTC' AT TIME ZONE $2) AS day
                  FROM quiz_attempts
                 WHERE user_id = $1 AND completed_at IS NOT NULL
            ) AS days
            WHERE day IS NOT NULL
            ORDER BY day DESC
            LIMIT 400
        `, [userId, APP_TIMEZONE]);

        /*
         * "Your Classes" — one row per enrolled *class*, not per enrolment.
         *
         * Enrolments are sold per subject: a student buys Physics, not "12th
         * Class". Listing the enrolment rows directly therefore filled the home
         * screen with "Biology" and "12th Physics (HPBOSE)-2027" — subjects,
         * with their class relegated to a grey "in NEET" subtitle. Someone
         * enrolled in three subjects of one class saw that class three times,
         * never by name.
         *
         * So the rows are rolled up to COALESCE(parent, self): a subject folds
         * into its class, a course with no parent stands as its own class, and
         * a student who bought two subjects of the same class gets one card.
         * Tapping it opens the class, which lists its subjects — the same route
         * "More courses" already uses, so Home and Explore agree about what a
         * class is.
         *
         * Progress is computed rather than stored: there is no progress column
         * on enrollments, and an earlier attempt to select one made every
         * request fail. Counting distinct watched videos against the total
         * gives the same figure from rows that exist. Summed across the
         * subjects the student actually holds, so the bar answers "how far
         * through my material am I" rather than counting videos they never
         * bought and can therefore never watch — a bar that could not reach
         * 100% would read as the student being permanently behind.
         */
        const courses = await pool.query(`
            WITH mine AS (
                SELECT
                    c.id AS course_id,
                    /*
                     * The parent join carries is_active, so an archived class
                     * does not swallow its subjects: with no live parent the
                     * subject falls back to standing on its own. Losing a card
                     * for a course they paid for is the one outcome worse than
                     * showing it at the wrong level.
                     */
                    COALESCE(p.id, c.id) AS class_id,
                    e.enrolled_at,
                    e.expires_at
                  FROM enrollments e
                  JOIN courses c ON c.id = e.course_id
                  LEFT JOIN courses p
                         ON p.id = c.parent_course_id AND p.is_active = true
                 WHERE e.user_id = $1
                   AND ${activeEnrolmentSql('e')}
                   AND c.is_active = true
            ),
            agg AS (
                SELECT
                    class_id,
                    /* The newest enrolment represents the class. It is only the
                       final tie-break now that the teacher's arrangement leads,
                       so it separates two classes placed at the same position
                       and decides nothing above that. */
                    MAX(enrolled_at) AS enrolled_at,
                    /* Soonest expiry governs the class. It is the first date
                       on which the student loses something. */
                    MIN(expires_at) AS expires_at,
                    COUNT(*) FILTER (WHERE course_id <> class_id)::int AS subject_count,
                    COALESCE(SUM(
                        (SELECT COUNT(*) FROM modules m
                          WHERE m.course_id = mine.course_id AND m.is_active = true)
                    ), 0)::int AS module_count,
                    COALESCE(SUM(
                        (SELECT COUNT(*)
                           FROM content_items ci
                           JOIN modules m ON ci.id = ANY(m.content_ids)
                          WHERE m.course_id = mine.course_id AND ci.is_active = true
                            AND ci.content_type = 'video' AND ci.status = 'ready')
                    ), 0)::int AS video_count,
                    COALESCE(SUM(
                        (SELECT COUNT(DISTINCT vp.content_id) FROM video_progress vp
                          WHERE vp.user_id = $1 AND vp.course_id = mine.course_id)
                    ), 0)::int AS videos_watched
                  FROM mine
                 GROUP BY class_id
            )
            SELECT
                c.id,
                c.title,
                c.description,
                c.thumbnail_url,
                c.category,
                c.price,
                agg.enrolled_at,
                agg.expires_at,
                agg.subject_count,
                agg.module_count,
                agg.video_count,
                agg.videos_watched,
                /*
                 * Everyone in the class or in any of its subjects, counted
                 * once. Left as the class's own enrolments it would read "1"
                 * under a class with two hundred students spread across its
                 * subjects.
                 */
                (SELECT COUNT(DISTINCT e2.user_id)::int
                   FROM enrollments e2
                   JOIN courses c2 ON c2.id = e2.course_id
                  WHERE e2.status = 'active'
                    AND (c2.id = c.id OR c2.parent_course_id = c.id)) AS student_count
              FROM agg
              JOIN courses c ON c.id = agg.class_id
             /*
              * The teacher's arrangement, here too.
              *
              * This list was ordered by enrolment date — a sort the student
              * side invented for itself, which is exactly what the two lists on
              * this screen must stop doing. A class sat in one position under
              * "Your Classes" and a different one under "More courses", and
              * neither matched the dashboard.
              *
              * Enrolment date survives only as the last tie-break, below the
              * three shared keys, so it decides nothing the teacher has an
              * opinion about.
              */
             ORDER BY ${classOrderSql('c')}, agg.enrolled_at DESC
        `, [userId]);

        /*
         * Counts behind the quick-action tiles.
         *
         * Restricted to courses this student can currently open, so a tile
         * never advertises material behind a lapsed enrolment.
         */
        const counts = await pool.query(`
            WITH mine AS (
                SELECT c.id FROM enrollments e
                JOIN courses c ON c.id = e.course_id
                WHERE e.user_id = $1 AND ${activeEnrolmentSql('e')} AND c.is_active = true
            )
            SELECT
                (SELECT COUNT(*)::int
                   FROM content_items ci
                   JOIN modules m ON ci.id = ANY(m.content_ids)
                  WHERE m.course_id IN (SELECT id FROM mine)
                    AND ci.is_active = true AND ci.content_type <> 'video'
                    AND ci.status = 'ready') AS notes_count,
                (SELECT COUNT(*)::int
                   FROM quizzes q
                   JOIN modules m ON m.id = q.module_id
                  WHERE m.course_id IN (SELECT id FROM mine)) AS quiz_count,
                (SELECT COUNT(*)::int
                   FROM quiz_attempts qa
                   JOIN quizzes q ON q.id = qa.quiz_id
                   JOIN modules m ON m.id = q.module_id
                  WHERE qa.user_id = $1 AND m.course_id IN (SELECT id FROM mine)
                    AND qa.status = 'completed') AS quizzes_done
        `, [userId]);

        /*
         * Slides for the carousel, from the gallery an admin curates.
         *
         * This was "every published top-level course that has a thumbnail,
         * newest first". It filled the space, but nobody chose what went there:
         * the most prominent surface in the app changed whenever a teacher
         * uploaded a course cover, and an admin who wanted a different banner
         * had no way to say so except by editing a course.
         *
         * Course thumbnails can no longer reach this list at all. The join to
         * courses supplies only the linked class's title and the enrolled flag,
         * so a banner still reads as a shortcut into that class — the image
         * itself is always the uploaded one.
         *
         * Left empty when nothing has been uploaded. There is deliberately no
         * fallback to course images: a silent fallback is how the old behaviour
         * would come back without anyone noticing it had.
         */
        const featured = await pool.query(`
            SELECT g.id,
                   g.image_url AS thumbnail_url,
                   g.link_course_id,
                   /* The caption if the admin wrote one, otherwise the linked
                      class's name, so a banner is never an unlabelled image. */
                   COALESCE(g.caption, c.title) AS title,
                   c.category,
                   CASE WHEN c.id IS NULL THEN false ELSE EXISTS (
                       SELECT 1 FROM enrollments e
                        WHERE e.course_id = c.id AND e.user_id = $1
                          AND ${activeEnrolmentSql('e')}
                   ) END AS enrolled
              FROM gallery_images g
              LEFT JOIN courses c
                     ON c.id = g.link_course_id
                    AND c.is_active = true
                    AND c.status = 'published'
             WHERE g.is_active = true
             ORDER BY g.sort_order ASC, g.created_at DESC
             LIMIT 8
        `, [userId]);

        /*
         * Every published course, whether or not this student has joined it.
         *
         * The category chips were filtering `courses`, which comes from the
         * enrolments table — so a teacher tagging a new course "NEET" made it
         * appear nowhere until somebody was already enrolled in it. That is
         * backwards: the chips are how a student is meant to *find* courses.
         *
         * Nothing private is exposed. A published course's title, cover and
         * category are already public on the Explore page; this is the same
         * data, surfaced where students actually look.
         *
         * Top-level only. Child courses belong to their parent and appear
         * inside it, so listing them here would show a student two entries
         * for what they think of as one course.
         */
        const catalog = await pool.query(`
            SELECT
                c.id,
                c.title,
                c.description,
                c.thumbnail_url,
                c.category,
                c.price,
                (SELECT COUNT(*)::int FROM modules m
                  WHERE m.course_id = c.id AND m.is_active = true) AS module_count,
                (SELECT COUNT(DISTINCT e2.user_id)::int FROM enrollments e2
                  WHERE e2.course_id = c.id AND e2.status = 'active') AS student_count,
                /*
                 * How many subjects sit inside this class, so the card can say
                 * so. It is the reason a student would open it.
                 */
                (SELECT COUNT(*)::int FROM courses s
                  WHERE s.parent_course_id = c.id
                    AND s.is_active = true AND s.status = 'published') AS subject_count,
                /*
                 * Every category this class can be found under: its own, plus
                 * every published subject's.
                 *
                 * A class is what a student browses, but a teacher may well
                 * have tagged the subjects instead — a "Class 12" class whose
                 * Physics and Chemistry subjects are tagged NEET. Matching on
                 * c.category alone would drop that class off the NEET chip
                 * even though everything inside it is NEET material.
                 *
                 * NULLs are filtered out, so an untagged class yields an empty
                 * array rather than [null], which would otherwise count as a
                 * category and match nothing.
                 */
                ARRAY(
                    SELECT DISTINCT cat FROM (
                        SELECT c.category AS cat
                        UNION ALL
                        SELECT s.category FROM courses s
                         WHERE s.parent_course_id = c.id
                           AND s.is_active = true AND s.status = 'published'
                    ) t WHERE cat IS NOT NULL
                ) AS categories,
                EXISTS (
                    SELECT 1 FROM enrollments e
                     WHERE e.course_id = c.id AND e.user_id = $1
                       AND ${activeEnrolmentSql('e')}
                ) AS enrolled
              FROM courses c
             WHERE c.is_active = true
               AND c.status = 'published'
               /*
                * Classes only. Subjects live inside a class and are reached by
                * opening it.
                *
                * An earlier version listed subjects here too, so that tagging a
                * subject "NEET" had a visible effect. That fixed the tag but
                * broke the browsing model: a student saw "Class 12", "Physics"
                * and "Chemistry" as three sibling entries with no indication
                * that the last two were inside the first. The categories array
                * above keeps subject tags working without flattening the
                * hierarchy to do it.
                *
                * (No backticks in this comment: it lives inside a JS template
                * literal, and one would end the string mid-query.)
                */
               AND c.parent_course_id IS NULL
             /*
              * "More courses" — the list in the report. Newest-first is the
              * ordering the teacher explicitly did not choose; their
              * arrangement is in display_order and was being discarded here.
              */
             ORDER BY ${classOrderSql('c')}
        `, [userId]);

        const days = activity.rows.map((r) => r.day);
        /*
         * One value for both, read once.
         * Calling todayInAppZone() twice could straddle midnight and produce a
         * streak and a strip that disagree about what day it is.
         */
        const today = todayInAppZone();

        /*
         * The chip list travels with the page.
         *
         * The frontend ships the five built-ins so the bar can render on first
         * paint, but a category a teacher invented exists only here. Without
         * this, tagging a course "Foundation" would file it under a chip that
         * never appears and the course would vanish from every filter.
         */
        const categories = await listCategories(pool);

        res.json({
            success: true,
            categories,
            streak: streakFromDays(days, today),
            activeDays: days.length,
            recentDays: lastSevenDays(days, today),
            courses: courses.rows,
            catalog: catalog.rows,
            featured: featured.rows,
            counts: counts.rows[0] ?? { notes_count: 0, quiz_count: 0, quizzes_done: 0 },
        });
    } catch (err) {
        console.error("GET /home:", err);
        res.status(500).json({ error: "Could not load your home page" });
    }
});

export default router;
