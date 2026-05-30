// Import modal — paste/scan JSON, per-entry review with dedup flags, validate
// & commit. Self-contained except for the in-memory state writes routed
// through app.js (addTxnToStore + renderAll + toast).

import { VALID_CATS } from '../../config.js';
import { escHtml } from '../../utils.js';
import { state } from '../../state.js';
import { txnFingerprint, buildExistingTxnFingerprints } from '../../domain/dedup.js';

// state read directly via the imported state object. The remaining context
// is just callbacks into orchestration that lives in app.js.
let _ctx = {
  monthLabel: () => '',
  addTxnToStore: () => {},
  renderAll: () => {},
  toast: () => {},
};
export function setImportContext(ctx) { _ctx = { ..._ctx, ...ctx }; }

export function openImport() {
  document.getElementById('importJson').value = '';
  document.getElementById('importResult').style.display = 'none';
  document.getElementById('importMonthLabel').textContent = _ctx.monthLabel();
  document.getElementById('importModal').style.display = 'flex';
  renderImportEntries();
  setTimeout(() => document.getElementById('importJson').focus(), 100);
}

export function closeImport() { document.getElementById('importModal').style.display = 'none'; }

export function clearImportResult() { document.getElementById('importResult').style.display = 'none'; }

export function onImportJsonInput() {
  clearImportResult();
  renderImportEntries();
}

// Render the per-entry review list whenever the textarea holds a valid JSON
// array. Each row shows the entry's raw single-line JSON plus a × button to
// drop it before importing. Rows whose fingerprint already exists in storage
// get a red tint + "Duplicate" badge. Textarea remains the source of truth.
export function renderImportEntries() {
  const container = document.getElementById('importEntries');
  if (!container) return;
  const raw = document.getElementById('importJson').value.trim();
  if (!raw) { container.style.display = 'none'; container.innerHTML = ''; return; }
  let arr;
  try { arr = JSON.parse(raw); } catch { container.style.display = 'none'; container.innerHTML = ''; return; }
  if (!Array.isArray(arr) || arr.length === 0) { container.style.display = 'none'; container.innerHTML = ''; return; }

  const existing = buildExistingTxnFingerprints();
  const flags = arr.map(e => existing.has(txnFingerprint(e)));
  const dupCount = flags.filter(Boolean).length;

  container.style.display = 'block';
  container.innerHTML = `
    <div class="import-entries-header">
      <span>${arr.length} entr${arr.length === 1 ? 'y' : 'ies'} — review &amp; drop unwanted${dupCount ? ` · <span class="import-entries-dup-count">${dupCount} duplicate${dupCount === 1 ? '' : 's'} flagged</span>` : ''}</span>
      <span class="hint">× removes one</span>
    </div>
    <div class="import-entries-list">
      ${arr.map((entry, i) => `
        <div class="import-entry-row${flags[i] ? ' is-duplicate' : ''}">
          <code class="import-entry-json">${escHtml(JSON.stringify(entry))}</code>
          ${flags[i] ? '<span class="import-entry-dup-badge" title="Same date, merchant, card, and amount as a saved transaction">Duplicate</span>' : ''}
          <button class="import-entry-del" onclick="dropImportEntry(${i})" title="Remove">×</button>
        </div>
      `).join('')}
    </div>
  `;
}

export function dropImportEntry(i) {
  const ta = document.getElementById('importJson');
  let arr;
  try { arr = JSON.parse(ta.value); } catch { return; }
  if (!Array.isArray(arr) || i < 0 || i >= arr.length) return;
  arr.splice(i, 1);
  ta.value = arr.length ? JSON.stringify(arr, null, 2) : '';
  clearImportResult();
  renderImportEntries();
}

function parseImportJson() {
  const raw = document.getElementById('importJson').value.trim();
  if (!raw) throw new Error('Paste is empty.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch(e) { throw new Error('Invalid JSON. ' + e.message); }
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array [ ... ].');
  if (parsed.length === 0) throw new Error('Array is empty — nothing to import.');

  const valid = [], errors = [];
  parsed.forEach((t, i) => {
    const missing = [];
    if (!t.date) missing.push('date');
    if (!t.merchant) missing.push('merchant');
    if (!t.category) missing.push('category');
    if (!t.card) missing.push('card');
    if (t.amount == null) missing.push('amount');
    if (missing.length) { errors.push(`Row ${i+1}: missing ${missing.join(', ')}`); return; }
    if (!VALID_CATS.has(t.category)) { errors.push(`Row ${i+1}: unknown category "${t.category}"`); return; }
    if (!state.validCards.has(t.card)) { errors.push(`Row ${i+1}: unknown card "${t.card}". Valid: ${state.cards.join(', ')}`); return; }
    const amt = parseFloat(t.amount);
    if (isNaN(amt) || amt <= 0) { errors.push(`Row ${i+1}: invalid amount "${t.amount}"`); return; }
    const row = { date: t.date, merchant: t.merchant, category: t.category, card: t.card, amount: amt };
    if (t.mcc != null && String(t.mcc).trim() !== '') {
      const mccStr = String(t.mcc).trim();
      if (!/^\d{4}$/.test(mccStr)) { errors.push(`Row ${i+1}: invalid mcc "${t.mcc}" (must be 4 digits)`); return; }
      row.mcc = mccStr;
    }
    valid.push(row);
  });
  return { valid, errors };
}

function showImportResult(html, ok) {
  const el = document.getElementById('importResult');
  el.innerHTML = html;
  el.className = `import-result ${ok ? 'ok' : 'err'}`;
  el.style.display = 'block';
}

export function validateImport() {
  try {
    const { valid, errors } = parseImportJson();
    if (errors.length) showImportResult(`⚠️ ${errors.length} error(s):<br>${errors.join('<br>')}`, false);
    else showImportResult(`✅ ${valid.length} transaction(s) look valid. Click <strong>Import All</strong> to add them.`, true);
  } catch(e) { showImportResult('❌ ' + e.message, false); }
}

export function processImport() {
  try {
    const { valid, errors } = parseImportJson();
    if (errors.length) {
      showImportResult(`❌ Fix these errors before importing:<br>${errors.join('<br>')}`, false);
      return;
    }
    valid.forEach(t => _ctx.addTxnToStore(t));
    closeImport();
    _ctx.renderAll();
    _ctx.toast(`✅ Imported ${valid.length} transaction(s)`);
  } catch(e) { showImportResult('❌ ' + e.message, false); }
}
