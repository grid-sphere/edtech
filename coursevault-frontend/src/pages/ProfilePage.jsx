import React, { useState, useEffect } from 'react';
import {
  User, Mail, Phone, Lock, Check, AlertTriangle, LogOut, Trash2,
  GraduationCap, BookOpen, MapPin, School,
} from 'lucide-react';
import { fetchAPI } from '../services/api';
import AppearanceButton from '../components/ui/AppearanceButton.jsx';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Button from '../components/ui/Button';
import PasswordInput from '../components/ui/PasswordInput';
import { BOARDS, STATES } from '../utils/studentOptions';

function Field({ icon: Icon, label, hint, children }) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5 font-bold text-sm mb-1">
        <Icon size={14} strokeWidth={2.5} /> {label}
      </span>
      {children}
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
    </label>
  );
}

const inputClass =
  'w-full border-2 border-black rounded-lg px-3 py-2 font-medium bg-white ' +
  'focus:outline-none focus:ring-2 focus:ring-[#F26B4D] disabled:bg-gray-100 disabled:text-gray-500';

function Banner({ tone, children }) {
  if (!children) return null;
  const tones = {
    error: 'bg-red-50 border-red-400 text-red-800',
    success: 'bg-green-50 border-green-500 text-green-800',
  };
  const Icon = tone === 'success' ? Check : AlertTriangle;
  return (
    <div className={`flex items-start gap-2 border-2 rounded-lg px-3 py-2 text-sm font-bold ${tones[tone]}`}>
      <Icon size={16} strokeWidth={3} className="shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  );
}

export default function ProfilePage() {
  const { user, applyProfileUpdate, logout } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [board, setBoard] = useState('');
  const [state, setState] = useState('');
  const [school, setSchool] = useState('');

  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');

  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setPhone(user.phone || '');
      setEmail(user.email || '');
      setBoard(user.board || '');
      setState(user.state || '');
      setSchool(user.school || '');
    }
  }, [user]);

  const isStudent = user?.role === 'student';
  // An account created with a mobile number only. The email field stays
  // editable in that case, because there is no existing address to protect —
  // once one is saved it locks like everyone else's.
  const canAddEmail = !user?.email;

  const saveProfile = async (e) => {
    e.preventDefault();
    setProfileError('');
    setProfileSuccess('');

    setSavingProfile(true);
    try {
      const result = await fetchAPI('/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          // Only sent when there is no address on file. Sending an unchanged
          // one is harmless, but sending nothing keeps the request honest
          // about what it is asking to change.
          ...(canAddEmail && email.trim() ? { email: email.trim() } : {}),
          // class_level is deliberately absent: it is locked, and the server
          // rejects any attempt to move it.
          ...(isStudent ? { board, state, school: school.trim() } : {}),
        }),
      });

      applyProfileUpdate(result);
      setProfileSuccess('Profile saved.');
    } catch (err) {
      setProfileError(err.message || 'Could not save your details.');
    } finally {
      setSavingProfile(false);
    }
  };

  // Confirmed because this used to be a header button people hit by accident;
  // on a page you visit deliberately an accidental click is likelier still.
  const handleSignOut = () => {
    if (window.confirm('Sign out of your account on this device?')) logout();
  };

  const savePassword = async (e) => {
    e.preventDefault();
    setPwError('');
    setPwSuccess('');

    if (pwNew !== pwConfirm) {
      setPwError('The two new passwords do not match.');
      return;
    }
    if (pwNew.length < 8) {
      setPwError('New password must be at least 8 characters.');
      return;
    }

    setSavingPw(true);
    try {
      await fetchAPI('/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNew }),
      });
      setPwCurrent('');
      setPwNew('');
      setPwConfirm('');
      setPwSuccess('Password updated.');
    } catch (err) {
      setPwError(err.message || 'Could not change your password.');
    } finally {
      setSavingPw(false);
    }
  };

  if (!user) return null;
  const initials = (user.name || '').trim().split(/\s+/).filter(Boolean)
    .slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '—';

  return (
    /*
     * Two columns from lg up: forms on the left, settings on the right.
     *
     * This was a single 672px column inside a 1400px page, so on a laptop
     * roughly half the screen was empty and the six cards made a scroll far
     * longer than the content warranted. A teacher's form is the shortest of
     * all — three fields — which made the imbalance worst for exactly the
     * person this page matters most to.
     *
     * No horizontal padding: <main> already provides the page gutter, and
     * adding one here compounded to 40px a side on a phone.
     */
    <div className="max-w-5xl mx-auto py-6 md:py-8">
      <div className="mb-5 md:mb-6">
        <h1 className="text-2xl md:text-4xl font-black tracking-tight">Your Profile</h1>
        <p className="text-sm text-gray-600 font-medium mt-1">
          Manage your details, security and how the site looks.
        </p>
      </div>

      <div className="grid gap-5 md:gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] items-start">
        {/* ------------------------------------------------------ left column */}
        <div className="flex flex-col gap-5 md:gap-6 min-w-0">
          {/* -------------------------------------------------------- contact */}
          <form
            onSubmit={saveProfile}
            className="border-[3px] border-black rounded-2xl bg-white p-5 md:p-6 shadow-[6px_6px_0px_0px_#111] flex flex-col gap-4"
          >
            <h2 className="font-black text-lg uppercase">Your Details</h2>

            <Banner tone="error">{profileError}</Banner>
            <Banner tone="success">{profileSuccess}</Banner>

            {/*
              Two fields per row once there is room. A teacher only has three
              fields here, and one per row left the card mostly whitespace
              beside a form that fits comfortably in half the width.
            */}
            <div className="grid sm:grid-cols-2 gap-4">
              <Field icon={User} label="Full name">
                <input
                  className={inputClass}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  required
                />
              </Field>

              <Field
                icon={Phone}
                label="Mobile number"
                hint="You sign in with this."
              >
                <input
                  type="tel"
                  inputMode="numeric"
                  className={inputClass}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="98765 43210"
                  required
                />
              </Field>

              {/*
                Shown but not editable once set. Rendered as plain text rather
                than a disabled <input> so it does not look like it might
                become editable; the server rejects a changed address
                regardless — this is the label on the rule, not the rule.
              */}
              {canAddEmail ? (
                <Field
                  icon={Mail}
                  label="Email address"
                  hint="Optional — but once you save one, it can't be changed."
                >
                  <input
                    type="email"
                    className={inputClass}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </Field>
              ) : (
                <Field
                  icon={Mail}
                  label="Email address"
                  hint="This can also be used to sign in, and it can't be changed."
                >
                  <div className="flex items-center gap-2 rounded-lg border-2 border-black/15 bg-gray-100 px-3 py-2">
                    <span className="flex-1 min-w-0 truncate font-medium text-gray-700">
                      {user.email}
                    </span>
                    <span className="flex items-center gap-1 shrink-0 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                      <Lock size={12} strokeWidth={3} /> Locked
                    </span>
                  </div>
                </Field>
              )}

              {isStudent && (
                <>
                  <Field
                    icon={GraduationCap}
                    label="Class"
                    hint="Set when you signed up. Contact support if this is wrong."
                  >
                    <div className="flex items-center gap-2 rounded-lg border-2 border-black/15 bg-gray-100 px-3 py-2">
                      <span className="flex-1 min-w-0 truncate font-medium text-gray-700">
                        {user.class_level || '—'}
                      </span>
                      <span className="flex items-center gap-1 shrink-0 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                        <Lock size={12} strokeWidth={3} /> Locked
                      </span>
                    </div>
                  </Field>

                  <Field icon={BookOpen} label="Board">
                    <select
                      className={inputClass}
                      value={board}
                      onChange={(e) => setBoard(e.target.value)}
                    >
                      <option value="">Not set</option>
                      {BOARDS.map((b) => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>
                  </Field>

                  <Field icon={MapPin} label="State">
                    <select
                      className={inputClass}
                      value={state}
                      onChange={(e) => setState(e.target.value)}
                    >
                      <option value="">Not set</option>
                      {STATES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </Field>

                  {/* Spans both columns: a school name is long enough that
                      half a row truncates most of it. */}
                  <div className="sm:col-span-2">
                    <Field icon={School} label="School / College" hint="Optional.">
                      <input
                        className={inputClass}
                        value={school}
                        onChange={(e) => setSchool(e.target.value)}
                        placeholder="Govt. Senior Secondary School"
                      />
                    </Field>
                  </div>
                </>
              )}
            </div>

            {/*
              Full width on a phone, right-aligned from `sm` up.

              A half-width button floated to the right edge of a narrow screen
              is both awkward to look at and awkward to reach one-handed — the
              far corner is the hardest part of a phone for a thumb. Given the
              whole width it reads as the obvious end of the form.

              pt-1 + border-t: the button was sitting flush against the last
              field with nothing marking where the form ended.
            */}
            <div className="flex flex-col sm:flex-row sm:justify-end pt-4 border-t-2 border-black/10">
              <Button
                type="submit"
                variant="primary"
                disabled={savingProfile}
                className="w-full sm:w-auto py-2.5 px-6 text-base rounded-xl border-2"
              >
                {savingProfile ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </form>

          {/* ------------------------------------------------------- password */}
          <form
            onSubmit={savePassword}
            className="border-[3px] border-black rounded-2xl bg-white p-5 md:p-6 shadow-[6px_6px_0px_0px_#111] flex flex-col gap-4"
          >
            <h2 className="font-black text-lg uppercase">Change Password</h2>

            <Banner tone="error">{pwError}</Banner>
            <Banner tone="success">{pwSuccess}</Banner>

            <Field icon={Lock} label="Current password">
              <PasswordInput
                className={inputClass}
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>

            {/* The new pair side by side: they are entered together and
                compared against each other, so they belong on one row. */}
            <div className="grid sm:grid-cols-2 gap-4">
              <Field icon={Lock} label="New password" hint="At least 8 characters.">
                <PasswordInput
                  className={inputClass}
                  value={pwNew}
                  onChange={(e) => setPwNew(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </Field>

              <Field icon={Lock} label="Confirm new password">
                <PasswordInput
                  className={inputClass}
                  value={pwConfirm}
                  onChange={(e) => setPwConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </Field>
            </div>

            <div className="flex flex-col sm:flex-row sm:justify-end pt-4 border-t-2 border-black/10">
              <Button
                type="submit"
                variant="secondary"
                disabled={savingPw}
                className="w-full sm:w-auto py-2.5 px-6 text-base rounded-xl border-2"
              >
                {savingPw ? 'Updating...' : 'Update Password'}
              </Button>
            </div>
          </form>
        </div>

        {/* ----------------------------------------------------- right column

            Sticky on a tall screen so the settings stay in view while the
            forms on the left are scrolled. `top-20` clears the sticky header. */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20">
          {/* Identity. Replaces the "Signed in as ..." line, which was a
              sentence doing a card's job. */}
          <div className="border-[3px] border-black rounded-2xl bg-white p-5 shadow-[6px_6px_0px_0px_#111] flex flex-col items-center text-center">
            <div
              className="w-16 h-16 rounded-full border-2 border-black bg-[#F26B4D] text-white
                         shadow-[3px_3px_0px_0px_#111] flex items-center justify-center
                         font-black text-xl mb-3"
              aria-hidden="true"
            >
              {initials}
            </div>
            <p className="font-black text-lg leading-tight break-words w-full">{user.name}</p>
            {/* Falls back to the mobile number: email is optional, and an
                empty line under a name looks like a failed load. */}
            <p className="text-xs font-medium text-gray-600 mt-0.5 break-all w-full">
              {user.email || user.phone}
            </p>
            <span className="mt-3 px-3 py-0.5 text-[11px] uppercase font-black border-2 border-black rounded-full bg-[#F9E076]">
              {user.role}
            </span>
          </div>

          {/*
            Educators only. This sets the default for every user, so a student
            seeing it — even disabled — would suggest they had a say. The
            server enforces the same rule; this is the label on it.
          */}
          {user.role === 'educator' && (
            <SettingCard
              title="Platform appearance"
              description="The default colours for everyone, students included."
            >
              <AppearanceButton scope="platform" />
            </SettingCard>
          )}

          <SettingCard
            title="Your appearance"
            description="Pick your own colours. Changes the site for you only."
          >
            <AppearanceButton />
          </SettingCard>

          {/* Last, and the only card with a destructive action. */}
          <SettingCard title="Session" description="Signs you out on this device only.">
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full h-11 inline-flex items-center justify-center gap-2 px-5 font-bold text-sm border-2 border-black rounded-xl bg-white text-red-600 shadow-[3px_3px_0px_0px_#111] hover:bg-red-50 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all"
            >
              <LogOut size={16} strokeWidth={2.5} /> Sign out
            </button>
          </SettingCard>

          {/*
            Last on the page, and available to everyone.

            Teachers were excluded here while the route refused them. It no
            longer does: closing an account anonymises the row rather than
            deleting it, so the ON DELETE CASCADE on courses.educator_id never
            fires and a teacher's courses survive. Leaving this student-only
            would mean teachers had no way to close an account the API is
            perfectly willing to close.
          */}
          <SettingCard
            title="Delete account"
            description={
              user.role === 'student'
                ? 'Remove your details permanently. This cannot be undone.'
                : 'Remove your details permanently. Your courses are kept for enrolled students.'
            }
          >
            <button
              type="button"
              onClick={() => navigate('/deleteaccount')}
              className="w-full h-11 inline-flex items-center justify-center gap-2 px-5 font-bold text-sm border-2 border-black rounded-xl bg-white text-red-600 shadow-[3px_3px_0px_0px_#111] hover:bg-red-50 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all"
            >
              <Trash2 size={16} strokeWidth={2.5} /> Delete my account
            </button>
          </SettingCard>

          {/*
            Not a card — a footer link. It belongs on the page (people look for
            it in settings) but it is reference material, not an action, and
            giving it a card would put it on a level with signing out.
          */}
          <p className="text-center text-xs font-bold text-gray-500 pt-1">
            <Link to="/privacypolicy" className="underline hover:text-black">
              Privacy Policy
            </Link>
          </p>
        </aside>
      </div>
    </div>
  );
}

/**
 * A sidebar card: a heading, a line of explanation, and one control.
 *
 * Extracted because there were three of these differing only in wording, and
 * the next person adding a fourth would have copied whichever they scrolled
 * to first.
 */
function SettingCard({ title, description, children }) {
  return (
    <div className="border-[3px] border-black rounded-2xl bg-white p-5 shadow-[6px_6px_0px_0px_#111] flex flex-col gap-3">
      <div>
        <h2 className="font-black text-base uppercase leading-tight">{title}</h2>
        <p className="text-xs text-gray-600 font-medium mt-1">{description}</p>
      </div>
      {children}
    </div>
  );
}
