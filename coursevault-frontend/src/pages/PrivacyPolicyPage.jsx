import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * The privacy policy.
 *
 * Public on purpose — it sits outside ProtectedRoute. A policy you must sign in
 * to read is useless to the two audiences that most need it: someone deciding
 * whether to sign up, and an app store reviewer checking the link works.
 *
 * Everything stated here is drawn from what the code actually does, not from a
 * template. If a claim below stops being true — a new analytics script, a new
 * processor, a new column on `users` — this file is wrong until it is updated,
 * and a wrong privacy policy is worse than none.
 */

const UPDATED = '8 August 2026';
// Every address on the page comes from here. Deliberately one constant: a
// policy that lists two contacts sends half the requests to whichever one the
// reader happened to notice, and data requests have a legal clock on them.
const CONTACT = 'gridsphere75@gmail.com';

function Section({ title, children }) {
  return (
    <section className="mb-7">
      <h2 className="text-lg font-black tracking-tight mb-2">{title}</h2>
      <div className="text-sm text-gray-700 font-medium space-y-2 leading-relaxed">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[#FDFBF7] px-4 py-8">
      <div className="max-w-3xl mx-auto">
        {/*
          A plain Link, not navigate(-1). This page is reachable from an app
          store listing and from a signed-out browser, where there is no
          history to go back to.
        */}
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs font-bold text-gray-600 hover:text-black mb-4"
        >
          <ArrowLeft size={14} strokeWidth={3} /> Back
        </Link>

        <div className="border-[3px] border-black rounded-2xl bg-white p-5 md:p-8 shadow-[6px_6px_0px_0px_#111]">
          <h1 className="text-2xl md:text-3xl font-black tracking-tight mb-1">Privacy Policy</h1>
          <p className="text-xs font-bold text-gray-500 mb-6">Last updated: {UPDATED}</p>

          <p className="text-sm text-gray-700 font-medium leading-relaxed mb-7">
            This policy explains what Sharda Vidyapeeth collects when you use
            this platform, why, and what you can do about it. It describes how
            the software actually behaves, not what we might do in future.
          </p>

          <Section title="Who is responsible">
            <p>
              Sharda Vidyapeeth operates this platform and decides how the
              information described here is used. For anything in this policy,
              including requests to see or delete your data, write to{' '}
              <a href={`mailto:${CONTACT}`} className="font-bold underline">
                {CONTACT}
              </a>
              .
            </p>
          </Section>

          <Section title="What we collect">
            <p>Only what the platform needs to work. Specifically:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>When you register:</strong> your name, email address and
                mobile number. Students are also asked for class, board, state
                and school name so courses can be matched to them.
              </li>
              <li>
                <strong>Your password:</strong> stored only as a bcrypt hash. We
                cannot read it, and nobody here can tell you what it is.
              </li>
              <li>
                <strong>As you study:</strong> which courses you are enrolled in,
                how far through each video you are, your quiz answers and scores,
                and the date of your last sign-in.
              </li>
              <li>
                <strong>If you pay for a course:</strong> the amount, currency,
                and the reference numbers our payment provider returns.{' '}
                <strong>We never see or store your card, UPI or bank details</strong> —
                those are entered on the payment provider's own page.
              </li>
              <li>
                <strong>If you contact support:</strong> the messages you send
                and our replies.
              </li>
            </ul>
          </Section>

          <Section title="What we do not collect">
            <p>
              This is worth stating plainly, because most policies are vague
              about it:
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>No advertising or analytics trackers.</strong> There is no
                Google Analytics, no Facebook pixel, and no third-party tracking
                script anywhere in this application.
              </li>
              <li>
                <strong>No advertising profiles, and no sale of your data.</strong>{' '}
                We do not sell, rent or trade personal information to anyone.
              </li>
              <li>
                <strong>No tracking cookies.</strong> The only thing stored in
                your browser is a single sign-in token, described below.
              </li>
              <li>
                <strong>No location tracking, contacts, camera or microphone
                access.</strong>
              </li>
            </ul>
          </Section>

          <Section title="Cookies and browser storage">
            <p>
              We do not use cookies. When you sign in, the platform stores one
              item in your browser's local storage — a token that keeps you
              signed in for up to seven days. It identifies your account to the
              server and nothing else. Signing out deletes it, and clearing your
              browser data has the same effect.
            </p>
          </Section>

          <Section title="Who can see your information">
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Your teachers.</strong> A teacher whose course you are
                enrolled in can see your name, email address, when you last
                signed in, and your progress and quiz results in that course.
                Teachers cannot see your password, your payment details, or your
                activity in other teachers' courses.
              </li>
              <li>
                <strong>Administrators of this platform,</strong> where needed to
                run and support it.
              </li>
              <li>
                <strong>Nobody else,</strong> other than the service providers
                listed below and where the law requires disclosure.
              </li>
            </ul>
          </Section>

          <Section title="Service providers we rely on">
            <p>
              These companies process some of your information on our behalf in
              order to make specific features work. They are not permitted to use
              it for their own purposes.
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Razorpay</strong> — processes payments. Your card, UPI or
                bank details go to them directly and never reach us.
              </li>
              <li>
                <strong>Cloudflare (R2 storage)</strong> — stores course videos,
                PDFs and images.
              </li>
              <li>
                <strong>Google (Gmail SMTP)</strong> — delivers verification and
                password-reset emails.
              </li>
            </ul>
          </Section>

          <Section title="Email codes">
            <p>
              We email a six-digit code when you first register, to confirm the
              address is really yours, and when you ask to reset a forgotten
              password. These codes are stored hashed, expire shortly after they
              are sent, and are deleted once used. We do not send marketing
              email.
            </p>
          </Section>

          <Section title="How long we keep it">
            <p>
              Your account information is kept for as long as your account is
              open. If you close it, see below. Records of payments are kept
              longer, because accounting and tax rules require it — but once your
              account is closed those records are no longer connected to your
              name.
            </p>
          </Section>

          <Section title="Closing your account">
            <p>
              You can close your own account at any time from{' '}
              <Link to="/deleteaccount" className="font-bold underline">
                Delete account
              </Link>{' '}
              in the profile page, or by writing to us at{' '}
              <a href={`mailto:${CONTACT}`} className="font-bold underline">
                {CONTACT}
              </a>
              . This applies to students and teachers alike.
            </p>
            <p>
              When you do, your name, email address, mobile number and school
              details are permanently removed, your password is destroyed, and
              you will not be able to sign in again. This cannot be undone.
            </p>
            <p>
              <strong>If you are a teacher:</strong> the courses you created are
              not deleted. They stop being offered to new students, while every
              student already enrolled keeps full access to the material and
              their progress. Your name is replaced with &ldquo;Former
              teacher&rdquo; on those courses.
            </p>
          </Section>

          <Section title="Your rights">
            <p>
              You can ask us to show you the information we hold about you,
              correct anything that is wrong, or delete your account. Name, phone
              number and school details can also be edited directly in your
              profile at any time. Write to{' '}
              <a href={`mailto:${CONTACT}`} className="font-bold underline">
                {CONTACT}
              </a>{' '}
              and we will respond within 30 days.
            </p>
            <p>
              If you are unhappy with how we have handled a request, you may
              complain to the Data Protection Board of India.
            </p>
          </Section>

          <Section title="Students under 18">
            <p>
              This platform is used by school students, and many of them are
              under 18. If you are under 18, please use this platform with your
              parent's or guardian's knowledge and permission, and ask them to
              read this policy with you.
            </p>
            <p>
              Parents and guardians may contact us at{' '}
              <a href={`mailto:${CONTACT}`} className="font-bold underline">
                {CONTACT}
              </a>{' '}
              to see what information we hold about their child, correct it, or
              ask us to delete the account. We act on those requests.
            </p>
            <p>
              We do not use children's information for advertising, profiling or
              behavioural tracking of any kind.
            </p>
          </Section>

          <Section title="Security">
            <p>
              Passwords are hashed with bcrypt and never stored in a readable
              form. Traffic between your device and the platform is encrypted
              over HTTPS. Access to course material requires a valid sign-in and
              a current enrolment.
            </p>
            <p>
              No system is perfectly secure. If we discover a breach affecting
              your personal information, we will notify you and the Data
              Protection Board of India as the law requires.
            </p>
          </Section>

          <Section title="Changes to this policy">
            <p>
              If we change this policy we will update the date at the top. If a
              change materially affects how your information is used, we will
              tell you in the app before it takes effect.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Sharda Vidyapeeth
              <br />
              <a href={`mailto:${CONTACT}`} className="font-bold underline">
                {CONTACT}
              </a>
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
