// Add / Edit Transaction modal — the form for creating or editing a single
// transaction. addTxnToStore is exported separately because the import-modal
// commit path (processImport → addTxnToStore) is the only other consumer.

import { CATEGORIES, MCC_LOOKUP } from '../../config.js';
import { fmt } from '../../utils.js';
import { state } from '../../state.js';
import { storageKey, bucketKeyFromDate } from '../../storage.js';

let editingTxnId = null;

let _ctx = {
  saveTransactionsBucket: (_key) => {},  // accepts a specific bucket key
  monthLabelOfKey: (_key) => '',         // for the cross-bucket "Moved to X" toast
  renderAll: () => {},
  toast: () => {},
};
export function setAddTxnContext(ctx) { _ctx = { ..._ctx, ...ctx }; }

// Bucket a txn by its date field. Falls back to the currently-viewed month
// only when the date is malformed/missing (logs a warning so we notice).
function bucketKeyForTxn(t) {
  const key = bucketKeyFromDate(t.date);
  if (key) return key;
  console.warn('add-txn: malformed date, falling back to current view bucket', t.date);
  return storageKey(state.currentYear, state.currentMonth);
}

export function populateTxnCategorySelect() {
  document.getElementById('txnCategory').innerHTML =
    CATEGORIES.map(c => `<option value="${c.name}">${c.emoji} ${c.name}</option>`).join('');
}

export function onMccInputChange() {
  const raw = (document.getElementById('txnMcc').value || '').trim();
  const hint = document.getElementById('txnMccHint');
  if (!raw) { hint.textContent = ''; return; }
  const entry = MCC_LOOKUP[raw];
  if (entry) {
    hint.innerHTML = `<span style="color:var(--accent);">→ ${entry.name}</span> · suggests category <strong>${entry.category}</strong>`;
    // Auto-pick suggested category (user can override afterwards)
    const sel = document.getElementById('txnCategory');
    if (sel && CATEGORIES.some(c => c.name === entry.category)) sel.value = entry.category;
  } else if (/^\d{4}$/.test(raw)) {
    hint.innerHTML = `<span style="color:var(--muted);">${raw} — not in lookup; saved as metadata only</span>`;
  } else {
    hint.innerHTML = `<span style="color:var(--muted);">4 digits</span>`;
  }
}

export function openAddTxn() {
  editingTxnId = null;
  document.getElementById('txnModalTitle').textContent = 'Add Transaction';
  document.getElementById('txnSaveBtn').textContent = 'Add Transaction';

  const y = state.currentYear, m = state.currentMonth;
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === y && now.getMonth() === m;
  document.getElementById('txnDate').value = isCurrentMonth
    ? now.toISOString().split('T')[0]
    : `${y}-${String(m+1).padStart(2,'0')}-01`;
  document.getElementById('txnMerchant').value = '';
  document.getElementById('txnAmount').value = '';
  document.getElementById('txnMcc').value = '';
  document.getElementById('txnMccHint').textContent = '';
  document.getElementById('txnCard').value = 'DBS Vantage';

  populateTxnCategorySelect();
  document.getElementById('addModal').style.display = 'flex';
  setTimeout(() => document.getElementById('txnMerchant').focus(), 100);
}

export function openEditTxn(id) {
  const key = storageKey(state.currentYear, state.currentMonth);
  const t = (state.transactions[key] || []).find(x => x.id === id);
  if (!t) { _ctx.toast('Transaction not found'); return; }

  editingTxnId = id;
  document.getElementById('txnModalTitle').textContent = 'Edit Transaction';
  document.getElementById('txnSaveBtn').textContent = 'Save Changes';

  populateTxnCategorySelect();
  document.getElementById('txnDate').value = t.date;
  document.getElementById('txnMerchant').value = t.merchant;
  document.getElementById('txnCategory').value = t.category;
  document.getElementById('txnCard').value = t.card;
  document.getElementById('txnAmount').value = t.amount;
  document.getElementById('txnMcc').value = t.mcc || '';
  onMccInputChange();
  document.getElementById('addModal').style.display = 'flex';
  setTimeout(() => document.getElementById('txnMerchant').focus(), 100);
}

export function closeAddTxn() {
  document.getElementById('addModal').style.display = 'none';
  editingTxnId = null;
}

export function saveTxn() {
  const date     = document.getElementById('txnDate').value;
  const merchant = document.getElementById('txnMerchant').value.trim();
  const category = document.getElementById('txnCategory').value;
  const card     = document.getElementById('txnCard').value;
  const amount   = parseFloat(document.getElementById('txnAmount').value);
  const mccRaw   = (document.getElementById('txnMcc').value || '').trim();

  if (!date || !merchant || !amount || amount <= 0) { _ctx.toast('Please fill in all fields'); return; }
  if (mccRaw && !/^\d{4}$/.test(mccRaw)) { _ctx.toast('MCC must be 4 digits (or empty)'); return; }
  const mcc = mccRaw || undefined;

  if (editingTxnId) {
    // The row lives in whichever bucket the user is currently viewing — the
    // edit modal was opened from a row that renderTransactions emitted from
    // state.transactions[currentBucket]. If the new date is in a different
    // calendar month, move the row across buckets and persist both sides.
    const oldKey = storageKey(state.currentYear, state.currentMonth);
    const newKey = bucketKeyForTxn({ date });
    const list = state.transactions[oldKey] || [];
    const idx = list.findIndex(x => x.id === editingTxnId);
    if (idx < 0) { _ctx.toast('Transaction not found'); return; }
    const updated = { ...list[idx], date, merchant, category, card, amount, mcc };

    if (newKey === oldKey) {
      list[idx] = updated;
      _ctx.saveTransactionsBucket(oldKey);
      closeAddTxn();
      _ctx.renderAll();
      _ctx.toast('Transaction updated ✓');
    } else {
      list.splice(idx, 1);
      if (!state.transactions[newKey]) state.transactions[newKey] = [];
      state.transactions[newKey].push(updated);
      _ctx.saveTransactionsBucket(oldKey);
      _ctx.saveTransactionsBucket(newKey);
      closeAddTxn();
      _ctx.renderAll();
      _ctx.toast(`Moved to ${_ctx.monthLabelOfKey(newKey)} ✓`);
    }
    return;
  }

  addTxnToStore({ date, merchant, category, card, amount, mcc });
  closeAddTxn();
  _ctx.renderAll();
  _ctx.toast(`Added $${fmt(amount)} · ${merchant}`);
}

export function addTxnToStore(t) {
  const key = bucketKeyForTxn(t);
  if (!state.transactions[key]) state.transactions[key] = [];
  const row = { id: Date.now().toString() + Math.random().toString(36).slice(2), date: t.date, merchant: t.merchant, category: t.category, card: t.card, amount: t.amount };
  if (t.mcc) row.mcc = String(t.mcc);
  state.transactions[key].push(row);
  _ctx.saveTransactionsBucket(key);
}
