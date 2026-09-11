import React, { useState, useEffect } from 'react';
import { Video, FileText, HelpCircle, Plus, Edit, Trash2, FilePlus, X, ChevronUp, ChevronDown, CheckCircle2 } from 'lucide-react';
import { formatSize } from '../../utils/format';
import { fetchAPI } from '../../services/api.js';
import InlineVideoPlayer from './InlineVideoPlayer.jsx';
import StudyIcon from './StudyIcon.jsx';
import QuizModal from '../educator/QuizModal.jsx';
import QuizTakeModal from './QuizTakeModal.jsx';

const SECTIONS = [
  { key: 'videos',    label: 'Videos',    Icon: Video,      colour: 'bg-[#87CEFA]' },
  { key: 'pdfs',      label: 'PDFs',      Icon: FileText,   colour: 'bg-[#A7E2D1]' },
  { key: 'documents', label: 'Documents', Icon: FilePlus,   colour: 'bg-[#F4DFD8]' },
  { key: 'quizzes',   label: 'Quizzes',   Icon: HelpCircle, colour: 'bg-[#F9E076]' },
];

/**
 * One tab in a module's strip.
 *
 * @param {string}   label
 * @param {number}   count    items filed here; shown as a badge
 * @param {boolean}  active
 * @param {Function} onClick
 * @param {Function|null} onDelete  omitted for students, and for General while
 *   it is empty — there would be nothing to delete
 */
function TabButton({ label, count, active, onClick, onDelete, deleteTitle, tone }) {
  return (
    <div className="relative shrink-0 flex items-end">
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        title={label}
        className={`flex items-center gap-2 border-2 border-b-0 border-black rounded-t-xl font-bold text-sm transition-all
          ${onDelete ? 'pl-3.5 pr-8' : 'px-4'}
          ${active
            ? 'bg-white py-3 -mb-[2px] z-10 shadow-[0px_-2px_0px_0px_#111]'
            : 'bg-[#E5CFC8] py-2.5 text-gray-700 hover:bg-[#DCC6BE]'}`}
      >
        {/*
          Long chapter names are truncated rather than allowed to stretch the
          tab. A single tab wide enough to push every other one off-screen is
          how a strip becomes unusable.
        */}
        <span className="truncate max-w-[9rem]">{label}</span>

        {count > 0 && (
          <span
            className={`shrink-0 min-w-[1.25rem] px-1 py-0.5 rounded-full border border-black text-[10px] leading-none font-black tabular-nums ${
              active ? 'bg-[#F9E076]' : 'bg-white/70'
            }`}
          >
            {count}
          </span>
        )}
      </button>

      {onDelete && (
        /*
         * Always visible, never hover-only.
         *
         * This used to appear on :hover, which does not exist on a touch
         * screen — a teacher on a phone or tablet could not delete a tab at
         * all. It is small and muted until hovered instead, which keeps it
         * quiet without making it unreachable.
         */
        <button
          type="button"
          onClick={onDelete}
          title={deleteTitle}
          aria-label={deleteTitle}
          className={`absolute right-1.5 rounded-full p-1 transition-colors z-20
            ${active ? 'bottom-3' : 'bottom-2.5'}
            ${tone === 'general'
              ? 'text-red-600 hover:bg-red-100'
              : 'text-black/40 hover:text-red-600 hover:bg-red-100'}`}
        >
          <X size={13} strokeWidth={3} />
        </button>
      )}
    </div>
  );
}

export default function CourseAccordion({
  module,
  moduleNumber,
  isOpen,
  onToggle,
  onContentClick,
  isCreator,
  onAddContent,
  onAddPDF,
  onEditModule,
  onDeleteModule,
  courseId,
  isEnrolled,
  onRefreshCurriculum,
  completedContentIds = new Set(), // 🌟 PROGRESS TRACKING
  onProgressRefresh, // 🌟 PROGRESS TRACKING: called after a quiz is completed
}) {
  const contents = module.contents || [];

  const [activeTabId, setActiveTabId] = useState(null);
  const [expandedVideoId, setExpandedVideoId] = useState(null);
  const [quizzes, setQuizzes] = useState([]);
  const [quizzesLoaded, setQuizzesLoaded] = useState(false);
  const [isQuizModalOpen, setIsQuizModalOpen] = useState(false);
  // null while creating; a quiz id puts the builder into edit mode.
  const [editingQuizId, setEditingQuizId] = useState(null);
  const [takingQuizId, setTakingQuizId] = useState(null);
  const [folders, setFolders] = useState([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [selectedContentIds, setSelectedContentIds] = useState([]);
  // contentId -> title, shown until the refetch brings the saved value back.
  const [titleOverrides, setTitleOverrides] = useState({});

  const loadQuizzes = async () => {
    try {
      const data = await fetchAPI(`/quiz/module/${module.id}`);
      setQuizzes(data.quizzes || []);
    } catch (_) {
      setQuizzes([]);
    } finally {
      setQuizzesLoaded(true);
    }
  };

  const loadFolders = async () => {
    try {
      const data = await fetchAPI(`/content/folders/${module.id}`);
      setFolders(data.folders || []);
    } catch (_) {
      setFolders([]);
    } finally {
      setFoldersLoaded(true);
    }
  };

  useEffect(() => {
    if (isOpen) {
      if (!quizzesLoaded) loadQuizzes();
      if (!foldersLoaded) loadFolders();
    }
  }, [isOpen, quizzesLoaded, foldersLoaded]);

  const handleCreateTab = async () => {
    const title = window.prompt("Enter new tab name (e.g., Chapter 1):");
    if (!title) return;
    try {
      const res = await fetchAPI('/content/folder', {
        method: 'POST',
        body: JSON.stringify({ module_id: module.id, title })
      });
      loadFolders();
      if (res.folder) setActiveTabId(res.folder.id);
    } catch (err) {
      alert(err.message || 'Failed to create tab');
    }
  };

  const handleDeleteTab = async (e, folderId) => {
    e.stopPropagation();
    if (!window.confirm("Delete this tab? Contents will safely return to the General tab.")) return;
    try {
      await fetchAPI(`/content/folder/${folderId}`, { method: 'DELETE' });
      if (activeTabId === folderId) setActiveTabId(null);
      loadFolders();
      if (onRefreshCurriculum) onRefreshCurriculum();
    } catch (err) {
      alert(err.message || 'Failed to delete tab');
    }
  };

  /**
   * Clear the General tab.
   *
   * Deleting a chapter is non-destructive — its contents fall back to General.
   * General has no fallback of its own (it *is* the fallback), so there is
   * nowhere for its items to go and emptying it means deleting them. The
   * confirmation says so explicitly and names the counts, because the same red
   * cross on a chapter tab means something much safer.
   *
   * Once it is empty the tab hides itself, so this reads as "delete General".
   */
  const handleDeleteGeneral = async (e) => {
    e.stopPropagation();

    const unfiledContent = contents.filter((c) => !c.folder_id);
    const unfiledQuizzes = quizzes.filter((q) => !q.folder_id);
    const total = unfiledContent.length + unfiledQuizzes.length;

    // Already empty — nothing to delete, just step off it so it can hide.
    if (total === 0) {
      if (folders.length > 0) setActiveTabId(folders[0].id);
      return;
    }

    const parts = [];
    if (unfiledContent.length) {
      parts.push(`${unfiledContent.length} file${unfiledContent.length === 1 ? '' : 's'}`);
    }
    if (unfiledQuizzes.length) {
      parts.push(`${unfiledQuizzes.length} quiz${unfiledQuizzes.length === 1 ? '' : 'zes'}`);
    }

    const confirmed = window.confirm(
      `Delete everything in General?\n\n` +
      `This removes ${parts.join(' and ')}.\n\n` +
      `Deleting a chapter moves its contents here for safekeeping — General has ` +
      `nowhere to move things to, so these are deleted instead.`
    );
    if (!confirmed) return;

    try {
      // Sequential on purpose: a partial failure should stop rather than fire
      // off the rest, and these lists are small.
      for (const c of unfiledContent) {
        await fetchAPI(`/content/${c.id}`, { method: 'DELETE' });
      }
      for (const q of unfiledQuizzes) {
        await fetchAPI(`/quiz/${q.id}`, { method: 'DELETE' });
      }

      setQuizzes((prev) => prev.filter((q) => q.folder_id));
      if (folders.length > 0) setActiveTabId(folders[0].id);
      if (onRefreshCurriculum) onRefreshCurriculum({ silent: true });
    } catch (err) {
      // Some may already be gone — refresh so the UI matches the server.
      if (onRefreshCurriculum) onRefreshCurriculum({ silent: true });
      alert(err.message || 'Could not clear the General tab.');
    }
  };

  const toggleContentSelection = (id) => {
    setSelectedContentIds(prev =>
      prev.includes(id) ? prev.filter(cId => cId !== id) : [...prev, id]
    );
  };

  const handleBulkMove = async (targetFolderId) => {
    if (selectedContentIds.length === 0) return;
    try {
      await fetchAPI(`/content/bulk-move`, {
        method: 'PUT',
        body: JSON.stringify({
          content_ids: selectedContentIds,
          folder_id: targetFolderId === 'null' ? null : targetFolderId
        })
      });
      setSelectedContentIds([]);
      if (onRefreshCurriculum) onRefreshCurriculum();
      else window.location.reload();
    } catch (err) {
      alert(err.message || 'Failed to move items');
    }
  };

  /**
   * Rename a video, PDF or document.
   *
   * Titles come from the filename at upload time, so they arrive as things like
   * "WhatsApp Video 2026-07-23 at 14.02.11" — fine for the uploader, useless to
   * a student scanning a curriculum.
   *
   * The row updates immediately and is corrected from the server afterwards:
   * waiting on a round trip to see your own typing feels broken, but the
   * optimistic value must not be trusted if the request fails.
   */
  const handleRenameContent = async (e, content) => {
    e.stopPropagation();

    const current = titleOverrides[content.id] ?? content.title ?? '';
    const next = window.prompt('Rename this item:', current);
    if (next === null) return; // cancelled

    const trimmed = next.trim();
    if (!trimmed) {
      alert('The title cannot be empty.');
      return;
    }
    if (trimmed === current) return;

    // Held separately rather than mutating the prop: the parent owns that
    // object, and writing to it would not re-render anyway.
    setTitleOverrides((prev) => ({ ...prev, [content.id]: trimmed }));

    try {
      await fetchAPI(`/content/${content.id}`, {
        method: 'PUT',
        body: JSON.stringify({ title: trimmed }),
      });
      if (onRefreshCurriculum) onRefreshCurriculum({ silent: true });
    } catch (err) {
      setTitleOverrides((prev) => {
        const next = { ...prev };
        delete next[content.id];
        return next;
      });
      alert(err.message || 'Could not rename this item.');
    }
  };

  const handleDeleteContent = async (e, contentId) => {
    e.stopPropagation();
    if (!window.confirm('Delete this content item?')) return;
    try {
      await fetchAPI(`/content/${contentId}`, { method: 'DELETE' });
      if (onRefreshCurriculum) onRefreshCurriculum();
      else window.location.reload();
    } catch (err) {
      alert(err.message || 'Failed to delete content');
    }
  };

  /**
   * Open the builder on an existing quiz.
   *
   * Saving replaces the question set, which removes the per-question answers
   * of anyone who has already taken it — so say that plainly first rather than
   * letting a teacher discover it from missing review data later.
   */
  const handleEditQuiz = (quiz) => {
    if (quiz.is_completed || Number(quiz.attempt_count) > 0) {
      const ok = window.confirm(
        'Students have already taken this quiz.\n\n' +
        'Editing replaces its questions, so their per-question answers will be ' +
        'removed. Recorded scores are kept.\n\nContinue?'
      );
      if (!ok) return;
    }
    setEditingQuizId(quiz.id);
    setIsQuizModalOpen(true);
  };

  const handleDeleteQuiz = async (quizId) => {
    if (!window.confirm('Delete this quiz?')) return;
    try {
      await fetchAPI(`/quiz/${quizId}`, { method: 'DELETE' });
      setQuizzes((prev) => prev.filter((q) => q.id !== quizId));
    } catch (err) {
      alert(err.message || 'Failed to delete quiz');
    }
  };

  const activeContents = contents
    .filter(c => activeTabId === null ? !c.folder_id : c.folder_id === activeTabId)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));

  const activeQuizzes = quizzes.filter(q =>
    activeTabId === null ? !q.folder_id : q.folder_id === activeTabId
  );

  // Anything sitting in the unfiled bucket, regardless of which tab is open.
  // Gated on quizzesLoaded: quizzes arrive after the module payload, so without
  // it the tab would judge itself empty on first paint and flicker out just
  // before an unfiled quiz showed up.
  const generalIsEmpty =
    quizzesLoaded &&
    !contents.some((c) => !c.folder_id) &&
    !quizzes.some((q) => !q.folder_id);

  /*
   * General exists only while something is unfiled.
   *
   * It is not a folder you create — it is the folder_id IS NULL bucket — so it
   * appears when items land there and goes away when they don't. Deleting it
   * therefore leaves the strip with nothing but "+ Add Chapter", which is the
   * intended end state. Adding content while no chapter is selected files it
   * as unfiled again and brings the tab back.
   */
  const showGeneralTab = !generalIsEmpty;

  /**
   * How many items sit in each tab.
   *
   * Shown on the tab itself so an empty chapter is obvious without opening it
   * — which is the difference between "I haven't uploaded that yet" and "I
   * uploaded it into the wrong tab", a mistake this layout invites and
   * previously gave no way to spot.
   */
  const tabCounts = React.useMemo(() => {
    const counts = { general: 0 };
    for (const f of folders) counts[f.id] = 0;

    const bump = (folderId) => {
      const key = folderId || 'general';
      if (key in counts) counts[key] += 1;
    };
    contents.forEach((c) => bump(c.folder_id));
    quizzes.forEach((q) => bump(q.folder_id));
    return counts;
  }, [contents, quizzes, folders]);

  // 🌟 NEW: Arrow Movement Logic
  /**
   * PDFs, videos and quizzes in ONE ordered list.
   *
   * They live in different tables and used to render as two separate blocks,
   * so a quiz could never sit between two PDFs. Merging on the shared
   * `priority` field lets the creator arrange the lesson in any order.
   *
   * created_at breaks ties, which matters for legacy rows: uploads default to
   * priority 2 and quizzes to 0, so without a tiebreak the order would be
   * arbitrary until the first manual move.
   */
  const orderedItems = React.useMemo(() => {
    const merged = [
      ...activeContents.map((c) => ({ kind: 'content', id: c.id, priority: c.priority ?? 0, createdAt: c.created_at, data: c })),
      ...activeQuizzes.map((q) => ({ kind: 'quiz', id: q.id, priority: q.priority ?? 0, createdAt: q.created_at, data: q })),
    ];
    return merged.sort((a, b) =>
      a.priority !== b.priority
        ? a.priority - b.priority
        : new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );
  }, [activeContents, activeQuizzes]);

  const [reorderNotice, setReorderNotice] = useState('');

  // contentId -> { percent, stage, renditionsDone, renditionsTotal }
  const [encodeProgress, setEncodeProgress] = useState({});


  const displayItems = orderedItems;

  /**
   * Which section an item belongs to.
   *
   * content_type is only ever 'video' or 'pdf' today — the upload modal sends
   * 'pdf' for every non-video file — but .docx/.doc are already recognised
   * server-side, so a Word file would be filed under PDFs. Extension and mime
   * are checked before trusting content_type.
   */
  const sectionFor = (entry) => {
    if (entry.kind === 'quiz') return 'quizzes';

    const c = entry.data;
    const name = (c.file_name || c.title || '').toLowerCase();
    const mime = (c.mime_type || '').toLowerCase();

    if (c.content_type === 'video' || mime.startsWith('video/')) return 'videos';
    if (/\.(docx?|pptx?|xlsx?|odt|txt)$/.test(name) || mime.includes('word') || mime.includes('officedocument')) {
      return 'documents';
    }
    if (mime.includes('pdf') || name.endsWith('.pdf') || c.content_type === 'pdf') return 'pdfs';
    return 'documents';
  };

  // Buckets keep the priority order the items already arrived in.

  const grouped = React.useMemo(() => {
    const buckets = { videos: [], pdfs: [], documents: [], quizzes: [] };
    for (const entry of displayItems) buckets[sectionFor(entry)].push(entry);
    return buckets;
  }, [displayItems]);

  // Undefined means open; only an explicit false collapses a section.
  const [openSections, setOpenSections] = useState({});
  const toggleSection = (key) =>
    setOpenSections((prev) => ({ ...prev, [key]: prev[key] === false }));

  // ---- per-section rearranging -------------------------------------------
  //
  // Sections are rendered separately, so ordering only ever matters *within*
  // one. A section reorder therefore permutes the items back into the same
  // global slots that section already occupies — every other section keeps its
  // position, and one flat payload still describes the whole module.
  const [rearrangeSection, setRearrangeSection] = useState(null);
  const [sectionDraft, setSectionDraft] = useState(null);
  const [isSavingSection, setIsSavingSection] = useState(false);

  const startSectionRearrange = (key) => {
    setRearrangeSection(key);
    setSectionDraft(grouped[key]);
    setReorderNotice('');
  };

  const cancelSectionRearrange = () => {
    setRearrangeSection(null);
    setSectionDraft(null);
  };

  const moveInSection = (index, direction) => {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (!sectionDraft || target < 0 || target >= sectionDraft.length) return;
    const next = [...sectionDraft];
    [next[index], next[target]] = [next[target], next[index]];
    setSectionDraft(next);
  };

  const sectionHasChanges =
    sectionDraft !== null &&
    rearrangeSection !== null &&
    sectionDraft.some((item, i) => item.id !== (grouped[rearrangeSection] || [])[i]?.id);

  const saveSectionOrder = async () => {
    if (!sectionDraft || !rearrangeSection) return;
    setIsSavingSection(true);
    setReorderNotice('');

    try {
      // The indices this section currently occupies in the flat list.
      const slots = [];
      displayItems.forEach((entry, i) => {
        if (sectionFor(entry) === rearrangeSection) slots.push(i);
      });

      const next = [...displayItems];
      slots.forEach((slot, k) => { next[slot] = sectionDraft[k]; });

      await fetchAPI(`/modules/${module.id}/reorder`, {
        method: 'PUT',
        body: JSON.stringify({
          items: next.map(({ id, kind }) => ({ id, type: kind })),
        }),
      });

      if (onRefreshCurriculum) await onRefreshCurriculum({ silent: true });
      if (loadQuizzes) await loadQuizzes();

      setRearrangeSection(null);
      setSectionDraft(null);
    } catch (err) {
      console.error('[CourseAccordion] section reorder failed', err);
      setReorderNotice(err.message || 'Could not save the new order.');
    } finally {
      setIsSavingSection(false);
    }
  };

  // What the panel shows: its own draft, falling back to the live order.

  /**
   * Poll any still-transcoding video until it becomes playable.
   *
   * Nothing was watching /content/:id/status, so a video stayed labelled
   * "Processing" until a full page reload — even after ffmpeg had finished
   * minutes earlier. That made a completed transcode look like a stuck one.
   */
  const processingIds = contents
    .filter((c) => c.status === 'processing')
    .map((c) => c.id)
    .join(',');

  /*
   * Videos go live after the first rendition and keep encoding the rest, so
   * tracking cannot stop at 'processing'. These are already watchable — they
   * are polled only to keep the "still improving" note honest, and they must
   * never trigger the curriculum refetch, or a half-hour encode would refetch
   * every five seconds for no change.
   */
  const pendingIds = contents
    .filter((c) => c.status === 'ready' && c.metadata?.pending === true)
    .map((c) => c.id)
    .join(',');

  useEffect(() => {
    if (!isOpen || (!processingIds && !pendingIds)) return;

    let cancelled = false;
    const busy = processingIds ? processingIds.split(',') : [];
    const settling = pendingIds ? pendingIds.split(',') : [];
    const ids = [...busy, ...settling];

    const check = async () => {
      const results = await Promise.all(
        ids.map((id) =>
          fetchAPI(`/content/${id}/status`)
            .then((d) => ({ id, ...d }))
            .catch(() => ({ id, status: 'processing', progress: null }))
        )
      );
      if (cancelled) return;

      // Keep the live encode percentages so the row can show real movement
      // instead of an indefinite "this can take a few minutes".
      setEncodeProgress((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (r.progress) next[r.id] = r.progress;
          else delete next[r.id];
        }
        return next;
      });

      // Refresh only once something has actually left 'processing', so a long
      // transcode does not trigger a refetch every few seconds for nothing.
      const finished = results.some(
        (r) => busy.includes(r.id) && r.status && r.status !== 'processing'
      );
      // A pending item that quietly finishes its last rendition also needs one
      // final refetch, otherwise the "still improving" note never clears.
      const settled = results.some(
        (r) => settling.includes(r.id) && !r.stillEncoding
      );
      if (finished || settled) {
        if (onRefreshCurriculum) onRefreshCurriculum({ silent: true });
      }
    };

    check(); // don't make the first reading wait a full interval
    const timer = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isOpen, processingIds, pendingIds]);

  /*
   * Never leave the view pointed at a tab that is no longer on screen.
   *
   * Emptying General hides it, but activeTabId would still be null — so the
   * body would keep rendering the (now invisible) unfiled bucket with no tab
   * highlighted. Step onto the first chapter instead. With no chapters at all
   * there is nowhere to go, and the empty state below takes over.
   */
  useEffect(() => {
    if (!showGeneralTab && activeTabId === null && folders.length > 0) {
      setActiveTabId(folders[0].id);
    }
  }, [showGeneralTab, activeTabId, folders]);

  // A list built for one tab must never render under another. Switching tabs
  // therefore drops any in-progress rearrange rather than carrying a draft
  // built from the previous tab's items across.
  useEffect(() => {
    setReorderNotice('');
    setRearrangeSection(null);
    setSectionDraft(null);
  }, [activeTabId]);

  /**
   * Up/down arrows. Used only by the Rearrange panel now — the content rows
   * no longer carry them, so reordering happens in exactly one place.
   */
  const renderMoveArrows = (index, onMove, listLength) => {
    if (!isCreator) return null;
    const atTop = index === 0;
    const atBottom = index === listLength - 1;
    return (
      <div className="flex flex-col items-center justify-center gap-[2px]">
        <button
          onClick={() => onMove(index, 'up')}
          disabled={atTop}
          title="Move Up"
          className={`p-1.5 md:p-0.5 border-2 border-black rounded ${
            atTop
              ? 'bg-gray-200 text-gray-400 cursor-not-allowed opacity-50'
              : 'bg-[#A7E2D1] hover:bg-[#86cdba] text-black shadow-[1px_1px_0px_0px_#111] active:translate-y-[1px] active:shadow-none'
          }`}
        >
          <ChevronUp size={16} strokeWidth={3} />
        </button>
        <button
          onClick={() => onMove(index, 'down')}
          disabled={atBottom}
          title="Move Down"
          className={`p-1.5 md:p-0.5 border-2 border-black rounded ${
            atBottom
              ? 'bg-gray-200 text-gray-400 cursor-not-allowed opacity-50'
              : 'bg-[#F9E076] hover:bg-[#ebd056] text-black shadow-[1px_1px_0px_0px_#111] active:translate-y-[1px] active:shadow-none'
          }`}
        >
          <ChevronDown size={16} strokeWidth={3} />
        </button>
      </div>
    );
  };

  /** One content row (video / pdf / document). */
  const renderContentRow = (content) => {
                const isVideo = content.content_type === 'video';
                // A freshly uploaded video sits at 'processing' until ffmpeg
                // finishes. It used to be filtered out of the API response
                // entirely, so it simply vanished after upload.
                const isProcessing = content.status === 'processing';
                const isFailed = content.status === 'failed';
                const isSelected = selectedContentIds.includes(content.id);
                const isDone = completedContentIds.has(content.id); // 🌟 PROGRESS TRACKING

                return (
                  <div key={content.id} className={`border-2 border-black rounded-xl p-2.5 md:p-4 md:shadow-[2px_2px_0px_0px_#111] transition-colors ${isSelected ? 'bg-blue-50' : isDone ? 'bg-[#F3FBF8]' : 'bg-white'}`}>
                    <div className="flex justify-between items-center gap-2">
                      {/* min-w-0 + flex-1: without it this group refuses to
                          shrink, so on a phone the title pushes the badge and
                          buttons past the card edge instead of truncating. */}
                      <div className="flex items-center gap-2.5 md:gap-4 min-w-0 flex-1">
                        {isCreator && (
                          <input
                            type="checkbox"
                            className="w-5 h-5 border-2 border-black rounded cursor-pointer accent-[#F26B4D]"
                            checked={isSelected}
                            onChange={() => toggleContentSelection(content.id)}
                          />
                        )}


                        <div className={`relative w-9 h-9 md:w-10 md:h-10 shrink-0 rounded-full border-2 border-black flex items-center justify-center ${isVideo ? 'bg-[#87CEFA]' : 'bg-[#A7E2D1]'}`}>
                          {isVideo ? <Video size={18} /> : <FileText size={18} />}
                          {isDone && (
                            <CheckCircle2
                              size={16}
                              strokeWidth={2.5}
                              className="absolute -bottom-1 -right-1 bg-white text-[#2FA36B] rounded-full border-2 border-black"
                            />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="font-bold text-sm md:text-lg leading-tight mb-0.5 md:mb-1 line-clamp-2 break-words">{titleOverrides[content.id] ?? content.title}</h4>
                          {!isVideo && <p className="text-xs md:text-sm font-medium text-gray-500 truncate">PDF • {formatSize(content.file_size_bytes)}</p>}
                          {isVideo && !isProcessing && !isFailed && (
                            <p className="text-xs md:text-sm font-medium text-gray-500 flex items-center gap-1.5">
                              Video Lesson
                              {/* Watchable already; higher qualities still
                                  encoding. Said plainly so a creator doesn't
                                  think the upload half-failed. */}
                              {content.metadata?.pending && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700">
                                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                                  HD still encoding
                                  {encodeProgress[content.id]
                                    ? ` · ${encodeProgress[content.id].percent}%`
                                    : ''}
                                </span>
                              )}
                            </p>
                          )}
                          {isProcessing && (() => {
                            const prog = encodeProgress[content.id];
                            return (
                              <div className="mt-0.5">
                                <p className="text-xs md:text-sm font-bold text-amber-700 flex items-center gap-1.5">
                                  <span className="w-2 h-2 shrink-0 rounded-full bg-amber-500 animate-pulse" />
                                  {prog ? (
                                    <span className="truncate">
                                      Encoding {prog.stage}
                                      <span className="hidden sm:inline">
                                        {' '}({prog.renditionsDone + 1} of {prog.renditionsTotal})
                                      </span>
                                      {' · '}{prog.percent}%
                                    </span>
                                  ) : (
                                    <span className="truncate">
                                      Queued<span className="hidden sm:inline"> — starting shortly</span>
                                    </span>
                                  )}
                                </p>
                                {/* A real bar: an indefinite spinner gave no way
                                    to tell a slow encode from a stuck one. */}
                                <div className="mt-1 h-1.5 w-full max-w-[220px] rounded-full bg-amber-100 border border-amber-300 overflow-hidden">
                                  <div
                                    className="h-full bg-amber-500 transition-[width] duration-700 ease-out"
                                    style={{ width: `${prog?.percent ?? 0}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })()}
                          {isFailed && (
                            <p className="text-xs md:text-sm font-bold text-red-700">
                              Processing failed<span className="hidden sm:inline"> — check the server log, then re-upload</span>
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 md:gap-3 shrink-0">
                        {content.preview && <span className="hidden sm:inline-block bg-[#F26B4D] text-black text-[10px] font-black px-2 py-0.5 border-2 border-black rounded uppercase whitespace-nowrap">Preview</span>}
                        {/* Hidden on phones: the badge is what was being clipped,
                            and the green tick on the icon already says "done". */}
                        {isDone && (
                          <span className="hidden sm:inline-block bg-[#A7E2D1] text-black text-[10px] font-black px-2 py-0.5 border-2 border-black rounded uppercase whitespace-nowrap">Completed</span>
                        )}

                        {isVideo ? (
                          <button
                            onClick={() => setExpandedVideoId(prev => prev === content.id ? null : content.id)}
                            disabled={isProcessing || isFailed}
                            title={isProcessing ? 'Still transcoding' : isFailed ? 'Transcoding failed' : undefined}
                            className={`border-2 border-black rounded-lg px-2.5 md:px-4 py-1.5 md:py-2 font-bold text-xs md:text-sm shrink-0 transition-colors ${
                              isProcessing || isFailed
                                ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                                : 'bg-white hover:bg-[#F9E076]'
                            }`}
                          >
                            {isProcessing ? 'Processing' : isFailed ? 'Failed' : expandedVideoId === content.id ? 'Close' : isDone ? 'Rewatch' : 'Watch'}
                          </button>
                        ) : (
                          <button
                            onClick={() => onContentClick(content)}
                            className="bg-white border-2 border-black rounded-lg px-2.5 md:px-4 py-1.5 md:py-2 font-bold text-xs md:text-sm shrink-0 hover:bg-[#F9E076] transition-colors"
                          >
                            {isDone ? 'Review' : 'Read'}
                          </button>
                        )}

                        {isCreator && (
                          <button
                            title="Rename"
                            aria-label={`Rename ${content.title}`}
                            onClick={(e) => handleRenameContent(e, content)}
                            className="w-8 h-8 md:w-9 md:h-9 shrink-0 flex items-center justify-center bg-white border-2 border-black rounded-md hover:bg-[#F9E076] transition-colors"
                          >
                            <Edit size={14} strokeWidth={3} />
                          </button>
                        )}

                        {isCreator && (
                          <button
                            title="Delete Asset"
                            onClick={(e) => handleDeleteContent(e, content.id)}
                            className="w-8 h-8 md:w-9 md:h-9 shrink-0 flex items-center justify-center bg-red-400 border-2 border-black rounded-md hover:scale-105 transition-transform"
                          >
                            <Trash2 size={14} strokeWidth={3} />
                          </button>
                        )}
                      </div>
                    </div>
                    {isVideo && expandedVideoId === content.id && (
                      <div className="mt-4 border-t-2 border-dashed border-gray-300 pt-4">
                        <InlineVideoPlayer content={content} courseId={courseId} isEnrolled={isEnrolled} />
                      </div>
                    )}
                  </div>
                );
  };

  const renderQuizRow = (quiz) => (
    <div
      key={quiz.id}
      className={`border-2 border-black rounded-xl p-2.5 md:p-4 md:shadow-[2px_2px_0px_0px_#111] ${
        quiz.is_completed ? 'bg-[#F3FBF8]' : 'bg-white'
      }`}
    >
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2.5 md:gap-4 min-w-0 flex-1">
          {/* Spacer matching the content rows' checkbox, so icons line up. */}
          {isCreator && <div className="w-5 h-5 shrink-0" />}
          <div className="relative w-9 h-9 md:w-10 md:h-10 shrink-0 rounded-full border-2 border-black flex items-center justify-center bg-[#F4DFD8]">
            <HelpCircle size={18} />
            {quiz.is_completed && (
              <CheckCircle2
                size={16}
                strokeWidth={2.5}
                className="absolute -bottom-1 -right-1 bg-white text-[#2FA36B] rounded-full border-2 border-black"
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="font-bold text-sm md:text-lg leading-tight mb-0.5 md:mb-1 line-clamp-2 break-words">{quiz.title}</h4>
            <p className="text-xs md:text-sm font-medium text-gray-500 truncate">
              {quiz.question_count} question{quiz.question_count === 1 ? '' : 's'}
              {/* Worth knowing before you start, not after. */}
              {quiz.time_limit ? ` • ${quiz.time_limit} min` : ''}
              {quiz.is_completed && ` • Best score: ${quiz.user_score}%`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 md:gap-3 shrink-0">
          {quiz.is_completed && (
            <span className="hidden sm:inline-block bg-[#A7E2D1] text-black text-[10px] font-black px-2 py-0.5 border-2 border-black rounded uppercase whitespace-nowrap">
              Completed
            </span>
          )}
          <button
            onClick={() => setTakingQuizId(quiz.id)}
            className="bg-white border-2 border-black rounded-lg px-2.5 md:px-4 py-1.5 md:py-2 font-bold text-xs md:text-sm shrink-0 hover:bg-[#F9E076] transition-colors"
          >
            {quiz.is_completed ? 'Retake Quiz' : 'Take Quiz'}
          </button>
          {isCreator && (
            <button
              title="Edit quiz"
              aria-label={`Edit ${quiz.title}`}
              onClick={() => handleEditQuiz(quiz)}
              className="w-8 h-8 md:w-9 md:h-9 shrink-0 flex items-center justify-center bg-white border-2 border-black rounded-md hover:bg-[#F9E076] transition-colors"
            >
              <Edit size={14} strokeWidth={3} />
            </button>
          )}
          {isCreator && (
            <button
              title="Delete quiz"
              onClick={() => handleDeleteQuiz(quiz.id)}
              className="w-8 h-8 md:w-9 md:h-9 shrink-0 flex items-center justify-center bg-red-400 border-2 border-black rounded-md hover:scale-105 transition-transform"
            >
              <Trash2 size={14} strokeWidth={3} />
            </button>
          )}
        </div>
      </div>
    </div>
  );


  // Counts drive both the summary line and the thumbnail strip.
  const moduleCompleted =
    contents.filter((c) => completedContentIds.has(c.id)).length +
    quizzes.filter((q) => q.is_completed).length;
  const moduleTotal = contents.length + quizzes.length;
  const pct = moduleTotal > 0 ? Math.round((moduleCompleted / moduleTotal) * 100) : 0;

  const typeCounts = React.useMemo(() => {
    const counts = { videos: 0, pdfs: 0, documents: 0, quizzes: 0 };
    for (const entry of orderedItems) counts[sectionFor(entry)] += 1;
    return counts;
  }, [orderedItems]);

  return (
    <div className="bg-white border-2 border-black rounded-xl overflow-hidden shadow-[2px_2px_0px_0px_#111] md:shadow-[4px_4px_0px_0px_#111] mb-4 md:mb-6">
      <div
        className="p-3 md:p-6 flex items-start gap-3 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={onToggle}
      >
        {/* Play Store detail style: a square "icon", then title, meta line and a
            thumbnail strip of what is inside. */}
        {/* No tile behind it: the icon is already a bordered disc, and a square
            plate under a circular badge reads as a mistake rather than a frame. */}
        <div
          role="img"
          aria-label={moduleNumber == null ? 'Module' : `Module ${moduleNumber}`}
          className="w-12 h-12 md:w-14 md:h-14 shrink-0 flex items-center justify-center"
        >
          <StudyIcon className="w-full h-full" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-bold text-base md:text-xl leading-tight line-clamp-2 min-w-0">
              {module.title}
            </h3>

            <div className="flex items-center gap-1.5 shrink-0">
              {isCreator && (
                <>
                  <button
                    title="Edit Module"
                    onClick={(e) => { e.stopPropagation(); onEditModule(module); }}
                    className="w-7 h-7 md:w-8 md:h-8 flex items-center justify-center bg-[#F9E076] border-2 border-black rounded-md hover:scale-105 transition-transform md:shadow-[2px_2px_0px_0px_#000]"
                  >
                    <Edit size={13} strokeWidth={3} />
                  </button>
                  <button
                    title="Delete Module"
                    onClick={(e) => { e.stopPropagation(); onDeleteModule(module.id); }}
                    className="w-7 h-7 md:w-8 md:h-8 flex items-center justify-center bg-red-400 border-2 border-black rounded-md hover:scale-105 transition-transform md:shadow-[2px_2px_0px_0px_#000]"
                  >
                    <Trash2 size={13} strokeWidth={3} />
                  </button>
                </>
              )}
              <ChevronDown
                size={20}
                strokeWidth={3}
                className={`shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
              />
            </div>
          </div>

          {/* Content mix, the way a store lists what a bundle contains. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11px] md:text-xs font-bold text-gray-500">
            {typeCounts.videos > 0 && (
              <span className="flex items-center gap-1"><Video size={12} /> {typeCounts.videos}</span>
            )}
            {typeCounts.pdfs > 0 && (
              <span className="flex items-center gap-1"><FileText size={12} /> {typeCounts.pdfs}</span>
            )}
            {typeCounts.documents > 0 && (
              <span className="flex items-center gap-1"><FilePlus size={12} /> {typeCounts.documents}</span>
            )}
            {typeCounts.quizzes > 0 && (
              <span className="flex items-center gap-1"><HelpCircle size={12} /> {typeCounts.quizzes}</span>
            )}
            {moduleTotal === 0 && <span>Empty</span>}
            {moduleTotal > 0 && (
              <>
                <span className="text-gray-300">|</span>
                <span className={moduleCompleted === moduleTotal ? 'text-green-700' : ''}>
                  {moduleCompleted}/{moduleTotal} done
                </span>
              </>
            )}
          </div>

          {moduleTotal > 0 && (
            <div className="mt-2 h-1.5 w-full max-w-[220px] rounded-full bg-gray-200 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-[#2FA36B]' : 'bg-[#F26B4D]'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {isOpen && (
        <div className="border-t-2 border-black bg-gray-50 flex flex-col animate-in fade-in slide-in-from-top-4 duration-300">
          {/*
            The tab strip.

            Scrolls horizontally on narrow screens rather than wrapping: a
            wrapped strip changes height as tabs are added, which shifts the
            content below it every time a chapter is created.
          */}
          <div className="relative bg-[#F4DFD8] border-b-2 border-black">
            <div className="flex items-end gap-1.5 overflow-x-auto scrollbar-hide pt-2.5 md:pt-3 px-2.5 md:px-4 pb-0">
              {/*
                General is not a folder — it is the folder_id IS NULL bucket, and
                it is where deleting a chapter sends that chapter's contents. So
                it cannot be deleted, only hidden once nothing is in it.

                It stays visible while it holds anything, while it is the tab you
                are looking at (otherwise the strip would yank the current tab out
                from under you), and when there are no chapters at all — with no
                tabs and no content, there would be nowhere to add the first item.
              */}
              {showGeneralTab && (
                <TabButton
                  label="General"
                  count={tabCounts.general}
                  active={activeTabId === null}
                  onClick={() => setActiveTabId(null)}
                  onDelete={isCreator && !generalIsEmpty ? handleDeleteGeneral : null}
                  deleteTitle="Delete everything in General"
                  tone="general"
                />
              )}

              {folders.map((folder) => (
                <TabButton
                  key={folder.id}
                  label={folder.title}
                  count={tabCounts[folder.id] ?? 0}
                  active={activeTabId === folder.id}
                  onClick={() => setActiveTabId(folder.id)}
                  onDelete={isCreator ? (e) => handleDeleteTab(e, folder.id) : null}
                  deleteTitle={`Delete "${folder.title}"`}
                />
              ))}

              {isCreator && (
                <button
                  onClick={handleCreateTab}
                  title="Add a chapter tab"
                  className="shrink-0 self-end mb-0 flex items-center gap-1 px-3 py-2 rounded-t-xl border-2 border-b-0 border-dashed border-black/40 text-black/60 font-bold text-xs hover:border-solid hover:border-black hover:text-black hover:bg-[#F9E076] transition-colors"
                >
                  <Plus size={15} strokeWidth={3} /> Chapter
                </button>
              )}
            </div>

            {/*
              A fade at the right edge, so a strip that scrolls looks like it
              scrolls. Without it a cut-off tab reads as a rendering glitch.
              pointer-events-none: it must not swallow taps on the tab beneath.
            */}
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-[#F4DFD8] to-transparent md:hidden" />
          </div>

          <div className="p-3 md:p-8 bg-white min-h-[140px] md:min-h-[300px] relative">
            {isCreator && (
              <div className="flex flex-wrap gap-2 md:gap-4 mb-4 md:mb-8 pb-4 md:pb-6 border-b-2 border-dashed border-gray-300">
                <button onClick={() => onAddContent(module.id, activeTabId)} className="flex items-center gap-1.5 md:gap-2 px-3 md:px-5 py-2 md:py-2.5 bg-[#87CEFA] border-2 border-black rounded-lg md:rounded-xl font-bold text-xs md:text-sm md:shadow-[2px_2px_0px_0px_#111] hover:scale-[1.02] transition-transform">
                  <Video size={16} strokeWidth={3} className="md:w-[18px] md:h-[18px]" /> <span className="md:hidden">Video</span><span className="hidden md:inline">Add Video Here</span>
                </button>
                <button onClick={() => onAddPDF(module.id, activeTabId)} className="flex items-center gap-1.5 md:gap-2 px-3 md:px-5 py-2 md:py-2.5 bg-[#A7E2D1] border-2 border-black rounded-lg md:rounded-xl font-bold text-xs md:text-sm md:shadow-[2px_2px_0px_0px_#111] hover:scale-[1.02] transition-transform">
                  <FilePlus size={16} strokeWidth={3} className="md:w-[18px] md:h-[18px]" /> <span className="md:hidden">PDF</span><span className="hidden md:inline">Add PDF Here</span>
                </button>
                <button onClick={() => { setEditingQuizId(null); setIsQuizModalOpen(true); }} className="flex items-center gap-1.5 md:gap-2 px-3 md:px-5 py-2 md:py-2.5 bg-[#F4DFD8] border-2 border-black rounded-lg md:rounded-xl font-bold text-xs md:text-sm md:shadow-[2px_2px_0px_0px_#111] hover:scale-[1.02] transition-transform">
                  <HelpCircle size={16} strokeWidth={3} className="md:w-[18px] md:h-[18px]" /> <span className="md:hidden">Quiz</span><span className="hidden md:inline">Create Quiz Here</span>
                </button>
              </div>
            )}

            {selectedContentIds.length > 0 && isCreator && (
              <div className="bg-[#A7E2D1] border-2 border-black p-3 rounded-lg flex items-center justify-between shadow-[2px_2px_0px_0px_#111] mb-6 animate-in fade-in zoom-in duration-200">
                <span className="font-bold">{selectedContentIds.length} items selected</span>
                <div className="flex gap-2">
                  <select
                    className="border-2 border-black rounded-lg px-3 py-1.5 font-bold bg-white text-sm outline-none focus:ring-2 focus:ring-[#F26B4D]"
                    onChange={(e) => handleBulkMove(e.target.value)}
                    defaultValue=""
                  >
                    <option value="" disabled>Move to tab...</option>
                    <option value="null">General</option>
                    {folders.map(f => (
                      <option key={f.id} value={f.id}>{f.title}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {reorderNotice && (
              <div className="mb-3 flex items-start justify-between gap-2 flex-wrap border-2 border-amber-400 bg-amber-50 text-amber-900 rounded-lg px-3 py-2 text-xs md:text-sm font-bold">
                <span>{reorderNotice}</span>
                <button
                  type="button"
                  onClick={() => setReorderNotice('')}
                  className="shrink-0 underline hover:no-underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            {displayItems.length === 0 ? (
              <div className="text-center border-2 border-dashed border-gray-300 rounded-xl py-12 px-4">
                {/* With General deleted and no chapters yet the strip is just
                    "+ Add Chapter", so say that rather than "use the buttons
                    above" — there are no content buttons to point at. */}
                {folders.length === 0 && !showGeneralTab ? (
                  <>
                    <p className="text-gray-500 font-bold mb-2">No chapters yet.</p>
                    {isCreator && (
                      <p className="text-sm text-gray-400">
                        Add a chapter to start organising this module's content.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-gray-500 font-bold mb-2">This tab is empty.</p>
                    {isCreator && (
                      <p className="text-sm text-gray-400">
                        Use the buttons above to add content, or select items from other tabs to move them here.
                      </p>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {SECTIONS.map(({ key, label, Icon, colour }) => {
                  const items = grouped[key];
                  if (!items || items.length === 0) return null; // hide empty sections
                  const open = openSections[key] !== false; // default open
                  const arranging = rearrangeSection === key;
                  const rows = arranging && sectionDraft ? sectionDraft : items;

                  return (
                    <section key={key} className="border-2 border-black rounded-xl overflow-hidden md:shadow-[2px_2px_0px_0px_#111]">
                      <div className={`border-b-2 border-black ${colour}`}>
                        <div className="flex items-center gap-1 md:gap-2 px-2.5 md:px-4 py-2 md:py-2.5">
                          <button
                            type="button"
                            onClick={() => toggleSection(key)}
                            aria-expanded={open}
                            className="flex items-center gap-1.5 md:gap-2 font-black text-xs md:text-sm uppercase min-w-0 flex-1 text-left"
                          >
                            <Icon size={15} strokeWidth={2.5} className="shrink-0" />
                            <span className="truncate">{label}</span>
                            <span className="text-[10px] md:text-[11px] font-bold normal-case opacity-70 shrink-0">
                              ({items.length})
                            </span>
                          </button>

                          {/* Reordering only matters within a section, so the
                              control lives here rather than in one flat list. */}
                          {isCreator && open && items.length > 1 && !arranging && (
                            <button
                              type="button"
                              onClick={() => startSectionRearrange(key)}
                              title={`Reorder ${label}`}
                              className="shrink-0 flex items-center gap-1 px-2 py-1 bg-white border-2 border-black rounded-lg font-bold text-[10px] md:text-xs hover:bg-[#F9E076] transition-colors"
                            >
                              <ChevronUp size={10} strokeWidth={4} className="-mr-0.5" />
                              <ChevronDown size={10} strokeWidth={4} />
                              <span className="hidden sm:inline">Reorder</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => toggleSection(key)}
                            aria-label={open ? 'Collapse' : 'Expand'}
                            className="shrink-0 p-0.5"
                          >
                            <ChevronDown
                              size={18}
                              strokeWidth={3}
                              className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                            />
                          </button>
                        </div>

                        {arranging && (
                          <div className="flex items-center justify-between gap-2 px-2.5 md:px-4 pb-2 flex-wrap">
                            <span className="text-[10px] md:text-xs font-bold">
                              Arrange with the arrows
                              {sectionHasChanges && <span className="ml-1.5 text-[#B45309]">unsaved</span>}
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={cancelSectionRearrange}
                                disabled={isSavingSection}
                                className="px-2.5 py-1 bg-white border-2 border-black rounded-lg font-bold text-[10px] md:text-xs disabled:opacity-50"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={saveSectionOrder}
                                disabled={isSavingSection || !sectionHasChanges}
                                className="px-3 py-1 bg-[#A7E2D1] border-2 border-black rounded-lg font-bold text-[10px] md:text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {isSavingSection ? 'Saving...' : 'Save'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      {open && (
                        <div className="p-2 md:p-3 flex flex-col gap-2 md:gap-3 bg-gray-50">
                          {rows.map((entry, i) => (
                            <div key={entry.id} className="flex items-stretch gap-2">
                              {arranging && (
                                <div className="shrink-0 flex items-center">
                                  {renderMoveArrows(i, moveInSection, rows.length)}
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                {entry.kind === 'quiz'
                                  ? renderQuizRow(entry.data)
                                  : renderContentRow(entry.data)}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <QuizModal
        isOpen={isQuizModalOpen}
        onClose={() => { setIsQuizModalOpen(false); setEditingQuizId(null); }}
        moduleId={module.id}
        folderId={activeTabId}
        editQuizId={editingQuizId}
        onSave={() => { setEditingQuizId(null); setQuizzesLoaded(false); loadQuizzes(); }}
      />
      {takingQuizId && (
        <QuizTakeModal
          quizId={takingQuizId}
          onClose={() => {
            setTakingQuizId(null);
            // 🌟 PROGRESS TRACKING: re-pull this module's quizzes for the
            // fresh completed/score badge, and let the page-level progress
            // bar resync too.
            setQuizzesLoaded(false);
            loadQuizzes();
            if (onProgressRefresh) onProgressRefresh();
          }}
        />
      )}
    </div>
  );
}