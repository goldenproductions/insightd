import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';

// Uses raw fetch intentionally: the hub goes down mid-request during updates,
// so we need custom error handling that api()/apiAuth() don't support.
type HubStatus = 'idle' | 'updating' | 'restarting' | 'done' | 'failed';

export function useHubUpdate() {
  const { token } = useAuth();
  const [hubStatus, setHubStatus] = useState<HubStatus>('idle');
  const [hubError, setHubError] = useState('');

  const startHubUpdate = async () => {
    setHubStatus('updating');
    setHubError('');
    try {
      const res = await fetch('/api/update/hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setHubStatus('failed');
        setHubError(data.error || `Server returned ${res.status}`);
        return;
      }
    } catch {
      // Expected — hub may go down during the request
    }
    setHubStatus('restarting');
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          clearInterval(poll);
          setHubStatus('done');
          setTimeout(() => window.location.reload(), 2000);
        }
      } catch { /* hub still down */ }
    }, 3000);
    setTimeout(() => {
      clearInterval(poll);
      setHubStatus((prev) => prev === 'restarting' ? 'failed' : prev);
      setHubError('Hub did not come back within 2 minutes. Check the container logs.');
    }, 120000);
  };

  return { hubStatus, hubError, startHubUpdate };
}
