import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import MainLayout from './components/layout/MainLayout.jsx';
import AuthPage from './pages/AuthPage.jsx';
import ExplorePage from './pages/ExplorePage.jsx';
import MyLearningPage from './pages/MyLearningPage.jsx';
import CourseDetailPage from './pages/CourseDetailPage.jsx';
import EducatorDashboardPage from './pages/EducatorDashboardPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import DeleteAccountPage from './pages/DeleteAccountPage.jsx';
import GalleryManagementPage from './pages/GalleryManagementPage.jsx';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage.jsx';
import StudentHomePage from './pages/StudentHomePage.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';

// NEW: Import the security wrapper
import ScreenProtection from './components/security/ScreenProtection.jsx'; 

import './styles/globals.css';

/**
 * Send people to the landing page for their role.
 *
 * "/" and the catch-all both pointed at /explore, the student browse page, so
 * an educator arriving at either — a bookmark, a stale URL, a refresh on a
 * deleted route — was dropped into the student view and had to find their way
 * to Dashboard by hand.
 */
const RoleHome = () => {
  const { user } = useAuth();
  // Students land on /home now; educators keep their dashboard.
  const target = user?.role === 'educator' || user?.role === 'admin' ? '/dashboard' : '/home';
  return <Navigate to={target} replace />;
};

// Protected Route Wrapper
const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return null; 
  if (!user) return <Navigate to="/login" replace />;
  return children;
};

export default function App() {
  return (
    <BrowserRouter>
      {/*
        Outside AuthProvider on purpose. The theme applies to the sign-in page
        too, and that renders before anyone is authenticated — nesting it
        inside would mean the login screen never got the school's colours.
      */}
      <ThemeProvider>
      <AuthProvider>
        {/* SECURE ENVELOPE: This wraps every route to globally block screenshots and snipping tools */}
        <ScreenProtection>
          <Routes>
            {/* Public Auth Route */}
            <Route path="/login" element={<AuthPage />} />

            {/*
              Public, and deliberately outside ProtectedRoute.

              A privacy policy you have to sign in to read fails the two people
              who most need it: someone deciding whether to register, and an app
              store reviewer following the link from a listing.
            */}
            <Route path="/privacypolicy" element={<PrivacyPolicyPage />} />

            {/* Protected Application Routes */}
            <Route element={<ProtectedRoute><MainLayout /></ProtectedRoute>}>
              <Route path="/" element={<RoleHome />} />
              
              {/* Student Specific */}
              <Route path="/home" element={<StudentHomePage />} />
              <Route path="/explore" element={<ExplorePage />} />
              <Route path="/my-learning" element={<MyLearningPage />} />
              
              {/* Educator Specific */}
              <Route path="/dashboard" element={<EducatorDashboardPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              
              {/* Common Course View */}
              <Route path="/course/:id" element={<CourseDetailPage />} />

              {/* Any signed-in user — students and educators both. */}
              <Route path="/profile" element={<ProfilePage />} />
              {/* Inside the protected routes: closing an account
                  requires being signed in as that account. */}
              <Route path="/deleteaccount" element={<DeleteAccountPage />} />
              {/* Admin only. The page checks the role and the API enforces it —
                  the route itself is left open so a non-admin who follows a
                  link reads an explanation rather than being bounced. */}
              <Route path="/gallery" element={<GalleryManagementPage />} />
            </Route>
            
            {/* Catch-all Redirect */}
            <Route path="*" element={<RoleHome />} />
          </Routes>
        </ScreenProtection>
      </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}