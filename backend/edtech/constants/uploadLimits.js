/**
 * Upload size limits, in one place.
 *
 * The number was written out as `3 * 1024 * 1024 * 1024` in four separate
 * files, one of which carried the comment "matches the backend's videoUpload
 * limit" — a promise rather than a mechanism. Raising the ceiling meant finding
 * all four, and missing one would have produced the worst possible result: the
 * browser accepting a 7GB file and the server rejecting it after the teacher
 * had waited out the whole upload.
 *
 * The frontend cannot import from here (separate build), so
 * coursevault-frontend/src/constants/uploadLimits.js holds the same numbers and
 * check_upload_limit.mjs asserts the two agree. That turns the old comment into
 * something that fails loudly instead of silently drifting.
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/**
 * The largest video a teacher may upload.
 *
 * Raised from 3GB to 7GB. Note what that costs on the chunked path: the parts
 * land on the server's disk and are then joined into one file, so a single
 * upload can occupy twice its own size in temporary space at the moment of
 * assembly — about 14GB at the new ceiling, per concurrent upload. The limit is
 * enforceable; the disk behind it is the operator's problem to size.
 */
export const MAX_VIDEO_BYTES = 7 * GB;

/** PDFs and images, which are still buffered in memory and must stay small. */
export const MAX_FILE_BYTES = 50 * MB;

/**
 * One chunk of a chunked upload, as multer will accept it.
 *
 * The client sends 8MB; this is deliberately looser so a client that picks a
 * larger chunk is not rejected mid-upload. It is a per-request bound and has
 * nothing to do with the total, which is checked separately — that distinction
 * is exactly what was missing before.
 */
export const MAX_CHUNK_BYTES = 32 * MB;

/** Part size for the direct-to-R2 multipart path. */
export const MULTIPART_PART_SIZE = 64 * MB;

/** S3 and R2 both refuse more than this many parts in one multipart upload. */
export const MULTIPART_MAX_PARTS = 10000;

/**
 * How long the presigned part URLs stay valid.
 *
 * Twelve hours, up from six. The old window was sized for 3GB; 7GB over a
 * 2 Mbps rural link is roughly eight hours, so six would have expired
 * mid-upload and failed the parts that had not started yet — after hours of
 * apparently fine progress. SigV4 permits up to seven days, so there is room.
 */
export const MULTIPART_URL_TTL_SECONDS = 12 * 60 * 60;

/** For error messages: "7GB" rather than "7516192768 bytes". */
export function describeLimit(bytes = MAX_VIDEO_BYTES) {
    return `${Number((bytes / GB).toFixed(1))}GB`;
}
