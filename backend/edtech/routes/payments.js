import express from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import {
    PAYU_MERCHANT_KEY,
    PAYU_ENDPOINT,
    PAYU_MODE,
    PUBLIC_BASE_URL,
    payuConfigured,
    requestHash,
    responseHash,
    hashesMatch,
    formatAmount,
    newTxnId,
    sanitiseText,
} from "../utils/payu.js";
import pool from "../config/database.js";
import { expiryFrom, activeEnrolmentSql } from "../utils/enrollmentAccess.js";
import { notifyCourseOwner } from "../utils/notify.js";
import authMiddleware from "../middleware/auth.js";

const router = express.Router();

/*
 * Keys come from the environment, with no hardcoded fallback.
 *
 * Both used to be literals in this file, so every clone and every push carried
 * a working key_secret — the value Razorpay uses to sign and verify payments.
 *
 * Missing keys disable paid enrolment rather than stopping the server. The
 * alternative, throwing at import, would take the whole platform down over a
 * misconfigured payment provider: nobody could watch a video or sit a quiz
 * because a variable was missing. Free courses do not touch this file at all.
 */
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const razorpayConfigured = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);

/**
 * Which gateway takes the money.
 *
 * Inferred from whichever credentials are present, so filling in one pair of
 * variables is the whole configuration. PAYMENT_PROVIDER overrides it for the
 * case where both are set — otherwise "I pasted my PayU keys in and it still
 * used Razorpay" would be a genuinely baffling afternoon.
 */
export const PAYMENT_PROVIDER = (() => {
    const forced = (process.env.PAYMENT_PROVIDER || "").trim().toLowerCase();
    if (forced === "payu" || forced === "razorpay") return forced;
    if (payuConfigured) return "payu";
    if (razorpayConfigured) return "razorpay";
    return "none";
})();

export const paymentsConfigured = PAYMENT_PROVIDER !== "none";

if (!paymentsConfigured) {
    console.warn(
        "⚠️  No payment provider is configured.\n" +
        "   Set PAYU_MERCHANT_KEY + PAYU_MERCHANT_SALT, or\n" +
        "   RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET, in backend/edtech/.env.\n" +
        "   Paid enrolment is disabled; free courses are unaffected."
    );
} else if (PAYMENT_PROVIDER === "payu") {
    console.log(`💳 Payments: PayU (${PAYU_MODE} mode), callbacks to ${PUBLIC_BASE_URL}`);
    if (PAYU_MODE !== "live") {
        console.log("   Test mode — no real money moves. Set PAYU_MODE=live when ready.");
    }
    /*
     * Said at boot, not discovered at checkout. PayU redirects a real browser
     * to this address; if it is localhost, every payment dead-ends on a page
     * the student's phone cannot reach.
     */
    if (/localhost|127\.0\.0\.1/.test(PUBLIC_BASE_URL)) {
        console.warn(
            "⚠️  PUBLIC_BASE_URL points at localhost. PayU redirects the customer's\n" +
            "   browser there after payment, so this only works while you are testing\n" +
            "   on this machine. Set it to your public URL before taking real payments."
        );
    }
} else {
    console.log("💳 Payments: Razorpay");
}

const razorpayInstance = razorpayConfigured
    ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
    : null;

/**
 * Refuse payment routes cleanly when the provider is not set up.
 *
 * 503, not 500: this is a configuration state the operator can fix, not a bug,
 * and the message says so rather than surfacing "Cannot read properties of
 * null" from somewhere deep in the SDK.
 */
function requirePayments(req, res, next) {
    if (!paymentsConfigured) {
        return res.status(503).json({
            error: "Online payment is not available right now. Please contact your teacher.",
        });
    }
    next();
}

// Route 1: Create Razorpay Order
router.post("/create-order", authMiddleware, async (req, res) => {
    const { courseId } = req.body;
    const userId = req.user.id;
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        /*
         * "Already enrolled" must mean *currently* enrolled.
         *
         * This checked status alone, so a student whose access had expired was
         * still refused with "Already enrolled in this course" — locked out of
         * the content and locked out of buying it again, with no way forward.
         * Reusing the same predicate as the access gates keeps the two answers
         * consistent: if it will not let you in, it must let you re-purchase.
         */
        const existingEnrollment = await client.query(`
            SELECT status, expires_at FROM enrollments
            WHERE user_id = $1 AND course_id = $2 AND ${activeEnrolmentSql('')}
        `, [userId, courseId]);

        if (existingEnrollment.rows.length > 0) {
            // Deliberately specific. The old wording was a flat "Already
            // enrolled in this course", which was indistinguishable from a
            // stale server still running the pre-expiry check — and said
            // nothing about the access the student supposedly still has.
            const { expires_at: existingExpiry } = existingEnrollment.rows[0];
            return res.status(400).json({
                error: existingExpiry
                    ? `You already have access to this course until ${new Date(existingExpiry).toLocaleDateString()}.`
                    : "You already have lifetime access to this course.",
            });
        }
        
        const course = await client.query(`
            SELECT price, title, access_duration_months, access_duration_minutes FROM courses WHERE id = $1
        `, [courseId]);
        
        if (course.rows.length === 0) {
            return res.status(404).json({ error: "Course not found" });
        }
        
        const courseData = course.rows[0];
        if (parseFloat(courseData.price) === 0) {
            // Directly create an active enrollment for free courses
            /*
             * Stamp the expiry at purchase, computed from the course's setting
             * as it stands right now. Deriving it on every read instead would
             * mean a teacher shortening the validity later retroactively cut
             * off students who had already paid for longer.
             *
             * Re-enrolling after a lapse runs through the same ON CONFLICT
             * branch, so a renewal restarts the clock from today.
             */
            const expiresAt = expiryFrom({
                months: courseData.access_duration_months,
                minutes: courseData.access_duration_minutes,
            });

            await client.query(`
                INSERT INTO enrollments (user_id, course_id, payment_status, status, enrolled_at, amount_paid, expires_at)
                VALUES ($1, $2, 'completed', 'active', NOW(), 0, $3)
                ON CONFLICT (user_id, course_id) 
                DO UPDATE SET 
                    status = 'active', 
                    payment_status = 'completed', 
                    enrolled_at = NOW(),
                    expires_at = EXCLUDED.expires_at,
                    updated_at = NOW()
            `, [userId, courseId, expiresAt]);

            await client.query('COMMIT');

            await notifyCourseOwner(courseId, {
                type: "enrolment",
                title: `${req.user.name || "A student"} enrolled`,
                body: courseData.title,
                actorId: userId,
                link: `/analytics`,
            });

            return res.json({
                success: true,
                isFree: true,
                message: "Successfully enrolled in free course"
            });
        }
        const pendingOrder = await client.query(`
            SELECT order_id FROM payment_orders 
            WHERE user_id = $1 AND course_id = $2 AND status = 'created'
            ORDER BY created_at DESC LIMIT 1
        `, [userId, courseId]);
        
        /*
         * Checked here, not on the route.
         *
         * Everything above this line is the free-enrolment path, which never
         * touches Razorpay — gating the whole endpoint would break free courses
         * on an install that simply has no payment provider.
         */
        if (!paymentsConfigured) {
            await client.query('ROLLBACK');
            return res.status(503).json({
                error: "Online payment is not available right now. Please contact your teacher.",
            });
        }

        /*
         * PayU: sign a form, hand it back, let the browser post it.
         *
         * Everything above here — the already-enrolled check, the free path,
         * the price lookup, the pending-order reuse — is identical whichever
         * gateway is in use, which is why this branches here rather than in a
         * route of its own. Duplicating those guards is how two payment paths
         * drift until one of them lets someone buy a course twice.
         */
        if (PAYMENT_PROVIDER === "payu") {
            const txnid = pendingOrder.rows.length > 0
                ? pendingOrder.rows[0].order_id
                : newTxnId();

            if (pendingOrder.rows.length === 0) {
                await client.query(`
                    INSERT INTO payment_orders (order_id, user_id, course_id, amount, status, provider)
                    VALUES ($1, $2, $3, $4, 'created', 'payu')
                `, [txnid, userId, courseId, courseData.price]);
            }

            await client.query(`
                INSERT INTO enrollments (user_id, course_id, payment_status, status)
                VALUES ($1, $2, 'pending', 'pending')
                ON CONFLICT (user_id, course_id)
                DO UPDATE SET payment_status = 'pending', updated_at = NOW()
            `, [userId, courseId]);

            const buyer = await client.query(
                `SELECT name, email, phone FROM users WHERE id = $1`, [userId]
            );
            const me = buyer.rows[0] || {};

            /*
             * PayU rejects several punctuation characters in these fields and
             * requires all of them, so each has a fallback. A course titled
             * "Class 9 (HPBOSE)" would otherwise be refused at the gateway,
             * which reads to the student as the site being broken.
             */
            const fields = {
                key: PAYU_MERCHANT_KEY,
                txnid,
                amount: formatAmount(courseData.price),
                productinfo: sanitiseText(courseData.title, "Course"),
                firstname: sanitiseText((me.name || "").split(" ")[0], "Student"),
                email: me.email || "",
                phone: (me.phone || "").replace(/\D/g, "").slice(-10),
                surl: `${PUBLIC_BASE_URL}/api/payments/payu/callback`,
                furl: `${PUBLIC_BASE_URL}/api/payments/payu/callback`,
                // Carries the course back to us. PayU echoes udf1 in the
                // response, so the callback knows what was bought without
                // trusting anything the browser sends.
                udf1: courseId,
            };
            fields.hash = requestHash(fields);

            await client.query('COMMIT');

            return res.json({
                success: true,
                provider: "payu",
                action: PAYU_ENDPOINT,
                fields,
                amount: courseData.price,
                currency: "INR",
                courseTitle: courseData.title,
            });
        }

        let orderId;

        if (pendingOrder.rows.length > 0) {
            orderId = pendingOrder.rows[0].order_id;
        } else {
            const options = {
                amount: Math.round(courseData.price * 100),
                currency: "INR",
                receipt: `receipt_${Date.now()}_${userId.slice(0, 8)}`,
                notes: {
                    courseId: courseId,
                    userId: userId,
                    courseTitle: courseData.title
                }
            };
            
            const order = await razorpayInstance.orders.create(options);
            orderId = order.id;
            
            await client.query(`
                INSERT INTO payment_orders (order_id, user_id, course_id, amount, status)
                VALUES ($1, $2, $3, $4, 'created')
            `, [orderId, userId, courseId, courseData.price]);
        }
        
        /*
         * Record that a payment is in flight — without touching `status`.
         *
         * This used to force status = 'pending' on conflict, which meant
         * merely *starting* a checkout revoked access the student already had.
         * A student with three valid months who clicked Renew early, then
         * closed the Razorpay window, was left with no access and no payment:
         * their enrolment had been downgraded for a purchase that never
         * happened.
         *
         * Leaving status alone is safe because it is /verify that grants
         * access, and it sets both status and a fresh expires_at. An enrolment
         * that has genuinely lapsed stays lapsed until payment completes.
         */
        await client.query(`
            INSERT INTO enrollments (user_id, course_id, payment_status, status)
            VALUES ($1, $2, 'pending', 'pending')
            ON CONFLICT (user_id, course_id)
            DO UPDATE SET payment_status = 'pending', updated_at = NOW()
        `, [userId, courseId]);
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            provider: "razorpay",
            orderId: orderId,
            // The key id is public — the checkout widget needs it in the
            // browser. The secret never leaves the server.
            keyId: RAZORPAY_KEY_ID,
            amount: courseData.price,
            currency: "INR",
            courseTitle: courseData.title
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Create order error:", error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// Route 2: Verify Payment and Enroll User
router.post("/verify", authMiddleware, requirePayments, async (req, res) => {
    const { orderId, paymentId, signature, courseId } = req.body;
    const userId = req.user.id;
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const orderCheck = await client.query(`
            SELECT id, user_id, course_id, amount, status 
            FROM payment_orders 
            WHERE order_id = $1
        `, [orderId]);
        
        if (orderCheck.rows.length === 0) {
            return res.status(404).json({ error: "Order not found" });
        }
        
        const order = orderCheck.rows[0];
        
        if (order.user_id !== userId) {
            return res.status(403).json({ error: "Unauthorized: Payment belongs to different user" });
        }
        
        if (order.status === 'completed') {
            return res.json({ success: true, alreadyEnrolled: true, message: "Already enrolled" });
        }
        
        const body = orderId + "|" + paymentId;
        const expectedSignature = crypto
            .createHmac("sha256", RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest("hex");
        
        if (expectedSignature !== signature) {
            return res.status(400).json({ error: "Invalid payment signature" });
        }
        
        const razorpayOrder = await razorpayInstance.orders.fetch(orderId);
        if (razorpayOrder.amount_paid !== razorpayOrder.amount) {
            return res.status(400).json({ error: "Full amount not paid" });
        }
        
        await client.query(`
            UPDATE payment_orders 
            SET status = 'completed', 
                razorpay_payment_id = $1,
                razorpay_signature = $2,
                updated_at = NOW()
            WHERE order_id = $3
        `, [paymentId, signature, orderId]);
        
        // Same rule as the free path: the clock starts when the payment
        // completes, not when the order was created.
        const durationResult = await client.query(
            `SELECT access_duration_months, access_duration_minutes FROM courses WHERE id = $1`,
            [courseId]
        );
        const paidExpiresAt = expiryFrom({
            months: durationResult.rows[0]?.access_duration_months,
            minutes: durationResult.rows[0]?.access_duration_minutes,
        });

        await client.query(`
            UPDATE enrollments 
            SET status = 'active', 
                payment_status = 'completed',
                payment_id = $1,
                amount_paid = $2,
                enrolled_at = NOW(),
                expires_at = $5,
                updated_at = NOW()
            WHERE user_id = $3 AND course_id = $4
        `, [paymentId, order.amount, userId, courseId, paidExpiresAt]);
        
        await client.query('COMMIT');

        await notifyCourseOwner(courseId, {
            type: "enrolment",
            title: `${req.user.name || "A student"} enrolled`,
            body: `Paid ₹${order.amount}`,
            actorId: userId,
            link: `/analytics`,
        });

        res.json({
            success: true,
            message: "Payment verified and enrollment successful!"
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Payment verification error:", error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});


/**
 * POST /api/payments/payu/callback
 *
 * PayU's surl and furl. Not an API call — PayU redirects the customer's
 * browser here with a form POST, so this runs with no session, no JWT and no
 * CORS. It is a public endpoint that grants course access, which makes the
 * hash check the only thing standing between a forged form and a free course.
 *
 * Three things are verified, and all three matter:
 *
 *   1. the reverse hash, computed with our salt — proves PayU sent it;
 *   2. the txnid exists and is still awaiting payment — stops a genuine
 *      callback being replayed to re-grant or re-stamp an enrolment;
 *   3. the amount equals what we recorded when the order was created —
 *      a signed response for ₹1 must not unlock a ₹1,000 course.
 *
 * The response is a redirect rather than JSON: what arrives here is a person
 * looking at a browser, not a fetch() waiting on a status code.
 */
router.post("/payu/callback", async (req, res) => {
    const back = (courseId, state) =>
        `${PUBLIC_BASE_URL}/course/${courseId || ""}?payment=${state}`;

    const body = req.body || {};
    const { txnid, status, amount, mihpayid, error_Message: errorMessage } = body;
    const courseId = body.udf1 || null;

    if (!txnid) {
        return res.redirect(303, back(courseId, "failed"));
    }

    const client = await pool.connect();
    try {
        if (!hashesMatch(body.hash, responseHash(body))) {
            /*
             * Logged loudly and granted nothing. A mismatch is either a
             * misconfigured salt or someone posting a hand-written form at the
             * endpoint, and the two are worth telling apart in the logs.
             */
            console.error(`[payu] hash mismatch on txnid ${txnid} — ignoring callback`);
            return res.redirect(303, back(courseId, "failed"));
        }

        await client.query("BEGIN");

        /*
         * FOR UPDATE: PayU can post the same result more than once, and the
         * student's browser may retry. Locking the row means two concurrent
         * callbacks cannot both pass the pending check and both grant access.
         */
        const orderRes = await client.query(
            `SELECT user_id, course_id, amount, status
               FROM payment_orders
              WHERE order_id = $1 AND provider = 'payu'
              FOR UPDATE`,
            [txnid]
        );

        if (orderRes.rows.length === 0) {
            await client.query("ROLLBACK");
            console.error(`[payu] callback for unknown txnid ${txnid}`);
            return res.redirect(303, back(courseId, "failed"));
        }

        const order = orderRes.rows[0];

        // Already settled — a repeat post, not a new payment.
        if (order.status === "completed") {
            await client.query("ROLLBACK");
            return res.redirect(303, back(order.course_id, "success"));
        }

        if (String(status).toLowerCase() !== "success") {
            await client.query(
                `UPDATE payment_orders
                    SET status = 'failed', error_message = $2, updated_at = NOW()
                  WHERE order_id = $1`,
                [txnid, errorMessage || status || "failed"]
            );
            /*
             * The enrolment is left exactly as it was. It may be a live
             * enrolment the student was renewing early, and a failed renewal
             * must not revoke access they already paid for.
             */
            await client.query("COMMIT");
            return res.redirect(303, back(order.course_id, "failed"));
        }

        /*
         * The amount is checked against our own record, not against the
         * request. The hash proves PayU sent these values; it does not prove
         * they are the values we asked for.
         */
        if (formatAmount(order.amount) !== formatAmount(amount)) {
            await client.query(
                `UPDATE payment_orders
                    SET status = 'failed',
                        error_message = $2,
                        updated_at = NOW()
                  WHERE order_id = $1`,
                [txnid, `amount mismatch: expected ${formatAmount(order.amount)}, got ${formatAmount(amount)}`]
            );
            await client.query("COMMIT");
            console.error(`[payu] amount mismatch on ${txnid}`);
            return res.redirect(303, back(order.course_id, "failed"));
        }

        await client.query(
            `UPDATE payment_orders
                SET status = 'completed',
                    gateway_payment_id = $2,
                    updated_at = NOW()
              WHERE order_id = $1`,
            [txnid, mihpayid || null]
        );

        // Same rule as every other path: the clock starts when the payment
        // completes, not when the order was created.
        const duration = await client.query(
            `SELECT access_duration_months, access_duration_minutes FROM courses WHERE id = $1`,
            [order.course_id]
        );
        const expiresAt = expiryFrom({
            months: duration.rows[0]?.access_duration_months,
            minutes: duration.rows[0]?.access_duration_minutes,
        });

        await client.query(
            `UPDATE enrollments
                SET status = 'active',
                    payment_status = 'completed',
                    payment_id = $1,
                    amount_paid = $2,
                    enrolled_at = NOW(),
                    expires_at = $5,
                    updated_at = NOW()
              WHERE user_id = $3 AND course_id = $4`,
            [mihpayid || txnid, order.amount, order.user_id, order.course_id, expiresAt]
        );

        await client.query("COMMIT");

        await notifyCourseOwner(order.course_id, {
            type: "enrolment",
            title: "A student enrolled",
            body: `Paid ₹${order.amount}`,
            actorId: order.user_id,
            link: `/analytics`,
        });

        return res.redirect(303, back(order.course_id, "success"));
    } catch (err) {
        try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
        console.error("[payu] callback error:", err);
        return res.redirect(303, back(courseId, "failed"));
    } finally {
        client.release();
    }
});

// Route 3: Check Enrollment Status
router.get("/enrollments/status/:courseId", authMiddleware, async (req, res) => {
    const { courseId } = req.params;
    const userId = req.user.id;
    
    try {
        const result = await pool.query(`
            SELECT status, payment_status, payment_id, enrolled_at, amount_paid
            FROM enrollments 
            WHERE user_id = $1 AND course_id = $2
        `, [userId, courseId]);
        
        if (result.rows.length === 0) {
            return res.json({ status: 'not_enrolled', enrolled: false });
        }
        
        const enrollment = result.rows[0];
        res.json({
            status: enrollment.status,
            enrolled: enrollment.status === 'active',
            paymentStatus: enrollment.payment_status,
            paymentId: enrollment.payment_id,
            enrolledAt: enrollment.enrolled_at,
            amountPaid: enrollment.amount_paid
        });
        
    } catch (error) {
        console.error("Status check error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Route 4: Get Payment Order Status
router.get("/order/:orderId/status", authMiddleware, async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user.id;
    
    try {
        const result = await pool.query(`
            SELECT status, razorpay_payment_id, amount, created_at
            FROM payment_orders 
            WHERE order_id = $1 AND user_id = $2
        `, [orderId, userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Order not found" });
        }
        
        res.json({ success: true, order: result.rows[0] });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;