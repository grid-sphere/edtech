import express from "express";
import pool from "../config/database.js";
import authMiddleware from "../middleware/auth.js";
import { activeEnrolmentSql } from "../utils/enrollmentAccess.js";


const router = express.Router();

// POST /api/video/progress
router.post("/progress", authMiddleware, async (req, res) => {
    try {
        const { contentId, courseId, position, is_completed, completed } = req.body;
        // 🌟 BULLETPROOF ID EXTRACTION
        const userId = req.user.id || req.user.userId || req.user.sub;
        const userRole = req.user.role;

        if (!contentId || !courseId) return res.status(400).json({ error: "contentId and courseId are required" });

        const isAdmin = userRole === 'admin';

        // 🌟 SAFE OWNERSHIP CHECK
        const courseCheck = await pool.query(`SELECT educator_id FROM courses WHERE id = $1`, [courseId]);
        const educatorId = courseCheck.rows.length > 0 ? courseCheck.rows[0].educator_id : null;
        const isCreator = educatorId && String(educatorId).toLowerCase() === String(userId).toLowerCase();

        const contentCheck = await pool.query(
            `SELECT preview, duration_seconds FROM content_items WHERE id = $1 AND is_active = true`, [contentId]
        );

        let isPreviewVideo = false;
        let videoDuration = 0;

        if (contentCheck.rows.length > 0) {
            isPreviewVideo = contentCheck.rows[0].preview === true;
            videoDuration = contentCheck.rows[0].duration_seconds || 0;
        }

        if (!isAdmin && !isCreator && !isPreviewVideo) {
            const enrollmentCheck = await pool.query(
                `SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2 AND ${activeEnrolmentSql('')}`,
                [userId, courseId]
            );
            if (enrollmentCheck.rows.length === 0) {
                return res.status(403).json({ error: "Not authorized or enrolled in this course" });
            }
        }

        /*
         * Two ways to finish something, and neither is "opened it".
         *
         *   - The viewer says so: a video that fired `ended`, or a PDF whose
         *     last page was scrolled into view. `completed` is the current
         *     spelling; `is_completed` is kept because a browser tab left open
         *     across the deploy is still sending it.
         *   - The watch position reached the end, which catches a student who
         *     closed the tab on the final seconds before `ended` fired.
         *
         * The client is trusted here, as it is in every LMS — this measures
         * study progress, not exam integrity, and the alternative (refusing
         * credit unless the server can prove it) mostly punishes people with
         * bad connections. What matters is that the claim is now made when the
         * content is finished rather than when it is opened.
         */
        const viewerSaysDone = is_completed === true || completed === true;
        const watchedToEnd = videoDuration > 0 && position >= videoDuration - 5;
        const finalIsCompleted = viewerSaysDone || watchedToEnd;

        await pool.query(`
            INSERT INTO video_progress (user_id, content_id, course_id, position, is_completed, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (user_id, content_id) 
            DO UPDATE SET 
                position = EXCLUDED.position,
                is_completed = CASE WHEN video_progress.is_completed = true THEN true ELSE EXCLUDED.is_completed END,           
                updated_at = NOW()
        `, [userId, contentId, courseId, position || 0, finalIsCompleted]);

        res.json({ success: true, message: "Progress saved", isCompleted: finalIsCompleted });
    } catch (err) {
        console.error("Save progress error:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/video/progress/course/:courseId
router.get("/progress/course/:courseId", authMiddleware, async (req, res) => {
    try {
        const { courseId } = req.params;
        const userId = req.user.id || req.user.userId || req.user.sub;

        const result = await pool.query(`
            SELECT content_id, is_completed, position, updated_at
            FROM video_progress
            WHERE user_id = $1 AND course_id = $2
        `, [userId, courseId]);

        const completedContentIds = result.rows.filter(r => r.is_completed).map(r => r.content_id);

        res.json({ success: true, progress: result.rows, completedContentIds });
    } catch (err) {
        console.error("Get course progress error:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/video/progress/:contentId
router.get("/progress/:contentId", authMiddleware, async (req, res) => {
    try {
        const { contentId } = req.params;
        const { courseId } = req.query;
        const userId = req.user.id || req.user.userId || req.user.sub;
        const userRole = req.user.role;

        if (!courseId) return res.status(400).json({ error: "courseId is required" });

        const isAdmin = userRole === 'admin';

        const courseCheck = await pool.query(`SELECT educator_id FROM courses WHERE id = $1`, [courseId]);
        const educatorId = courseCheck.rows.length > 0 ? courseCheck.rows[0].educator_id : null;
        const isCreator = educatorId && String(educatorId).toLowerCase() === String(userId).toLowerCase();

        const contentCheck = await pool.query(
            `SELECT preview FROM content_items WHERE id = $1 AND is_active = true`, [contentId]
        );

        const isPreviewVideo = contentCheck.rows.length > 0 && contentCheck.rows[0].preview === true;

        if (!isAdmin && !isCreator && !isPreviewVideo) {
            const enrollmentCheck = await pool.query(
                `SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2 AND ${activeEnrolmentSql('')}`,
                [userId, courseId]
            );
            if (enrollmentCheck.rows.length === 0) {
                return res.status(403).json({ error: "Not authorized to read watch history" });
            }
        }

        const result = await pool.query(`
            SELECT position, is_completed, updated_at
            FROM video_progress
            WHERE user_id = $1 AND content_id = $2
        `, [userId, contentId]);

        if (result.rows.length === 0) {
            return res.json({ hasProgress: false, position: 0, isCompleted: false });
        }

        res.json({
            hasProgress: true,
            position: result.rows[0].position,
            isCompleted: result.rows[0].is_completed || false,
            lastUpdated: result.rows[0].updated_at
        });
    } catch (err) {
        console.error("Get progress error:", err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
