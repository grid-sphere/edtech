import React, { useMemo, useState } from 'react';
import { Outlet, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { Compass, BookOpen, LayoutDashboard, BarChart3, User as UserIcon, LifeBuoy, Home, Search } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import PageTransition from '../ui/PageTransition.jsx';
import NotificationBell from './NotificationBell.jsx';
import HelpDeskPanel from './HelpDeskPanel.jsx';
import VerifyEmailBanner from '../auth/VerifyEmailBanner.jsx';

const transitionColors = [
  "#E63946", // Red
  "#A7E2D1", // Mint
  "#F9E076", // Yellow
  "#932973", // Purple
  "#87CEFA", // Sky Blue
  "#F26B4D", // Orange
  "#A084E8"  // Lavender
];

/**
 * One tab in the phone bottom bar.
 *
 * `flex-1 min-w-0` is what lets five tabs fit a 360px screen: without it the
 * labels set the width and the row overflows. `truncate` is the backstop for
 * a longer label in another language.
 */
function TabButton({ icon: Icon, label, active, pressed, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Only route tabs claim to be the current page. The help desk is a
      // drawer, so it reports pressed instead — saying "current page" for
      // something that never changed the page misleads a screen reader.
      aria-current={pressed === undefined && active ? 'page' : undefined}
      aria-pressed={pressed}
      className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 px-1 py-1.5
                  rounded-2xl font-bold text-[10px] transition-colors ${
        active ? 'bg-[#A7E2D1] border-2 border-black' : 'text-black/60'
      }`}
    >
      <Icon size={19} strokeWidth={2.5} className="shrink-0" />
      <span className="truncate max-w-full">{label}</span>
    </button>
  );
}

/**
 * The home search box, living in the header.
 *
 * State is held in the URL rather than in React, because the input and the list
 * it filters are now in different components — the header and the page. A
 * context would work, but `?q=` also survives a refresh, can be linked, and
 * keeps the back button meaningful.
 *
 * `replace` matters: without it every keystroke would push a history entry, and
 * leaving the page would mean pressing Back once per character typed.
 */
function HeaderSearch() {
  const [params, setParams] = useSearchParams();
  const value = params.get('q') ?? '';

  const onChange = (next) => {
    const p = new URLSearchParams(params);
    // Removed rather than left empty, so the URL is a clean /home once the box
    // is cleared instead of a trailing "?q=".
    if (next) p.set('q', next);
    else p.delete('q');
    setParams(p, { replace: true });
  };

  return (
    /*
     * One row at every width: logo, then this, then the bell.
     *
     * `flex-1 min-w-0` is what makes that safe on a phone. min-w-0 is the
     * load-bearing half — a flex item refuses to shrink below its content by
     * default, so without it the input's intrinsic width would push the bell
     * off the edge instead of the field simply getting narrower.
     *
     * The arithmetic on a 360px screen: 32px of gutter, a 65px logo, a 36px
     * bell and ~24px of gaps leaves a little over 200px for the field, which
     * fits the placeholder.
     */
    <div className="relative flex-1 min-w-0 mx-2 md:mx-4 md:max-w-[200px] lg:max-w-sm">
      <Search
        size={16}
        strokeWidth={3}
        className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search your classes..."
        aria-label="Search your classes"
        className="w-full h-10 pl-10 pr-4 rounded-xl border-2 border-black bg-white text-sm
                   font-medium focus:outline-none focus:shadow-[3px_3px_0px_0px_#F26B4D]
                   transition-shadow"
      />
    </div>
  );
}

export default function MainLayout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  /*
   * Only on the student home page, because that is the only list it filters.
   *
   * A search box in the header of every page would be a promise the app does
   * not keep: on Explore it would sit beside that page's own search doing
   * nothing, and on Profile it would filter an empty set. Better to show it
   * where it works than to show it everywhere and have it lie.
   */
  const showSearch = user?.role !== 'educator' && location.pathname === '/home';
  const [helpOpen, setHelpOpen] = useState(false);
  // Set when the drawer is opened from a ticket notification, so it can land
  // on that thread instead of the list.
  const [helpTicketId, setHelpTicketId] = useState(null);

  const openHelp = (ticketId = null) => {
    setHelpTicketId(ticketId);
    setHelpOpen(true);
  };

  const currentColor = useMemo(() => {
    const pathHash = location.pathname.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return transitionColors[pathHash % transitionColors.length];
  }, [location.pathname]);

  const navItems = user?.role === 'educator' 
    ? [
        { path: '/dashboard', label: 'Dashboard' },
        { path: '/analytics', label: 'Analytics' },
      ]
    : [
        { path: '/home', label: 'Home' },
        { path: '/explore', label: 'Explore' },
        { path: '/my-learning', label: 'My Learning' },
      ];

  const getIcon = (path) => {
    if (path === '/home') return Home;
    if (path === '/explore') return Compass;
    if (path === '/my-learning') return BookOpen;
    if (path === '/dashboard') return LayoutDashboard;
    if (path === '/analytics') return BarChart3;
    return Compass;
  };

  return (
    <div className="min-h-screen bg-[#FDF1E9] pb-20 font-sans overflow-x-hidden">
     <nav className="relative z-50 flex flex-wrap justify-between items-center px-4 md:px-12 py-2 md:py-3 sticky top-0 bg-[#FDF1E9] shadow-[0px_4px_10px_rgba(0,0,0,0.12)]">
        {/* Logo */}
        <div 
          className="relative cursor-pointer group inline-block shrink-0" 
          onClick={() => navigate(user?.role === 'educator' ? '/dashboard' : '/home')}
        >
          <img src="/sv-logo.png" alt="Sharda Vidyapeeth" className="h-10 md:h-12 w-auto" />
        </div>

        {/* Center Nav - desktop only */}
        <div className="hidden md:flex items-center gap-4">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <div key={item.path} className="relative group cursor-pointer" onClick={() => navigate(item.path)}>
                <div className="absolute inset-0 bg-[#F26B4D] rounded-[40px] border-2 border-black transition-all duration-300 translate-x-0 translate-y-0 group-hover:-translate-x-2 group-hover:translate-y-2"></div>
                <div className="absolute inset-0 bg-[#932973] rounded-[40px] border-2 border-black transition-all duration-300 translate-x-0 translate-y-0 group-hover:-translate-x-1 group-hover:translate-y-1"></div>
                <button className={`relative z-10 px-5 py-1.5 rounded-[40px] border-2 border-black font-bold text-sm transition-all duration-300 flex items-center gap-2 ${isActive ? 'bg-[#A7E2D1] text-black' : 'bg-white text-black group-hover:bg-[#A7E2D1]'}`}>
                  {item.label}
                  <svg width="11" height="8" viewBox="0 0 14 10" fill="none" xmlns="http://www.w3.org/2000/svg" className="ml-1 mt-0.5">
                    <path d="M7 10L0.0717964 -1.30318e-06L13.9282 -9.10263e-08L7 10Z" fill="currentColor" stroke="black" strokeWidth="2" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            );
          })}
        </div>

        {showSearch && <HeaderSearch />}

        {/* User Info */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <NotificationBell onOpenSupport={openHelp} />

          {/*
            Help desk, desktop only.

            On a phone this lives in the bottom tab bar instead. The bar is
            md:hidden, so the two are exact complements — removing this
            outright would leave desktop with no way in at all.
          */}
          <button
            type="button"
            onClick={() => openHelp()}
            title="Help desk"
            aria-label="Help desk"
            aria-pressed={helpOpen}
            className="hidden md:flex items-center justify-center w-9 h-9 rounded-full border-2 border-black bg-white hover:bg-[#A7E2D1] transition-colors"
          >
            <LifeBuoy size={16} strokeWidth={3} />
          </button>

          {/*
            Name pill, desktop only.

            On a phone it was redundant twice over: the home page greeting
            already says the name, and Profile is a tab in the bottom bar, so
            this was neither telling nor going anywhere new — it just crowded
            a 360px header. The bar is md:hidden and this is hidden md:flex,
            so between them the profile route is reachable at every width.
          */}
          <button
            type="button"
            onClick={() => navigate('/profile')}
            title="Your profile"
            aria-current={location.pathname === '/profile' ? 'page' : undefined}
            className={`hidden md:flex max-w-[9rem] px-3 sm:px-4 py-1.5 rounded-[30px] border-2 border-black font-bold text-xs items-center gap-2 cursor-pointer transition-colors ${
              location.pathname === '/profile'
                ? 'bg-[#F9E076]'
                : 'bg-white hover:bg-[#F9E076]'
            }`}
          >
            <UserIcon size={13} strokeWidth={3} className="shrink-0" />
            <span className="truncate">{user?.name || 'student'}</span>
          </button>
        </div>
      </nav>

      {/* Above the page content, below the nav. Renders nothing for verified
          accounts, so it costs nothing for everyone else. */}
      <VerifyEmailBanner />

     {/*
          The page gutter, set once here.

          It was a flat px-6 — 24px a side at every width, so 48px of a 360px
          phone was margin before any content. 16px on a phone is the usual
          mobile gutter and gives that width back; desktop keeps 24px.

          Pages must not add their own horizontal padding on top of this.
          ProfilePage did, and compounded to 40px a side.
      */}
     <main className="max-w-[1400px] mx-auto px-4 md:px-6 pt-3 md:pt-10 relative">
        <AnimatePresence mode="wait">
          <PageTransition 
            key={location.pathname} 
            color={currentColor}
          >
            <Outlet />
          </PageTransition>
        </AnimatePresence>
      </main>

      {/* MOBILE BOTTOM TAB BAR

          Five tabs now that Help lives here, so the per-tab padding is gone
          and each one flexes instead. Fixed padding fitted four items and
          overflowed at five on a 360px screen.                              */}
      <nav
        aria-label="Main"
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex items-stretch bg-white border-t-2 border-black px-1 pt-1.5"
        style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
      >
        {navItems.map((item) => (
          <TabButton
            key={item.path}
            icon={getIcon(item.path)}
            label={item.label}
            active={location.pathname === item.path}
            onClick={() => navigate(item.path)}
          />
        ))}

        {/*
          Help desk, moved down from the header.

          A button rather than a link — it opens a drawer, not a route — so it
          reports pressed state instead of claiming to be the current page.
        */}
        <TabButton
          icon={LifeBuoy}
          label="Help"
          active={helpOpen}
          pressed={helpOpen}
          onClick={() => openHelp()}
        />

        {/* Phone route to the profile page, which is also where sign-out is. */}
        <TabButton
          icon={UserIcon}
          label="Profile"
          active={location.pathname === '/profile'}
          onClick={() => navigate('/profile')}
        />
      </nav>

      {helpOpen && (
        <HelpDeskPanel
          isEducator={user?.role === 'educator'}
          initialTicketId={helpTicketId}
          onClose={() => {
            setHelpOpen(false);
            // Clear it, or reopening the drawer from the header would jump
            // back into the thread they read last time.
            setHelpTicketId(null);
          }}
        />
      )}
    </div>
  );
}