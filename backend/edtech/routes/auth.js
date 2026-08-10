import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../config/database.js";
import authMiddleware from "../middleware/auth.js";

import { JWT_SECRET, JWT_EXPIRES_IN } from "../config/jwt.js";
import {
    normalizePhone,
    normalizeEmail,
    classifyIdentifier,
    validateStudentFields,
    CLASS_LEVELS,
    BOARDS,
    STATES,
} from "../utils/studentProfile.js";
import { sendMail, passwordResetEmail, verifyEmailMessage } from "../utils/mailer.js";

const router = express.Router();

/** The shape of `user` returned to the client, kept identical everywhere. */
const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    class_level: u.class_level,
    board: u.board,
    state: u.state,
    school: u.school,
    // Drives the "confirm your email" banner. `!== false` rather than a bare
    // read: rows selected before this column existed return undefined, and an
    // undefined should not put a warning in front of an existing user.
    email_verified: u.email_verified !== false,
});

// ============================================================
// EMAIL VERIFICATION
// ============================================================

/*
 * TWO_FACTOR_EXEMPT_EMAILS is gone.
 *
 * It listed accounts allowed to skip the emailed code at sign-in. No login
 * now sends one, so the setting exempted nobody from anything — and a config
 * key that reads as a security control while doing nothing is worse than none
 * at all: someone would eventually add an address to it believing that
 * mattered.
 *
 * The variable can be deleted from .env. Leaving it there is harmless; it is
 * simply no longer read.
 */


const VERIFY_TTL_MINUTES = 30;
const VERIFY_MAX_ATTEMPTS = 5;

/*
 * Codes per account per hour.
 *
 * Raised from 5 once every login began needing one. Five was right when a code
 * meant "confirm your address", which happens once — as a sign-in limit it
 * locks out anyone who logs in from a few devices in a morning, or who closes
 * the tab and starts again a couple of times. Fifteen still caps mail volume
 * to a single inbox, which is the abuse this guards against.
 */
const VERIFY_MAX_PER_HOUR = 15;

/**
 * The scope claim carried by a token that may only finish verification.
 *
 * Gating an unverified account in the frontend alone would be decoration: the
 * token issued at login would be a full session token, and anyone willing to
 * open DevTools could call the API with it directly. Instead an unverified
 * login gets a token that the middleware refuses everywhere except the two
 * verification routes, so the gate holds no matter what the client does.
 */
export const VERIFY_SCOPE = "verify-email";

/** Short-lived: it exists to complete one task, not to hold a session open. */
const VERIFY_TOKEN_TTL = "30m";

function verifyScopedToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role, name: user.name, scope: VERIFY_SCOPE },
        JWT_SECRET,
        { expiresIn: VERIFY_TOKEN_TTL }
    );
}

function fullToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role, name: user.name },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

/**
 * Stamp the moment a session actually began.
 *
 * The `last_login` column has existed since the first schema and nothing has
 * ever written to it, so every row reads NULL. Any report built on it would
 * have shown "Never" for every student forever — the sort of empty feature
 * that looks like a bug in the report rather than a gap in the data.
 *
 * Called where the *full* token is issued, not where the password is checked.
 * With two-factor in place those are different moments: a correct password
 * that never completes the emailed code is not a login, and counting it would
 * quietly overstate how engaged a class is.
 *
 * Fire-and-forget. A failed stamp must not fail the login.
 */
function stampLastLogin(userId) {
    pool.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [userId])
        .catch((err) => console.error("[auth] could not record last_login:", err.message));
}

/**
 * Issue a fresh verification code and email it.
 *
 * Any earlier unused code is retired first, so two codes in an inbox can never
 * both work — the newest is always the right one.
 *
 * @param {{id: string, name: string, email: string}} user
 * @param {{purpose?: 'login'|'confirm'}} [options] chooses the email wording.
 *   The mechanism is identical either way; only what the message says differs,
 *   and "confirm your address" reads as a mistake to someone who signed up
 *   months ago and is simply logging in.
 */
async function issueVerificationCode(user) {
    if (!user?.email) return { ok: false, reason: "no-email" };

    const recent = await pool.query(
        `SELECT COUNT(*)::int AS n FROM email_verifications
          WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
        [user.id]
    );
    if (recent.rows[0].n >= VERIFY_MAX_PER_HOUR) {
        return { ok: false, reason: "rate-limited" };
    }

    await pool.query(
        `UPDATE email_verifications SET consumed_at = NOW()
          WHERE user_id = $1 AND consumed_at IS NULL`,
        [user.id]
    );

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = await bcrypt.hash(code, 10);

    await pool.query(
        `INSERT INTO email_verifications (user_id, email, code_hash, expires_at)
         VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)`,
        [user.id, user.email, codeHash, String(VERIFY_TTL_MINUTES)]
    );

    /*
     * One wording, because there is one purpose left.
     *
     * This used to branch on "login" versus "confirm" and send differently
     * worded mail. Nothing requests "login" now, so the branch had identical
     * arms — a ternary that always picks the same value reads as a decision
     * and is not one, which is worse than no branch at all.
     */
    await sendMail({
        to: user.email,
        ...verifyEmailMessage({ name: user.name, code, minutes: VERIFY_TTL_MINUTES }),
    });

    return { ok: true };
}

/**
 * POST /api/auth/send-verification
 *
 * Resend the code to the signed-in user's own address. Authenticated, so
 * unlike the password reset there is no enumeration concern — the caller has
 * already proved who they are.
 */
router.post("/send-verification", authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, name, email, email_verified FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: "User not found" });

        const user = rows[0];
        if (!user.email) {
            return res.status(400).json({ error: "There is no email address on your account." });
        }
        /*
         * Still reachable for an account whose address was never confirmed —
         * older records that predate the signup code. It is no longer part of
         * signing in: login stopped asking for a code, so this is purely
         * "confirm the address on file".
         */
        const result = await issueVerificationCode(user);
        if (!result.ok && result.reason === "rate-limited") {
            return res.status(429).json({
                error: "Too many codes requested. Please wait an hour and try again.",
            });
        }

        res.json({ success: true, message: `A code has been sent to ${user.email}.` });
    } catch (err) {
        console.error("Send verification error:", err);
        res.status(500).json({ error: "Could not send the code. Please try again." });
    }
});

/**
 * POST /api/auth/verify-email
 * Body: { code }
 */
router.post("/verify-email", authMiddleware, async (req, res) => {
    try {
        const digits = String(req.body.code ?? "").trim();
        if (!/^\d{6}$/.test(digits)) {
            return res.status(400).json({ error: "Enter the 6-digit code from your email." });
        }

        const { rows: users } = await pool.query(
            `SELECT id, email, email_verified FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (users.length === 0) return res.status(404).json({ error: "User not found" });

        /*
         * There is deliberately no shortcut for an already-verified account.
         *
         * An earlier version returned a session here without checking anything,
         * on the reasoning that a confirmed address has nothing left to prove.
         * That was fine while this endpoint only confirmed addresses. It is a
         * hole now that it is also the second factor at login: anyone holding a
         * scoped token — which is what a correct password alone earns — could
         * call this and be handed a full session without ever seeing the code.
         *
         * Every path through this route now requires a valid code.
         */

        const { rows } = await pool.query(
            `SELECT id, code_hash, attempts, email
               FROM email_verifications
              WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
              ORDER BY created_at DESC
              LIMIT 1`,
            [req.user.id]
        );
        if (rows.length === 0) {
            return res.status(400).json({ error: "That code has expired. Send a new one." });
        }

        const row = rows[0];

        /*
         * The code was issued for a specific address.
         *
         * If the account's email changed after the code was sent, redeeming it
         * would confirm the new address on the strength of a message delivered
         * to the old one — which is precisely the check verification exists to
         * perform.
         */
        if (row.email !== users[0].email) {
            await pool.query(`UPDATE email_verifications SET consumed_at = NOW() WHERE id = $1`, [row.id]);
            return res.status(400).json({ error: "Your email address changed. Send a new code." });
        }

        if (row.attempts >= VERIFY_MAX_ATTEMPTS) {
            await pool.query(`UPDATE email_verifications SET consumed_at = NOW() WHERE id = $1`, [row.id]);
            return res.status(429).json({ error: "Too many wrong codes. Send a new one." });
        }

        const matches = await bcrypt.compare(digits, row.code_hash);
        if (!matches) {
            await pool.query(`UPDATE email_verifications SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
            const left = VERIFY_MAX_ATTEMPTS - (row.attempts + 1);
            return res.status(400).json({
                error: left > 0
                    ? `That code is not correct. ${left} attempt${left === 1 ? "" : "s"} left.`
                    : "That code is not correct. Send a new one.",
            });
        }

        // Atomic claim, so a double-tapped button cannot consume two codes.
        const claim = await pool.query(
            `UPDATE email_verifications SET consumed_at = NOW()
              WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
            [row.id]
        );
        if (claim.rowCount === 0) {
            return res.status(400).json({ error: "That code has already been used." });
        }

        const { rows: updated } = await pool.query(
            `UPDATE users SET email_verified = TRUE, updated_at = NOW()
              WHERE id = $1
            RETURNING id, name, email, phone, role, class_level, board, state, school, email_verified`,
            [req.user.id]
        );

        /*
         * Trade the verify-scoped token for a real session.
         *
         * This is the only place that upgrade happens. Without it the client
         * would hold a token the middleware refuses everywhere, and a
         * successful verification would look like being logged out.
         */
        // The session starts here, so this is the login worth recording.
        stampLastLogin(req.user.id);

        res.json({
            success: true,
            token: fullToken(updated[0]),
            user: publicUser(updated[0]),
        });
    } catch (err) {
        console.error("Verify email error:", err);
        res.status(500).json({ error: "Could not verify that code. Please try again." });
    }
});

// ============================================================
// SIGNUP EMAIL VERIFICATION (before the account exists)
// ============================================================

/** Scope of the proof handed out once a typed address is confirmed. */
const SIGNUP_PROOF_SCOPE = "signup-email-verified";

/**
 * How long the proof lasts.
 *
 * Long enough to finish the rest of the form without hurrying, short enough
 * that one confirmed address cannot be used to create accounts days later.
 */
const SIGNUP_PROOF_TTL = "30m";

const SIGNUP_CODE_TTL_MINUTES = 15;
const SIGNUP_MAX_ATTEMPTS = 5;
const SIGNUP_MAX_PER_HOUR = 5;

/**
 * POST /api/auth/request-signup-code
 * Body: { email }
 *
 * Public by necessity — the caller has no account yet.
 *
 * Unlike the password-reset endpoint, this one *does* say when an address is
 * already registered. The two look similar but leak differently: reset reveals
 * who has an account to anyone who asks, whereas signup would reveal it anyway
 * the moment the form is submitted, and refusing to say so just makes people
 * type a code that can never be used.
 */
router.post("/request-signup-code", async (req, res) => {
    try {
        const check = normalizeEmail(req.body.email);
        if (!check.ok || !check.email) {
            return res.status(400).json({ error: "Enter a valid email address." });
        }
        const email = check.email;

        const taken = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
        if (taken.rows.length > 0) {
            return res.status(409).json({
                error: "That email address is already registered. Try signing in instead.",
            });
        }

        /*
         * Per address, not per IP.
         *
         * The cost here is mail landing in a stranger's inbox: anyone can type
         * any address into a signup form, so the limit has to protect the
         * person receiving the messages rather than the person sending them.
         */
        const recent = await pool.query(
            `SELECT COUNT(*)::int AS n FROM signup_email_verifications
              WHERE email = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
            [email]
        );
        if (recent.rows[0].n >= SIGNUP_MAX_PER_HOUR) {
            return res.status(429).json({
                error: "Too many codes requested for that address. Please wait an hour.",
            });
        }

        await pool.query(
            `UPDATE signup_email_verifications SET consumed_at = NOW()
              WHERE email = $1 AND consumed_at IS NULL`,
            [email]
        );

        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
        const codeHash = await bcrypt.hash(code, 10);

        await pool.query(
            `INSERT INTO signup_email_verifications (email, code_hash, expires_at)
             VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
            [email, codeHash, String(SIGNUP_CODE_TTL_MINUTES)]
        );

        const mail = verifyEmailMessage({ name: null, code, minutes: SIGNUP_CODE_TTL_MINUTES });
        const sent = await sendMail({ to: email, ...mail });

        if (!sent.ok) {
            // Said plainly. The person is mid-signup and can do nothing about a
            // mail server problem; pretending it worked strands them on a code
            // screen waiting for something that will never arrive.
            return res.status(502).json({
                error: "We could not send the code right now. Please try again in a moment.",
            });
        }

        res.json({ success: true, message: `We've sent a code to ${email}.` });
    } catch (err) {
        console.error("Request signup code error:", err);
        res.status(500).json({ error: "Could not send the code. Please try again." });
    }
});

/**
 * POST /api/auth/verify-signup-code
 * Body: { email, code }
 *
 * Returns a signed proof that this address was confirmed. The proof is what
 * registration accepts — nothing is stored against the address, so there is no
 * half-created account to clean up if the person abandons the form.
 */
router.post("/verify-signup-code", async (req, res) => {
    try {
        const check = normalizeEmail(req.body.email);
        const digits = String(req.body.code ?? "").trim();

        if (!check.ok || !check.email || !/^\d{6}$/.test(digits)) {
            return res.status(400).json({ error: "Enter the 6-digit code from your email." });
        }
        const email = check.email;

        const { rows } = await pool.query(
            `SELECT id, code_hash, attempts FROM signup_email_verifications
              WHERE email = $1 AND consumed_at IS NULL AND expires_at > NOW()
              ORDER BY created_at DESC LIMIT 1`,
            [email]
        );
        if (rows.length === 0) {
            return res.status(400).json({ error: "That code has expired. Send a new one." });
        }

        const row = rows[0];

        if (row.attempts >= SIGNUP_MAX_ATTEMPTS) {
            await pool.query(
                `UPDATE signup_email_verifications SET consumed_at = NOW() WHERE id = $1`,
                [row.id]
            );
            return res.status(429).json({ error: "Too many wrong codes. Send a new one." });
        }

        const matches = await bcrypt.compare(digits, row.code_hash);
        if (!matches) {
            await pool.query(
                `UPDATE signup_email_verifications SET attempts = attempts + 1 WHERE id = $1`,
                [row.id]
            );
            const left = SIGNUP_MAX_ATTEMPTS - (row.attempts + 1);
            return res.status(400).json({
                error: left > 0
                    ? `That code is not correct. ${left} attempt${left === 1 ? "" : "s"} left.`
                    : "That code is not correct. Send a new one.",
            });
        }

        await pool.query(
            `UPDATE signup_email_verifications SET consumed_at = NOW() WHERE id = $1`,
            [row.id]
        );

        /*
         * The email is baked into the proof.
         *
         * Registration compares it against the address being registered, so a
         * proof earned for one address cannot be used to create an account on
         * another — which would let someone confirm an address they own and
         * then sign up as anyone.
         */
        const proof = jwt.sign(
            { email, scope: SIGNUP_PROOF_SCOPE },
            JWT_SECRET,
            { expiresIn: SIGNUP_PROOF_TTL }
        );

        res.json({ success: true, emailVerifiedToken: proof });
    } catch (err) {
        console.error("Verify signup code error:", err);
        res.status(500).json({ error: "Could not check that code. Please try again." });
    }
});

/**
 * Check the proof presented at registration.
 *
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function checkSignupProof(token, email) {
    if (!token) {
        return { ok: false, error: "Please confirm your email address before creating an account." };
    }
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch {
        return { ok: false, error: "Your email confirmation expired. Please request a new code." };
    }
    if (decoded.scope !== SIGNUP_PROOF_SCOPE) {
        return { ok: false, error: "Please confirm your email address before creating an account." };
    }
    if (String(decoded.email).toLowerCase() !== String(email).toLowerCase()) {
        return { ok: false, error: "That confirmation was for a different email address." };
    }
    return { ok: true };
}

// ROUTE 1: REGISTER
// POST /api/auth/register
// Body: { name, phone, password, email?, role?, class_level?, board?, state?, school? }
router.post("/register", async (req, res) => {
    try {
        const { name, password, role = "student" } = req.body;

        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: "Please enter your full name." });
        }
        if (!password) {
            return res.status(400).json({ error: "Please choose a password." });
        }
        if (!["student", "educator"].includes(role)) {
            return res.status(400).json({ error: "role must be student or educator" });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: "Password must be at least 6 characters" });
        }

        // Mobile is now the primary identifier, so it is required for everyone
        // and validated before anything else touches the database.
        const phoneCheck = normalizePhone(req.body.phone);
        if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });

        /*
         * Email is required now, where it was optional.
         *
         * It is the only channel that can reset a forgotten password: an
         * account with a mobile number alone has no way back in, and the
         * support burden of resetting those by hand falls on the teacher.
         * Mobile remains the primary login identifier; email is the recovery
         * address.
         */
        const emailCheck = normalizeEmail(req.body.email);
        if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });
        if (!emailCheck.email) {
            return res.status(400).json({
                error: "An email address is required — it is how you reset a forgotten password.",
            });
        }

        /*
         * The address must already have been confirmed.
         *
         * Verification moved into the form itself, so by the time this runs the
         * person has entered a code sent to that address. Enforced here and not
         * only in the UI: without this check the whole step is a suggestion,
         * and anyone posting straight to the API skips it.
         */
        const proof = checkSignupProof(req.body.emailVerifiedToken, emailCheck.email);
        if (!proof.ok) return res.status(400).json({ error: proof.error });

        /*
         * Academic fields are required for students and ignored for educators.
         * A teacher has no class, and demanding one would block their signup on
         * a field that means nothing to them.
         */
        const isStudent = role === "student";
        const fields = validateStudentFields(req.body, { strict: isStudent });
        if (!fields.ok) return res.status(400).json({ error: fields.error });
        const extra = isStudent ? fields.values : {};

        const clash = await pool.query(
            `SELECT phone, email FROM users
              WHERE phone = $1 OR ($2::text IS NOT NULL AND email = $2)`,
            [phoneCheck.phone, emailCheck.email]
        );
        if (clash.rows.length > 0) {
            // Named specifically: "already registered" without saying which
            // field sends people round in circles retyping the wrong one.
            const phoneTaken = clash.rows.some((r) => r.phone === phoneCheck.phone);
            return res.status(409).json({
                error: phoneTaken
                    ? "That mobile number is already registered."
                    : "That email address is already registered.",
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        // TRUE: the address was confirmed by code before this row existed.
        const result = await pool.query(`
            INSERT INTO users (name, email, phone, password_hash, role, class_level, board, state, school, email_verified)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
            RETURNING id, name, email, phone, role, class_level, board, state, school, email_verified, created_at
        `, [
            String(name).trim(),
            emailCheck.email,
            phoneCheck.phone,
            passwordHash,
            role,
            extra.class_level ?? null,
            extra.board ?? null,
            extra.state ?? null,
            extra.school ?? null,
        ]);

        const user = result.rows[0];

        /*
         * Send the code, but do not make the signup depend on it.
         *
         * The account exists and the token below is already valid, so a mail
         * server having a bad minute must not turn a completed registration
         * into an error. The user lands in the app and can resend from there.
         */
        /*
         * A full session, and no second code.
         *
         * They confirmed the address a moment ago to get this far. Sending
         * another code immediately would be asking them to prove the same
         * thing twice within the same minute, which reads as the app having
         * lost track of what just happened.
         *
         * The two-factor requirement still applies to every *later* sign-in.
         */
        // Registering signs them in, so it counts as their first login.
        stampLastLogin(user.id);

        res.status(201).json({
            success: true,
            message: "Account created successfully",
            token: fullToken(user),
            user: publicUser(user),
        });

    } catch (err) {
        console.error("Register error:", err);
        if (err.code === "23505") {
            return res.status(409).json({ error: "That mobile number or email is already registered." });
        }
        res.status(500).json({ error: err.message });
    }
});

// ROUTE 2: LOGIN
// POST /api/auth/login
// Body: { identifier, password }  — identifier is a mobile number or an email
router.post("/login", async (req, res) => {
    try {
        const { password } = req.body;

        /*
         * `email` is still accepted as the field name.
         *
         * That is what every existing client sends, including any browser tab
         * left open across the deploy. Reading either key means the rename can
         * happen in the UI without a flag day.
         */
        const raw = req.body.identifier ?? req.body.email ?? req.body.phone;

        if (!raw || !password) {
            return res.status(400).json({ error: "Enter your mobile number or email, and your password." });
        }

        const id = classifyIdentifier(raw);
        if (id.kind === "empty" || id.kind === "unknown") {
            // Same wording as a wrong password below: telling an attacker that
            // an identifier is merely malformed is harmless, but keeping one
            // message avoids leaking which accounts exist.
            return res.status(401).json({ error: "Invalid login or password" });
        }

        const result = await pool.query(
            id.kind === "email"
                ? `SELECT * FROM users WHERE email = $1`
                : `SELECT * FROM users WHERE phone = $1`,
            [id.value]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Invalid login or password" });
        }

        const user = result.rows[0];

        /*
         * A closed account cannot sign in.
         *
         * In practice the scrubbed row is already unreachable — its address is
         * a @deleted.invalid one nobody can receive at, and its password hash
         * is random. But relying on that makes "the account is gone" an
         * accident of unguessability rather than a rule. Stated here, it also
         * holds if a backup restores an old hash.
         *
         * Same wording as a wrong password: whether an address once existed
         * and was closed is not something a stranger needs confirmed.
         */
        if (user.deleted_at) {
            return res.status(401).json({ error: "Invalid login or password" });
        }

        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({ error: "Invalid login or password" });
        }

        /*
         * A correct password is the whole check.
         *
         * Login used to issue only a verify-scoped token and email a code,
         * making every sign-in two steps. That is real security, and removing
         * it is a deliberate trade: sign-in is now one factor, so anyone with
         * the password is in.
         *
         * What is NOT affected, and should not be confused with this:
         *   - signup still proves the email address with a code before the
         *     account exists, so addresses on file are still real;
         *   - password reset still requires a code, so email remains the way
         *     back into a locked-out account.
         *
         * Those are the two places a code actually protects something the
         * password does not. The login challenge protected against a stolen
         * password, which is a genuine loss — worth remembering if sign-ins
         * from unexpected places ever start showing up.
         */
        stampLastLogin(user.id);

        res.json({
            success: true,
            message: "Login successful",
            token: fullToken(user),
            user: publicUser(user),
        });

    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ROUTE 3: GET CURRENT USER
// GET /api/auth/me
router.get("/me", authMiddleware, async (req, res) => {
    try {
        /*
         * deleted_at is selected so a session that outlived the account is
         * caught here.
         *
         * The JWT stays cryptographically valid until it expires — closing an
         * account cannot reach a token already issued. This route is what the
         * app calls on load, so it is the practical place to end that session;
         * without it, a tab left open on another device would keep working for
         * up to a week.
         */
        const result = await pool.query(
            `SELECT id, name, email, phone, role, class_level, board, state, school,
                    email_verified, deleted_at, created_at
               FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        /*
         * 401, not 404: the client treats 401 as "your session is over" and
         * clears the token, which is exactly what should happen to a tab still
         * open on a closed account. A 404 would leave it holding a token and
         * showing an error it cannot act on.
         */
        if (result.rows[0].deleted_at) {
            return res.status(401).json({ error: "This account has been closed." });
        }

        // The allowed values travel with the profile so the form's dropdowns
        // are populated from the same list the server validates against.
        res.json({
            success: true,
            user: result.rows[0],
            options: { classLevels: CLASS_LEVELS, boards: BOARDS, states: STATES },
        });
    } catch (err) {
        console.error("Me error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// PROFILE
// ============================================================

/*
 * The local EMAIL_RE / PHONE_RE that lived here are gone.
 *
 * Both are now in utils/studentProfile.js, alongside the normalisation that
 * has to agree with them. The phone rule in particular is no longer just a
 * format check: it rewrites +91 and leading-zero forms to a bare 10-digit
 * number, and if validation and normalisation lived apart, a number could pass
 * one and be stored in a shape the login lookup never matches.
 */

/**
 * PUT /api/auth/profile
 * Body: { name?, phone? }
 *
 * Email is read-only after sign-up — it is the login identifier, and letting
 * it change is an account-takeover path. Sending a different one returns 403;
 * sending the current one is accepted as a no-op so clients that echo the
 * whole profile back still work.
 *
 * A rename reissues the token, since the JWT carries the name in its payload
 * and would otherwise hold a stale value until it expired.
 */
router.put("/profile", authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { name, phone, email, currentPassword } = req.body;

        const existing = await pool.query(
            `SELECT id, name, email, phone, role, class_level, board, state, school, password_hash
               FROM users WHERE id = $1`,
            [userId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }
        const user = existing.rows[0];

        // --- validate ------------------------------------------------------
        const nextName = name === undefined ? user.name : String(name).trim();
        if (!nextName) {
            return res.status(400).json({ error: "Name cannot be empty." });
        }

        /*
         * Phone can be corrected, but not cleared.
         *
         * It is a login identifier now: an account with no phone and no email
         * cannot be signed in to at all, so an empty value here would lock the
         * user out of their own account with no way back.
         */
        let nextPhone = user.phone;
        if (phone !== undefined) {
            const check = normalizePhone(phone);
            if (!check.ok) return res.status(400).json({ error: check.error });
            nextPhone = check.phone;

            if (nextPhone !== user.phone) {
                const taken = await pool.query(
                    `SELECT id FROM users WHERE phone = $1 AND id <> $2`,
                    [nextPhone, userId]
                );
                if (taken.rows.length > 0) {
                    return res.status(409).json({ error: "That mobile number is already registered." });
                }
            }
        }

        /*
         * Class is locked after signup; board, state and school are not.
         *
         * Class decides which material a student is shown, so letting them
         * change it is a way to reach content they did not pay for. The other
         * three are descriptive — a student who changes school should be able
         * to say so without contacting anyone.
         */
        if (req.body.class_level !== undefined || req.body.classLevel !== undefined) {
            const sent = String(req.body.class_level ?? req.body.classLevel ?? "");
            if (sent !== String(user.class_level ?? "")) {
                return res.status(403).json({
                    error: "Your class cannot be changed. Contact support if you need it updated.",
                });
            }
        }

        const fields = validateStudentFields(req.body, { strict: false });
        if (!fields.ok) return res.status(400).json({ error: fields.error });

        const nextBoard = fields.values.board ?? user.board;
        const nextState = fields.values.state ?? user.state;
        // school is the one field where an explicit empty string means "clear
        // it", because leaving a stale school on the profile is worse than a
        // blank one.
        const nextSchool = "school" in fields.values ? fields.values.school : user.school;

        /*
         * Email is immutable after sign-up.
         *
         * It is the login identifier, so allowing it to change here is an
         * account-takeover path: anyone reaching an unattended logged-in
         * browser could repoint the account at their own address. Requiring
         * the current password narrowed that, but the product decision is
         * that it simply cannot change.
         *
         * Enforced here rather than only by disabling the input, because the
         * input is a UI affordance — a client can still PUT any body it likes.
         * A mismatched email is rejected loudly rather than ignored silently,
         * so a stale client cannot believe it succeeded.
         */
        if (email !== undefined) {
            const trimmed = String(email).trim().toLowerCase();
            // `user.email` can now be null — email is optional at signup — so
            // this must not call .toLowerCase() on it unguarded.
            const current = (user.email ?? "").toLowerCase();

            /*
             * One exception to immutability: adding an address where there was
             * none. An account created with only a mobile number has nothing to
             * take over, so setting the first email is not the risk the rule
             * exists to prevent — and refusing it would make the optional field
             * permanently unfillable.
             */
            if (current === "" && trimmed !== "") {
                const emailCheck = normalizeEmail(trimmed);
                if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });

                const taken = await pool.query(
                    `SELECT id FROM users WHERE email = $1 AND id <> $2`,
                    [emailCheck.email, userId]
                );
                if (taken.rows.length > 0) {
                    return res.status(409).json({ error: "That email address is already registered." });
                }
                user.pendingEmail = emailCheck.email;
            } else if (trimmed !== current) {
                return res.status(403).json({
                    error: "Your email address cannot be changed. Contact support if you need it updated.",
                });
            }
        }

        // --- persist -------------------------------------------------------
        // An existing email is never overwritten: COALESCE keeps the stored
        // value whenever pendingEmail is absent.
        const updated = await pool.query(`
            UPDATE users
            SET name = $1,
                phone = $2,
                email = COALESCE($4, email),
                board = $5,
                state = $6,
                school = $7,
                updated_at = NOW()
            WHERE id = $3
            RETURNING id, name, email, phone, role, class_level, board, state, school, created_at
        `, [nextName, nextPhone, userId, user.pendingEmail ?? null, nextBoard, nextState, nextSchool]);

        const profile = updated.rows[0];

        // The name is carried in the token payload, so a rename needs a fresh
        // one. Email can no longer move, so it can never go stale here.
        const nameChanged = nextName !== user.name;
        const response = { success: true, user: profile };

        if (nameChanged) {
            response.token = jwt.sign(
                { id: profile.id, email: profile.email, role: profile.role, name: profile.name },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRES_IN }
            );
        }

        res.json(response);

    } catch (err) {
        // Race against the uniqueness check above.
        if (err.code === '23505') {
            return res.status(409).json({ error: "That email is already in use." });
        }
        console.error("Profile update error:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/auth/password
 * Body: { currentPassword, newPassword }
 */
router.put("/password", authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: "Both your current and new password are required." });
        }
        if (String(newPassword).length < 8) {
            return res.status(400).json({ error: "New password must be at least 8 characters." });
        }

        const result = await pool.query(
            `SELECT password_hash FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const ok = await bcrypt.compare(String(currentPassword), result.rows[0].password_hash);
        if (!ok) {
            return res.status(401).json({ error: "Your current password is incorrect." });
        }

        const hash = await bcrypt.hash(String(newPassword), 10);
        await pool.query(
            `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
            [hash, req.user.id]
        );

        res.json({ success: true, message: "Password updated." });

    } catch (err) {
        console.error("Password change error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// PASSWORD RESET BY EMAIL OTP
// ============================================================

/** How long a code stays valid. Short enough to matter, long enough to find. */
const OTP_TTL_MINUTES = 15;
/** Wrong guesses allowed before the code is burned. */
const OTP_MAX_ATTEMPTS = 5;
/** Codes a single account may request per hour. */
const OTP_MAX_PER_HOUR = 5;

/**
 * A six-digit code from a cryptographic source.
 *
 * Math.random() is seeded predictably enough that a determined attacker who
 * knows roughly when a code was issued can narrow the search dramatically.
 * randomInt costs nothing here and removes the question.
 */
function generateOtp() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/*
 * Every response below is the same whether or not the account exists.
 *
 * A reset form that says "no account with that email" is an account
 * enumeration oracle: anyone can test an address list against it and learn who
 * is registered. The one exception is deliberate and product-driven, and is
 * explained where it appears.
 */
const NEUTRAL = "If an account with that email exists, a reset code is on its way.";

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 */
router.post("/forgot-password", async (req, res) => {
    try {
        const check = normalizeEmail(req.body.email);
        if (!check.ok || !check.email) {
            return res.status(400).json({ error: "Enter the email address on your account." });
        }

        const found = await pool.query(
            `SELECT id, name, email FROM users WHERE email = $1`,
            [check.email]
        );

        // Nothing to send to — but the caller is told the same thing either way.
        if (found.rows.length === 0) {
            return res.json({ success: true, message: NEUTRAL });
        }

        const user = found.rows[0];

        /*
         * Cap requests per account, not per IP.
         *
         * The cost being controlled is mail sent to a real person: someone who
         * hammers this endpoint against one address is spamming that person's
         * inbox, and rotating IPs would defeat an IP-based limit while doing
         * nothing to change who receives the mail.
         */
        const recent = await pool.query(
            `SELECT COUNT(*)::int AS n FROM password_resets
              WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
            [user.id]
        );
        if (recent.rows[0].n >= OTP_MAX_PER_HOUR) {
            return res.status(429).json({
                error: "Too many reset requests. Please wait an hour and try again.",
            });
        }

        // Any earlier code is dead the moment a new one is issued, so two
        // codes in an inbox can never both work.
        await pool.query(
            `UPDATE password_resets SET consumed_at = NOW()
              WHERE user_id = $1 AND consumed_at IS NULL`,
            [user.id]
        );

        const code = generateOtp();
        const codeHash = await bcrypt.hash(code, 10);

        await pool.query(
            `INSERT INTO password_resets (user_id, code_hash, expires_at)
             VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
            [user.id, codeHash, String(OTP_TTL_MINUTES)]
        );

        const mail = passwordResetEmail({ name: user.name, code, minutes: OTP_TTL_MINUTES });
        await sendMail({ to: user.email, ...mail });

        res.json({ success: true, message: NEUTRAL });

    } catch (err) {
        console.error("Forgot password error:", err);
        res.status(500).json({ error: "Could not start the reset. Please try again." });
    }
});

/**
 * POST /api/auth/verify-reset-code
 * Body: { email, code }
 *
 * Separate from the reset itself so the UI can tell someone their code is
 * wrong before making them invent a password. Verifying does not consume the
 * code — the reset step re-checks it.
 */
router.post("/verify-reset-code", async (req, res) => {
    try {
        const result = await consumeResetCode(req.body, { consume: false });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        res.json({ success: true, message: "Code accepted." });
    } catch (err) {
        console.error("Verify reset code error:", err);
        res.status(500).json({ error: "Could not check that code. Please try again." });
    }
});

/**
 * POST /api/auth/reset-password
 * Body: { email, code, newPassword }
 */
router.post("/reset-password", async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || String(newPassword).length < 8) {
            return res.status(400).json({ error: "New password must be at least 8 characters." });
        }

        const result = await consumeResetCode(req.body, { consume: true });
        if (!result.ok) return res.status(result.status).json({ error: result.error });

        const hash = await bcrypt.hash(String(newPassword), 10);
        await pool.query(
            `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
            [hash, result.userId]
        );

        res.json({ success: true, message: "Your password has been changed. You can sign in now." });

    } catch (err) {
        console.error("Reset password error:", err);
        res.status(500).json({ error: "Could not reset your password. Please try again." });
    }
});

/**
 * Shared check behind both verify and reset.
 *
 * One function so the two endpoints cannot drift: a verify that is stricter
 * than the reset would reject a working code, and a verify that is laxer would
 * wave someone through to a step that then fails for reasons they cannot see.
 *
 * @returns {{ok: true, userId: string} | {ok: false, status: number, error: string}}
 */
async function consumeResetCode({ email, code }, { consume }) {
    const emailCheck = normalizeEmail(email);
    const digits = String(code ?? "").trim();

    if (!emailCheck.ok || !emailCheck.email || !/^\d{6}$/.test(digits)) {
        return { ok: false, status: 400, error: "Enter the 6-digit code from your email." };
    }

    const found = await pool.query(`SELECT id FROM users WHERE email = $1`, [emailCheck.email]);
    if (found.rows.length === 0) {
        return { ok: false, status: 400, error: "That code is not valid. Request a new one." };
    }
    const userId = found.rows[0].id;

    const reset = await pool.query(
        `SELECT id, code_hash, attempts, expires_at
           FROM password_resets
          WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1`,
        [userId]
    );
    if (reset.rows.length === 0) {
        return { ok: false, status: 400, error: "That code has expired. Request a new one." };
    }

    const row = reset.rows[0];

    if (row.attempts >= OTP_MAX_ATTEMPTS) {
        // Burn it rather than leaving a locked row around that still counts as
        // "the newest live code" and blocks a fresh request from working.
        await pool.query(`UPDATE password_resets SET consumed_at = NOW() WHERE id = $1`, [row.id]);
        return { ok: false, status: 429, error: "Too many wrong codes. Request a new one." };
    }

    const matches = await bcrypt.compare(digits, row.code_hash);
    if (!matches) {
        // Counted on the row, not in memory: a process restart must not hand
        // an attacker a fresh five guesses.
        await pool.query(`UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
        const left = OTP_MAX_ATTEMPTS - (row.attempts + 1);
        return {
            ok: false,
            status: 400,
            error: left > 0
                ? `That code is not correct. ${left} attempt${left === 1 ? "" : "s"} left.`
                : "That code is not correct. Request a new one.",
        };
    }

    if (consume) {
        /*
         * Consume conditionally, and check that it worked.
         *
         * `consumed_at IS NULL` in the WHERE makes this an atomic claim: two
         * requests arriving with the same valid code — a double-tapped button
         * is enough — cannot both succeed, because only one UPDATE matches.
         */
        const claim = await pool.query(
            `UPDATE password_resets SET consumed_at = NOW()
              WHERE id = $1 AND consumed_at IS NULL
            RETURNING id`,
            [row.id]
        );
        if (claim.rowCount === 0) {
            return { ok: false, status: 400, error: "That code has already been used. Request a new one." };
        }
    }

    return { ok: true, userId };
}

// ROUTE 5: CLOSE YOUR OWN ACCOUNT
// DELETE /api/auth/account
/*
 * Anonymise, do not DELETE the row.
 *
 * Nine tables cascade from users(id) — courses, enrolments, payments, quiz
 * attempts, support threads. A real DELETE would take all of them, including
 * the payment records the business is required to keep and every student's
 * progress in a teacher's courses. Scrubbing the identifying columns gives the
 * person what they are actually asking for (their name, email and phone number
 * stop existing here) while leaving the rows that are not about them intact.
 *
 * This is also why teachers can now close their own accounts. The cascade only
 * fires on DELETE; an UPDATE never triggers it, so a teacher's courses and the
 * work their students did inside them survive untouched. The row stays, holding
 * the foreign keys together, with nothing identifying left on it.
 */
router.delete("/account", authMiddleware, async (req, res) => {
    try {
        const { password, confirm } = req.body || {};
        const isEducator = req.user.role !== "student";

        /*
         * Typing DELETE is not security — anyone who can reach this route can
         * type six letters. It is there to make the action deliberate. The
         * password is the actual check: it proves the person at the keyboard is
         * the account holder and not someone who found an unlocked phone.
         */
        if (confirm !== "DELETE") {
            return res.status(400).json({ error: 'Type DELETE to confirm.' });
        }
        if (!password) {
            return res.status(400).json({ error: "Enter your password to confirm." });
        }

        const found = await pool.query(
            `SELECT id, password_hash, deleted_at FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (found.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }
        const user = found.rows[0];

        // Already closed — report success rather than an error. The outcome the
        // caller wants is the current state, and a second tap on a slow
        // connection should not produce a scary failure.
        if (user.deleted_at) {
            return res.json({ success: true, message: "This account is already closed." });
        }

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
            /*
             * 403, not 401. The session is perfectly valid; it is the
             * confirmation that failed. A 401 would trip the client's
             * session-expired handler and sign the person out for a typo — on
             * the one screen where being unexpectedly logged out reads as "did
             * it work?".
             */
            return res.status(403).json({ error: "That password is not correct." });
        }

        /*
         * A random hash, not NULL.
         *
         * password_hash is NOT NULL, but more importantly bcrypt.compare
         * against a null or empty hash has surprising behaviour across
         * versions. A hash of random bytes is a password nobody knows and
         * every comparison rejects.
         */
        const deadHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);

        /*
         * A teacher's courses are unpublished, not deleted or hidden.
         *
         * Deleting them would destroy work students paid for. Leaving them
         * published would keep selling a course with nobody behind it to
         * answer a question or fix a broken video. Unpublishing splits the
         * difference: it disappears from the catalogue, while everyone already
         * enrolled keeps full access — GET /courses/:id admits enrolled
         * students to unpublished courses precisely so this is true.
         *
         * Reversible on purpose. An administrator can hand the courses to
         * another teacher and publish them again; nothing here is destroyed.
         */
        if (isEducator) {
            await pool.query(
                `UPDATE courses SET status = 'draft'
                  WHERE educator_id = $1 AND status = 'published'`,
                [req.user.id]
            );
        }

        await pool.query(
            `UPDATE users
                SET name = $3,
                    -- Unique (the column is), unroutable (.invalid is reserved
                    -- by RFC 2606 and can never resolve), and clearly not a
                    -- typo when someone reads it in the database later.
                    email = 'deleted+' || id::text || '@deleted.invalid',
                    phone = NULL,
                    password_hash = $2,
                    board = NULL,
                    state = NULL,
                    school = NULL,
                    class_level = NULL,
                    pref_theme = NULL,
                    pref_mode = NULL,
                    pref_density = NULL,
                    pref_style = NULL,
                    email_verified = FALSE,
                    deleted_at = NOW()
              WHERE id = $1 AND deleted_at IS NULL`,
            /*
             * A teacher's name is not private data here — it is a byline. It
             * is joined onto every course listing, so whatever goes in this
             * column is what students read next to a course they are studying.
             * "Deleted user" reads as a bug and quietly announces that someone
             * closed their account; "Former teacher" is a state, not an error.
             */
            [req.user.id, deadHash, isEducator ? 'Former teacher' : 'Deleted user']
        );

        /*
         * Pending codes are deleted, not kept.
         *
         * A live reset code is a way back into the account. Leaving one behind
         * would mean a closed account could be reopened from an old email —
         * the exact thing "you will not be able to sign in again" promises
         * cannot happen.
         */
        await pool.query(`DELETE FROM password_resets WHERE user_id = $1`, [req.user.id]);
        await pool.query(`DELETE FROM email_verifications WHERE user_id = $1`, [req.user.id]);

        res.json({ success: true, message: "Your account has been closed." });
    } catch (err) {
        console.error("Account deletion error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ROUTE 4: LOGOUT
// POST /api/auth/logout
router.post("/logout", authMiddleware, (req, res) => {
    res.json({ success: true, message: "Logged out successfully" });
});

export default router;