/**
 * Replay a backup produced by scripts/backup-database.js.
 *
 *   node scripts/restore-database.js <file.sql>              # report only
 *   node scripts/restore-database.js <file.sql> --apply      # insert
 *   node scripts/restore-database.js <file.sql> --apply --truncate
 *
 * The backup holds rows, not schema. So the order is: let the backend start
 * once against the empty database (setupDatabase builds every table), stop it,
 * then run this.
 *
 * --truncate empties every table first. Without it, restoring over existing
 * rows fails on primary keys and unique emails — the backup carries explicit
 * ids, so it cannot merge with data that is already there. A fresh database
 * usually needs it anyway, because the backend seeds a Default Educator row on
 * first boot and the backup contains that same id.
 *
 * Statements are split on semicolons *outside* string literals. Splitting on
 * every ';' would cut a row in half the moment a description or a quiz question
 * contained one, and that failure looks like corrupt SQL rather than a bad
 * parser.
 */
import "dotenv/config";
import fs from "fs";
import pool from "../config/database.js";

const file = process.argv[2];
const apply = process.argv.includes("--apply");
const truncate = process.argv.includes("--truncate");

if (!file) {
    console.error("Usage: node scripts/restore-database.js <file.sql> [--apply] [--truncate]");
    process.exit(1);
}
if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
}

/**
 * Split SQL into statements, respecting single-quoted strings.
 *
 * Postgres escapes a quote inside a literal by doubling it (''), so a quote
 * immediately followed by another quote does not end the string. Comments are
 * skipped at line level, which is all this file contains.
 */
function splitStatements(sql) {
    const out = [];
    let buf = "";
    let inString = false;

    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];

        if (inString) {
            buf += ch;
            if (ch === "'") {
                if (sql[i + 1] === "'") { buf += sql[++i]; }   // escaped quote
                else inString = false;
            }
            continue;
        }

        if (ch === "'") { inString = true; buf += ch; continue; }

        // A line comment runs to the newline, and only outside a string.
        if (ch === "-" && sql[i + 1] === "-") {
            while (i < sql.length && sql[i] !== "\n") i++;
            continue;
        }

        if (ch === ";") {
            const s = buf.trim();
            if (s) out.push(s);
            buf = "";
            continue;
        }

        buf += ch;
    }
    const tail = buf.trim();
    if (tail) out.push(tail);
    return out;
}

const sql = fs.readFileSync(file, "utf8");
const statements = splitStatements(sql)
    // BEGIN/COMMIT are handled by this script's own transaction.
    .filter((s) => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s));

const byTable = new Map();
const columnsWanted = new Map();  // table -> Set(columns the backup writes)
for (const s of statements) {
    const m = s.match(/^INSERT\s+INTO\s+"?(\w+)"?\s*\(([^)]*)\)/i);
    if (!m) continue;
    const t = m[1];
    byTable.set(t, (byTable.get(t) || 0) + 1);
    const set = columnsWanted.get(t) || new Set();
    for (const c of m[2].split(",")) {
        const name = c.trim().replace(/"/g, "").toLowerCase();
        if (/^\w+$/.test(name)) set.add(name);
    }
    columnsWanted.set(t, set);
}

console.log(`\n${file}`);
console.log(`${statements.length} statements across ${byTable.size} tables:\n`);
for (const [t, n] of [...byTable].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${t}`);
}

/*
 * Preflight: what does the backup need that the live schema does not have?
 *
 * A backup is a photograph of an older schema. Restoring it into a database
 * built by today's setupDatabase fails on the first column that has since been
 * dropped — or, as happened here, on a column that only ever existed because a
 * hand-run migration added it and was never folded back in.
 *
 * Checking up front turns "it failed on statement 1 of 957" into a list of
 * exactly what to add, which is the difference between one fix and twenty
 * restarts.
 */
const schemaGaps = [];
{
    const { rows } = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'`
    );
    const live = new Map();
    for (const r of rows) {
        if (!live.has(r.table_name)) live.set(r.table_name, new Set());
        live.get(r.table_name).add(r.column_name.toLowerCase());
    }
    for (const [t, wanted] of columnsWanted) {
        const have = live.get(t);
        if (!have) { schemaGaps.push(`${t} — table does not exist`); continue; }
        for (const c of wanted) if (!have.has(c)) schemaGaps.push(`${t}.${c}`);
    }
}

if (schemaGaps.length) {
    console.log(`\n⚠️  ${schemaGaps.length} column(s) the backup needs are missing from this database:\n`);
    for (const g of schemaGaps) console.log(`   - ${g}`);
    console.log(
        "\nAdd these to setupDatabase() in server.js and restart once before\n" +
        "restoring, or those rows will be skipped."
    );
} else {
    console.log("\nSchema check: every column the backup writes exists here.");
}

if (!apply) {
    console.log(
        "\nNothing was written. To restore:" +
        "\n  node scripts/restore-database.js " + file + " --apply --truncate" +
        "\n\n--truncate empties the target first; without it this will fail on" +
        "\nduplicate ids wherever rows already exist."
    );
    await pool.end();
    process.exit(0);
}

const client = await pool.connect();
try {
    await client.query("BEGIN");

    if (truncate) {
        const { rows } = await client.query(
            `SELECT table_name FROM information_schema.tables
              WHERE table_schema='public' AND table_type='BASE TABLE'`
        );
        const names = rows.map((r) => `"${r.table_name}"`).join(", ");
        if (names) {
            // All at once: truncating one at a time fails on the first table
            // another still references.
            await client.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
            console.log(`\ntruncated ${rows.length} tables`);
        }
    }

    let done = 0;
    const failures = [];
    for (const s of statements) {
        /*
         * A savepoint per statement.
         *
         * Without one, this loop does not do what it looks like it does:
         * Postgres aborts the entire transaction on the first error and then
         * refuses every later command with "current transaction is aborted",
         * so one bad row turns into 957 failures and nothing is restored. That
         * is exactly what happened the first time this script ran.
         *
         * Rolling back to a savepoint discards only the failed statement and
         * leaves the transaction usable, which is what makes "skip the bad rows
         * and keep the rest" actually true.
         */
        await client.query("SAVEPOINT stmt");
        try {
            await client.query(s);
            await client.query("RELEASE SAVEPOINT stmt");
            done++;
        } catch (err) {
            await client.query("ROLLBACK TO SAVEPOINT stmt");
            failures.push({ sql: s.slice(0, 110), message: err.message });
        }
    }

    if (failures.length) {
        console.log(`\n${failures.length} statement(s) failed:\n`);
        for (const f of failures.slice(0, 15)) {
            console.log(`  ${f.message}`);
            console.log(`    ${f.sql}...\n`);
        }
        if (failures.length > 15) console.log(`  ...and ${failures.length - 15} more`);
    }

    await client.query("COMMIT");
    console.log(`\n✅ restored ${done} of ${statements.length} statements`);
    if (failures.length) {
        console.log("   The failures above were skipped; everything else is in.");
    }
} catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\nRestore failed, rolled back:", err.message);
    process.exitCode = 1;
} finally {
    client.release();
    await pool.end();
}
