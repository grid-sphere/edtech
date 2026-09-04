/**
 * Upload size limits, mirroring the server.
 *
 * These must equal the values in backend/edtech/constants/uploadLimits.js. The
 * frontend is a separate build and cannot import across, so the two are kept in
 * step by check_upload_limit.mjs, which reads both files and fails if they
 * disagree.
 *
 * Getting this wrong is worse than it sounds in either direction. Too high in
 * the browser and the teacher waits out a full upload before the server refuses
 * it. Too low and a file the server would happily take is rejected instantly,
 * with the UI insisting the limit is something it is not.
 *
 * The browser check is a courtesy, not a control: it saves someone a wasted
 * hour, and it is trivially bypassed. The server enforces the real limit when
 * the chunks are assembled.
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** Largest video a teacher may upload. Mirrors MAX_VIDEO_BYTES on the server. */
export const MAX_VIDEO_BYTES = 7 * GB;

/** Largest PDF or image. Mirrors MAX_FILE_BYTES on the server. */
export const MAX_FILE_BYTES = 50 * MB;

/**
 * Above this, upload in chunks rather than as one POST.
 *
 * Unrelated to the ceiling: it is the point where a single request stops being
 * worth the risk of losing everything to one dropped connection.
 */
export const CHUNKED_THRESHOLD = 50 * MB;
