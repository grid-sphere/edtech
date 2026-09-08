import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, GraduationCap, ChevronRight, Layers, Trash2, Pencil, ChevronUp, ChevronDown, Search, X, ArrowUpDown } from 'lucide-react';
import CourseCard from '../components/course/CourseCard.jsx';
import { compareCourses } from '../utils/courseOrder.js';
import Button from '../components/ui/Button.jsx';
import CourseModal from '../components/educator/CourseModal.jsx';
import { fetchAPI } from '../services/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCategories } from '../hooks/useCategories.js';

/**
 * The category badge on a course row, changeable in place.
 *
 * Category was already editable — but only inside the Edit modal, four clicks
 * and a form away, and the dashboard never showed the current value. A teacher
 * could not tell which chip a class sat under without opening it, which made
 * the tag feel like it had not saved.
 *
 * A native <select> rather than a custom menu: it is one tap on a phone, gets
 * the platform picker for free, and cannot be scrolled out of a container.
 */
const NEW_CATEGORY = '__new__';

function CategorySelect({ course, onChanged, categories, addLocal }) {
  const [value, setValue] = useState(course.category || '');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // Non-null while the teacher is typing a new category name.
  const [draft, setDraft] = useState(null);

  const change = async (next, label = null) => {
    if (next === NEW_CATEGORY) {
      // Not a value — a request for the text box. Nothing is saved until the
      // name is submitted, so the badge keeps showing the current category.
      setDraft('');
      return;
    }
    const previous = value;
    /*
     * Optimistic, with an explicit revert.
     *
     * The select is the only thing showing this value, so leaving it on the
     * old category until the request returns reads as the tap not registering
     * and invites a second tap. On failure it goes back and says so, rather
     * than silently displaying a category the server never accepted.
     */
    setValue(next);
    setSaving(true);
    setFailed(false);
    try {
      await fetchAPI(`/courses/${course.id}`, {
        method: 'PUT',
        // Only the category. Sending the whole course would let a stale copy
        // of the row overwrite a title someone edited in another tab.
        body: JSON.stringify(
          label ? { category_label: label } : { category: next || null }
        ),
      });
      onChanged?.(course.id, next || null);
    } catch (err) {
      setValue(previous);
      setFailed(true);
      console.error('Could not change category', err);
    } finally {
      setSaving(false);
    }
  };

  /*
   * Submitting the typed name is what saves it — not blurring, and not the
   * dropdown. The teacher must be able to change their mind mid-word without
   * having created a category they did not want.
   */
  const submitDraft = async () => {
    const label = (draft || '').trim();
    if (!label) { setDraft(null); return; }
    const id = addLocal?.(label);
    setDraft(null);
    if (id) await change(id, label);
  };

  if (draft !== null) {
    return (
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submitDraft(); }}
        className="inline-flex items-center gap-1"
      >
        <input
          autoFocus
          value={draft}
          maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          // Escape backs out without saving. A text box with no visible cancel
          // is a trap on a keyboard.
          onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); }}
          placeholder="New category"
          aria-label={`New category for ${course.title}`}
          className="text-[10px] font-bold uppercase tracking-wider border-2 border-black rounded-full px-2 py-0.5 w-28 bg-white focus:outline-none"
        />
        <button
          type="submit"
          className="text-[10px] font-bold uppercase border-2 border-black rounded-full px-2 py-0.5 bg-[#A7E2D1]"
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => setDraft(null)}
          className="text-[10px] font-bold uppercase text-gray-500 px-1"
        >
          Cancel
        </button>
      </form>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <select
        value={value}
        disabled={saving}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => change(e.target.value)}
        aria-label={`Category for ${course.title}`}
        title={failed ? 'Could not save — try again' : 'Which student chip this appears under'}
        className={`text-[10px] font-bold uppercase tracking-wider border-2 rounded-full pl-2 pr-1 py-0.5 cursor-pointer transition-colors disabled:opacity-50 ${
          failed
            ? 'border-red-500 bg-red-50 text-red-700'
            : value
              ? 'border-black bg-[#A7E2D1]'
              : 'border-dashed border-black/40 bg-white text-gray-500'
        }`}
      >
        <option value="">No category</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>{c.label}</option>
        ))}
        <option value={NEW_CATEGORY}>+ New category…</option>
      </select>
    </span>
  );
}

export default function EducatorDashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [courses, setCourses] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dashQuery, setDashQuery] = useState('');
  const [isCourseModalOpen, setIsCourseModalOpen] = useState(false);

  // When null -> the modal creates a brand-new top-level course (same as
  // the "Create New Course" button). When set to a course id -> the modal
  // creates a course linked to that course as its parent (row's "+ Add
  // Course" button).
  const [modalParentId, setModalParentId] = useState(null);

  // When set to a course object -> the modal edits that course (title,
  // description, price, status) instead of creating a new one.
  const [editingCourse, setEditingCourse] = useState(null);

  // Tracks which single top-level course row is currently expanded.
  // null = nothing expanded.
  const [selectedCourseId, setSelectedCourseId] = useState(null);

  /*
   * Patch the row in place rather than refetching the whole dashboard.
   *
   * A reload would collapse whichever class the teacher had expanded, which is
   * a strange thing to happen after changing a dropdown.
   */
  /*
   * Fetched once here rather than inside each badge. A dashboard with twenty
   * classes would otherwise make twenty identical requests, and a category
   * created on one row would not appear in the others' dropdowns.
   */
  const { categories, addLocal, move, remove } = useCategories();
  const [tagError, setTagError] = useState('');

  /*
   * Confirmation names the cost, in courses.
   *
   * "Are you sure?" is a question nobody can answer usefully. "3 classes will
   * lose this tag" is the fact that decides it — and the count comes from the
   * server with the list, so it is not a guess made in the browser.
   */
  const deleteTag = async (c) => {
    const n = c.course_count ?? 0;
    /*
     * `course_count` used to arrive undefined here, because mergeCategories
     * rebuilt each category as { id, label } and dropped it. Every
     * confirmation therefore read "No classes are using it" — including for
     * tags with classes in them. The count is real now; the ?? 0 is a
     * genuine fallback rather than the usual case.
     */
    const consequence = n === 0
      ? 'No classes are using it.'
      : `${n} class${n === 1 ? '' : 'es'} will become uncategorised. `
        + `The class${n === 1 ? '' : 'es'} stay — you can give ${n === 1 ? 'it' : 'them'} another tag afterwards.`;
    if (!window.confirm(`Delete the "${c.label}" tag?\n\n${consequence}\n\nThis cannot be undone.`)) return;

    setTagError('');
    const res = await remove(c.id);
    if (!res.ok) setTagError(res.error);
  };

  const applyCategory = (courseId, category) =>
    setCourses((prev) => prev.map((c) => (c.id === courseId ? { ...c, category } : c)));

  const loadMyCourses = () => {
    setIsLoading(true);
    fetchAPI('/courses')
      .then(data => {
        // Show courses created by this user
        const myCourses = (data.courses || []).filter(c => c.educator_id === user?.id || c.isCreator);
        setCourses(myCourses);
        setIsLoading(false);
      })
      .catch(err => {
        console.error("Dashboard error", err);
        setIsLoading(false);
      });
  };

  useEffect(() => {
    loadMyCourses();
  }, []);

  const handleDeleteCourse = async (courseId) => {
    if (!window.confirm("Are you sure you want to delete this class category? All subjects inside it will also be hidden.")) return;
    try {
      await fetchAPI(`/courses/${courseId}`, { method: 'DELETE' });
      // Instantly remove it from the UI
      setCourses(prev => prev.filter(c => c.id !== courseId && c.parent_course_id !== courseId));
      if (selectedCourseId === courseId) setSelectedCourseId(null);
    } catch (err) {
      alert(err.message || 'Failed to delete course');
    }
  };

  // Only courses with no parent are shown as their own row on the
  // dashboard. Sub-courses (created via a row's "+ Add Course") stay
  // nested under their parent and are rendered only when that parent
  // is expanded.
  const topLevelCourses = courses.filter(c => !c.parent_course_id);

  // Dynamically looks up every course linked to a given parent id.
  // No hardcoded names/ids -- purely relationship-driven.
  const getChildCourses = (parentId) =>
    courses.filter(c => c.parent_course_id === parentId);

  // If the currently selected top-level course disappears (deleted /
  // list refreshed and no longer contains it), clear the selection so we
  // never render a stale/ghost card.
  useEffect(() => {
    if (selectedCourseId && !topLevelCourses.some(c => c.id === selectedCourseId)) {
      setSelectedCourseId(null);
    }
  }, [courses, selectedCourseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const publishedCount = topLevelCourses.filter(c => c.status === 'published').length;

  // Toggle behaviour: clicking "View" on the already-open course closes it,
  // clicking a different course's "View" switches to that one instead.
  const handleToggleView = (courseId) => {
    setSelectedCourseId(prev => (prev === courseId ? null : courseId));
  };

  const openCreateModal = () => {
    setModalParentId(null);
    setEditingCourse(null);
    setIsCourseModalOpen(true);
  };

  const openAddModal = (parentId) => {
    setModalParentId(parentId);
    setEditingCourse(null);
    setIsCourseModalOpen(true);
  };

  const openEditModal = (course) => {
    setEditingCourse(course);
    setModalParentId(null);
    setIsCourseModalOpen(true);
  };

  const closeModal = () => {
    setIsCourseModalOpen(false);
    setModalParentId(null);
    setEditingCourse(null);
  };

  /*
   * The comparator lives in utils/courseOrder.js now.
   *
   * It was defined here and nowhere else, so Explore invented its own rule and
   * the students' class view disagreed with this screen — the arrangement made
   * with these arrows was visible only on this page. Sharing it means the
   * dashboard, Explore and the server all sort by the same three keys.
   */
  const sortedCourses = [...topLevelCourses].sort(compareCourses);

  const query = dashQuery.trim().toLowerCase();

  /*
   * A class stays in the list when it matches, and also when one of its own
   * subjects matches — hiding the parent would make a matching subject
   * unreachable, since subjects are only shown after expanding their class.
   */
  const visibleCourses = React.useMemo(() => {
    if (!query) return sortedCourses;

    const matches = (c) =>
      `${c.title || ''} ${c.description || ''}`.toLowerCase().includes(query);

    return sortedCourses.filter(
      (course) => matches(course) || getChildCourses(course.id).some(matches)
    );
  }, [sortedCourses, query, courses]);

  const selectedCourse = topLevelCourses.find(c => c.id === selectedCourseId) || null;
  const selectedChildCourses = selectedCourse
    ? getChildCourses(selectedCourse.id).sort(compareCourses)
    : [];

  // Sends the new order for one sibling group (either the top-level rows,
  // or the child/subject courses under a single parent) to the backend,
  // then reloads so the UI reflects the confirmed, saved state.
  const persistOrder = (orderedIds) => {
    fetchAPI('/courses/reorder', {
      method: 'PUT',
      body: JSON.stringify({ orderedIds })
    })
      .then(() => loadMyCourses())
      .catch(err => {
        console.error('Failed to save order', err);
        alert('Could not save the new order. Please try again.');
        loadMyCourses();
      });
  };

  // Moves a top-level course up or down among the other top-level rows.
  const moveTopLevelCourse = (courseId, direction) => {
    const list = [...sortedCourses];
    const idx = list.findIndex(c => c.id === courseId);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (idx === -1 || swapIdx < 0 || swapIdx >= list.length) return;

    [list[idx], list[swapIdx]] = [list[swapIdx], list[idx]];
    persistOrder(list.map(c => c.id));
  };

  // Moves a child/subject course up or down only among its siblings under
  // the same parent -- never mixed with any other course's children.
  const moveChildCourse = (childId, direction, parentId) => {
    const list = [...getChildCourses(parentId)].sort(compareCourses);
    const idx = list.findIndex(c => c.id === childId);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (idx === -1 || swapIdx < 0 || swapIdx >= list.length) return;

    [list[idx], list[swapIdx]] = [list[swapIdx], list[idx]];
    persistOrder(list.map(c => c.id));
  };

  return (
    <div className="pb-20 animate-in fade-in slide-in-from-bottom-5 duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight mb-1 flex items-center gap-3">
            <GraduationCap size={40} className="text-[#F26B4D]" /> Educator Console
          </h1>
          <p className="text-gray-600 font-bold">Manage your curriculum and track student engagement.</p>
        </div>
        <Button variant="accent" onClick={openCreateModal} className="py-3 px-8 text-base border-[3px]">
          <Plus size={20} className="mr-2 inline" /> Create New Course
        </Button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
        <div className="bg-[#87CEFA] border-[3px] border-black rounded-2xl p-6 shadow-[8px_8px_0px_0px_#111]">
          <div className="text-5xl font-black mb-1">{topLevelCourses.length}</div>
          <div className="font-bold text-black uppercase text-sm tracking-widest">Total Courses</div>
        </div>
        <div className="bg-[#F9E076] border-[3px] border-black rounded-2xl p-6 shadow-[8px_8px_0px_0px_#111]">
          <div className="text-5xl font-black mb-1">{publishedCount}</div>
          <div className="font-bold text-black uppercase text-sm tracking-widest">Live Courses</div>
        </div>
      </div>


      {/* --------------------------------------------------- category ordering

          Collapsed by default. This is a setting, not a daily task, and an
          always-open panel of arrows would sit between the teacher and the
          courses they actually came to edit.                                */}
      <details className="mb-8 border-[3px] border-black rounded-2xl bg-white shadow-[6px_6px_0px_0px_#111] overflow-hidden">
        <summary className="cursor-pointer select-none px-5 py-3 font-black uppercase text-sm tracking-wider flex items-center gap-2">
          <ArrowUpDown size={16} strokeWidth={3} />
          Tag order
          <span className="font-medium normal-case tracking-normal text-xs text-gray-500">
            — the order students see the filter chips in
          </span>
        </summary>

        <div className="px-5 pb-5 pt-1">
          <ul className="flex flex-col gap-2 max-w-md list-none m-0 p-0">
            {categories.map((c, i) => (
              <li
                key={c.id}
                className="flex items-center gap-2 border-2 border-black rounded-xl px-3 py-2 bg-[#FDF1E9]"
              >
                <span className="w-6 shrink-0 text-xs font-black tabular-nums text-gray-500">{i + 1}</span>
                <span className="flex-1 min-w-0 truncate font-bold text-sm">{c.label}</span>
                {/*
                  Disabled at the ends rather than hidden, so the row does not
                  change width as a tag moves and the buttons stay where the
                  reader's finger already is.
                */}
                <button
                  type="button"
                  onClick={() => move(c.id, 'up')}
                  disabled={i === 0}
                  aria-label={`Move ${c.label} earlier`}
                  className="w-7 h-7 shrink-0 border-2 border-black rounded flex items-center justify-center bg-white hover:bg-gray-100 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronUp size={14} strokeWidth={3} />
                </button>
                <button
                  type="button"
                  onClick={() => move(c.id, 'down')}
                  disabled={i === categories.length - 1}
                  aria-label={`Move ${c.label} later`}
                  className="w-7 h-7 shrink-0 border-2 border-black rounded flex items-center justify-center bg-white hover:bg-gray-100 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronDown size={14} strokeWidth={3} />
                </button>
                {/*
                  Every tag can go, including the five that ship with the app.
                  They are a starting point for a new school, not a fixture.
                */}
                <button
                  type="button"
                  onClick={() => deleteTag(c)}
                  aria-label={`Delete ${c.label}`}
                  title={`Delete ${c.label}`}
                  className="w-7 h-7 shrink-0 border-2 border-black rounded flex items-center justify-center bg-white text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 size={13} strokeWidth={3} />
                </button>
              </li>
            ))}
          </ul>
          {tagError && (
            <p className="text-xs font-bold text-red-700 border-2 border-red-500 bg-red-50 rounded-xl px-3 py-2 mt-3 max-w-md">
              {tagError}
            </p>
          )}
          <p className="text-xs font-medium text-gray-500 mt-3">
            Saved as you go. Students see this order on their home screen; "All"
            always stays first. Deleting a tag removes it from any class using
            it — the classes themselves are not touched.
          </p>
        </div>
      </details>

      <h2 className="text-3xl font-bold mb-4 tracking-tight">Your Courses</h2>

      <div className="relative mb-6 max-w-md">
        <Search size={18} strokeWidth={2.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
        <input
          type="search"
          value={dashQuery}
          onChange={(e) => setDashQuery(e.target.value)}
          placeholder="Search your classes and subjects..."
          aria-label="Search your classes and subjects"
          className="w-full h-11 pl-10 pr-10 border-2 border-black rounded-xl bg-white font-medium shadow-[3px_3px_0px_0px_#111] focus:outline-none focus:ring-2 focus:ring-[#F26B4D]"
        />
        {/* The browser's own clear button is suppressed in globals.css, so this
            box needs its own — matching the one on Explore. */}
        {dashQuery && (
          <button
            type="button"
            onClick={() => setDashQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-full border-2 border-black bg-white hover:bg-[#F26B4D] hover:text-white transition-colors"
          >
            <X size={13} strokeWidth={3} />
          </button>
        )}
      </div>

      {query && (
        <p className="text-sm font-bold text-gray-600 mb-4">
          {visibleCourses.length === 0
            ? 'No classes match that.'
            : `${visibleCourses.length} of ${sortedCourses.length} classes shown — reordering is paused while searching.`}
        </p>
      )}

      {isLoading ? (
        <div className="text-center font-bold text-gray-400 py-20">Loading Dashboard...</div>
      ) : topLevelCourses.length === 0 ? (
        <div className="bg-white border-[3px] border-black border-dashed rounded-3xl p-16 text-center">
          <p className="text-gray-500 font-bold text-xl mb-6">No courses found in your library.</p>
          <Button variant="primary" onClick={openCreateModal}>Get Started</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {visibleCourses.map((course, courseIndex) => {
            const isSelected = course.id === selectedCourseId;
            const childCount = getChildCourses(course.id).length;

            return (
              <div key={course.id} className="w-full">
                {/* Row: arrange arrows + name + Edit + Add Course + View + Delete */}
                {/* Stacks on mobile: the action group is ~300px wide, so on a
                    phone `justify-between` gave it everything and squeezed the
                    title to zero width, hiding it behind the buttons. */}
                <div
                  className={`flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-white border-[3px] border-black rounded-2xl px-4 py-3 md:px-6 md:py-4 shadow-[4px_4px_0px_0px_#111] md:shadow-[6px_6px_0px_0px_#111] transition-all
                    ${isSelected ? 'ring-2 ring-[#F26B4D]' : ''}`}
                >
                  <div className="flex items-center gap-3 md:gap-4 min-w-0">
                    {/* Arrange (priority) controls */}
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() => moveTopLevelCourse(course.id, 'up')}
                        disabled={courseIndex === 0 || !!query}
                        title="Move up"
                        className="w-6 h-6 border-2 border-black rounded flex items-center justify-center bg-white hover:bg-gray-100 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronUp size={14} strokeWidth={3} />
                      </button>
                      <button
                        onClick={() => moveTopLevelCourse(course.id, 'down')}
                        disabled={courseIndex === visibleCourses.length - 1 || !!query}
                        title="Move down"
                        className="w-6 h-6 border-2 border-black rounded flex items-center justify-center bg-white hover:bg-gray-100 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronDown size={14} strokeWidth={3} />
                      </button>
                    </div>

                    {/* Title on its own line with the badges wrapping under it,
                        so a long course name truncates instead of pushing the
                        status pills off the card. */}
                    <div className="min-w-0 flex-1">
                      <div className="font-black text-base md:text-lg truncate">{course.title}</div>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider bg-black text-white px-2 py-0.5 rounded-full">
                          {course.status || 'draft'}
                        </span>
                        {/* Beside the status pill: both answer "where does
                            this show up for students right now". */}
                        <CategorySelect course={course} onChanged={applyCategory} categories={categories} addLocal={addLocal} />
                        {childCount > 0 && (
                          <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider bg-[#A7E2D1] border border-black px-2 py-0.5 rounded-full">
                            <Layers size={10} /> {childCount} added
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center flex-wrap gap-2 md:gap-3 md:shrink-0">
                    <button
                      onClick={() => openEditModal(course)}
                      className="flex items-center gap-1 font-bold text-sm border-2 border-black rounded-full px-3 py-1.5 bg-[#87CEFA] hover:bg-[#6cc0f5] transition-colors shadow-[2px_2px_0px_0px_#111]"
                    >
                      <Pencil size={14} strokeWidth={3} /> Edit
                    </button>
                    <button
                      onClick={() => openAddModal(course.id)}
                      className="flex items-center gap-1 font-bold text-sm border-2 border-black rounded-full px-3 py-1.5 bg-[#F9E076] hover:bg-[#f5d84a] transition-colors shadow-[2px_2px_0px_0px_#111]"
                    >
                      <Plus size={16} strokeWidth={3} /> Add<span className="hidden sm:inline">&nbsp;Course</span>
                    </button>
                    <button
                      onClick={() => handleToggleView(course.id)}
                      className="flex items-center gap-1 font-bold underline decoration-2 underline-offset-4 hover:text-[#F26B4D] transition-colors"
                    >
                      {isSelected ? 'Hide' : 'View'}
                      <ChevronRight
                        size={18}
                        className={`transition-transform ${isSelected ? 'rotate-90' : ''}`}
                      />
                    </button>

                    {/* Delete Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteCourse(course.id);
                      }}
                      className="w-9 h-9 shrink-0 flex items-center justify-center bg-red-400 border-[3px] border-black rounded-xl hover:bg-red-500 hover:-translate-y-1 transition-all shadow-[3px_3px_0px_0px_#111] md:shadow-[4px_4px_0px_0px_#111] ml-auto md:ml-2"
                      title="Delete Class Category"
                    >
                      <Trash2 size={16} strokeWidth={3} />
                    </button>
                  </div>
                </div>

                {/* Only render the child courses (subjects) belonging to this parent */}
                {isSelected && selectedCourse && (
                  <div className="mt-6 mb-2 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-8 gap-y-16 items-start">
                    {selectedChildCourses.length === 0 ? (
                      <p className="text-gray-500 font-bold italic col-span-full pt-4">No subjects added to this class yet.</p>
                    ) : (
                      selectedChildCourses.map((child, i) => (
                        <div key={child.id} className="flex flex-col gap-3">
                          {/* Arrange + Edit controls for this subject */}
                          <div className="flex items-center justify-between px-1">
                            <div className="flex gap-1">
                              <button
                                onClick={() => moveChildCourse(child.id, 'up', selectedCourse.id)}
                                disabled={i === 0}
                                title="Move up"
                                className="w-6 h-6 border-2 border-black rounded flex items-center justify-center bg-white hover:bg-gray-100 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                              >
                                <ChevronUp size={14} strokeWidth={3} />
                              </button>
                              <button
                                onClick={() => moveChildCourse(child.id, 'down', selectedCourse.id)}
                                disabled={i === selectedChildCourses.length - 1}
                                title="Move down"
                                className="w-6 h-6 border-2 border-black rounded flex items-center justify-center bg-white hover:bg-gray-100 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                              >
                                <ChevronDown size={14} strokeWidth={3} />
                              </button>
                            </div>
                            <div className="flex items-center gap-2">
                              {/*
                                Subjects get the control too. A class now
                                appears under a chip if the class OR any of its
                                subjects carries that category, so tagging a
                                subject is a real action with a visible effect
                                — it needs to be visible and changeable here.
                              */}
                              <CategorySelect course={child} onChanged={applyCategory} categories={categories} addLocal={addLocal} />
                              <button
                                onClick={() => openEditModal(child)}
                                className="flex items-center gap-1 font-bold text-xs border-2 border-black rounded-full px-3 py-1 bg-[#87CEFA] hover:bg-[#6cc0f5] transition-colors shadow-[2px_2px_0px_0px_#111]"
                              >
                                <Pencil size={12} strokeWidth={3} /> Edit
                              </button>
                            </div>
                          </div>
                          {/*
                            The one place the price badge stays. CourseCard now
                            hides it by default so no student-facing list shows
                            a price; here the teacher is reading back a figure
                            they set themselves, on a page only they can open.
                          */}
                          <CourseCard
                            course={child}
                            index={i}
                            isMyLearning={false}
                            showPrice
                            onClick={(id) => navigate(`/course/${id}`)}
                          />
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <CourseModal
        isOpen={isCourseModalOpen}
        onClose={closeModal}
        onSave={loadMyCourses}
        parentCourseId={modalParentId}
        course={editingCourse}
      />
    </div>
  );
}