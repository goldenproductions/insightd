import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { bootstrap } = require('../../src/db/schema');
const { buildExplanation } = require('../../src/insights/explain');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrap(db);
  return db;
}

test('buildExplanation emits log_match extras for log_pattern_match insights', () => {
  const db = freshDb();
  const evidence = JSON.stringify({
    pattern_id: 'media_file_corrupted',
    image: 'linuxserver/jellyfin',
    matched_line: 'File ended prematurely',
    context_before: ['decode start'],
    context_after: ['exit code 1'],
    captures: { reason: 'eof' },
    fired_at: '2026-05-13 10:00:00',
    occurrences: 5,
  });
  const info = db.prepare(`
    INSERT INTO insights (entity_type, entity_id, category, severity, title, message, metric, current_value, baseline_value, evidence)
    VALUES ('container','h1/jellyfin','logs','warning','t','m','log_pattern_match',5,null,?)
  `).run(evidence);
  const insightRow = db.prepare('SELECT * FROM insights WHERE id = ?').get(info.lastInsertRowid);

  const explanation = buildExplanation(db, insightRow);
  assert.ok(Array.isArray(explanation.extras));
  const lm = explanation.extras!.find((b: any) => b.kind === 'log_match');
  assert.ok(lm, 'expected log_match extras block');
  assert.equal(lm.pattern_id, 'media_file_corrupted');
  assert.equal(lm.matched_line, 'File ended prematurely');
  assert.deepEqual(lm.context_before, ['decode start']);
  assert.equal(lm.captures.reason, 'eof');
  assert.equal(lm.occurrences, 5);
});

test('buildExplanation tolerates malformed evidence', () => {
  const db = freshDb();
  const info = db.prepare(`
    INSERT INTO insights (entity_type, entity_id, category, severity, title, message, metric, current_value, baseline_value, evidence)
    VALUES ('container','h1/jellyfin','logs','warning','t','m','log_pattern_match',5,null,'not-json')
  `).run();
  const insightRow = db.prepare('SELECT * FROM insights WHERE id = ?').get(info.lastInsertRowid);
  const explanation = buildExplanation(db, insightRow);
  // extras may be undefined or empty array — both acceptable
  const log_match = (explanation.extras ?? []).find((b: any) => b.kind === 'log_match');
  assert.equal(log_match, undefined);
});
