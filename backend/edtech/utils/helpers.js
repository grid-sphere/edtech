import crypto from "crypto";
import { pipeline } from "node:stream";

/**
 * Send a stream to a writable, and close the source when the other end goes away.
 *
 * This exists because of a specific failure: videos and PDFs worked after a
 * restart and stopped opening some hours later, for everyone at once.
 *
 * The media routes did `obj.Body.pipe(res)`. A browser aborts media requests
 * constantly — seeking, pausing, switching page, and HLS cancelling its own
 * read-ahead — and a bare `.pipe()` handles that in one direction only: `res`
 * is destroyed, and the R2 stream on the other side is left open and unread.
 * The HTTPS socket carrying it stays checked out of the AWS SDK's connection
 * pool and is never returned.
 *
 * The SDK's pool holds 50 sockets by default. So every abandoned video leaked
 * one, and once fifty had accumulated, every subsequent R2 request queued for a
 * socket that would never come free. Nothing errored — requests simply hung
 * until the browser gave up. PDFs died alongside videos even though the PDF
 * route was blameless, because they draw from the same pool; that shared
 * symptom is what makes this look like "R2 broke" rather than a leak. A restart
 * emptied the pool, which is why it always came back and then went again.
 *
 * `pipeline` is the fix: it propagates destruction both ways, so a client
 * hanging up tears down the R2 read as well. It also gives the source an error
 * handler, which `.pipe()` does not — an R2 stream failing mid-send used to
 * emit `error` with nothing listening, and an unhandled `error` on a stream
 * takes the whole process down.
 *
 * @param {import("node:stream").Readable} source
 * @param {import("node:stream").Writable} destination
 * @param {string} [label] for the log line when something genuinely fails
 */
export function pipeStream(source, destination, label = "stream") {
    pipeline(source, destination, (err) => {
        // pipeline destroys both ends itself; this only covers a source that
        // finished without it noticing. Destroying a closed stream is a no-op.
        if (source && !source.destroyed) source.destroy();

        if (!err) return;

        /*
         * A client closing a tab mid-download is the normal case, not an
         * incident. Logging it would bury real failures under one line per
         * seek, which on a video player is a lot of lines.
         */
        if (err.code === "ERR_STREAM_PREMATURE_CLOSE") return;
        if (err.code === "ECONNRESET" || err.code === "EPIPE") return;

        console.error(`[${label}] stream failed:`, err.message);
    });
}

export function generateFileHash(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

export function getFileExtension(filename) {
    const parts = filename.split(".");
    return parts.length > 1 ? `.${parts.pop()}` : "";
}

export function getMimeType(filename) {
    const ext = getFileExtension(filename).toLowerCase();
    const map = {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
        ".txt": "text/plain",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".mkv": "video/x-matroska",
        ".mp3": "audio/mpeg",
        ".html": "text/html", ".css": "text/css",
        ".js": "application/javascript", ".json": "application/json",
        ".csv": "text/csv",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel",
    };
    return map[ext] || "application/octet-stream";
}

export function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function convertDocxToHtml(buf) {
    try {
        const mammoth = await import("mammoth");
        const result = await mammoth.convertToHtml({ buffer: buf });
        return { success: true, html: result.value };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function generateSignedUrl(r2Client, r2Key, expiresIn = 3600) {
    if (!r2Key) return null;
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl: getSignedUrlFromSdk } = await import("@aws-sdk/s3-request-presigner");
    const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key });
    return await getSignedUrlFromSdk(r2Client, command, { expiresIn });
}