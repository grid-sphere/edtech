import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Flame, Check, LayoutGrid, ChevronLeft, ChevronRight, Stethoscope,
  Compass, GraduationCap, ClipboardList,
  BookOpen, Users, Play, ArrowRight, Loader,
} from 'lucide-react';
import { fetchAPI, resolveMediaUrl } from '../services/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { COURSE_CATEGORIES, categoryLabel } from '../constants/courseCategories.js';

/** Morning / afternoon / evening, from the reader's own clock. */
function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
}

/**
 * An icon per category, kept here rather than in the shared constants.
 *
 * The constants file is mirrored on the server, which has no use for a React
 * component — putting these there would drag lucide into a list whose only job
 * is to agree with the backend about five strings.
 */
const CATEGORY_ICONS = {
  hp_board: BookOpen,
  neet: Stethoscope,
  jee: Compass,
  cbse: GraduationCap,
  test_series: ClipboardList,
};

/** How long each slide holds before the carousel advances. */
const SLIDE_MS = 4500;

/**
 * Initials for the avatar, from however much of a name we actually have.
 *
 * "Aakash Kumar" gives AK, "testcode" gives T. Falls back to a dash rather
 * than an empty circle, which reads as a failed image load.
 */
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The greeting block.
 *
 * Two lines with a real hierarchy rather than one flat bold line: the
 * "Good evening" part is boilerplate the reader has seen every day, so it
 * sits small and muted next to the date, while their own name — the only
 * part that is actually theirs — carries the weight.
 *
 * The date is formatted from `new Date()`, the reader's own clock. That is
 * safe here precisely because it is not a date parsed from the server; there
 * is no string to misinterpret.
 */
function Greeting({ name }) {
  const first = (name || '').split(' ')[0] || 'there';
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
  });

  return (
    <div className="flex items-center gap-2.5 min-w-0 flex-1">
      <div
        className="shrink-0 w-10 h-10 md:w-11 md:h-11 rounded-full border-2 border-black
                   bg-[#F26B4D] text-white shadow-[2px_2px_0px_0px_#111]
                   flex items-center justify-center font-black text-sm md:text-base"
        aria-hidden="true"
      >
        {initialsOf(name)}
      </div>

      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500 leading-none">
          <span>{greeting()}</span>
          <span className="text-gray-500/50" aria-hidden="true">•</span>
          <span className="normal-case tracking-normal">{today}</span>
        </p>
        <h1 className="text-lg md:text-2xl font-black tracking-tight leading-tight truncate mt-1">
          {first} <span aria-hidden="true">👋</span>
        </h1>
      </div>
    </div>
  );
}

/** Indexed by the `dow` the server sends, so 0 is Sunday. */
const DOW_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The learning streak, as a week at a glance.
 *
 * A bare number says "7" and nothing else. Seven dots say which days were
 * studied, so a gap is visible and today being unfilled is a gentle nudge
 * rather than a scolding — the difference between information and pressure.
 *
 * Dates are never parsed here. The server sends the weekday index with each
 * day precisely so the browser's timezone cannot shift a dot under the wrong
 * letter.
 */
function StreakStrip({ streak, days, activeDays }) {
  if (!days?.length) return null;

  return (
    /*
     * Full width on a phone, inline in the header from `sm` up.
     *
     * The parent wraps, so this drops to its own row on a narrow screen where
     * squeezing it beside the greeting is what forced the dots down to an
     * unreadable size in the first place. Given the whole width it can spread
     * out and actually be legible.
     */
    <div
      className="w-full sm:w-auto shrink-0 flex items-center justify-between sm:justify-start
                 gap-3 sm:gap-3.5 px-3 py-2 rounded-xl border-2 border-black bg-white
                 shadow-[3px_3px_0px_0px_#111]"
      title={`${activeDays} active day${activeDays === 1 ? '' : 's'} in total`}
    >
      <div className="flex items-center gap-1.5 shrink-0">
        <Flame size={18} strokeWidth={2.5} className="text-[#F26B4D]" />
        <div className="leading-none">
          <span className="font-black text-lg leading-none tabular-nums">{streak}</span>
          <span className="block text-[9px] font-bold uppercase tracking-wide text-gray-500 mt-0.5">
            day{streak === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className="w-px self-stretch bg-black/10" aria-hidden="true" />

      {/*
        A list, not a row of decorative divs. Each dot carries its own label,
        so a screen reader reads "Thursday (today): studied" instead of seven
        unlabelled bullets — the visible letters stay purely visual.
      */}
      <ul className="flex items-center gap-1.5 sm:gap-1 list-none m-0 p-0">
        {days.map((d, i) => {
          const isToday = i === days.length - 1;
          return (
            <li key={d.day} className="flex flex-col items-center gap-1">
              <span
                className={`text-[9px] leading-none ${
                  isToday ? 'font-black text-black' : 'font-bold text-gray-500'
                }`}
                aria-hidden="true"
              >
                {DOW_LETTERS[d.dow]}
              </span>
              {/*
                Filled days get the tick, not just a colour change. Colour
                alone would be the only signal separating done from missed,
                which disappears for a red-green colourblind reader and in a
                screenshot printed in black and white.
              */}
              <span
                className={`flex items-center justify-center w-[18px] h-[18px] rounded-full border-2 ${
                  d.active
                    ? 'bg-[#F26B4D] border-black text-white'
                    : isToday
                      ? 'bg-white border-black border-dashed'
                      : 'bg-gray-100 border-black/25'
                }`}
              >
                {d.active && <Check size={10} strokeWidth={4} />}
                <span className="sr-only">
                  {DOW_NAMES[d.dow]}
                  {isToday ? ' (today)' : ''}: {d.active ? 'studied' : 'no activity'}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The course carousel.
 *
 * Covers only — the images are the content, so each slide is the thumbnail at
 * full bleed with the title laid over a gradient rather than beside it.
 *
 * Auto-advance stops on hover and on focus. A strip that keeps moving while
 * someone is reaching for a slide takes the target away just as they click,
 * and one that keeps moving while a keyboard user is tabbing through it is
 * worse still.
 */
function CourseCarousel({ slides, onOpen }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const count = slides.length;
  const go = useCallback((next) => setIndex(((next % count) + count) % count), [count]);

  /*
   * Honour the OS "reduce motion" setting.
   *
   * Read once on mount rather than watched: this decides whether a timer is
   * ever created, and someone changing the setting mid-session can reload.
   */
  const [reduceMotion] = useState(() =>
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );

  useEffect(() => {
    if (paused || reduceMotion || count < 2) return undefined;
    const t = setInterval(() => setIndex((i) => (i + 1) % count), SLIDE_MS);
    return () => clearInterval(t);
  }, [paused, reduceMotion, count]);

  /*
   * Wrapped at read time rather than corrected in an effect.
   *
   * The list can shrink under a stale index — a course unpublished while the
   * page is open. Clamping in an effect would render one blank frame first and
   * then re-render, so the value is simply derived instead.
   */
  const safe = count > 0 ? index % count : 0;
  const current = slides[safe];
  if (!current) return null;

  return (
    <div
      className="relative mb-3 rounded-xl border-2 border-black overflow-hidden shadow-[3px_3px_0px_0px_#111] bg-[#932973]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      // Announced as a region rather than live: the slides are decorative
      // navigation, and reading each one aloud as it passes would interrupt
      // whatever the reader is actually doing.
      role="region"
      aria-roledescription="carousel"
      aria-label="Featured courses"
    >
      <div className="relative aspect-[5/2] sm:aspect-[16/5]">
        {slides.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onOpen(s)}
            // Only the visible slide is reachable; the rest are hidden from
            // assistive tech and the tab order so the carousel is one stop.
            tabIndex={i === safe ? 0 : -1}
            aria-hidden={i !== safe}
            className={`absolute inset-0 w-full text-left transition-opacity duration-500 ${
              i === safe ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            <img
              src={resolveMediaUrl(s.thumbnail_url)}
              alt={s.title}
              className="w-full h-full object-cover"
              loading={i === 0 ? 'eager' : 'lazy'}
            />
            {/* The gradient is what keeps the title legible over an unknown
                photograph — a teacher can upload anything, including a white
                slide, so the text cannot rely on the image being dark. */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />

            <div className="absolute left-0 right-0 bottom-0 p-3 md:p-4 text-white">
              <div className="flex items-center gap-1.5 mb-1">
                {s.category && (
                  <span className="px-2 py-0.5 rounded-full bg-white/25 backdrop-blur-sm text-[10px] font-bold uppercase tracking-wide">
                    {categoryLabel(s.category)}
                  </span>
                )}
                {s.enrolled && (
                  <span className="px-2 py-0.5 rounded-full bg-[#A7E2D1] text-black text-[10px] font-bold uppercase tracking-wide">
                    Enrolled
                  </span>
                )}
              </div>
              <h2 className="text-sm md:text-xl font-black leading-tight line-clamp-2 drop-shadow">
                {s.title}
              </h2>
              <span className="inline-flex items-center gap-1 mt-1.5 text-[11px] md:text-sm font-bold">
                {s.enrolled ? 'Continue' : 'Explore now'}
                <ArrowRight size={14} strokeWidth={3} />
              </span>
            </div>
          </button>
        ))}

        {count > 1 && (
          <>
            <CarouselArrow side="left" onClick={() => go(safe - 1)} />
            <CarouselArrow side="right" onClick={() => go(safe + 1)} />

            <div className="absolute bottom-2.5 right-3 flex items-center gap-1.5">
              {slides.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => go(i)}
                  aria-label={`Go to slide ${i + 1} of ${count}`}
                  aria-current={i === safe}
                  className={`h-1.5 rounded-full transition-all ${
                    i === safe ? 'w-5 bg-white' : 'w-1.5 bg-white/50 hover:bg-white/80'
                  }`}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One pill in the filter bar.
 *
 * `shrink-0` matters: without it flexbox squeezes the chips to fit the row
 * instead of letting them overflow, and the labels wrap to two lines on a
 * phone rather than scrolling.
 */
function CategoryChip({ icon: Icon, label, count, active, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border-2 border-black
        font-bold text-xs whitespace-nowrap transition-all ${
        active
          ? 'bg-[#F26B4D] text-white shadow-[2px_2px_0px_0px_#111]'
          : 'bg-white hover:shadow-[2px_2px_0px_0px_#111]'
      }`}
    >
      {Icon && <Icon size={13} strokeWidth={3} />}
      {label}
      {count > 0 && (
        <span
          className={`text-[11px] font-black tabular-nums px-1.5 rounded-full ${
            active ? 'bg-white/25' : 'bg-black/10'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function CarouselArrow({ side, onClick }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? 'Previous course' : 'Next course'}
      className={`absolute top-1/2 -translate-y-1/2 ${side === 'left' ? 'left-2' : 'right-2'}
        w-8 h-8 rounded-full bg-black/45 text-white backdrop-blur-sm
        flex items-center justify-center hover:bg-black/70 transition-colors`}
    >
      <Icon size={17} strokeWidth={3} />
    </button>
  );
}

export default function StudentHomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /*
   * The search box now lives in the header, so the text arrives through the
   * URL rather than local state. This page mostly reads it — the one exception
   * is the empty state below, which has to be able to clear a search it did
   * not start.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const clearQuery = useCallback(() => {
    const p = new URLSearchParams(searchParams);
    p.delete('q');
    setSearchParams(p, { replace: true });
  }, [searchParams, setSearchParams]);
  const [category, setCategory] = useState('all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchAPI('/home');
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load your home page.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Memoised because `?? []` builds a fresh array on every render, which
  // would defeat every useMemo that depends on it.
  const courses = useMemo(() => data?.courses ?? [], [data]);
  const featured = useMemo(() => data?.featured ?? [], [data]);
  /*
   * Every published course, joined or not. The chips count and filter against
   * this rather than against enrolments, so a course a teacher tagged today
   * is findable today.
   */
  const catalog = useMemo(() => data?.catalog ?? [], [data]);
  const streak = data?.streak ?? 0;

  /*
   * How many enrolled courses sit under each category.
   *
   * The bar itself is always the full fixed list. An earlier version rendered
   * only the categories a student already had courses in, which meant that
   * until a teacher tagged something the bar did not appear at all — the
   * feature looked missing rather than empty. A chip that leads to "nothing
   * here yet" is honest; a navigation bar that silently deletes itself is not.
   */
  const countByCategory = useMemo(() => {
    const n = {};
    for (const c of catalog) if (c.category) n[c.category] = (n[c.category] ?? 0) + 1;
    return n;
  }, [catalog]);

  /*
   * The chip actually in force.
   *
   * A selected chip can stop existing when the data reloads — a course
   * dropped, an enrolment lapsed — which would otherwise filter the list down
   * to nothing with no way back except reloading. Resolved during render
   * rather than corrected in an effect, so there is no frame where the page
   * shows an empty list before righting itself.
   */
  const activeCategory = category;

  const matches = (c) => {
    const q = query.trim().toLowerCase();
    if (activeCategory !== 'all' && c.category !== activeCategory) return false;
    if (!q) return true;
    return c.title?.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q);
  };

  /** The student's own courses — these keep their progress bar. */
  const filtered = useMemo(
    () => courses.filter(matches),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [courses, query, activeCategory]
  );

  /*
   * Published courses in this category that the student has not joined.
   *
   * Excluded by id rather than by the `enrolled` flag alone: a course can be
   * in both lists — enrolments carry progress that the catalogue row does not
   * — and showing it twice under one chip looks like duplicated data.
   */
  const available = useMemo(() => {
    const mine = new Set(courses.map((c) => c.id));
    return catalog.filter((c) => !mine.has(c.id) && matches(c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, courses, query, activeCategory]);


  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 font-bold text-gray-500">
        <Loader size={18} className="animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <div className="pb-24">
      {/* ---------------------------------------------------------- greeting

          Deliberately small. This line is read once and never again, so it
          should not be the biggest thing on a phone screen — the courses
          below are what the student came for. `truncate` keeps it to one
          line for long names rather than pushing everything down.          */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <Greeting name={user?.name} />

        {/*
          Only shown once there is a streak to show. A "0 day streak" badge is
          a reproach on the first screen after signing up, which is the worst
          possible moment for one.

          One row rather than a stacked number over a caption: stacked, it was
          two lines tall and forced the whole header to match its height.
        */}
        {streak > 0 && (
          <StreakStrip
            streak={streak}
            days={data?.recentDays}
            activeDays={data?.activeDays ?? 0}
          />
        )}
      </div>

      {error && (
        <div className="p-3 mb-4 border-2 border-red-500 bg-red-50 rounded-xl font-bold text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* ---------------------------------------------------------- carousel

          Falls back to the static banner when nothing qualifies. A brand-new
          site with no published course would otherwise show a blank strip
          where the largest element on the page should be.                   */}
      {featured.length > 0 ? (
        <CourseCarousel
          slides={featured}
          onOpen={(s) => navigate(s.enrolled ? `/course/${s.id}` : '/explore')}
        />
      ) : (
        <div className="relative overflow-hidden rounded-xl border-2 border-black bg-[#932973] text-white p-4 md:p-5 mb-3 shadow-[3px_3px_0px_0px_#111]">
          <div className="relative z-10 max-w-md">
            <span className="inline-block px-2 py-0.5 rounded-full bg-white/20 text-[10px] font-bold uppercase tracking-wide mb-2">
              Sharda Vidyapeeth
            </span>
            <h2 className="text-base md:text-2xl font-black leading-tight mb-1">
              Learn • Practice • Achieve
            </h2>
            <p className="text-xs text-white/80 font-medium mb-3">
              Everything for your class in one place.
            </p>
            <button
              type="button"
              onClick={() => navigate('/explore')}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border-2 border-black bg-white text-black font-bold text-sm shadow-[2px_2px_0px_0px_#111]"
            >
              Explore Courses <ArrowRight size={15} strokeWidth={3} />
            </button>
          </div>
          <BookOpen
            size={150}
            strokeWidth={1}
            className="absolute -right-6 -bottom-8 text-white/10 pointer-events-none"
          />
        </div>
      )}

      {/* -------------------------------------------------------- filter bar

          Always the full list, whether or not a category has courses in it
          today. The bar is the student's map of what the platform covers, so
          it should not change shape depending on what they happen to be
          enrolled in — an empty result is handled by the message below.    */}
      <div
        role="tablist"
        aria-label="Filter classes by category"
        // Scrolls sideways on a phone rather than wrapping to two rows. The
        // negative margin lets the row bleed to the screen edge so the last
        // chip is visibly cut off — the cue that there is more to scroll to.
        // -mx-4 cancels the gutter on <main> exactly, so the row bleeds to the
        // screen edge. If that gutter changes, this must change with it.
        className="flex gap-1.5 overflow-x-auto pb-1 mb-4 -mx-4 px-4 md:mx-0 md:px-0
                   [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <CategoryChip
          icon={LayoutGrid}
          label="All"
          count={courses.length}
          active={activeCategory === 'all'}
          onClick={() => setCategory('all')}
        />
        {COURSE_CATEGORIES.map((c) => (
          <CategoryChip
            key={c.id}
            icon={CATEGORY_ICONS[c.id]}
            label={c.label}
            count={countByCategory[c.id] ?? 0}
            active={activeCategory === c.id}
            onClick={() => setCategory(c.id)}
          />
        ))}
      </div>

      {/* ----------------------------------------------------------- classes

          Hidden when the student has nothing in this category: an empty
          "Your Classes" heading above a list of courses they could join
          reads as a failure rather than as a starting point.               */}
      <div className={`flex items-center justify-between gap-2 mb-2 ${
        filtered.length === 0 && available.length > 0 ? 'hidden' : ''
      }`}>
        <h2 className="font-black text-sm md:text-lg uppercase">Your Classes</h2>
        <button
          type="button"
          onClick={() => navigate('/my-learning')}
          className="flex items-center gap-1 text-xs font-bold text-gray-600 hover:text-black"
        >
          View all <ArrowRight size={13} strokeWidth={3} />
        </button>
      </div>

      {/*
        The empty card only appears when there is genuinely nothing to show.
        With courses available below it, "No classes under NEET" contradicts
        the list immediately underneath it.
      */}
      {filtered.length === 0 && available.length === 0 ? (
        <div className="border-2 border-black rounded-xl bg-white p-6 text-center shadow-[2px_2px_0px_0px_#111]">
          <BookOpen size={30} strokeWidth={2} className="mx-auto mb-2 text-gray-600" />
          {/* Three different situations, three different messages. "Nothing
              matches that search" when the reader has not searched — they have
              tapped a chip — sends them looking for a search box to clear. */}
          <p className="font-bold text-sm text-gray-600">
            {courses.length === 0
              ? "You haven't joined any classes yet."
              : query.trim()
                ? 'Nothing matches that search.'
                : `No classes under ${categoryLabel(activeCategory)}.`}
          </p>
          {/*
            Every empty state offers the way out of itself.

            Tapping a category with nothing in it is the common case now that
            the bar always shows all six, so that case needs a one-tap route
            back to the full list — otherwise the reader has to work out for
            themselves that a chip is still selected further up the page.
          */}
          {courses.length === 0 ? (
            <button
              type="button"
              onClick={() => navigate('/explore')}
              className="mt-4 px-4 py-2 rounded-full border-2 border-black bg-[#A7E2D1] font-bold text-xs shadow-[2px_2px_0px_0px_#111]"
            >
              Browse courses
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { setCategory('all'); clearQuery(); }}
              className="mt-4 px-4 py-2 rounded-full border-2 border-black bg-[#A7E2D1] font-bold text-xs shadow-[2px_2px_0px_0px_#111]"
            >
              Show all classes
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((c) => (
            <CourseRow key={c.id} course={c} onOpen={() => navigate(`/course/${c.id}`)} />
          ))}
        </div>
      )}

      {/* ------------------------------------------------- available courses

          Published courses in this category the student has not joined.

          Kept in a separate section rather than mixed into the list above,
          because the two are not the same kind of thing: one is work in
          progress, the other is an invitation. Merging them would put a
          course with no progress bar between two that have one and leave the
          reader working out which is which.                                */}
      {available.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="font-black text-sm md:text-lg uppercase">
              {activeCategory === 'all'
                ? 'More courses'
                : `More in ${categoryLabel(activeCategory)}`}
            </h2>
            <span className="text-[11px] font-bold text-gray-500">
              {available.length} available
            </span>
          </div>

          <div className="flex flex-col gap-2">
            {available.map((c) => (
              <AvailableRow
                key={c.id}
                course={c}
                onOpen={() => navigate(`/course/${c.id}`)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A course the student has not joined.
 *
 * Deliberately quieter than CourseRow: no progress bar, because there is no
 * progress, and a 0% bar on something never started reads as falling behind
 * rather than as an invitation. The play button becomes an arrow for the same
 * reason — play implies resuming.
 */
function AvailableRow({ course, onOpen }) {
  const free = !course.price || Number(course.price) === 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className="flex gap-2.5 p-2 rounded-xl border-2 border-black bg-white/70 shadow-[2px_2px_0px_0px_#111] cursor-pointer hover:bg-white hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0px_0px_#111] transition-all"
    >
      <div className="shrink-0 w-14 h-14 rounded-lg border-2 border-black overflow-hidden bg-[#F4DFD8] flex items-center justify-center">
        {course.thumbnail_url ? (
          <img src={resolveMediaUrl(course.thumbnail_url)} alt="" className="w-full h-full object-cover" />
        ) : (
          <BookOpen size={20} strokeWidth={2} className="text-black/40" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="font-black text-sm leading-tight truncate">{course.title}</h3>
        {/* Subjects carry their class name. Two courses called "Physics" under
            different classes are otherwise indistinguishable in this list. */}
        {course.parent_title && (
          <p className="text-[10px] font-bold text-gray-500 truncate">in {course.parent_title}</p>
        )}
        <div className="flex items-center gap-2.5 mt-0.5 text-[10px] font-bold text-gray-500">
          <span className="flex items-center gap-1">
            <BookOpen size={11} strokeWidth={3} /> {course.module_count}
          </span>
          <span className="flex items-center gap-1">
            <Users size={11} strokeWidth={3} /> {course.student_count}
          </span>
          {/* Price stated up front. Finding out at the checkout that a course
              costs money is a worse moment than reading it here. */}
          <span className={`px-1.5 rounded-full ${free ? 'bg-[#A7E2D1]' : 'bg-[#F9E076]'} text-black`}>
            {free ? 'Free' : `₹${course.price}`}
          </span>
        </div>
      </div>

      <div className="shrink-0 self-center w-8 h-8 rounded-full border-2 border-black bg-white flex items-center justify-center shadow-[2px_2px_0px_0px_#111]">
        <ArrowRight size={14} strokeWidth={3} />
      </div>
    </div>
  );
}

function CourseRow({ course, onOpen }) {
  /*
   * Progress against videos, matching what the backend counts.
   *
   * A course with no video yet shows no bar rather than 0% — an empty bar on
   * brand-new material reads as the student having fallen behind on something
   * that does not exist.
   */
  const total = course.video_count ?? 0;
  const done = Math.min(course.videos_watched ?? 0, total);
  const pct = total > 0 ? Math.round((done / total) * 100) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className="flex gap-2.5 p-2 rounded-xl border-2 border-black bg-white shadow-[2px_2px_0px_0px_#111] cursor-pointer hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0px_0px_#111] transition-all"
    >
      <div className="shrink-0 w-14 h-14 rounded-lg border-2 border-black overflow-hidden bg-[#F4DFD8] flex items-center justify-center">
        {course.thumbnail_url ? (
          <img
            src={resolveMediaUrl(course.thumbnail_url)}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : (
          <BookOpen size={20} strokeWidth={2} className="text-black/40" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="font-black text-sm leading-tight truncate">{course.title}</h3>
        {course.parent_title && (
          <p className="text-[11px] font-bold text-gray-500">in {course.parent_title}</p>
        )}
        {/* Counts abbreviated to fit one line beside a 56px thumbnail.
            "42 chapters · 520 students" wrapped on a narrow phone, which made
            every card two lines taller than it needed to be. */}
        <div className="flex items-center gap-2.5 mt-0.5 text-[10px] font-bold text-gray-500">
          <span className="flex items-center gap-1">
            <BookOpen size={11} strokeWidth={3} /> {course.module_count}
          </span>
          <span className="flex items-center gap-1">
            <Users size={11} strokeWidth={3} /> {course.student_count}
          </span>
        </div>

        {pct !== null && (
          <div className="flex items-center gap-1.5 mt-1">
            <div className="flex-1 h-1.5 rounded-full border border-black bg-gray-100 overflow-hidden">
              <div className="h-full bg-[#F26B4D]" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[10px] font-black tabular-nums">{pct}%</span>
          </div>
        )}
      </div>

      <div className="shrink-0 self-center w-8 h-8 rounded-full border-2 border-black bg-[#F26B4D] text-white flex items-center justify-center shadow-[2px_2px_0px_0px_#111]">
        <Play size={13} strokeWidth={3} fill="currentColor" />
      </div>
    </div>
  );
}
