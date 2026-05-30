// Settings page — three render functions (budgets table, miles thresholds,
// OCR API-key panel) + their respective save handlers + the OCR config
// storage wrappers.
//
// The recurring-rules list is owned by ui/modals/recurring.js (renderRecurringList).
// The sync panel is owned by sync.js (renderSyncPanel).

import { CATEGORIES } from '../../config.js';
import { state } from '../../state.js';
import { budgetKey, milesKey, ocrConfigKey } from '../../storage.js';
import { triggerSyncPush } from '../../sync.js';
import { toast } from '../toast.js';

let _ctx = {
  renderDashboard: () => {},
};
export function setSettingsContext(ctx) { _ctx = { ..._ctx, ...ctx }; }

export function renderSettings() {
  const table = document.getElementById('settingsTable');
  table.innerHTML = `
    <tr><th>Category</th><th>Type</th><th style="text-align:right">Monthly Budget (SGD)</th></tr>
    ${CATEGORIES.map(cat => `
      <tr>
        <td>${cat.emoji} ${cat.name}</td>
        <td>${cat.fixed ? '<span class="fixed-badge">Fixed</span>' : '<span style="font-size:11px;color:var(--muted)">Discretionary</span>'}</td>
        <td style="text-align:right">
          <input type="number" id="bud_${cat.name.replace(/\W/g, '_')}"
            value="${state.budgets[cat.name] || cat.budget}" min="0" step="1"
            ${cat.fixed ? 'style="opacity:0.5"' : ''}>
        </td>
      </tr>
    `).join('')}
  `;
}

export function renderMilesSettings() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('miles_hsbc', state.milesConfig.hsbc);
  set('miles_uob_fashion', state.milesConfig.uobLadyFashion);
  set('miles_uob_dining', state.milesConfig.uobLadyDining);
  set('miles_kf_annual', state.milesConfig.kfAnnual);
  set('miles_fashion_cats', (state.milesConfig.fashionCats || []).join(', '));
  set('miles_dining_cats', (state.milesConfig.diningCats || []).join(', '));
}

export function saveMilesSettings() {
  const get = (id, def) => parseFloat(document.getElementById(id)?.value) || def;
  const getCats = (id, def) => {
    const v = document.getElementById(id)?.value || '';
    const parsed = v.split(',').map(s => s.trim()).filter(Boolean);
    return parsed.length ? parsed : def;
  };
  state.milesConfig = {
    hsbc: get('miles_hsbc', 1000),
    uobLadyFashion: get('miles_uob_fashion', 750),
    uobLadyDining: get('miles_uob_dining', 750),
    kfAnnual: get('miles_kf_annual', 1000),
    fashionCats: getCats('miles_fashion_cats', ['Luxury Fashion', 'Clothing & Apparel']),
    diningCats: getCats('miles_dining_cats', ['Fine Dining', 'Casual Dining', 'Cafes & Coffee']),
  };
  localStorage.setItem(milesKey(), JSON.stringify(state.milesConfig));
  triggerSyncPush();
  _ctx.renderDashboard();
  toast('Miles settings saved ✓');
}

export function saveBudgets() {
  CATEGORIES.forEach(cat => {
    const id = `bud_${cat.name.replace(/\W/g, '_')}`;
    const el = document.getElementById(id);
    if (el) state.budgets[cat.name] = parseFloat(el.value) || 0;
  });
  localStorage.setItem(budgetKey(), JSON.stringify(state.budgets));
  triggerSyncPush();
  _ctx.renderDashboard();
  toast('Budgets saved ✓');
}

// ─── OCR API-key panel (Settings → Receipt OCR) ─────────────────────────────
export function loadOcrConfig() {
  try { return JSON.parse(localStorage.getItem(ocrConfigKey()) || '{}'); } catch (e) { return {}; }
}

export function saveOcrConfig(cfg) {
  localStorage.setItem(ocrConfigKey(), JSON.stringify(cfg));
}

export function saveOcrKeyFromUI() {
  const k = document.getElementById('ocrApiKeyInput')?.value?.trim();
  if (!k) { toast('Paste an API key first'); return; }
  saveOcrConfig({ apiKey: k });
  renderOcrPanel();
  toast('API key saved ✓');
}

export function clearOcrKeyFromUI() {
  if (!confirm('Remove the saved Anthropic API key from this device?')) return;
  saveOcrConfig({});
  renderOcrPanel();
  toast('API key removed');
}

export function renderOcrPanel() {
  const el = document.getElementById('ocrPanel');
  if (!el) return;
  const cfg = loadOcrConfig();
  if (!cfg.apiKey) {
    el.innerHTML = `
      <div class="form-row">
        <label>Anthropic API key (sk-ant-…)</label>
        <input type="password" id="ocrApiKeyInput" placeholder="sk-ant-..." autocomplete="off">
      </div>
      <button class="btn" data-act="save-ocr-key">Save Key</button>
    `;
    return;
  }
  const masked = cfg.apiKey.slice(0, 7) + '…' + cfg.apiKey.slice(-4);
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <div style="font-size:13px;">Saved key · <code style="font-size:11px;">${masked}</code></div>
      <button class="btn btn-outline" data-act="clear-ocr-key">Remove Key</button>
    </div>
  `;
}
