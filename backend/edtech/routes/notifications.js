/**
 * The notification feed.
 *
 * Every route here is scoped to req.user.id in the WHERE clause rather than
 * fetching a row and then checking ownership in JavaScript. A missing check is
 * then a query that returns nothing, not a query that returns someone else's
 * notification.
 */
import express from "express";
import pool from "../config/database.js";
/*
 * authOnly, not authMiddleware.
 *
 * Same reason as the support router: a notification id is not a content id,
 * and authMiddleware would infer one from req.params.id and 403 the request.
 * That is why marking a single notification read silently failed for students
 * while the badge kept its old count — the POST never reached this file.
 *
 * Every query below is already scoped to req.user.id, so ownership does not
 * depend on the middleware.
 */
import { authOnly as authMiddleware, canManage } from "../middleware/auth.js";
import { notifyCourseStudents } from "../utils/notify.js";

const router = express.Router();

/**
 * GET /api/notifications
 *
 * The feed. Capped at 50: the dropdown shows a handful and nobody scrolls
 * through a year of history, while an uncapped query grows without limit.
 */
router.get("/", authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT n.id,
                    n.type,
                    n.title,
                    n.body,
                    n.course_id,
                    n.link,
                    n.read_at,
                    n.created_at,
                    c.title AS course_title,
                    a.name  AS actor_name
               FROM notifications n
               LEFT JOIN courses c ON c.id = n.course_id
               LEFT JOIN users   a ON a.id = n.actor_id
              WHERE n.user_id = $1
              ORDER BY n.created_at DESC
              LIMIT 50`,
            [req.user.id]
        );

        const unread = rows.filter((r) => !r.read_at).length;
        res.json({ notifications: rows, unread });
    } catch (err) {
        console.error("GET /notifications:", err);
        res.status(500).json({ error: "Could not load notifications" });
    }
});

/**
 * GET /api/notifications/unread-count
 *
 * Polled by the badge, so it stays deliberately tiny — a covered count against
 * the partial index, no joins, no row bodies crossing the wire.
 */
router.get("/unread-count", authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS unread
               FROM notifications
              WHERE user_id = $1 AND read_at IS NULL`,
            [req.user.id]
        );
        res.json({ unread: rows[0].unread });
    } catch (err) {
        console.error("GET /notifications/unread-count:", err);
        res.status(500).json({ error: "Could not load unread count" });
    }
});

/**
 * POST /api/notifications/read-all
 *
 * Safe alongside /:id/read because that route is two segments and this is one,
 * so they cannot match the same URL. It is still declared first: if /:id ever
 * grows a single-segment POST, declaration order is what keeps this working.
 */
router.post("/read-all", authMiddleware, async (req, res) => {
    try {
        // `read_at IS NULL` is not redundant: without it every visit rewrites
        // the whole feed and bloats the table with dead tuples.
        const { rowCount } = await pool.query(
            `UPDATE notifications
                SET read_at = NOW()
              WHERE user_id = $1 AND read_at IS NULL`,
            [req.user.id]
        );
        res.json({ success: true, marked: rowCount });
    } catch (err) {
        console.error("POST /notifications/read-all:", err);
        res.status(500).json({ error: "Could not mark notifications read" });
    }
});

/** POST /api/notifications/:id/read — mark one as read. */
router.post("/:id/read", authMiddleware, async (req, res) => {
    try {
        const { rowCount } = await pool.query(
            `UPDATE notifications
                SET read_at = NOW()
              WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
            [req.params.id, req.user.id]
        );
        res.json({ success: true, marked: rowCount });
    } catch (err) {
        console.error("POST /notifications/:id/read:", err);
        res.status(500).json({ error: "Could not mark notification read" });
    }
});

/** DELETE /api/notifications/:id — remove one from the feed. */
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
            [req.params.id, req.user.id]
        );
        if (rowCount === 0) return res.status(404).json({ error: "Notification not found" });
        res.json({ success: true });
    } catch (err) {
        console.error("DELETE /notifications/:id:", err);
        res.status(500).json({ error: "Could not delete notification" });
    }
});

/**
 * POST /api/notifications/announce
 *
 * A teacher writes to everyone enrolled in one of their courses.
 *
 * Ownership is checked against the course row rather than trusting the role
 * claim alone — an educator account is not entitled to broadcast to another
 * educator's students.
 */
router.post("/announce", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== "educator") {
            return res.status(403).json({ error: "Only educators can post announcements" });
        }

        const { courseId, title, body } = req.body;

        if (!courseId) return res.status(400).json({ error: "courseId is required" });
        if (!title || !title.trim()) return res.status(400).json({ error: "A title is required" });

        const { rows } = await pool.query(
            `SELECT id, title, educator_id FROM courses WHERE id = $1 AND is_active = true`,
            [courseId]
        );
        if (rows.length === 0) return res.status(404).json({ error: "Course not found" });
        if (!canManage(rows[0].educator_id, req.user)) {
            return res.status(403).json({ error: "You do not own this course" });
        }

        const sent = await notifyCourseStudents(courseId, {
            type: "announcement",
            title: title.trim().slice(0, 255),
            body: (body || "").trim() || null,
            actorId: req.user.id,
            link: `/course/${courseId}`,
        });

        // `sent: 0` is a legitimate outcome (a course with no live enrolments)
        // and the UI reports it, so the teacher is not left assuming it went out.
        res.json({ success: true, sent });
    } catch (err) {
        console.error("POST /notifications/announce:", err);
        res.status(500).json({ error: "Could not post the announcement" });
    }
});

export default router;
