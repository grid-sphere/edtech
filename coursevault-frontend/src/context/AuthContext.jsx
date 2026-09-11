import React, { createContext, useContext, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchAPI, readTokenClaims, isTokenExpired } from '../services/api.js';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  /*
   * Set when the server answered with a verification challenge rather than a
   * session. Its presence is what makes the auth page show the code screen —
   * `user` stays null throughout, so nothing can route into the app.
   */
  const [pendingVerification, setPendingVerification] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    const initAuth = async () => {
      const token = localStorage.getItem('token');
      if (token) {
        try {
          const data = await fetchAPI('/auth/me');
          setUser(data.user);
        } catch (err) {
          /*
           * This used to discard the token on *any* failure, which is the
           * likeliest reason people were "logged out" at times that had nothing
           * to do with the token's expiry. /auth/me runs on every app load, so
           * a backend that was restarting, a phone that woke up before its
           * connection did, or one dropped request at the wrong moment threw
           * away a perfectly good session — and the next thing the user saw was
           * the sign-in screen, indistinguishable from an expired login.
           *
           * Only the server actually rejecting the credential is grounds for
           * clearing it. 401 is an invalid or expired token; 403 is the
           * verify-scoped token left over from a reload part-way through
           * verification, which cannot reach /auth/me. Both mean: sign in again.
           */
          const rejected = err?.status === 401 || err?.status === 403;
          /*
           * No status at all means fetch itself failed — offline, DNS, the
           * server not listening yet. 5xx means it is up but broken. Those are
           * the two cases where the token is probably still good and the answer
           * is to wait, not to sign out. Any other 4xx is left alone: the token
           * is kept, but nothing is assumed about it.
           */
          const unreachable = !err?.status || err.status >= 500;
          if (rejected) {
            localStorage.removeItem('token');
          } else if (unreachable) {
            /*
             * Couldn't ask the server. Trust the token we are holding, as far
             * as its own expiry claim, and carry on with the identity it
             * carries. This is not a security decision — the claims are
             * unverified and the app grants nothing on their say-so. Every
             * request still sends the token, and the server still decides. The
             * worst case is a session that looks alive until the first real
             * call comes back 401, which is better than one that is thrown
             * away because the network hiccupped on startup.
             */
            const claims = readTokenClaims(token);
            if (claims && !claims.scope && !isTokenExpired(claims)) {
              setUser({
                id: claims.id,
                email: claims.email,
                name: claims.name,
                role: claims.role,
              });
            }
          }
        }
      }
      setLoading(false);
    };
    initAuth();
  }, []);

  /**
   * Where a freshly signed-in user belongs.
   *
   * Both login and register sent everyone to /explore, which is the student
   * browse page. An educator therefore landed in the student view and only
   * reached their own panel by noticing the Dashboard tab and clicking it —
   * which looked like the app had logged them in as the wrong kind of user,
   * especially right after signing out of a student account.
   *
   * MainLayout already picks the navigation from the same role, so this keeps
   * the landing page and the nav consistent.
   */
  const homeFor = (role) =>
    role === 'educator' || role === 'admin' ? '/dashboard' : '/home';

  /**
   * @param {string} identifier a mobile number or an email address
   * @param {string} password
   */
  const login = async (identifier, password) => {
    const data = await fetchAPI('/auth/login', {
      method: 'POST',
      // `email` is sent alongside `identifier` for one release: a browser tab
      // left open across the deploy will be running the old backend contract.
      body: JSON.stringify({ identifier, email: identifier, password })
    });
    return finishAuth(data);
  };

  /**
   * Complete a login or registration.
   *
   * The server answers in one of two shapes: a session, or a verification
   * challenge. `requiresVerification` means the token that came back is
   * verify-scoped — good only for submitting a code — so it is stored (the
   * verification calls need it) but no user is set and no navigation happens.
   * Setting the user would let ProtectedRoute wave them into the app holding a
   * token every other endpoint refuses.
   *
   * As of removing the sign-in second factor, no route sets that flag: login
   * and registration both return a session outright. The branch is kept
   * rather than deleted because it is the only thing standing between a
   * verify-scoped token and ProtectedRoute — if a challenge is ever
   * reintroduced and this has been removed, the failure is a user waved into
   * the app holding a token every endpoint refuses, which reads as the whole
   * site being broken rather than as a missing branch.
   *
   * @returns {{requiresVerification: boolean, email?: string}}
   */
  const finishAuth = (data) => {
    localStorage.setItem('token', data.token);

    if (data.requiresVerification) {
      setPendingVerification({
        email: data.user?.email,
        name: data.user?.name,
        // 'two-factor' for a returning user, 'confirm-email' for one who has
        // not confirmed the address yet. Same code, different thing to say.
        reason: data.reason || 'confirm-email',
      });
      return { requiresVerification: true, email: data.user?.email };
    }

    setPendingVerification(null);
    setUser(data.user);
    navigate(homeFor(data.user?.role), { replace: true });
    return { requiresVerification: false };
  };

  /**
   * Called once a code is accepted. The response carries a full session token
   * in place of the scoped one.
   */
  const completeVerification = (data) => {
    if (data?.token) localStorage.setItem('token', data.token);
    setPendingVerification(null);
    setUser(data.user);
    navigate(homeFor(data.user?.role), { replace: true });
  };

  /** Abandon a half-finished verification and return to the sign-in form. */
  const cancelVerification = () => {
    localStorage.removeItem('token');
    setPendingVerification(null);
    setUser(null);
  };

  /**
   * Takes the whole form as one object.
   *
   * Registration now collects nine fields; as positional arguments they would
   * be a line of same-typed strings where transposing two is silent and
   * produces an account with a board in the state column.
   *
   * @param {{name, phone, password, email?, role?, class_level?, board?, state?, school?}} payload
   */
  const register = async (payload) => {
    const data = await fetchAPI('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return finishAuth(data);
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
    // replace: otherwise Back returns to the previous account's page, which
    // renders from cache for a moment before the redirect kicks in.
    navigate('/login', { replace: true });
  };

  /**
   * Apply a profile change coming back from the server.
   *
   * A new token accompanies name or email changes — the JWT carries both in
   * its payload, so without swapping it the old values would stay in effect for
   * the rest of the token's life, which is now a year rather than a week.
   */
  const applyProfileUpdate = ({ user: updatedUser, token }) => {
    if (token) localStorage.setItem('token', token);
    if (updatedUser) setUser(updatedUser);
  };

  return (
    <AuthContext.Provider value={{
      user, login, register, logout, loading, applyProfileUpdate,
      pendingVerification, completeVerification, cancelVerification,
    }}>
      {!loading && children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);