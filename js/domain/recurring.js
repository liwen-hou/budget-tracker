// Recurring transactions — persistence wrappers + the date helper that
// decides whether to auto-apply for a given month.
//
// applyRecurringForMonth itself stays in app.js because it mutates the
// in-memory `transactions` cache; this module owns the rest.

import { recurringKey, recurringAppliedKey } from '../storage.js';
import { triggerSyncPush } from '../sync.js';

export function loadRecurring() {
  try { return JSON.parse(localStorage.getItem(recurringKey()) || '[]'); } catch (e) { return []; }
}

export function saveRecurringList(list) {
  localStorage.setItem(recurringKey(), JSON.stringify(list));
  triggerSyncPush();
}

export function loadRecurringApplied() {
  try { return JSON.parse(localStorage.getItem(recurringAppliedKey()) || '{}'); } catch (e) { return {}; }
}

export function saveRecurringApplied(map) {
  localStorage.setItem(recurringAppliedKey(), JSON.stringify(map));
  triggerSyncPush();
}

// Recurring rules only auto-apply to the current or a future month — never
// retroactively, so editing a rule doesn't quietly stuff rows into old
// months you've already reconciled.
export function isCurrentOrFutureMonth(y, m) {
  const today = new Date();
  return (y > today.getFullYear()) || (y === today.getFullYear() && m >= today.getMonth());
}
