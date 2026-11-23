/**
 * Device sessions and the per-student device limit.
 *
 * A JWT on its own cannot be counted or taken back: once issued it is valid
 * until it expires, and nothing on the server knows how many exist. So every
 * full sign-in now also opens a row in user_sessions, and the token carries
 * that row's id as `sid`. The middleware checks the row on each request, which
 * is what makes two things possible:
 *
 *   - counting how many devices a student is signed in on, so a login past the
 *     admin's limit can be refused;
 *   - signing a device out from the admin panel, which revokes the row and so
 *     kills the token on its next request.
 *
 * The limit applies to students only. Staff accounts still get session rows
 * (so an admin can see and revoke them) but are never refused.
 */
import pool from "../config/database.js";

/** Read the platform-wide limit. null means unlimited. */
export async function getDeviceLimit() {
    try {
        const { rows } = await pool.query(`SELECT device_limit FROM platform_settings WHERE id = 1`);
        const n = rows[0]?.device_limit;
        return Number.isInteger(n) && n > 0 ? n : null;
    } catch (err) {
        // A settings read failing must not lock everyone out.
        console.error("[devices] could not read device_limit:", err.message);
        return null;
    }
}

/** Whether the device limit applies to this account at all. */
export const limitApplies = (user) => user?.role === "student";

/** A short human label from a User-Agent, e.g. "Chrome on Windows". */
export function describeDevice(ua = "") {
    const s = String(ua);
    const os =
        /Android/i.test(s) ? "Android" :
        /iPhone|iPad|iPod/i.test(s) ? "iOS" :
        /Windows/i.test(s) ? "Windows" :
        /Mac OS X|Macintosh/i.test(s) ? "Mac" :
        /CrOS/i.test(s) ? "ChromeOS" :
        /Linux/i.test(s) ? "Linux" : "Unknown device";
    const browser =
        /Edg\//i.test(s) ? "Edge" :
        /OPR\/|Opera/i.test(s) ? "Opera" :
        /SamsungBrowser/i.test(s) ? "Samsung Internet" :
        /Chrome\//i.test(s) ? "Chrome" :
        /Firefox\//i.test(s) ? "Firefox" :
        /Safari\//i.test(s) ? "Safari" : null;
    return browser ? `${browser} on ${os}` : os;
}

/** Normalise the client's persistent device id: a short opaque token or null. */
function cleanDeviceId(raw) {
    const s = String(raw ?? "").trim();
    return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

const clientIp = (req) =>
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || null;

/**
 * Open a session for a full sign-in.
 *
 * The same browser signing in again reuses its slot rather than taking a new
 * one: the client sends a device id it keeps in localStorage across sign-outs,
 * and any live session with that id is replaced. Without this, a student who
 * was signed out by an expired token, or who signs in twice on the same laptop,
 * would use up their limit on one machine.
 *
 * @returns {Promise<{ok: true, sid: string} | {ok: false, limit: number, active: number}>}
 */
export async function openSession(user, req) {
    const deviceId = cleanDeviceId(req.body?.deviceId ?? req.headers["x-device-id"]);
    const ua = String(req.headers["user-agent"] || "").slice(0, 400);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // Serialise sign-ins for one account so two simultaneous logins cannot
        // both see "one slot left" and both take it.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sessions:${user.id}`]);

        if (deviceId) {
            await client.query(
                `UPDATE user_sessions SET revoked_at = NOW()
                  WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
                [user.id, deviceId]
            );
        }

        if (limitApplies(user)) {
            const limit = await getDeviceLimit();
            if (limit) {
                const { rows } = await client.query(
                    `SELECT COUNT(*)::int AS n FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
                    [user.id]
                );
                if (rows[0].n >= limit) {
                    await client.query("ROLLBACK");
                    return { ok: false, limit, active: rows[0].n };
                }
            }
        }

        const { rows } = await client.query(
            `INSERT INTO user_sessions (user_id, device_id, device_name, user_agent, ip)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [user.id, deviceId, describeDevice(ua), ua, clientIp(req)]
        );
        await client.query("COMMIT");
        invalidate(rows[0].id);
        return { ok: true, sid: rows[0].id };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** The response for a refused sign-in. One wording, used by login and register. */
export const deviceLimitError = ({ limit }) => ({
    code: "DEVICE_LIMIT",
    error:
        `You are already signed in on ${limit} device${limit === 1 ? "" : "s"}, the most allowed. ` +
        `Sign out on one of them, or ask your administrator to remove a device.`,
});

/*
 * A short cache of session checks.
 *
 * Every authenticated request would otherwise cost a query, and a course page
 * makes a dozen. Fifteen seconds means a device the admin removes stops working
 * within that window, which is fine for this purpose. Revocations made in this
 * process clear the entry immediately.
 */
const CACHE_MS = 15_000;
const cache = new Map(); // sid -> { active, at }

export function invalidate(sid) {
    if (sid) cache.delete(sid);
}

/** Drop every cached entry; used when revoking by user rather than by id. */
export function invalidateAll() {
    cache.clear();
}

/**
 * Is the token's session still live?
 *
 * Tokens issued before sessions existed carry no `sid`. Those are allowed
 * unless a device limit is on and the account is a student — then they would
 * be an uncounted extra device, so they are sent back to sign in, which opens
 * a counted session.
 *
 * @returns {Promise<{ok: true} | {ok: false, error: string, code: string}>}
 */
export async function checkSession(decoded) {
    if (!decoded.sid) {
        if (limitApplies(decoded) && (await getDeviceLimit())) {
            return { ok: false, code: "SESSION_ENDED", error: "Please sign in again." };
        }
        return { ok: true };
    }

    const hit = cache.get(decoded.sid);
    let active;
    if (hit && Date.now() - hit.at < CACHE_MS) {
        active = hit.active;
    } else {
        const { rows } = await pool.query(
            `UPDATE user_sessions SET last_seen_at = NOW()
              WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
            RETURNING id`,
            [decoded.sid, decoded.id]
        );
        active = rows.length > 0;
        cache.set(decoded.sid, { active, at: Date.now() });
        if (cache.size > 5000) cache.delete(cache.keys().next().value);
    }

    return active
        ? { ok: true }
        : { ok: false, code: "SESSION_ENDED", error: "This device was signed out. Please sign in again." };
}

/** Revoke one session. Returns true if it was live. */
export async function revokeSession(sid, userId = null) {
    const { rowCount } = await pool.query(
        `UPDATE user_sessions SET revoked_at = NOW()
          WHERE id = $1 AND revoked_at IS NULL ${userId ? "AND user_id = $2" : ""}`,
        userId ? [sid, userId] : [sid]
    );
    invalidate(sid);
    return rowCount > 0;
}

/** Revoke every live session a user has. Returns how many. */
export async function revokeAllSessions(userId) {
    const { rowCount } = await pool.query(
        `UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
    );
    invalidateAll();
    return rowCount;
}
