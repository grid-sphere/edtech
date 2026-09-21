/**
 * Free file_hash values held by uploads that never finished.
 *
 * content_items.file_hash is UNIQUE, and both video upload paths used to write
 * the hash before the encode succeeded while only checking for an existing row
 * whose status was 'ready'. An upload that failed, or was abandoned mid-encode,
 * therefore kept the hash for ever — and every later attempt at the same file
 * died on
 *
 *   duplicate key value violates unique constraint "content_items_file_hash_key"
 *
 * The routes no longer do that (they release a dead holder before claiming the
 * hash), but rows stranded before the fix stay stranded: nothing goes back and
 * tidies them, and the educator just sees the same upload fail again.
 *
 * This clears the fingerprint from those rows. It does not delete anything —
 * the row, its title, its module links and its failure metadata all stay, so
 * the history of what went wrong is still there to read. Only the dedupe
 * fingerprint goes, which is what was blocking the re-upload.
 *
 *   node scripts/release-stuck-hashes.js            # report only, writes nothing
 *   node scripts/release-stuck-hashes.js --apply    # release them
 *
 * Dry by default on purpose: this is the kind of script someone runs at
 * midnight on a live database because uploads are broken, and it should not be
 * possible to change anything by pressing up-arrow and enter.
 */
import pool from "../config/database.js";

const apply = process.argv.includes("--apply");

/*
 * 'processing' is deliberately excluded.
 *
 * A row can legitimately be processing right now — a long encode is minutes of
 * work — and releasing its hash mid-job would let a second upload of the same
 * file claim it and race the first to the same output. Only rows that have
 * actually stopped are safe to reclaim.
 *
 * Genuinely stuck 'processing' rows do exist (a backend restart mid-encode
 * leaves one), so they are reported separately rather than ignored. Left alone
 * they are still handled at upload time: the routes hand back the processing
 * row instead of inserting a duplicate.
 */
const RELEASABLE = `status = 'failed'`;

async function main() {
    const stuck = await pool.query(`
        SELECT id, title, status, is_active, created_at, updated_at
          FROM content_items
         WHERE file_hash IS NOT NULL
           AND status <> 'ready'
         ORDER BY updated_at DESC NULLS LAST, created_at DESC
    `);

    if (stuck.rows.length === 0) {
        console.log("Nothing is holding a hash it should not. No action needed.");
        return;
    }

    const failed = stuck.rows.filter((r) => r.status === "failed");
    const processing = stuck.rows.filter((r) => r.status !== "failed");

    console.log(`\n${stuck.rows.length} row(s) hold a file_hash without being ready:\n`);
    for (const r of stuck.rows) {
        const when = (r.updated_at || r.created_at)?.toISOString?.().slice(0, 16) ?? "?";
        const live = r.is_active ? "" : "  (soft-deleted)";
        console.log(`  [${r.status.padEnd(10)}] ${when}  ${r.title ?? "(untitled)"}${live}`);
        console.log(`               ${r.id}`);
    }

    if (processing.length > 0) {
        console.log(
            `\n${processing.length} of those are still 'processing'. Left alone — one may be` +
            `\nencoding right now, and the upload routes already hand that row back` +
            `\nrather than inserting a duplicate. If you are certain nothing is running,` +
            `\nmark them failed first:` +
            `\n  UPDATE content_items SET status = 'failed' WHERE id = '<id>';`
        );
    }

    if (failed.length === 0) {
        console.log("\nNothing releasable (no 'failed' rows).");
        return;
    }

    if (!apply) {
        console.log(
            `\n${failed.length} failed row(s) would have their hash released.` +
            `\nRe-run with --apply to do it.`
        );
        return;
    }

    const done = await pool.query(`
        UPDATE content_items
           SET file_hash = NULL, updated_at = NOW()
         WHERE file_hash IS NOT NULL
           AND ${RELEASABLE}
        RETURNING id
    `);

    console.log(`\n✅ Released ${done.rowCount} hash(es). Those files can be uploaded again.`);
}

main()
    .catch((err) => {
        console.error("release-stuck-hashes failed:", err.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
