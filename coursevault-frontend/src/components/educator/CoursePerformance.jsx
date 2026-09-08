import React, { useMemo, useState } from 'react';
import { Download, Search, X, ChevronDown, ChevronRight, Users, IndianRupee, BookOpen } from 'lucide-react';
import { groupByClass, groupByYear, overallTotals } from '../../utils/coursePerformance.js';

/**
 * Course Performance.
 *
 * This was one flat list of every course the teacher owns — classes and the
 * subjects inside them as siblings, in upload order, five columns wide. With a
 * handful of courses that is a table; with thirty it is a wall, and the two
 * questions a teacher actually opens this page to answer are unanswerable from
 * it: which class is doing well, and where is the money coming from.
 *
 * So: subjects fold into their class, each class carries its own totals, and
 * the list can be searched and reordered by the thing being asked about. The
 * numbers are unchanged — this is a different arrangement of the same data,
 * plus revenue, which was the obvious absence.
 */

const formatCurrency = (n) =>
  `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/** Sort options, in the order a teacher is likely to want them. */
const SORTS = [
  { id: 'order',    label: 'Your order' },
  { id: 'students', label: 'Most students' },
  { id: 'revenue',  label: 'Most revenue' },
  { id: 'title',    label: 'A–Z' },
];

export default function CoursePerformance({ courses = [], onExport }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('order');
  const [open, setOpen] = useState(() => new Set());

  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  /**
   * Classes, each with its subjects and the totals of both.
   *
   * A class's own enrolments are counted alongside its subjects' because a
   * student can be enrolled either way — the class total has to answer "how
   * many people are studying this", not "how many rows point at this id".
   */
  /*
   * The grouping and the totals live in utils/coursePerformance.js.
   *
   * They were inline here, and the check that verified them reproduced the same
   * arithmetic — so it passed while the component's real totals were broken,
   * because it was testing its own copy. A pure function can be run against
   * known inputs; JSX cannot.
   */
  const groups = useMemo(() => groupByClass(courses), [courses]);
  /*
   * One more level: the same year taught to different boards is one thing.
   *
   * "10th Class (CBSE)" and "10th Class (HPBOSE)" are class 10 twice, and a
   * teacher asking how class 10 is doing had to add the rows up themselves. A
   * year with only one board, or a course with no year in its title at all,
   * renders as a plain row — see groupByYear for why.
   */
  const years = useMemo(() => groupByYear(groups), [groups]);

  /*
   * Search matches a subject as well as its class, and keeps the class visible
   * when it does — hiding the parent would make the matching subject
   * unreachable, since subjects only appear inside an expanded class.
   */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    /*
     * A match at any depth keeps the whole branch. Searching "physics" must
     * leave its class visible, and that class's year group with it — a subject
     * only renders inside an expanded class, inside an expanded year.
     */
    const matched = !q
      ? years
      : years.filter((y) =>
          y.label?.toLowerCase().includes(q) ||
          y.classes.some(
            (g) =>
              g.title?.toLowerCase().includes(q) ||
              g.subjects.some((s) => s.title?.toLowerCase().includes(q))
          )
        );

    const sorted = [...matched];
    if (sort === 'students') sorted.sort((a, b) => b.totalStudents - a.totalStudents);
    else if (sort === 'revenue') sorted.sort((a, b) => b.totalRevenue - a.totalRevenue);
    else if (sort === 'title') sorted.sort((a, b) => (a.label || '').localeCompare(b.label || ''));
    // 'order' is the arrangement the years already arrived in.
    return sorted;
  }, [years, query, sort]);

  const totals = useMemo(() => overallTotals(groups), [groups]);

  if (courses.length === 0) {
    return (
      <div className="bg-white border-[3px] border-black rounded-[20px] p-8 text-center font-bold text-gray-500 shadow-[4px_4px_0px_0px_#111]">
        No courses yet.
      </div>
    );
  }

  return (
    <div>
      {/* Totals first: the summary a teacher wants before any individual row. */}
      <div className="grid grid-cols-3 gap-2 md:gap-3 mb-3">
        <Summary icon={BookOpen} label="Classes" value={totals.classes} tone="bg-[#F9E076]" />
        <Summary icon={Users} label="Students" value={totals.students} tone="bg-[#A7E2D1]" />
        <Summary icon={IndianRupee} label="Revenue" value={formatCurrency(totals.revenue)} tone="bg-[#F4DFD8]" />
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="relative flex-1 min-w-0">
          <Search size={15} strokeWidth={3} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search classes and subjects..."
            className="w-full h-10 pl-8 pr-8 border-2 border-black rounded-xl font-bold text-sm bg-white"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500"
            >
              <X size={15} strokeWidth={3} />
            </button>
          )}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          aria-label="Sort by"
          className="h-10 px-2 border-2 border-black rounded-xl font-bold text-sm bg-white shrink-0"
        >
          {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>

      {visible.length === 0 ? (
        <div className="border-2 border-black rounded-xl bg-white p-6 text-center font-bold text-sm text-gray-600">
          Nothing matches “{query}”.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((y) =>
            /*
             * A year with one board is rendered as that board, not as a group
             * wrapping it. Nesting "10th Class (CBSE)" inside a "Class 10"
             * header costs a tap and says nothing new.
             */
            y.grouped ? (
              <YearGroup
                key={y.key}
                year={y}
                open={open}
                toggle={toggle}
                onExport={onExport}
              />
            ) : (
              <ClassRow
                key={y.classes[0].id}
                cls={y.classes[0]}
                expanded={open.has(y.classes[0].id)}
                onToggle={() => toggle(y.classes[0].id)}
                onExport={onExport}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One year, several boards.
 *
 * Carries the combined figures so "how is class 10 doing" is readable without
 * expanding anything; the boards underneath answer "which board".
 */
function YearGroup({ year, open, toggle, onExport }) {
  const expanded = open.has(year.key);
  return (
    <div className="border-2 border-black rounded-xl bg-[#F9E076] shadow-[2px_2px_0px_0px_#111] overflow-hidden">
      <div className="flex items-center gap-2 p-2.5">
        <button
          onClick={() => toggle(year.key)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
          className="shrink-0 w-7 h-7 flex items-center justify-center border-2 border-black rounded-lg bg-white"
        >
          {expanded ? <ChevronDown size={14} strokeWidth={3} /> : <ChevronRight size={14} strokeWidth={3} />}
        </button>

        <div className="min-w-0 flex-1">
          <h3 className="font-black text-sm leading-tight truncate">{year.label}</h3>
          <p className="text-[10px] font-bold text-black/60">
            {year.classes.length} boards
            {year.subjectCount > 0 && ` · ${year.subjectCount} subjects`}
          </p>
        </div>

        <Stat value={year.totalStudents} label="students" />
        <Stat value={formatCurrency(year.totalRevenue)} label="revenue" wide />
        {/* No export at this level: a CSV spanning several boards would need a
            column saying which, and the per-board files already say it by
            being separate. */}
        <div className="w-8 shrink-0" aria-hidden="true" />
      </div>

      {expanded && (
        <div className="border-t-2 border-black/20 bg-white p-1.5 flex flex-col gap-1.5">
          {year.classes.map((cls) => (
            <ClassRow
              key={cls.id}
              cls={cls}
              expanded={open.has(cls.id)}
              onToggle={() => toggle(cls.id)}
              onExport={onExport}
              nested
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One class — a board of a year, or a standalone course like NEET. */
function ClassRow({ cls: g, expanded, onToggle, onExport, nested = false }) {
  return (
    <div className={`border-2 border-black rounded-xl bg-white overflow-hidden ${
      nested ? '' : 'shadow-[2px_2px_0px_0px_#111]'
    }`}>
      <div className="flex items-center gap-2 p-2.5">
        <button
          onClick={() => g.subjects.length && onToggle()}
          disabled={!g.subjects.length}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
          className="shrink-0 w-7 h-7 flex items-center justify-center border-2 border-black rounded-lg bg-white disabled:opacity-25"
        >
          {expanded ? <ChevronDown size={14} strokeWidth={3} /> : <ChevronRight size={14} strokeWidth={3} />}
        </button>

        <div className="min-w-0 flex-1">
          <h3 className="font-black text-sm leading-tight truncate">{g.title}</h3>
          <p className="text-[10px] font-bold text-gray-500">
            {g.subjects.length > 0
              ? `${g.subjects.length} subject${g.subjects.length === 1 ? '' : 's'}`
              : formatCurrency(g.price)}
            {g.status !== 'published' && ' · Draft'}
          </p>
        </div>

        <Stat value={g.totalStudents} label="students" />
        <Stat value={formatCurrency(g.totalRevenue)} label="revenue" wide />

        <button
          onClick={() => onExport(g.id, g.title)}
          aria-label={`Export ${g.title} as CSV`}
          className="shrink-0 w-8 h-8 flex items-center justify-center bg-[#F26B4D] border-2 border-black rounded-lg shadow-[2px_2px_0px_0px_#111] active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-all"
        >
          <Download size={14} strokeWidth={3} />
        </button>
      </div>

      {expanded && g.subjects.length > 0 && (
        <div className="border-t-2 border-black/10 bg-[#FAFAFA]">
          {g.subjects.map((s) => (
            <div key={s.id} className="flex items-center gap-2 px-2.5 py-2 pl-11 border-b border-black/5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="font-bold text-xs truncate">{s.title}</p>
                <p className="text-[10px] font-bold text-gray-500">
                  {formatCurrency(s.price)}
                  {s.status !== 'published' && ' · Draft'}
                </p>
              </div>
              <Stat value={s.enrolled_count} label="students" small />
              <Stat value={formatCurrency(s.revenue)} label="revenue" small wide />
              <button
                onClick={() => onExport(s.id, s.title)}
                aria-label={`Export ${s.title} as CSV`}
                className="shrink-0 w-7 h-7 flex items-center justify-center bg-white border-2 border-black rounded-lg"
              >
                <Download size={12} strokeWidth={3} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Summary({ icon: Icon, label, value, tone }) {
  return (
    <div className={`border-2 border-black rounded-xl p-2 md:p-3 ${tone} shadow-[2px_2px_0px_0px_#111]`}>
      <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider">
        <Icon size={12} strokeWidth={3} /> {label}
      </div>
      <div className="font-black text-base md:text-2xl mt-0.5 truncate">{value}</div>
    </div>
  );
}

/*
 * Tabular figures, so the numbers line up column-wise down the list rather than
 * jittering with the width of each digit — the whole point of putting them in a
 * column is being able to compare them vertically.
 */
function Stat({ value, label, small = false, wide = false }) {
  return (
    <div className={`shrink-0 text-right ${wide ? 'w-16 md:w-24' : 'w-10 md:w-14'}`}>
      <div className={`font-black tabular-nums truncate ${small ? 'text-xs' : 'text-sm'}`}>{value}</div>
      <div className="text-[9px] font-bold uppercase tracking-wider text-gray-500">{label}</div>
    </div>
  );
}
