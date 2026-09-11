// Detect the backend base URL dynamically
const getBaseUrl = () => {
  if (window.location.hostname === 'localhost') {
    return import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
  }
  return window.location.origin + '/api';
};

const BASE_URL = getBaseUrl();

/**
 * Exported so components building their own fetch calls (image uploads, which
 * need multipart bodies) resolve the API the same way fetchAPI does.
 * Reading import.meta.env.VITE_API_URL directly is a trap: it is undefined in
 * local dev, producing a request to the literal URL "undefined/content/...".
 */
export { BASE_URL };

/**
 * The backend origin, for URLs that are not under /api — video streams and
 * file downloads that the browser fetches directly.
 *
 * Derived from BASE_URL rather than resolved separately. Three components used
 * to build this themselves as
 *
 *     import.meta.env.VITE_API_URL ? ... : 'http://localhost:3000'
 *
 * and there is no VITE_API_URL in this project, so every one of them pointed at
 * localhost:3000 on every device. On the developer's laptop that is the backend
 * and everything worked; on a phone it is the phone, so video and PDF hung for
 * ever on their loading screens while the rest of the app — which goes through
 * BASE_URL — was fine. A bug that only appears on the devices students use is
 * the worst kind to leave to a hardcoded fallback.
 */
export const MEDIA_ORIGIN = BASE_URL.replace(/\/api\/?$/, '');

/**
 * Turn an API-relative media path into one the browser can actually load.
 *
 * The upload endpoints return relative URLs like
 *   /api/content/stream-image?key=images/thumbnails/abc.jpg
 * which are correct in production, where nginx serves the app and the API from
 * the same origin. In local dev the app is on :5173 and the API on :3000, so a
 * relative path in an <img src> resolves against Vite and 404s — the thumbnail
 * silently never appears.
 *
 * Absolute URLs and data: URIs are passed through untouched.
 */
export const resolveMediaUrl = (url) => {
  if (!url) return url;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;

  // BASE_URL ends in /api; strip it so a path already starting with /api
  // doesn't become /api/api/...
  const origin = BASE_URL.replace(/\/api\/?$/, '');
  return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
};

// Appends moduleId directly to FormData body instead of URL Query Params
export const uploadVideoWithProgress = (
  moduleId,
  file,
  title,
  description,
  onProgress,
  options = {}
) => {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const token = localStorage.getItem('token');
    const formData = new FormData();

    // Backend's videoUpload multer config is `videoUpload.single("file")`
    // — it only reads a field literally named "file".
    formData.append('file', file);
    formData.append('moduleId', moduleId);
    formData.append('title', title || '');
    formData.append('description', description || '');

    // Without these, the "free preview" checkbox and the tab a video was added
    // from were silently dropped for videos but honoured for PDFs.
    formData.append('preview', options.preview ? 'true' : 'false');
    if (options.folderId) formData.append('folder_id', options.folderId);

    // Track real-time uploading logs
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        const percentComplete = Math.round((event.loaded / event.total) * 100);
        if (onProgress) onProgress(percentComplete);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (_) {
          resolve(xhr.responseText);
        }
      } else {
        try {
          const errData = JSON.parse(xhr.responseText);
          reject(new Error(errData.error || `Upload failed with status: ${xhr.status}`));
        } catch (_) {
          reject(new Error(`Upload failed with status: ${xhr.status}`));
        }
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network upload error occurred.')));

    // Cleaned endpoint path without trailing query parameter pollution
    xhr.open('POST', `${BASE_URL}/content/upload-video`);
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }
    xhr.send(formData);
  });
};

// Existing fetchAPI Utility
/**
 * @param {object} [options]
 * @param {boolean} [options.redirectOn401=true]
 *   A 401 normally means the session died, and bouncing to the sign-in page is
 *   the right answer. It is the wrong answer for a background request that is
 *   not on the user's behalf — a decorative one that simply has nothing to say
 *   when signed out. Such a request must be able to fail quietly, or it turns
 *   "no session" into a navigation, and if it runs on mount it turns that into
 *   a reload loop.
 */
export const fetchAPI = async (endpoint, options = {}) => {
  const { redirectOn401 = true, ...rest } = options;
  options = rest;

  const token = localStorage.getItem('token');
  const headers = { ...options.headers };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers });
    const contentType = response.headers.get("content-type");
    const data = contentType?.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      if (response.status === 401 && redirectOn401) {
        localStorage.removeItem('token');
        /*
         * A hard navigation, not a router push — it must clear all in-memory
         * state. Guarded so a page that is already here does not reload
         * itself: /login makes the same unauthenticated calls, so without the
         * guard one failing background request reloads the page forever.
         */
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
      }

      // Express answers an unmatched route with an HTML error page. Passing
      // that straight to Error() put a full <!DOCTYPE html> document inside an
      // alert() box, burying the one useful line ("Cannot PUT /api/...").
      if (typeof data === 'string' && /<!DOCTYPE|<html/i.test(data)) {
        const cannot = data.match(/Cannot (GET|POST|PUT|DELETE|PATCH) ([^\s<]+)/i);
        throw new Error(
          cannot
            ? `${cannot[1]} ${cannot[2]} — no such endpoint (${response.status}). ` +
              `If this route was just added, restart the backend.`
            : `Request failed (${response.status}).`
        );
      }

      throw new Error(data?.error || (typeof data === 'string' ? data : null) || `Request failed (${response.status})`);
    }

    return data;
  } catch (error) {
    console.error(`API Fetch Error [${endpoint}]:`, error);
    throw error;
  }
};

/* ============================================================
 * Notifications
 * ============================================================ */

export const notificationsAPI = {
  list: () => fetchAPI('/notifications'),

  /*
   * Polled on a timer, so failures are swallowed and reported as zero.
   *
   * A rejected promise here would surface as an unhandled rejection every
   * minute, and a badge that briefly shows nothing is a far smaller problem
   * than a console full of noise or an error toast on a background poll.
   */
  unreadCount: () =>
    fetchAPI('/notifications/unread-count').catch(() => ({ unread: 0 })),

  markRead: (id) => fetchAPI(`/notifications/${id}/read`, { method: 'POST' }),

  markAllRead: () => fetchAPI('/notifications/read-all', { method: 'POST' }),

  remove: (id) => fetchAPI(`/notifications/${id}`, { method: 'DELETE' }),

  announce: (courseId, title, body) =>
    fetchAPI('/notifications/announce', {
      method: 'POST',
      body: JSON.stringify({ courseId, title, body }),
    }),
};

/* ============================================================
 * Support tickets
 * ============================================================ */

export const supportAPI = {
  listTickets: () => fetchAPI('/support/tickets'),

  getTicket: (id) => fetchAPI(`/support/tickets/${id}`),

  createTicket: ({ subject, message, category, courseId }) =>
    fetchAPI('/support/tickets', {
      method: 'POST',
      body: JSON.stringify({ subject, message, category, courseId }),
    }),

  reply: (id, body) =>
    fetchAPI(`/support/tickets/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),

  setStatus: (id, status) =>
    fetchAPI(`/support/tickets/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
};