/**
 * Grant or revoke the admin role.
 *
 *   node make-admin.js someone@example.com
 *   node make-admin.js someone@example.com --revoke
 *
 * Why this exists as a script: signup only ever issues 'student' or 'educator',
 * nothing seeds an admin, and there is no promotion screen — so the very first
 * admin has to be made directly against the database. The database is remote,
 * so rather than require a psql install this borrows the connection the backend
 * already has, reading DATABASE_URL from .env exactly as the server does.
 *
 * It grants no access that the reader does not already have: anyone who can run
 * this can read .env, and anyone who can read .env can run any SQL they like.
 *
 * Two things it deliberately does:
 *   - reports how many rows changed, because "0" is the answer when the email is
 *     wrong, and silence would look identical to success;
 *   - prints the resulting role, so a typo in a column or a stale connection
 *     cannot pass for a promotion that never happened.
 */
import "dotenv/config";
import pool from "./config/database.js";

const email = process.argv[2];
const revoke = process.argv.includes("--revoke");

if (!email || !email.includes("@")) {
    console.error("Usage: node make-admin.js <email> [--revoke]");
    process.exit(1);
}

const role = revoke ? "educator" : "admin";

try {
    /*
     * Matched case-insensitively and trimmed. Addresses are stored however the
     * person typed them at signup, and "no rows updated" because of a capital
     * letter is a confusing way to spend an afternoon.
     */
    const { rows } = await pool.query(
        `UPDATE users SET role = $1
          WHERE LOWER(TRIM(email)) = LOWER(TRIM($2))
        RETURNING id, name, email, role`,
        [role, email]
    );

    if (rows.length === 0) {
        console.error(`No account found for ${email} — nothing changed.`);
        // Names only, never addresses: this prints to a terminal that may be
        // shared or screenshotted, and the point is only to spot a typo.
        const { rows: near } = await pool.query(
            `SELECT name, role FROM users ORDER BY created_at DESC LIMIT 5`
        );
        console.error("Five most recent accounts:", near.map((u) => `${u.name} (${u.role})`).join(", "));
        process.exit(1);
    }

    for (const u of rows) {
        console.log(`${u.name} <${u.email}> is now ${u.role}.`);
    }
    console.log("\nLog out and back in — the role is inside the session token,");
    console.log("so an existing login keeps the old one until it is reissued.");
} catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
} finally {
    await pool.end();
}
