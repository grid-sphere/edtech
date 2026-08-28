import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader, ShieldCheck } from 'lucide-react';
import Button from '../ui/Button.jsx';
import PasswordInput from '../ui/PasswordInput.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { fetchAPI } from '../../services/api.js';
import { CLASS_LEVELS, BOARDS, STATES } from '../../utils/studentOptions.js';

const inputClass =
  'w-full bg-[#F4F4F4] border-2 border-black rounded-xl px-4 py-3 font-medium ' +
  'focus:outline-none focus:shadow-[4px_4px_0px_0px_#F26B4D] transition-shadow';

function Label({ children, optional }) {
  return (
    <label className="font-bold text-sm ml-2 mb-1 block">
      {children}
      {optional && <span className="font-medium text-gray-500"> (optional)</span>}
    </label>
  );
}

/**
 * How far along the form is.
 *
 * A count ("Step 2 of 3") as well as the dots: dots alone show position but
 * not how much is left, which is the thing that decides whether someone
 * abandons a signup.
 */
function Progress({ step, total }) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-2">
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            className={`h-2 flex-1 rounded-full border-2 border-black transition-colors ${
              i < step ? 'bg-[#A7E2D1]' : i === step ? 'bg-[#F9E076]' : 'bg-white'
            }`}
          />
        ))}
      </div>
      <p className="text-xs font-bold text-gray-500 text-center">
        Step {step + 1} of {total}
      </p>
    </div>
  );
}

export default function RegisterForm() {
  const { register } = useAuth();

  const [step, setStep] = useState(0);
  const [role, setRole] = useState('student');

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [classLevel, setClassLevel] = useState('');
  const [board, setBoard] = useState('');
  const [state, setState] = useState('');
  const [school, setSchool] = useState('');

  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  /* ---- inline email confirmation, step 1 ---- */
  const [codeSent, setCodeSent] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  /** The signed proof the server returns once a code is accepted. */
  const [emailToken, setEmailToken] = useState('');
  /** The exact address the proof was earned for. */
  const [verifiedEmail, setVerifiedEmail] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeNotice, setCodeNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  /*
   * Confirmation belongs to one address.
   *
   * Editing the email after confirming it must invalidate the proof —
   * otherwise someone could verify an address they own, change the field, and
   * register with an address they do not. The server checks this too; doing it
   * here as well means the button state matches reality instead of failing on
   * submit.
   */
  const emailConfirmed = Boolean(emailToken) && verifiedEmail === email.trim().toLowerCase();

  const isStudent = role === 'student';
  // Educators skip the academic step entirely, so the progress bar has to
  // reflect their shorter journey rather than promising a step they never see.
  const steps = isStudent ? 3 : 2;

  /**
   * Validate the current step only.
   *
   * Checking everything on every "Next" would surface errors about fields the
   * person has not reached yet, which reads as the form being broken.
   */
  const validateStep = () => {
    if (step === 0) {
      if (!name.trim()) return 'Please enter your full name.';
      const digits = phone.replace(/\D/g, '');
      const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
        : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
        : digits;
      if (national.length !== 10) return 'Enter a 10-digit mobile number.';
      if (!/^[6-9]/.test(national)) return "That doesn't look like a mobile number.";
      if (!email.trim()) return 'Please enter your email address.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
        return "That email address doesn't look valid.";
      }
      if (!emailConfirmed) return 'Please confirm your email address with the code we sent.';
      return null;
    }
    if (step === 1) {
      if (password.length < 6) return 'Password must be at least 6 characters.';
      if (password !== confirm) return 'The two passwords do not match.';
      return null;
    }
    if (step === 2) {
      if (!classLevel) return 'Please choose your class.';
      if (!board) return 'Please choose your board.';
      if (!state) return 'Please choose your state.';
      return null;
    }
    return null;
  };

  const sendEmailCode = async () => {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      setError("Enter a valid email address first.");
      return;
    }
    setError('');
    setCodeBusy(true);
    try {
      const data = await fetchAPI('/auth/request-signup-code', {
        method: 'POST',
        /*
         * The role decides where the code is delivered. A teacher's goes to the
         * school's administrator, not to this address, so the server has to
         * know which kind of account is being asked for before it sends.
         */
        body: JSON.stringify({ email: value, role }),
      });
      /*
       * The server's message wins. It is the only side that knows the code went
       * to an administrator rather than to the address on screen, and telling
       * someone "we've sent a code to <your address>" when we have not leaves
       * them watching an inbox forever.
       */
      setCodeNotice(data?.message || `We've sent a code to ${value}.`);
      setCodeSent(true);
      setCooldown(45);
    } catch (err) {
      setError(err.message || 'Could not send the code.');
    } finally {
      setCodeBusy(false);
    }
  };

  /*
   * Switching role throws away any code already confirmed.
   *
   * The proof is bound to the role it was earned for, so a student proof
   * cannot create a teacher — the server refuses it. Clearing here means that
   * refusal happens now, one field away from the fix, instead of after the
   * whole form is filled in.
   */
  const changeRole = (next) => {
    setRole(next);
    if (emailToken || codeSent) {
      setEmailToken('');
      setVerifiedEmail('');
      setCodeSent(false);
      setEmailCode('');
      setCodeNotice('');
    }
  };

  const confirmEmailCode = async () => {
    setError('');
    setCodeBusy(true);
    try {
      const data = await fetchAPI('/auth/verify-signup-code', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), code: emailCode }),
      });
      setEmailToken(data.emailVerifiedToken);
      setVerifiedEmail(email.trim().toLowerCase());
      setCodeNotice('');
    } catch (err) {
      setError(err.message || 'That code is not correct.');
      setEmailCode('');
    } finally {
      setCodeBusy(false);
    }
  };

  const next = (e) => {
    e.preventDefault();
    const problem = validateStep();
    if (problem) { setError(problem); return; }
    setError('');
    setStep((s) => s + 1);
  };

  const back = () => {
    setError('');
    setStep((s) => Math.max(0, s - 1));
  };

  const submit = async (e) => {
    e.preventDefault();
    const problem = validateStep();
    if (problem) { setError(problem); return; }

    setError('');
    setIsSubmitting(true);
    try {
      await register({
        name,
        phone,
        email: email.trim(),
        // The server refuses to create an account without this.
        emailVerifiedToken: emailToken,
        password,
        role,
        ...(isStudent
          ? { class_level: classLevel, board, state, school: school.trim() || undefined }
          : {}),
      });
    } catch (err) {
      /*
       * A rejection here is nearly always about the mobile number or email,
       * both of which live on step 1 — so send them back rather than showing
       * the message on a step where the offending field is not visible.
       */
      setError(err.message || 'Failed to register');
      if (/mobile|email|registered/i.test(err.message || '')) setStep(0);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isLast = step === steps - 1;

  return (
    <form className="text-left" onSubmit={isLast ? submit : next}>
      <Progress step={step} total={steps} />

      {error && (
        <div className="p-3 mb-4 bg-red-100 border-2 border-red-500 text-red-700 font-bold rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* -------------------------------------------------- step 1: about you */}
      {step === 0 && (
        <div className="flex flex-col gap-4">
          <div>
            <Label>I am a</Label>
            <select
              value={role}
              onChange={(e) => changeRole(e.target.value)}
              className={inputClass}
            >
              <option value="student">📚 Student - Looking to learn</option>
              <option value="educator">🎓 Educator - Want to teach</option>
            </select>
            {/*
              Said before they start, not after they finish. Someone applying to
              teach should know an administrator is involved while they can
              still change their mind, rather than discovering it on a code
              screen watching an inbox nothing arrives in.
            */}
            {role === 'educator' && (
              <p className="text-xs font-bold text-amber-800 bg-amber-50 border-2 border-amber-400 rounded-xl px-3 py-2 mt-2">
                Teacher accounts need approval. The confirmation code goes to
                your administrator, not to your inbox — ask them for it to
                finish signing up.
              </p>
            )}
          </div>

          <div>
            <Label>Full Name</Label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              placeholder="John Doe"
              autoComplete="name"
              autoFocus
            />
          </div>

          <div>
            <Label>Mobile Number</Label>
            <input
              // tel, not number: a number input strips leading zeros and shows
              // spinner arrows you can scroll a phone number with.
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClass}
              placeholder="98765 43210"
              autoComplete="tel"
            />
            <p className="text-xs text-gray-500 mt-1 ml-2">You will use this to sign in.</p>
          </div>

          <div>
            <Label>Email Address</Label>
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  // Editing after confirming drops the code box back to its
                  // starting state, so the UI never claims an address is
                  // confirmed while a different one is typed.
                  setCodeSent(false);
                  setEmailCode('');
                  setCodeNotice('');
                }}
                disabled={emailConfirmed}
                className={`${inputClass} ${emailConfirmed ? 'opacity-70' : ''}`}
                placeholder="you@example.com"
                autoComplete="email"
              />

              {emailConfirmed ? (
                <span className="shrink-0 flex items-center gap-1 px-3 rounded-xl border-2 border-black bg-[#A7E2D1] font-bold text-xs">
                  <ShieldCheck size={15} strokeWidth={3} /> Confirmed
                </span>
              ) : (
                <button
                  type="button"
                  onClick={sendEmailCode}
                  disabled={codeBusy || cooldown > 0}
                  className="shrink-0 px-3 rounded-xl border-2 border-black bg-white font-bold text-xs hover:bg-[#F9E076] disabled:opacity-50"
                >
                  {codeBusy ? <Loader size={14} className="animate-spin" />
                    : cooldown > 0 ? `${cooldown}s`
                    : codeSent ? 'Resend' : 'Send code'}
                </button>
              )}
            </div>

            {emailConfirmed ? (
              <button
                type="button"
                onClick={() => { setEmailToken(''); setVerifiedEmail(''); setCodeSent(false); }}
                className="text-xs font-bold underline underline-offset-2 mt-1 ml-2 text-gray-600 hover:text-black"
              >
                Use a different email
              </button>
            ) : codeSent ? (
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={emailCode}
                  onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className={`${inputClass} text-center tracking-[0.4em] font-black`}
                  placeholder="000000"
                  autoComplete="one-time-code"
                />
                <button
                  type="button"
                  onClick={confirmEmailCode}
                  disabled={codeBusy || emailCode.length !== 6}
                  className="shrink-0 px-4 rounded-xl border-2 border-black bg-[#A7E2D1] font-bold text-xs disabled:opacity-50"
                >
                  Confirm
                </button>
              </div>
            ) : (
              <p className="text-xs text-gray-500 mt-1 ml-2">
                We'll send a code to confirm it. This is how you reset a forgotten password.
              </p>
            )}

            {codeNotice && (
              <p className="text-xs font-bold text-gray-600 mt-1 ml-2">{codeNotice}</p>
            )}
          </div>
        </div>
      )}

      {/* --------------------------------------------------- step 2: password */}
      {step === 1 && (
        <div className="flex flex-col gap-4">
          <div>
            <Label>Password</Label>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className={inputClass}
              placeholder="••••••••"
            />
            <p className="text-xs text-gray-500 mt-1 ml-2">At least 6 characters.</p>
          </div>

          <div>
            <Label>Confirm Password</Label>
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className={inputClass}
              placeholder="••••••••"
            />
            {confirm && password !== confirm && (
              <p className="text-xs font-bold text-red-600 mt-1 ml-2">Passwords do not match.</p>
            )}
          </div>
        </div>
      )}

      {/* -------------------------------------------------- step 3: academics */}
      {step === 2 && isStudent && (
        <div className="flex flex-col gap-4">
          <div>
            <Label>Class</Label>
            <select
              value={classLevel}
              onChange={(e) => setClassLevel(e.target.value)}
              className={inputClass}
            >
              <option value="" disabled>Select your class</option>
              {CLASS_LEVELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <p className="text-xs text-gray-500 mt-1 ml-2">
              This can't be changed later, so please choose carefully.
            </p>
          </div>

          <div>
            <Label>Board</Label>
            <select
              value={board}
              onChange={(e) => setBoard(e.target.value)}
              className={inputClass}
            >
              <option value="" disabled>Select your board</option>
              {BOARDS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          <div>
            <Label>State</Label>
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className={inputClass}
            >
              <option value="" disabled>Select your state</option>
              {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <Label optional>School / College</Label>
            <input
              type="text"
              value={school}
              onChange={(e) => setSchool(e.target.value)}
              className={inputClass}
              placeholder="Govt. Senior Secondary School"
            />
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ actions */}
      <div className="flex gap-3 mt-6">
        {step > 0 && (
          <button
            type="button"
            onClick={back}
            className="flex items-center justify-center gap-1 px-4 py-3 rounded-xl border-2 border-black bg-white font-bold text-sm hover:bg-gray-100"
          >
            <ArrowLeft size={16} strokeWidth={3} /> Back
          </button>
        )}

        <Button
          type="submit"
          variant="secondary"
          className="flex-1"
          // Step 1 cannot be left until the address is confirmed. The message
          // below says why, so the disabled button is never a mystery.
          disabled={isSubmitting || (step === 0 && !emailConfirmed)}
        >
          {isSubmitting ? 'Creating account...' : isLast ? (
            <span className="flex items-center justify-center gap-2">
              <Check size={16} strokeWidth={3} /> Create Account
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              Next <ArrowRight size={16} strokeWidth={3} />
            </span>
          )}
        </Button>
      </div>

      {step === 0 && !emailConfirmed && (
        <p className="text-xs text-gray-500 text-center mt-2">
          Confirm your email address to continue.
        </p>
      )}
    </form>
  );
}
