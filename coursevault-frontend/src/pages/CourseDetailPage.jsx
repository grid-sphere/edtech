import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Play, Plus, Edit, Trash2, Users } from 'lucide-react';
import Badge from '../components/ui/Badge.jsx';
import CourseAccordion from '../components/course/CourseAccordion.jsx';
import CourseCard from '../components/course/CourseCard.jsx';
import MediaViewerModal from '../components/course/MediaViewerModal.jsx';
import CourseModal from '../components/educator/CourseModal.jsx';
import ModuleModal from '../components/educator/ModuleModal.jsx';
import ContentModal from '../components/educator/ContentModal.jsx';
import EnrollmentsModal from '../components/educator/EnrollmentsModal.jsx';
import AnnouncementModal from '../components/educator/AnnouncementModal.jsx';
import CircularProgress from '../components/ui/CircularProgress.jsx';
import { fetchAPI } from '../services/api.js';
import { getBgColor } from '../utils/format.js';
import { categoryLabel } from '../constants/courseCategories.js';
import { useCategories } from '../hooks/useCategories.js';
import { useAuth } from '../context/AuthContext.jsx';
import { isStaff } from '../utils/roles.js';

const loadRazorpayScript = () => {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
};

export default function CourseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  /*
   * Called up here, above the loading and not-found early returns, because a
   * hook after a conditional return runs on some renders and not others.
   *
   * It is needed because the badge was printing course.category raw — the
   * screenshot shows "hp_board" where every other surface in the app says
   * "HP Board". categoryLabel can only resolve a custom tag against the fetched
   * list; with the built-ins alone it falls back to the slug.
   */
  const { categories } = useCategories();

  const [course, setCourse] = useState(null);
  const [modules, setModules] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [searchParams, setSearchParams] = useSearchParams();
  /*
   * Set once from `?payment=` and then cleared from the URL.
   *
   * PayU returns the student here with the outcome in the query string. If it
   * stayed there, a refresh — or a bookmark — would re-announce a payment that
   * happened days ago.
   */
  const [paymentNotice, setPaymentNotice] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [isEnrolled, setIsEnrolled] = useState(false);
  const [expandedModules, setExpandedModules] = useState([]);
  const [activeContent, setActiveContent] = useState(null);

  // 🌟 PROGRESS TRACKING
  const [completedContentIds, setCompletedContentIds] = useState(new Set());
  const [courseProgress, setCourseProgress] = useState(0);
  const [accessExpiresAt, setAccessExpiresAt] = useState(null);
  // Which course the access belongs to — often the parent class, not this page.
  const [accessCourseId, setAccessCourseId] = useState(null);

  const isCreator = isStaff(user) && (course?.isCreator || user?.id === course?.educator_id);
  const canAccessContent = isCreator || isEnrolled;

  // Educator States
  const [isCourseModalOpen, setIsCourseModalOpen] = useState(false);
  const [isModuleModalOpen, setIsModuleModalOpen] = useState(false);
  const [isContentModalOpen, setIsContentModalOpen] = useState(false);
  const [isEnrollmentsModalOpen, setIsEnrollmentsModalOpen] = useState(false);
  const [isAnnounceOpen, setIsAnnounceOpen] = useState(false);

  const [activeModuleId, setActiveModuleId] = useState(null);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [editingModule, setEditingModule] = useState(null);
  const [contentModalTab, setContentModalTab] = useState('pdf');

  /**
   * @param {{silent?: boolean}} [options]
   *   silent skips the full-page loading state. Reordering needs the fresh
   *   data (otherwise the new order is lost the moment the optimistic list is
   *   dropped) but must not blank the page behind a spinner on every click,
   *   which looked exactly like the page reloading.
   */
  useEffect(() => {
    const outcome = searchParams.get('payment');
    if (!outcome) return;
    setPaymentNotice(outcome === 'success' ? 'success' : 'failed');
    const next = new URLSearchParams(searchParams);
    next.delete('payment');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const loadCourseData = async ({ silent = false } = {}) => {
    if (!silent) setIsLoading(true);
    try {
      const data = await fetchAPI(`/courses/${id}`);
      setCourse(data.course);
      setModules(data.modules || []);
      setSubjects(data.subjects || []);

      // Modules start collapsed. Auto-opening the first one pushed the rest of
      // the curriculum off the screen before the student had seen what the
      // course contained — worst on a phone, where one open module can fill
      // the whole viewport.

      const enrolled = isStaff(user) ? true : !!data.course.isEnrolled;
      setIsEnrolled(enrolled);

      // 🌟 FIX: same stale-gate issue as onContentClick — always attempt to
      // load progress and let the backend's own checks decide what comes back.
      loadProgress(data.course);

    } catch (err) {
      console.error(err);
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  // 🌟 PROGRESS TRACKING: bulk-fetch completed content ids + reuse the
  // enrollments endpoint's already-computed percentage for the header bar.
  const loadProgress = async (courseRecord) => {
    const courseId = courseRecord?.id || courseRecord;
    try {
      const [progressData, enrollmentsData] = await Promise.all([
        fetchAPI(`/video/progress/course/${courseId}`),
        fetchAPI('/enrollments')
      ]);

      setCompletedContentIds(new Set(progressData.completedContentIds || []));

      const all = enrollmentsData.enrollments || [];

      /*
       * Fall back to the parent class's enrolment.
       *
       * Students buy a class and study its subjects, so on a subject page there
       * is no enrolment row for this course id — the access (and its expiry)
       * belongs to the parent. Looking only at this id would show no countdown
       * on exactly the pages where students spend their time.
       */
      const mine =
        all.find((e) => e.course_id === courseId) ||
        (courseRecord?.parent_course_id
          ? all.find((e) => e.course_id === courseRecord.parent_course_id)
          : null);

      setCourseProgress(mine ? mine.progress : 0);
      setAccessExpiresAt(mine?.expires_at || null);
      setAccessCourseId(mine?.course_id || null);
    } catch (err) {
      console.error('Failed to load progress', err);
    }
  };

  useEffect(() => { loadCourseData(); }, [id]);

  if (isLoading) return <div className="text-center font-bold py-20 text-gray-400">Loading...</div>;
  if (!course) return <div className="text-center font-bold py-20 text-red-500">Course not found.</div>;

  const isPublished = course.status === 'published';

  const handleTogglePublish = async () => {
    try {
      const newStatusStr = isPublished ? 'draft' : 'published';
      setCourse({ ...course, status: newStatusStr });

      await fetchAPI(`/courses/${course.id}/publish`, {
        method: 'PUT',
        body: JSON.stringify({ is_published: !isPublished })
      });

    } catch (err) {
      console.error("Failed to toggle publish status", err);
      setCourse({ ...course, status: isPublished ? 'published' : 'draft' });
      alert("Failed to update course status.");
    }
  };

  /**
   * @param {string} [targetCourseId]
   *   The course to buy. Defaults to this page's course, but renewing passes
   *   the course the *enrolment* belongs to — students buy a class and study
   *   its subjects, so on a subject page the lapsed enrolment is the parent's.
   *   Without this, Renew silently bought a different course and left the
   *   expired one untouched, so access never came back.
   */
  const handleEnroll = async (targetCourseId) => {
    const buyCourseId =
      typeof targetCourseId === 'string' ? targetCourseId : course.id;

    setIsEnrolling(true);
    try {
      const orderData = await fetchAPI('/payments/create-order', {
        method: 'POST',
        body: JSON.stringify({ courseId: buyCourseId })
      });

      if (orderData.isFree) {
        alert("Success! You have been enrolled in this free course.");
        setIsEnrolled(true);
        loadCourseData();
        setIsEnrolling(false);
        return;
      }

      /*
       * PayU is a redirect, not a modal.
       *
       * There is no SDK and nothing to await: the server hands back a signed
       * set of fields, the browser posts them to PayU, and PayU brings the
       * student back to this page afterwards. The form is built and submitted
       * rather than fetched because a fetch would follow the redirect itself
       * and leave the student staring at this page while the payment happened
       * invisibly in the background.
       */
      if (orderData.provider === 'payu') {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = orderData.action;
        // Nothing about the payment lives in this DOM node beyond the moment
        // of submission, but hidden inputs are how PayU expects to receive it.
        Object.entries(orderData.fields).forEach(([name, value]) => {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = name;
          input.value = value ?? '';
          form.appendChild(input);
        });
        document.body.appendChild(form);
        form.submit();
        // Deliberately no setIsEnrolling(false): the page is navigating away,
        // and re-enabling the button would let a second tap fire mid-redirect.
        return;
      }

      const res = await loadRazorpayScript();
      if (!res) throw new Error("Razorpay SDK failed to load. Are you online?");

      const options = {
        key: orderData.keyId,
        amount: Math.round(orderData.amount * 100),
        currency: orderData.currency,
        name: "CourseVault.",
        description: `Enrollment: ${orderData.courseTitle}`,
        order_id: orderData.orderId,
        handler: async function (response) {
          try {
            const verifyRes = await fetchAPI('/payments/verify', {
              method: 'POST',
              body: JSON.stringify({
                orderId: response.razorpay_order_id,
                paymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature,
                courseId: buyCourseId
              })
            });

            if (verifyRes.success) {
              alert("Enrollment Successful! Welcome to the course.");
              setIsEnrolled(true);
              loadCourseData();
            }
          } catch (verifyErr) {
            alert(verifyErr.message || "Payment verification failed");
          }
        },
        prefill: {
          name: user?.name || "Student",
          email: user?.email || "student@coursevault.com",
        },
        theme: { color: "#F26B4D" }
      };

      const paymentObject = new window.Razorpay(options);
      paymentObject.open();

    } catch (err) {
      alert(err.message || "Enrollment initialization failed");
    } finally {
      setIsEnrolling(false);
    }
  };

  const handleDeleteCourse = async () => {
    if (!window.confirm('⚠️ Are you sure? This will delete all modules and content.')) return;
    try {
      await fetchAPI(`/courses/${course.id}`, { method: 'DELETE' });
      // Home, not Explore: that tab is hidden for students now. Only an
      // educator can reach this delete, so the second branch is a safety net
      // rather than a path anyone walks.
      navigate(isStaff(user) ? '/dashboard' : '/home');
    } catch (err) {
      alert(err.message || 'Delete failed');
    }
  };

  const handleDeleteModule = async (moduleId) => {
    if (!window.confirm('⚠️ Delete this module?')) return;
    try {
      await fetchAPI(`/modules/${moduleId}`, { method: 'DELETE' });
      loadCourseData();
    } catch (err) {
      alert(err.message || 'Delete failed');
    }
  };

  /*
   * Remaining access, as one short line for the card.
   *
   * This was a separate full-width banner between the header and the
   * curriculum. It said the same thing it says now, but it cost a whole block
   * of vertical space to say it, and with the progress bar below it the student
   * scrolled past two strips of chrome before reaching module 1.
   *
   * Deliberately not gated on isEnrolled. Once access lapses the server
   * correctly reports isEnrolled as false, so gating on it would hide the
   * message at the exact moment it matters — the student would find the enrol
   * button back with no explanation. accessExpiresAt still arrives because the
   * enrolments list keeps lapsed rows on purpose.
   */
  const access = (() => {
    if (isCreator || !(isEnrolled || accessExpiresAt)) return null;
    if (!accessExpiresAt) return { text: 'Lifetime access', tone: 'bg-white', expired: false };

    const expires = new Date(accessExpiresAt);
    const daysLeft = Math.ceil((expires - new Date()) / 86400000);
    if (daysLeft <= 0) {
      return {
        text: `Access ended ${expires.toLocaleDateString()} — re-enrol to continue, your progress is kept.`,
        tone: 'bg-[#F26B4D] text-white',
        expired: true,
      };
    }
    // Days are the useful unit near the end; months read better far out.
    const remaining = daysLeft > 60
      ? `${Math.round(daysLeft / 30)} months left`
      : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
    return {
      text: `${remaining} — access until ${expires.toLocaleDateString()}.`,
      tone: daysLeft <= 14 ? 'bg-[#F9E076]' : 'bg-white',
      expired: false,
    };
  })();

  // The ring replaces the old horizontal bar in the curriculum header.
  const showProgress = isEnrolled && !isCreator;

  return (
    <div className="max-w-5xl mx-auto pb-20">
      {/* ---------------------------------------------------------- one card

          Back arrow, title, board badge, actions, remaining access and the
          progress ring, in a single block.

          These were four stacked things: a floating back button, a large
          header card, a full-width access banner, and a progress bar living in
          the Curriculum heading. Each was reasonable alone; together they cost
          most of a phone screen before the first module, and the reader had to
          scroll to learn the course had any content at all.

          Spacing follows the home screen — gap-2 between cards, mb-2 under a
          heading — rather than the mb-8/md:mb-12 rhythm this page used, which
          was built for a desktop hero and never revisited for a phone.        */}
      <div className={`relative mb-3 ${getBgColor(course.id)} border-2 border-black rounded-2xl p-3 md:p-4 shadow-[3px_3px_0px_0px_#111]`}>
        <div className="flex items-start gap-2.5">
          <button
            onClick={() => navigate(-1)}
            aria-label="Back"
            className="shrink-0 w-8 h-8 md:w-9 md:h-9 flex items-center justify-center bg-white border-2 border-black rounded-full font-bold shadow-[2px_2px_0px_0px_#111] hover:bg-[#F9E076] active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-all"
          >
            <span className="text-base leading-none">←</span>
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="text-base md:text-2xl font-black leading-tight break-words">{course.title}</h1>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              {/* Resolved against the fetched list, so a custom tag reads
                  "HP Board" rather than the stored slug "hp_board". */}
              <Badge colorClass="bg-white">{categoryLabel(course.category, categories) || 'General'}</Badge>
              {isCreator && <Badge colorClass="bg-[#F9E076]">Creator View</Badge>}
              {/* Destructive, and rare — it does not belong in the row of
                  everyday actions where it was one mis-tap from Students. */}
              {isCreator && (
                <button
                  onClick={handleDeleteCourse}
                  title="Delete course"
                  aria-label="Delete course"
                  className="w-7 h-7 shrink-0 flex items-center justify-center bg-white text-red-500 border-2 border-black rounded-lg shadow-[2px_2px_0px_0px_#111] hover:bg-red-50 active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-all"
                >
                  <Trash2 size={13} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>

        {course.description?.trim() && (
          <p className="text-[11px] md:text-sm font-bold text-black/70 mt-2 line-clamp-2">
            {course.description}
          </p>
        )}

        <div className="mt-2.5 grid grid-cols-2 gap-2 md:flex md:flex-wrap md:gap-3">
            {isCreator ? (
              <>
                <button
                  onClick={handleTogglePublish}
                  className={`h-11 md:h-12 w-full md:w-auto md:px-5 flex items-center justify-center gap-2 px-3 text-sm md:text-base font-bold border-2 border-black rounded-xl shadow-[3px_3px_0px_0px_#111] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0px_0px_#111] transition-all ${isPublished
                    ? "bg-[#A7E2D1] text-black"
                    : "bg-white text-gray-500"
                    }`}
                >
                  <div className={`w-2.5 h-2.5 shrink-0 rounded-full border-2 border-black ${isPublished ? "bg-[#F26B4D]" : "bg-gray-400"}`}></div>
                  {isPublished ? "Published" : "Draft"}
                </button>

                <button
                  onClick={() => setIsCourseModalOpen(true)}
                  className="h-11 md:h-12 w-full md:w-auto md:px-5 flex items-center justify-center gap-2 px-3 text-sm md:text-base font-bold border-2 border-black rounded-xl bg-[#A7E2D1] shadow-[3px_3px_0px_0px_#111] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0px_0px_#111] transition-all"
                >
                  Edit
                </button>

                <button
                  onClick={() => { setEditingModule(null); setIsModuleModalOpen(true); }}
                  className="h-11 md:h-12 w-full md:w-auto md:px-5 flex items-center justify-center gap-2 px-3 text-sm md:text-base font-bold border-2 border-black rounded-xl bg-[#F26B4D] shadow-[3px_3px_0px_0px_#111] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0px_0px_#111] transition-all"
                >
                  Add Module
                </button>

                <button
                  onClick={() => setIsEnrollmentsModalOpen(true)}
                  className="h-11 md:h-12 w-full md:w-auto md:px-5 flex items-center justify-center gap-2 px-3 text-sm md:text-base font-bold border-2 border-black rounded-xl bg-[#87CEFA] shadow-[3px_3px_0px_0px_#111] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0px_0px_#111] transition-all"
                >
                  Students
                </button>

                {/* Fifth button in a two-column grid: col-span-2 fills the
                    trailing row instead of leaving a stranded half-width
                    button beside a gap. */}
                <button
                  onClick={() => setIsAnnounceOpen(true)}
                  className="col-span-2 md:col-span-1 h-11 md:h-12 w-full md:w-auto md:px-5 flex items-center justify-center gap-2 px-3 text-sm md:text-base font-bold border-2 border-black rounded-xl bg-[#F9E076] shadow-[3px_3px_0px_0px_#111] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0px_0px_#111] transition-all"
                >
                  Announce
                </button>
              </>
            ) : (
              // col-span-2 so the single student action fills the grid row
              // rather than sitting awkwardly in the left-hand cell.
              <button
                onClick={isEnrolled ? () => { } : handleEnroll}
                disabled={isEnrolling}
                className={`col-span-2 md:col-span-1 h-10 md:h-12 w-full md:w-auto md:px-10 flex items-center justify-center px-4 text-sm md:text-base font-bold border-2 border-black rounded-xl md:rounded-full bg-[#A7E2D1] shadow-[3px_3px_0px_0px_#111] transition-all ${
                  isEnrolling
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0px_0px_#111]'
                }`}
              >
                {isEnrolling ? 'Processing...' : isEnrolled ? 'Continue Learning' : `Enroll - ₹${course.price}`}
              </button>
            )}
          </div>

        {/*
          Access and progress share the last row.

          The ring sits here rather than in the Curriculum heading, where a
          horizontal bar competed with the word "Curriculum" for the same line
          and pushed the heading into its own strip of vertical space.
        */}
        {(access || showProgress) && (
          <div className="flex items-center gap-2.5 mt-2.5">
            {access && (
              <div className={`flex-1 min-w-0 flex flex-wrap items-center gap-2 px-2.5 py-1.5 border-2 border-black rounded-xl font-bold ${access.tone}`}>
                <span className="text-[11px] md:text-sm">{access.text}</span>
                {access.expired && (
                  <button
                    onClick={() => handleEnroll(accessCourseId || course.id)}
                    disabled={isEnrolling}
                    className="shrink-0 h-7 px-2.5 bg-white text-black border-2 border-black rounded-lg text-[11px] font-bold hover:bg-[#F9E076] transition-colors disabled:opacity-60"
                  >
                    {isEnrolling ? '...' : 'Renew'}
                  </button>
                )}
              </div>
            )}
            {/*
              Round, per the sketch. CircularProgress already draws the ring and
              the number, so this is the existing component rather than a second
              implementation of the same thing.
            */}
            {showProgress && (
              <div className="shrink-0 ml-auto">
                <CircularProgress size="small" percentage={courseProgress} color="#F26B4D" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------ subjects

          A class holds no material of its own — it holds subjects, and the
          material is in those. So this is the whole page for a class, and the
          curriculum below it renders nothing.

          Before this existed, tapping a class landed on an empty "Curriculum"
          heading with nothing under it, from home, My Learning and every
          notification alike. The class looked broken rather than full.       */}
      {/*
        The outcome of a payment the student was redirected away for.

        Stated on the page rather than in an alert(): they have just come back
        from another site and the first thing they need is confirmation that
        their money did something. A failure says to try again rather than
        implying the charge went through.
      */}
      {paymentNotice && (
        <div
          role="status"
          className={`mb-3 p-3 border-2 border-black rounded-xl font-bold text-xs md:text-sm shadow-[3px_3px_0px_0px_#111] ${
            paymentNotice === 'success' ? 'bg-[#A7E2D1]' : 'bg-red-100 text-red-800'
          }`}
        >
          {paymentNotice === 'success'
            ? 'Payment received — you now have access to this course.'
            : 'That payment did not go through, and you have not been charged. You can try again.'}
        </div>
      )}

      {subjects.length > 0 && (
        <div className="mb-4">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <h2 className="text-lg md:text-2xl font-black shrink-0">Subjects</h2>
            <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
              {subjects.length} in this class
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 md:gap-4 items-start">
            {subjects.map((s, i) => (
              <CourseCard
                key={s.id}
                course={s}
                index={i}
                isMyLearning={false}
                /*
                 * Straight to the subject's own page, which is where its
                 * modules live. The same component the Explore grid uses, so a
                 * subject looks the same wherever a student meets it.
                 */
                onClick={() => navigate(`/course/${s.id}`)}
              />
            ))}
          </div>
        </div>
      )}

      {/*
        Hidden for a class with subjects.

        A class has no modules, so the heading would stand alone above nothing
        — and next to a populated Subjects grid it reads as a section that
        failed to load rather than one that was never meant to have content.
        A subject, and a class that holds material directly, both still show it.
      */}
      {/*
        Just the heading now.

        "Your Progress" and its horizontal bar used to share this row; the bar
        is the ring in the card above, so the heading no longer needs a strip of
        its own. mb-2 matches the home screen, where a heading sits this close
        to the list it introduces.
      */}
      <div className={`mb-2 ${
        subjects.length > 0 && modules.length === 0 ? 'hidden' : ''
      }`}>
        <h2 className="text-lg md:text-2xl font-black">Curriculum</h2>
      </div>
      {/* gap-2, as between the class rows on home. gap-6 here was most of a
          module card's height of empty space between every pair. */}
      <div className="flex flex-col gap-2">
        {modules.map((module, moduleIndex) => (
          <CourseAccordion
            key={module.id}
            module={module}
            // Position in the ordered list, not module_order. Deleting a module
            // leaves a gap in module_order (0, 1, 3), which would display as
            // "1, 2, 4". The index always renumbers to 1, 2, 3.
            moduleNumber={moduleIndex + 1}
            isOpen={expandedModules.includes(module.id)}
            onToggle={() => setExpandedModules(prev => prev.includes(module.id) ? prev.filter(m => m !== module.id) : [...prev, module.id])}

            // 🌟 DIRECT TRACKING INJECTION: Fires the exact second they click "Read" or "Take Quiz"
            onContentClick={(content) => {
              setActiveContent(content); // Opens the modal

              // 🌟 FIX: no client-side isEnrolled/role gate here anymore — it was
              // stale/false at click time and silently skipped the fetch entirely
              // (confirmed: zero /video/progress requests ever hit the backend).
              // The backend route already does its own proper authorization
              // (creator bypass, preview check, real enrollment check) and
              // returns a clean 403 if the click genuinely isn't authorized —
              // so we just always attempt it and let the response decide.
              const contentId = content.id || content.content_id;
              if (contentId && course?.id) {
                console.log('[progress] attempting save for', contentId, 'in course', course.id);

                // Reflect completion in the UI immediately, don't wait on the network
                setCompletedContentIds(prev => new Set(prev).add(contentId));

                fetchAPI('/video/progress', {
                  method: 'POST',
                  body: JSON.stringify({
                    contentId: contentId,
                    courseId: course.id,
                    position: 100,
                    is_completed: true
                  })
                })
                  .then((res) => {
                    console.log('[progress] saved', contentId, res);
                    loadProgress(course.id); // resync overall % from the server
                  })
                  .catch(err => {
                    // 🌟 Don't lie to the UI: if the save actually failed, undo the checkmark
                    console.error('[progress] FAILED to save for content', contentId, err);
                    setCompletedContentIds(prev => {
                      const next = new Set(prev);
                      next.delete(contentId);
                      return next;
                    });
                  });
              } else {
                console.warn('[progress] skipped — missing contentId or course.id', { contentId, courseId: course?.id });
              }
            }}

            completedContentIds={completedContentIds}
            onProgressRefresh={() => loadProgress(course.id)}
            isCreator={isCreator}
            onAddContent={(mId, fId) => { setActiveModuleId(mId); setActiveFolderId(fId); setContentModalTab('video'); setIsContentModalOpen(true); }}
            onAddPDF={(mId, fId) => { setActiveModuleId(mId); setActiveFolderId(fId); setContentModalTab('pdf'); setIsContentModalOpen(true); }}
            onEditModule={(mod) => { setEditingModule(mod); setIsModuleModalOpen(true); }}
            onDeleteModule={handleDeleteModule}
            courseId={course.id}
            isEnrolled={isEnrolled}
            onRefreshCurriculum={loadCourseData}
          />
        ))}
      </div>

      <MediaViewerModal
        content={activeContent}
        courseId={course.id}
        isEnrolled={canAccessContent}
        onClose={() => setActiveContent(null)}
      />

      {/* Educator Modals */}
      <CourseModal isOpen={isCourseModalOpen} onClose={() => setIsCourseModalOpen(false)} course={course} onSave={loadCourseData} />
      <ModuleModal isOpen={isModuleModalOpen} onClose={() => setIsModuleModalOpen(false)} courseId={course.id} module={editingModule} onSave={loadCourseData} />

      <ContentModal
        isOpen={isContentModalOpen}
        onClose={() => setIsContentModalOpen(false)}
        moduleId={activeModuleId}
        folderId={activeFolderId}
        onSave={loadCourseData}
        initialTab={contentModalTab}
      />
      <EnrollmentsModal isOpen={isEnrollmentsModalOpen} onClose={() => setIsEnrollmentsModalOpen(false)} courseId={course.id} courseTitle={course.title} />

      {isAnnounceOpen && (
        <AnnouncementModal
          courseId={course.id}
          courseTitle={course.title}
          onClose={() => setIsAnnounceOpen(false)}
        />
      )}
    </div>
  );
}