/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, HashRouter, Routes, Route, Link, useLocation } from 'react-router';
import { Users, Database, CheckSquare, Download, Settings, Cloud } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';

import Dashboard from './pages/Dashboard';
import Sources from './pages/Sources';
import ReviewQueue from './pages/ReviewQueue';
import Contacts from './pages/Contacts';
import Exports from './pages/Exports';
import SettingsPage from './pages/Settings';

function Sidebar() {
  const location = useLocation();
  const navItems = [
    { icon: Cloud, label: 'Dashboard', path: '/' },
    { icon: Database, label: 'Sources', path: '/sources' },
    { icon: CheckSquare, label: 'Review Queue', path: '/review' },
    { icon: Users, label: 'Contacts', path: '/contacts' },
    { icon: Download, label: 'Exports', path: '/exports' },
    { icon: Settings, label: 'Privacy & Settings', path: '/settings' },
  ];

  return (
    <div className="w-64 border-r bg-gray-50/50 min-h-screen p-4 flex flex-col">
      <div className="flex items-center gap-2 px-2 mb-8 mt-2">
        <div className="bg-blue-600 p-1.5 rounded-md">
          <Cloud className="w-5 h-5 text-white" />
        </div>
        <span className="font-semibold text-lg tracking-tight">ContactBridge</span>
      </div>
      
      <nav className="flex-1 space-y-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                isActive 
                  ? 'bg-blue-100/50 text-blue-700 font-medium' 
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100/50'
              }`}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      
      <div className="mt-auto pt-4 border-t px-2">
        <p className="text-xs text-gray-500">Privacy-First Hub</p>
      </div>
    </div>
  );
}

export default function App() {
  const Router = import.meta.env.BASE_URL === '/' ? BrowserRouter : HashRouter;

  return (
    <Router>
      <div className="flex min-h-screen bg-white">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="/review" element={<ReviewQueue />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/exports" element={<Exports />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
      <Toaster />
    </Router>
  );
}
