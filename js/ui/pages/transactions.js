// Transactions page — the list with search / category / card filters,
// plus the per-row delete handler.

import { CATEGORIES, CARD_CLASS, mccDisplayName, CARD_BONUS_RULES } from '../../config.js';
import { fmt, formatDate, escHtml } from '../../utils.js';
import { state } from '../../state.js';
import { storageKey } from '../../storage.js';
import { cardBadgeStyle } from '../cards.js';

let _ctx = {
  currentTxns: () => [],
  monthLabel: () => '',
  saveTransactions: () => {},
  renderAll: () => {},
  toast: () => {},
};
export function setTransactionsContext(ctx) { _ctx = { ..._ctx, ...ctx }; }

// Inlined from app.js — depends on milesConfig (in state) so it stays close
// to renderTransactions where it's the only consumer.
function getMissedBonus(t) {
  if (!t.card) return null;
  const rules = CARD_BONUS_RULES[t.card];
  if (!rules) return null;

  if (rules.type === 'excluded-list') {
    if (t.mcc && rules.excludedMCCs.has(t.mcc)) {
      return {
        severity: 'no-earn',
        label: '⚠️ no miles',
        reason: `${t.card}: MCC ${t.mcc} is on the excluded list — no miles earned and the spend doesn't count toward the monthly cap.`,
      };
    }
    return null;
  }

  if (rules.type === 'category-bonus') {
    const bonusCats = new Set([...(state.milesConfig.fashionCats || []), ...(state.milesConfig.diningCats || [])]);
    if (bonusCats.size === 0) return null;  // not configured, don't flag
    if (!bonusCats.has(t.category)) {
      return {
        severity: 'base-only',
        label: '⚠️ base only',
        reason: `${t.card}: "${t.category}" isn't in your bonus categories (${[...bonusCats].join(', ')}) — earns ~0.4 mpd base instead of 4 mpd.`,
      };
    }
    return null;
  }
  return null;
}

export function renderTransactions() {
  const search = (document.getElementById('txnSearch')?.value || '').toLowerCase();
  const filterCat = document.getElementById('txnFilter')?.value || '';
  const filterCard = document.getElementById('txnCardFilter')?.value || '';

  // Populate filter options once
  const sel = document.getElementById('txnFilter');
  if (sel && sel.options.length <= 1) {
    CATEGORIES.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.name; opt.textContent = c.name;
      sel.appendChild(opt);
    });
  }

  let txns = [..._ctx.currentTxns()].sort((a, b) => b.date.localeCompare(a.date));
  if (search) txns = txns.filter(t => t.merchant.toLowerCase().includes(search) || t.category.toLowerCase().includes(search));
  if (filterCat) txns = txns.filter(t => t.category === filterCat);
  if (filterCard) txns = txns.filter(t => t.card === filterCard);

  // Filtered total — reflects whatever search/category/card filters are active
  const totEl = document.getElementById('txnTotalAmount');
  if (totEl) {
    const total = txns.reduce((s, t) => s + (t.amount || 0), 0);
    totEl.innerHTML = `$${fmt(total)}<span class="txn-total-count"> · ${txns.length} txn${txns.length === 1 ? '' : 's'}</span>`;
  }

  const body = document.getElementById('txnListBody');
  if (txns.length === 0) {
    body.innerHTML = `<div class="empty">🧾<p>No transactions yet for ${_ctx.monthLabel()}</p></div>`;
    return;
  }

  body.innerHTML = txns.map(t => {
    const mccName = t.mcc ? mccDisplayName(t.mcc) : '';
    const mccBadge = t.mcc
      ? `<span class="txn-mcc-badge" title="${mccName ? escHtml(mccName) : 'MCC ' + t.mcc}">${t.mcc}${mccName ? ' · ' + escHtml(mccName) : ''}</span>`
      : '';
    const miss = getMissedBonus(t);
    const missBadge = miss
      ? `<span class="txn-miss-badge txn-miss-${miss.severity}" title="${escHtml(miss.reason)}">${miss.label}</span>`
      : '';
    const subline = (mccBadge || missBadge)
      ? `<br><span class="txn-subline">${mccBadge}${missBadge}</span>`
      : '';
    return `
    <div class="txn-row">
      <span class="txn-date">${formatDate(t.date)}</span>
      <span class="txn-merchant">${escHtml(t.merchant)}${subline}</span>
      <span><span class="txn-cat-badge">${CATEGORIES.find(c => c.name === t.category)?.emoji || ''} ${t.category}</span></span>
      <span><span class="txn-card-badge ${CARD_CLASS[t.card] || ''}" ${cardBadgeStyle(t.card)}>${t.card}</span></span>
      <span class="txn-amount">$${fmt(t.amount)}</span>
      <span class="txn-row-actions">
        <button class="btn-edit" data-act="open-edit-txn" data-id="${t.id}" title="Edit">✎</button>
        <button class="btn-del" data-act="delete-txn" data-id="${t.id}" title="Delete">✕</button>
      </span>
    </div>
  `;}).join('');
}

export function deleteTxn(id) {
  const key = storageKey(state.currentYear, state.currentMonth);
  state.transactions[key] = (state.transactions[key] || []).filter(t => t.id !== id);
  _ctx.saveTransactions();
  _ctx.renderAll();
  _ctx.toast('Transaction deleted');
}
