import React from 'react';

/**
 * The mark on a module's square badge in the curriculum.
 *
 * It used to be the module's ordinal. A number tells a student which module
 * this is, which they can already read from the position in the list and from
 * the title — so it was spending the most prominent element of the row on the
 * least informative thing in it.
 *
 * Drawn as vector rather than shipped as the PNG it came from. The source was a
 * 1240px render; at the 48px this occupies, almost all of that file is detail
 * nobody will ever see, downloaded by every student on every visit. Vector also
 * survives a retina screen and a 2x badge without a second asset.
 *
 * Faithful to the original's composition — ring, laurels, checklist sheet, cap
 * and tassel, open book — but flat, because the original's soft 3D shading is
 * built from gradients and blurs that cost real bytes and collapse into mud
 * below about 64px anyway. Flat colour is what actually reads at badge size.
 *
 * The number is not lost: the badge carries it as its accessible label, so a
 * screen reader still announces "Module 3" where a sighted reader sees the
 * position.
 *
 * @param {string} [className] sizing; the badge sets its own box
 */
export default function StudyIcon({ className = 'w-11 h-11 md:w-[52px] md:h-[52px]' }) {
  /*
   * Half a wreath, rendered twice — once mirrored.
   *
   * Not an `<svg:use href="#id">`, which is the obvious way to do this and is
   * wrong here: every module on the page renders this component, so the id
   * would be duplicated down the document and each `use` would resolve to the
   * *first* one. Collapsing or removing that module then takes the right-hand
   * laurel off every other icon on the page. A plain element rendered twice has
   * no such coupling.
   */
  const laurel = (
    <>
      <path
        d="M10.6 44.2c1-5.6 2.8-11.2 6.6-16.4"
        fill="none"
        stroke="#3F8FE0"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <ellipse cx="11.4" cy="41.6" rx="3.5" ry="1.9" transform="rotate(-42 11.4 41.6)" />
      <ellipse cx="13" cy="36.4" rx="3.5" ry="1.9" transform="rotate(-33 13 36.4)" />
      <ellipse cx="15.2" cy="31.6" rx="3.4" ry="1.8" transform="rotate(-24 15.2 31.6)" />
      <ellipse cx="18" cy="27.6" rx="3.2" ry="1.7" transform="rotate(-14 18 27.6)" />
    </>
  );

  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Disc, then ring over its edge. */}
      <circle cx="32" cy="32" r="29" fill="#DDEBFA" />
      <circle cx="32" cy="32" r="29.4" fill="none" stroke="#1667D6" strokeWidth="4.4" />

      {/*
        Laurels. One shape mirrored, rather than two hand-placed sets — the pair
        only reads as a wreath if the halves match exactly, and by eye they never
        quite do.
      */}
      <g fill="#4A97E8">
        <g>{laurel}</g>
        <g transform="translate(64 0) scale(-1 1)">{laurel}</g>
      </g>

      {/* The little burst at the top left. */}
      <g stroke="#F5B01F" strokeWidth="2.1" strokeLinecap="round">
        <path d="M16.4 13.6 19.8 16.4" />
        <path d="M13.8 18.6 17.8 19.8" />
        <path d="M14.2 24 18.2 23.2" />
      </g>

      {/* Checklist sheet on its blue card. */}
      <rect x="20" y="14" width="28" height="34" rx="4" fill="#1E6FD6" />
      <rect x="22" y="16" width="25" height="32" rx="2.5" fill="#FFFFFF" />

      <g strokeLinecap="round">
        <rect x="25" y="20.5" width="5.6" height="5.6" rx="1.6" fill="#2482ED" />
        <path d="M26.3 23.3 27.4 24.4 29.3 22.1" fill="none" stroke="#FFFFFF" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M33 22.2H45" stroke="#A9BBD0" strokeWidth="1.7" />
        <path d="M33 24.8H43" stroke="#A9BBD0" strokeWidth="1.7" />

        <rect x="25" y="27.5" width="5.6" height="5.6" rx="1.6" fill="#21A34A" />
        <path d="M26.3 30.3 27.4 31.4 29.3 29.1" fill="none" stroke="#FFFFFF" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M33 29.2H45" stroke="#A9BBD0" strokeWidth="1.7" />
        <path d="M33 31.8H43" stroke="#A9BBD0" strokeWidth="1.7" />

        <rect x="25" y="34.5" width="5.6" height="5.6" rx="1.6" fill="#F0871B" />
        <path d="M26.3 37.3 27.4 38.4 29.3 36.1" fill="none" stroke="#FFFFFF" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M33 36.2H45" stroke="#A9BBD0" strokeWidth="1.7" />
        <path d="M33 38.8H43" stroke="#A9BBD0" strokeWidth="1.7" />
      </g>

      {/* Cap: the head band first, so the board sits over it. */}
      <path d="M35 21h12l-1.4 6q-4.6 2.4-9.2 0Z" fill="#1B3562" />
      <path d="M29 18.5 41 12.2 53 18.5 41 24.8Z" fill="#223F72" />
      <path
        d="M50 16.7 54.3 18.8V25"
        fill="none"
        stroke="#F4B21E"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="54.3" cy="26.6" r="2" fill="#F4B21E" />
      <rect x="52.8" y="28" width="3" height="5" rx="1.5" fill="#F4B21E" />

      {/*
        The open book, last, so it sits over the sheet and the ring exactly as it
        does in the original.
      */}
      <path d="M12 43.5c7-2.5 15-1.7 19.5 2v10.5C27 52.3 19 51.5 12 54Z" fill="#1668DC" />
      <path d="M52 43.5c-7-2.5-15-1.7-19.5 2v10.5C37 52.3 45 51.5 52 54Z" fill="#1668DC" />
      <path d="M14.6 44.6c5.6-1.8 11.6-1.1 15.7 1.8v7.8c-4.1-2.9-10.1-3.6-15.7-1.8Z" fill="#F7FAFF" />
      <path d="M49.4 44.6c-5.6-1.8-11.6-1.1-15.7 1.8v7.8c4.1-2.9 10.1-3.6 15.7-1.8Z" fill="#F7FAFF" />
      <g fill="none" stroke="#D3E0EE" strokeWidth="1" strokeLinecap="round">
        <path d="M17.4 46.8c3.6-.9 7.6-.4 10.6 1.4" />
        <path d="M17.4 49.6c3.6-.9 7.6-.4 10.6 1.4" />
        <path d="M46.6 46.8c-3.6-.9-7.6-.4-10.6 1.4" />
        <path d="M46.6 49.6c-3.6-.9-7.6-.4-10.6 1.4" />
      </g>
      <path
        d="M28.6 54.6q3.4 3 6.8 0"
        fill="none"
        stroke="#F4B21E"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
