/**
 * Report any 'superadmin' rows, and optionally put them back to a normal role.
 *
 * The superadmin feature was rolled back in code, so the role string no longer
 * grants anything — it now fails every `role === 'admin'` check, which means an
 * account left at 'superadmin' is effectively locked out of the admin powers it
 * used to have. This finds those rows so they can be set back.
 *
 *   node scripts/check-superadmin.js            # report only, writes nothing
 *   node scripts/check-superadmin.js --to-admin # set every superadmin -> admin
 *
 * --to-admin restores admin powers (not student), since anyone who was made a
 * superadmin was, by definition, meant to have at least admin access.
 */
import "dotenv/config";
import pool from "../config/database.js";

const fix = process.argv.includes("--to-admin");

try {
    const { rows } = await pool.query(
        `SELECT id, name, email, role, deleted_at
           FROM users WHERE role = 'superadmin'
          ORDER BY created_at DESC`
    );

    if (rows.length === 0) {
        console.log("No 'superadmin' rows. The database is clean — nothing to undo.");
        process.exit(0);
    }

    console.log(`\n${rows.length} account(s) still hold role = 'superadmin':\n`);
    for (const u of rows) {
        const state = u.deleted_at ? "  (suspended/deleted)" : "";
        console.log(`  ${u.name} <${u.email}>${state}`);
        console.log(`     ${u.id}`);
    }

    if (!fix) {
        console.log("\nRe-run with --to-admin to set them back to admin.");
        process.exit(0);
    }

    const done = await pool.query(
        `UPDATE users SET role = 'admin', updated_at = NOW()
          WHERE role = 'superadmin' RETURNING id`
    );
    console.log(`\n✅ Set ${done.rowCount} account(s) back to admin.`);
    console.log("They keep admin access; the superadmin tier no longer exists.");
} catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
} finally {
    await pool.end();
}
