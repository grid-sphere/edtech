import crypto from "crypto";

/**
 * PayU (India) hosted checkout.
 *
 * PayU is not an API you call — it is a form you post the browser to. There is
 * no SDK and no order object: you sign a set of fields with your salt, POST
 * them to PayU, the customer pays on PayU's page, and PayU posts the result
 * back to a URL you nominated. Everything hangs off two SHA-512 hashes, and if
 * either string is assembled wrongly the failure is a flat "hash mismatch"
 * from PayU with nothing to say which field was wrong.
 *
 * Formulas, from PayU's own documentation:
 *
 *   request  sha512(key|txnid|amount|productinfo|firstname|email
 *                   |udf1|udf2|udf3|udf4|udf5||||||SALT)
 *   response sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1
 *                   |email|firstname|productinfo|amount|txnid|key)
 *
 * The response is the request reversed with the salt moved to the front, and
 * the six empty fields in the middle are real — they are udf6..udf10, which
 * this integration does not use but must still account for.
 */

export const PAYU_MERCHANT_KEY = (process.env.PAYU_MERCHANT_KEY || "").trim();
export const PAYU_MERCHANT_SALT = (process.env.PAYU_MERCHANT_SALT || "").trim();

/**
 * Test or live. Defaults to test.
 *
 * The safe default is the one that cannot take real money by accident: an
 * unset variable means a misconfigured server, and a misconfigured server
 * charging real cards is far worse than one that does not.
 */
export const PAYU_MODE = (process.env.PAYU_MODE || "test").trim().toLowerCase();

export const PAYU_ENDPOINT = PAYU_MODE === "live"
    ? "https://secure.payu.in/_payment"
    : "https://test.payu.in/_payment";

/**
 * Where PayU sends the browser back to.
 *
 * Must be an address PayU can reach from the public internet — it redirects a
 * real browser there, so localhost works while you are testing on your own
 * machine and nowhere else.
 */
export const PUBLIC_BASE_URL =
    (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

export const payuConfigured = Boolean(PAYU_MERCHANT_KEY && PAYU_MERCHANT_SALT);

const sha512 = (s) => crypto.createHash("sha512").update(s).digest("hex");

/**
 * Amounts must be byte-identical between the request and the response hash.
 *
 * PayU echoes back whatever string it received, so "100" out and "100.00" back
 * would produce two different hashes and a mismatch that looks like tampering.
 * Fixing the format at two decimals on the way out removes the question.
 */
export function formatAmount(value) {
    return Number(value).toFixed(2);
}

/**
 * The five user-defined fields, normalised.
 *
 * Absent udfs must hash as empty strings rather than "undefined" — which is
 * what string interpolation would produce, and which PayU would never
 * reproduce on its side.
 */
function udfs(source = {}) {
    return [1, 2, 3, 4, 5].map((n) => source[`udf${n}`] ?? "");
}

/**
 * Sign an outgoing payment request.
 *
 * @param {{txnid: string, amount: string|number, productinfo: string,
 *          firstname: string, email: string}} p
 */
export function requestHash(p) {
    const [u1, u2, u3, u4, u5] = udfs(p);
    return sha512(
        [
            PAYU_MERCHANT_KEY,
            p.txnid,
            formatAmount(p.amount),
            p.productinfo,
            p.firstname,
            p.email,
            u1, u2, u3, u4, u5,
            // udf6..udf10, unused but part of the string.
            "", "", "", "", "",
            PAYU_MERCHANT_SALT,
        ].join("|")
    );
}

/**
 * Recompute the hash PayU should have sent with a response.
 *
 * Built from the values in the response, not from what we stored: that is what
 * makes it a signature check. Whether those values are the ones we expected —
 * the amount in particular — is a separate question the caller must also ask.
 *
 * @param {Record<string, string>} r the posted form body
 */
export function responseHash(r) {
    const [u1, u2, u3, u4, u5] = udfs(r);
    const base = [
        PAYU_MERCHANT_SALT,
        r.status ?? "",
        // udf10..udf6, again unused and again required.
        "", "", "", "", "",
        u5, u4, u3, u2, u1,
        r.email ?? "",
        r.firstname ?? "",
        r.productinfo ?? "",
        r.amount ?? "",
        r.txnid ?? "",
        PAYU_MERCHANT_KEY,
    ].join("|");

    /*
     * additionalCharges shifts the whole string.
     *
     * When PayU applies a convenience fee it prepends the charge and hashes
     * `additionalCharges|SALT|status|...` instead. Miss this and every
     * surcharged payment fails verification — which, since most test
     * transactions carry no fee, is a bug that only appears in production.
     */
    return r.additionalCharges
        ? sha512(`${r.additionalCharges}|${base}`)
        : sha512(base);
}

/**
 * Constant-time comparison of two hex digests.
 *
 * A plain !== leaks timing information about how much of the hash matched,
 * which is exactly the signal an attacker forging a callback would want.
 */
export function hashesMatch(a, b) {
    const x = Buffer.from(String(a || "").toLowerCase(), "utf8");
    const y = Buffer.from(String(b || "").toLowerCase(), "utf8");
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
}

/**
 * A transaction id PayU will accept.
 *
 * Alphanumeric and short: PayU rejects long ids and anything with punctuation,
 * and a UUID with its hyphens is exactly the kind of value that looks fine
 * locally and is refused at the gateway.
 */
export function newTxnId() {
    return `sv${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * PayU rejects several characters in the free-text fields, and a rejected
 * payment reads to the student as the site being broken. Stripping them is
 * kinder than passing them through and hoping.
 */
export function sanitiseText(value, fallback) {
    const cleaned = String(value ?? "")
        .replace(/[^a-zA-Z0-9 .\-_]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100);
    return cleaned || fallback;
}
