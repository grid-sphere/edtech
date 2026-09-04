/**
 * Staff: anyone who runs the school rather than studies at it.
 *
 * An admin is an educator with more, not a different kind of user. The backend
 * already assumed that — every route guard reads
 * `role !== 'educator' && role !== 'admin'` — but the frontend compared against
 * 'educator' alone in five places, so promoting somebody to admin silently took
 * away their Publish, Edit, Add Module, Students and Announce buttons on every
 * course page. Nothing errored; the controls were simply not rendered.
 *
 * That made "make yourself an admin" a trap, which is exactly what the gallery
 * feature needed people to do.
 */
export const isStaff = (user) => user?.role === 'educator' || user?.role === 'admin';
