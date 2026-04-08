import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiAuth } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

interface ActionResult {
  ok: boolean;
  message: string;
}

type ConfirmFn = (opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;

const defaultConfirm: ConfirmFn = (opts) => Promise.resolve(window.confirm(opts.message));

export function useContainerAction(hostId: string, invalidateKeys: unknown[][], confirmFn: ConfirmFn = defaultConfirm) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);

  const runAction = async (containerName: string, action: string, needsConfirm = true) => {
    if (needsConfirm && action !== 'start') {
      const label = action.charAt(0).toUpperCase() + action.slice(1);
      const confirmed = await confirmFn({
        title: `${label} Container`,
        message: `${label} container "${containerName}"?`,
        confirmLabel: label,
        danger: action === 'stop',
      });
      if (!confirmed) return;
    }
    setActionLoading(`${containerName}:${action}`);
    setActionResult(null);
    try {
      const res = await apiAuth('POST', `/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerName)}/action`, { action }, token) as { status: string; message?: string; error?: string };
      setActionResult({ ok: res.status === 'success', message: res.message || res.error || `${action} completed` });
      for (const key of invalidateKeys) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
    } catch (err) {
      setActionResult({ ok: false, message: err instanceof Error ? err.message : 'Action failed' });
    }
    setActionLoading(null);
  };

  const removeContainer = async (containerName: string): Promise<boolean> => {
    const confirmed = await confirmFn({
      title: 'Remove Container',
      message: `Remove container "${containerName}" and all its data from insightd? If the container still exists in Docker, it will also be removed. This cannot be undone.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return false;
    setActionLoading(`${containerName}:remove`);
    setActionResult(null);
    try {
      await apiAuth('DELETE', `/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerName)}`, undefined, token);
      setActionResult({ ok: true, message: `Container "${containerName}" removed successfully` });
      for (const key of invalidateKeys) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      return true;
    } catch (err) {
      setActionResult({ ok: false, message: err instanceof Error ? err.message : 'Remove failed' });
      return false;
    } finally {
      setActionLoading(null);
    }
  };

  return { actionLoading, actionResult, runAction, removeContainer };
}
