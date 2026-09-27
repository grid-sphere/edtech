/**
 * Empty every application table. Irreversible.
 *
 *   node scripts/reset-database.js                      # report only, writes nothing
 *   node scripts/reset-database.js --apply --yes-wipe   # actually truncate
 *
 * TRUNCATE rather than DROP: server.js recreates missing tables on boot, but it
 * also runs a long list of ALTER TABLE ... ADD COLUMN IF NOT EXISTS migrations
 * accumulated over the project's life. Dropping the tables would leave the
 * schema to be rebuilt by whichever of those still run, and any that were
 * removed from the file over time would simply never be reapplied. Truncating
 * keeps the schema exactly as it is today and only removes the rows.
 *
 * Two flags, deliberately. A single --force is one shell-history arrow-up away
 * from being re-run by accident on a database somebody has since repopulated;
 * --yes-wipe is long enough and specific enough that typing it is a decision.
 *
 * It prints the database host before doing anything, because the single worst
 * outcome here is running this against the wrong DATABASE_URL — and by the time
 * the row counts look surprising, it is already done.
 */
import "dotenv/config";
import pool from "../config/database.js";

const apply = process.argv.includes("--apply") && process.argv.includes("--yes-wipe");

/*
 * Tables that are not the application's data.
 *
 * Nothing here today, but PostGIS, pg_stat_statements and similar extensions
 * create tables in `public`, and truncating those breaks the extension rather
 * than clearing user data.
 */
const NEVER_TRUNCATE = new Set(["spatial_ref_sys"]);

function describeTarget() {
    const url = process.env.DATABASE_URL || "";
    try {
        const u = new URL(url);
        // Host and database name only — never the password, which is in this URL.
        return `${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
    } catch {
        return "(could not parse DATABASE_URL)";
    }
}

try {
    console.log(`\nDatabase: ${describeTarget()}\n`);

    const { rows: tables } = await pool.query(`
        SELECT table_name
          FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name
    `);

    const targets = tables
        .map((t) => t.table_name)
        .filter((name) => !NEVER_TRUNCATE.has(name));

    if (targets.length === 0) {
        console.log("No tables found. Nothing to do.");
        process.exit(0);
    }

    let total = 0;
    console.log("Rows that would be deleted:\n");
    for (const name of targets) {
        // Identifier interpolation is unavoidable for a table name; the values
        // come from information_schema, not from user input, and are quoted.
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "${name}"`);
        total += rows[0].n;
        console.log(`  ${String(rows[0].n).padStart(8)}  ${name}`);
    }
    console.log(`\n  ${String(total).padStart(8)}  TOTAL across ${targets.length} tables`);

    if (!apply) {
        console.log(
            "\nNothing was changed. To actually do this:" +
            "\n  node scripts/reset-database.js --apply --yes-wipe" +
            "\n\nMake sure your backup is verified first — this cannot be undone."
        );
        process.exit(0);
    }

    /*
     * One statement, all tables. TRUNCATE across the whole set at once is the
     * only way to satisfy the foreign keys between them — truncating
     * table-by-table fails on the first one another table still references, and
     * CASCADE on a single table would quietly take its dependents with it in an
     * order nobody chose.
     *
     * RESTART IDENTITY so any serial columns begin again at 1 rather than
     * continuing from wherever the deleted data left off.
     */
    const list = targets.map((n) => `"${n}"`).join(", ");
    await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);

    console.log(`\n✅ Truncated ${targets.length} tables (${total} rows removed).`);
    console.log("Restart the backend — it recreates anything it needs on boot.");
} catch (err) {
    console.error("Failed:", err.message);
    process.exit(1);
} finally {
    await pool.end();
}
