import React, { useEffect, useState } from 'react';
import { MailWarning, Check, Loader, X } from 'lucide-react';
import { fetchAPI, getDeviceId } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';

/** Seconds before another code can be requested. */
const RESEND_SECONDS = 45;

/**
 * A safety net for unverified accounts that are already inside the app.
 *
 * Verification is enforced at the auth page now — an unverified login gets a
 * verify-scoped token and never reaches a route that renders this. So in
 * normal operation this banner does not appear at all.
 *
 * It still exists for the accounts that slip between the two rules: anyone
 * holding a full session token issued before the gate shipped, who is signed
 * in and unverified. Without it they would carry an unconfirmed address
 * indefinitely, since nothing else would ever ask them again.
 *
 * Renders nothing for verified users, signed-out visitors, or accounts with no
 * email.
 */
export default function VerifyEmailBanner() {
  const { user, applyProfileUpdate } = useAuth();

  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  if (!user || !user.email || user.email_verified || dismissed) return null;

  const sendCode = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await fetchAPI('/auth/send-verification', { method: 'POST' });
      setNotice(res?.message || `A code has been sent to ${user.email}.`);
      setOpen(true);
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      setError(err.message || 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetchAPI('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ code, deviceId: getDeviceId() }),
      });
      /*
       * The token matters as much as the user here: verify-email trades the
       * caller's token for a full session one, and dropping it would leave a
       * verified account still holding whatever it arrived with.
       */
      if (res?.user) applyProfileUpdate({ user: res.user, token: res.token });
      else setDismissed(true);
    } catch (err) {
      setError(err.message || 'That code is not correct.');
    } finally {
      setBusy(false);
    }
  };

  return (
    // Mirrors the gutter on <main>; it renders above it, outside that element.
    <div className="mx-auto max-w-[1400px] px-4 md:px-6 pt-3">
      <div className="rounded-2xl border-2 border-black bg-[#F9E076] shadow-[3px_3px_0px_0px_#111] overflow-hidden">
        <div className="flex items-start gap-3 p-3 md:p-4">
          <MailWarning size={20} strokeWidth={2.5} className="shrink-0 mt-0.5" />

          <div className="min-w-0 flex-1">
            <p className="font-bold text-sm leading-snug">
              Confirm your email address
            </p>
            <p className="text-xs text-black/70 mt-0.5 break-words">
              We need to confirm <strong>{user.email}</strong> so you can reset your
              password if you ever forget it.
            </p>

            {error && (
              <p className="mt-2 text-xs font-bold text-red-700">{error}</p>
            )}
            {notice && !error && (
              <p className="mt-2 text-xs font-bold text-black/70">{notice}</p>
            )}

            {!open ? (
              <button
                type="button"
                onClick={sendCode}
                disabled={busy}
                className="mt-2 px-3 py-1.5 rounded-full border-2 border-black bg-white font-bold text-xs hover:bg-[#A7E2D1] disabled:opacity-50"
              >
                {busy ? 'Sending...' : 'Send me a code'}
              </button>
            ) : (
              <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  className="w-32 px-3 py-1.5 rounded-lg border-2 border-black bg-white text-center font-black tracking-[0.3em]"
                />
                <button
                  type="submit"
                  disabled={busy || code.length !== 6}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-full border-2 border-black bg-[#A7E2D1] font-bold text-xs disabled:opacity-50"
                >
                  {busy ? <Loader size={13} className="animate-spin" /> : <Check size={13} strokeWidth={3} />}
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={sendCode}
                  disabled={busy || cooldown > 0}
                  className="text-xs font-bold underline underline-offset-2 disabled:no-underline disabled:text-black/40"
                >
                  {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend'}
                </button>
              </form>
            )}
          </div>

          {/*
            Dismissible for the session, not permanently.
            Someone in the middle of a lesson should be able to clear it; it
            returns on the next visit, because the reason for it has not gone
            away.
          */}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Hide until next visit"
            title="Hide until next visit"
            className="shrink-0 p-1 rounded-full hover:bg-black/10"
          >
            <X size={16} strokeWidth={3} />
          </button>
        </div>
      </div>
    </div>
  );
}
