import { HashRouter, Routes, Route, Navigate, useParams, useNavigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { ShortcutsProvider, useShortcutsContext } from '@/context/ShortcutsContext';
import { ShowInternalProvider } from '@/hooks/useShowInternal';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { Layout } from '@/components/Layout';
import { ShortcutHelpModal } from '@/components/ShortcutHelpModal';
import { api } from '@/lib/api';
import { useState, useEffect, lazy, Suspense } from 'react';

const SetupWizardPage = lazy(() => import('@/pages/SetupWizardPage').then(m => ({ default: m.SetupWizardPage })));
const DashboardPage = lazy(() => import('@/pages/dashboard/DashboardPage').then(m => ({ default: m.DashboardPage })));
const HostsPage = lazy(() => import('@/pages/hosts/HostsPage').then(m => ({ default: m.HostsPage })));
const HostDetailPage = lazy(() => import('@/pages/hosts/HostDetailPage').then(m => ({ default: m.HostDetailPage })));
const ContainerDetailPage = lazy(() => import('@/pages/containers/ContainerDetailPage').then(m => ({ default: m.ContainerDetailPage })));
const AlertsPage = lazy(() => import('@/pages/AlertsPage').then(m => ({ default: m.AlertsPage })));
const InsightsPage = lazy(() => import('@/pages/InsightsPage').then(m => ({ default: m.InsightsPage })));
const EndpointsPage = lazy(() => import('@/pages/EndpointsPage').then(m => ({ default: m.EndpointsPage })));
const EndpointDetailPage = lazy(() => import('@/pages/EndpointDetailPage').then(m => ({ default: m.EndpointDetailPage })));
const EndpointFormPage = lazy(() => import('@/pages/EndpointFormPage').then(m => ({ default: m.EndpointFormPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const LoginPage = lazy(() => import('@/pages/LoginPage').then(m => ({ default: m.LoginPage })));
const AddAgentPage = lazy(() => import('@/pages/AddAgentPage').then(m => ({ default: m.AddAgentPage })));
const LogSplitPage = lazy(() => import('@/pages/LogSplitPage').then(m => ({ default: m.LogSplitPage })));
const WebhooksPage = lazy(() => import('@/pages/WebhooksPage').then(m => ({ default: m.WebhooksPage })));
const UpdatesPage = lazy(() => import('@/pages/updates/UpdatesPage').then(m => ({ default: m.UpdatesPage })));
const WebhookFormPage = lazy(() => import('@/pages/WebhookFormPage').then(m => ({ default: m.WebhookFormPage })));
const StacksPage = lazy(() => import('@/pages/StacksPage').then(m => ({ default: m.StacksPage })));
const StackDetailPage = lazy(() => import('@/pages/StackDetailPage').then(m => ({ default: m.StackDetailPage })));
const StackFormPage = lazy(() => import('@/pages/StackFormPage').then(m => ({ default: m.StackFormPage })));
const ApiKeysPage = lazy(() => import('@/pages/ApiKeysPage').then(m => ({ default: m.ApiKeysPage })));
const StatusPage = lazy(() => import('@/pages/StatusPage').then(m => ({ default: m.StatusPage })));

function RedirectStackDetail() {
  const { groupId } = useParams();
  return <Navigate to={`/stacks/${groupId}`} replace />;
}

function RedirectStackEdit() {
  const { groupId } = useParams();
  return <Navigate to={`/stacks/${groupId}/edit`} replace />;
}

function PageLoading() {
  return (
    <div className="flex h-[50vh] items-center justify-center text-muted">
      Loading…
    </div>
  );
}

/**
 * Registers the app-wide keyboard shortcuts. Must live inside both HashRouter
 * (so it can useNavigate) and ShortcutsProvider (so it can register).
 */
function GlobalShortcuts() {
  const navigate = useNavigate();
  const { setHelpOpen, helpOpen } = useShortcutsContext();

  useKeyboardShortcut({
    keys: '?',
    description: 'Show keyboard shortcuts',
    scope: 'Global',
    onTrigger: () => setHelpOpen(!helpOpen),
  });
  useKeyboardShortcut({ keys: 'g d', description: 'Go to dashboard', scope: 'Global', onTrigger: () => navigate('/') });
  useKeyboardShortcut({ keys: 'g h', description: 'Go to hosts', scope: 'Global', onTrigger: () => navigate('/hosts') });
  useKeyboardShortcut({ keys: 'g s', description: 'Go to stacks', scope: 'Global', onTrigger: () => navigate('/stacks') });
  useKeyboardShortcut({ keys: 'g e', description: 'Go to endpoints', scope: 'Global', onTrigger: () => navigate('/endpoints') });
  useKeyboardShortcut({ keys: 'g i', description: 'Go to insights', scope: 'Global', onTrigger: () => navigate('/insights') });
  useKeyboardShortcut({ keys: 'g a', description: 'Go to alerts', scope: 'Global', onTrigger: () => navigate('/alerts') });
  useKeyboardShortcut({ keys: 'g u', description: 'Go to updates', scope: 'Global', onTrigger: () => navigate('/updates') });
  useKeyboardShortcut({ keys: 'g ,', description: 'Go to settings', scope: 'Global', onTrigger: () => navigate('/settings') });

  return null;
}

export function App() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [mode, setMode] = useState('hub');

  useEffect(() => {
    api<{ setupComplete: boolean; mode: string }>('/setup/status')
      .then(d => {
        setSetupComplete(d.setupComplete);
        setMode(d.mode);
      })
      .catch(() => setSetupComplete(true)); // If API fails, skip wizard
  }, []);

  if (setupComplete === null) return null; // Loading

  if (!setupComplete) {
    return (
      <ThemeProvider>
        <Suspense fallback={<PageLoading />}>
          <SetupWizardPage mode={mode} onComplete={() => setSetupComplete(true)} />
        </Suspense>
      </ThemeProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <ShowInternalProvider>
          <HashRouter>
            <ShortcutsProvider>
            <GlobalShortcuts />
            <ShortcutHelpModal />
            <Suspense fallback={<PageLoading />}>
            <Routes>
              <Route path="/status" element={<StatusPage />} />
              <Route element={<Layout />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/hosts" element={<HostsPage />} />
                <Route path="/hosts/:hostId" element={<HostDetailPage />} />
                <Route path="/hosts/:hostId/logs" element={<LogSplitPage />} />
                <Route path="/hosts/:hostId/containers/:containerName" element={<ContainerDetailPage />} />
                <Route path="/alerts" element={<AlertsPage />} />
                <Route path="/insights" element={<InsightsPage />} />
                <Route path="/endpoints" element={<EndpointsPage />} />
                <Route path="/endpoints/new" element={<EndpointFormPage />} />
                <Route path="/endpoints/:endpointId" element={<EndpointDetailPage />} />
                <Route path="/endpoints/:endpointId/edit" element={<EndpointFormPage />} />
                <Route path="/stacks" element={<StacksPage />} />
                <Route path="/stacks/new" element={<StackFormPage />} />
                <Route path="/stacks/:groupId" element={<StackDetailPage />} />
                <Route path="/stacks/:groupId/edit" element={<StackFormPage />} />
                {/* Old /services* URLs redirect to /stacks* (one release of bookmark compat) */}
                <Route path="/services" element={<Navigate to="/stacks" replace />} />
                <Route path="/services/new" element={<Navigate to="/stacks/new" replace />} />
                <Route path="/services/:groupId" element={<RedirectStackDetail />} />
                <Route path="/services/:groupId/edit" element={<RedirectStackEdit />} />
                <Route path="/webhooks" element={<WebhooksPage />} />
                <Route path="/webhooks/new" element={<WebhookFormPage />} />
                <Route path="/webhooks/:webhookId/edit" element={<WebhookFormPage />} />
                <Route path="/updates" element={<UpdatesPage />} />
                <Route path="/add-agent" element={<AddAgentPage />} />
                <Route path="/api-keys" element={<ApiKeysPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/login" element={<LoginPage />} />
              </Route>
            </Routes>
            </Suspense>
            </ShortcutsProvider>
          </HashRouter>
          </ShowInternalProvider>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
