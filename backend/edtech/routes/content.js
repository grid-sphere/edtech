import express from "express";
import {
    MAX_VIDEO_BYTES, MAX_FILE_BYTES, MAX_CHUNK_BYTES,
    MULTIPART_PART_SIZE, MULTIPART_MAX_PARTS, MULTIPART_URL_TTL_SECONDS,
    describeLimit,
} from "../constants/uploadLimits.js";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import {
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import pool from "../config/database.js";
import { r2Client, R2_BUCKET_NAME } from "../config/r2.js";
import authMiddleware from "../middleware/auth.js";
import { activeEnrolmentSql } from "../utils/enrollmentAccess.js";
import { notifyCourseStudents } from "../utils/notify.js";

import { generateFileHash, getFileExtension, getMimeType, pipeStream } from "../utils/helpers.js";
import { pipeline as pipelineCb } from "node:stream";

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_VIDEO_DIR = path.join(__dirname, "../temp_videos");

/**
 * Tell enrolled students that a piece of content is now watchable.
 *
 * Called at the point a row reaches status 'ready', not at upload time. A
 * video is inserted as 'processing' and attached to its module immediately,
 * then flips to 'ready' minutes later once encoding finishes — announcing at
 * upload would send students to a player that cannot play anything yet.
 *
 * The module is found by searching content_ids rather than being passed in,
 * because the background encode paths run long after the request that knew it
 * has ended.
 *
 * Never throws: this runs at the tail of upload handlers and inside background
 * jobs, and neither should fail over a notification.
 */
async function announceContentReady(contentId, actorId) {
    try {
        const { rows } = await pool.query(
            `SELECT ci.title,
                    ci.content_type,
                    m.course_id
               FROM content_items ci
               JOIN modules m ON ci.id = ANY(m.content_ids)
              WHERE ci.id = $1::uuid
                AND ci.status = 'ready'
                AND ci.is_active = true
              LIMIT 1`,
            [contentId]
        );
        if (rows.length === 0) return;

        const { title, content_type, course_id } = rows[0];
        const label = content_type === "video" ? "video" : content_type === "pdf" ? "document" : "resource";

        await notifyCourseStudents(course_id, {
            type: "content",
            title: `New ${label} available`,
            body: title,
            actorId: actorId || null,
            link: `/course/${course_id}`,
        });
    } catch (err) {
        console.error("[announceContentReady]", err.message);
    }
}

/**
 * Resolve the ffmpeg / ffprobe binaries.
 *
 * They were spawned by bare name, which requires a system-wide FFmpeg on PATH.
 * package.json already depends on @ffmpeg-installer/ffmpeg and
 * @ffprobe-installer/ffprobe, which ship the binary and expose its path — so
 * on a machine without FFmpeg installed, every transcode died with ENOENT and
 * the video was marked 'failed', with the fix sitting unused in node_modules.
 *
 * Falls back to the bare name so a system install still wins if those packages
 * are ever removed.
 */
async function resolveBinary(installerPackage, fallbackName) {
    try {
        const mod = await import(installerPackage);
        const resolved = mod.default?.path || mod.path;
        if (resolved && fs.existsSync(resolved)) {
            console.log(`ffmpeg-tools: using bundled ${fallbackName} at ${resolved}`);
            return resolved;
        }
    } catch (err) {
        console.warn(`ffmpeg-tools: could not load ${installerPackage} (${err.message}); falling back to PATH.`);
    }
    console.log(`ffmpeg-tools: ${fallbackName} falling back to PATH`);
    return fallbackName;
}

const FFMPEG_PATH = await resolveBinary("@ffmpeg-installer/ffmpeg", "ffmpeg");
const FFPROBE_PATH = await resolveBinary("@ffprobe-installer/ffprobe", "ffprobe");

if (!fs.existsSync(TEMP_VIDEO_DIR)) fs.mkdirSync(TEMP_VIDEO_DIR, { recursive: true });

// Small assets (PDFs/images) stay in memory — fine at these sizes.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

// 🚀 RESTORED: Videos stream straight to disk instead of buffering into RAM.
// At 7GB, memoryStorage would need 7GB of RAM per concurrent upload — this
// was reverted back to memoryStorage/500MB at some point and needs to stay
// disk-based for large uploads to be safe.
const videoUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, TEMP_VIDEO_DIR),
        filename: (req, file, cb) => cb(null, `raw_${crypto.randomUUID()}${getFileExtension(file.originalname)}`)
    }),
    limits: { fileSize: MAX_VIDEO_BYTES }
});


/**
 * Decide what to do about an existing row with the same file_hash.
 *
 * content_items.file_hash is UNIQUE and deletes are soft (is_active = false),
 * which leaves three cases:
 *
 *   no row        -> caller inserts as normal
 *   active row    -> real duplicate; reuse it, upload nothing
 *   INACTIVE row  -> deleted, but the hash is still taken. Filtering it out
 *                    with "AND is_active = true" means the INSERT then fails
 *                    with 'duplicate key value ... content_items_file_hash_key'
 *                    — so revive the row instead. The bytes are already in R2
 *                    under the same hash-addressed key.
 *
 * @returns {Promise<{row: object, revived: boolean} | null>}
 */
async function resolveExistingByHash(db, fileHash, fields = {}) {
    const found = await db.query(`SELECT * FROM content_items WHERE file_hash = $1`, [fileHash]);
    if (found.rows.length === 0) return null;

    const row = found.rows[0];
    if (row.is_active) return { row, revived: false };

    const revived = await db.query(`
        UPDATE content_items
        SET is_active = true,
            title = COALESCE($2, title),
            description = COALESCE($3, description),
            preview = COALESCE($4, preview),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `, [row.id, fields.title ?? null, fields.description ?? null, fields.preview ?? null]);

    return { row: revived.rows[0], revived: true };
}

/**
 * One output quality, not a ladder.
 *
 * Encoding three renditions costs three times the CPU, and for recorded
 * lectures the adaptive switching that buys is rarely worth it: the content is
 * mostly static slides and a talking head, so a single well-chosen rung looks
 * fine on a phone and a laptop alike.
 *
 * The trade-off is real though — a student on a weak connection can no longer
 * drop to a smaller stream, they just buffer. 720p is the balance point for
 * lecture material: text on slides stays legible, which 480p does not always
 * manage.
 *
 * Set VIDEO_QUALITY=480p in .env to halve the bitrate again.
 */
const RENDITION_PRESETS = {
    "480p":  { name: "480p",  scale: "854:480",   bitrate: "1000k" },
    "720p":  { name: "720p",  scale: "1280:720",  bitrate: "2500k" },
    "1080p": { name: "1080p", scale: "1920:1080", bitrate: "4500k" },
};

const VIDEO_RENDITIONS = [
    RENDITION_PRESETS[(process.env.VIDEO_QUALITY || "720p").toLowerCase()] ||
    RENDITION_PRESETS["720p"],
];

console.log(`🎥 Video output: single ${VIDEO_RENDITIONS[0].name} rendition`);

const activeJobs = new Map();

// Streaming SHA-256 hash for disk-based files (videos) — avoids reading the
// whole file into memory just to hash it.
function hashFileFromDisk(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// Wraps a multer middleware so upload errors (file too large, wrong
// field, etc.) return clean JSON instead of an unhandled exception.
function handleUpload(multerMiddleware, maxSizeBytes) {
    return (req, res, next) => {
        multerMiddleware(req, res, (err) => {
            if (err) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(413).json({
                        success: false,
                        error: `File too large. Max allowed size is ${(maxSizeBytes / (1024 * 1024)).toFixed(0)} MB.`
                    });
                }
                return res.status(400).json({ success: false, error: err.message });
            }
            next();
        });
    };
}

// POST /api/content/upload
router.post("/upload", authMiddleware, handleUpload(upload.single("file"), 50 * 1024 * 1024), async (req, res) => {
    try {
        // 🚀 RESTORED: check both body and query for moduleId.
        const moduleId = req.body.moduleId || req.query.moduleId;
        const { title, description, content_type, preview } = req.body;
        // The modal sends the tab the educator had open. It was being ignored,
        // so every upload landed unfiled and appeared under General no matter
        // which chapter it was added from.
        const folderId = req.body.folder_id || req.query.folder_id || null;
        const file = req.file;
        const userId = req.user.id || req.user.userId || req.user.sub;
        
        if (req.user.role !== 'educator' && req.user.role !== 'admin') return res.status(403).json({ error: "Only educators can upload content" });
        if (!file) return res.status(400).json({ error: "No file uploaded" });
        if (!title || !content_type) return res.status(400).json({ error: "title and content_type are required" });

        const fileHash = generateFileHash(file.buffer);
        const extension = getFileExtension(file.originalname);
        const mimeType = getMimeType(file.originalname);

        // 🚀 RESTORED: Only ACTIVE rows count as a real duplicate. A soft-deleted
        // row (is_active = false) with a matching hash must not short-circuit
        // the upload — that returns a dead, unopenable "duplicate" forever.
        const existingResolved = await resolveExistingByHash(pool, fileHash, { title, description });
        const existing = { rows: existingResolved ? [existingResolved.row] : [] };
        if (existing.rows.length > 0) {
            const contentId = existing.rows[0].id;
            if (moduleId) {
                await pool.query(`
                    UPDATE modules 
                    SET content_ids = array_append(content_ids, $1::uuid) 
                    WHERE id = $2::uuid AND NOT ($1::uuid = ANY(content_ids))
                `, [contentId, moduleId]);
            }
            // Re-uploading a file that already exists should still file it
            // where the educator asked, rather than leaving it where it was.
            if (folderId) {
                await pool.query(`UPDATE content_items SET folder_id = $1 WHERE id = $2`, [folderId, contentId]);
                existing.rows[0].folder_id = folderId;
            }
            return res.status(200).json({ success: true, message: "File already exists.", content: existing.rows[0], isDuplicate: true });
        }

        const hashPrefix = fileHash.slice(0, 6);
        const r2Key = `content/${hashPrefix}/${fileHash}${extension}`;
        await r2Client.send(new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: r2Key, Body: file.buffer, ContentType: mimeType }));

        const result = await pool.query(`
            INSERT INTO content_items (title, description, content_type, file_hash, file_name, file_size_bytes, mime_type, r2_key, status, preview, created_by, folder_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready', $9, $10, $11) RETURNING *
        `, [title, description, content_type, fileHash, file.originalname, file.size, mimeType, r2Key, preview === 'true' || preview === true, userId, folderId]);

        const contentId = result.rows[0].id;

        if (moduleId) {
            await pool.query(`
                UPDATE modules 
                SET content_ids = array_append(content_ids, $1::uuid) 
                WHERE id = $2::uuid AND NOT ($1::uuid = ANY(content_ids))
            `, [contentId, moduleId]);
        }

        // PDFs and documents are stored synchronously, so they are already
        // 'ready' here — unlike video, there is nothing to wait for.
        if (moduleId) await announceContentReady(contentId, userId);

        res.status(201).json({ success: true, content: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/content/upload-video
router.post("/upload-video", authMiddleware, handleUpload(videoUpload.single("file"), MAX_VIDEO_BYTES), async (req, res) => {
    // Track the raw disk path Multer wrote to, so it can be cleaned up on any early-exit path.
    let rawDiskPath = null;
    try {
        // 🚀 RESTORED: check both body and query for moduleId. VideoUploadModal
        // sends this as a FormData body field, not a query string — without
        // this fallback, videos uploaded through that modal succeed but never
        // get linked into any module's content_ids array.
        const moduleId = req.body.moduleId || req.query.moduleId;
        const { title, description, preview } = req.body;
        const folderId = req.body.folder_id || req.query.folder_id || null;
        const file = req.file;
        const userId = req.user.id || req.user.userId || req.user.sub;

        if (req.user.role !== 'educator' && req.user.role !== 'admin') {
            if (file) fs.unlinkSync(file.path);
            return res.status(403).json({ error: "Only educators can upload videos" });
        }
        if (!file) return res.status(400).json({ error: "No file uploaded" });
        rawDiskPath = file.path;

        if (!title || !file.mimetype.startsWith("video/")) {
            fs.unlinkSync(rawDiskPath);
            return res.status(400).json({ error: "Invalid video upload" });
        }

        // 🚀 RESTORED: File already lives on disk — hash it by streaming
        // instead of loading a buffer, so a multi-gigabyte file never sits in RAM.
        const fileHash = await hashFileFromDisk(rawDiskPath);
        const extension = getFileExtension(file.originalname);

        // 🚀 RESTORED: Only ACTIVE rows count as a real duplicate.
        const existingResolved = await resolveExistingByHash(pool, fileHash, { title, description });
        const existing = { rows: existingResolved ? [existingResolved.row] : [] };
        if (existing.rows.length > 0) {
            fs.unlinkSync(rawDiskPath);
            const contentId = existing.rows[0].id;
            if (moduleId) {
                await pool.query(`
                    UPDATE modules 
                    SET content_ids = array_append(content_ids, $1::uuid) 
                    WHERE id = $2::uuid AND NOT ($1::uuid = ANY(content_ids))
                `, [contentId, moduleId]);
            }
            if (folderId) {
                await pool.query(`UPDATE content_items SET folder_id = $1 WHERE id = $2`, [folderId, contentId]);
                existing.rows[0].folder_id = folderId;
            }
            return res.status(200).json({ success: true, message: "Video already exists.", content: existing.rows[0], isDuplicate: true });
        }

        // Rename to the hash-based name transcodeVideo/cleanup expects.
        const tempFilePath = path.join(TEMP_VIDEO_DIR, `${fileHash}${extension}`);
        fs.renameSync(rawDiskPath, tempFilePath);
        rawDiskPath = null; // ownership moved to tempFilePath now

        const result = await pool.query(`
            INSERT INTO content_items (
                title, description, content_type, file_hash, file_name, file_size_bytes, mime_type,
                status, preview, created_by, folder_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8, $9, $10) RETURNING id
        `, [title, description || "", "video", fileHash, file.originalname, file.size, file.mimetype, preview === 'true' || preview === true, userId, folderId]);

        const contentId = result.rows[0].id;

        if (moduleId) {
            await pool.query(`
                UPDATE modules 
                SET content_ids = array_append(content_ids, $1::uuid) 
                WHERE id = $2::uuid AND NOT ($1::uuid = ANY(content_ids))
            `, [contentId, moduleId]);
        }
        
        transcodeVideo(contentId, tempFilePath, fileHash, title, VIDEO_RENDITIONS, 0);

        res.status(202).json({ success: true, message: "Video uploaded. Processing in background.", content: { id: contentId, title, content_type: "video", status: "processing" } });
    } catch (err) {
        console.error("Video Upload error:", err);
        if (rawDiskPath && fs.existsSync(rawDiskPath)) {
            try { fs.unlinkSync(rawDiskPath); } catch (_) {}
        }
        res.status(500).json({ success: false, error: err.message });
    }
});


// ============================================================
// IMAGES (course thumbnails + quiz diagrams)
// ============================================================
//
// Both routes were lost in a merge, so CourseModal's thumbnail picker and
// QuizModal's "Add Diagram" button posted to a route that did not exist and
// got a 404 back.
//
// These must stay ABOVE `GET /:id`: Express matches in declaration order, so
// registering them later would let `/:id` capture "stream-image" as an id and
// return "content not found" instead of the image.
//
// Unlike /upload, these never touch content_items — an image is not a lesson,
// and giving it a content row would put thumbnails in the curriculum list.

// POST /api/content/upload-image
router.post("/upload-image", authMiddleware, upload.single("file"), async (req, res) => {
    try {
        const file = req.file;
        const folder = (req.query.folder || "misc").replace(/[^a-zA-Z0-9_-]/g, "");

        if (req.user.role !== 'educator' && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Only educators can upload images" });
        }
        if (!file) return res.status(400).json({ error: "No file uploaded" });
        if (!file.mimetype.startsWith("image/")) {
            return res.status(400).json({ error: "Only image files are allowed" });
        }

        const fileHash = generateFileHash(file.buffer);
        const extension = getFileExtension(file.originalname) || ".jpg";
        const r2Key = `images/${folder}/${fileHash}${extension}`;

        await r2Client.send(new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: r2Key,
            Body: file.buffer,
            ContentType: file.mimetype
        }));

        // Served back through our own endpoint rather than a public R2 URL, so
        // the bucket can stay private.
        const imageUrl = `/api/content/stream-image?key=${encodeURIComponent(r2Key)}`;

        res.status(201).json({ success: true, imageUrl, key: r2Key });
    } catch (err) {
        console.error("Image upload error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/content/stream-image
//
// Deliberately unauthenticated. An <img src> cannot send an Authorization
// header, and the alternative — putting the JWT in the query string — would
// leak it into browser history, access logs and Referer headers.
//
// Safe because the route is not a general R2 proxy: it serves only keys under
// images/, and those keys are content hashes, so a URL cannot be guessed. The
// images themselves (course thumbnails) already appear on public listings.
router.get("/stream-image", async (req, res) => {
    try {
        const { key } = req.query;
        if (!key) return res.status(400).json({ error: "key is required" });

        // Restricted to images/ on purpose: without this the route would be a
        // generic R2 proxy and any authenticated user could read every object
        // in the bucket, including course videos and PDFs.
        if (!key.startsWith("images/")) {
            return res.status(400).json({ error: "Invalid image key" });
        }

        const r2Response = await r2Client.send(
            new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })
        );

        const chunks = [];
        for await (const chunk of r2Response.Body) chunks.push(chunk);
        const imageBuffer = Buffer.concat(chunks);

        res.setHeader("Content-Type", r2Response.ContentType || "image/jpeg");
        res.setHeader("Content-Length", imageBuffer.length);
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.send(imageBuffer);
    } catch (err) {
        console.error("Stream image error:", err);
        if (err.name === "NoSuchKey" || err.Code === "NoSuchKey") {
            return res.status(404).json({ error: "Image not found in storage" });
        }
        res.status(500).json({ error: "Failed to load image", details: err.message });
    }
});

// ============================================================
// CHUNKED UPLOAD (large videos, straight to this server)
// ============================================================
//
// One multi-gigabyte POST is fragile and unhelpful: a dropped connection at 90% loses
// everything, a proxy or body limit anywhere in the chain kills it outright,
// and a single TCP stream rarely saturates the uplink.
//
// Splitting it up fixes all three. Each chunk is an ordinary small POST, so
// nothing in the chain objects; a failed chunk retries on its own; and several
// can be in flight at once, which usually raises the achieved throughput
// because the limit is typically per-connection rather than per-link.
//
// Chunks land as separate files and are joined at the end, so they may arrive
// in any order — that is what makes parallel upload possible without the
// server having to buffer or reorder anything.

const CHUNK_DIR = path.join(TEMP_VIDEO_DIR, "chunks");
if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });

// Generous ceiling; the client picks the real size. This bounds ONE chunk,
// not the file — the total is checked at assembly, where it is knowable.
const chunkUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_CHUNK_BYTES },
});

/**
 * Where one upload's parts live.
 *
 * Namespaced by user and validated as a UUID: the id arrives from the client,
 * and without both of those a crafted value could write outside this directory
 * or into someone else's upload.
 */
function chunkDirFor(userId, uploadId) {
    if (!/^[0-9a-fA-F-]{36}$/.test(String(uploadId))) {
        throw new Error("Invalid uploadId");
    }
    return path.join(CHUNK_DIR, String(userId), String(uploadId));
}

// POST /api/content/upload-chunk
router.post("/upload-chunk", authMiddleware, chunkUpload.single("chunk"), async (req, res) => {
    try {
        if (req.user.role !== 'educator' && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Only educators can upload videos" });
        }

        const { uploadId, index } = req.body;
        const chunkIndex = Number(index);

        if (!req.file) return res.status(400).json({ error: "No chunk received" });
        if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
            return res.status(400).json({ error: "A numeric chunk index is required" });
        }

        const dir = chunkDirFor(req.user.id, uploadId);
        fs.mkdirSync(dir, { recursive: true });

        // Written under a temp name and renamed, so a half-written chunk from a
        // dropped connection is never mistaken for a complete one on retry.
        const finalPath = path.join(dir, `${chunkIndex}.part`);
        const tempPath = `${finalPath}.incoming`;
        fs.writeFileSync(tempPath, req.file.buffer);
        fs.renameSync(tempPath, finalPath);

        res.json({ success: true, index: chunkIndex, size: req.file.buffer.length });
    } catch (err) {
        console.error("upload-chunk error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/content/upload-status/:uploadId — which chunks already arrived.
// Lets a resumed upload skip what it already sent.
router.get("/upload-status/:uploadId", authMiddleware, async (req, res) => {
    try {
        const dir = chunkDirFor(req.user.id, req.params.uploadId);
        if (!fs.existsSync(dir)) return res.json({ success: true, received: [] });

        const received = fs.readdirSync(dir)
            .filter((f) => f.endsWith(".part"))
            .map((f) => parseInt(f, 10))
            .filter((n) => Number.isInteger(n));

        res.json({ success: true, received });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/content/upload-finish — join the chunks and start processing.
router.post("/upload-finish", authMiddleware, async (req, res) => {
    let assembledPath = null;
    try {
        if (req.user.role !== 'educator' && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Only educators can upload videos" });
        }

        const { uploadId, totalChunks, fileName, title, description, preview, moduleId, folderId } = req.body;
        const expected = Number(totalChunks);
        const userId = req.user.id;

        if (!title) return res.status(400).json({ error: "title is required" });
        if (!Number.isInteger(expected) || expected < 1) {
            return res.status(400).json({ error: "totalChunks is required" });
        }

        const dir = chunkDirFor(userId, uploadId);
        if (!fs.existsSync(dir)) return res.status(400).json({ error: "No chunks found for this upload" });

        // Refuse to assemble a file with holes in it rather than producing a
        // corrupt video that fails much later in ffmpeg.
        const missing = [];
        for (let i = 0; i < expected; i++) {
            if (!fs.existsSync(path.join(dir, `${i}.part`))) missing.push(i);
        }
        if (missing.length > 0) {
            return res.status(400).json({
                error: `Upload incomplete — ${missing.length} chunk(s) missing.`,
                missing: missing.slice(0, 20),
            });
        }

        /*
         * The size limit, actually enforced.
         *
         * Until now the chunked path had no total-size check anywhere on the
         * server. multer bounds one chunk at a time, and nothing added them up,
         * so the advertised ceiling lived exclusively in the browser — where it
         * is a hint, not a limit. Anyone posting chunks directly could store a
         * file of any size, and the "reject oversized videos" requirement was
         * simply not true of the path this modal actually uses.
         *
         * Summed from the parts before they are joined rather than from the
         * assembled file afterwards: stat is metadata only, so this costs a few
         * hundred syscalls and no reading, and it refuses the upload before
         * writing a second full-size copy to disk. Checking after assembly would
         * mean spending the disk to discover we did not want it.
         */
        let totalBytes = 0;
        for (let i = 0; i < expected; i++) {
            totalBytes += fs.statSync(path.join(dir, `${i}.part`)).size;
        }
        if (totalBytes > MAX_VIDEO_BYTES) {
            fs.rmSync(dir, { recursive: true, force: true });
            return res.status(413).json({
                error: `Videos must be ${describeLimit()} or smaller.`,
            });
        }

        assembledPath = path.join(TEMP_VIDEO_DIR, `assembled_${uploadId}${getFileExtension(fileName || ".mp4")}`);

        // Streamed append: concatenating gigabytes through Buffers would blow the heap.
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(assembledPath);
            out.on("error", reject);
            out.on("finish", resolve);

            let i = 0;
            const next = () => {
                if (i >= expected) { out.end(); return; }
                const part = fs.createReadStream(path.join(dir, `${i}.part`));
                part.on("error", reject);
                part.on("end", () => { i++; next(); });
                part.pipe(out, { end: false });
            };
            next();
        });

        fs.rmSync(dir, { recursive: true, force: true });

        const fileHash = await hashFileFromDisk(assembledPath);
        const stats = fs.statSync(assembledPath);

        /*
         * An identical video already processed needs no second encode.
         *
         * The status check used to guard only the `ready` case and then fall
         * through — straight into an INSERT carrying the same file_hash, which
         * the UNIQUE index rejects with
         *   duplicate key value violates unique constraint "content_items_file_hash_key"
         *
         * So a video whose first upload was still encoding, or had failed,
         * could never be uploaded again: the dead row kept the hash for ever
         * and every retry hit the same wall. Which is the worst time for it,
         * because retrying is exactly what someone does after a failed upload.
         */
        const existingResolved = await resolveExistingByHash(pool, fileHash, { title, description });
        if (existingResolved) {
            const holder = existingResolved.row;

            const attachToModule = async (contentId) => {
                if (!moduleId) return;
                await pool.query(`
                    UPDATE modules SET content_ids = array_append(content_ids, $1::uuid)
                    WHERE id = $2::uuid AND NOT ($1::uuid = ANY(content_ids))
                `, [contentId, moduleId]);
            };

            if (holder.status === 'ready') {
                fs.unlinkSync(assembledPath);
                await attachToModule(holder.id);
                return res.status(200).json({ success: true, isDuplicate: true, content: holder });
            }

            /*
             * Still encoding. The same bytes are already in flight, so hand
             * back that row rather than starting a second job on the same file
             * — the UI polls it to completion either way.
             */
            if (holder.status === 'processing') {
                fs.unlinkSync(assembledPath);
                assembledPath = null;
                await attachToModule(holder.id);
                return res.status(200).json({ success: true, isDuplicate: true, content: holder });
            }

            /*
             * Failed, or abandoned in some other state: it holds the hash with
             * nothing behind it. Release it so this upload can claim it.
             * Nulling rather than deleting keeps the row — and whatever it is
             * still attached to — intact for anyone looking at the failure.
             */
            await pool.query(
                `UPDATE content_items SET file_hash = NULL, updated_at = NOW() WHERE id = $1`,
                [holder.id]
            );
            console.log(`🔓 released file_hash held by failed content ${holder.id}`);
        }

        const finalPath = path.join(TEMP_VIDEO_DIR, `${fileHash}${getFileExtension(fileName || ".mp4")}`);
        fs.renameSync(assembledPath, finalPath);
        assembledPath = null;

        const inserted = await pool.query(`
            INSERT INTO content_items (
                title, description, content_type, file_hash, file_name,
                file_size_bytes, mime_type, status, preview, created_by
            ) VALUES ($1, $2, 'video', $3, $4, $5, 'video/mp4', 'processing', $6, $7)
            RETURNING id
        `, [
            title, description || "", fileHash, fileName || null, stats.size,
            preview === true || preview === 'true', userId,
        ]);

        const contentId = inserted.rows[0].id;

        if (moduleId) {
            await pool.query(`
                UPDATE modules SET content_ids = array_append(content_ids, $1::uuid)
                WHERE id = $2::uuid AND NOT ($1::uuid = ANY(content_ids))
            `, [contentId, moduleId]);
        }
        if (folderId) {
            await pool.query(`UPDATE content_items SET folder_id = $1 WHERE id = $2`, [folderId, contentId]);
        }

        res.status(202).json({
            success: true,
            message: "Upload complete. Processing in background.",
            content: { id: contentId, title, content_type: "video", status: "processing" },
        });

        transcodeVideo(contentId, finalPath, fileHash, title, VIDEO_RENDITIONS, 0)
            .catch((err) => console.error("Transcode failed:", err.message));
    } catch (err) {
        console.error("upload-finish error:", err);
        if (assembledPath && fs.existsSync(assembledPath)) fs.unlinkSync(assembledPath);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// POST /api/content/upload-cancel — drop a part-finished upload's chunks.
router.post("/upload-cancel", authMiddleware, async (req, res) => {
    try {
        const dir = chunkDirFor(req.user.id, req.body.uploadId);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ============================================================
// DIRECT-TO-R2 MULTIPART UPLOAD (large videos)
// ============================================================
//
// The ordinary /upload-video route sends the file to this server first, which
// writes it to disk and only then pushes it onward. Every byte of a large file
// therefore crosses the network twice and is limited by this one machine's
// inbound bandwidth.
//
// Here the browser talks straight to R2 using presigned URLs, in parts, several
// at once. That removes the middle hop entirely and — because a single TCP
// stream rarely saturates a home connection — parallel parts typically multiply
// the achieved throughput as well. A failed part retries on its own instead of
// restarting the whole file.
//
// Requires CORS on the R2 bucket allowing PUT from the app's origin and
// exposing the ETag header; without ExposeHeaders the browser cannot read the
// part ETags and the upload cannot be completed.


// POST /api/content/upload-init
router.post("/upload-init", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'educator' && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Only educators can upload videos" });
        }

        const { fileName, fileSize, mimeType } = req.body;
        const size = Number(fileSize);

        if (!fileName || !Number.isFinite(size) || size <= 0) {
            return res.status(400).json({ error: "fileName and a positive fileSize are required" });
        }
        if (size > MAX_VIDEO_BYTES) {
            return res.status(413).json({ error: `Videos must be ${describeLimit()} or smaller.` });
        }
        if (mimeType && !String(mimeType).startsWith("video/")) {
            return res.status(400).json({ error: "That file is not a video." });
        }

        const partCount = Math.ceil(size / MULTIPART_PART_SIZE);
        if (partCount > MULTIPART_MAX_PARTS) {
            return res.status(413).json({ error: "File is too large to upload in parts." });
        }

        // Random key: the content hash is not known until the bytes exist, and
        // hashing a multi-gigabyte file in the browser before uploading would cost more than it
        // saves. The row is keyed by hash later, once the server has the file.
        const key = `uploads/raw/${crypto.randomUUID()}${getFileExtension(fileName)}`;

        const created = await r2Client.send(new CreateMultipartUploadCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            ContentType: mimeType || "video/mp4",
        }));

        // Presigned up front so the browser never has to come back mid-upload.
        // See MULTIPART_URL_TTL_SECONDS: sized for the slowest link likely to push a
        // full-size file, since a URL that expires mid-upload fails parts that have
        // not started yet.
        const urls = [];
        for (let partNumber = 1; partNumber <= partCount; partNumber++) {
            urls.push(await getSignedUrl(
                r2Client,
                new UploadPartCommand({
                    Bucket: R2_BUCKET_NAME,
                    Key: key,
                    UploadId: created.UploadId,
                    PartNumber: partNumber,
                }),
                { expiresIn: MULTIPART_URL_TTL_SECONDS }
            ));
        }

        res.json({
            success: true,
            key,
            uploadId: created.UploadId,
            partSize: MULTIPART_PART_SIZE,
            urls,
        });
    } catch (err) {
        console.error("upload-init error:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/content/upload-complete
router.post("/upload-complete", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'educator' && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Only educators can upload videos" });
        }

        const { key, uploadId, parts, moduleId, title, description, preview, folderId, fileName, fileSize } =
            req.body;
        const userId = req.user.id || req.user.userId || req.user.sub;

        if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
            return res.status(400).json({ error: "key, uploadId and parts are required" });
        }
        if (!title) return res.status(400).json({ error: "title is required" });

        await r2Client.send(new CompleteMultipartUploadCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                // R2 rejects out-of-order parts, and the browser finishes them
                // in whatever order the network allows.
                Parts: [...parts]
                    .map((p) => ({ ETag: p.ETag, PartNumber: Number(p.PartNumber) }))
                    .sort((a, b) => a.PartNumber - b.PartNumber),
            },
        }));

        // file_hash is filled in by the background job, which has to read the
        // whole object anyway to transcode it. NULL is allowed by the UNIQUE
        // index (Postgres permits many NULLs), so duplicate detection simply
        // starts working once the hash is known.
        const inserted = await pool.query(`
            INSERT INTO content_items (
                title, description, content_type, file_name, file_size_bytes,
                mime_type, status, preview, created_by
            ) VALUES ($1, $2, 'video', $3, $4, $5, 'processing', $6, $7)
            RETURNING id
        `, [
            title,
            description || "",
            fileName || null,
            Number(fileSize) || null,
            "video/mp4",
            preview === true || preview === 'true',
            userId,
        ]);

        const contentId = inserted.rows[0].id;

        if (moduleId) {
            await pool.query(`
                UPDATE modules
                SET content_ids = array_append(content_ids, $1::uuid)
                WHERE id = $2::uuid AND NOT ($1::uuid = ANY(content_ids))
            `, [contentId, moduleId]);
        }

        if (folderId) {
            await pool.query(`UPDATE content_items SET folder_id = $1 WHERE id = $2`, [folderId, contentId]);
        }

        // Answer immediately; the fetch-and-transcode runs behind it.
        res.status(202).json({
            success: true,
            message: "Upload complete. Processing in background.",
            content: { id: contentId, title, content_type: "video", status: "processing" },
        });

        processUploadedObject(contentId, key, title).catch((err) => {
            console.error("Background processing failed:", err);
        });
    } catch (err) {
        console.error("upload-complete error:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/content/upload-abort — tidy up a cancelled upload.
router.post("/upload-abort", authMiddleware, async (req, res) => {
    try {
        const { key, uploadId } = req.body;
        if (!key || !uploadId) return res.status(400).json({ error: "key and uploadId are required" });

        await r2Client.send(new AbortMultipartUploadCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
        }));
        res.json({ success: true });
    } catch (err) {
        // Abort is best-effort; R2 lifecycle rules clean up orphans anyway.
        console.warn("upload-abort:", err.message);
        res.json({ success: true, warning: err.message });
    }
});

/**
 * Pull the uploaded object down and run it through the existing pipeline.
 *
 * Streamed to disk rather than buffered: a multi-gigabyte Buffer would exhaust the heap.
 * This hop is server-to-R2 inside a datacentre, so it is far quicker than the
 * educator's uplink, and it happens after the browser is already finished.
 */
async function processUploadedObject(contentId, key, title) {
    const localPath = path.join(TEMP_VIDEO_DIR, `direct_${contentId}${path.extname(key)}`);

    try {
        const obj = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));

        // Same reasoning as the media routes: if the disk write fails, the R2
        // read has to be torn down with it or the socket is never returned.
        await new Promise((resolve, reject) => {
            pipelineCb(obj.Body, fs.createWriteStream(localPath), (err) =>
                err ? reject(err) : resolve()
            );
        });

        const fileHash = await hashFileFromDisk(localPath);

        /*
         * Whoever else holds this hash — not just a `ready` one.
         *
         * Filtering on status here was the same bug as the chunked path: a row
         * stuck in `processing` or `failed` was invisible to the lookup, so the
         * UPDATE below tried to write a hash another row already owned and the
         * job died on
         *   duplicate key value violates unique constraint "content_items_file_hash_key"
         * — reported to the educator as a failed upload with no way to retry.
         */
        const holderQ = await pool.query(
            `SELECT id, r2_key, metadata, duration_seconds, status
               FROM content_items
              WHERE file_hash = $1 AND id <> $2
              LIMIT 1`,
            [fileHash, contentId]
        );
        const src = holderQ.rows[0];

        // A real duplicate means the bytes are already stored and transcoded;
        // point this row at the existing output instead of encoding again.
        if (src && src.status === 'ready' && src.r2_key) {
            await pool.query(`
                UPDATE content_items
                SET status = 'ready', r2_key = $1, metadata = $2, duration_seconds = $3, updated_at = NOW()
                WHERE id = $4
            `, [src.r2_key, src.metadata, src.duration_seconds, contentId]);

            fs.unlinkSync(localPath);
            await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })).catch(() => {});
            console.log(`♻️  ${contentId} reused an identical existing video`);
            return;
        }

        if (src) {
            // Holds the hash with no usable output behind it. Release it, or
            // the UNIQUE index blocks this encode and every future one.
            await pool.query(
                `UPDATE content_items SET file_hash = NULL, updated_at = NOW() WHERE id = $1`,
                [src.id]
            );
            console.log(`🔓 released file_hash held by ${src.status} content ${src.id}`);
        }

        await pool.query(
            `UPDATE content_items SET file_hash = $1, file_size_bytes = $2 WHERE id = $3`,
            [fileHash, fs.statSync(localPath).size, contentId]
        );

        await transcodeVideo(contentId, localPath, fileHash, title, VIDEO_RENDITIONS, 0);

        // The raw upload is redundant once HLS segments exist.
        await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })).catch(() => {});
    } catch (err) {
        console.error(`Direct-upload processing failed for ${contentId}:`, err.message);
        await pool.query(
            `UPDATE content_items SET status = 'failed', metadata = $1, updated_at = NOW() WHERE id = $2`,
            [{ error: err.message, failed_at: new Date().toISOString() }, contentId]
        );
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
}

// GET /api/content
router.get("/", async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM content_items WHERE is_active = true ORDER BY created_at DESC`);
        res.json({ success: true, contents: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// FOLDERS ("tabs" inside a module) + content ordering
// ============================================================
//
// These five routes were dropped in the content.js rewrite (e068d4bf) and
// replaced by a stub that returned an empty array. The UI still calls all of
// them, so tabs stopped listing, could not be created, renamed, deleted or
// moved between, and the up/down reorder arrows silently did nothing.

// GET /api/content/folders/:moduleId  — list a module's tabs
router.get("/folders/:moduleId", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM folders WHERE module_id = $1 ORDER BY created_at ASC`,
            [req.params.moduleId]
        );
        res.json({ success: true, folders: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/content/folder  — create a tab
router.post("/folder", authMiddleware, async (req, res) => {
    const { module_id, title } = req.body;
    if (!module_id || !title || !String(title).trim()) {
        return res.status(400).json({ error: "module_id and a title are required" });
    }
    try {
        const result = await pool.query(
            `INSERT INTO folders (module_id, title) VALUES ($1, $2) RETURNING *`,
            [module_id, String(title).trim()]
        );
        res.json({ success: true, folder: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/content/bulk-move  — move items between tabs
router.put("/bulk-move", authMiddleware, async (req, res) => {
    const { content_ids, folder_id } = req.body;
    if (!Array.isArray(content_ids) || content_ids.length === 0) {
        return res.status(400).json({ error: "content_ids must be a non-empty array" });
    }
    try {
        const result = await pool.query(
            `UPDATE content_items SET folder_id = $2 WHERE id = ANY($1::uuid[]) RETURNING id, folder_id`,
            [content_ids, folder_id || null]
        );
        res.json({ success: true, updated: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/content/folder/:id  — rename a tab
router.put("/folder/:id", authMiddleware, async (req, res) => {
    try {
        const { title } = req.body;
        if (!title || !String(title).trim()) {
            return res.status(400).json({ error: "A title is required" });
        }
        const result = await pool.query(
            `UPDATE folders SET title = $1 WHERE id = $2 RETURNING *`,
            [String(title).trim(), req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Tab not found" });
        }
        res.json({ success: true, folder: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/content/folder/:id  — delete a tab, keeping its contents
router.delete("/folder/:id", authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Detach first. Whether folders.id has ON DELETE CASCADE varies by how
        // the table was created, and cascading here would destroy the
        // educator's uploads rather than returning them to the General tab.
        const moved = await client.query(
            `UPDATE content_items SET folder_id = NULL WHERE folder_id = $1 RETURNING id`,
            [req.params.id]
        );

        const deleted = await client.query(
            `DELETE FROM folders WHERE id = $1 RETURNING id`,
            [req.params.id]
        );

        await client.query("COMMIT");

        if (deleted.rows.length === 0) {
            return res.status(404).json({ error: "Tab not found" });
        }
        res.json({ success: true, message: "Folder deleted", movedToGeneral: moved.rows.length });
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// PUT /api/content/:id/priority  — the up/down reorder arrows
router.put("/:id/priority", authMiddleware, async (req, res) => {
    try {
        const { priority } = req.body;
        const result = await pool.query(
            `UPDATE content_items SET priority = $1 WHERE id = $2 RETURNING id, priority`,
            [parseInt(priority, 10) || 0, req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Content not found" });
        }
        res.json({ success: true, content: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/content/:id
router.get("/:id", async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM content_items WHERE id = $1 AND is_active = true`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Content not found" });
        res.json({ success: true, content: result.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/content/:id/status
router.get("/:id/status", async (req, res) => {
    try {
        const result = await pool.query(`SELECT status, metadata FROM content_items WHERE id = $1`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Content not found" });

        const row = result.rows[0];

        /*
         * activeJobs is in-memory, so it is the live view while this process is
         * doing the work and simply absent after a restart or once the job is
         * done. The DB row is the durable answer; the job only adds detail on
         * top of it, and the client must cope with progress being null.
         */
        const job = activeJobs.get(req.params.id);

        res.json({
            status: row.status,
            metadata: row.metadata,
            // True once at least one rendition is live but others are still
            // encoding — the video is watchable and still improving.
            stillEncoding: Boolean(job) || row.metadata?.pending === true,
            progress: job
                ? {
                      percent: job.percent ?? 0,
                      stage: job.stage ?? null,
                      renditionPercent: job.renditionPercent ?? 0,
                      renditionsDone: job.renditionsDone ?? 0,
                      renditionsTotal: job.renditionsTotal ?? (job.resolutions?.length ?? 0),
                      startedAt: job.startTime ?? null,
                  }
                : null,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// ⭐ GET /api/content/:id/pdf
// ============================================
router.get("/:id/pdf", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { courseId } = req.query;
        const userId = req.user.id || req.user.userId || req.user.sub;

        const result = await pool.query(`SELECT * FROM content_items WHERE id = $1 AND is_active = true`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Content not found" });
        const content = result.rows[0];
        
        // Anything that is not a video is served here. The curriculum shows a
        // separate "Documents" section for .docx/.pptx, and those rows call
        // this same endpoint — an exact content_type === "pdf" test rejected
        // every one of them with "Not a PDF file".
        if (content.content_type === "video") {
            return res.status(400).json({ error: "Use the streaming endpoint for videos." });
        }

        const courseCheck = await pool.query(`
            SELECT c.educator_id, c.id as course_id, c.is_active AS course_is_active
            FROM courses c JOIN modules m ON m.course_id = c.id
            WHERE $1::uuid = ANY(m.content_ids) LIMIT 1
        `, [id]);

        /*
         * A deleted course must stop serving its files.
         *
         * Removing it from the listings only hides it — a student who had the
         * page open, or kept a direct link, could still pull the video or PDF
         * because these gates only ever asked about enrolment. The creator is
         * exempt so they can still review what they deleted.
         */
        if (courseCheck.rows.length > 0 && courseCheck.rows[0].course_is_active === false) {
            const stillOwner =
                String(courseCheck.rows[0].educator_id).toLowerCase() === String(userId).toLowerCase() ||
                req.user.role === 'admin';
            if (!stillOwner) {
                return res.status(403).json({ error: "This course is no longer available." });
            }
        }

        const educatorId = courseCheck.rows.length > 0 ? courseCheck.rows[0].educator_id : null;
        const isCourseOwner = educatorId && String(educatorId).toLowerCase() === String(userId).toLowerCase();
        const isOwner = (content.created_by && String(content.created_by).toLowerCase() === String(userId).toLowerCase()) || isCourseOwner || req.user.role === 'admin';

        if (!isOwner) {
            const courseIdToCheck = courseId || (courseCheck.rows.length > 0 ? courseCheck.rows[0].course_id : null);
            if (!courseIdToCheck) return res.status(403).json({ error: "Access denied." });

            /*
             * Accept an enrolment on the parent course too.
             *
             * Courses are nested — a "class" holds "subject" sub-courses — and
             * students enrol in the parent. This matched only the immediate
             * course_id, so content inside a subject returned 403 for exactly
             * the students who had paid for it. authMiddleware already resolves
             * enrolment this way; the route disagreeing with its own middleware
             * was the bug.
             */
            const enrollCheck = await pool.query(
                `SELECT 1
                   FROM enrollments
                  WHERE user_id = $1
                    AND ${activeEnrolmentSql('')}
                    AND course_id IN (
                        SELECT $2::uuid
                        UNION
                        SELECT parent_course_id FROM courses
                         WHERE id = $2::uuid AND parent_course_id IS NOT NULL
                    )`,
                [userId, courseIdToCheck]
            );

            if (enrollCheck.rows.length === 0 && !content.preview) {
                return res.status(403).json({ error: "Access denied. You are not enrolled." });
            }
        }

        if (!content.r2_key) return res.status(404).json({ error: "PDF not found" });

        const command = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: content.r2_key });
        const r2Response = await r2Client.send(command);
        
        const chunks = [];
        for await (const chunk of r2Response.Body) chunks.push(chunk);
        const body = Buffer.concat(chunks);

        // An empty object would otherwise be sent as a 200 with a zero-byte
        // body, which the viewer renders as a blank frame with no error —
        // indistinguishable from a broken UI. Fail loudly instead.
        if (body.length === 0) {
            return res.status(404).json({ error: "That file is empty or missing from storage." });
        }

        // Serve the real type. Hardcoding application/pdf meant a .docx was
        // labelled a PDF, so the browser tried to render it as one and showed
        // an empty viewer.
        const contentType =
            content.mime_type ||
            (content.content_type === "pdf" ? "application/pdf" : "application/octet-stream");

        res.setHeader("Content-Type", contentType);
        res.setHeader(
            "Content-Disposition",
            `inline; filename="${encodeURIComponent(content.file_name || content.title)}"`
        );
        res.setHeader("Content-Length", body.length);
        res.send(body);
    } catch (err) {
        console.error("PDF fetch error:", err);
        res.status(500).json({ error: "Failed to load PDF" });
    }
});

// ============================================
// ⭐ GET /api/content/:id/stream
// ============================================
/**
 * GET /api/content/:id/file — progressive MP4 with range support.
 *
 * Range handling is not optional here: without it the browser must download
 * the whole file before it can play, and the seek bar does nothing. With it,
 * playback starts immediately and dragging the scrubber fetches only the bytes
 * around that point — which is most of what HLS was buying us.
 *
 * Authenticated via ?token= as well as the header, because a <video src> tag
 * cannot set headers.
 */
router.get("/:id/file", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id || req.user.userId || req.user.sub;

        const result = await pool.query(
            `SELECT * FROM content_items WHERE id = $1 AND is_active = true`, [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "Content not found" });
        const content = result.rows[0];

        const courseCheck = await pool.query(`
            SELECT c.educator_id, c.id as course_id, c.is_active AS course_is_active
            FROM courses c JOIN modules m ON m.course_id = c.id
            WHERE $1::uuid = ANY(m.content_ids) LIMIT 1
        `, [id]);

        const educatorId = courseCheck.rows[0]?.educator_id ?? null;
        const isOwner =
            (content.created_by && String(content.created_by).toLowerCase() === String(userId).toLowerCase()) ||
            (educatorId && String(educatorId).toLowerCase() === String(userId).toLowerCase()) ||
            req.user.role === 'admin';

        if (courseCheck.rows[0]?.course_is_active === false && !isOwner) {
            return res.status(403).json({ error: "This course is no longer available." });
        }

        if (!isOwner) {
            const courseIdToCheck = req.query.courseId || courseCheck.rows[0]?.course_id || null;
            if (!courseIdToCheck) return res.status(403).json({ error: "Access denied." });

            const enrolled = await pool.query(
                `SELECT 1 FROM enrollments
                  WHERE user_id = $1
                    AND ${activeEnrolmentSql('')}
                    AND course_id IN (
                        SELECT $2::uuid
                        UNION
                        SELECT parent_course_id FROM courses
                         WHERE id = $2::uuid AND parent_course_id IS NOT NULL
                    )`,
                [userId, courseIdToCheck]
            );
            if (enrolled.rows.length === 0 && !content.preview) {
                return res.status(403).json({ error: "Access denied. You are not enrolled." });
            }
        }

        if (!content.r2_key) return res.status(404).json({ error: "Video not found" });

        // Pass the browser's Range straight through to R2 so only the needed
        // bytes are ever fetched — this is what makes seeking cheap.
        const range = req.headers.range;
        const obj = await r2Client.send(new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: content.r2_key,
            ...(range ? { Range: range } : {}),
        }));

        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Accept-Ranges", "bytes");
        if (obj.ContentLength != null) res.setHeader("Content-Length", obj.ContentLength);
        if (obj.ContentRange) res.setHeader("Content-Range", obj.ContentRange);

        res.status(range && obj.ContentRange ? 206 : 200);
        /*
         * Not `.pipe()`. Players abort this request on every seek and every
         * pause, and a bare pipe leaves the R2 read open when they do — see
         * pipeStream for why fifty of those stopped the whole site serving
         * media.
         */
        pipeStream(obj.Body, res, `video ${id}`);
    } catch (err) {
        if (err.name === "InvalidRange") return res.status(416).end();
        console.error("File stream error:", err.message);
        if (!res.headersSent) res.status(500).json({ error: "Failed to stream video" });
    }
});

router.get("/:id/stream", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { courseId } = req.query;
        const userId = req.user.id || req.user.userId || req.user.sub;

        const result = await pool.query(`SELECT * FROM content_items WHERE id = $1 AND is_active = true`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Content not found" });
        const content = result.rows[0];
        
        if (content.content_type !== "video") return res.status(400).json({ error: "Not a video" });

        const courseCheck = await pool.query(`
            SELECT c.educator_id, c.id as course_id, c.is_active AS course_is_active
            FROM courses c JOIN modules m ON m.course_id = c.id
            WHERE $1::uuid = ANY(m.content_ids) LIMIT 1
        `, [id]);

        /*
         * A deleted course must stop serving its files.
         *
         * Removing it from the listings only hides it — a student who had the
         * page open, or kept a direct link, could still pull the video or PDF
         * because these gates only ever asked about enrolment. The creator is
         * exempt so they can still review what they deleted.
         */
        if (courseCheck.rows.length > 0 && courseCheck.rows[0].course_is_active === false) {
            const stillOwner =
                String(courseCheck.rows[0].educator_id).toLowerCase() === String(userId).toLowerCase() ||
                req.user.role === 'admin';
            if (!stillOwner) {
                return res.status(403).json({ error: "This course is no longer available." });
            }
        }

        const educatorId = courseCheck.rows.length > 0 ? courseCheck.rows[0].educator_id : null;
        const isCourseOwner = educatorId && String(educatorId).toLowerCase() === String(userId).toLowerCase();
        const isOwner = (content.created_by && String(content.created_by).toLowerCase() === String(userId).toLowerCase()) || isCourseOwner || req.user.role === 'admin';

        if (!isOwner) {
            const courseIdToCheck = courseId || (courseCheck.rows.length > 0 ? courseCheck.rows[0].course_id : null);
            if (!courseIdToCheck) return res.status(403).json({ error: "Access denied." });

            /*
             * Accept an enrolment on the parent course too.
             *
             * Courses are nested — a "class" holds "subject" sub-courses — and
             * students enrol in the parent. This matched only the immediate
             * course_id, so content inside a subject returned 403 for exactly
             * the students who had paid for it. authMiddleware already resolves
             * enrolment this way; the route disagreeing with its own middleware
             * was the bug.
             */
            const enrollCheck = await pool.query(
                `SELECT 1
                   FROM enrollments
                  WHERE user_id = $1
                    AND ${activeEnrolmentSql('')}
                    AND course_id IN (
                        SELECT $2::uuid
                        UNION
                        SELECT parent_course_id FROM courses
                         WHERE id = $2::uuid AND parent_course_id IS NOT NULL
                    )`,
                [userId, courseIdToCheck]
            );

            if (enrollCheck.rows.length === 0 && !content.preview) {
                return res.status(403).json({ error: "Access denied. You are not enrolled." });
            }
        }

        if (content.status !== "ready") {
            return res.status(202).json({ status: content.status, message: "Video is processing" });
        }
        
        if (!content.r2_key) return res.status(404).json({ error: "Video manifest not found" });

        // A directly-stored MP4 has no manifest to point at; the player gets a
        // progressive URL instead and uses native playback.
        if (content.metadata?.direct) {
            return res.json({
                success: true,
                mp4Url: `/api/content/${id}/file`,
                duration: content.duration_seconds,
                accessType: isOwner ? 'creator' : 'enrolled'
            });
        }

        res.json({
            success: true,
            hlsUrl: `/api/hls/serve?videoId=${id}&path=master.m3u8`,
            duration: content.duration_seconds,
            accessType: isOwner ? 'creator' : 'enrolled'
        });
    } catch (err) {
        console.error("Stream endpoint error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// PUT /api/content/:id 
// ============================================
router.put("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, preview } = req.body;
        const userId = req.user.id || req.user.userId || req.user.sub;

        const contentRow = await pool.query(`SELECT * FROM content_items WHERE id = $1`, [id]);
        if (contentRow.rows.length === 0) return res.status(404).json({ error: "Content not found" });
        const content = contentRow.rows[0];

        // 🚀 RESTORED: check ownership directly against content_items.created_by
        // first. The JOIN-through-modules check alone 404s for any content item
        // that isn't (yet) linked into a module's content_ids array — the exact
        // bug this fallback exists to prevent.
        let isOwner = content.created_by && String(content.created_by).toLowerCase() === String(userId).toLowerCase();
        if (!isOwner) {
            const courseCheck = await pool.query(`
                SELECT c.educator_id 
                FROM modules m JOIN courses c ON m.course_id = c.id
                WHERE $1::uuid = ANY(m.content_ids) LIMIT 1
            `, [id]);
            isOwner = courseCheck.rows.length > 0 && String(courseCheck.rows[0].educator_id) === String(userId);
        }
        if (!isOwner && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Only course creator can update content" });
        }
        
        const updateFields = [];
        const values = [];
        let paramCounter = 1;
        
        if (title !== undefined) {
            updateFields.push(`title = $${paramCounter++}`);
            values.push(title === "" ? null : title);
        }
        if (description !== undefined) {
            updateFields.push(`description = $${paramCounter++}`);
            values.push(description === "" ? null : description);
        }
        if (preview !== undefined) {
            updateFields.push(`preview = $${paramCounter++}`);
            values.push(preview === 'true' || preview === true);
        }
        
        if (updateFields.length === 0) return res.status(400).json({ error: "No fields to update" });
        
        updateFields.push(`updated_at = NOW()`);
        values.push(id);
        
        const query = `
            UPDATE content_items 
            SET ${updateFields.join(', ')}
            WHERE id = $${paramCounter}
            RETURNING *
        `;
        
        const result = await pool.query(query, values);
        res.json({ success: true, content: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// DELETE /api/content/:id 
// ============================================
router.delete("/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id || req.user.userId || req.user.sub;

        const contentRow = await pool.query(`SELECT * FROM content_items WHERE id = $1`, [id]);
        if (contentRow.rows.length === 0) return res.status(404).json({ error: "Content not found" });
        const content = contentRow.rows[0];

        // 🚀 RESTORED: same direct-ownership fallback as PUT above.
        let isOwner = content.created_by && String(content.created_by).toLowerCase() === String(userId).toLowerCase();
        if (!isOwner) {
            const courseCheck = await pool.query(`
                SELECT c.educator_id 
                FROM modules m JOIN courses c ON m.course_id = c.id
                WHERE $1::uuid = ANY(m.content_ids) LIMIT 1
            `, [id]);
            isOwner = courseCheck.rows.length > 0 && String(courseCheck.rows[0].educator_id) === String(userId);
        }
        if (!isOwner && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Only course creator can delete content" });
        }
        
        await pool.query(`
            UPDATE content_items 
            SET is_active = false, updated_at = NOW()
            WHERE id = $1 AND is_active = true
        `, [id]);
        
        await pool.query(`
            UPDATE modules 
            SET content_ids = array_remove(content_ids, $1)
            WHERE $1 = ANY(content_ids)
        `, [id]);
        
        res.json({ success: true, message: "Content deactivated successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Run async work over a list with a bounded number in flight.
 *
 * Segments were uploaded to R2 one at a time, each awaiting the previous. A
 * 30-minute lecture is ~180 ten-second segments per rendition, so three
 * renditions meant ~540 sequential round-trips — at a couple of hundred
 * milliseconds each that is minutes of waiting on a mostly idle connection.
 *
 * Concurrency is capped rather than unbounded: firing 540 parallel PUTs would
 * exhaust sockets and file handles, and R2 would start rejecting them.
 */
async function runWithConcurrency(items, limit, worker) {
    let cursor = 0;
    let failure = null;

    const runner = async () => {
        while (cursor < items.length && !failure) {
            const index = cursor++;
            try {
                await worker(items[index]);
            } catch (err) {
                if (!failure) failure = err;
                return;
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, runner)
    );

    if (failure) throw failure;
}

// Eight parallel PUTs was greedy enough to provoke connection resets against
// R2 on a home connection. Four still keeps the link busy.
const UPLOAD_CONCURRENCY = 4;

/**
 * Send one object to R2, retrying transient network failures.
 *
 * "socket hang up" is a dropped connection, not a bad request — and the SDK's
 * own retries could not help, because the body was a read stream that had
 * already been consumed by the failed attempt. A Buffer can be sent again, so
 * this reads the segment into memory first; HLS segments are a few megabytes,
 * which is a cheap price for being able to retry at all.
 */
async function putObjectWithRetry(key, filePath, contentType, attempts = 4) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const body = fs.readFileSync(filePath);
            await r2Client.send(new PutObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: key,
                Body: body,
                ContentLength: body.length,
                ContentType: contentType,
            }));
            return;
        } catch (err) {
            lastError = err;

            // A rejected request will be rejected again; only retry the ones
            // that look like the connection rather than the content.
            const transient =
                /socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|timeout|network/i
                    .test(err.message || "") || err.name === "TimeoutError";

            if (!transient || attempt === attempts) throw err;

            const waitMs = 500 * 2 ** (attempt - 1); // 0.5s, 1s, 2s
            console.warn(`   ↻ ${key} failed (${err.message}); retry ${attempt}/${attempts - 1} in ${waitMs}ms`);
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }

    throw lastError;
}

/**
 * Probe the source so renditions can be chosen from it.
 *
 * Returns { height, duration }; height is null when the probe fails, in which
 * case the caller keeps the full ladder rather than guessing.
 */
async function probeVideo(inputPath) {
    return new Promise((resolve) => {
        let stdout = "";
        let probe;
        try {
            // Codec names matter as much as the dimensions: an H.264/AAC
            // source can be remuxed into HLS instead of re-encoded, which is
            // roughly 30x faster because no pixels are touched.
            probe = spawn(FFPROBE_PATH, [
                "-v", "error",
                "-show_entries", "stream=codec_type,codec_name,width,height",
                "-show_entries", "format=duration",
                "-of", "json",
                inputPath
            ]);
        } catch (err) {
            return resolve({ height: null, duration: null, ok: false });
        }

        probe.stdout.on("data", (d) => { stdout += d.toString(); });
        probe.on("error", () => resolve({ height: null, duration: null, ok: false }));
        probe.on("close", () => {
            try {
                const parsed = JSON.parse(stdout);
                const streams = parsed.streams || [];
                const video = streams.find((s) => s.codec_type === "video");
                const audio = streams.find((s) => s.codec_type === "audio");

                resolve({
                    width: video?.width ?? null,
                    height: video?.height ?? null,
                    duration: Math.round(parseFloat(parsed.format?.duration)) || null,
                    videoCodec: video?.codec_name ?? null,
                    // No audio track at all is fine to copy; only a foreign
                    // codec forces a re-encode.
                    audioCodec: audio ? audio.codec_name : null,
                    hasAudio: Boolean(audio),
                    ok: true,
                });
            } catch (_) {
                resolve({ height: null, duration: null, ok: false });
            }
        });
    });
}

// ============================================
// TRANSCODE FUNCTION
// ============================================
/**
 * Store a browser-playable file as-is instead of transcoding it.
 *
 * HLS exists to allow mid-playback quality switching. That is worth its cost
 * for a streaming service; for recorded lectures it means every upload waits
 * minutes to be decoded and re-encoded into hundreds of segments, when the
 * file the educator already has plays natively in every browser.
 *
 * An H.264/AAC MP4 needs none of that. Uploading it once and serving it with
 * byte-range requests gives immediate playback and working seek, and reduces
 * processing to a single upload — seconds rather than minutes.
 *
 * @returns {Promise<boolean>} true when handled, false to fall through to HLS
 */
async function storeDirectly(contentId, inputPath, fileHash, probe) {
    const playable =
        probe.videoCodec === "h264" && (!probe.hasAudio || probe.audioCodec === "aac");

    if (!playable) return false;

    const key = `content/videos/${fileHash.slice(0, 6)}/${fileHash}.mp4`;

    console.log(`⚡ ${contentId}: already browser-playable — storing as-is, no transcode`);

    // Multipart: a single PutObject of a multi-gigabyte Buffer would exhaust
    // the heap, and this way a dropped connection retries one part.
    const created = await r2Client.send(new CreateMultipartUploadCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        ContentType: "video/mp4",
    }));

    const PART = 16 * 1024 * 1024;
    const size = fs.statSync(inputPath).size;
    const parts = [];

    try {
        const fd = fs.openSync(inputPath, "r");
        try {
            let partNumber = 1;
            for (let offset = 0; offset < size; offset += PART) {
                const length = Math.min(PART, size - offset);
                const buffer = Buffer.allocUnsafe(length);
                fs.readSync(fd, buffer, 0, length, offset);

                let uploaded = null;
                for (let attempt = 1; attempt <= 4 && !uploaded; attempt++) {
                    try {
                        uploaded = await r2Client.send(new UploadPartCommand({
                            Bucket: R2_BUCKET_NAME,
                            Key: key,
                            UploadId: created.UploadId,
                            PartNumber: partNumber,
                            Body: buffer, // a Buffer can be re-sent; a stream cannot
                        }));
                    } catch (err) {
                        if (attempt === 4) throw err;
                        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
                    }
                }

                parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
                const pct = Math.round(((offset + length) / size) * 100);

                const job = activeJobs.get(contentId);
                if (job) {
                    job.stage = "storing";
                    job.percent = pct;
                    job.renditionsDone = 0;
                    job.renditionsTotal = 1;
                }
                partNumber++;
            }
        } finally {
            fs.closeSync(fd);
        }

        await r2Client.send(new CompleteMultipartUploadCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            UploadId: created.UploadId,
            MultipartUpload: { Parts: parts },
        }));
    } catch (err) {
        await r2Client.send(new AbortMultipartUploadCommand({
            Bucket: R2_BUCKET_NAME, Key: key, UploadId: created.UploadId,
        })).catch(() => {});
        throw err;
    }

    await pool.query(`
        UPDATE content_items
        SET status = 'ready',
            r2_key = $1,
            duration_seconds = $2,
            metadata = $3,
            updated_at = NOW()
        WHERE id = $4::uuid
    `, [
        key,
        probe.duration || null,
        {
            // The player uses this to choose progressive playback over HLS.
            format: "mp4",
            direct: true,
            height: probe.height,
            completed_at: new Date().toISOString(),
        },
        contentId,
    ]);

    // The row is live now, so students can be told about it.
    await announceContentReady(contentId);

    activeJobs.delete(contentId);
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    return true;
}

async function transcodeVideo(contentId, inputPath, fileHash, title, resolutions, duration) {
    console.log(`\n${"=".repeat(70)}\n🎬 TRANSCODING — ${contentId}\n${"=".repeat(70)}`);

    const outputDir = path.join(TEMP_VIDEO_DIR, `hls_${contentId}`);
    const hashPrefix = fileHash.slice(0, 6);
    const r2BasePath = `content/videos/${hashPrefix}/${fileHash}`;

    activeJobs.set(contentId, { title, startTime: Date.now(), resolutions: resolutions.map(r => r.name), status: "processing" });

    try {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const probe = await probeVideo(inputPath);
        if (!probe.ok) {
            throw new Error("FFprobe is not available (not installed or not on PATH). Cannot process video.");
        }
        const actualDuration = probe.duration || duration;

        /*
         * The fast path, taken before any encoding decisions are made: if the
         * file already plays in a browser, none of the work below is needed.
         * Set FORCE_HLS=true to always transcode instead.
         */
        if (process.env.FORCE_HLS !== "true") {
            const storedDirectly = await storeDirectly(contentId, inputPath, fileHash, probe);
            if (storedDirectly) {
                console.log(`✅ ${contentId} ready without transcoding`);
                return;
            }
        }

        /*
         * Never encode above the source resolution.
         *
         * The ladder was applied unconditionally, so a 480p screen recording
         * was still upscaled to 720p and 1080p. That is roughly three times
         * the encoding work to produce two files that are larger than the
         * original and cannot look any better than it — upscaling invents no
         * detail. This is the main reason processing took so long.
         *
         * The 32px tolerance keeps sources like 1072p or 704p on their
         * intended rung instead of demoting them. If the probe could not read
         * a height we keep the full ladder rather than guess.
         */
        if (probe.height) {
            const fits = resolutions.filter(
                (r) => parseInt(r.scale.split(":")[1], 10) <= probe.height + 32
            );

            if (fits.length > 0) {
                resolutions = fits;
            } else {
                /*
                 * The source is smaller than the configured target, so encode
                 * it at its own size rather than upscaling. Upscaling burns CPU
                 * to invent detail that is not there and produces a file larger
                 * than the original for no visible gain — and with a single
                 * rendition there is no taller rung that would justify it.
                 */
                const srcWidth = Math.round(((probe.width || probe.height * 16 / 9)) / 2) * 2;
                const srcHeight = Math.round(probe.height / 2) * 2;
                resolutions = [{
                    name: `${srcHeight}p`,
                    scale: `${srcWidth}:${srcHeight}`,
                    bitrate: resolutions[0].bitrate,
                }];
                console.log(`↧ source is ${probe.height}p — encoding at source size instead of upscaling`);
            }
        }

        /*
         * Remux the top rung instead of re-encoding it, when we can.
         *
         * HLS needs H.264 in MPEG-TS. A source that is already H.264 (with AAC
         * or no audio) at the ladder's top resolution therefore needs no
         * transcoding at all — only re-packaging into segments, which measured
         * ~30x faster because no pixels are decoded or encoded.
         *
         * It is moved to the front so the video becomes watchable in seconds
         * at full quality; the smaller rungs then encode behind it for
         * students on poor connections.
         */
        const topRung = resolutions[resolutions.length - 1];
        const canCopy =
            Boolean(topRung) &&
            probe.videoCodec === "h264" &&
            (!probe.hasAudio || probe.audioCodec === "aac") &&
            probe.height &&
            Math.abs(parseInt(topRung.scale.split(":")[1], 10) - probe.height) <= 32;

        if (canCopy) {
            resolutions = [
                { ...topRung, copy: true },
                ...resolutions.slice(0, resolutions.length - 1),
            ];
            console.log(`⚡ ${topRung.name} will be stream-copied (source is h264/${probe.audioCodec || 'no audio'})`);
        }

        console.log(
            `🎯 source ${probe.height ?? "?"}p → encoding ${resolutions.map(r => r.name).join(", ")}`
        );
        activeJobs.set(contentId, {
            title,
            startTime: Date.now(),
            resolutions: resolutions.map(r => r.name),
            status: "processing"
        });

        // Renditions finished so far, in ladder order.
        const completed = [];
        let isPublished = false;
        const masterR2Key = `${r2BasePath}/master.m3u8`;

        /**
         * Write a master playlist covering the renditions done so far and point
         * the content row at it, marking the video ready on the first call.
         *
         * Rewriting the master each time is cheap — it is a few hundred bytes —
         * and keeps the manifest honest about which renditions actually exist.
         * Advertising a rung whose segments are not uploaded yet would make the
         * player stall when it tried to switch up to it.
         */
        const publishMaster = async (done) => {
            let manifest = "#EXTM3U\n#EXT-X-VERSION:3\n";
            for (const res of done) {
                const bandwidth =
                    res.name === "1080p" ? "5000000" : res.name === "720p" ? "2800000" : "1200000";
                manifest += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${res.scale.replace(":", "x")}\n`;
                manifest += `${res.name}/index.m3u8\n`;
            }

            await r2Client.send(new PutObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: masterR2Key,
                Body: Buffer.from(manifest, "utf-8"),
                ContentType: "application/vnd.apple.mpegurl"
            }));

            await pool.query(`
                UPDATE content_items
                SET status = 'ready', r2_key = $1, duration_seconds = $2, metadata = $3, updated_at = NOW()
                WHERE id = $4::uuid
            `, [
                masterR2Key,
                actualDuration || duration,
                {
                    resolutions: done.map(r => r.name),
                    r2_base_path: r2BasePath,
                    // Only complete once every planned rung has landed, so the
                    // UI can tell "watchable" from "finished" if it wants to.
                    pending: done.length < resolutions.length,
                    completed_at: new Date().toISOString()
                },
                contentId
            ]);
        };

        for (const { name: resName, scale, bitrate, copy: streamCopy } of resolutions) {
            const qualityDir = path.join(outputDir, resName);
            if (!fs.existsSync(qualityDir)) fs.mkdirSync(qualityDir, { recursive: true });

            const segmentPattern = path.join(qualityDir, "segment_%03d.ts");
            const playlistPath = path.join(qualityDir, "index.m3u8");

            console.log(`\n🎬 ${streamCopy ? "Remuxing" : "Transcoding"} ${resName}...`);

            let lastLoggedFrame = 0;
            await new Promise((resolve, reject) => {
                let ffmpeg;
                try {
                    const encodeArgs = streamCopy
                        ? [
                              // No scaling, no codec work — just repackage.
                              // independent_segments lets a player start on
                              // any segment, which copy mode does not
                              // guarantee on its own.
                              "-i", inputPath,
                              "-c", "copy",
                              "-hls_flags", "independent_segments",
                          ]
                        : [
                              "-i", inputPath,
                              "-vf", `scale=${scale}`,
                              "-c:v", "libx264", "-preset", "veryfast",
                              "-b:v", bitrate, "-maxrate", bitrate,
                              "-bufsize", `${parseInt(bitrate) * 2}k`,
                              "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
                          ];

                    ffmpeg = spawn(FFMPEG_PATH, [
                        ...encodeArgs,
                        "-f", "hls",
                        "-hls_time", "10",
                        "-hls_list_size", "0",
                        "-hls_segment_type", "mpegts",
                        "-hls_segment_filename", segmentPattern,
                        playlistPath
                    ]);
                } catch (spawnErr) {
                    return reject(new Error(`ffmpeg failed to start: ${spawnErr.message}`));
                }

                ffmpeg.stderr.on("data", (data) => {
                    const text = data.toString();

                    const match = text.match(/frame=\s*(\d+)/);
                    if (match) {
                        const currentFrame = parseInt(match[1]);
                        if (currentFrame - lastLoggedFrame >= 500) {
                            console.log(`   🎬 ${resName}: frame ${currentFrame}`);
                            lastLoggedFrame = currentFrame;
                        }
                    }

                    /*
                     * Turn ffmpeg's progress line into a real percentage.
                     *
                     * `time=` is how far into the source this pass has reached,
                     * so dividing by the probed duration gives this rendition's
                     * share. Frames would need the frame rate to mean anything;
                     * time needs only the duration we already have.
                     */
                    const t = text.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                    if (t && actualDuration > 0) {
                        const secs = (+t[1]) * 3600 + (+t[2]) * 60 + parseFloat(t[3]);
                        const share = Math.min(secs / actualDuration, 1);
                        const overall = (completed.length + share) / resolutions.length;

                        const job = activeJobs.get(contentId);
                        if (job) {
                            job.stage = resName;
                            job.percent = Math.round(overall * 100);
                            job.renditionPercent = Math.round(share * 100);
                            job.renditionsDone = completed.length;
                            job.renditionsTotal = resolutions.length;
                        }
                    }
                });

                let stderrTail = "";
                ffmpeg.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });

                ffmpeg.on("close", (code) => {
                    if (code === 0) return resolve();
                    // Without this the failure read only "ffmpeg exited 1",
                    // which is why "check the server log" showed nothing useful.
                    const reason = stderrTail.trim().split("\n").slice(-6).join(" | ");
                    console.error(`\nffmpeg failed on ${resName} (exit ${code}):\n${stderrTail.trim()}\n`);
                    reject(new Error(`ffmpeg exited ${code} on ${resName}: ${reason || 'no output captured'}`));
                });
                // Without this handler, a missing ffmpeg binary crashes the whole process.
                ffmpeg.on("error", (err) => {
                    reject(new Error(`ffmpeg spawn error: ${err.message}. Is FFmpeg installed and on PATH?`));
                });
            });

            const allFiles = fs.readdirSync(qualityDir).sort();
            const segments = allFiles.filter(f => f.endsWith(".ts"));

            await runWithConcurrency(segments, UPLOAD_CONCURRENCY, async (seg) => {
                const filePath = path.join(qualityDir, seg);
                await putObjectWithRetry(
                    `${r2BasePath}/${resName}/${seg}`,
                    filePath,
                    "video/mp2t"
                );
                fs.unlinkSync(filePath);
            });
            console.log(`   ☁️  uploaded ${segments.length} ${resName} segments`);

            if (fs.existsSync(playlistPath)) {
                await putObjectWithRetry(
                    `${r2BasePath}/${resName}/index.m3u8`,
                    playlistPath,
                    "application/vnd.apple.mpegurl"
                );
            }

            /*
             * Publish after each rendition instead of only at the very end.
             *
             * The row stayed 'processing' — hidden from students, labelled
             * "Processing" for the educator — until every rung had finished.
             * With three renditions at roughly 3-4x realtime each, a 30 minute
             * lecture sat unwatchable for the better part of half an hour even
             * though the lowest quality was ready after the first third.
             *
             * The ladder runs lowest-first, so the first pass through here
             * publishes a playable 480p and flips the row to 'ready'. Each
             * later rung rewrites the master to add itself. A viewer who loads
             * mid-way simply sees fewer quality options.
             */
            completed.push({ name: resName, scale });
            await publishMaster(completed);

            if (!isPublished) {
                isPublished = true;
                console.log(`   ✅ ${resName} live — remaining renditions continue in background`);

                // Announce on the first rendition going live, not on each one.
                // The video is watchable from this moment, and later rungs only
                // add quality options — students do not need telling twice.
                await announceContentReady(contentId);
            }
        }

        activeJobs.delete(contentId);
        
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });

    } catch (err) {
        console.error(`❌ Transcoding failed:`, err.message);
        activeJobs.delete(contentId);

        /*
         * Only fail the row if nothing was published.
         *
         * Now that each rendition goes live as it finishes, a video can be
         * perfectly watchable at 480p when the 1080p pass dies. Marking it
         * 'failed' there would hide a working video from students and tell the
         * educator to re-upload something that is already fine — so a partial
         * failure leaves the row 'ready' and just records what went wrong.
         */
        const published = await pool.query(
            `SELECT status FROM content_items WHERE id = $1::uuid`,
            [contentId]
        );
        const alreadyLive = published.rows[0]?.status === 'ready';

        if (alreadyLive) {
            console.warn(`⚠️  Keeping ${contentId} live — some renditions completed before the failure.`);
            await pool.query(`
                UPDATE content_items
                SET metadata = metadata || $1::jsonb, updated_at = NOW()
                WHERE id = $2::uuid
            `, [JSON.stringify({
                partial_error: err.message,
                failed_at: new Date().toISOString()
            }), contentId]);
        } else {
            await pool.query(`
                UPDATE content_items
                SET status = 'failed', metadata = $1, updated_at = NOW()
                WHERE id = $2::uuid
            `, [{ error: err.message, failed_at: new Date().toISOString() }, contentId]);
        }

        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        const od = path.join(TEMP_VIDEO_DIR, `hls_${contentId}`);
        if (fs.existsSync(od)) fs.rmSync(od, { recursive: true, force: true });
    }
}

/**
 * Deal with videos left mid-transcode by a server restart.
 *
 * activeJobs is in-memory, so a restart forgets every running job while the
 * database row stays at 'processing'. Nothing then moves it: the row is hidden
 * from students, and the educator sees "Queued — starting shortly" forever
 * because the status endpoint truthfully reports that no job is running.
 *
 * The raw upload survives in temp_videos when the machine was not wiped, so
 * where the source is still on disk the transcode simply restarts. Where it is
 * gone the row is failed honestly, which at least tells the educator to
 * re-upload instead of leaving them watching a queue that will never move.
 */
export async function recoverInterruptedJobs() {
    try {
        const { rows } = await pool.query(`
            SELECT id, title, file_hash, file_name
              FROM content_items
             WHERE content_type = 'video'
               AND status = 'processing'
               AND is_active = true
        `);

        if (rows.length === 0) return;
        console.log(`\n🔄 ${rows.length} video(s) were left mid-processing by a restart`);

        for (const row of rows) {
            if (activeJobs.has(row.id)) continue; // already running in this process

            // The upload route renames the source to <hash><ext> before
            // transcoding, so that is where to look for it.
            const candidates = row.file_hash
                ? fs.readdirSync(TEMP_VIDEO_DIR).filter((f) => f.startsWith(row.file_hash))
                : [];

            if (candidates.length > 0) {
                const sourcePath = path.join(TEMP_VIDEO_DIR, candidates[0]);
                console.log(`   ▶ resuming ${row.title}`);
                transcodeVideo(row.id, sourcePath, row.file_hash, row.title, VIDEO_RENDITIONS, 0).catch((err) => console.error(`   resume failed for ${row.id}:`, err.message));
            } else {
                console.log(`   ✖ ${row.title} — source no longer on disk, marking failed`);
                await pool.query(`
                    UPDATE content_items
                    SET status = 'failed',
                        metadata = $1,
                        updated_at = NOW()
                    WHERE id = $2
                `, [{
                    error: "Processing was interrupted by a server restart and the uploaded file is no longer available. Please upload it again.",
                    failed_at: new Date().toISOString(),
                }, row.id]);
            }
        }
    } catch (err) {
        console.error("Could not recover interrupted jobs:", err.message);
    }
}

export default router;