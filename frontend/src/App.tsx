import { useState, useEffect } from 'react';
import { Routes, Route, Link, useLocation } from 'react-router-dom';
import {
  Shield,
  Users,
  Key,
  CheckCircle,
  Activity,
  PlugZap,
  LogOut,
  UserCog,
  User,
  Database,
  Bell,
  Menu,
  X,
} from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Credentials from './pages/Credentials';
import Approvals from './pages/Approvals';
import AuditLog from './pages/AuditLog';
import Permissions from './pages/Permissions';
import Login from './pages/Login';
import AdminUsers from './pages/AdminUsers';
import AgentNew from './pages/AgentNew';
import AgentDetail from './pages/AgentDetail';
import Backups from './pages/Backups';
import Notifications from './pages/Notifications';
import OAuthComplete from './pages/OAuthComplete';
import { auth } from './api/client';
import type { User as UserType } from './api/client';

const navItems = [
  { path: '/', label: 'Dashboard', icon: Activity },
  { path: '/agents', label: 'Agents', icon: Users },
  { path: '/credentials', label: 'Credentials', icon: Key },
  { path: '/approvals', label: 'Approvals', icon: CheckCircle },
  { path: '/audit', label: 'Audit Log', icon: Activity },
  { path: '/backups', label: 'Backups', icon: Database },
  { path: '/notifications', label: 'Notifications', icon: Bell },
];

const adminNavItems = [
  { path: '/admin/users', label: 'Users', icon: UserCog },
];

function App() {
  const location = useLocation();
  const [user, setUser] = useState<UserType | null | undefined>(undefined);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Close drawer on route change
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    auth.session()
      .then((r) => setUser(r.authenticated && r.user ? r.user : null))
      .catch(() => setUser(null));
  }, []);

  // Loading session check
  if (user === undefined) {
    return (
      <div className="min-h-screen bg-reins-navy flex items-center justify-center">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-gray-600 border-t-trust-blue" />
      </div>
    );
  }

  // Public routes — no auth required
  if (location.pathname === '/oauth-complete') {
    return <OAuthComplete />;
  }

  // Not authenticated
  if (!user) {
    return <Login onSuccess={(u) => setUser(u)} />;
  }

  const handleLogout = async () => {
    await auth.logout();
    setUser(null);
  };

  const isAdmin = user.role === 'admin';

  const navLinks = (
    <>
      <ul className="space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.path;
          return (
            <li key={item.path}>
              <Link
                to={item.path}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-trust-blue text-white'
                    : 'text-gray-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="font-medium">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      {isAdmin && (
        <>
          <div className="mt-6 mb-2 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Admin
          </div>
          <ul className="space-y-1">
            {adminNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.path;
              return (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-lg transition-colors ${
                      isActive
                        ? 'bg-trust-blue text-white'
                        : 'text-gray-300 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="font-medium">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );

  return (
    <div className="min-h-screen flex">
      {/* Mobile backdrop */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 sm:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Sidebar — fixed drawer on mobile, static on desktop */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-reins-navy text-white flex flex-col transition-transform duration-200
          sm:static sm:translate-x-0 sm:z-auto
          ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Logo + mobile close button */}
        <div className="p-6 border-b border-white/10 flex items-start justify-between">
          <Link to="/" className="flex items-center gap-3">
            <Shield className="w-8 h-8 text-trust-blue" />
            <div>
              <span className="text-xl font-semibold">Reins</span>
              <p className="text-xs text-gray-400 mt-0.5">The trust layer for AI agents</p>
            </div>
          </Link>
          <button
            onClick={() => setMobileNavOpen(false)}
            className="sm:hidden text-gray-400 hover:text-white p-1 -mr-1 -mt-1"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 overflow-y-auto">
          {navLinks}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-white/10 space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <PlugZap className="w-4 h-4" />
            <span>System Status</span>
            <span className="ml-auto flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-safe-green"></span>
              <span className="text-safe-green">Online</span>
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <User className="w-4 h-4" />
            <span className="truncate">{user.name}</span>
            {isAdmin && (
              <span className="ml-auto text-xs bg-trust-blue/20 text-trust-blue px-1.5 py-0.5 rounded">
                Admin
              </span>
            )}
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-300 transition-colors w-full"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="sm:hidden flex items-center gap-3 px-4 h-14 bg-reins-navy text-white shrink-0 border-b border-white/10">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="text-gray-300 hover:text-white"
            aria-label="Open menu"
          >
            <Menu className="w-6 h-6" />
          </button>
          <Shield className="w-6 h-6 text-trust-blue" />
          <span className="font-semibold text-lg">Reins</span>
        </header>

        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/agents/new" element={<AgentNew />} />
            <Route path="/agents/:id" element={<AgentDetail />} />
            <Route path="/agents" element={<Permissions />} />
            <Route path="/credentials" element={<Credentials />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="/backups" element={<Backups />} />
            <Route path="/notifications" element={<Notifications />} />
            {isAdmin && <Route path="/admin/users" element={<AdminUsers />} />}
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default App;
