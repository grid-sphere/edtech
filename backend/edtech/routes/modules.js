

import express from "express";
import pool from "../config/database.js";
import authMiddleware, { canManage } from "../middleware/auth.js";

const router = express.Router()
// POST /api/modules
// POST /api/modules
router.post("/", authMiddleware, async (req, res) => {
    try {
        const { course_id, title, description } = req.body;

        // FIX: Removed 'AND is_active = true' from this query.
        // It will now safely count deleted modules to avoid unique constraint crashes.
        const orderResult = await pool.query(
            `SELECT COALESCE(MAX(module_order), -1) + 1 AS next_order FROM modules WHERE course_id = $1`,
            [course_id]
        );
        
        const nextOrder = orderResult.rows[0]?.next_order || 0;
        
        const result = await pool.query(`
            INSERT INTO modules (course_id, title, description, module_order, content_ids, is_active)
            VALUES ($1, $2, $3, $4, $5, true) RETURNING *
        `, [course_id, title, description, nextOrder, []]);
        
        res.status(201).json({ success: true, module: result.rows[0] });
    } catch (err) {
        console.error("Module creation error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});
// GET /api/modules/:id
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`SELECT * FROM modules WHERE id = $1 AND is_active = true`, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Module not found" });
        }
        res.json({ success: true, module: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/courses/:courseId/modules
router.get("/courses/:courseId/modules", async (req, res) => {
    try {
        const { courseId } = req.params;
        const result = await pool.query(`
            SELECT * FROM modules 
            WHERE course_id = $1 AND is_active = true
            ORDER BY module_order ASC
        `, [courseId]);
        res.json({ success: true, modules: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/modules/:id
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, module_order } = req.body;
        
        if (!req.isCourseCreator) {
            return res.status(403).json({ error: "Only course creator can update modules" });
        }
        
        const updateFields = [];
        const values = [];
        let paramCounter = 1;
        
        if (title !== undefined) {
            updateFields.push(`title = $${paramCounter++}`);
            values.push(title === "" ? null : title);
        }
        if (description !== undefined) {
            updateFields.push(`description = $${paramCounter++}`);
            values.push(description === "" ? null : description);
        }
        if (module_order !== undefined) {
            updateFields.push(`module_order = $${paramCounter++}`);
            values.push(module_order);
        }
        
        if (updateFields.length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }
        
        updateFields.push(`updated_at = NOW()`);
        values.push(id);
        
        const query = `
            UPDATE modules 
            SET ${updateFields.join(', ')}
            WHERE id = $${paramCounter}
            RETURNING *
        `;
        
        const result = await pool.query(query, values);
        res.json({ success: true, module: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/modules/:id
// DELETE /api/modules/:id
/**
 * PUT /api/modules/:moduleId/reorder
 * Body: { items: [{ id, type: 'content' | 'quiz' }, ...] }  — in display order
 *
 * Content and quizzes live in different tables but share a `priority` column,
 * which is what lets a quiz sit between two PDFs in one list.
 *
 * Position comes from the array index, so the list is renumbered 0..n-1 on
 * every save. That is deliberate: uploads default to the same priority, so
 * without a full renumber the values stay tied and the order is undefined.
 *
 * One UPDATE per table via unnest, inside a transaction — not a query per row.
 * A move near the top of the list renumbers most of it, and a partial write
 * would leave duplicate priorities and an order nobody chose.
 */
router.put("/:moduleId/reorder", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { moduleId } = req.params;
        const { items } = req.body;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "items must be a non-empty array" });
        }

        const ownership = await client.query(`
            SELECT c.educator_id, m.content_ids
            FROM modules m
            JOIN courses c ON m.course_id = c.id
            WHERE m.id = $1
        `, [moduleId]);

        if (ownership.rows.length === 0) {
            return res.status(404).json({ error: "Module not found" });
        }
        if (ownership.rows[0].educator_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Only the course creator can reorder content" });
        }

        // Only ids that genuinely belong to this module may be written.
        // Checking membership here rather than in a correlated subquery keeps
        // the SQL trivial (and testable) without weakening the guarantee: an
        // id from another course is simply never sent to the database.
        const moduleContentIds = new Set(
            (ownership.rows[0].content_ids || []).map(String)
        );

        // Split into the two tables, carrying each item's position.
        const contentIds = [];
        const contentPositions = [];
        const quizIds = [];
        const quizPositions = [];

        items.forEach((item, index) => {
            if (!item || !item.id) return;
            if (item.type === 'quiz') {
                quizIds.push(item.id);
                quizPositions.push(index);
            } else if (moduleContentIds.has(String(item.id))) {
                contentIds.push(item.id);
                contentPositions.push(index);
            }
        });

        await client.query("BEGIN");

        let contentUpdated = 0;
        let quizUpdated = 0;

        // One statement per row rather than a single unnest-based UPDATE.
        // Both are correct, but this form is plain SQL that can be verified
        // locally, and a module holds tens of items, not thousands — the extra
        // round trips inside one transaction are not worth untested cleverness.
        for (let i = 0; i < contentIds.length; i++) {
            const result = await client.query(
                `UPDATE content_items SET priority = $1 WHERE id = $2`,
                [contentPositions[i], contentIds[i]]
            );
            contentUpdated += result.rowCount;
        }

        for (let i = 0; i < quizIds.length; i++) {
            const result = await client.query(`
                UPDATE quizzes
                SET priority = $1, updated_at = NOW()
                WHERE id = $2 AND module_id = $3
            `, [quizPositions[i], quizIds[i], moduleId]);
            quizUpdated += result.rowCount;
        }

        await client.query("COMMIT");

        res.json({
            success: true,
            content: contentUpdated,
            quizzes: quizUpdated,
            total: contentUpdated + quizUpdated,
        });

    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("Module reorder error:", err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        
        // 1. FIRST, fetch the educator_id from the database using a JOIN
        const courseResult = await pool.query(`
            SELECT c.educator_id 
            FROM courses c
            JOIN modules m ON c.id = m.course_id
            WHERE m.id = $1
        `, [id]);

        // 2. Check if the module actually exists before proceeding
        if (courseResult.rows.length === 0) {
            return res.status(404).json({ error: "Module not found" });
        }

        // 3. NOW we can safely check if the logged-in user is the creator
        if (!canManage(courseResult.rows[0].educator_id, req.user)) {
            return res.status(403).json({ error: "Only the course creator or an admin can delete modules" });
        }                
        
        // 4. Finally, do the actual soft-delete
        const result = await pool.query(`
            UPDATE modules 
            SET is_active = false, 
                updated_at = NOW()
            WHERE id = $1 AND is_active = true
            RETURNING id
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Module not found or already deleted" });
        }
        
        res.json({ success: true, message: "Module deactivated successfully" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});        
router.post("/:id/reactivate", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!req.isCourseCreator) {
            return res.status(403).json({ error: "Only course creator can reactivate" });
        }
        
        const result = await pool.query(`
            UPDATE modules 
            SET is_active = true, 
                updated_at = NOW()
            WHERE id = $1 AND is_active = false
            RETURNING id
        `, [id]);
        
        res.json({ success: true, message: "Module reactivated successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/modules/:moduleId/content
router.post("/:moduleId/content", authMiddleware, async (req, res) => {
    try {
        const { moduleId } = req.params;
        const { content_id } = req.body;
        
        if (!req.isCourseCreator) {
            return res.status(403).json({ error: "Only course creator can add content to modules" });
        }
        
        const moduleResult = await pool.query(
            `SELECT content_ids FROM modules WHERE id = $1 AND is_active = true`,
            [moduleId]
        );
        
        if (moduleResult.rows.length === 0) {
            return res.status(404).json({ error: "Module not found or inactive" });
        }
        
        let currentIds = moduleResult.rows[0]?.content_ids || [];
        if (!currentIds.includes(content_id)) {
            currentIds.push(content_id);
            await pool.query(`UPDATE modules SET content_ids = $1, updated_at = NOW() WHERE id = $2`, [currentIds, moduleId]);
        }
        
        res.json({ success: true, message: "Content added to module" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/modules/:moduleId/content/:contentId
router.delete("/:moduleId/content/:contentId", async (req, res) => {
    try {
        const { moduleId, contentId } = req.params;
        const moduleResult = await pool.query(`SELECT content_ids FROM modules WHERE id = $1`, [moduleId]);
        if (moduleResult.rows.length === 0) {
            return res.status(404).json({ error: "Module not found" });
        }
        const currentIds = moduleResult.rows[0]?.content_ids || [];
        const newIds = currentIds.filter(id => id !== contentId);
        await pool.query(`UPDATE modules SET content_ids = $1, updated_at = NOW() WHERE id = $2`, [newIds, moduleId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
