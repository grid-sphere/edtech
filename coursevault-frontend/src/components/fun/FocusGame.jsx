import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Timer, Trophy, Target } from 'lucide-react';

/**
 * A short attention exercise, hidden behind seven taps on the logo.
 *
 * The first version was pure reflex — tap everything, fast. That trains speed,
 * not attention, and rewards exactly the scattered tapping a student is trying
 * to get away from. This is a go/no-go task instead: circles are to be tapped,
 * squares are to be left alone. Hitting a square costs a point.
 *
 * Go/no-go is the standard shape for measuring sustained attention and
 * inhibitory control, so the demand is at least the right one: keep watching,
 * and hold back when the rule says hold back. Being honest about the claim
 * though — three quarters of a minute of anything is not a proven cognitive
 * intervention. What it can reliably do is interrupt a drift, ask for deliberate
 * control for a moment, and hand the student back to their work on purpose
 * rather than leaving them in the app. The closing screen is written to do that.
 *
 * Constraints:
 *   - Short and self-ending, so it is a pause and not a destination.
 *   - Tap targets only. Most students are on a phone; anything needing a
 *     keyboard or two fingers excludes them.
 *   - Five an hour. Past that it stops being a break — see minutesUntilFree().
 *   - No backend and no new dependency. A hidden extra is not worth a table, a
 *     migration, or a package every student downloads whether they find it or
 *     not. That is why the 3D is CSS perspective rather than three.js: a WebGL
 *     library is upward of 150KB gzipped in every student's bundle, found or
 *     not, to draw a dozen coloured shapes.
 *
 * The shapes fly toward the viewer out of depth, which is not decoration — a
 * target that approaches has to be tracked over time rather than located once,
 * so the "keep watching" half of go/no-go actually asks for something.
 */

/*
 * Forty-five seconds.
 *
 * Long enough that staying with it is the demand — the first ten seconds of
 * anything are easy, and a sustained-attention task that ends before attention
 * has had a chance to wander is not measuring much. Short enough to still be a
 * pause rather than a destination.
 */
const ROUND_MS = 45000;
const BEST_KEY = 'sv_focus_best';
const PLAYS_KEY = 'sv_focus_plays';
const SCORES_KEY = 'sv_focus_scores';

/*
 * How many rounds the table remembers.
 *
 * Ten is a session's worth. An unbounded list would grow in localStorage for
 * ever and turn the results screen into something that needs its own scrolling
 * — which is a long way past what a hidden extra should be.
 */
const KEEP_SCORES = 10;

/** Five rounds per rolling hour. */
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PLAYS = 5;

/*
 * Roughly seven circles to three squares.
 *
 * Go/no-go only demands anything when the "go" response has become the habit —
 * if half the shapes were squares the student would simply hesitate on all of
 * them, which is not the same skill.
 */
const NO_GO_CHANCE = 0.3;

/* How far away a shape starts, and how far past the viewer it travels. */
const Z_START = -1100;
const Z_END = 260;

/*
 * Shape size in pixels, not percent.
 *
 * translateZ ignores percentages — they resolve against the element's own
 * width, which is what a cube's faces would need to be offset by. A fixed size
 * keeps the six faces meeting exactly at the edges at any container width, and
 * 60px is a comfortable thumb target on the narrowest phone this runs on.
 */
const SHAPE_PX = 60;
const HALF = SHAPE_PX / 2;

/*
 * Objects flying at the face are precisely what this setting exists for.
 *
 * With reduced motion the shapes appear in place and fade instead, so the task
 * still works for a student who gets motion sick or has a vestibular disorder —
 * they lose the depth, not the game.
 */
const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/* The pace picks up as the score climbs, floored so it stays doable. */
const spawnDelay = (score) => Math.max(520, 1000 - score * 20);
const targetLife = (score) => Math.max(850, 1500 - score * 24);

/** Play timestamps inside the window, oldest first. Never throws. */
function readPlays() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const cutoff = Date.now() - WINDOW_MS;
    return raw.filter((t) => typeof t === 'number' && t > cutoff).sort((a, b) => a - b);
  } catch {
    // Private browsing, disabled storage, or corrupted value. Treat as no plays
    // rather than locking the student out of something harmless.
    return [];
  }
}

/** The last few rounds, newest first. Never throws. */
function readScores() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCORES_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && typeof r.score === 'number' && typeof r.t === 'number')
      .sort((a, b) => b.t - a.t)
      .slice(0, KEEP_SCORES);
  } catch {
    return [];
  }
}

/** "just now", "12m", "3h" — short enough for a narrow column. */
function ago(t) {
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/** Minutes until a slot frees up, or 0 if one is free now. */
function minutesUntilFree(plays = readPlays()) {
  if (plays.length < MAX_PLAYS) return 0;
  // The oldest play inside the window is the one that expires first.
  const freesAt = plays[plays.length - MAX_PLAYS] + WINDOW_MS;
  return Math.max(1, Math.ceil((freesAt - Date.now()) / 60000));
}


/**
 * A real cube: six faces in one 3D space.
 *
 * Each face is pushed half the cube's width along its own normal, so they meet
 * at the edges. As the parent tumbles the faces occlude each other correctly —
 * which is the whole difference between a cube and a square that happens to be
 * rotating.
 *
 * Front and back are the lit faces; the sides carry a dark overlay so the form
 * reads as solid rather than as a wireframe of identical panels. Nothing here
 * is a light source — it is painted shading, which is all a CSS cube can do and
 * enough at this size.
 */
function Cube({ hue }) {
  const faces = [
    { t: `rotateY(0deg) translateZ(${HALF}px)`,   shade: 'rgba(0,0,0,0)' },
    { t: `rotateY(180deg) translateZ(${HALF}px)`, shade: 'rgba(0,0,0,0.45)' },
    { t: `rotateY(90deg) translateZ(${HALF}px)`,  shade: 'rgba(0,0,0,0.28)' },
    { t: `rotateY(-90deg) translateZ(${HALF}px)`, shade: 'rgba(0,0,0,0.28)' },
    { t: `rotateX(90deg) translateZ(${HALF}px)`,  shade: 'rgba(255,255,255,0.18)' },
    { t: `rotateX(-90deg) translateZ(${HALF}px)`, shade: 'rgba(0,0,0,0.5)' },
  ];
  return (
    <span
      aria-hidden="true"
      className="absolute inset-0"
      style={{ transformStyle: 'preserve-3d' }}
    >
      {faces.map((f, i) => (
        <span
          key={i}
          className="absolute inset-0 border-2 border-black/70"
          style={{
            transform: f.t,
            background: `linear-gradient(${f.shade}, ${f.shade}), ${hue}`,
            boxShadow: '0 0 14px rgba(0,0,0,0.5)',
            // Without this a face's own children would flatten it back to 2D;
            // with it the six panels stay in the parent's 3D space.
            backfaceVisibility: 'hidden',
          }}
        />
      ))}
    </span>
  );
}

/**
 * A sphere built as geometry: meridian rings in one 3D space.
 *
 * The previous version was two radial gradients — a painted ball, correct from
 * the front and flat the moment anything rotated. These are MERIDIANS rings
 * circles rotated evenly about the vertical axis, so the form is actually there
 * in three dimensions: the rings bunch toward the silhouette and open out
 * across the face exactly as a wireframe globe does, and the whole thing turns
 * with the tumble rather than sliding.
 *
 * MERIDIANS is the cost dial. Each ring is one element, so a sphere is
 * MERIDIANS + 1 nodes and eight in flight is roughly a hundred. Twelve is
 * enough to read as round without the rings merging into a smear; going much
 * higher buys very little and costs it on a mid-range phone, which is what most
 * students are holding.
 *
 * A shaded core sits inside so the ball reads solid rather than hollow — the
 * rings alone would let the background through the middle.
 */
const MERIDIANS = 12;

function Sphere({ hue }) {
  return (
    <span
      aria-hidden="true"
      className="absolute inset-0"
      style={{ transformStyle: 'preserve-3d' }}
    >
      {/*
        The core. Slightly inset so the rings sit proudly on its surface
        instead of z-fighting with it.
      */}
      <span
        className="absolute rounded-full"
        style={{
          inset: '6%',
          background:
            `radial-gradient(circle at 32% 26%, rgba(255,255,255,0.75) 0%, rgba(255,255,255,0) 40%), ` +
            `radial-gradient(circle at 50% 45%, ${hue} 30%, rgba(0,0,0,0.72) 100%)`,
          boxShadow: '0 0 16px rgba(0,0,0,0.5)',
        }}
      />
      {Array.from({ length: MERIDIANS }, (_, i) => (
        <span
          key={i}
          className="absolute inset-0 rounded-full"
          style={{
            // Evenly spaced half-turns: a full turn would draw each ring twice.
            transform: `rotateY(${(i * 180) / MERIDIANS}deg)`,
            border: `2px solid ${hue}`,
            /*
             * Each ring must keep its own plane rather than being flattened
             * into the parent's, or the sphere collapses into a stack of
             * concentric circles.
             */
            transformStyle: 'preserve-3d',
            opacity: 0.75,
          }}
        />
      ))}
    </span>
  );
}

export default function FocusGame({ onClose }) {
  // ready | settle | playing | over | limit
  const [phase, setPhase] = useState(() => (minutesUntilFree() > 0 ? 'limit' : 'ready'));
  const [score, setScore] = useState(0);
  const [slips, setSlips] = useState(0);
  const [msLeft, setMsLeft] = useState(ROUND_MS);
  const [targets, setTargets] = useState([]);
  const [settle, setSettle] = useState(3);
  const [wait, setWait] = useState(() => minutesUntilFree());
  const [flash, setFlash] = useState(false);
  const [flat] = useState(prefersReducedMotion);

  const [scores, setScores] = useState(readScores);

  const [best, setBest] = useState(() => {
    try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
  });

  /*
   * Timers live in a ref. Every one must be cleared when the round ends or the
   * modal closes — a stray timeout sets state on a dead component, and a stray
   * interval keeps spawning shapes into a game nobody is playing.
   */
  const timers = useRef(new Set());
  const nextId = useRef(0);
  /*
   * The live score, outside React state. The spawn loop and the end-of-round
   * check both need it, and reading it through a setScore updater would be a
   * side effect inside an updater — React may call those twice in development,
   * which would schedule two spawn chains and double the rate.
   */
  const scoreRef = useRef(0);
  const slipsRef = useRef(0);

  const later = useCallback((fn, ms) => {
    const t = setTimeout(() => { timers.current.delete(t); fn(); }, ms);
    timers.current.add(t);
    return t;
  }, []);

  const clearAll = useCallback(() => {
    for (const t of timers.current) { clearTimeout(t); clearInterval(t); }
    timers.current.clear();
  }, []);

  useEffect(() => clearAll, [clearAll]);

  /**
   * Append the round to the table.
   *
   * Written at the same moment as the best score so the two can never disagree
   * — a table whose top row beats the trophy in the header is the kind of small
   * wrongness that makes everything else look untrustworthy.
   */
  const recordScore = useCallback((finalScore, finalSlips) => {
    try {
      const rows = [{ t: Date.now(), score: finalScore, slips: finalSlips }, ...readScores()]
        .slice(0, KEEP_SCORES);
      localStorage.setItem(SCORES_KEY, JSON.stringify(rows));
      setScores(rows);
    } catch {
      // Storage unavailable: keep the round in memory so the table still shows
      // this session, and accept that it will not survive a reload.
      setScores((rows) => [{ t: Date.now(), score: finalScore, slips: finalSlips }, ...rows].slice(0, KEEP_SCORES));
    }
  }, []);

  const recordBest = useCallback((finalScore) => {
    setBest((b) => {
      if (finalScore <= b) return b;
      try { localStorage.setItem(BEST_KEY, String(finalScore)); } catch { /* ignore */ }
      return finalScore;
    });
  }, []);

  /**
   * Spend one of the hour's two rounds.
   *
   * Recorded when a round actually begins, not when the modal opens — opening
   * it, reading the rules and closing again should not cost a turn.
   */
  const recordPlay = useCallback(() => {
    try {
      const plays = readPlays();
      plays.push(Date.now());
      localStorage.setItem(PLAYS_KEY, JSON.stringify(plays));
    } catch { /* storage unavailable; the limit simply does not bind */ }
  }, []);

  const spawn = useCallback((currentScore) => {
    const id = nextId.current++;
    const go = Math.random() > NO_GO_CHANCE;
    // Carried on the shape so the flight animation and the removal timer are
    // the same length — otherwise a shape vanishes mid-approach, or lingers
    // motionless after arriving.
    const life = targetLife(currentScore);
    setTargets((t) => [...t, {
      id,
      go,
      life,
      // Inset so no shape sits half outside the play area.
      x: 8 + Math.random() * 76,
      y: 8 + Math.random() * 76,
      hue: go ? ['#F26B4D', '#A7E2D1', '#87CEFA'][id % 3] : '#111',
    }]);
    later(() => setTargets((t) => t.filter((x) => x.id !== id)), life);
  }, [later]);

  const beginRound = useCallback(() => {
    setPhase('playing');
    const startedAt = Date.now();

    const tick = setInterval(() => {
      const left = ROUND_MS - (Date.now() - startedAt);
      if (left <= 0) {
        clearAll();
        setMsLeft(0);
        setTargets([]);
        setPhase('over');
        recordBest(scoreRef.current);
        recordScore(scoreRef.current, slipsRef.current);
      } else {
        setMsLeft(left);
      }
    }, 100);
    timers.current.add(tick);

    /*
     * Self-rescheduling rather than a fixed interval, so the delay can shorten
     * as the score rises. setInterval would be locked to its original period.
     */
    const loop = () => {
      spawn(scoreRef.current);
      later(loop, spawnDelay(scoreRef.current));
    };
    loop();
  }, [clearAll, later, spawn, recordBest, recordScore]);

  const start = useCallback(() => {
    const left = minutesUntilFree();
    if (left > 0) { setWait(left); setPhase('limit'); return; }

    clearAll();
    recordPlay();
    scoreRef.current = 0;
    slipsRef.current = 0;
    setScore(0);
    setSlips(0);
    setTargets([]);
    setMsLeft(ROUND_MS);

    /*
     * Three seconds of nothing before the first shape.
     *
     * A task that starts the instant a button is pressed is entered mid-scramble
     * — which is the state the student is presumably already in. The count-in is
     * the only part of this that is unambiguously about settling.
     */
    setSettle(3);
    setPhase('settle');
    const step = (n) => {
      if (n === 0) { beginRound(); return; }
      setSettle(n);
      later(() => step(n - 1), 1000);
    };
    step(3);
  }, [clearAll, later, recordPlay, beginRound]);

  const hit = (t) => {
    setTargets((list) => list.filter((x) => x.id !== t.id));
    if (t.go) {
      scoreRef.current += 1;
      setScore(scoreRef.current);
    } else {
      /*
       * The point of the exercise. A square costs a point and flashes, so
       * holding back is worth something and tapping everything is not a
       * winning strategy.
       */
      scoreRef.current = Math.max(0, scoreRef.current - 1);
      slipsRef.current += 1;
      setScore(scoreRef.current);
      setSlips(slipsRef.current);
      setFlash(true);
      later(() => setFlash(false), 180);
    }
  };

  const seconds = (msLeft / 1000).toFixed(1);
  const playsLeft = Math.max(0, MAX_PLAYS - readPlays().length);

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-3"
      role="dialog"
      aria-modal="true"
      aria-label="Focus — a forty-five second attention exercise"
    >
      <div className="w-full max-w-md bg-white border-2 border-black rounded-2xl shadow-[4px_4px_0px_0px_#111] overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b-2 border-black bg-[#F9E076]">
          <h2 className="font-black text-sm uppercase">Focus</h2>
          <div className="flex items-center gap-2">
            {phase === 'playing' && (
              <span className="flex items-center gap-1 text-xs font-black tabular-nums">
                <Timer size={13} strokeWidth={3} /> {seconds}s
              </span>
            )}
            <span className="flex items-center gap-1 text-xs font-black tabular-nums">
              <Trophy size={13} strokeWidth={3} /> {Math.max(best, score)}
            </span>
            <button
              onClick={() => { clearAll(); onClose(); }}
              aria-label="Close"
              className="w-7 h-7 flex items-center justify-center border-2 border-black rounded-full bg-white"
            >
              <X size={14} strokeWidth={3} />
            </button>
          </div>
        </div>

        {/*
          Square play area, so a shape's position means the same on a phone and
          a laptop. touch-none stops a tap near the edge scrolling the page
          underneath instead of registering.
        */}
        {/*
          Keyframes live with the component rather than in the global stylesheet:
          they exist for these shapes only, and nothing else should be able to
          depend on them.

          The animation drives transform alone — a compositor property — so a
          dozen shapes in flight cost no layout or paint work, which is what
          keeps this smooth on the cheap Android phones most students carry.
        */}
        <style>{`
          @keyframes sv-approach {
            from { transform: translate(-50%, -50%) translateZ(${Z_START}px) rotateX(0deg) rotateY(0deg); }
            to   { transform: translate(-50%, -50%) translateZ(${Z_END}px) rotateX(200deg) rotateY(340deg); }
          }
          @keyframes sv-appear {
            from { transform: translate(-50%, -50%) scale(0.6); opacity: 0; }
            to   { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          }
        `}</style>

        {/*
          perspective is what makes translateZ read as depth rather than scale.
          preserve-3d on the container keeps each shape in the same 3D space, so
          two shapes at different depths overlap correctly instead of stacking
          by DOM order.
        */}
        <div
          style={{ perspective: '720px', transformStyle: 'preserve-3d' }}
          className={`relative w-full aspect-square touch-none select-none overflow-hidden transition-colors duration-150 ${
            flash ? 'bg-red-200' : 'bg-[#0E1626]'
          }`}
        >
          {/*
            A horizon and a vanishing point. Without something receding, a shape
            growing on a flat colour reads as a shape growing, not as a shape
            approaching — the depth cue does the work the perspective cannot.
          */}
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(circle at 50% 50%, #1B2B45 0%, #0E1626 70%), ' +
                'repeating-linear-gradient(0deg, transparent 0 38px, rgba(255,255,255,0.05) 38px 39px), ' +
                'repeating-linear-gradient(90deg, transparent 0 38px, rgba(255,255,255,0.05) 38px 39px)',
            }}
          />
          {phase === 'ready' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <Target size={28} strokeWidth={2.5} className="text-[#F26B4D]" />
              <p className="font-black text-lg text-white">Forty-five seconds of attention</p>
              <p className="text-sm font-bold text-white/80">
                Tap the <span className="text-[#F26B4D]">circles</span> as they fly at you. Leave the{' '}
                <span className="text-white">squares</span> alone — a square costs a point.
              </p>
              <p className="text-xs font-bold text-white/50">
                Holding back is the hard part. That is the exercise.
              </p>
              <button
                onClick={start}
                className="mt-1 h-10 px-5 border-2 border-black rounded-xl bg-[#A7E2D1] font-bold text-sm shadow-[3px_3px_0px_0px_#111] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all"
              >
                Start
              </button>
              <p className="text-[11px] font-bold text-white/40">
                {playsLeft} of {MAX_PLAYS} turns left this hour
              </p>
            </div>
          )}

          {phase === 'settle' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <p className="text-6xl font-black tabular-nums text-white">{settle}</p>
              <p className="text-sm font-bold text-white/60">Settle.</p>
            </div>
          )}

          {phase === 'playing' && targets.map((t) => (
            <button
              key={t.id}
              onPointerDown={() => hit(t)}
              aria-label={t.go ? 'Tap this' : 'Do not tap this'}
              style={{
                left: `${t.x}%`,
                top: `${t.y}%`,
                width: SHAPE_PX,
                height: SHAPE_PX,
                // The faces live in this element's 3D space, so the tumble in
                // the keyframes turns a solid rather than spinning a picture.
                /*
                 * The faces live in this element's 3D space, so the tumble in
                 * the keyframes turns a solid rather than spinning a picture.
                 *
                 * Nothing here may set filter, opacity below 1, mask or
                 * clip-path. Those are grouping properties: the spec flattens
                 * preserve-3d on any element that has one, which would collapse
                 * the cube to a rotating square with no warning. The glow lives
                 * on the faces instead, where flattening a leaf costs nothing.
                 */
                transformStyle: 'preserve-3d',
                background: 'transparent',
                border: 'none',
                padding: 0,

                /*
                 * The flight is one animation whose duration is the shape's
                 * whole life, so it reaches the viewer exactly as it expires.
                 * `forwards` holds the final frame for the few milliseconds
                 * before React removes it, rather than snapping back to the
                 * start — which would read as the shape teleporting away.
                 */
                animation: flat
                  ? 'sv-appear 180ms ease-out both'
                  : `sv-approach ${t.life}ms linear forwards`,
              }}
              className="absolute active:brightness-75"
            >
              {t.go ? <Sphere hue={t.hue} /> : <Cube hue={t.hue} />}
            </button>
          ))}

          {phase === 'over' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center overflow-y-auto">
              <p className="text-4xl font-black tabular-nums text-white">{score}</p>
              <p className="text-xs font-bold text-white/50">
                {slips === 0
                  ? 'No slips — you held back every time.'
                  : `${slips} slip${slips === 1 ? '' : 's'} on a square.`}
              </p>
              {/*
                The table, on the screen where a score has just been earned —
                a number means little until it sits next to the last few.
              */}
              {scores.length > 0 && (
                <div className="w-full max-w-[15rem] mt-1 border-2 border-white/15 rounded-lg overflow-hidden">
                  <div className="grid grid-cols-[1.6rem_1fr_2.6rem_2.6rem] gap-1 px-2 py-1 bg-white/10 text-[9px] font-bold uppercase tracking-wider text-white/50">
                    <span>#</span><span>When</span>
                    <span className="text-right">Slips</span>
                    <span className="text-right">Points</span>
                  </div>
                  {/*
                    Newest first, which is where the eye goes after a round.
                    The best is marked rather than sorted to the top: reordering
                    would make the row that just appeared hard to find.
                  */}
                  {scores.map((r, i) => (
                    <div
                      key={r.t}
                      className={`grid grid-cols-[1.6rem_1fr_2.6rem_2.6rem] gap-1 px-2 py-1 text-[11px] font-bold tabular-nums ${
                        i === 0 ? 'bg-[#A7E2D1]/20 text-white' : 'text-white/70'
                      }`}
                    >
                      <span className="text-white/40">{i + 1}</span>
                      <span className="truncate">{ago(r.t)}</span>
                      <span className="text-right text-white/50">{r.slips ?? 0}</span>
                      <span className="text-right">
                        {r.score}
                        {r.score === best && best > 0 && (
                          <span className="text-[#F9E076]" title="Best"> ★</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-sm font-bold text-white/80 mt-1">
                {/*
                  Every ending points back at the work. The most useful thing a
                  break can do is finish.
                */}
                Now pick one thing and start it.
              </p>
              <div className="flex gap-2 mt-2">
                {playsLeft > 0 && (
                  <button
                    onClick={start}
                    className="h-10 px-4 border-2 border-black rounded-xl bg-[#A7E2D1] font-bold text-sm shadow-[3px_3px_0px_0px_#111] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all"
                  >
                    Again
                  </button>
                )}
                <button
                  onClick={() => { clearAll(); onClose(); }}
                  className="h-10 px-4 border-2 border-black rounded-xl bg-white font-bold text-sm shadow-[3px_3px_0px_0px_#111]"
                >
                  Back to studying
                </button>
              </div>
              <p className="text-[11px] font-bold text-white/40 mt-1">
                {playsLeft} of {MAX_PLAYS} turns left this hour
              </p>
            </div>
          )}

          {phase === 'limit' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <Timer size={28} strokeWidth={2.5} className="text-gray-400" />
              <p className="font-black text-lg text-white">That is enough for now</p>
              <p className="text-sm font-bold text-white/80">
                {MAX_PLAYS} turns an hour. The next one unlocks in about {wait} minute{wait === 1 ? '' : 's'}.
              </p>
              <p className="text-xs font-bold text-white/50">
                Another round right now would not be a break from anything.
              </p>
              <button
                onClick={() => { clearAll(); onClose(); }}
                className="mt-1 h-10 px-5 border-2 border-black rounded-xl bg-[#A7E2D1] font-bold text-sm shadow-[3px_3px_0px_0px_#111]"
              >
                Back to studying
              </button>
            </div>
          )}
        </div>

        {/*
          Signed. An easter egg with no author is just an odd feature; the point
          of finding one is knowing somebody put it there on purpose.
        */}
        <div className="px-3 py-1.5 border-t-2 border-black bg-[#F9E076] text-center">
          <p className="text-[10px] font-bold text-black/60">
            this easter egg is created by dazedcoder1
          </p>
        </div>
      </div>
    </div>
  );
}
