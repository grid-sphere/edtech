import "dotenv/config";
import jwt from "jsonwebtoken";

/**
 * One JWT secret for the whole app.
 *
 * This module exists because the secret was previously declared separately in
 * three files, and they drifted:
 *
 *   routes/auth.js       "your-secret-key-change-in-production"   <- signs
 *   middleware/auth.js   "your-secret-key-change-in-production"
 *   routes/courses.js    "your-secret-key"                        <- verifies
 *
 * With JWT_SECRET unset, GET /courses/:id could not verify the very token that
 * login had just issued. Its jwt.verify threw, an empty `catch {}` swallowed
 * the error, and isCreator/isEnrolled silently became false — so educators lost
 * every edit and delete control on their own courses, with nothing logged.
 *
 * A hardcoded fallback is what allowed that to go unnoticed, so in production
 * we refuse to start instead.
 */
const FALLBACK = "your-secret-key-change-in-production";

if (!process.env.JWT_SECRET) {
    if (process.env.NODE_ENV === "production") {
        throw new Error(
            "JWT_SECRET is not set. Refusing to start in production with a public default secret."
        );
    }
    console.warn(
        "⚠️  JWT_SECRET is not set — using the development fallback.\n" +
        "   Set it in backend/edtech/.env before deploying."
    );
}

export const JWT_SECRET = process.env.JWT_SECRET || FALLBACK;

/*
 * How long a session lasts.
 *
 * It was seven days, which is why an admin who uses the panel a couple of times
 * a week kept arriving at the sign-in screen: the token was counting down from
 * the moment it was issued and nothing they did reset it. A week is a sensible
 * default for a consumer app where a stolen token is a real risk; it is the
 * wrong shape for a staff tool that somebody keeps open on one machine.
 *
 * A year, plus the sliding renewal below, so that in practice the only thing
 * that ends a session is signing out.
 */
const DEFAULT_EXPIRES_IN = "365d";

/*
 * `never` means exactly that: a token with no `exp` claim, valid until the
 * secret changes.
 *
 * Offered because "indefinitely" is what was asked for and a year is only an
 * approximation of it — but not the default, because a token that never expires
 * cannot be revoked by waiting, and this app has no revocation list. With a long
 * expiry, rotating JWT_SECRET is still the emergency exit and a forgotten laptop
 * eventually locks itself.
 *
 * An empty string is not "never" — docker-compose passes `JWT_EXPIRES_IN=${JWT_EXPIRES_IN}`
 * whether or not the host has the variable, so unset arrives here as "". That
 * has to mean "use the default", or an unrelated deploy quietly makes every
 * token immortal.
 */
const raw = (process.env.JWT_EXPIRES_IN || "").trim().toLowerCase();
const NEVER = ["never", "none", "0", "infinite", "indefinite"];

/** A `jsonwebtoken` duration string, or null for "no expiry at all". */
export const JWT_EXPIRES_IN = NEVER.includes(raw) ? null : raw || DEFAULT_EXPIRES_IN;

/** The claims a session token carries. Kept in one place so renewal can rebuild one. */
const sessionClaims = (user) => ({
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
});

/**
 * Sign a full session token.
 *
 * Every caller went through `jwt.sign(..., { expiresIn: JWT_EXPIRES_IN })`, which
 * cannot express "no expiry" — `expiresIn: null` is a type error, not an opt-out.
 * Routing them all through here is what makes the `never` setting possible.
 */
export function signSession(user) {
    return jwt.sign(
        sessionClaims(user),
        JWT_SECRET,
        JWT_EXPIRES_IN ? { expiresIn: JWT_EXPIRES_IN } : {}
    );
}

/**
 * A replacement token for a session that is past halfway through its life, or
 * null if the current one is still fresh enough to leave alone.
 *
 * This is what makes the session *sliding* rather than merely long. A fixed
 * expiry logs out the people who use the app most, because using it does not
 * extend it — the only thing that matters is how long ago they typed their
 * password. Reissuing on use means an account in regular use never reaches its
 * own expiry, and one that is abandoned still does.
 *
 * Halfway, rather than "always", so a busy screen making ten calls does not mint
 * ten tokens; and rather than "nearly expired", so there is a wide window in
 * which any single visit renews. It reads `iat`/`exp` off the token instead of
 * the configured lifetime, so a token issued under the old seven-day setting
 * renews on its own terms and upgrades to the new one.
 *
 * @param {object} decoded a verified payload
 * @returns {string|null}
 */
export function renewedSession(decoded) {
    // A verify-email token is a one-task credential, not a session. Extending it
    // would quietly hand an unconfirmed account a permanent foothold.
    if (!decoded || decoded.scope) return null;
    // No exp: already immortal, nothing to slide.
    if (!decoded.exp || !decoded.iat) return null;

    const life = decoded.exp - decoded.iat;
    if (life <= 0) return null;

    const elapsed = Math.floor(Date.now() / 1000) - decoded.iat;
    if (elapsed < life / 2) return null;

    return signSession(decoded);
}

/** Response header carrying a renewed token. Clients swap it in silently. */
export const RENEWED_TOKEN_HEADER = "X-Renewed-Token";

export default JWT_SECRET;
