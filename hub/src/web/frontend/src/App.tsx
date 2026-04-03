import { HashRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { ShowInternalProvider } from '@/lib/useShowInternal';
import { Layout } from '@/components/Layout';
import { SetupWizardPage } from '@/pages/SetupWizardPage';
import { useState, useEffect } from 'react';
import { DashboardPage } from '@/pages/DashboardPage';
import { HostsPage } from '@/pages/HostsPage';
import { HostDetailPage } from '@/pages/HostDetailPage';
import { ContainerDetailPage } from '@/pages/ContainerDetailPage';
import { AlertsPage } from '@/pages/AlertsPage';
import { EndpointsPage } from '@/pages/EndpointsPage';
import { EndpointDetailPage } from '@/pages/EndpointDetailPage';
import { EndpointFormPage } from '@/pages/EndpointFormPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { LoginPage } from '@/pages/LoginPage';
import { AddAgentPage } from '@/pages/AddAgentPage';
import { LogSplitPage } from '@/pages/LogSplitPage';
import { WebhooksPage } from '@/pages/WebhooksPage';
import { UpdatesPage } from '@/pages/UpdatesPage';
import { WebhookFormPage } from '@/pages/WebhookFormPage';
import { ServicesPage } from '@/pages/ServicesPage';
import { ServiceDetailPage } from '@/pages/ServiceDetailPage';
import { ServiceFormPage } from '@/pages/ServiceFormPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { StatusPage } from '@/pages/StatusPage';

export function App() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [mode, setMode] = useState('hub');

  useEffect(() => {
    fetch('/api/setup/status')
      .then(r => r.json())
      .then((d: { setupComplete: boolean; mode: string }) => {
        setSetupComplete(d.setupComplete);
        setMode(d.mode);
      })
      .catch(() => setSetupComplete(true)); // If API fails, skip wizard
  }, []);

  if (setupComplete === null) return null; // Loading

  if (!setupComplete) {
    return (
      <ThemeProvider>
        <SetupWizardPage mode={mode} onComplete={() => setSetupComplete(true)} />
      </ThemeProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <ShowInternalProvider>
          <HashRouter>
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
          </HashRouter>
          </ShowInternalProvider>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
