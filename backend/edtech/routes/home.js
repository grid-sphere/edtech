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
         * Enrolled courses with progress.
         *
         * Progress is computed rather than stored: there is no progress column
         * on enrollments, and an earlier attempt to select one made every
         * request fail. Counting distinct watched videos against the course's
         * total gives the same figure from rows that exist.
         */
        const courses = await pool.query(`
            SELECT
                c.id,
                c.title,
                c.description,
                c.thumbnail_url,
                c.category,
                c.price,
                e.enrolled_at,
                e.expires_at,
                parent.title AS parent_title,
                (SELECT COUNT(*)::int FROM modules m
                  WHERE m.course_id = c.id AND m.is_active = true) AS module_count,
                (SELECT COUNT(*)::int
                   FROM content_items ci
                   JOIN modules m ON ci.id = ANY(m.content_ids)
                  WHERE m.course_id = c.id AND ci.is_active = true
                    AND ci.content_type = 'video' AND ci.status = 'ready') AS video_count,
                (SELECT COUNT(DISTINCT vp.content_id)::int FROM video_progress vp
                  WHERE vp.user_id = $1 AND vp.course_id = c.id) AS videos_watched,
                (SELECT COUNT(DISTINCT e2.user_id)::int FROM enrollments e2
                  WHERE e2.course_id = c.id AND e2.status = 'active') AS student_count
            FROM enrollments e
            JOIN courses c ON c.id = e.course_id
            LEFT JOIN courses parent ON parent.id = c.parent_course_id
            WHERE e.user_id = $1
              AND ${activeEnrolmentSql('e')}
              AND c.is_active = true
            ORDER BY e.enrolled_at DESC
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
         * Slides for the carousel at the top of the home screen.
         *
         * Published top-level courses that have a thumbnail — the carousel is
         * a picture strip, and a slide with no picture is a grey rectangle
         * with a title on it, which looks broken rather than minimal.
         *
         * Not restricted to enrolled courses: this is the discovery surface,
         * and a student who has joined nothing yet is exactly who most needs
         * to see what is on offer. Nothing sensitive is exposed — the title
         * and cover of a published course are already public on Explore.
         */
        const featured = await pool.query(`
            SELECT c.id, c.title, c.thumbnail_url, c.category, c.price,
                   EXISTS (
                       SELECT 1 FROM enrollments e
                        WHERE e.course_id = c.id AND e.user_id = $1
                          AND ${activeEnrolmentSql('e')}
                   ) AS enrolled
              FROM courses c
             WHERE c.is_active = true
               AND c.status = 'published'
               AND c.parent_course_id IS NULL
               AND c.thumbnail_url IS NOT NULL
               AND c.thumbnail_url <> ''
             ORDER BY c.created_at DESC
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
             ORDER BY c.created_at DESC
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
