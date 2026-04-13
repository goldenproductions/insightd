import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiAuth, ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/FormField';
import { DiagnosisCard } from '@/components/DiagnosisCard';

export interface AIDiagnosis {
  rootCause: string;
  reasoning: string;
  suggestedFix: string;
  confidence: number | null;
  caveats: string[];
  model: string;
  latencyMs: number | null;
  createdAt: string;
  cached?: boolean;
}

interface AIStatus {
  enabled: boolean;
  model: string | null;
}

interface Props {
  hostId: string;
  containerName: string;
}

function confidenceColor(c: number | null): string {
  if (c == null) return 'bg-muted/20 text-muted';
  if (c >= 0.75) return 'bg-success/10 text-success';
  if (c >= 0.5) return 'bg-warning/10 text-warning';
  return 'bg-muted/20 text-muted';
}

function formatTimestamp(raw: string): string {
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function AIDiagnosisCard({ hostId, containerName }: Props) {
  const { isAuthenticated, authEnabled, token } = useAuth();
  const queryClient = useQueryClient();
  const [showReasoning, setShowReasoning] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  useEffect(() => {
    if (!cooldownUntil) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownRemaining(remaining);
      if (remaining === 0) setCooldownUntil(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const hid = encodeURIComponent(hostId);
  const cname = encodeURIComponent(containerName);

  const { data: status } = useQuery<AIStatus>({
    queryKey: queryKeys.aiDiagnoseStatus(),
    queryFn: () => api<AIStatus>('/ai-diagnose/status'),
    staleTime: 5 * 60_000,
  });

  const { data: existing, isFetched } = useQuery<AIDiagnosis | null>({
    queryKey: queryKeys.aiDiagnose(hostId, containerName),
    queryFn: async () => {
      try {
        return await api<AIDiagnosis>(`/hosts/${hid}/containers/${cname}/ai-diagnose`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: !!status?.enabled,
    refetchInterval: false,
  });

  const mutation = useMutation<AIDiagnosis, Error>({
    mutationFn: async () => {
      try {
        return await apiAuth<AIDiagnosis>('POST', `/hosts/${hid}/containers/${cname}/ai-diagnose`, undefined, token);
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          setCooldownUntil(Date.now() + 60 * 1000);
        }
        throw err;
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.aiDiagnose(hostId, containerName), data);
    },
  });

  if (!status) return null;

  if (!status.enabled) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface p-4">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-base" aria-hidden>✨</span>
          <div className="text-xs text-muted">
            <span className="font-semibold text-fg">AI diagnosis disabled.</span>{' '}
            Set <code className="rounded bg-bg-secondary px-1 py-0.5 font-mono text-[11px]">GEMINI_API_KEY</code> in the hub environment to enable "Diagnose with AI".
          </div>
        </div>
      </div>
    );
  }

  const diagnosis = mutation.data ?? existing ?? null;
  const loading = mutation.isPending;
  const authMissing = authEnabled && !isAuthenticated;
  const rateLimited = cooldownRemaining > 0;
  const errorMsg = rateLimited
    ? `Rate limited by Gemini. Try again in ${cooldownRemaining}s.`
    : mutation.error?.message ?? null;

  const headerAction = (
    <Button
      variant="primary"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={loading || authMissing || rateLimited}
      title={authMissing ? 'Log in to run AI diagnosis' : rateLimited ? `Retry available in ${cooldownRemaining}s` : undefined}
    >
      {loading
        ? 'Asking…'
        : rateLimited
        ? `Retry in ${cooldownRemaining}s`
        : diagnosis
        ? 'Re-run'
        : 'Diagnose with AI'}
    </Button>
  );

  const footer = diagnosis ? (
    <div className="flex flex-wrap items-center gap-2">
      {diagnosis.confidence != null && (
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${confidenceColor(diagnosis.confidence)}`}>
          {Math.round(diagnosis.confidence * 100)}% confidence
        </span>
      )}
      <span>Generated {formatTimestamp(diagnosis.createdAt)}</span>
      {diagnosis.cached && <span className="rounded bg-border/60 px-1.5 py-0.5 text-[10px]">cached</span>}
      {diagnosis.latencyMs != null && !diagnosis.cached && <span>&middot; {diagnosis.latencyMs}ms</span>}
    </div>
  ) : undefined;

  return (
    <DiagnosisCard
      icon="✨"
      severity="info"
      title="AI diagnosis"
      subtitle={`${status.model ? `Powered by ${status.model}` : 'Powered by Gemini'} — verify before acting.`}
      headerAction={headerAction}
      footer={footer}
    >
      {authMissing && !diagnosis && (
        <div className="text-xs text-muted">Log in to run a new AI diagnosis.</div>
      )}

      {errorMsg && (
        <div className="rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
          {errorMsg}
        </div>
      )}

      {!diagnosis && isFetched && !loading && !errorMsg && (
        <div className="text-xs text-muted">
          No AI analysis yet. Click "Diagnose with AI" to send the current signals to Gemini.
        </div>
      )}

      {diagnosis && (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Root cause</div>
            <p className="text-sm font-medium text-fg">{diagnosis.rootCause}</p>
          </div>

          <div>
            <button
              onClick={() => setShowReasoning((v) => !v)}
              className="text-[11px] text-muted hover:text-fg transition-colors"
            >
              {showReasoning ? '▾' : '▸'} Reasoning
            </button>
            {showReasoning && (
              <p className="mt-1 text-xs leading-relaxed text-fg">{diagnosis.reasoning}</p>
            )}
          </div>

          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Suggested fix</div>
            <p className="text-xs leading-relaxed text-fg whitespace-pre-wrap">{diagnosis.suggestedFix}</p>
          </div>

          {diagnosis.caveats.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Caveats</div>
              <ul className="space-y-1 text-xs text-fg">
                {diagnosis.caveats.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-muted mt-0.5">•</span>
                    <span className="flex-1">{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </DiagnosisCard>
  );
}
