import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function loadSnooze(): any {
  delete require.cache[require.resolve('../../hub/src/alert-snooze')];
  return require('../../hub/src/alert-snooze');
}

describe('alert-snooze', () => {
  let snooze: any;

  beforeEach(() => { snooze = loadSnooze(); });

  it('starts un-snoozed', () => {
    assert.equal(snooze.isSnoozed(), false);
    assert.deepEqual(snooze.getSnoozeInfo(), { snoozed: false });
  });

  it('snoozes for the requested duration', () => {
    snooze.snoozeAlerts(10);
    assert.equal(snooze.isSnoozed(), true);
    const info = snooze.getSnoozeInfo();
    assert.equal(info.snoozed, true);
    assert.ok(info.until);
    // Allow some clock drift
    assert.ok(info.remainingMinutes! >= 9 && info.remainingMinutes! <= 10);
  });

  it('defaults to 10 minutes when no argument is supplied', () => {
    snooze.snoozeAlerts();
    const info = snooze.getSnoozeInfo();
    assert.ok(info.remainingMinutes! >= 9 && info.remainingMinutes! <= 10);
  });

  it('returns false after the snooze window expires', () => {
    snooze.snoozeAlerts(0); // 0 minutes → immediately expired (or basically so)
    // Snooze for 0 minutes still sets snoozeUntil to now-ish; isSnoozed checks `Date.now() < snoozeUntil`
    // For 0 minutes, the comparison is now < now → false (or true within the same ms)
    // Test the explicit "definitely expired" case using a negative duration
    snooze.snoozeAlerts(-1);
    assert.equal(snooze.isSnoozed(), false);
    assert.deepEqual(snooze.getSnoozeInfo(), { snoozed: false });
  });

  it('a fresh snooze extends or replaces an existing one', () => {
    snooze.snoozeAlerts(1);
    const initial = snooze.getSnoozeInfo().remainingMinutes!;
    snooze.snoozeAlerts(30);
    const extended = snooze.getSnoozeInfo().remainingMinutes!;
    assert.ok(extended > initial);
  });
});
