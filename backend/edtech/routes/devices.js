/**
 * Admin → Device management.
 *
 * Sets how many devices a student may be signed in on at once, and lets an
 * admin see and sign out a student's devices — the way a student who lost a
 * phone, or hit the limit, gets a slot back.
 */
import express from "express";
import pool from "../config/database.js";
import { authOnly as authMiddleware } from "../middleware/auth.js";
import { getDeviceLimit, revokeSession, revokeAllSessions } from "../utils/deviceSessions.js";

const router = express.Router();

/** Highest limit accepted. A typo of 1000 should not be saved silently. */
const MAX_LIMIT = 20;

function adminOnly(req, res, next) {
    if (req.user?.role !== "admin") {
        return res.status(403).json({ error: "Only an admin can manage devices." });
    }
    next();
}

router.use(authMiddleware, adminOnly);

/** GET /api/devices/settings */
router.get("/settings", async (req, res) => {
    res.json({ success: true, limit: await getDeviceLimit(), max: MAX_LIMIT });
});

/**
 * PUT /api/devices/settings
 * Body: { limit: number | null }  — null or 0 turns the limit off.
 */
router.put("/settings", async (req, res) => {
    try {
        const raw = req.body?.limit;
        let limit = null;
        if (raw !== null && raw !== undefined && raw !== "" && Number(raw) !== 0) {
            limit = Number(raw);
            if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
                return res.status(400).json({ error: `Limit must be a whole number from 1 to ${MAX_LIMIT}, or off.` });
            }
        }
        await pool.query(
            `UPDATE platform_settings SET device_limit = $1, updated_by = $2, updated_at = NOW() WHERE id = 1`,
            [limit, req.user.id]
        );
        res.json({ success: true, limit });
    } catch (err) {
        console.error("PUT /devices/settings:", err);
        res.status(500).json({ error: "Could not save the device limit." });
    }
});

/**
 * GET /api/devices/users?q=
 *
 * Students with their count of signed-in devices, busiest first. Without a
 * search, only students who have at least one device are listed — the list an
 * admin actually needs is "who is signed in where", not every account.
 */
router.get("/users", async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();
        const { rows } = await pool.query(
            `SELECT u.id, u.name, u.email, u.phone, u.role,
                    COUNT(s.id)::int AS active_devices,
                    MAX(s.last_seen_at) AS last_seen_at
               FROM users u
               LEFT JOIN user_sessions s ON s.user_id = u.id AND s.revoked_at IS NULL
              WHERE u.deleted_at IS NULL
                AND u.role = 'student'
                AND ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%')
              GROUP BY u.id
             HAVING $1 <> '' OR COUNT(s.id) > 0
              ORDER BY active_devices DESC, last_seen_at DESC NULLS LAST, u.name
              LIMIT 200`,
            [q]
        );
        res.json({ success: true, users: rows });
    } catch (err) {
        console.error("GET /devices/users:", err);
        res.status(500).json({ error: "Could not load students." });
    }
});

/** GET /api/devices/users/:userId — that student's signed-in devices. */
router.get("/users/:userId", async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, device_name, ip, created_at, last_seen_at
               FROM user_sessions
              WHERE user_id = $1 AND revoked_at IS NULL
              ORDER BY last_seen_at DESC`,
            [req.params.userId]
        );
        res.json({ success: true, devices: rows });
    } catch (err) {
        console.error("GET /devices/users/:id:", err);
        res.status(500).json({ error: "Could not load devices." });
    }
});

/** DELETE /api/devices/sessions/:id — sign one device out. */
router.delete("/sessions/:id", async (req, res) => {
    try {
        const ok = await revokeSession(req.params.id);
        res.json({ success: true, revoked: ok });
    } catch (err) {
        console.error("DELETE /devices/sessions/:id:", err);
        res.status(500).json({ error: "Could not sign out that device." });
    }
});

/** DELETE /api/devices/users/:userId — sign out every device. */
router.delete("/users/:userId", async (req, res) => {
    try {
        const n = await revokeAllSessions(req.params.userId);
        res.json({ success: true, revoked: n });
    } catch (err) {
        console.error("DELETE /devices/users/:id:", err);
        res.status(500).json({ error: "Could not sign out those devices." });
    }
});

export default router;
