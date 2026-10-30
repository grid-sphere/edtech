import React, { useEffect, useMemo, useState } from 'react';
import { Users, Search, X, Loader, AlertTriangle, ShieldOff, ShieldCheck, Mail } from 'lucide-react';
import { fetchAPI } from '../../services/api.js';

/**
 * How long ago, in words.
 *
 * "3d ago" beats a timestamp for the question this table answers — a teacher
 * scanning for students who have gone quiet is comparing recency, not reading
 * dates. The exact date stays in the title attribute for when it matters.
 */
function ago(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const mins = ms / 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  const months = days / 30;
  if (months < 12) return `${Math.floor(months)}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

const fullDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

/** Days since a timestamp, or null when it never happened. */
function daysSince(iso) {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

/**
 * Who is enrolled in what, and when they were last here.
 *
 * One row per enrolment rather than per student: a student taking three
 * subjects appears three times, because "enrolled in which course" is the
 * question and collapsing them would hide the answer.
 */
export default function StudentDirectory() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [revokingId, setRevokingId] = useState(null);
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  /*
   * Selection, keyed by enrolment id.
   *
   * Not by student: the same person can hold several enrolments, and revoking
   * "a student" would have to guess which course was meant. The row is the
   * unit of action because the row is what the teacher is looking at.
   *
   * Attempt-only rows have no enrolment id and are deliberately unselectable —
   * there is nothing to revoke or restore, so including them would build a
   * selection where half the actions silently skip half the rows.
   */
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);
  /*
   * Two views over the same rows.
   *
   * Seven columns plus a checkbox scrolled horizontally on a desktop and was
   * unreadable on a phone, because it was answering two unrelated questions at
   * once: "how is this student doing in the course" and "what happened at the
   * till". Splitting them lets each stay narrow.
   *
   * It also resolves what to do with a payment attempt that never became an
   * enrolment. Those rows had no sensible place in a student list — no access,
   * no progress, no enrolment date — and they are the whole point of the
   * payments view.
   */
  const [view, setView] = useState('students');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchAPI('/analytics/students');
        if (!cancelled) setRows(data?.students ?? []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load the student list.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const revokeAccess = async (r) => {
    if (!r.enrollment_id || r.status !== 'active') return;
    const student = r.student_name || 'this student';
    const course = r.course_title || 'this course';
    if (!window.confirm(`Revoke access for ${student} to "${course}"? Their enrollment and payment history will be kept.`)) return;

    setRevokingId(r.enrollment_id);
    setActionError('');
    setActionMessage('');
    try {
      await fetchAPI(`/analytics/enrollments/${encodeURIComponent(r.enrollment_id)}/revoke`, {
        method: 'POST',
      });
      setRows((current) => current.map((row) =>
        row.enrollment_id === r.enrollment_id
          ? { ...row, status: 'inactive' }
          : row
      ));
      setActionMessage(`Access revoked for ${student} — ${course}.`);
    } catch (err) {
      setActionError(err.message || 'Could not revoke access. Please try again.');
    } finally {
      setRevokingId(null);
    }
  };

  const grantAccess = async (r) => {
    if (!r.enrollment_id || !['inactive', 'revoked'].includes(String(r.status || '').toLowerCase())) return;
    const student = r.student_name || 'this student';
    const course = r.course_title || 'this course';
    if (!window.confirm(`Grant access again to ${student} for "${course}"? Existing payment and learning history will be kept.`)) return;

    setRevokingId(r.enrollment_id);
    setActionError('');
    setActionMessage('');
    try {
      await fetchAPI(`/analytics/enrollments/${encodeURIComponent(r.enrollment_id)}/grant`, {
        method: 'POST',
      });
      setRows((current) => current.map((row) =>
        row.enrollment_id === r.enrollment_id
          ? { ...row, status: 'active' }
          : row
      ));
      setActionMessage(`Access granted again for ${student} — ${course}.`);
    } catch (err) {
      setActionError(err.message || 'Could not grant access. Please try again.');
    } finally {
      setRevokingId(null);
    }
  };

  const toggleOne = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  /**
   * Apply one action to every selected row that it makes sense for.
   *
   * Sequential, not Promise.all: these are writes against the same few rows,
   * and firing twenty at once gives the server no chance to reject the
   * twentieth for a reason caused by the first. It is also the only way to
   * report honest progress.
   *
   * Failures are counted rather than thrown. Stopping halfway through a bulk
   * revoke leaves the teacher with no idea which half happened.
   */
  const runBulk = async (kind) => {
    const verb = kind === 'revoke' ? 'Revoke' : 'Grant';
    const eligible = rows.filter((r) =>
      selected.has(r.enrollment_id) &&
      (kind === 'revoke'
        ? r.status === 'active'
        : ['inactive', 'revoked'].includes(String(r.status || '').toLowerCase()))
    );

    if (eligible.length === 0) {
      setActionError(`None of the selected rows can be ${kind === 'revoke' ? 'revoked' : 'granted'} — check their current access.`);
      return;
    }

    const skipped = selected.size - eligible.length;
    const warning = skipped > 0 ? `\n\n${skipped} selected row(s) are already in that state and will be skipped.` : '';
    if (!window.confirm(`${verb} access for ${eligible.length} enrolment(s)?${warning}`)) return;

    setBulkBusy(true);
    setActionError('');
    setActionMessage('');
    let done = 0;
    const failed = [];

    for (const r of eligible) {
      setBulkProgress(`${verb.toLowerCase().replace(/e$/, 'ing')} ${done + 1} of ${eligible.length}…`);
      try {
        await fetchAPI(`/analytics/enrollments/${encodeURIComponent(r.enrollment_id)}/${kind}`, {
          method: 'POST',
        });
        const nextStatus = kind === 'revoke' ? 'inactive' : 'active';
        setRows((cur) => cur.map((row) =>
          row.enrollment_id === r.enrollment_id ? { ...row, status: nextStatus } : row
        ));
        done++;
      } catch (err) {
        failed.push(`${r.student_name}: ${err.message || 'failed'}`);
      }
    }

    setBulkBusy(false);
    setBulkProgress(null);
    setSelected(new Set());
    setActionMessage(`${verb}d access for ${done} enrolment(s).`);
    if (failed.length) setActionError(`${failed.length} failed — ${failed.slice(0, 3).join('; ')}`);
  };

  const courses = useMemo(() => {
    const seen = new Map();
    for (const r of rows) if (!seen.has(r.course_id)) seen.set(r.course_id, r.course_title);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (courseFilter && r.course_id !== courseFilter) return false;
      if (!q) return true;
      return (
        r.student_name?.toLowerCase().includes(q) ||
        r.student_email?.toLowerCase().includes(q) ||
        r.student_phone?.includes(q) ||
        r.course_title?.toLowerCase().includes(q)
      );
    });
  }, [rows, query, courseFilter]);

  /*
   * Students: anyone actually enrolled.
   * Payments: anyone who has ever reached checkout, enrolled or not.
   *
   * A row can legitimately appear in both — a student who paid and is studying
   * is a fact about their access and a fact about a sale. Forcing it into one
   * would mean one of the two views lied about its own total.
   */
  const shown = useMemo(() => {
    if (view === 'payments') return filtered.filter((r) => Number(r.payment_attempts || 0) > 0);
    return filtered.filter((r) => r.enrollment_id);
  }, [filtered, view]);

  const counts = useMemo(() => ({
    students: filtered.filter((r) => r.enrollment_id).length,
    payments: filtered.filter((r) => Number(r.payment_attempts || 0) > 0).length,
    unfinished: filtered.filter((r) => ['created', 'failed'].includes(String(r.last_payment_status || '').toLowerCase())).length,
  }), [filtered]);

  /*
   * The rows a checkbox can apply to, among those currently shown.
   *
   * Scoped to `filtered` rather than `rows` so select-all means "everything I
   * can see". Selecting rows hidden behind a search is how a bulk revoke
   * reaches a class the teacher was not even looking at.
   */
  const selectableShown = useMemo(
    () => shown.filter((r) => r.enrollment_id),
    [shown]
  );

  /*
   * Drop selections that have scrolled out of scope.
   *
   * Without this, selecting ten rows and then typing in the search box leaves
   * them selected but invisible — and the action bar still says ten, so a
   * revoke hits rows the teacher can no longer see.
   */
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(selectableShown.map((r) => r.enrollment_id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectableShown]);

  // Counted from all rows, not the filtered view: a summary that changes as
  // you type is describing your search, not your class.
  const neverLoggedIn = useMemo(
    () => new Set(rows.filter((r) => !r.last_login).map((r) => r.student_id)).size,
    [rows]
  );
  const uniqueStudents = useMemo(
    () => new Set(rows.map((r) => r.student_id)).size,
    [rows]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 font-bold text-gray-500">
        <Loader size={18} className="animate-spin" /> Loading students...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 border-2 border-red-500 bg-red-50 rounded-xl font-bold text-red-700 text-sm">
        {error}
      </div>
    );
  }

  return (
    <section className="border-[3px] border-black rounded-2xl bg-white p-4 md:p-6 shadow-[6px_6px_0px_0px_#111]">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <Users size={20} strokeWidth={3} />
        <h2 className="font-black text-lg md:text-xl uppercase">Students</h2>
        <span className="ml-auto text-xs font-bold text-gray-500">
          {uniqueStudents} student{uniqueStudents === 1 ? '' : 's'} · {rows.length} enrolment{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {neverLoggedIn > 0 && (
        <p className="flex items-center gap-1.5 text-xs font-bold text-[#F26B4D] mb-3">
          <AlertTriangle size={13} strokeWidth={3} />
          {neverLoggedIn} student{neverLoggedIn === 1 ? ' has' : 's have'} never signed in
        </p>
      )}

      {actionError && (
        <p role="alert" className="mb-3 rounded-lg border-2 border-red-500 bg-red-50 p-2 text-sm font-bold text-red-700">
          {actionError}
        </p>
      )}
      {actionMessage && (
        <p role="status" className="mb-3 rounded-lg border-2 border-black bg-[#A7E2D1] p-2 text-sm font-bold text-black">
          {actionMessage}
        </p>
      )}

      {/* ------------------------------------------------------------ filters */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={15} strokeWidth={3} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, mobile or course"
            className="w-full pl-9 pr-9 py-2 rounded-xl border-2 border-black font-medium text-sm focus:outline-none focus:shadow-[3px_3px_0px_0px_#F26B4D]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-gray-400 hover:text-black"
            >
              <X size={14} strokeWidth={3} />
            </button>
          )}
        </div>

        <select
          value={courseFilter}
          onChange={(e) => setCourseFilter(e.target.value)}
          className="px-3 py-2 rounded-xl border-2 border-black font-bold text-sm bg-white"
        >
          <option value="">All courses</option>
          {courses.map(([id, title]) => (
            <option key={id} value={id}>{title}</option>
          ))}
        </select>
      </div>

      {/*
        Two views, underlined like the curriculum tabs rather than boxed —
        these switch what the table is about, which is a navigation act, not a
        filter sitting alongside the search box.
      */}
      <div className="mb-3 flex items-stretch gap-6 border-b-2 border-black">
        {[
          ['students', 'Students', counts.students],
          ['payments', 'Payments', counts.payments],
        ].map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            aria-current={view === id ? 'page' : undefined}
            className={`relative shrink-0 px-1 pt-1 pb-2.5 text-sm font-bold transition-colors ${
              view === id ? 'text-black' : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {label}
            <span className={`ml-1.5 text-xs font-black tabular-nums ${view === id ? 'text-black/40' : 'text-gray-300'}`}>
              {n}
            </span>
            {/* Unfinished payments are the actionable number, so it is called
                out on the tab rather than waiting to be discovered inside. */}
            {id === 'payments' && counts.unfinished > 0 && (
              <span className="ml-1.5 rounded-full bg-[#F26B4D] px-1.5 py-0.5 text-[10px] font-black text-white">
                {counts.unfinished} unfinished
              </span>
            )}
            <span
              aria-hidden="true"
              className={`absolute left-0 right-0 bottom-0 h-[3px] rounded-full ${view === id ? 'bg-[#F26B4D]' : 'bg-transparent'}`}
            />
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-10 text-center font-bold text-sm text-gray-500">
          {rows.length === 0
            ? 'Nobody has enrolled in your courses yet.'
            : 'No students match that search.'}
        </p>
      ) : (
        <>
          {/*
            The action bar.
            --------------------------------------------------------------
            Actions live here rather than one button per row, because the thing
            a teacher does at the end of term is revoke thirty enrolments, not
            one — and thirty confirmation dialogs is not a feature.

            It only appears once something is selected. A permanently visible
            toolbar of disabled buttons is a worse default: it occupies the top
            of the table saying "no" before anyone has asked for anything.
          */}
          {selected.size > 0 && (
            <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border-2 border-black bg-[#F9E076] px-3 py-2 shadow-[3px_3px_0px_0px_#111]">
              <span className="font-black text-sm">
                {selected.size} selected
              </span>

              <button
                type="button"
                onClick={() => runBulk('revoke')}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1 rounded-lg border-2 border-black bg-[#F26B4D] px-2.5 py-1 text-xs font-black text-white disabled:opacity-50"
              >
                <ShieldOff size={12} /> Revoke access
              </button>

              <button
                type="button"
                onClick={() => runBulk('grant')}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1 rounded-lg border-2 border-black bg-[#18794E] px-2.5 py-1 text-xs font-black text-white disabled:opacity-50"
              >
                <ShieldCheck size={12} /> Grant access
              </button>

              {/* Opens one draft addressed to everyone selected. BCC, not To:
                  a teacher mailing thirty students should not hand each of them
                  the other twenty-nine addresses. */}
              <a
                href={`mailto:?bcc=${encodeURIComponent(
                  [...new Set(rows.filter((r) => selected.has(r.enrollment_id)).map((r) => r.student_email).filter(Boolean))].join(',')
                )}`}
                className="inline-flex items-center gap-1 rounded-lg border-2 border-black bg-white px-2.5 py-1 text-xs font-black"
              >
                <Mail size={12} /> Email selected
              </a>

              <button
                type="button"
                onClick={() => setSelected(new Set())}
                disabled={bulkBusy}
                className="ml-auto inline-flex items-center gap-1 rounded-lg border-2 border-black bg-white px-2.5 py-1 text-xs font-black disabled:opacity-50"
              >
                <X size={12} /> Clear
              </button>

              {bulkBusy && (
                <span className="flex w-full items-center gap-1.5 text-xs font-bold">
                  <Loader size={12} className="animate-spin" /> {bulkProgress}
                </span>
              )}
            </div>
          )}

          {/* --------------------------------------------------- desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b-2 border-black">
                  <th className="py-2 pr-2 w-8">
                    {/*
                      Select-all applies to what is on screen, not to every row
                      loaded — with a search or course filter active, selecting
                      rows the teacher cannot see is how a bulk revoke hits the
                      wrong class.
                    */}
                    <input
                      type="checkbox"
                      aria-label="Select all shown"
                      className="h-4 w-4 accent-black"
                      checked={selectableShown.length > 0 && selectableShown.every((r) => selected.has(r.enrollment_id))}
                      ref={(el) => {
                        if (el) {
                          const n = selectableShown.filter((r) => selected.has(r.enrollment_id)).length;
                          el.indeterminate = n > 0 && n < selectableShown.length;
                        }
                      }}
                      onChange={(e) => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          for (const r of selectableShown) {
                            if (e.target.checked) next.add(r.enrollment_id);
                            else next.delete(r.enrollment_id);
                          }
                          return next;
                        });
                      }}
                    />
                  </th>
                  <th className="py-2 pr-3 font-black uppercase text-xs">Student</th>
                  <th className="py-2 pr-3 font-black uppercase text-xs">Course</th>
                  {view === 'students' ? (
                    <>
                      <th className="py-2 pr-3 font-black uppercase text-xs">Access</th>
                      <th className="py-2 pr-2 font-black uppercase text-xs">Last login</th>
                    </>
                  ) : (
                    <>
                      <th className="py-2 pr-3 font-black uppercase text-xs">Payment</th>
                      <th className="py-2 pr-3 font-black uppercase text-xs">Attempts</th>
                      <th className="py-2 pr-3 font-black uppercase text-xs">Amount</th>
                      <th className="py-2 pr-2 font-black uppercase text-xs">Last tried</th>
                    </>
                  )}
                  <th className="py-2 font-black uppercase text-xs">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <StudentRow
                    key={r.enrollment_id ?? `${r.student_id}-${r.course_id}`}
                    r={r}
                    view={view}
                    onRevoke={revokeAccess}
                    onGrant={grantAccess}
                    revoking={revokingId === r.enrollment_id}
                    checked={selected.has(r.enrollment_id)}
                    onToggle={() => toggleOne(r.enrollment_id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* ---------------------------------------------------- mobile cards */}
          <div className="md:hidden flex flex-col gap-2">
            {shown.map((r) => (
              <StudentCard
                key={r.enrollment_id ?? `${r.student_id}-${r.course_id}`}
                r={r}
                view={view}
                onRevoke={revokeAccess}
                onGrant={grantAccess}
                revoking={revokingId === r.enrollment_id}
                checked={selected.has(r.enrollment_id)}
                onToggle={() => toggleOne(r.enrollment_id)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Shared derivation so the table and the cards cannot disagree. */
function useRowState(r) {
  const lapsed = r.expires_at && new Date(r.expires_at) <= new Date();
  const stale = daysSince(r.last_login);
  const status = String(r.status || '').toLowerCase();
  const accessLabel = status !== 'active'
    ? (status === 'inactive' || status === 'revoked' ? 'Access revoked / inactive' : status || 'Unknown')
    : (r.payment_status && r.payment_status !== 'completed' && Number(r.amount_paid) > 0
        ? `Payment ${r.payment_status}`
        : r.expires_at
          ? (lapsed ? 'Expired' : new Date(r.expires_at).toLocaleDateString())
          : 'Lifetime');
  /*
   * Payment, derived separately from access.
   *
   * These were one column and they answer different questions. Access is "can
   * they open the course right now"; payment is "what happened at the till".
   * A student can have paid and had access revoked, or be studying free, or
   * have tried to pay three times and failed — and the merged label could only
   * ever say one of those things.
   *
   * The order matters: an abandoned or failed attempt outranks a completed one
   * in the display, because a row with both means they paid once and have since
   * tried again and got stuck, which is the thing worth seeing.
   */
  const paidAmount = Number(r.paid_amount ?? r.amount_paid ?? 0);
  const last = String(r.last_payment_status || '').toLowerCase();
  const attempts = Number(r.payment_attempts || 0);

  let payment;
  if (last === 'created') {
    // Written when checkout opens, never advanced. They started and walked away.
    payment = { label: 'Abandoned', tone: 'amber', detail: 'Started checkout, never completed' };
  } else if (last === 'failed') {
    payment = { label: 'Failed', tone: 'red', detail: `${r.failed_attempts || 1} failed attempt(s)` };
  } else if (last === 'completed' || paidAmount > 0) {
    payment = {
      label: paidAmount > 0 ? `Paid ₹${paidAmount.toLocaleString('en-IN')}` : 'Paid',
      tone: 'green',
      detail: r.paid_at ? `Paid ${ago(r.paid_at)}` : null,
    };
  } else if (r.enrolled_without_payment) {
    payment = { label: 'Free / granted', tone: 'grey', detail: 'Enrolled without a payment' };
  } else {
    payment = { label: '—', tone: 'grey', detail: null };
  }

  return {
    lapsed,
    accessLabel,
    lastLogin: r.last_login ? ago(r.last_login) : 'Never',
    // Highlighted rather than merely stated: never, or quiet for a fortnight.
    // Both are the teacher's cue to reach out, which is the point of the column.
    lastLoginWarning: !r.last_login || (stale !== null && stale > 14),
    payment,
    attempts,
    // No enrolment row at all — they exist in this table only because they
    // tried to pay. There is nothing to revoke, and the useful action is to
    // contact them.
    attemptOnly: !r.enrollment_id,
  };
}

/** Colour for a payment pill. Kept out of the row so both views match. */
const PAY_TONE = {
  green: 'bg-[#A7E2D1] text-[#04342C]',
  amber: 'bg-[#F9E076] text-[#412402]',
  red: 'bg-[#F7C1C1] text-[#501313]',
  grey: 'bg-gray-100 text-gray-600',
};

function StudentRow({ r, view, onRevoke, onGrant, revoking, checked, onToggle }) {
  const { lapsed, accessLabel, lastLogin, lastLoginWarning, payment, attempts, attemptOnly } =
    useRowState(r);

  return (
    <tr className={`border-b border-gray-200 last:border-b-0 hover:bg-gray-50 ${checked ? 'bg-[#FFF9E0]' : ''}`}>
      <td className="py-2.5 pr-2">
        {/* Attempt-only rows have no enrolment, so there is nothing a bulk
            action could do to them. An empty cell is more honest than a
            checkbox that silently does nothing when ticked. */}
        {attemptOnly ? (
          <span className="block h-4 w-4" aria-hidden="true" />
        ) : (
          <input
            type="checkbox"
            className="h-4 w-4 accent-black"
            checked={checked}
            onChange={onToggle}
            aria-label={`Select ${r.student_name} — ${r.course_title}`}
          />
        )}
      </td>
      <td className="py-2.5 pr-3">
        <div className="font-bold">{r.student_name}</div>
        <div className="text-xs text-gray-500 break-all">{r.student_email}</div>
        {r.student_phone && <div className="text-xs text-gray-500">{r.student_phone}</div>}
      </td>
      <td className="py-2.5 pr-3">
        <div className="font-medium">{r.course_title}</div>
        {r.parent_course_title && (
          <div className="text-xs text-gray-500">in {r.parent_course_title}</div>
        )}
        {r.class_level && (
          <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded-full border border-black text-[10px] font-bold bg-[#F9E076]">
            {r.class_level}
          </span>
        )}
      </td>
      {view === 'students' ? (
        <>
          <td className="py-2.5 pr-3 whitespace-nowrap">
            <span className={`font-bold ${lapsed ? 'text-[#E63946]' : ''}`}>{accessLabel}</span>
            {/* The enrolment date, demoted to a second line. It is context for
                the access state, not a column anyone scans on its own. */}
            <div className="text-[11px] font-medium text-gray-500" title={fullDate(r.enrolled_at)}>
              since {r.enrolled_at ? new Date(r.enrolled_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'}
            </div>
          </td>
          <td className="py-2.5 pr-2 whitespace-nowrap" title={fullDate(r.last_login)}>
            <span className={`font-bold ${lastLoginWarning ? 'text-[#F26B4D]' : ''}`}>{lastLogin}</span>
          </td>
        </>
      ) : (
        <>
          <td className="py-2.5 pr-3 whitespace-nowrap" title={payment.detail || undefined}>
            <span className={`inline-block rounded-full border border-black/15 px-2 py-0.5 text-[11px] font-black ${PAY_TONE[payment.tone]}`}>
              {payment.label}
            </span>
          </td>
          <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums">
            {attempts || '—'}
            {/* Only worth breaking down when something went wrong. */}
            {(r.failed_attempts > 0 || r.abandoned_attempts > 0) && (
              <div className="text-[11px] font-medium text-gray-500">
                {[
                  r.failed_attempts > 0 ? `${r.failed_attempts} failed` : null,
                  r.abandoned_attempts > 0 ? `${r.abandoned_attempts} abandoned` : null,
                ].filter(Boolean).join(', ')}
              </div>
            )}
          </td>
          <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums font-bold">
            {Number(r.paid_amount ?? 0) > 0 ? `₹${Number(r.paid_amount).toLocaleString('en-IN')}` : '—'}
          </td>
          <td className="py-2.5 pr-2 whitespace-nowrap" title={fullDate(r.last_attempt_at)}>
            {r.last_attempt_at ? ago(r.last_attempt_at) : '—'}
          </td>
        </>
      )}
      <td className="py-2.5 whitespace-nowrap">
        {/*
          An attempt-only row has no enrolment, so there is nothing to revoke or
          restore. Offering a disabled Revoke button would say "you may not do
          this", when the truth is there is nothing to do it to — emailing them
          is the action that exists.
        */}
        {attemptOnly ? (
          <a
            href={`mailto:${r.student_email}?subject=${encodeURIComponent(`Completing your enrolment in ${r.course_title}`)}`}
            className="inline-flex items-center gap-1 rounded-lg border-2 border-black bg-[#F9E076] px-2 py-1 text-xs font-black"
          >
            <Mail size={12} /> Follow up
          </a>
        ) : r.status === 'active' ? (
          <button
            type="button"
            onClick={() => onRevoke(r)}
            disabled={revoking}
            className="inline-flex items-center gap-1 rounded-lg border-2 border-black bg-[#F26B4D] px-2 py-1 text-xs font-black text-white disabled:opacity-50"
          >
            {revoking ? <Loader size={12} className="animate-spin" /> : <ShieldOff size={12} />}
            {revoking ? 'Revoking…' : 'Revoke access'}
          </button>
        ) : (r.status === 'inactive' || r.status === 'revoked') ? (
          <button
            type="button"
            onClick={() => onGrant(r)}
            disabled={revoking}
            className="inline-flex items-center gap-1 rounded-lg border-2 border-black bg-[#18794E] px-2 py-1 text-xs font-black text-white disabled:opacity-50"
          >
            {revoking ? <Loader size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
            {revoking ? 'Granting…' : 'Grant access again'}
          </button>
        ) : (
          <span className="text-xs font-bold text-gray-500">—</span>
        )}
      </td>
    </tr>
  );
}

function StudentCard({ r, view, onRevoke, onGrant, revoking, checked, onToggle }) {
  const { lapsed, accessLabel, lastLogin, lastLoginWarning, payment, attempts, attemptOnly } =
    useRowState(r);

  return (
    <div className={`border-2 border-black rounded-xl p-3 shadow-[2px_2px_0px_0px_#111] ${checked ? 'bg-[#FFF9E0]' : 'bg-white'}`}>
      <div className="flex items-start justify-between gap-2">
        {!attemptOnly && (
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 accent-black"
            checked={checked}
            onChange={onToggle}
            aria-label={`Select ${r.student_name} — ${r.course_title}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-bold text-sm truncate">{r.student_name}</div>
          <div className="text-xs text-gray-500 break-all">{r.student_email}</div>
        </div>
        <span
          className={`shrink-0 px-2 py-0.5 rounded-full border-2 border-black text-[10px] font-bold ${
            lastLoginWarning ? 'bg-[#F26B4D] text-white' : 'bg-[#A7E2D1]'
          }`}
          title={fullDate(r.last_login)}
        >
          {lastLogin}
        </span>
      </div>

      <div className="mt-2 text-xs font-medium">
        <span className="font-bold">{r.course_title}</span>
        {r.parent_course_title && <span className="text-gray-500"> · in {r.parent_course_title}</span>}
      </div>

      {/* The card shows whichever story the current view is about, so the two
          halves of the UI never disagree about what is being looked at. */}
      {view === 'students' ? (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-600">
          <span title={fullDate(r.enrolled_at)}>
            Enrolled {r.enrolled_at ? new Date(r.enrolled_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'}
          </span>
          <span className={lapsed || r.status !== 'active' ? 'text-[#E63946] font-bold' : ''}>Access: {accessLabel}</span>
        </div>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`inline-block rounded-full border border-black/15 px-2 py-0.5 text-[11px] font-black ${PAY_TONE[payment.tone]}`}>
            {payment.label}
          </span>
          {Number(r.paid_amount ?? 0) > 0 && (
            <span className="text-[11px] font-black tabular-nums">
              ₹{Number(r.paid_amount).toLocaleString('en-IN')}
            </span>
          )}
          {attempts > 1 && <span className="text-[11px] font-bold text-gray-500">{attempts} attempts</span>}
          {r.last_attempt_at && (
            <span className="text-[11px] text-gray-500" title={fullDate(r.last_attempt_at)}>
              last tried {ago(r.last_attempt_at)}
            </span>
          )}
        </div>
      )}

      {attemptOnly && (
        <a
          href={`mailto:${r.student_email}?subject=${encodeURIComponent(`Completing your enrolment in ${r.course_title}`)}`}
          className="mt-3 inline-flex items-center gap-1 rounded-lg border-2 border-black bg-[#F9E076] px-3 py-2 text-xs font-black"
        >
          <Mail size={12} /> Follow up
        </a>
      )}
      {!attemptOnly && r.status === 'active' && (
        <button
          type="button"
          onClick={() => onRevoke(r)}
          disabled={revoking}
          className="mt-3 inline-flex items-center gap-1 rounded-lg border-2 border-black bg-[#F26B4D] px-3 py-2 text-xs font-black text-white disabled:opacity-50"
        >
          {revoking ? <Loader size={12} className="animate-spin" /> : <ShieldOff size={12} />}
          {revoking ? 'Revoking…' : 'Revoke access'}
        </button>
      )}
      {(r.status === 'inactive' || r.status === 'revoked') && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-xs font-black text-red-600">Access revoked / inactive</p>
          <button
            type="button"
            onClick={() => onGrant(r)}
            disabled={revoking}
            className="inline-flex items-center gap-1 rounded-lg border-2 border-black bg-[#18794E] px-3 py-2 text-xs font-black text-white disabled:opacity-50"
          >
            {revoking ? <Loader size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
            {revoking ? 'Granting…' : 'Grant access again'}
          </button>
        </div>
      )}
    </div>
  );
}
