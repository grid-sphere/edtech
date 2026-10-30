import express from "express";
import pool from "../config/database.js";
import authMiddleware from "../middleware/auth.js";
import { classOrderSql } from "../utils/courseOrder.js";

const router = express.Router();

/**
 * GET /api/analytics/students
 *
 * Every student enrolled in any of this educator's courses, one row per
 * enrolment — so someone taking three subjects appears three times, which is
 * what "who is enrolled in what" actually means.
 *
 * Scoped by `c.educator_id = $1` in the query itself rather than filtered
 * afterwards: a teacher must never see another teacher's students, and a WHERE
 * clause cannot be forgotten the way a post-filter can.
 */
router.get("/students", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== "educator" && req.user.role !== "admin") {
            return res.status(403).json({ error: "Access denied. Only educators can view analytics." });
        }

        /*
         * Every student-course pair with an enrolment OR a payment attempt.
         *
         * This used to be `FROM enrollments`, which answers "who is studying"
         * and silently refuses the question a teacher actually asks first:
         * who tried to buy this and did not finish. A student who opened
         * checkout and abandoned it has no enrolment row, so they did not
         * appear here at all — the single most useful row in the table was the
         * one that could never be in it.
         *
         * payment_orders has recorded those all along. A row is written at
         * 'created', before the student ever reaches the payment page, and only
         * moves to 'completed' or 'failed' afterwards — so one still sitting at
         * 'created' is precisely an abandoned checkout.
         */
        const isAdmin = req.user.role === "admin";

        const { rows } = await pool.query(`
            WITH scope AS (
                -- An admin runs the school and sees all of it; a teacher sees
                -- their own. Scoping an admin to courses they personally
                -- created showed them an empty table.
                SELECT c.id FROM courses c
                 WHERE c.is_active = true
                   AND ($2::boolean OR c.educator_id = $1)
            ),
            pairs AS (
                SELECT e.user_id, e.course_id FROM enrollments e
                 WHERE e.course_id IN (SELECT id FROM scope)
                UNION
                SELECT po.user_id, po.course_id FROM payment_orders po
                 WHERE po.course_id IN (SELECT id FROM scope)
                   AND po.user_id IS NOT NULL
            ),
            pay AS (
                -- One row per student-course, summarising every attempt.
                SELECT
                    po.user_id,
                    po.course_id,
                    COUNT(*)::int                                         AS payment_attempts,
                    MAX(po.created_at)                                    AS last_attempt_at,
                    MAX(po.created_at) FILTER (WHERE po.status = 'completed') AS paid_at,
                    COUNT(*) FILTER (WHERE po.status = 'failed')::int      AS failed_attempts,
                    COUNT(*) FILTER (WHERE po.status = 'created')::int     AS abandoned_attempts,
                    -- The most recent outcome, which is what the column shows.
                    (ARRAY_AGG(po.status ORDER BY po.created_at DESC))[1]  AS last_payment_status,
                    MAX(po.amount) FILTER (WHERE po.status = 'completed')  AS paid_amount
                  FROM payment_orders po
                 GROUP BY po.user_id, po.course_id
            )
            SELECT
                e.id            AS enrollment_id,
                u.id            AS student_id,
                u.name          AS student_name,
                u.email         AS student_email,
                u.phone         AS student_phone,
                u.class_level,
                u.board,
                u.last_login,
                c.id            AS course_id,
                c.title         AS course_title,
                parent.title    AS parent_course_title,
                e.enrolled_at,
                e.expires_at,
                e.status,
                e.payment_status,
                e.amount_paid,
                COALESCE(pay.payment_attempts, 0)    AS payment_attempts,
                COALESCE(pay.failed_attempts, 0)     AS failed_attempts,
                COALESCE(pay.abandoned_attempts, 0)  AS abandoned_attempts,
                pay.last_attempt_at,
                pay.paid_at,
                pay.last_payment_status,
                pay.paid_amount,
                -- Enrolled without ever paying: a free course, or access
                -- granted by hand. Worth distinguishing from a completed sale.
                (e.id IS NOT NULL AND pay.user_id IS NULL) AS enrolled_without_payment,
                /*
                 * Computed, not stored. There is no progress column on
                 * enrollments — an earlier version of this file selected one
                 * and every request failed with "column e.progress does not
                 * exist". Counting distinct completed videos against the
                 * course's total is the same number, derived from rows that
                 * definitely exist.
                 */
                (
                    SELECT COUNT(DISTINCT vp.content_id)::int
                      FROM video_progress vp
                     WHERE vp.user_id = u.id AND vp.course_id = c.id
                ) AS videos_started,
                (
                    SELECT COUNT(DISTINCT qa.quiz_id)::int
                      FROM quiz_attempts qa
                      JOIN quizzes q ON q.id = qa.quiz_id
                      JOIN modules m ON m.id = q.module_id
                     WHERE qa.user_id = u.id AND m.course_id = c.id
                       AND qa.status = 'completed'
                ) AS quizzes_done
            FROM pairs p
            JOIN users   u ON u.id = p.user_id
            JOIN courses c ON c.id = p.course_id
            -- LEFT, because a pair can exist on a payment attempt alone.
            LEFT JOIN enrollments e  ON e.user_id = p.user_id AND e.course_id = p.course_id
            LEFT JOIN pay            ON pay.user_id = p.user_id AND pay.course_id = p.course_id
            LEFT JOIN courses parent ON parent.id = c.parent_course_id
            ORDER BY
                /*
                 * Unfinished business first.
                 *
                 * Someone who tried to pay and did not complete is the most
                 * actionable row in this table — it is a sale a message might
                 * still recover — so it sorts above everything. Then students
                 * who have never signed in, who need chasing for a different
                 * reason. Settled rows come last.
                 */
                (e.id IS NULL AND pay.user_id IS NOT NULL) DESC,
                u.last_login NULLS FIRST,
                u.name ASC
        `, [req.user.id, isAdmin]);

        res.json({ success: true, students: rows });
    } catch (err) {
        console.error("GET /analytics/students:", err);
        res.status(500).json({ error: "Could not load the student list" });
    }
});


/**
 * POST /api/analytics/enrollments/:enrollmentId/revoke
 * Revoke one enrollment without deleting its payment or learning history.
 * The existing `inactive` status is used because it is already supported by
 * this application's enrollment lifecycle and is denied by activeEnrolmentSql.
 */
router.post("/enrollments/:enrollmentId/revoke", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== "educator" && req.user.role !== "admin") {
            return res.status(403).json({ error: "Only educators or admins can revoke access." });
        }

        const { enrollmentId } = req.params;
        const isAdmin = req.user.role === "admin";

        const result = await pool.query(`
            UPDATE enrollments e
               SET status = 'inactive',
                   updated_at = NOW()
              FROM courses c
             WHERE e.id = $1
               AND c.id = e.course_id
               AND (c.educator_id = $2 OR $3::boolean)
               AND e.status = 'active'
         RETURNING e.id AS enrollment_id, e.user_id, e.course_id, e.status,
                   e.payment_status, e.expires_at
        `, [enrollmentId, req.user.id, isAdmin]);

        if (result.rows.length === 0) {
            // Avoid revealing whether an enrollment exists outside this educator's courses.
            return res.status(404).json({
                error: "Active enrollment not found, or you do not have permission to manage it."
            });
        }

        return res.json({
            success: true,
            message: "Access revoked for this course enrollment.",
            enrollment: result.rows[0]
        });
    } catch (err) {
        console.error("POST /analytics/enrollments/:enrollmentId/revoke:", err);
        return res.status(500).json({ error: "Could not revoke enrollment access." });
    }
});

/**
 * POST /api/analytics/enrollments/:enrollmentId/grant
 * Restore an enrollment that was manually revoked. Payment records and
 * learning history are intentionally left untouched.
 */
router.post("/enrollments/:enrollmentId/grant", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== "educator" && req.user.role !== "admin") {
            return res.status(403).json({ error: "Only educators or admins can grant access." });
        }

        const { enrollmentId } = req.params;
        const isAdmin = req.user.role === "admin";

        const result = await pool.query(`
            UPDATE enrollments e
               SET status = 'active',
                   updated_at = NOW()
              FROM courses c
             WHERE e.id = $1
               AND c.id = e.course_id
               AND (c.educator_id = $2 OR $3::boolean)
               AND e.status IN ('inactive', 'revoked')
         RETURNING e.id AS enrollment_id, e.user_id, e.course_id, e.status,
                   e.payment_status, e.expires_at
        `, [enrollmentId, req.user.id, isAdmin]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Revoked enrollment not found, or you do not have permission to manage it."
            });
        }

        return res.json({
            success: true,
            message: "Access granted again for this course enrollment.",
            enrollment: result.rows[0]
        });
    } catch (err) {
        console.error("POST /analytics/enrollments/:enrollmentId/grant:", err);
        return res.status(500).json({ error: "Could not restore enrollment access." });
    }
});

// ============================================================
// ROUTE 1: EDUCATOR DASHBOARD OVERVIEW
// GET /api/analytics/dashboard
// ============================================================
router.get("/dashboard", authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const isAdmin = req.user.role === 'admin';
        
        if (req.user.role !== 'educator' && req.user.role !== 'admin') {
            return res.status(403).json({ 
                error: "Access denied. Only educators can view analytics." 
            });
        }
        
        // 1. TOTAL COURSES & STUDENTS (without progress column)
        const totalsResult = await pool.query(`
            SELECT 
                COUNT(DISTINCT c.id) as total_courses,
                COUNT(DISTINCT e.user_id) as total_students,
                COALESCE(SUM(e.amount_paid), 0) as total_revenue
            FROM courses c
            LEFT JOIN enrollments e ON c.id = e.course_id 
                AND e.status = 'active' 
                AND e.payment_status = 'completed'
            WHERE c.educator_id = $1 AND c.deleted_at IS NULL
        `, [userId]);
        
        // 2. ALL COURSES WITH STATS
        const coursesResult = await pool.query(`
            SELECT 
                c.id,
                c.title,
                c.price,
                c.status,
                c.created_at,
                c.thumbnail_url,
                /*
                 * Which class a subject belongs to.
                 *
                 * Without it the table was a flat list of everything the
                 * teacher owns — classes and the subjects inside them as
                 * siblings, in upload order — so "12th Class", "Physics" and
                 * "Chemistry" sat in three unrelated rows and the reader had to
                 * already know which belonged to which.
                 */
                c.parent_course_id,
                p.title AS parent_title,
                c.display_order,
                COUNT(DISTINCT e.user_id) as enrolled_count,
                COUNT(CASE WHEN e.payment_status = 'completed' THEN 1 END) as paid_count,
                /*
                 * Money actually taken, from the payment records — not
                 * price x paid_count.
                 *
                 * That product is wrong the moment a price changes: it reprices
                 * every past sale at today's figure, so lowering a price makes
                 * historic revenue drop. Summing completed orders is what the
                 * bank saw.
                 */
                COALESCE((
                    SELECT SUM(po.amount)
                      FROM payment_orders po
                     WHERE po.course_id = c.id AND po.status = 'completed'
                ), 0)::float AS revenue
            FROM courses c
            LEFT JOIN enrollments e ON c.id = e.course_id AND e.status = 'active'
            LEFT JOIN courses p ON p.id = c.parent_course_id
            /*
             * An admin sees every course; a teacher sees only their own.
             *
             * Scoping this to educator_id alone meant an admin — who owns
             * nothing — got a list with the parent classes missing, so every
             * subject fell through the "parent not in the list" branch and
             * rendered as its own top-level row. The page looked like a flat
             * dump of subjects because, for that account, it was one.
             */
            WHERE ($2::boolean OR c.educator_id = $1) AND c.deleted_at IS NULL
            GROUP BY c.id, p.title
            ORDER BY ${classOrderSql('c')}
        `, [userId, isAdmin]);
        
        // 3. RECENT ENROLLMENTS (last 30 days)
        const recentEnrollments = await pool.query(`
            SELECT 
                e.id,
                e.enrolled_at,
                e.amount_paid,
                e.payment_status,
                u.name as student_name,
                u.email as student_email,
                c.title as course_title,
                c.id as course_id
            FROM enrollments e
            JOIN courses c ON e.course_id = c.id
            JOIN users u ON e.user_id = u.id
            WHERE c.educator_id = $1 
                AND e.status = 'active'
                AND e.enrolled_at > NOW() - INTERVAL '30 days'
            ORDER BY e.enrolled_at DESC
            LIMIT 20
        `, [userId]);
        
        // 4. DAILY ACTIVITY (last 30 days)
        const dailyActivity = await pool.query(`
            SELECT 
                DATE(e.enrolled_at) as date,
                COUNT(*) as new_enrollments
            FROM enrollments e
            JOIN courses c ON e.course_id = c.id
            WHERE c.educator_id = $1 
                AND e.status = 'active'
                AND e.enrolled_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(e.enrolled_at)
            ORDER BY date DESC
        `, [userId]);
        
        res.json({
            success: true,
            data: {
                overview: {
                    total_courses: parseInt(totalsResult.rows[0].total_courses) || 0,
                    total_students: parseInt(totalsResult.rows[0].total_students) || 0,
                    total_revenue: parseFloat(totalsResult.rows[0].total_revenue) || 0
                },
                courses: coursesResult.rows.map(row => ({
                    id: row.id,
                    title: row.title,
                    price: parseFloat(row.price),
                    status: row.status,
                    thumbnail_url: row.thumbnail_url,
                    created_at: row.created_at,
                    enrolled_count: parseInt(row.enrolled_count),
                    paid_count: parseInt(row.paid_count),
                    revenue: Number(row.revenue) || 0
                })),
                recent_enrollments: recentEnrollments.rows,
                daily_activity: dailyActivity.rows
            }
        });
        
    } catch (err) {
        console.error("Analytics dashboard error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROUTE 2: COURSE-SPECIFIC ANALYTICS
// GET /api/analytics/course/:courseId
// ============================================================
router.get("/course/:courseId", authMiddleware, async (req, res) => {
    try {
        const { courseId } = req.params;
        
        if (!req.isCourseCreator) {
            return res.status(403).json({ 
                error: "You don't have permission to view analytics for this course" 
            });
        }
        
        // 1. BASIC COURSE INFO
        const courseInfo = await pool.query(`
            SELECT title, description, price, status, thumbnail_url, created_at
            FROM courses WHERE id = $1
        `, [courseId]);
        
        // 2. ENROLLMENT STATISTICS
        const enrollmentStats = await pool.query(`
            SELECT 
                COUNT(*) as total_enrolled,
                COUNT(CASE WHEN payment_status = 'completed' THEN 1 END) as paid_count,
                COUNT(CASE WHEN payment_status = 'pending' THEN 1 END) as pending_count,
                COALESCE(SUM(amount_paid), 0) as total_revenue
            FROM enrollments
            WHERE course_id = $1 AND status = 'active'
        `, [courseId]);
        
        // 3. ALL STUDENTS ENROLLED
        const students = await pool.query(`
            SELECT 
                e.id as enrollment_id,
                e.user_id,
                e.enrolled_at,
                e.payment_status,
                e.amount_paid,
                u.name as student_name,
                u.email as student_email,
                u.created_at as member_since
            FROM enrollments e
            JOIN users u ON e.user_id = u.id
            WHERE e.course_id = $1 AND e.status = 'active'
            ORDER BY e.enrolled_at DESC
        `, [courseId]);
        
        // 4. WEEKLY ENROLLMENT TREND
        const weeklyTrend = await pool.query(`
            SELECT 
                DATE_TRUNC('week', e.enrolled_at) as week_start,
                COUNT(*) as enrollments
            FROM enrollments e
            WHERE e.course_id = $1 
                AND e.status = 'active'
                AND e.enrolled_at > NOW() - INTERVAL '8 weeks'
            GROUP BY DATE_TRUNC('week', e.enrolled_at)
            ORDER BY week_start DESC
        `, [courseId]);
        
        res.json({
            success: true,
            data: {
                course: courseInfo.rows[0],
                overview: {
                    total_enrolled: parseInt(enrollmentStats.rows[0].total_enrolled),
                    paid_count: parseInt(enrollmentStats.rows[0].paid_count),
                    pending_count: parseInt(enrollmentStats.rows[0].pending_count),
                    total_revenue: parseFloat(enrollmentStats.rows[0].total_revenue)
                },
                students: students.rows.map(s => ({
                    enrollment_id: s.enrollment_id,
                    user_id: s.user_id,
                    name: s.student_name,
                    email: s.student_email,
                    enrolled_at: s.enrolled_at,
                    payment_status: s.payment_status,
                    amount_paid: parseFloat(s.amount_paid),
                    member_since: s.member_since
                })),
                weekly_trend: weeklyTrend.rows
            }
        });
        
    } catch (err) {
        console.error("Course analytics error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROUTE 3: STUDENT DETAILS FOR A COURSE
// GET /api/analytics/course/:courseId/student/:studentId
// ============================================================
router.get("/course/:courseId/student/:studentId", authMiddleware, async (req, res) => {
    try {
        const { courseId, studentId } = req.params;
        
        if (!req.isCourseCreator) {
            return res.status(403).json({ error: "Access denied" });
        }
        
        const enrollmentResult = await pool.query(`
            SELECT 
                e.id as enrollment_id,
                e.enrolled_at,
                e.payment_status,
                e.amount_paid,
                u.name as student_name,
                u.email as student_email,
                u.created_at as member_since
            FROM enrollments e
            JOIN users u ON e.user_id = u.id
            WHERE e.course_id = $1 AND e.user_id = $2 AND e.status = 'active'
        `, [courseId, studentId]);
        
        if (enrollmentResult.rows.length === 0) {
            return res.status(404).json({ error: "Student not enrolled in this course" });
        }
        
        res.json({
            success: true,
            data: {
                student: enrollmentResult.rows[0]
            }
        });
        
    } catch (err) {
        console.error("Student details error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROUTE 4: REVENUE / EARNINGS ANALYTICS
// GET /api/analytics/earnings
// ============================================================
router.get("/earnings", authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        
        if (req.user.role !== 'educator' && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Access denied" });
        }
        
        // Monthly earnings breakdown
        const monthlyEarnings = await pool.query(`
            SELECT 
                DATE_TRUNC('month', e.enrolled_at) as month,
                COUNT(*) as enrollments,
                COALESCE(SUM(e.amount_paid), 0) as revenue
            FROM enrollments e
            JOIN courses c ON e.course_id = c.id
            WHERE c.educator_id = $1 
                AND e.status = 'active' 
                AND e.payment_status = 'completed'
                AND e.enrolled_at > NOW() - INTERVAL '12 months'
            GROUP BY DATE_TRUNC('month', e.enrolled_at)
            ORDER BY month DESC
        `, [userId]);
        
        // Total earnings by course
        const earningsByCourse = await pool.query(`
            SELECT 
                c.id as course_id,
                c.title,
                COUNT(e.id) as enrollments,
                COALESCE(SUM(e.amount_paid), 0) as revenue
            FROM courses c
            LEFT JOIN enrollments e ON c.id = e.course_id 
                AND e.status = 'active' 
                AND e.payment_status = 'completed'
            WHERE c.educator_id = $1 AND c.deleted_at IS NULL
            GROUP BY c.id, c.title
            ORDER BY revenue DESC
        `, [userId]);
        
        res.json({
            success: true,
            data: {
                monthly_earnings: monthlyEarnings.rows.map(m => ({
                    month: m.month,
                    enrollments: parseInt(m.enrollments),
                    revenue: parseFloat(m.revenue)
                })),
                earnings_by_course: earningsByCourse.rows.map(c => ({
                    course_id: c.course_id,
                    title: c.title,
                    enrollments: parseInt(c.enrollments),
                    revenue: parseFloat(c.revenue)
                }))
            }
        });
        
    } catch (err) {
        console.error("Earnings analytics error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// ROUTE 5: EXPORT COURSE REPORT
// GET /api/analytics/course/:courseId/export
// ============================================================
router.get("/course/:courseId/export", authMiddleware, async (req, res) => {
    try {
        const { courseId } = req.params;
        
        if (!req.isCourseCreator) {
            return res.status(403).json({ error: "Access denied" });
        }
        
        const students = await pool.query(`
            SELECT 
                u.name as "Student Name",
                u.email as "Email",
                e.enrolled_at as "Enrolled Date",
                e.payment_status as "Payment Status",
                e.amount_paid as "Amount Paid"
            FROM enrollments e
            JOIN users u ON e.user_id = u.id
            WHERE e.course_id = $1 AND e.status = 'active'
            ORDER BY e.enrolled_at DESC
        `, [courseId]);
        
        res.json({
            success: true,
            course_title: req.courseTitle,
            exported_at: new Date().toISOString(),
            total_students: students.rows.length,
            data: students.rows
        });
        
    } catch (err) {
        console.error("Export error:", err);
        res.status(500).json({ error: err.message });
    }
});

export default router;