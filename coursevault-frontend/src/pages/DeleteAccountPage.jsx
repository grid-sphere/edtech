import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Trash2, Loader } from 'lucide-react';
import { fetchAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import PasswordInput from '../components/ui/PasswordInput';

/**
 * Closing your own account.
 *
 * A page rather than a modal on the profile, for two reasons. It is
 * irreversible, and a full screen with nothing else on it makes that the only
 * thing being decided — a dialog over the settings you were just editing
 * invites a reflexive confirm. And it gives the action a URL, which is what
 * app stores and privacy policies ask to link to.
 */
export default function DeleteAccountPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const isEducator = user && user.role !== 'student';
  const ready = password.length > 0 && confirm === 'DELETE';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await fetchAPI('/auth/account', {
        method: 'DELETE',
        body: JSON.stringify({ password, confirm }),
        /*
         * The default 401 handler wipes the token and hard-navigates to the
         * sign-in page. On this screen that is the worst possible response to
         * a failure: the person cannot tell whether their account was deleted
         * or their session merely expired. Errors stay here and get read out.
         */
        redirectOn401: false,
      });
      /*
       * Show the outcome before signing out.
       *
       * Logging out immediately would drop the reader on the sign-in page with
       * no statement that anything happened — indistinguishable from being
       * randomly kicked out, on the one action where being sure it worked
       * matters most.
       */
      setDone(true);
    } catch (err) {
      setError(err.message || 'Could not close the account.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="max-w-lg mx-auto py-10">
        <div className="border-[3px] border-black rounded-2xl bg-white p-6 shadow-[6px_6px_0px_0px_#111] text-center">
          <h1 className="text-2xl font-black tracking-tight mb-2">Your account is closed</h1>
          <p className="text-sm text-gray-600 font-medium mb-6">
            Your name, email and phone number have been removed. You can't sign
            in with them again.
          </p>
          <button
            type="button"
            onClick={logout}
            className="px-5 py-2.5 rounded-xl border-2 border-black bg-[#F26B4D] text-white font-bold text-sm shadow-[3px_3px_0px_0px_#111]"
          >
            Close and sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto py-6 md:py-10">
      <button
        type="button"
        onClick={() => navigate('/profile')}
        className="flex items-center gap-1.5 text-xs font-bold text-gray-600 hover:text-black mb-4"
      >
        <ArrowLeft size={14} strokeWidth={3} /> Back to profile
      </button>

      <div className="border-[3px] border-black rounded-2xl bg-white p-5 md:p-6 shadow-[6px_6px_0px_0px_#111]">
        <h1 className="flex items-center gap-2 text-xl md:text-2xl font-black tracking-tight mb-1">
          <Trash2 size={22} strokeWidth={2.5} className="text-red-600" />
          Delete your account
        </h1>

          <p className="text-sm text-gray-600 font-medium mt-1 mb-4">
            This cannot be undone.
          </p>

          {/*
            Teachers see what happens to their courses before they decide,
            not afterwards. This is the part of the outcome that affects
            other people, so it is called out on its own rather than being
            one bullet among five.
          */}
          {isEducator && (
            <div className="mb-4 flex items-start gap-2 p-3 border-2 border-amber-400 bg-amber-50 rounded-xl">
              <AlertTriangle size={16} strokeWidth={3} className="shrink-0 mt-0.5 text-amber-800" />
              <div className="text-sm font-bold text-amber-900">
                <p className="mb-1">Your courses will be affected.</p>
                <p className="font-medium">
                  They stop appearing to new students, so nobody else can
                  enrol. Students already enrolled keep full access to
                  everything, and their progress is not touched. Your courses
                  are not deleted — an administrator can hand them to another
                  teacher later.
                </p>
              </div>
            </div>
          )}

          <div className="p-3 mb-5 border-2 border-black rounded-xl bg-[#F9E076]">
            <p className="font-bold text-sm mb-1">What happens</p>
            <ul className="text-xs font-medium list-disc pl-4 space-y-0.5">
              <li>Your name, email address and phone number are removed.</li>
              <li>You will not be able to sign in again.</li>
              {isEducator ? (
                <li>
                  Your name is replaced with &ldquo;Former teacher&rdquo; on
                  courses you created.
                </li>
              ) : (
                <li>Your course access ends immediately.</li>
              )}
              {/* Stated plainly rather than buried. Someone deleting an
                  account after paying deserves to know a refund is a
                  separate conversation, before they click, not after. */}
              <li>
                A record of any purchase is kept for accounting. It is no
                longer linked to your name.
              </li>
            </ul>
            {/* The bullet above summarises; this is where the full rule
                lives. Someone weighing an irreversible choice should be one
                tap from the detail, not asked to trust a summary. */}
            <p className="text-xs font-medium mt-2">
              Full detail in the{' '}
              <Link to="/privacypolicy" className="underline font-bold">
                Privacy Policy
              </Link>
              .
            </p>
          </div>

          {error && (
            <div className="p-3 mb-4 border-2 border-red-500 bg-red-50 rounded-xl font-bold text-red-700 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={submit} className="flex flex-col gap-4">
            <label className="block">
              <span className="font-bold text-sm mb-1 block">Your password</span>
              <PasswordInput
                className="w-full border-2 border-black rounded-lg px-3 py-2 font-medium bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>

            <label className="block">
              <span className="font-bold text-sm mb-1 block">
                Type <span className="font-mono">DELETE</span> to confirm
              </span>
              <input
                className="w-full border-2 border-black rounded-lg px-3 py-2 font-medium bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                // Not autocapitalised: a phone keyboard would offer "Delete"
                // and the comparison is exact, leaving the button dead with
                // no explanation.
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                placeholder="DELETE"
              />
            </label>

            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-1">
              <button
                type="button"
                onClick={() => navigate('/profile')}
                className="px-5 py-2.5 rounded-xl border-2 border-black bg-white font-bold text-sm"
              >
                Keep my account
              </button>
              <button
                type="submit"
                disabled={!ready || busy}
                className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl border-2 border-black bg-red-600 text-white font-bold text-sm shadow-[3px_3px_0px_0px_#111] disabled:opacity-50 disabled:shadow-none"
              >
                {busy ? <Loader size={15} className="animate-spin" /> : <Trash2 size={15} strokeWidth={3} />}
                {busy ? 'Closing...' : 'Delete my account'}
              </button>
            </div>
          </form>
      </div>
    </div>
  );
}
