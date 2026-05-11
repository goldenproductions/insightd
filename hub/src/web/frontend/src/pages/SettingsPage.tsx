import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { SettingItem, SettingsResponse, StorageInfo, VacuumResult } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { Card } from '@/components/Card';
import { Input, Select, Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { PageTitle } from '@/components/PageTitle';
import { LoadingState } from '@/components/LoadingState';
import { SearchIcon } from '@/components/Icons';
import { fmtBytes, timeAgo } from '@/lib/formatters';
import { AlertRulesSection } from './AlertRulesSection';

// ───────────────────────── Category metadata ─────────────────────────

const CATEGORY_ORDER = [
  'General',
  'Alerts',
  'Email',
  'Digest',
  'Collection',
  'AI Diagnosis',
  'Status Page',
  'Web',
  'Storage',
] as const;

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  General: 'Timezone and site-wide defaults.',
  Alerts: 'Thresholds, recipients, and throttling for real-time alerts.',
  Email: 'SMTP connection used for alert emails and the weekly digest.',
  Digest: 'Weekly summary email — who receives it and when.',
  Collection: 'How often agents report metrics and early-warning disk thresholds.',
  'AI Diagnosis': 'Optional Gemini-powered container diagnosis on the detail page.',
  'Status Page': 'Public /status route — what to show and who can see it.',
  Web: 'Public base URL used in outbound emails and webhooks.',
  Storage: 'Data retention, database size, and cleanup.',
};

// ───────────────────────── Helpers ─────────────────────────

function flatten(categories: Record<string, SettingItem[]>): SettingItem[] {
  return CATEGORY_ORDER.flatMap(cat => categories[cat] ?? []);
}

function matchesSearch(s: SettingItem, q: string): boolean {
  if (!q) return true;
  const haystack = `${s.label} ${s.key} ${s.description ?? ''}`.toLowerCase();
  return haystack.includes(q.toLowerCase());
}

function sensitiveIsMasked(value: string): boolean {
  // Backend returns '****' for configured sensitive values, '' for unconfigured.
  return value === '****';
}

function isDirty(s: SettingItem, edit: string | undefined): boolean {
  if (edit === undefined) return false;
  if (s.sensitive) {
    // Sensitive values are '****' from backend; any edit that isn't '****' is dirty.
    return edit !== '****' && edit !== '';
  }
  return edit !== s.value;
}

// ───────────────────────── Main page ─────────────────────────

export function SettingsPage() {
  const { token, logout } = useAuth();
  const queryClient = useQueryClient();

  const { data, error } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => apiAuth<SettingsResponse>('GET', '/settings', undefined, token),
    refetchInterval: false,
  });

  // Logout on stale token (401 after hub restart)
  useEffect(() => {
    if (error instanceof Error && (error.message.includes('401') || error.message.includes('Unauthorized'))) {
      logout();
    }
  }, [error, logout]);

  const [searchParams, setSearchParams] = useSearchParams();
  const activeSection = searchParams.get('section') ?? 'General';
  const setActiveSection = (section: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('section', section);
    setSearchParams(next, { replace: true });
  };

  const [search, setSearch] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; color: 'green' | 'amber' | 'red' } | null>(null);

  const allSettings = useMemo(() => (data ? flatten(data.categories) : []), [data]);

  const dirtyKeys = useMemo(
    () => allSettings.filter(s => isDirty(s, edits[s.key])).map(s => s.key),
    [allSettings, edits]
  );
  const restartKeys = useMemo(
    () => allSettings.filter(s => dirtyKeys.includes(s.key) && !s.hotReload).map(s => s.key),
    [allSettings, dirtyKeys]
  );

  const setEdit = (key: string, value: string) => {
    setEdits(prev => ({ ...prev, [key]: value }));
  };
  const clearEdits = () => {
    setEdits({});
    setReveal(new Set());
  };

  const save = async () => {
    if (dirtyKeys.length === 0) return;
    setSaving(true);
    setMsg(null);
    try {
      const payload: Record<string, string> = {};
      for (const k of dirtyKeys) payload[k] = edits[k] ?? '';
      const result = await apiAuth<{ saved: boolean; restartRequired: boolean }>(
        'PUT', '/settings', payload, token
      );
      clearEdits();
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      if (result.restartRequired) {
        setMsg({ text: 'Saved. Some changes take effect after a restart.', color: 'amber' });
      } else {
        setMsg({ text: `Saved ${dirtyKeys.length} ${dirtyKeys.length === 1 ? 'change' : 'changes'}.`, color: 'green' });
      }
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : 'Save failed', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  // Auto-clear success/warning banner after a few seconds.
  useEffect(() => {
    if (!msg || msg.color === 'red') return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  if (error) return <AlertBanner message={error instanceof Error ? error.message : 'Failed to load settings'} color="red" />;
  if (!data) return <LoadingState />;

  const searching = search.trim().length > 0;
  const sectionItems = data.categories[activeSection] ?? [];
  const searchResults: Array<[string, SettingItem[]]> = searching
    ? CATEGORY_ORDER
        .map(cat => [cat, (data.categories[cat] ?? []).filter(s => matchesSearch(s, search.trim()))] as [string, SettingItem[]])
        .filter(([, items]) => items.length > 0)
    : [];

  return (
    <div className="space-y-5 pb-24">
      <PageTitle>Settings</PageTitle>

      {/* Search */}
      <div className="relative max-w-lg">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search settings…"
          className="w-full rounded-lg border border-border bg-bg-secondary py-2 pl-9 pr-3 text-sm text-fg placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-info/40"
          aria-label="Search settings"
        />
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
        <SettingsSidebar
          categories={data.categories}
          active={activeSection}
          onSelect={setActiveSection}
          dirtyKeys={dirtyKeys}
          restartKeys={restartKeys}
          disabled={searching}
        />

        <div className="min-w-0 space-y-5">
          {searching ? (
            <SearchResults
              groups={searchResults}
              edits={edits}
              reveal={reveal}
              onChange={setEdit}
              onToggleReveal={(key) => setReveal(r => {
                const next = new Set(r);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })}
              query={search.trim()}
            />
          ) : (
            <SectionBody
              category={activeSection}
              settings={sectionItems}
              allSettings={allSettings}
              edits={edits}
              reveal={reveal}
              token={token}
              onChange={setEdit}
              onToggleReveal={(key) => setReveal(r => {
                const next = new Set(r);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })}
            />
          )}
        </div>
      </div>

      {/* Dirty footer */}
      {dirtyKeys.length > 0 && (
        <DirtyFooter
          count={dirtyKeys.length}
          restartCount={restartKeys.length}
          saving={saving}
          onSave={save}
          onDiscard={clearEdits}
        />
      )}

      {/* Save result toast / inline banner */}
      {msg && (
        <div className="fixed bottom-20 right-6 z-30 max-w-sm">
          <AlertBanner message={msg.text} color={msg.color} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Sidebar ─────────────────────────

function SettingsSidebar({
  categories, active, onSelect, dirtyKeys, restartKeys, disabled,
}: {
  categories: Record<string, SettingItem[]>;
  active: string;
  onSelect: (s: string) => void;
  dirtyKeys: string[];
  restartKeys: string[];
  disabled: boolean;
}) {
  const dirtyByCat = useMemo(() => {
    const m: Record<string, { dirty: number; restart: number }> = {};
    for (const cat of CATEGORY_ORDER) {
      const items = categories[cat] ?? [];
      const keys = new Set(items.map(i => i.key));
      const dirty = dirtyKeys.filter(k => keys.has(k)).length;
      const restart = restartKeys.filter(k => keys.has(k)).length;
      m[cat] = { dirty, restart };
    }
    return m;
  }, [categories, dirtyKeys, restartKeys]);

  return (
    <aside className={`sticky top-4 h-fit ${disabled ? 'opacity-60' : ''}`}>
      <nav aria-label="Settings sections">
        <ul className="space-y-0.5">
          {CATEGORY_ORDER.map(cat => {
            const counts = dirtyByCat[cat] ?? { dirty: 0, restart: 0 };
            const isActive = active === cat && !disabled;
            return (
              <li key={cat}>
                <button
                  type="button"
                  onClick={() => onSelect(cat)}
                  disabled={disabled}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    isActive
                      ? 'bg-surface-hover font-medium text-fg'
                      : 'text-secondary hover:bg-surface-hover hover:text-fg disabled:hover:bg-transparent'
                  }`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="truncate">{cat}</span>
                  {counts.dirty > 0 && (
                    <span
                      className={`ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular-nums ${
                        counts.restart > 0
                          ? 'bg-warning/15 text-warning'
                          : 'bg-info/15 text-info'
                      }`}
                      title={counts.restart > 0 ? `${counts.dirty} unsaved (${counts.restart} need restart)` : `${counts.dirty} unsaved`}
                    >
                      {counts.dirty}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

// ───────────────────────── Section body ─────────────────────────

function SectionBody({
  category, settings, allSettings, edits, reveal, token, onChange, onToggleReveal,
}: {
  category: string;
  settings: SettingItem[];
  allSettings: SettingItem[];
  edits: Record<string, string>;
  reveal: Set<string>;
  token: string | null;
  onChange: (key: string, value: string) => void;
  onToggleReveal: (key: string) => void;
}) {
  return (
    <>
      <div>
        <h2 className="text-lg font-bold text-fg">{category}</h2>
        {CATEGORY_DESCRIPTIONS[category] && (
          <p className="mt-0.5 text-sm text-secondary">{CATEGORY_DESCRIPTIONS[category]}</p>
        )}
      </div>

      {category === 'General' && <ConfigSummary settings={allSettings} />}

      {settings.length > 0 && (
        <Card>
          <div className="divide-y divide-border">
            {settings.map((s, i) => (
              <div key={s.key} className={i === 0 ? 'pb-5' : i === settings.length - 1 ? 'pt-5' : 'py-5'}>
                <SettingRow
                  setting={s}
                  edit={edits[s.key]}
                  revealed={reveal.has(s.key)}
                  onChange={(v) => onChange(s.key, v)}
                  onToggleReveal={() => onToggleReveal(s.key)}
                />
              </div>
            ))}
          </div>
        </Card>
      )}

      {category === 'Storage' && <StorageBody token={token} />}
      {category === 'Alerts' && <AlertRulesSection />}
    </>
  );
}

// ───────────────────────── Config summary hero (General) ─────────────────────────

function ConfigSummary({ settings }: { settings: SettingItem[] }) {
  const byKey = useMemo(() => Object.fromEntries(settings.map(s => [s.key, s])), [settings]);
  const val = (k: string): string => byKey[k]?.value ?? '';
  const bool = (k: string): boolean => val(k) === 'true';

  const alertsOn = bool('alerts.enabled');
  const emailConfigured = val('smtp.host').length > 0;
  const digestSet = val('digestTo').length > 0;
  const statusPublic = bool('statusPage.enabled');
  const aiConfigured = val('ai.geminiApiKey').length > 0;
  const aiModel = val('ai.geminiModel');

  const items: Array<{ label: string; ok: boolean; value: string }> = [
    { label: 'Alerts', ok: alertsOn, value: alertsOn ? 'Enabled' : 'Off' },
    { label: 'Email (SMTP)', ok: emailConfigured, value: emailConfigured ? val('smtp.host') : 'Not configured' },
    { label: 'Weekly digest', ok: digestSet, value: digestSet ? val('digestTo') : 'No recipient' },
    { label: 'Status page', ok: statusPublic, value: statusPublic ? 'Public' : 'Private' },
    { label: 'AI diagnosis', ok: aiConfigured, value: aiConfigured ? aiModel || 'Configured' : 'Not configured' },
  ];

  return (
    <Card title="Configuration Summary">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(it => (
          <div key={it.label} className="flex items-start gap-2.5">
            <span
              aria-hidden
              className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${it.ok ? 'bg-success' : 'bg-muted'}`}
            />
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">{it.label}</dt>
              <dd className="truncate text-sm text-fg" title={it.value}>{it.value}</dd>
            </div>
          </div>
        ))}
      </dl>
    </Card>
  );
}

// ───────────────────────── Setting row ─────────────────────────

function SettingRow({
  setting, edit, revealed, onChange, onToggleReveal,
}: {
  setting: SettingItem;
  edit: string | undefined;
  revealed: boolean;
  onChange: (value: string) => void;
  onToggleReveal: () => void;
}) {
  const dirty = isDirty(setting, edit);
  const displayValue = edit !== undefined ? edit : setting.value;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,320px)] md:items-start md:gap-6">
      {/* Label + description */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`setting-${setting.key}`} className="text-sm font-medium text-fg">
            {setting.label}
          </label>
          {dirty && (
            <span
              aria-label="unsaved change"
              className="inline-block h-1.5 w-1.5 rounded-full bg-info"
            />
          )}
          {!setting.hotReload && (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
              Restart
            </span>
          )}
          {setting.source === 'env' && (
            <span
              className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted"
              title="Currently set by environment variable; saving here will override it in the database."
            >
              ENV
            </span>
          )}
        </div>
        {setting.description && (
          <p className="mt-1 text-xs text-secondary">{setting.description}</p>
        )}
        <p className="mt-1 font-mono text-[11px] text-muted">{setting.key}</p>
      </div>

      {/* Control */}
      <div>
        {setting.sensitive ? (
          <SensitiveField
            setting={setting}
            edit={edit}
            revealed={revealed}
            onChange={onChange}
            onToggleReveal={onToggleReveal}
          />
        ) : setting.key === 'timezone' ? (
          <TimezoneSelect
            id={`setting-${setting.key}`}
            value={displayValue}
            onChange={onChange}
          />
        ) : setting.type === 'bool' ? (
          <Select
            id={`setting-${setting.key}`}
            value={displayValue}
            onChange={e => onChange(e.target.value)}
          >
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </Select>
        ) : setting.type === 'int' || setting.type === 'float' ? (
          <Input
            id={`setting-${setting.key}`}
            type="number"
            value={displayValue}
            onChange={e => onChange(e.target.value)}
            step={setting.type === 'float' ? '0.1' : '1'}
          />
        ) : (
          <Input
            id={`setting-${setting.key}`}
            type="text"
            value={displayValue}
            onChange={e => onChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

function SensitiveField({
  setting, edit, revealed, onChange, onToggleReveal,
}: {
  setting: SettingItem;
  edit: string | undefined;
  revealed: boolean;
  onChange: (value: string) => void;
  onToggleReveal: () => void;
}) {
  const configured = sensitiveIsMasked(setting.value);
  const editing = revealed || edit !== undefined;

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-muted">
          {configured ? '••••••••' : 'Not set'}
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onToggleReveal}>
          {configured ? 'Change' : 'Set'}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        id={`setting-${setting.key}`}
        type="password"
        autoFocus
        value={edit ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={configured ? 'Enter new value' : 'Enter value'}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => { onChange(configured ? '****' : ''); onToggleReveal(); }}
      >
        Cancel
      </Button>
    </div>
  );
}

// ───────────────────────── Timezone picker ─────────────────────────

const TIMEZONE_OPTIONS: string[] = (() => {
  // Intl.supportedValuesOf was added in ES2022 / Node 18+ and all modern browsers.
  const supported = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const zones = supported ? supported('timeZone') : [];
  return zones.length > 0 ? zones : ['UTC'];
})();

function TimezoneSelect({
  id, value, onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  // Preserve a non-IANA / custom value (e.g. legacy "EST") so the current setting stays selectable.
  const options = useMemo(() => {
    if (!value || TIMEZONE_OPTIONS.includes(value)) return TIMEZONE_OPTIONS;
    return [value, ...TIMEZONE_OPTIONS];
  }, [value]);

  return (
    <Select id={id} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(tz => (
        <option key={tz} value={tz}>{tz}</option>
      ))}
    </Select>
  );
}

// ───────────────────────── Search results ─────────────────────────

function SearchResults({
  groups, edits, reveal, onChange, onToggleReveal, query,
}: {
  groups: Array<[string, SettingItem[]]>;
  edits: Record<string, string>;
  reveal: Set<string>;
  onChange: (key: string, value: string) => void;
  onToggleReveal: (key: string) => void;
  query: string;
}) {
  const totalMatches = groups.reduce((sum, [, items]) => sum + items.length, 0);

  if (totalMatches === 0) {
    return (
      <Card>
        <div className="py-6 text-center text-sm text-muted">
          No settings match <span className="font-mono text-fg">{query}</span>.
        </div>
      </Card>
    );
  }

  return (
    <>
      <div className="text-sm text-secondary">
        {totalMatches} {totalMatches === 1 ? 'match' : 'matches'}
      </div>
      {groups.map(([cat, items]) => (
        <Card key={cat} title={cat}>
          <div className="divide-y divide-border">
            {items.map((s, i) => (
              <div key={s.key} className={i === 0 ? 'pb-5' : i === items.length - 1 ? 'pt-5' : 'py-5'}>
                <SettingRow
                  setting={s}
                  edit={edits[s.key]}
                  revealed={reveal.has(s.key)}
                  onChange={(v) => onChange(s.key, v)}
                  onToggleReveal={() => onToggleReveal(s.key)}
                />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </>
  );
}

// ───────────────────────── Dirty footer ─────────────────────────

function DirtyFooter({
  count, restartCount, saving, onSave, onDiscard,
}: {
  count: number;
  restartCount: number;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur"
    >
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium text-fg tabular-nums">
            {count} unsaved {count === 1 ? 'change' : 'changes'}
          </span>
          {restartCount > 0 && (
            <span className="text-xs text-warning">
              {restartCount} {restartCount === 1 ? 'requires' : 'require'} a restart
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Storage body ─────────────────────────

function StorageBody({ token }: { token: string | null }) {
  const queryClient = useQueryClient();
  const [vacuuming, setVacuuming] = useState(false);
  const [vacuumMsg, setVacuumMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const { data } = useQuery({
    queryKey: queryKeys.storage(),
    queryFn: () => apiAuth<StorageInfo>('GET', '/storage', undefined, token),
    refetchInterval: 60_000,
  });

  if (!data) return null;

  const runVacuum = async () => {
    setVacuuming(true);
    setVacuumMsg(null);
    try {
      const r = await apiAuth<VacuumResult>('POST', '/storage/vacuum', undefined, token);
      setVacuumMsg({ text: `Reclaimed ${fmtBytes(r.reclaimed)}`, ok: true });
      queryClient.invalidateQueries({ queryKey: queryKeys.storage() });
    } catch (err) {
      setVacuumMsg({ text: err instanceof Error ? err.message : 'Vacuum failed', ok: false });
    } finally {
      setVacuuming(false);
    }
  };

  // DB size progress bar uses 500 MB as a "visual horizon" — purely indicative.
  const sizePct = Math.min(100, Math.max(5, (data.dbSizeBytes / (500 * 1024 * 1024)) * 100));

  return (
    <Card title="Database">
      <div className="space-y-5">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-2xl font-bold text-fg tabular-nums">{fmtBytes(data.dbSizeBytes)}</div>
            <div className="text-xs text-muted">on disk</div>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-info transition-all"
              style={{ width: `${sizePct}%` }}
            />
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Last cleanup</dt>
            <dd className="mt-0.5 text-fg">{data.lastPruneAt ? timeAgo(data.lastPruneAt) : 'Never'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Last vacuum</dt>
            <dd className="mt-0.5 text-fg">{data.lastVacuumAt ? timeAgo(data.lastVacuumAt) : 'Never'}</dd>
          </div>
        </dl>

        <div className="flex items-center gap-3 border-t border-border pt-4">
          <Button onClick={runVacuum} disabled={vacuuming} size="sm" variant="secondary">
            {vacuuming ? 'Vacuuming…' : 'Vacuum now'}
          </Button>
          <div className="text-xs text-muted">
            Reclaims unused space. Safe to run while the hub is active.
          </div>
          {vacuumMsg && (
            <span className={`ml-auto text-xs ${vacuumMsg.ok ? 'text-success' : 'text-danger'}`}>
              {vacuumMsg.text}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
