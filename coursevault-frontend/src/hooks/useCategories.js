import { useCallback, useEffect, useState } from 'react';
import { fetchAPI } from '../services/api';
import { COURSE_CATEGORIES, mergeCategories, slugifyCategory } from '../constants/courseCategories';

/**
 * The category list, shared by every place a teacher picks one.
 *
 * Two components offer this choice — the course form and the badge on the
 * dashboard — and they must show the same options. A second copy of the fetch
 * would mean one of them silently missing a category the other had just
 * created.
 *
 * Starts from the five built-ins so a <select> is never momentarily empty,
 * then replaces them with the server's list, which includes anything the
 * school has added.
 */
export function useCategories() {
  const [categories, setCategories] = useState(COURSE_CATEGORIES);

  useEffect(() => {
    let cancelled = false;
    fetchAPI('/courses/categories')
      .then((res) => {
        if (!cancelled) setCategories(mergeCategories(res?.categories));
      })
      .catch((err) => {
        /*
         * Non-fatal on purpose. The built-ins are already on screen, so a
         * failure here costs the custom categories, not the feature. Throwing
         * would take down a course form over a list that is mostly cosmetic.
         */
        console.error('Could not load categories', err);
      });
    return () => { cancelled = true; };
  }, []);

  /*
   * Add one locally without waiting for a refetch.
   *
   * The server creates the row as a side effect of saving the course, so there
   * is nothing to call here. Adding it to the list immediately means the
   * teacher sees their new category selected rather than the dropdown
   * snapping back to "No category" because the id is not in the options yet.
   */
  const addLocal = useCallback((label) => {
    const id = slugifyCategory(label);
    if (!id) return null;
    setCategories((prev) =>
      prev.some((c) => c.id === id) ? prev : mergeCategories([...prev, { id, label: label.trim() }])
    );
    return id;
  }, []);

  /*
   * Move one category up or down and persist the whole order.
   *
   * The list is sent entire rather than a single "move" instruction, because
   * the server stores positions, not moves. Sending the final arrangement means
   * two teachers reordering at once end with one of the two orders rather than
   * an interleaving neither of them chose.
   */
  const move = useCallback(async (id, direction) => {
    /*
     * Computed from `categories` directly rather than inside a setState
     * updater. An updater that also assigns an outer variable is a side effect,
     * and React is free to call it twice in development — which would swap the
     * pair twice and leave the order unchanged while the request still went out.
     */
    const i = categories.findIndex((c) => c.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i === -1 || j < 0 || j >= categories.length) return;

    const next = [...categories];
    [next[i], next[j]] = [next[j], next[i]];
    setCategories(next);

    try {
      const res = await fetchAPI('/courses/categories/reorder', {
        method: 'PUT',
        body: JSON.stringify({ ids: next.map((c) => c.id) }),
      });
      // Adopt the server's answer: it is the one students will be served.
      if (res?.categories) setCategories(mergeCategories(res.categories));
    } catch (err) {
      // Put it back. Leaving the optimistic order on screen would show an
      // arrangement students are not getting.
      setCategories(categories);
      console.error('Could not reorder categories', err);
    }
  }, [categories]);

  /**
   * Delete a custom category, untagging whatever used it.
   *
   * Not optimistic, unlike `move`. Reordering is trivially reversible if the
   * request fails; this untags courses, so showing it as done before the server
   * agrees would misreport something the teacher cannot easily undo.
   *
   * @returns {Promise<{ok: true, untagged: number} | {ok: false, error: string}>}
   */
  const remove = useCallback(async (id) => {
    try {
      const res = await fetchAPI(`/courses/categories/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res?.categories) setCategories(mergeCategories(res.categories));
      return { ok: true, untagged: res?.untagged ?? 0 };
    } catch (err) {
      console.error('Could not delete category', err);
      return { ok: false, error: err.message || 'Could not delete that category.' };
    }
  }, []);

  return { categories, addLocal, move, remove };
}
