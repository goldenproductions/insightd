/**
 * Simple in-memory alert snooze. Suppresses alerts for a duration.
 * Used during updates to prevent false alerts.
 */

let snoozeUntil = 0;

function snoozeAlerts(durationMinutes = 10) {
  snoozeUntil = Date.now() + durationMinutes * 60 * 1000;
}

function isSnoozed() {
  return Date.now() < snoozeUntil;
}

function getSnoozeInfo() {
  if (!isSnoozed()) return { snoozed: false };
  return { snoozed: true, until: new Date(snoozeUntil).toISOString(), remainingMinutes: Math.ceil((snoozeUntil - Date.now()) / 60000) };
}

module.exports = { snoozeAlerts, isSnoozed, getSnoozeInfo };
