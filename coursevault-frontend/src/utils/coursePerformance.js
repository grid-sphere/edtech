import { sortCourses, classNumber } from './courseOrder.js';

/**
 * Group a flat course list into classes, each carrying its subjects and totals.
 *
 * Extracted from the component rather than left inline, because the totals are
 * the whole value of the Course Performance table and a miscount there is
 * invisible — nobody adds a column up by hand to check. A pure function can be
 * run against known inputs; JSX cannot.
 *
 * (It was inline at first, and the check reproduced the same arithmetic to test
 * it. That check then passed while the component's real totals were broken,
 * because it was verifying its own copy. This exists so there is one
 * implementation to be wrong.)
 *
 * @param {Array<{id, title, parent_course_id?, enrolled_count?, paid_count?, revenue?}>} courses
 * @returns {Array<object>} classes, each with `subjects` and total* fields
 */
export function groupByClass(courses = []) {
  const byId = new Map(courses.map((c) => [c.id, c]));

  /*
   * A subject whose parent is not in the list counts as a class of its own.
   *
   * The parent may have been deleted, or belong to another teacher. Filing it
   * under a group that is never rendered would drop it from the page silently —
   * a course the teacher owns, gone from their own analytics.
   */
  const classes = courses.filter((c) => !c.parent_course_id || !byId.has(c.parent_course_id));

  const childrenOf = new Map();
  for (const c of courses) {
    if (c.parent_course_id && byId.has(c.parent_course_id)) {
      if (!childrenOf.has(c.parent_course_id)) childrenOf.set(c.parent_course_id, []);
      childrenOf.get(c.parent_course_id).push(c);
    }
  }

  return sortCourses(classes).map((cls) => {
    const subjects = sortCourses(childrenOf.get(cls.id) || []);
    /*
     * The class itself is included in its own totals.
     *
     * A student can enrol in the class directly or in one of its subjects, so
     * counting only the subjects would under-report a class that sells both —
     * and would report zero for a class sold as a single package.
     */
    const all = [cls, ...subjects];
    return {
      ...cls,
      subjects,
      totalStudents: all.reduce((n, c) => n + (c.enrolled_count || 0), 0),
      totalPaid: all.reduce((n, c) => n + (c.paid_count || 0), 0),
      totalRevenue: all.reduce((n, c) => n + (c.revenue || 0), 0),
    };
  });
}

/** Totals across every class, for the summary row. */
export function overallTotals(groups = []) {
  return {
    classes: groups.length,
    students: groups.reduce((n, g) => n + g.totalStudents, 0),
    revenue: groups.reduce((n, g) => n + g.totalRevenue, 0),
  };
}

/**
 * Club classes that are the same year but different boards.
 *
 * "10th Class (CBSE)", "10th Class (HPBOSE)" and "10th Class (ICSE)" are one
 * year taught three ways. Listed flat they are three unrelated rows, and the
 * question a teacher actually has — how is class 10 doing — cannot be read off
 * the page without adding three rows up by hand.
 *
 * Grouped on the number in the title, which is the same key classNumber()
 * already uses for sorting, so a title the sorter understands is a title this
 * understands.
 *
 * Two deliberate refusals to group:
 *
 *   - A title with no number — NEET, JEE-Mains, HPCET — never joins a group.
 *     There is no year to club it under, and inventing an "Other" bucket would
 *     hide unrelated courses behind a heading that describes none of them.
 *
 *   - A year with only one class renders as a plain row, with no heading. A
 *     "Class 10" header containing exactly "10th Class (CBSE)" is a level of
 *     nesting that costs a tap and tells the reader nothing they did not
 *     already see.
 *
 * @param {Array} groups output of groupByClass()
 * @returns {Array<{key, year, label, classes, grouped, total*}>}
 */
export function groupByYear(groups = []) {
  const buckets = new Map();
  const out = [];

  for (const g of groups) {
    const year = classNumber(g.title);
    if (year === null) {
      // Stands alone, in place.
      out.push({ key: g.id, year: null, label: g.title, classes: [g], grouped: false });
      continue;
    }
    if (!buckets.has(year)) {
      const bucket = { key: `year-${year}`, year, label: `Class ${year}`, classes: [], grouped: false };
      buckets.set(year, bucket);
      out.push(bucket);
    }
    buckets.get(year).classes.push(g);
  }

  for (const b of out) {
    // A group of one is not a group.
    b.grouped = b.year !== null && b.classes.length > 1;
    b.totalStudents = b.classes.reduce((n, c) => n + (c.totalStudents || 0), 0);
    b.totalPaid = b.classes.reduce((n, c) => n + (c.totalPaid || 0), 0);
    b.totalRevenue = b.classes.reduce((n, c) => n + (c.totalRevenue || 0), 0);
    /* Subjects across every board of this year, for the "N subjects" line. */
    b.subjectCount = b.classes.reduce((n, c) => n + (c.subjects?.length || 0), 0);
  }

  return out;
}
