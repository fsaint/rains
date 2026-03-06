import { useState, useEffect } from 'react';
import { Routes, Route, Link, useLocation } from 'react-router-dom';
import {
  Shield,
  Users,
  FileText,
  Key,
  CheckCircle,
  Activity,
  PlugZap,
  Lock,
  LogOut,
} from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import Policies from './pages/Policies';
import Credentials from './pages/Credentials';
import Approvals from './pages/Approvals';
import AuditLog from './pages/AuditLog';
import Permissions from './pages/Permissions';
import ClaimAgent from './pages/ClaimAgent';
import Login from './pages/Login';
import { auth } from './api/client';

const navItems = [
  { path: '/', label: 'Dashboard', icon: Activity },
  { path: '/agents', label: 'Agents', icon: Users },
  { path: '/permissions', label: 'Permissions', icon: Lock },
  { path: '/policies', label: 'Policies', icon: FileText },
  { path: '/credentials', label: 'Credentials', icon: Key },
  { path: '/approvals', label: 'Approvals', icon: CheckCircle },
  { path: '/audit', label: 'Audit Log', icon: Activity },
];

function App() {
  const location = useLocation();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    auth.session().then((r) => setAuthenticated(r.authenticated)).catch(() => setAuthenticated(false));
  }, []);

  // Render claim page without sidebar (it's a standalone page, no auth required)
  if (location.pathname.startsWith('/claim')) {
    return (
      <Routes>
        <Route path="/claim/:code?" element={<ClaimAgent />} />
      </Routes>
    );
  }

  // Loading session check
  if (authenticated === null) {
    return (
      <div className="min-h-screen bg-reins-navy flex items-center justify-center">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-gray-600 border-t-trust-blue" />
      </div>
    );
  }

  // Not authenticated
  if (!authenticated) {
    return <Login onSuccess={() => setAuthenticated(true)} />;
  }

  const handleLogout = async () => {
    await auth.logout();
    setAuthenticated(false);
  };

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 bg-reins-navy text-white flex flex-col">
        {/* Logo */}
        <div className="p-6 border-b border-white/10">
          <Link to="/" className="flex items-center gap-3">
            <Shield className="w-8 h-8 text-trust-blue" />
            <span className="text-xl font-semibold">Reins</span>
          </Link>
          <p className="text-xs text-gray-400 mt-1">The trust layer for AI agents</p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4">
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
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/permissions" element={<Permissions />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/audit" element={<AuditLog />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
