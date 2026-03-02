import { Routes, Route, Link, useLocation } from 'react-router-dom';
import {
  Shield,
  Users,
  FileText,
  Key,
  CheckCircle,
  Activity,
  PlugZap,
} from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import Policies from './pages/Policies';
import Credentials from './pages/Credentials';
import Approvals from './pages/Approvals';
import AuditLog from './pages/AuditLog';

const navItems = [
  { path: '/', label: 'Dashboard', icon: Activity },
  { path: '/agents', label: 'Agents', icon: Users },
  { path: '/policies', label: 'Policies', icon: FileText },
  { path: '/credentials', label: 'Credentials', icon: Key },
  { path: '/approvals', label: 'Approvals', icon: CheckCircle },
  { path: '/audit', label: 'Audit Log', icon: Activity },
];

function App() {
  const location = useLocation();

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

        {/* Connection Status */}
        <div className="p-4 border-t border-white/10">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <PlugZap className="w-4 h-4" />
            <span>System Status</span>
            <span className="ml-auto flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-safe-green"></span>
              <span className="text-safe-green">Online</span>
            </span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agents" element={<Agents />} />
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
