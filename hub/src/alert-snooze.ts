/**
 * Simple in-memory alert snooze. Suppresses alerts for a duration.
 * Used during updates to prevent false alerts.
 */

let snoozeUntil: number = 0;

function snoozeAlerts(durationMinutes: number = 10): void {
  snoozeUntil = Date.now() + durationMinutes * 60 * 1000;
}

function isSnoozed(): boolean {
  return Date.now() < snoozeUntil;
}

interface SnoozeInfo {
  snoozed: boolean;
  until?: string;
  remainingMinutes?: number;
}

function getSnoozeInfo(): SnoozeInfo {
  if (!isSnoozed()) return { snoozed: false };
  return { snoozed: true, until: new Date(snoozeUntil).toISOString(), remainingMinutes: Math.ceil((snoozeUntil - Date.now()) / 60000) };
}

module.exports = { snoozeAlerts, isSnoozed, getSnoozeInfo };
