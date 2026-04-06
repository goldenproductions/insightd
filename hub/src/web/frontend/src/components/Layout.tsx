import { useState, useMemo } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { useShowInternal } from '@/hooks/useShowInternal';
import { UpdateBanner } from './UpdateBanner';

interface NavItem { to: string; label: string; icon: () => React.JSX.Element }
interface NavGroup { label: string; items: NavItem[] }

export function Layout() {
  const { authEnabled, isHubMode } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { showInternal, toggleShowInternal } = useShowInternal();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navGroups = useMemo<NavGroup[]>(() => [
    { label: 'Monitor', items: [
      { to: '/', label: 'Dashboard', icon: DashboardIcon },
      { to: '/hosts', label: 'Hosts', icon: HostsIcon },
      { to: '/services', label: 'Services', icon: ServicesIcon },
      { to: '/endpoints', label: 'Endpoints', icon: EndpointsIcon },
    ]},
    { label: 'Respond', items: [
      { to: '/alerts', label: 'Alerts', icon: AlertsIcon },
      { to: '/webhooks', label: 'Webhooks', icon: WebhooksIcon },
    ]},
    { label: 'System', items: [
      { to: '/updates', label: 'Updates', icon: UpdatesIcon },
      ...(isHubMode ? [{ to: '/add-agent', label: 'Add Agent', icon: AgentIcon }] : []),
      ...(authEnabled ? [
        { to: '/api-keys', label: 'API Keys', icon: KeyIcon },
        { to: '/settings', label: 'Settings', icon: SettingsIcon },
      ] : []),
    ]},
  ], [isHubMode, authEnabled]);

  return (
    <div className="flex min-h-screen">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-info focus:px-4 focus:py-2 focus:text-white">Skip to content</a>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-30 flex w-56 flex-col
        transition-transform duration-200 lg:translate-x-0 lg:static
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        bg-sidebar-bg
      `}>
        {/* Logo */}
        <div className="flex h-14 items-center px-4">
          <NavLink to="/" className="text-lg font-bold text-sidebar-active"
            onClick={() => setSidebarOpen(false)}>
            insightd
          </NavLink>
        </div>

        {/* Nav links */}
        <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-2 py-2">
          {navGroups.map(group => (
            <div key={group.label} className="mb-3">
              <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-white/35">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map(item => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    onClick={() => setSidebarOpen(false)}
                    className={({ isActive }) => `
                      flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors
                      ${isActive ? 'text-sidebar-active bg-sidebar-hover' : 'text-sidebar-text hover:text-white'}
                    `}
                  >
                    <item.icon />
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Bottom controls */}
        <div className="border-t border-white/10 px-4 py-3 space-y-1">
          <button
            onClick={toggleShowInternal}
            aria-label="Toggle insightd containers visibility"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:text-white text-sidebar-text"
          >
            <EyeIcon hidden={!showInternal} />
            {showInternal ? 'Hide insightd' : 'Show insightd'}
          </button>
          <button
            onClick={toggleTheme}
            aria-label="Toggle dark mode"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:text-white text-sidebar-text"
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Mobile header */}
        <header className="flex h-14 items-center gap-3 px-4 lg:hidden border-b border-border">
          <button onClick={() => setSidebarOpen(true)} aria-label="Toggle menu" className="p-1 text-fg">
            <MenuIcon />
          </button>
          <span className="text-sm font-bold text-fg">insightd</span>
        </header>

        <main id="main-content" className="flex-1 overflow-auto p-4 lg:p-6">
          <div className="mx-auto max-w-6xl">
            <UpdateBanner />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

// Simple SVG icons
function DashboardIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>;
}
function HostsIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="7" rx="2" /><rect x="2" y="14" width="20" height="7" rx="2" /><circle cx="6" cy="6.5" r="1" /><circle cx="6" cy="17.5" r="1" /></svg>;
}
function AlertsIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;
}
function EndpointsIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
}
function ServicesIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>;
}
function WebhooksIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>;
}
function KeyIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>;
}
function UpdatesIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-6.22-8.56" /><polyline points="21 3 21 9 15 9" /></svg>;
}
function AgentIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>;
}
function SettingsIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>;
}
function EyeIcon({ hidden }: { hidden: boolean }) {
  if (hidden) return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>;
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>;
}
function SunIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>;
}
function MoonIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></svg>;
}
function MenuIcon() {
  return <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 12h18M3 6h18M3 18h18" /></svg>;
}
