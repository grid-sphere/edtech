/**
 * Dump every table to a restorable .sql file, without needing pg_dump.
 *
 *   node scripts/backup-database.js                     # writes ./db-backup-<date>.sql
 *   node scripts/backup-database.js C:\path\out.sql     # or wherever you like
 *
 * pg_dump is the right tool and this is not trying to replace it — it has no
 * schema, no indexes, no sequences, no ownership. What it does have is every
 * row of every table as INSERT statements, which is the part you cannot
 * reconstruct from the source code. The schema comes back on its own: server.js
 * recreates tables and runs its ALTER migrations on boot, so a restore is
 * "start the backend once against an empty database, then replay this file".
 *
 * Written because the machine doing the backup had no Postgres client tools and
 * the database was about to be wiped — the worst possible moment to discover
 * that the only backup path needed an install.
 *
 * Restore:
 *   1. Point the backend at the empty database and start it once, so the schema
 *      and migrations run.
 *   2. Feed this file back in with psql, or paste it into any SQL console.
 */
import "dotenv/config";
import fs from "fs";
import pool from "../config/database.js";

const outPath =
    process.argv[2] ||
    `db-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.sql`;

/*
 * Rows are written in this order where possible.
 *
 * Foreign keys mean a child row cannot be inserted before its parent, and a
 * restore that fails a third of the way through is worse than one that refuses
 * to start. This is not a real topological sort — it is the handful of tables
 * everything else points at, listed first. Anything not named here follows
 * alphabetically, which is fine because the remaining tables reference these
 * rather than each other.
 */
const FIRST = ["users", "courses", "modules", "content_items", "folders", "quizzes"];

/** Format one value as a SQL literal. */
function literal(v) {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
    if (v instanceof Date) return `'${v.toISOString()}'`;
    if (Buffer.isBuffer(v)) return `'\\x${v.toString("hex")}'`;

    if (Array.isArray(v)) {
        /*
         * A Postgres array literal, not JSON. modules.content_ids is uuid[],
         * and handing it '["a","b"]' would fail the cast — it needs '{a,b}'.
         * Elements are double-quoted so a value containing a comma or brace
         * cannot break out of the literal.
         */
        const items = v.map((x) =>
            x === null ? "NULL" : `"${String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        );
        return `'{${items.join(",")}}'`;
    }

    if (typeof v === "object") {
        // jsonb columns (content_items.metadata, and others).
        return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
    }

    return `'${String(v).replace(/'/g, "''")}'`;
}

const BATCH = 500;

try {
    const { rows: found } = await pool.query(`
        SELECT table_name
          FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name
    `);

    const names = found.map((r) => r.table_name);
    const ordered = [
        ...FIRST.filter((n) => names.includes(n)),
        ...names.filter((n) => !FIRST.includes(n)),
    ];

    const out = fs.createWriteStream(outPath, { encoding: "utf8" });
    const write = (s) =>
        new Promise((resolve) => (out.write(s) ? resolve() : out.once("drain", resolve)));

    await write(
        `-- Row backup taken ${new Date().toISOString()}\n` +
        `-- Restore: start the backend once against an empty database so the\n` +
        `-- schema is created, then replay this file.\n\n` +
        `BEGIN;\n\n`
    );

    let grandTotal = 0;
    for (const table of ordered) {
        const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
        const n = countRows[0].n;
        console.log(`  ${String(n).padStart(8)}  ${table}`);
        grandTotal += n;

        if (n === 0) {
            await write(`-- ${table}: empty\n\n`);
            continue;
        }

        await write(`-- ${table}: ${n} rows\n`);

        // Batched so a large table is never fully resident in memory.
        for (let offset = 0; offset < n; offset += BATCH) {
            const { rows, fields } = await pool.query(
                `SELECT * FROM "${table}" ORDER BY 1 LIMIT $1 OFFSET $2`,
                [BATCH, offset]
            );
            if (rows.length === 0) break;

            const cols = fields.map((f) => `"${f.name}"`).join(", ");
            for (const row of rows) {
                const values = fields.map((f) => literal(row[f.name])).join(", ");
                await write(`INSERT INTO "${table}" (${cols}) VALUES (${values});\n`);
            }
        }
        await write("\n");
    }

    await write("COMMIT;\n");
    await new Promise((resolve) => out.end(resolve));

    const size = fs.statSync(outPath).size;
    console.log(`\n✅ ${grandTotal} rows from ${ordered.length} tables`);
    console.log(`   ${outPath}  (${(size / 1024 / 1024).toFixed(2)} MB)`);
} catch (err) {
    console.error("Backup failed:", err.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
