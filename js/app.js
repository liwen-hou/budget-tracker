// ─── app.js — entry point + glue ────────────────────────────────────────────
// After the phase 0–6 refactor this file owns:
//   • module-level mutable state (state.currentYear, state.currentMonth, state.transactions,
//     state.budgets, state.milesConfig, state.cards, state.cardColor, state.validCards) — every other
//     module reads this via context-injection closures wired at boot
//   • the boot IIFE (resume session key OR show lock overlay)
//   • bootApp() — runs after unlock; populates state from storage and renders
//   • orchestration functions that mix DOM, state mutation, and module calls:
//     handleScannedReceipt, enrichTransactionsWithAI, generateSpendAnalysis,
//     manualSync, connectSyncFromUI, disconnectSyncFromUI, addTxnToStore's
//     callers (renderAll, saveTransactions, deleteTxn, clearMonth)
//   • the page renderers (renderDashboard, renderTransactions,
//     renderSettings, renderMilesTracker) — still here pending a state.js
//     module that would let ui/pages/*.js own them cleanly
//   • the inline-handler compatibility shim (see end of file)
//
// Other concerns moved out: see js/{config,state,utils,crypto,storage,sync}.js,
// js/api/{ocr,enrich,analysis}.js, js/domain/{dedup,miles,budgets,recurring}.js,
// and js/ui/{lock,modals/*}.js.

import {
  // Storage key naming + bucketing
  storageKey, budgetKey, milesKey, recurringKey, recurringAppliedKey,
  ocrConfigKey, cardsKey, cardOrderKey, milesOrderKey, monthKeyOf,
  rebucketAllTransactions, BUCKETING_MIGRATION_V1,
  // Encryption-at-rest
  origGetItem, origSetItem, PRIVACY_PREF_KEY,
  installStorageOverride, decryptAllToCache, restoreSessionKey,
  setupPassphrase, unlockWithPassphrase, loadEncMeta, flushPendingWrites,
  setMasterKey,
} from './storage.js';
import {
  loadSyncConfig, saveSyncConfig, triggerSyncPush,
  syncConnect, syncDisconnect, syncPull, syncPush, renderSyncPanel,
} from './sync.js';

import {
  CATEGORIES, CATEGORY_MIGRATION,
  DEFAULT_CARDS, DEFAULT_CARD_COLOR, CUSTOM_CARD_PALETTE,
  MCC_LOOKUP, mccDisplayName,
  CARD_BONUS_RULES, CARD_CLASS, VALID_CATS,
} from './config.js';
import { state } from './state.js';
import { fmt, formatDate, escHtml } from './utils.js';
import { scanReceiptsWithClaude } from './api/ocr.js';
import { enrichTxnsWithClaude } from './api/enrich.js';
import { generateAnalysisWithClaude } from './api/analysis.js';
import { txnFingerprint, buildExistingTxnFingerprints } from './domain/dedup.js';
import { getKrisFlyerYTD } from './domain/miles.js';
import { previousMonthData, deltaBadge, buildSpendOverview } from './domain/budgets.js';
import {
  loadRecurring, saveRecurringList, loadRecurringApplied, saveRecurringApplied,
  isCurrentOrFutureMonth,
} from './domain/recurring.js';
import {
  openImport, closeImport, clearImportResult, onImportJsonInput,
  renderImportEntries, dropImportEntry, validateImport, processImport,
  setImportContext,
} from './ui/modals/import.js';
import { showLockOverlay, hideLockOverlay, submitLock, setLockContext } from './ui/lock.js';
import { openAddCardModal, closeAddCardModal, submitAddCard, setAddCardContext } from './ui/modals/add-card.js';
import { openAnalysisModal, closeAnalysisModal } from './ui/modals/analysis.js';
import {
  openRecurringModal, closeRecurringModal, saveRecurring, deleteRecurring,
  renderRecurringList, setRecurringContext,
} from './ui/modals/recurring.js';
import {
  openAddTxn, openEditTxn, closeAddTxn, saveTxn, addTxnToStore,
  populateTxnCategorySelect, onMccInputChange, setAddTxnContext,
} from './ui/modals/add-txn.js';
import { toast, closeModalOutside } from './ui/toast.js';
import { loadPrivacyPref, savePrivacyPref, applyPrivacyPref, togglePrivacy } from './ui/privacy.js';
import {
  initMonth, syncMonthPicker, changeMonth, onMonthPickerChange, monthLabel,
  setMonthBarContext,
} from './ui/month-bar.js';
import {
  loadCustomCards, saveCustomCards, loadCardOrder, saveCardOrder,
  loadMilesOrder, saveMilesOrder, nextCustomColor, refreshCards,
  cardBadgeStyle, populateCardSelects,
} from './ui/cards.js';
import {
  flipCard, openTxnsForCard, openTxnsForCategory,
  setupCardReorder, setupMilesReorder, setCarouselContext,
} from './ui/carousel.js';
import { renderDashboard, setDashboardContext } from './ui/pages/dashboard.js';
import { renderTransactions, deleteTxn, setTransactionsContext } from './ui/pages/transactions.js';
import {
  renderSettings, renderMilesSettings, saveBudgets, saveMilesSettings,
  loadOcrConfig, saveOcrKeyFromUI, clearOcrKeyFromUI, renderOcrPanel,
  setSettingsContext,
} from './ui/pages/settings.js';





function getMissedBonus(t) {
  if (!t.card) return null;
  const rules = CARD_BONUS_RULES[t.card];
  if (!rules) return null;

  if (rules.type === "excluded-list") {
    if (t.mcc && rules.excludedMCCs.has(t.mcc)) {
      return {
        severity: "no-earn",
        label: "⚠️ no miles",
        reason: `${t.card}: MCC ${t.mcc} is on the excluded list — no miles earned and the spend doesn't count toward the monthly cap.`,
      };
    }
    return null;
  }

  if (rules.type === "category-bonus") {
    const bonusCats = new Set([...(state.milesConfig.fashionCats || []), ...(state.milesConfig.diningCats || [])]);
    if (bonusCats.size === 0) return null;  // not configured, don't flag
    if (!bonusCats.has(t.category)) {
      return {
        severity: "base-only",
        label: "⚠️ base only",
        reason: `${t.card}: "${t.category}" isn't in your bonus categories (${[...bonusCats].join(", ")}) — earns ~0.4 mpd base instead of 4 mpd.`,
      };
    }
    return null;
  }
  return null;
}



// State





// ─── Receipt OCR (orchestration) ─────────────────────────────────────────────
// Pure Claude API calls live in js/api/{ocr,enrich,analysis}.js. The wrappers
// here handle API-key check, toasts, modal opening, and applying the response
// to in-memory state.

// Bump on every release. The PWA shell on iOS caches the HTML and won't
// pull updates on its own; checkForAppUpdate() fetches the live index.html,
// reads this constant, and if it differs from the version that's running it
// shows a tap-to-refresh banner.
const APP_VERSION = '2026-05-30.001';

let _lastUpdateCheck = 0;
async function checkForAppUpdate({ force = false } = {}) {
  if (!force && Date.now() - _lastUpdateCheck < 30_000) return;
  _lastUpdateCheck = Date.now();
  try {
    const url = window.location.href.split('?')[0].split('#')[0];
    const res = await fetch(url + '?cb=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const m = html.match(/const APP_VERSION = '([^']+)'/);
    if (m && m[1] !== APP_VERSION) showUpdateBanner(m[1]);
  } catch (e) { /* offline / blocked — ignore */ }
}

function showUpdateBanner(newVersion) {
  if (document.getElementById('updateBanner')) return;
  const b = document.createElement('div');
  b.id = 'updateBanner';
  b.innerHTML = `<span style="font-size:18px;line-height:1;">📦</span> <strong>New version available</strong> <span style="opacity:0.85;font-size:11px;margin-left:6px;">tap to refresh</span>`;
  b.style.cssText = `
    position: fixed; left: 14px; right: 14px; bottom: 90px;
    background: var(--accent); color: #fff;
    padding: 12px 16px; border-radius: 12px;
    font-size: 13px; cursor: pointer;
    z-index: 200; text-align: center;
    box-shadow: 0 10px 28px rgba(0,0,0,0.45);
    display: flex; gap: 8px; align-items: center; justify-content: center;
    animation: updateBannerIn 0.3s ease-out;
  `;
  b.onclick = () => { location.reload(); };
  document.body.appendChild(b);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkForAppUpdate();
});

async function manualRefreshApp() {
  toast('Checking for new version…');
  await checkForAppUpdate({ force: true });
  // If checkForAppUpdate found one it already showed the banner; if not,
  // tell the user we're up-to-date but offer a hard reload anyway.
  if (!document.getElementById('updateBanner')) {
    if (confirm('You\'re already on the latest version (v' + APP_VERSION + ').\n\nForce-reload anyway?')) {
      location.reload();
    }
  }
}


function openScanReceipt() {
  const cfg = loadOcrConfig();
  if (!cfg.apiKey) {
    toast('Add your Anthropic API key in Budgets → Receipt OCR first');
    showPage('settings', document.querySelectorAll('.nav-item')[2]);
    return;
  }
  document.getElementById('ocrFileInput').click();
}

async function handleScannedReceipt(evt) {
  const files = Array.from(evt.target.files || []);
  evt.target.value = '';  // allow re-selecting the same files
  if (files.length === 0) return;

  const cfg = loadOcrConfig();
  if (!cfg.apiKey) { toast('No API key set'); return; }

  const pdfCount = files.filter(f => f.type === 'application/pdf').length;
  const imgCount = files.length - pdfCount;
  const summary = [
    pdfCount && `${pdfCount} PDF${pdfCount === 1 ? '' : 's'}`,
    imgCount && `${imgCount} image${imgCount === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' + ');
  toast(`Reading ${summary}…`);

  let cleaned;
  try {
    cleaned = await scanReceiptsWithClaude({
      apiKey: cfg.apiKey,
      files,
      categoryNames: CATEGORIES.map(c => c.name),
      cardNames: state.cards,
    });
  } catch (e) {
    if (e.status) {
      toast(`Claude API ${e.status}`);
      console.warn('OCR API error:', e.body);
    } else {
      toast(e.message || 'Network error calling Claude');
    }
    return;
  }

  openImport();
  document.getElementById('importJson').value = cleaned;
  renderImportEntries();
  toast(`Extracted from ${summary} — review then Validate / Import All`);
}

async function enrichTransactionsWithAI() {
  const cfg = loadOcrConfig();
  if (!cfg.apiKey) {
    toast('Add your Anthropic API key in Budgets → Receipt OCR first');
    showPage('settings', document.querySelectorAll('.nav-item')[2]);
    return;
  }

  const txns = currentTxns();
  if (txns.length === 0) { toast('No transactions in this month to enrich'); return; }

  const missingMcc = txns.filter(t => !t.mcc).length;
  const ok = confirm(
    `Send ${txns.length} transaction${txns.length===1?'':'s'} for ${monthLabel()} to Claude?\n\n` +
    `• ${missingMcc} missing MCC will be inferred from merchant\n` +
    `• Categories will be reviewed; only clear mismatches change\n` +
    `• Date, merchant, card, amount stay unchanged\n\n` +
    `Uses your Anthropic API key (typically <1¢ per run).`
  );
  if (!ok) return;

  toast(`Asking Claude to review ${txns.length} transactions…`);

  let patches;
  try {
    patches = await enrichTxnsWithClaude({
      apiKey: cfg.apiKey,
      txns,
      categoryNames: CATEGORIES.map(c => c.name),
    });
  } catch (e) {
    if (e.status) {
      toast(`Claude API ${e.status}`);
      console.warn('Enrich error:', e.body);
    } else if (e.message?.startsWith('Claude returned non-JSON')) {
      toast('Claude returned non-JSON; see console');
      console.warn('Enrich response:', e.body);
    } else if (e.message?.startsWith('Unexpected response shape')) {
      toast('Unexpected response shape; see console');
      console.warn(e.body);
    } else {
      toast(e.message || 'Network error calling Claude');
    }
    return;
  }

  const key = storageKey(state.currentYear, state.currentMonth);
  const list = state.transactions[key] || [];
  const validCats = new Set(CATEGORIES.map(c => c.name));
  let mccAdded = 0, mccChanged = 0, catChanged = 0;
  patches.forEach(p => {
    if (!p?.id) return;
    const idx = list.findIndex(t => t.id === p.id);
    if (idx < 0) return;
    const t = list[idx];
    if (p.mcc && /^\d{4}$/.test(String(p.mcc))) {
      const newMcc = String(p.mcc);
      if (!t.mcc) { t.mcc = newMcc; mccAdded++; }
      else if (t.mcc !== newMcc) { t.mcc = newMcc; mccChanged++; }
    }
    if (p.category && validCats.has(p.category) && p.category !== t.category) {
      t.category = p.category;
      catChanged++;
    }
  });
  saveTransactions();
  renderAll();

  const parts = [];
  if (mccAdded)   parts.push(`${mccAdded} MCC added`);
  if (mccChanged) parts.push(`${mccChanged} MCC corrected`);
  if (catChanged) parts.push(`${catChanged} categor${catChanged===1?'y':'ies'} fixed`);
  toast(parts.length ? `Enriched — ${parts.join(', ')}` : 'Reviewed — nothing needed changing');
}







async function generateSpendAnalysis() {
  const cfg = loadOcrConfig();
  if (!cfg.apiKey) {
    toast('Add your Anthropic API key in Budgets → OCR first');
    closeAnalysisModal();
    showPage('settings', document.querySelectorAll('.nav-item')[2]);
    return;
  }

  const btn = document.getElementById('analysisRegenBtn');
  const body = document.getElementById('analysisBody');
  if (!btn || !body) return;
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  body.classList.add('loading');
  body.textContent = 'Asking Claude…';

  let text;
  try {
    text = await generateAnalysisWithClaude({ apiKey: cfg.apiKey, overview: buildSpendOverview({ year: state.currentYear, month: state.currentMonth, txns: currentTxns(), budgets: state.budgets, milesConfig: state.milesConfig, cards: state.cards }) });
  } catch (e) {
    body.classList.remove('loading');
    if (e.status) {
      body.textContent = `⚠️ Claude API ${e.status}`;
      console.warn('Analysis API error:', e.body);
    } else {
      body.textContent = '⚠️ ' + (e.message || 'Network error calling Claude');
    }
    btn.disabled = false;
    btn.textContent = 'Try again';
    return;
  }

  body.classList.remove('loading');
  body.innerHTML = `<div>${escHtml(text)}</div>
    <div class="analysis-meta">
      <span>${new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' })}</span>
      <a data-act="generate-analysis" style="cursor:pointer">↻ Refresh</a>
    </div>`;
  btn.disabled = false;
  btn.textContent = 'Regenerate';
}


async function manualSync() {
  const status = document.getElementById('syncStatus');
  if (status) status.textContent = 'Syncing…';
  try {
    await syncPull();
    await syncPush();
    // Reload current month into memory
    const k = storageKey(state.currentYear, state.currentMonth);
    try { state.transactions[k] = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { state.transactions[k] = []; }
    renderAll();
    renderSyncPanel();
    toast('Synced ✓');
  } catch (e) {
    renderSyncPanel(e.message);
    toast('Sync failed — see panel');
  }
}

async function connectSyncFromUI() {
  const pat = document.getElementById('syncPatInput')?.value?.trim() || '';
  const existingGistId = document.getElementById('syncGistIdInput')?.value?.trim() || '';
  const status = document.getElementById('syncStatus');
  if (!pat) { if (status) status.textContent = 'Paste a PAT first'; return; }
  if (status) status.textContent = existingGistId ? 'Pulling from existing gist…' : 'Creating gist…';
  try {
    if (existingGistId) {
      // Reconnect to an existing gist: save credentials, force-pull (epoch lastSyncedAt).
      saveSyncConfig({ pat, gistId: existingGistId, lastSyncedAt: '1970-01-01T00:00:00.000Z' });
      const r = await syncPull();
      if (!r.pulled) throw new Error('Connected, but nothing pulled — gist may be empty');
      // Wait for all encrypted writes to actually land in localStorage before
      // declaring success — otherwise a refresh right after would lose data.
      await flushPendingWrites();
      // Re-hydrate in-memory state from the freshly pulled data.
      const k = storageKey(state.currentYear, state.currentMonth);
      try { state.transactions[k] = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { state.transactions[k] = []; }
      const savedBudgets = localStorage.getItem(budgetKey());
      if (savedBudgets) state.budgets = JSON.parse(savedBudgets);
      const savedMiles = localStorage.getItem(milesKey());
      if (savedMiles) state.milesConfig = Object.assign({}, state.milesConfig, JSON.parse(savedMiles));
      renderAll();
      renderSyncPanel();
      toast(`Pulled from gist ${existingGistId.slice(0, 7)} ✓`);
    } else {
      const gistId = await syncConnect(pat);
      await flushPendingWrites();
      renderSyncPanel();
      toast(`Connected · gist ${gistId.slice(0, 7)}`);
    }
  } catch (e) {
    renderSyncPanel(e.message);
  }
}

function disconnectSyncFromUI() {
  if (!confirm('Disconnect sync? Your gist will remain on GitHub; only the local credentials are removed.')) return;
  syncDisconnect();
  renderSyncPanel();
  toast('Sync disconnected');
}


// ─── Load / Save ──────────────────────────────────────────────────────────────
function migrateStoredCategories() {
  const mapName = n => CATEGORY_MIGRATION[n] || n;
  const validNames = new Set(CATEGORIES.map(c => c.name));

  // Transactions across every stored month
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('txns_')) continue;
    try {
      const list = JSON.parse(localStorage.getItem(k));
      if (!Array.isArray(list)) continue;
      let changed = false;
      list.forEach(t => {
        const nc = mapName(t.category);
        if (nc !== t.category) { t.category = nc; changed = true; }
      });
      if (changed) localStorage.setItem(k, JSON.stringify(list));
    } catch (e) { /* skip malformed */ }
  }

  // Saved state.budgets: sum old-key values into their new-key buckets, drop stale keys
  const rawB = localStorage.getItem(budgetKey());
  if (rawB) {
    try {
      const old = JSON.parse(rawB);
      const merged = {};
      Object.entries(old).forEach(([k, v]) => {
        const nk = mapName(k);
        if (!validNames.has(nk)) return;
        merged[nk] = (merged[nk] || 0) + (Number(v) || 0);
      });
      // Ensure every current category has a value (fall back to default)
      CATEGORIES.forEach(c => { if (merged[c.name] === undefined) merged[c.name] = c.budget; });
      localStorage.setItem(budgetKey(), JSON.stringify(merged));
    } catch (e) { /* skip */ }
  }

  // Miles config cat-lists
  const rawM = localStorage.getItem(milesKey());
  if (rawM) {
    try {
      const m = JSON.parse(rawM);
      const remap = arr => Array.isArray(arr) ? [...new Set(arr.map(mapName).filter(n => validNames.has(n)))] : arr;
      m.fashionCats = remap(m.fashionCats);
      m.diningCats = remap(m.diningCats);
      localStorage.setItem(milesKey(), JSON.stringify(m));
    } catch (e) { /* skip */ }
  }
}

// ─── Recurring Transactions ──────────────────────────────────────────────────

function applyRecurringForMonth(y, m) {
  if (!isCurrentOrFutureMonth(y, m)) return;
  const list = loadRecurring();
  if (list.length === 0) return;

  const appliedMap = loadRecurringApplied();
  const mk = monthKeyOf(y, m);
  const appliedSet = new Set(appliedMap[mk] || []);

  const txKey = storageKey(y, m);
  let txns;
  try { txns = JSON.parse(localStorage.getItem(txKey) || '[]'); } catch (e) { txns = []; }

  let changed = false;
  list.forEach(r => {
    if (appliedSet.has(r.id)) return;
    const day = Math.min(Math.max(1, Number(r.day) || 1), 28);
    const date = `${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    txns.push({
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      date, merchant: r.merchant, category: r.category, card: r.card, amount: Number(r.amount),
      recurringId: r.id,
    });
    appliedSet.add(r.id);
    changed = true;
  });

  if (changed) {
    localStorage.setItem(txKey, JSON.stringify(txns));
    appliedMap[mk] = [...appliedSet];
    saveRecurringApplied(appliedMap);
    // Refresh in-memory copy if this is the month we're viewing
    if (state.transactions[txKey]) state.transactions[txKey] = txns;
  }
}


function loadData() {
  migrateStoredCategories();
  maybeRunBucketingMigration();

  // Auto-apply recurring for the month we're about to render
  applyRecurringForMonth(state.currentYear, state.currentMonth);

  // Budgets
  const savedBudgets = localStorage.getItem(budgetKey());
  if (savedBudgets) state.budgets = JSON.parse(savedBudgets);
  else CATEGORIES.forEach(c => { state.budgets[c.name] = c.budget; });

  // Miles config — merge saved over defaults so new keys always have values
  const savedMiles = localStorage.getItem(milesKey());
  if (savedMiles) state.milesConfig = Object.assign({}, state.milesConfig, JSON.parse(savedMiles));

  // Transactions for current month
  const key = storageKey(state.currentYear, state.currentMonth);
  const raw = localStorage.getItem(key);
  if (raw) state.transactions[key] = JSON.parse(raw);
  else state.transactions[key] = [];
}

// One-time per-device migration: re-files any txn whose date.slice(0,7)
// disagrees with its bucket key. Gated by a localStorage flag so it doesn't
// re-scan every boot. Sync-apply runs the same re-bucket pass unconditionally.
function maybeRunBucketingMigration() {
  if (localStorage.getItem(BUCKETING_MIGRATION_V1) === '1') return;
  const { moved, scanned } = rebucketAllTransactions();
  localStorage.setItem(BUCKETING_MIGRATION_V1, '1');
  if (moved > 0) {
    console.log(`bucketing migration v1: re-filed ${moved} of ${scanned} transaction(s)`);
  }
}

function saveTransactions() {
  saveTransactionsBucket(storageKey(state.currentYear, state.currentMonth));
}

// Persist a specific bucket. Used by addTxnToStore + the cross-bucket edit
// path, which both need to write a non-current-view bucket.
function saveTransactionsBucket(key) {
  localStorage.setItem(key, JSON.stringify(state.transactions[key] || []));
  triggerSyncPush();
}

function currentTxns() {
  return state.transactions[storageKey(state.currentYear, state.currentMonth)] || [];
}


// ─── Pages ───────────────────────────────────────────────────────────────────
function showPage(name, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
  if (el) el.classList.add('active');
  // Tag main so CSS can hide top actions on Settings
  document.querySelector('.main')?.setAttribute('data-active', name);
  if (name === 'settings') {
    renderSettings(); renderMilesSettings(); renderRecurringList(); renderSyncPanel(); renderOcrPanel();
    const v = document.getElementById('appVersionText'); if (v) v.textContent = APP_VERSION;
  }
  if (name === 'transactions') renderTransactions();
  if (name === 'dashboard') renderDashboard();
}






// ─── Utilities ───────────────────────────────────────────────────────────────

function clearMonth() {
  if (!confirm(`Clear all transactions for ${monthLabel()}? This cannot be undone.`)) return;
  const key = storageKey(state.currentYear, state.currentMonth);
  state.transactions[key] = [];
  saveTransactions();
  renderAll();
  toast('Month cleared');
}

function exportData() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('txns_') || k === budgetKey() || k === milesKey() || k === recurringKey() || k === recurringAppliedKey()) data[k] = JSON.parse(localStorage.getItem(k));
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `budget-backup-${new Date().toISOString().split('T')[0]}.json`; a.click();
  toast('Backup downloaded');
}


function renderAll() {
  syncMonthPicker();
  const activePage = document.querySelector('.page.active')?.id?.replace('page-','');
  if (activePage === 'dashboard') renderDashboard();
  if (activePage === 'transactions') renderTransactions();
  if (activePage === 'settings') { renderSettings(); renderMilesSettings(); renderRecurringList(); renderSyncPanel(); renderOcrPanel(); }
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('addModal').style.display = 'none';
    document.getElementById('importModal').style.display = 'none';
  }
  if (e.key === 'Enter' && document.getElementById('addModal').style.display === 'flex') saveTxn();
});

// ─── Init ────────────────────────────────────────────────────────────────────
async function bootApp() {
  initMonth();
  loadData();
  refreshCards();
  populateCardSelects();
  document.querySelector('.main')?.setAttribute('data-active', 'dashboard');
  syncMonthPicker();
  renderDashboard();
  setupCardReorder();
  applyPrivacyPref();
  // PWA shell on iOS won't pull updates on its own — check in the background.
  setTimeout(() => checkForAppUpdate(), 3000);

  // Background pull on startup (non-blocking; UI is already up)
  const cfg = loadSyncConfig();
  if (!cfg.pat || !cfg.gistId) return;
  try {
    const r = await syncPull();
    if (r.pulled) {
      // Reload everything from the freshly-pulled localStorage
      const key = storageKey(state.currentYear, state.currentMonth);
      try { state.transactions[key] = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { state.transactions[key] = []; }
      const savedBudgets = localStorage.getItem(budgetKey());
      if (savedBudgets) state.budgets = JSON.parse(savedBudgets);
      const savedMiles = localStorage.getItem(milesKey());
      if (savedMiles) state.milesConfig = Object.assign({}, state.milesConfig, JSON.parse(savedMiles));
      refreshCards();
      populateCardSelects();
      renderAll();
      toast('Pulled latest from sync');
    }
    renderSyncPanel();
  } catch (e) {
    console.warn('Startup sync pull failed:', e.message);
    renderSyncPanel(e.message);
  }
}

(async () => {
  // 1) Resume a session-cached key (survives reload in the same tab).
  const sessKey = await restoreSessionKey();
  if (sessKey) {
    setMasterKey(sessKey);
    installStorageOverride();
    await decryptAllToCache();
    await bootApp();
    return;
  }
  // 2) Else prompt for passphrase (setup if first run, unlock otherwise).
  showLockOverlay({ setup: !loadEncMeta() });
})();

// Inject the orchestration callbacks each ui module needs. State reads
// (currentYear, currentMonth, transactions, cards, validCards) go straight
// through `import { state } from './state.js'` inside each module — no
// accessors needed.
setImportContext({
  monthLabel: () => monthLabel(),
  addTxnToStore: (t) => addTxnToStore(t),
  renderAll: () => renderAll(),
  toast: (msg) => toast(msg),
});
setLockContext({ onUnlock: () => bootApp() });
setAddCardContext({
  loadCustomCards: () => loadCustomCards(),
  saveCustomCards: (l) => saveCustomCards(l),
  nextCustomColor: () => nextCustomColor(),
  refreshCards: () => refreshCards(),
  populateCardSelects: () => populateCardSelects(),
  renderDashboard: () => renderDashboard(),
  toast: (msg) => toast(msg),
});
setRecurringContext({
  monthLabel: () => monthLabel(),
  applyRecurringForMonth: (y, m) => applyRecurringForMonth(y, m),
  renderAll: () => renderAll(),
  toast: (msg) => toast(msg),
});
setAddTxnContext({
  saveTransactionsBucket: (key) => saveTransactionsBucket(key),
  monthLabelOfKey: (key) => {
    // key is "txns_YYYY_MM" → return e.g. "June 2026"
    const m = key.match(/^txns_(\d{4})_(\d{2})$/);
    if (!m) return key;
    return new Date(+m[1], +m[2] - 1, 1).toLocaleString('en-SG', { month: 'long', year: 'numeric' });
  },
  renderAll: () => renderAll(),
  toast: (msg) => toast(msg),
});
setMonthBarContext({
  loadData: () => loadData(),
  renderAll: () => renderAll(),
});
setCarouselContext({
  showPage: (n, el) => showPage(n, el),
});
setDashboardContext({
  currentTxns: () => currentTxns(),
  syncMonthPicker: () => syncMonthPicker(),
});
setTransactionsContext({
  currentTxns: () => currentTxns(),
  monthLabel: () => monthLabel(),
  saveTransactions: () => saveTransactions(),
  renderAll: () => renderAll(),
  toast: (msg) => toast(msg),
});
setSettingsContext({
  renderDashboard: () => renderDashboard(),
});

// ─── Global event delegation ────────────────────────────────────────────────
// One body-level listener per event type, dispatching by data-act value.
// Replaces the 65 inline `onclick="…"` / `oninput="…"` / `onkeydown="…"`
// attributes that index.html and JS template strings used to carry. Each
// action handler is called with (element, event) — element is the closest
// ancestor with data-act, so handlers can read params from its dataset.
//
// Patterns covered:
//   • static button clicks       — data-act="..." on the button
//   • dynamic row clicks         — data-act + data-id/data-card/data-cat
//                                   in JS template strings; bubbles up to
//                                   the body listener via event delegation
//   • textarea/select input/change — data-act on the form element
//   • Enter-to-submit on inputs    — data-enter-act on the input
//   • modal backdrop close         — generic: if click target IS .overlay,
//                                    close that overlay (no per-modal data-act)
const CLICK_ACTIONS = {
  // import modal
  'close-import':       () => closeImport(),
  'validate-import':    () => validateImport(),
  'process-import':     () => processImport(),
  'drop-import-entry':  (t) => dropImportEntry(+t.dataset.idx),
  // add/edit txn modal
  'open-add-txn':       () => openAddTxn(),
  'close-add-txn':      () => closeAddTxn(),
  'save-txn':           () => saveTxn(),
  'open-edit-txn':      (t) => openEditTxn(t.dataset.id),
  'delete-txn':         (t) => deleteTxn(t.dataset.id),
  // add-card modal
  'open-add-card':      () => openAddCardModal(),
  'close-add-card':     () => closeAddCardModal(),
  'submit-add-card':    () => submitAddCard(),
  // analysis modal
  'open-analysis':      () => openAnalysisModal(),
  'close-analysis':     () => closeAnalysisModal(),
  'generate-analysis':  () => generateSpendAnalysis(),
  // recurring modal + list
  'open-recurring':     (t) => openRecurringModal(t.dataset.id || null),
  'close-recurring':    () => closeRecurringModal(),
  'save-recurring':     () => saveRecurring(),
  'delete-recurring':   (t) => {
    if (confirm(`Delete recurring "${t.dataset.merchant}"? Past auto-added rows are kept.`)) {
      deleteRecurring(t.dataset.id);
    }
  },
  // scan + enrich
  'open-scan':          () => openScanReceipt(),
  'enrich-txns':        () => enrichTransactionsWithAI(),
  // month nav
  'month-prev':         () => changeMonth(-1),
  'month-next':         () => changeMonth(+1),
  // page nav
  'show-dashboard':     (t) => showPage('dashboard', t),
  'show-transactions':  (t) => showPage('transactions', t),
  'show-settings':      (t) => showPage('settings', t),
  // settings
  'save-budgets':       () => saveBudgets(),
  'save-miles-settings':() => saveMilesSettings(),
  'save-ocr-key':       () => saveOcrKeyFromUI(),
  'clear-ocr-key':      () => clearOcrKeyFromUI(),
  // sync
  'manual-sync':        () => manualSync(),
  'connect-sync':       () => connectSyncFromUI(),
  'disconnect-sync':    () => disconnectSyncFromUI(),
  // misc
  'manual-refresh':     () => manualRefreshApp(),
  'export-data':        () => exportData(),
  'clear-month':        () => clearMonth(),
  'toggle-privacy':     () => togglePrivacy(),
  'submit-lock':        () => submitLock(),
  // dashboard tiles
  'open-txns-card':     (t) => openTxnsForCard(t.dataset.card),
  'open-txns-cat':      (t) => openTxnsForCategory(t.dataset.cat),
  'flip-card':          (t, e) => { e.stopPropagation(); flipCard(t.closest('.card-stat')); },
};
const INPUT_ACTIONS = {
  'on-import-input': () => onImportJsonInput(),
  'on-mcc-input':    () => onMccInputChange(),
  'render-txns':     () => renderTransactions(),
};
const CHANGE_ACTIONS = {
  'on-month-picker':   () => onMonthPickerChange(),
  'on-scan-file':      (t, e) => handleScannedReceipt(e),
  'render-txns':       () => renderTransactions(),
};

document.body.addEventListener('click', e => {
  // Backdrop click — close the overlay if the target IS the overlay itself
  // (not bubbled from a click inside the modal body).
  if (e.target.classList && e.target.classList.contains('overlay')) {
    e.target.style.display = 'none';
    return;
  }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const fn = CLICK_ACTIONS[t.dataset.act];
  if (fn) fn(t, e);
});
document.body.addEventListener('input', e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const fn = INPUT_ACTIONS[t.dataset.act];
  if (fn) fn(t, e);
});
document.body.addEventListener('change', e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const fn = CHANGE_ACTIONS[t.dataset.act];
  if (fn) fn(t, e);
});
document.body.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const t = e.target.closest('[data-enter-act]');
  if (!t) return;
  const fn = CLICK_ACTIONS[t.dataset.enterAct];
  if (fn) fn(t, e);
});
