import type Database from 'better-sqlite3';
import type { WebhookRow, WebhookCreateData, WebhookUpdateData } from '../types';

function getWebhooks(db: Database.Database): WebhookRow[] {
  return db.prepare('SELECT * FROM webhooks ORDER BY name').all() as WebhookRow[];
}

function getWebhook(db: Database.Database, id: number): WebhookRow | null {
  return (db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow) || null;
}

function getEnabledWebhooks(db: Database.Database, { onAlert, onDigest }: { onAlert?: boolean; onDigest?: boolean } = {}): WebhookRow[] {
  let sql = 'SELECT * FROM webhooks WHERE enabled = 1';
  if (onAlert) sql += ' AND on_alert = 1';
  if (onDigest) sql += ' AND on_digest = 1';
  return db.prepare(sql).all() as WebhookRow[];
}

function createWebhook(db: Database.Database, data: WebhookCreateData): { id: number | bigint } {
  const result = db.prepare(`
    INSERT INTO webhooks (name, type, url, secret, on_alert, on_digest, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name,
    data.type,
    data.url,
    data.secret || null,
    data.onAlert !== false ? 1 : 0,
    data.onDigest !== false ? 1 : 0,
    data.enabled !== false ? 1 : 0
  );
  return { id: result.lastInsertRowid };
}

function updateWebhook(db: Database.Database, id: number, data: WebhookUpdateData): { updated: boolean } {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.type !== undefined) { fields.push('type = ?'); values.push(data.type); }
  if (data.url !== undefined) { fields.push('url = ?'); values.push(data.url); }
  if (data.secret !== undefined) { fields.push('secret = ?'); values.push(data.secret ?? null); }
  if (data.onAlert !== undefined) { fields.push('on_alert = ?'); values.push(data.onAlert ? 1 : 0); }
  if (data.onDigest !== undefined) { fields.push('on_digest = ?'); values.push(data.onDigest ? 1 : 0); }
  if (data.enabled !== undefined) { fields.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }

  if (fields.length === 0) return { updated: false };

  fields.push("updated_at = datetime('now')");
  values.push(id);

  const result = db.prepare(`UPDATE webhooks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return { updated: result.changes > 0 };
}

function deleteWebhook(db: Database.Database, id: number): { deleted: boolean } {
  const result = db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  return { deleted: result.changes > 0 };
}

module.exports = { getWebhooks, getWebhook, getEnabledWebhooks, createWebhook, updateWebhook, deleteWebhook };
