// hub/src/insights/explain.ts
import type Database from 'better-sqlite3';

interface InsightRow {
  id: number;
  entity_type: string;
  entity_id: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  metric: string | null;
  current_value: number | null;
  baseline_value: number | null;
  evidence: string | null;
  suggested_action: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  computed_at: string;
}

interface ExplanationSummary {
  lead: string;
  reasons: string[];
  confidence: 'high' | 'medium' | 'low' | null;
}

function entityLabel(insight: InsightRow): string {
  if (insight.entity_type === 'container' && insight.entity_id.includes('/')) {
    return insight.entity_id.split('/').slice(1).join('/');
  }
  return insight.entity_id;
}

function fmt(n: number | null, metric: string | null): string {
  if (n == null) return '-';
  if (metric?.includes('percent')) return `${Math.round(n * 10) / 10}%`;
  if (metric?.includes('mb') || metric?.includes('memory')) return `${Math.round(n)} MB`;
  return String(Math.round(n * 10) / 10);
}

function buildSummary(insight: InsightRow): ExplanationSummary {
  const lead = `${insight.title} on ${entityLabel(insight)}`;
  const reasons: string[] = [];
  if (insight.current_value != null) {
    reasons.push(`Current ${insight.metric ?? 'value'} is ${fmt(insight.current_value, insight.metric)}`);
  }
  if (insight.baseline_value != null) {
    reasons.push(`Baseline is ${fmt(insight.baseline_value, insight.metric)}`);
  }
  return { lead, reasons, confidence: insight.confidence };
}

module.exports = { buildSummary };
