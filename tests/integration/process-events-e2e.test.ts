// tests/integration/process-events-e2e.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';

const COMPOSE = 'docker compose -f docker-compose.yml';

describe('process events end-to-end', { skip: !process.env.RUN_E2E }, () => {
  before(() => {
    execSync(`${COMPOSE} up -d --build mosquitto hub agent`);
    execSync('sleep 10');
    execSync(`docker run -d --name proc-test-victim alpine sh -c \
      'while true; do ls /tmp >/dev/null; sleep 0.5; done'`);
  });

  after(() => {
    try { execSync('docker rm -f proc-test-victim'); } catch {}
    execSync(`${COMPOSE} down -v`);
  });

  it('captures `ls` spawn rows from the victim container within 60s', () => {
    execSync('sleep 60');
    const out = execSync(
      `${COMPOSE} exec -T hub sqlite3 /data/insightd.db \
        "SELECT COUNT(*) FROM process_events WHERE argv_hash IN \
         (SELECT argv_hash FROM argv_dictionary WHERE comm='ls')"`,
    ).toString().trim();
    assert.ok(parseInt(out, 10) >= 60, `expected ≥60 ls spawns, got ${out}`);
  });
});
