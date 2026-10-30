/**
 * Set a known password on an account, for testing.
 *
 *   node scripts/set-password.js someone@example.com
 *   node scripts/set-password.js someone@example.com --role student
 *
 * Why this exists: stored passwords are bcrypt hashes, and bcrypt is one-way.
 * There is no way to read back what a user's password is — not for an admin,
 * not for anyone. Restoring a backup brings the hashes with it, so every real
 * user's own password keeps working, but if you need to sign in *as* a
 * particular account to test what they see, the only honest route is to give
 * that account a password you choose.
 *
 * The password is typed at a prompt rather than passed as an argument, so it
 * does not end up in PowerShell's history file.
 *
 * This changes a real person's password. They will not be able to sign in with
 * their old one afterwards, and nothing tells them why — so on a live database,
 * prefer making a test account over borrowing a student's.
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import readline from "node:readline";
import pool from "../config/database.js";

const email = process.argv[2];
const roleIdx = process.argv.indexOf("--role");
const role = roleIdx > -1 ? process.argv[roleIdx + 1] : null;

if (!email || !email.includes("@")) {
    console.error('Usage: node scripts/set-password.js <email> [--role student|educator|admin]');
    process.exit(1);
}

/** Read a line without echoing it. */
function askHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let first = true;
        rl._writeToOutput = (s) => {
            if (first) { process.stdout.write(question); first = false; return; }
            if (s.includes("\n")) process.stdout.write("\n");
        };
        rl.question(question, (a) => { rl.close(); resolve(a); });
    });
}

try {
    const { rows } = await pool.query(
        `SELECT id, name, email, role, deleted_at FROM users
          WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
        [email]
    );

    if (rows.length === 0) {
        console.error(`No account found for ${email}.`);
        const { rows: near } = await pool.query(
            `SELECT name, role FROM users ORDER BY created_at DESC LIMIT 5`
        );
        console.error("Five most recent:", near.map((u) => `${u.name} (${u.role})`).join(", "));
        process.exit(1);
    }

    const user = rows[0];
    if (user.deleted_at) {
        console.error("That account is suspended or deleted; it cannot sign in whatever its password.");
        process.exit(1);
    }

    const pw = await askHidden(`New password for ${user.name} <${user.email}> (min 8): `);
    const confirm = await askHidden("Confirm: ");
    if (pw !== confirm) { console.error("Passwords did not match. Nothing changed."); process.exit(1); }
    if (!pw || pw.length < 8) { console.error("Must be at least 8 characters. Nothing changed."); process.exit(1); }

    const hash = await bcrypt.hash(pw, 10);

    if (role) {
        await pool.query(
            `UPDATE users SET password_hash = $1, role = $2, updated_at = NOW() WHERE id = $3`,
            [hash, role, user.id]
        );
        console.log(`\n✅ Password set, role is now ${role}.`);
    } else {
        await pool.query(
            `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
            [hash, user.id]
        );
        console.log(`\n✅ Password set. Role unchanged (${user.role}).`);
    }
    console.log("Their previous password no longer works.");
} catch (err) {
    console.error("Failed:", err.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
