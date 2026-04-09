import { useState, useMemo } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { useShowInternal } from '@/hooks/useShowInternal';
import { UpdateBanner } from './UpdateBanner';
import {
  DashboardIcon, HostsIcon, AlertsIcon, InsightsIcon, EndpointsIcon, ServicesIcon,
  WebhooksIcon, KeyIcon, UpdatesIcon, AgentIcon, SettingsIcon,
  EyeIcon, SunIcon, MoonIcon, MenuIcon,
} from './Icons';

interface NavItem { to: string; label: string; icon: () => React.JSX.Element }
interface NavGroup { label: string; items: NavItem[] }

export function Layout() {
  const { authEnabled, isHubMode } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { showInternal, toggleShowInternal } = useShowInternal();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  const navGroups = useMemo<NavGroup[]>(() => [
    { label: 'Monitor', items: [
      { to: '/', label: 'Dashboard', icon: DashboardIcon },
      { to: '/hosts', label: 'Hosts', icon: HostsIcon },
      { to: '/services', label: 'Services', icon: ServicesIcon },
      { to: '/endpoints', label: 'Endpoints', icon: EndpointsIcon },
    ]},
    { label: 'Respond', items: [
      { to: '/alerts', label: 'Alerts', icon: AlertsIcon },
      { to: '/insights', label: 'Insights', icon: InsightsIcon },
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
              <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-white/35">
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
            <div key={location.pathname} className="animate-page-enter">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
