import { HashRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { Layout } from '@/components/Layout';
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
import { WebhookFormPage } from '@/pages/WebhookFormPage';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <HashRouter>
            <Routes>
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
                <Route path="/webhooks" element={<WebhooksPage />} />
                <Route path="/webhooks/new" element={<WebhookFormPage />} />
                <Route path="/webhooks/:webhookId/edit" element={<WebhookFormPage />} />
                <Route path="/add-agent" element={<AddAgentPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/login" element={<LoginPage />} />
              </Route>
            </Routes>
          </HashRouter>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
