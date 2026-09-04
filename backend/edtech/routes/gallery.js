/**
 * Home-screen banner images, managed by an admin.
 *
 * The carousel used to be built from courses: every published class that
 * happened to have a thumbnail, newest first. That made the most prominent
 * surface in the app a side effect of what a teacher last uploaded a cover for.
 * Nobody chose it, and nobody could change it without editing a course.
 *
 * These images are their own records. A banner may point at a class, but it is
 * not derived from one, so archiving or deleting a class cannot silently empty
 * the home screen.
 */
import express from "express";
import pool from "../config/database.js";
import { authOnly as authMiddleware } from "../middleware/auth.js";

const router = express.Router();

/**
 * Admin only.
 *
 * Every student sees this on opening the app, so it is a platform surface
 * rather than one teacher's content — a single educator should not be able to
 * change what the whole school looks at.
 *
 * Written as middleware rather than a line repeated in four handlers: a guard
 * that has to be remembered is a guard that eventually is not.
 */
function adminOnly(req, res, next) {
    if (req.user?.role !== "admin") {
        return res.status(403).json({ error: "Only an admin can manage the gallery." });
    }
    next();
}

/**
 * GET /api/gallery
 *
 * The admin's list: everything, including banners hidden from students, with
 * the linked class's title so the screen can show what each one points at.
 */
router.get("/", authMiddleware, adminOnly, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT g.id, g.image_url, g.caption, g.link_course_id,
                   g.sort_order, g.is_active, g.created_at,
                   c.title AS link_course_title
              FROM gallery_images g
              LEFT JOIN courses c ON c.id = g.link_course_id
             ORDER BY g.sort_order ASC, g.created_at DESC
        `);
        res.json({ images: rows });
    } catch (err) {
        console.error("gallery list error:", err.message);
        res.status(500).json({ error: "Could not load the gallery." });
    }
});

/**
 * POST /api/gallery
 *
 * The image itself is uploaded first via /api/content/upload-image, which
 * already stores to R2 and returns a URL. This records the resulting URL rather
 * than accepting the bytes a second time.
 */
router.post("/", authMiddleware, adminOnly, async (req, res) => {
    try {
        const { imageUrl, caption, linkCourseId } = req.body;
        if (!imageUrl || typeof imageUrl !== "string") {
            return res.status(400).json({ error: "An uploaded image is required." });
        }

        /*
         * A link to a course that does not exist would be a banner that opens
         * a "Course not found" page. Checked here rather than trusted from the
         * client, which picked from a list that may since have changed.
         */
        let link = linkCourseId || null;
        if (link) {
            const { rowCount } = await pool.query(
                `SELECT 1 FROM courses WHERE id = $1 AND is_active = true`, [link]
            );
            if (!rowCount) return res.status(400).json({ error: "That class no longer exists." });
        }

        // New banners go to the end, so adding one never reshuffles the rest.
        const { rows } = await pool.query(`
            INSERT INTO gallery_images (image_url, caption, link_course_id, sort_order, created_by)
            VALUES ($1, $2, $3,
                    COALESCE((SELECT MAX(sort_order) + 1 FROM gallery_images), 0),
                    $4)
            RETURNING id, image_url, caption, link_course_id, sort_order, is_active, created_at
        `, [imageUrl, (caption || "").trim().slice(0, 120) || null, link, req.user.id]);

        res.status(201).json({ image: rows[0] });
    } catch (err) {
        console.error("gallery create error:", err.message);
        res.status(500).json({ error: "Could not add that image." });
    }
});

/**
 * PUT /api/gallery/:id
 *
 * Caption, link and visibility. Each field is only written when the client
 * actually sent it — a screen that edits the caption must not blank the link
 * simply by not mentioning it.
 */
router.put("/:id", authMiddleware, adminOnly, async (req, res) => {
    try {
        const { caption, linkCourseId, isActive } = req.body;

        if (linkCourseId) {
            const { rowCount } = await pool.query(
                `SELECT 1 FROM courses WHERE id = $1 AND is_active = true`, [linkCourseId]
            );
            if (!rowCount) return res.status(400).json({ error: "That class no longer exists." });
        }

        const { rows } = await pool.query(`
            UPDATE gallery_images SET
                caption          = CASE WHEN $2::boolean THEN $3 ELSE caption END,
                link_course_id   = CASE WHEN $4::boolean THEN $5::uuid ELSE link_course_id END,
                is_active        = CASE WHEN $6::boolean THEN $7 ELSE is_active END
             WHERE id = $1::uuid
            RETURNING id, image_url, caption, link_course_id, sort_order, is_active
        `, [
            req.params.id,
            caption !== undefined, (caption || "").trim().slice(0, 120) || null,
            linkCourseId !== undefined, linkCourseId || null,
            isActive !== undefined, isActive === true,
        ]);

        if (!rows.length) return res.status(404).json({ error: "No such image." });
        res.json({ image: rows[0] });
    } catch (err) {
        console.error("gallery update error:", err.message);
        res.status(500).json({ error: "Could not update that image." });
    }
});

/**
 * PUT /api/gallery/reorder
 *
 * The whole arrangement, not one move. The server stores positions, so sending
 * the final order means two admins reordering at once end with one of the two
 * orders rather than an interleaving neither chose.
 *
 * Declared before /:id would otherwise match "reorder" as an id — Express takes
 * the first route that matches, and a uuid cast on the literal string
 * "reorder" fails with 22P02 rather than anything that reads as a routing bug.
 */
router.put("/reorder/all", authMiddleware, adminOnly, async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: "ids array is required" });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        for (let i = 0; i < ids.length; i++) {
            await client.query(
                `UPDATE gallery_images SET sort_order = $1 WHERE id = $2::uuid`, [i, ids[i]]
            );
        }
        await client.query("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("gallery reorder error:", err.message);
        res.status(500).json({ error: "Could not save the new order." });
    } finally {
        client.release();
    }
});

/**
 * DELETE /api/gallery/:id
 *
 * A real delete. The row holds no history worth keeping and the file stays in
 * R2 either way; a soft delete here would only accumulate rows the admin
 * cannot see to clean up.
 */
router.delete("/:id", authMiddleware, adminOnly, async (req, res) => {
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM gallery_images WHERE id = $1::uuid`, [req.params.id]
        );
        if (!rowCount) return res.status(404).json({ error: "No such image." });
        res.json({ success: true });
    } catch (err) {
        console.error("gallery delete error:", err.message);
        res.status(500).json({ error: "Could not delete that image." });
    }
});

export default router;
