import express from "express";
import { parseCategory, COURSE_CATEGORIES } from "../constants/courseCategories.js";
import pool from "../config/database.js";
import authMiddleware from "../middleware/auth.js";
import { activeEnrolmentSql, parseDurationMonths, parseDurationMinutes } from "../utils/enrollmentAccess.js";
import { announceCourseIfNew } from "../utils/notify.js";

import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/jwt.js";

const router = express.Router();

/*
 * GET /api/courses/categories
 *
 * Registered before any "/:id" route so the literal path wins the match —
 * Express takes the first route whose pattern fits, and "/:id" fits
 * "/categories" perfectly well.
 */
router.get("/categories", (req, res) => {
    res.json({ success: true, categories: COURSE_CATEGORIES });
});

// GET /api/courses

router.get("/", async (req, res) => {
    try {
        let userId = null;
        let userRole = null;
        
        // 1. Peek at the token to see who is asking (Student or Educator)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            try {
                const token = authHeader.split(" ")[1];
                const decoded = jwt.verify(token, JWT_SECRET);
                userId = decoded.id;
                userRole = decoded.role;
            } catch (err) {}
        }

        // 2. Base query
        let query = `
            SELECT c.*, u.name as educator_name
            FROM courses c
            JOIN users u ON c.educator_id = u.id
            WHERE c.is_active = true AND c.deleted_at IS NULL
        `;
        const params = [];

        // 3. Apply strict security filters based on role
        if (userRole === "admin") {
            // Admins see everything
        } else if (userRole === "educator" && userId) {
            // Educators see ALL published courses + ONLY their own drafts
            query += ` AND (c.status = 'published' OR c.educator_id = $1)`;
            params.push(userId);
        } else {
            // 🌟 STUDENTS AND GUESTS ONLY SEE PUBLISHED COURSES
            query += ` AND c.status = 'published'`;
        }

        query += ` ORDER BY c.created_at DESC`;

        const result = await pool.query(query, params);
        res.json({ success: true, courses: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/my-courses
router.get("/my-courses", authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const userRole = req.user.role;

        let courses = [];

        if (userRole === "student") {
            const result = await pool.query(`
                SELECT
                    c.*,
                    u.name as educator_name,
                    e.enrolled_at,
                    e.expires_at,
                    -- e.progress / e.last_accessed removed: neither column
                    -- exists, so this endpoint threw on every call. Progress
                    -- is derived in GET /api/enrollments, which is what the
                    -- UI actually reads.
                    e.status as enrollment_status
                FROM enrollments e
                JOIN courses c ON e.course_id = c.id
                JOIN users u ON c.educator_id = u.id
                WHERE e.user_id = $1
                    AND e.status = 'active'
                    AND c.status = 'published'
                    AND c.deleted_at IS NULL
                ORDER BY e.enrolled_at DESC
            `, [userId]);
            courses = result.rows;
        } else if (userRole === "educator") {
            const result = await pool.query(`
                SELECT
                    c.*,
                    u.name as educator_name,
                    COUNT(DISTINCT e.user_id) as total_students,
                    COUNT(DISTINCT m.id) as total_modules,
                    COUNT(DISTINCT ci.id) as total_contents
                FROM courses c
                JOIN users u ON c.educator_id = u.id
                LEFT JOIN enrollments e ON c.id = e.course_id AND e.status = 'active'
                LEFT JOIN modules m ON c.id = m.course_id
                LEFT JOIN content_items ci ON ci.id = ANY(m.content_ids)
                WHERE c.educator_id = $1
                    AND c.deleted_at IS NULL
                GROUP BY c.id, u.name
                ORDER BY c.created_at DESC
            `, [userId]);
            courses = result.rows;
        } else if (userRole === "admin") {
            const result = await pool.query(`
                SELECT
                    c.*,
                    u.name as educator_name,
                    COUNT(DISTINCT e.user_id) as total_students
                FROM courses c
                JOIN users u ON c.educator_id = u.id
                LEFT JOIN enrollments e ON c.id = e.course_id AND e.status = 'active'
                WHERE c.deleted_at IS NULL
                GROUP BY c.id, u.name
                ORDER BY c.created_at DESC
            `);
            courses = result.rows;
        }

        res.json({
            success: true,
            role: userRole,
            count: courses.length,
            courses
        });
    } catch (err) {
        console.error("My courses error:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/courses/:id
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;

        /*
         * Fetch first, authorise below — `status = 'published'` used to be in
         * this WHERE clause.
         *
         * That conflated "listed publicly" with "you may open it", and the two
         * are not the same thing. Unpublishing a course a student has already
         * paid for would 404 their course page: their enrolment, their
         * progress and their payment would all still exist, and the course
         * would simply be gone.
         *
         * That is not hypothetical. Closing a teacher's account unpublishes
         * their courses, so without this every student they taught would lose
         * access the moment the teacher left.
         */
        const courseResult = await pool.query(`
            SELECT c.*, u.name as educator_name
            FROM courses c
            JOIN users u ON c.educator_id = u.id
            WHERE c.id = $1 AND c.is_active = true
        `, [id]);

        if (courseResult.rows.length === 0) {
            return res.status(404).json({ error: "Course not found" });
        }

        const course = courseResult.rows[0];

        let isEnrolled = false;
        let isCreator = false;

        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            try {
                const token = authHeader.split(" ")[1];
                const decoded = jwt.verify(token, JWT_SECRET);

                /*
                 * Accept the parent class's enrolment, matching every access
                 * gate. Students buy a class and study its subjects, so
                 * checking only this course id reported isEnrolled = false on
                 * every subject page — the UI offered "Enroll" to students who
                 * already had access, and after renewing, the page still
                 * looked unpurchased even though the content had unlocked.
                 */
                const enrollmentCheck = await pool.query(
                    `SELECT id FROM enrollments
                      WHERE user_id = $1
                        AND ${activeEnrolmentSql('')}
                        AND course_id IN (
                            SELECT $2::uuid
                            UNION
                            SELECT parent_course_id FROM courses
                             WHERE id = $2::uuid AND parent_course_id IS NOT NULL
                        )`,
                    [decoded.id, id]
                );
                isEnrolled = enrollmentCheck.rows.length > 0;
                isCreator = course.educator_id === decoded.id;
            } catch (err) {
                // Never swallow this. A verify failure here silently strips
                // isCreator/isEnrolled, so the UI hides every educator control
                // and looks like a permissions bug with nothing in the logs.
                console.warn(
                    `[courses] token verification failed on GET /courses/${id}: ${err.message}. ` +
                    `isCreator/isEnrolled will be false.`
                );
            }
        }

        /*
         * The published check, moved here so it can take enrolment into
         * account.
         *
         * An unpublished course is hidden from the catalogue but must stay
         * open to the two people entitled to it: someone already enrolled, and
         * the educator who built it. Everyone else gets the same 404 as before,
         * so nothing became more visible than it was.
         */
        if (course.status !== 'published' && !isEnrolled && !isCreator) {
            return res.status(404).json({ error: "Course not found" });
        }

        const modulesResult = await pool.query(`
            SELECT * FROM modules
            WHERE course_id = $1 AND is_active = true
            ORDER BY module_order ASC
        `, [id]);

        const modules = [];
        for (const module of modulesResult.rows) {
            let contents = [];
            if (module.content_ids && module.content_ids.length > 0) {
                // ✅ FIXED: Added all needed fields including file_size_bytes
                const contentResult = await pool.query(`
                    SELECT 
                        id, 
                        title, 
                        description, 
                        content_type, 
                        duration_seconds,
                        thumbnail_url, 
                        preview, 
                        priority, 
                        file_size_bytes,
                        file_name,
                        mime_type,
                        status,
                        r2_key,
                        created_at,
                        folder_id,
                        -- Carries { pending: true } while later renditions are
                        -- still encoding, so the row can keep showing progress
                        -- after the video becomes watchable.
                        metadata
                    FROM content_items
                    WHERE id = ANY($1::uuid[])
                    AND is_active = true
                    AND ($2::boolean OR status = 'ready')
                `, [module.content_ids, isCreator]);
                
                // Log the file sizes for debugging
                contentResult.rows.forEach(c => {
                    if (c.content_type === 'pdf') {
                        console.log(`📄 PDF: ${c.title} - ${c.file_size_bytes || 0} bytes`);
                    }
                });
                
                contents = contentResult.rows;
            }
            modules.push({ ...module, contents });
        }

        res.json({
            success: true,
            course: {
                ...course,
                isEnrolled,
                isCreator
            },
            modules
        });
    } catch (err) {
        console.error("Course fetch error:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/courses
router.post("/", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== "educator" && req.user.role !== "admin") {
            return res.status(403).json({ error: "Only educators can create courses" });
        }

        const { title, description, price, status, parent_course_id, thumbnail_url, access_duration_months, access_duration_minutes, category } = req.body;

        const duration = parseDurationMonths(access_duration_months);
        if (!duration.ok) return res.status(400).json({ error: duration.error });
        const testDuration = parseDurationMinutes(access_duration_minutes);
        if (!testDuration.ok) return res.status(400).json({ error: testDuration.error });
        const cat = parseCategory(category);
        if (!cat.ok) return res.status(400).json({ error: cat.error });

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            /*
             * display_order is assigned here rather than left NULL.
             *
             * The dashboard sorts on display_order and treats NULL as 0, so an
             * unassigned course tied with every other unarranged one and fell
             * through to the alphabetical tiebreak — which is why a new course
             * appeared partway up the list instead of at the bottom.
             *
             * MAX + 1 within its own sibling group puts it last. IS NOT
             * DISTINCT FROM (not `=`) is required so top-level courses, where
             * parent_course_id is NULL, group together at all: `NULL = NULL`
             * is NULL in SQL, so `=` would match no rows and every top-level
             * course would restart at 1.
             */
            const courseResult = await client.query(`
    INSERT INTO courses (educator_id, title, description, price, status, thumbnail_url, is_active, parent_course_id, access_duration_months, access_duration_minutes, category, display_order)
    SELECT $1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10,
           COALESCE((
               SELECT MAX(display_order) FROM courses
               WHERE educator_id = $1
                 AND is_active = true
                 AND parent_course_id IS NOT DISTINCT FROM $7
           ), 0) + 1
    RETURNING *
`, [req.user.id, title, description, price || 0, status || "draft", thumbnail_url || null, parent_course_id || null, duration.months, testDuration.minutes, cat.value]);
            const course = courseResult.rows[0];

            const moduleResult = await client.query(`
                INSERT INTO modules (course_id, title, description, module_order, content_ids, is_active)
                VALUES ($1, $2, $3, $4, $5, true) RETURNING *
            `, [course.id, "Preview Module", "Course preview content - get a glimpse of what you'll learn", 0, []]);

            await client.query("COMMIT");

            // Courses are normally created as drafts, so this usually does
            // nothing — it covers the case of one created published outright.
            // No-op unless the course is genuinely published and unannounced.
            await announceCourseIfNew(course.id, req.user.id);

            res.status(201).json({
                success: true,
                course: course,
                previewModule: moduleResult.rows[0],
                message: "Course created with preview module"
            });

        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }

    } catch (err) {
        console.error("Course creation error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/courses/reorder
router.put("/reorder", authMiddleware, async (req, res) => {
    try {
        const { orderedIds } = req.body;

        if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
            return res.status(400).json({ error: "orderedIds array is required" });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            for (let i = 0; i < orderedIds.length; i++) {
                await client.query(
                    `UPDATE courses
                     SET display_order = $1, updated_at = NOW()
                     WHERE id = $2 AND educator_id = $3`,
                    [i, orderedIds[i], req.user.id]
                );
            }

            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }

        res.json({ success: true, message: "Order updated" });
    } catch (err) {
        console.error("Reorder error:", err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/courses/:id
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        if (!req.isCourseCreator) {
            return res.status(403).json({ error: "Only course creator can update courses" });
        }

        const { title, description, price, status, thumbnail_url, access_duration_months, access_duration_minutes, category } = req.body;

        const duration = parseDurationMonths(access_duration_months);
        if (!duration.ok) return res.status(400).json({ error: duration.error });
        const testDuration = parseDurationMinutes(access_duration_minutes);
        if (!testDuration.ok) return res.status(400).json({ error: testDuration.error });
        const cat = parseCategory(category);
        if (!cat.ok) return res.status(400).json({ error: cat.error });

        const result = await pool.query(`
    UPDATE courses
    SET title = COALESCE($1, title),
        description = COALESCE($2, description),
        price = COALESCE($3, price),
        status = COALESCE($4, status),
        thumbnail_url = COALESCE($5, thumbnail_url),
        -- Not COALESCE: clearing the field back to lifetime access has to be
        -- possible, and COALESCE would read that null as "leave unchanged".
        -- Only applies to future purchases; enrolments already sold keep the
        -- expires_at stamped when they were bought.
        access_duration_months = $6,
        access_duration_minutes = $7,
        -- Also not COALESCE, for the same reason: a teacher must be able to
        -- clear the category back to uncategorised once they have set one.
        category = $8,
        updated_at = NOW()
    WHERE id = $9
    RETURNING *
`, [title, description, price, status, thumbnail_url, duration.months, testDuration.minutes, cat.value, id]);

        /*
         * This is the hook that actually fires in practice: a teacher builds a
         * course as a draft, then flips it to published.
         *
         * Called unconditionally rather than only when `status === 'published'`
         * in this request. The COALESCE above means an update that omits status
         * leaves an already-published course published, and announceCourseIfNew
         * re-reads the committed row and decides for itself — so the decision
         * is made from the course's real state, not from what this particular
         * request happened to send.
         */
        await announceCourseIfNew(id, req.user.id);

        res.json({ success: true, course: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/courses/:id/publish
 *
 * The Publish/Draft toggle on the course page.
 *
 * This route was missing entirely. The frontend has always called it, and
 * `PUT /:id` did not answer because that pattern matches a single segment
 * while this URL has two — so every toggle 404'd, the optimistic state was
 * rolled back, and the button snapped straight back to where it started.
 *
 * Body: { is_published: boolean }
 */
router.put("/:id/publish", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { is_published } = req.body;

        if (typeof is_published !== "boolean") {
            return res.status(400).json({ error: "is_published must be true or false" });
        }

        // Checked against the row rather than req.isCourseCreator: the
        // middleware resolves that flag from a courseId it infers from the
        // path, and an inference that changes shape should not be what decides
        // who may publish.
        const owner = await pool.query(
            `SELECT educator_id FROM courses WHERE id = $1 AND is_active = true`,
            [id]
        );
        if (owner.rows.length === 0) return res.status(404).json({ error: "Course not found" });
        if (owner.rows[0].educator_id !== req.user.id && req.user.role !== "admin") {
            return res.status(403).json({ error: "Only the course creator can publish this course" });
        }

        const result = await pool.query(
            `UPDATE courses
                SET status = $2, updated_at = NOW()
              WHERE id = $1
            RETURNING *`,
            [id, is_published ? "published" : "draft"]
        );

        // Only announces the first time, and only when actually published.
        const notified = await announceCourseIfNew(id, req.user.id);

        res.json({ success: true, course: result.rows[0], notified });
    } catch (err) {
        console.error("PUT /courses/:id/publish:", err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/courses/:id
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const courseId = req.query.courseId || req.params.id;

        if (!courseId) {
            return res.status(400).json({ error: "courseId is required" });
        }

        const courseCheck = await pool.query(
            `SELECT educator_id FROM courses WHERE id = $1 AND is_active = true`,
            [courseId]
        );

        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: "Course not found or already deleted" });
        }

        if (courseCheck.rows[0].educator_id !== req.user.id) {
            return res.status(403).json({ error: "Only course creator can delete courses" });
        }

        /*
         * Delete the class and its subjects together.
         *
         * Only the named row was being deactivated, so deleting a class left
         * its subjects active and still enrolled-in — reachable by direct link,
         * and still listed for students who had bought them, while the class
         * they belonged to had vanished.
         *
         * The enrolment rows are deliberately left alone. They are the record
         * that a purchase happened, which matters for refunds and revenue
         * reporting; access is denied because the course is inactive, not
         * because the sale was erased.
         */
        const result = await pool.query(`
            UPDATE courses
            SET is_active = false,
                status = 'deleted',
                updated_at = NOW()
            WHERE (id = $1 OR parent_course_id = $1) AND is_active = true
            RETURNING id, parent_course_id
        `, [courseId]);

        const subjectsRemoved = result.rows.filter((r) => r.parent_course_id).length;

        res.json({
            success: true,
            message: subjectsRemoved
                ? `Course deleted, along with ${subjectsRemoved} subject${subjectsRemoved === 1 ? '' : 's'} inside it.`
                : "Course deactivated successfully",
            removed: result.rows.length,
        });
    } catch (err) {
        console.error("Delete course error:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/courses/:id/reactivate
router.post("/:id/reactivate", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;

        if (!req.isCourseCreator) {
            return res.status(403).json({ error: "Only course creator can reactivate" });
        }

        const result = await pool.query(`
            UPDATE courses
            SET is_active = true,
                status = 'draft',
                updated_at = NOW()
            WHERE id = $1 AND is_active = false
            RETURNING id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Course not found or already active" });
        }

        res.json({ success: true, message: "Course reactivated successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;