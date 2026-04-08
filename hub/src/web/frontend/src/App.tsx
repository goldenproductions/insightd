import { HashRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { ShowInternalProvider } from '@/hooks/useShowInternal';
import { Layout } from '@/components/Layout';
import { api } from '@/lib/api';
import { useState, useEffect, lazy, Suspense } from 'react';

const SetupWizardPage = lazy(() => import('@/pages/SetupWizardPage').then(m => ({ default: m.SetupWizardPage })));
const DashboardPage = lazy(() => import('@/pages/dashboard/DashboardPage').then(m => ({ default: m.DashboardPage })));
const HostsPage = lazy(() => import('@/pages/hosts/HostsPage').then(m => ({ default: m.HostsPage })));
const HostDetailPage = lazy(() => import('@/pages/hosts/HostDetailPage').then(m => ({ default: m.HostDetailPage })));
const ContainerDetailPage = lazy(() => import('@/pages/containers/ContainerDetailPage').then(m => ({ default: m.ContainerDetailPage })));
const AlertsPage = lazy(() => import('@/pages/AlertsPage').then(m => ({ default: m.AlertsPage })));
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
const ServicesPage = lazy(() => import('@/pages/ServicesPage').then(m => ({ default: m.ServicesPage })));
const ServiceDetailPage = lazy(() => import('@/pages/ServiceDetailPage').then(m => ({ default: m.ServiceDetailPage })));
const ServiceFormPage = lazy(() => import('@/pages/ServiceFormPage').then(m => ({ default: m.ServiceFormPage })));
const ApiKeysPage = lazy(() => import('@/pages/ApiKeysPage').then(m => ({ default: m.ApiKeysPage })));
const StatusPage = lazy(() => import('@/pages/StatusPage').then(m => ({ default: m.StatusPage })));

function PageLoading() {
  return (
    <div className="flex h-[50vh] items-center justify-center text-muted">
      Loading…
    </div>
  );
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
                <Route path="/endpoints" element={<EndpointsPage />} />
                <Route path="/endpoints/new" element={<EndpointFormPage />} />
                <Route path="/endpoints/:endpointId" element={<EndpointDetailPage />} />
                <Route path="/endpoints/:endpointId/edit" element={<EndpointFormPage />} />
                <Route path="/services" element={<ServicesPage />} />
                <Route path="/services/new" element={<ServiceFormPage />} />
                <Route path="/services/:groupId" element={<ServiceDetailPage />} />
                <Route path="/services/:groupId/edit" element={<ServiceFormPage />} />
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
          </HashRouter>
          </ShowInternalProvider>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
