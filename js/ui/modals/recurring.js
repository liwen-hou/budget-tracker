// Recurring-transactions modal + the side-panel list that lives in Settings.
// Owns the modal markup interactions and the CRUD against domain/recurring.js.

import { CATEGORIES } from '../../config.js';
import { fmt, escHtml } from '../../utils.js';
import { state } from '../../state.js';
import {
  loadRecurring, saveRecurringList, loadRecurringApplied, saveRecurringApplied,
  isCurrentOrFutureMonth,
} from '../../domain/recurring.js';

let editingRecurringId = null;

let _ctx = {
  monthLabel: () => '',
  applyRecurringForMonth: () => {},
  renderAll: () => {},
  toast: () => {},
};
export function setRecurringContext(ctx) { _ctx = { ..._ctx, ...ctx }; }

export function openRecurringModal(id) {
  editingRecurringId = id || null;
  document.getElementById('recurringModalTitle').textContent = id ? 'Edit Recurring Transaction' : 'Add Recurring Transaction';
  document.getElementById('recSaveBtn').textContent = id ? 'Save Changes' : 'Add';

  // Populate category dropdown fresh each open
  document.getElementById('recCategory').innerHTML =
    CATEGORIES.map(c => `<option value="${c.name}">${c.emoji} ${c.name}</option>`).join('');

  if (id) {
    const r = loadRecurring().find(x => x.id === id);
    if (!r) { editingRecurringId = null; _ctx.toast('Recurring not found'); return; }
    document.getElementById('recMerchant').value = r.merchant;
    document.getElementById('recCategory').value = r.category;
    document.getElementById('recCard').value = r.card;
    document.getElementById('recAmount').value = r.amount;
    document.getElementById('recDay').value = r.day;
  } else {
    document.getElementById('recMerchant').value = '';
    document.getElementById('recAmount').value = '';
    document.getElementById('recDay').value = 1;
    document.getElementById('recCard').value = 'DBS Vantage';
  }

  document.getElementById('recurringModal').style.display = 'flex';
  setTimeout(() => document.getElementById('recMerchant').focus(), 100);
}

export function closeRecurringModal() {
  document.getElementById('recurringModal').style.display = 'none';
  editingRecurringId = null;
}

export function saveRecurring() {
  const merchant = document.getElementById('recMerchant').value.trim();
  const category = document.getElementById('recCategory').value;
  const card     = document.getElementById('recCard').value;
  const amount   = parseFloat(document.getElementById('recAmount').value);
  const day      = parseInt(document.getElementById('recDay').value, 10);

  if (!merchant || !amount || amount <= 0 || !day || day < 1 || day > 28) {
    _ctx.toast('Fill in all fields (day must be 1–28)'); return;
  }

  const list = loadRecurring();
  if (editingRecurringId) {
    const idx = list.findIndex(x => x.id === editingRecurringId);
    if (idx < 0) { _ctx.toast('Recurring not found'); return; }
    list[idx] = { ...list[idx], merchant, category, card, amount, day };
    saveRecurringList(list);
    closeRecurringModal();
    renderRecurringList();
    _ctx.toast('Recurring updated ✓');
    return;
  }

  const newRec = {
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    merchant, category, card, amount, day,
  };
  list.push(newRec);
  saveRecurringList(list);
  const y = state.currentYear, m = state.currentMonth;
  _ctx.applyRecurringForMonth(y, m);
  closeRecurringModal();
  renderRecurringList();
  _ctx.renderAll();
  _ctx.toast(`Recurring added — ${isCurrentOrFutureMonth(y, m) ? 'applied to ' + _ctx.monthLabel() : 'will apply going forward'}`);
}

export function deleteRecurring(id) {
  const list = loadRecurring().filter(r => r.id !== id);
  saveRecurringList(list);
  // Also forget that it was applied, so if re-added it can re-apply
  const appliedMap = loadRecurringApplied();
  Object.keys(appliedMap).forEach(mk => {
    appliedMap[mk] = (appliedMap[mk] || []).filter(rid => rid !== id);
  });
  saveRecurringApplied(appliedMap);
  renderRecurringList();
  _ctx.toast('Recurring deleted (existing month transactions kept)');
}

export function renderRecurringList() {
  const el = document.getElementById('recurringList');
  if (!el) return;
  const list = loadRecurring();
  if (list.length === 0) {
    el.innerHTML = `<div style="font-size:13px;color:var(--muted);padding:14px;text-align:center;border:1px dashed var(--border);border-radius:8px;">No recurring transactions yet. Add fixed costs like rent, subscriptions, or loan instalments here.</div>`;
    return;
  }
  el.innerHTML = `
    <div style="display:grid;gap:8px;">
      ${list.map(r => {
        const cat = CATEGORIES.find(c => c.name === r.category);
        return `
        <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:10px;align-items:center;padding:10px 12px;background:var(--surface2);border-radius:8px;font-size:13px;">
          <div>
            <div style="font-weight:600;">${escHtml(r.merchant)}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">${cat?.emoji||''} ${r.category} · ${r.card} · day ${r.day}</div>
          </div>
          <div style="font-weight:700;white-space:nowrap;">$${fmt(r.amount)}</div>
          <button class="btn-edit" data-act="open-recurring" data-id="${r.id}" title="Edit">✎</button>
          <button class="btn-del" data-act="delete-recurring" data-id="${r.id}" data-merchant="${escHtml(r.merchant)}" title="Delete">✕</button>
        </div>`;
      }).join('')}
    </div>
  `;
}
