// Month navigation — the picker + the ‹ › buttons. Owns the current-month
// state on `state.currentYear` / `state.currentMonth` and triggers reload +
// re-render whenever it changes.

import { state } from '../state.js';

let _ctx = {
  loadData: () => {},
  renderAll: () => {},
};
export function setMonthBarContext(ctx) { _ctx = { ..._ctx, ...ctx }; }

export function initMonth() {
  const now = new Date();
  state.currentYear = now.getFullYear();
  state.currentMonth = now.getMonth();
}

export function syncMonthPicker() {
  const el = document.getElementById('monthPicker');
  if (el) el.value = `${state.currentYear}-${String(state.currentMonth + 1).padStart(2, '0')}`;
}

export function changeMonth(delta) {
  state.currentMonth += delta;
  if (state.currentMonth > 11) { state.currentMonth = 0; state.currentYear++; }
  if (state.currentMonth < 0)  { state.currentMonth = 11; state.currentYear--; }
  syncMonthPicker();
  _ctx.loadData();
  _ctx.renderAll();
}

export function onMonthPickerChange() {
  const v = document.getElementById('monthPicker').value;
  if (!v) return;
  const [y, m] = v.split('-').map(Number);
  if (!y || !m) return;
  state.currentYear = y;
  state.currentMonth = m - 1;
  _ctx.loadData();
  _ctx.renderAll();
}

export function monthLabel() {
  return new Date(state.currentYear, state.currentMonth, 1).toLocaleString('en-SG', { month: 'long', year: 'numeric' });
}
