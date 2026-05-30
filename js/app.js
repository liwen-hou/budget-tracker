import {
  // Storage key naming
  storageKey, budgetKey, milesKey, recurringKey, recurringAppliedKey,
  ocrConfigKey, cardsKey, cardOrderKey, milesOrderKey, monthKeyOf,
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
import { fmt, formatDate, escHtml } from './utils.js';




let CARDS       = [...DEFAULT_CARDS];
let CARD_COLOR  = {...DEFAULT_CARD_COLOR};




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
    const bonusCats = new Set([...(milesConfig.fashionCats || []), ...(milesConfig.diningCats || [])]);
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
let VALID_CARDS = new Set(CARDS);

function loadCustomCards() {
  try { return JSON.parse(localStorage.getItem(cardsKey()) || '[]'); } catch (e) { return []; }
}
function saveCustomCards(list) { localStorage.setItem(cardsKey(), JSON.stringify(list)); triggerSyncPush(); }
function loadCardOrder() {
  try { return JSON.parse(localStorage.getItem(cardOrderKey()) || '[]'); } catch (e) { return []; }
}
function saveCardOrder(order) { localStorage.setItem(cardOrderKey(), JSON.stringify(order)); triggerSyncPush(); }
function loadMilesOrder() {
  try { return JSON.parse(localStorage.getItem(milesOrderKey()) || '[]'); } catch (e) { return []; }
}
function saveMilesOrder(order) { localStorage.setItem(milesOrderKey(), JSON.stringify(order)); triggerSyncPush(); }
function nextCustomColor() {
  const used = Object.values(CARD_COLOR);
  return CUSTOM_CARD_PALETTE.find(c => !used.includes(c)) || CUSTOM_CARD_PALETTE[0];
}
function refreshCards() {
  const custom = loadCustomCards();
  // Build the universe of available card names (defaults + custom, dedup)
  const universe = [...DEFAULT_CARDS];
  custom.forEach(c => { if (c?.name && !universe.includes(c.name)) universe.push(c.name); });
  // Apply saved order on top: existing names in saved order first, then any new ones
  const saved = loadCardOrder();
  const ordered = [];
  saved.forEach(n => { if (universe.includes(n)) ordered.push(n); });
  universe.forEach(n => { if (!ordered.includes(n)) ordered.push(n); });
  CARDS = ordered;
  // Colour map (defaults override saved custom colours so brand colours stay stable)
  CARD_COLOR = {...DEFAULT_CARD_COLOR};
  custom.forEach(c => { if (c?.name && !CARD_COLOR[c.name]) CARD_COLOR[c.name] = c.color || nextCustomColor(); });
  VALID_CARDS = new Set(CARDS);
}
// Inline-style fallback for badges of cards that don't have a preset CSS class
// (i.e. user-added custom cards). Returns empty string for built-in cards.
function cardBadgeStyle(card) {
  if (CARD_CLASS[card]) return '';
  const color = CARD_COLOR[card] || '#7b809a';
  return `style="background: color-mix(in srgb, ${color} 18%, transparent); color: ${color};"`;
}
function populateCardSelects() {
  const opts = CARDS.map(c => `<option value="${c}">${c}</option>`).join('');
  ['txnCard', 'recCard'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = opts;
    if (cur && CARDS.includes(cur)) sel.value = cur;
  });
  const fil = document.getElementById('txnCardFilter');
  if (fil) {
    const cur = fil.value;
    fil.innerHTML = '<option value="">All cards</option>' + opts;
    if (cur === '' || CARDS.includes(cur)) fil.value = cur;
  }
}


// State
let currentYear, currentMonth;
let budgets = {};
let transactions = {};
let milesConfig = {
  hsbc: 1000,
  uobLadyFashion: 750,
  uobLadyDining: 750,
  kfAnnual: 1000,
  fashionCats: ['Fashion'],
  diningCats: ['Dining Out'],
};



function showLockOverlay({ setup }) {
  const el = document.getElementById('lockOverlay');
  document.getElementById('lockTitle').textContent = setup ? '🔒 Set a passphrase' : '🔒 Unlock Budget Tracker';
  document.getElementById('lockHelp').textContent = setup
    ? "This encrypts your transactions and sync data. You'll be asked again when you reopen the app. There is no recovery if you forget it."
    : 'Enter your passphrase to decrypt your data.';
  document.getElementById('lockPass1').value = '';
  document.getElementById('lockPass2').value = '';
  document.getElementById('lockPass2').style.display = setup ? 'block' : 'none';
  document.getElementById('lockErr').textContent = '';
  document.getElementById('lockBtn').textContent = setup ? 'Set passphrase' : 'Unlock';
  el.classList.add('show');
  setTimeout(() => document.getElementById('lockPass1').focus(), 30);
}
function hideLockOverlay() {
  document.getElementById('lockOverlay').classList.remove('show');
  document.getElementById('lockPass1').value = '';
  document.getElementById('lockPass2').value = '';
}

async function submitLock() {
  const meta = loadEncMeta();
  const p1 = document.getElementById('lockPass1').value;
  const errEl = document.getElementById('lockErr');
  errEl.textContent = '';
  const btn = document.getElementById('lockBtn');
  btn.disabled = true;
  try {
    if (!meta) {
      const p2 = document.getElementById('lockPass2').value;
      if (p1.length < 8) { errEl.textContent = 'Passphrase must be at least 8 characters.'; return; }
      if (p1 !== p2)     { errEl.textContent = "Passphrases don't match."; return; }
      await setupPassphrase(p1);
    } else {
      try { await unlockWithPassphrase(p1); }
      catch (e) { errEl.textContent = e.message || 'Wrong passphrase.'; return; }
    }
    installStorageOverride();
    await decryptAllToCache();
    hideLockOverlay();
    await bootApp();
  } catch (e) {
    console.error(e);
    errEl.textContent = e.message || 'Something went wrong.';
  } finally {
    btn.disabled = false;
  }
}

// ─── Privacy mode (S7) ───────────────────────────────────────────────────────
function loadPrivacyPref() { return origGetItem.call(localStorage, PRIVACY_PREF_KEY) === '1'; }
function savePrivacyPref(on) { origSetItem.call(localStorage, PRIVACY_PREF_KEY, on ? '1' : '0'); }
function applyPrivacyPref() {
  const on = loadPrivacyPref();
  document.body.classList.toggle('privacy-on', on);
  const btn = document.getElementById('privacyBtn');
  if (btn) {
    btn.textContent = on ? '🙈' : '👁️';
    btn.classList.toggle('active', on);
    btn.title = on ? 'Privacy mode ON — tap to reveal amounts' : 'Privacy mode — blur all amounts';
  }
}
function togglePrivacy() {
  const next = !loadPrivacyPref();
  savePrivacyPref(next);
  applyPrivacyPref();
  toast(next ? '🙈 Amounts blurred' : '👁️ Amounts visible');
}
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('tab-hidden', document.hidden);
});

// ─── Receipt OCR (Claude Vision) ─────────────────────────────────────────────
const OCR_MODEL = 'claude-haiku-4-5';
const ANALYSIS_MODEL = 'claude-sonnet-4-6';

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

function loadOcrConfig() {
  try { return JSON.parse(localStorage.getItem(ocrConfigKey()) || '{}'); } catch (e) { return {}; }
}
function saveOcrConfig(cfg) { localStorage.setItem(ocrConfigKey(), JSON.stringify(cfg)); }

function saveOcrKeyFromUI() {
  const k = document.getElementById('ocrApiKeyInput')?.value?.trim();
  if (!k) { toast('Paste an API key first'); return; }
  saveOcrConfig({ apiKey: k });
  renderOcrPanel();
  toast('API key saved ✓');
}

function clearOcrKeyFromUI() {
  if (!confirm('Remove the saved Anthropic API key from this device?')) return;
  saveOcrConfig({});
  renderOcrPanel();
  toast('API key removed');
}

function renderOcrPanel() {
  const el = document.getElementById('ocrPanel');
  if (!el) return;
  const cfg = loadOcrConfig();
  if (!cfg.apiKey) {
    el.innerHTML = `
      <div class="form-row">
        <label>Anthropic API key (sk-ant-…)</label>
        <input type="password" id="ocrApiKeyInput" placeholder="sk-ant-..." autocomplete="off">
      </div>
      <button class="btn" onclick="saveOcrKeyFromUI()">Save Key</button>
    `;
    return;
  }
  const masked = cfg.apiKey.slice(0, 7) + '…' + cfg.apiKey.slice(-4);
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <div style="font-size:13px;">Saved key · <code style="font-size:11px;">${masked}</code></div>
      <button class="btn btn-outline" onclick="clearOcrKeyFromUI()">Remove Key</button>
    </div>
  `;
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

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      // strip "data:<mime>;base64," prefix
      const comma = String(result).indexOf(',');
      resolve(comma >= 0 ? String(result).slice(comma + 1) : String(result));
    };
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsDataURL(file);
  });
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

  let contentBlocks;
  try {
    contentBlocks = await Promise.all(files.map(async f => {
      const data = await fileToBase64(f);
      if (f.type === 'application/pdf') {
        return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
      }
      return { type: 'image', source: { type: 'base64', media_type: f.type || 'image/jpeg', data } };
    }));
  } catch (e) {
    toast('Could not read one of the files');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const catList = CATEGORIES.map(c => c.name).join(', ');
  const cardList = CARDS.join(', ');
  const sourceLabel = pdfCount && imgCount ? 'attached receipts, statements, and PDFs'
                    : pdfCount > 1 ? `${pdfCount} attached bank statement PDFs`
                    : pdfCount === 1 ? 'this bank statement PDF'
                    : imgCount > 1 ? `${imgCount} attached receipt or statement images`
                    : 'this receipt or statement image';
  const multi = files.length > 1 || pdfCount >= 1;
  const prompt = `Extract every transaction visible in ${sourceLabel}.

${multi ? 'Merge transactions from every page and file into a single combined JSON array, in chronological order. Skip non-transaction rows (opening balance, closing balance, totals, fees summary headers, payments to the card if this is a credit card statement). ' : ''}For each transaction return:
- date: YYYY-MM-DD (if year not visible, infer from the statement period; if no date at all, use ${today})
- merchant: short description (clean up redundant codes like reference numbers, location IDs)
- category: choose the closest match from this list — ${catList}
- card: choose from — ${cardList}. If a bank statement makes the source card obvious (e.g. "DBS Vantage Statement"), use it. Otherwise "Cash".
- amount: a positive number in SGD (use the debit/charge amount, not credit)
- mcc: 4-digit Merchant Category Code IF visible on the statement (e.g. "5814"). Omit the field entirely if not shown.

Return ONLY a JSON array, no prose, no markdown fences. Example:
[{"date":"${today}","merchant":"NTUC","category":"Groceries","card":"DBS Vantage","amount":42.50,"mcc":"5411"}]`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: OCR_MODEL,
        // Bank statements can list 50–100+ transactions per file, so leave room.
        max_tokens: pdfCount > 0 ? 16384 : 4096,
        messages: [{
          role: 'user',
          content: [...contentBlocks, { type: 'text', text: prompt }],
        }],
      }),
    });
  } catch (e) {
    toast('Network error calling Claude');
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    toast(`Claude API ${res.status}`);
    console.warn('OCR API error:', text);
    return;
  }

  const body = await res.json();
  const text = (body?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

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

  const catList = CATEGORIES.map(c => c.name).join(', ');
  // Only send fields needed for inference; keep IDs for patching
  const payload = txns.map(t => ({
    id: t.id,
    date: t.date,
    merchant: t.merchant,
    card: t.card,
    amount: t.amount,
    category: t.category,
    mcc: t.mcc || null,
  }));

  const prompt = `You are reviewing a Singapore credit-card transaction list. Fill in missing MCCs and fix obviously-wrong categories. Be confident — most Singapore merchants are recognisable even with the noisy prefixes banks add.

STRIP MERCHANT PREFIXES before classifying. Examples of the same merchant appearing in different forms:
- "GRAB*SG_XXXXXX", "Grab Rides", "GRAB SINGAPORE", "GRAB*A1B2C3D4" → Grab Rides (taxi)
- "GRABFOOD*XYZ", "GrabFood SG", "Foodpanda *MERCHANT" → food delivery
- "POSB AUTO-PAY SINGTEL", "SINGTEL MOBILE PMT" → Singtel
- "PAYPAL*ACME", "STRIPE*ACME" → look at the merchant after the *

SG MERCHANT CHEAT SHEET (use these MCCs unless statement says otherwise):
- Grab Rides / Gojek / ComfortDelGro / TADA → 4121 → Transport
- GrabFood / Foodpanda / Deliveroo → 5814 → Food Delivery
- GrabMart / RedMart → 5411 → Groceries
- NTUC / FairPrice / Sheng Siong / Cold Storage / Giant / Don Don Donki → 5411 → Groceries
- Singtel / StarHub / M1 / Circles.Life → 4812 → Bills & Subscriptions
- SP Group / Senoko / City Energy → 4900 → Bills & Subscriptions
- Netflix / Spotify / Apple iCloud / Google One / ChatGPT / Disney+ → 5817 → Bills & Subscriptions
- SQ / Singapore Airlines / Scoot / Jetstar / AirAsia → 3000-3299 (airlines) → Travel
- Klook / Trip.com / Agoda / Booking.com / Expedia / Airbnb → 4722 → Travel
- Uniqlo / Zara / H&M / Cotton On / Charles & Keith / Pedro → 5651 / 5621 → Fashion
- Sephora / Watsons / Guardian / Sephora.sg → 5977 → Shopping & Beauty
- Shopee / Lazada / Taobao / Amazon → 5399 → varies (Shopping & Beauty / Fashion / Other based on what's typically bought)
- Apple / Best Denki / Harvey Norman → 5732 → Other
- Pure Yoga / Anytime Fitness / Ally Health / ClassPass → 7991 / 7298 → Health & Fitness
- Mount Elizabeth / Raffles Medical / Q&M / Polyclinic → 8062 / 8021 → Medical & Dental
- Restaurants, hawker stalls, bars, cafes, Starbucks, Coffee Bean → 5812 / 5814 → Dining Out
- POSB / DBS / OCBC / UOB instalments / repayments / loans → 6012 → Debt & Instalments

Rules:
1. Always fill in MCC when you're confident (the cheat sheet covers most cases). Only omit MCC when the merchant is genuinely unrecognisable.
2. If the current category is clearly wrong given the merchant (e.g. Grab Rides categorised as Food Delivery), fix it using a category from the valid list. If the existing category is plausible, leave it.
3. Use ONLY these exact category strings: ${catList}

Return ONLY a JSON array of patches — one per txn that needs updating. Each patch has the original "id" plus only the fields that should change. Example:
[{"id":"abc","mcc":"4121","category":"Transport"},{"id":"def","mcc":"5411"}]

No markdown fences, no prose, no commentary.

Transactions:
${JSON.stringify(payload, null, 2)}`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Sonnet handles merchant-name disambiguation and SG context far
        // better than Haiku — the previous version was missing obvious
        // Grab / NTUC / Singtel cases because Haiku played it too safe.
        model: ANALYSIS_MODEL,
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    toast('Network error calling Claude');
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    toast(`Claude API ${res.status}`);
    console.warn('Enrich error:', text);
    return;
  }

  const body = await res.json();
  const text = (body?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let patches;
  try { patches = JSON.parse(cleaned); }
  catch (e) {
    toast('Claude returned non-JSON; see console');
    console.warn('Enrich response:', cleaned);
    return;
  }
  if (!Array.isArray(patches)) { toast('Unexpected response shape; see console'); console.warn(patches); return; }

  const key = storageKey(currentYear, currentMonth);
  const list = transactions[key] || [];
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

// ─── AI Spending Analysis ────────────────────────────────────────────────────
function buildSpendOverview() {
  const txns = currentTxns();
  const totalSpent = txns.reduce((s, t) => s + t.amount, 0);
  const totalBudget = Object.values(budgets).reduce((s, v) => s + (v || 0), 0);
  const days = new Date(currentYear, currentMonth + 1, 0).getDate();
  const today = new Date();
  const dayOfMonth = (today.getFullYear() === currentYear && today.getMonth() === currentMonth)
    ? today.getDate() : days;
  const dailyAvg = dayOfMonth > 0 ? totalSpent / dayOfMonth : 0;
  const projected = dailyAvg * days;

  const perCategory = CATEGORIES.map(c => {
    const spent = txns.filter(t => t.category === c.name).reduce((s, t) => s + t.amount, 0);
    const bud = budgets[c.name] ?? c.budget;
    return { category: c.name, spent: +spent.toFixed(2), budget: +bud, fixed: !!c.fixed };
  }).filter(c => c.spent > 0 || c.budget > 0);

  const perCard = CARDS.map(card => {
    const cardTxns = txns.filter(t => t.card === card);
    return {
      card,
      spent: +cardTxns.reduce((s, t) => s + t.amount, 0).toFixed(2),
      txns: cardTxns.length,
    };
  }).filter(c => c.txns > 0);

  const prev = previousMonthData();

  // Miles tracker context (HSBC cap + UOB Lady's caps)
  const milesContext = {
    hsbc_cap_sgd: milesConfig.hsbc,
    hsbc_qualifying_spent: +txns
      .filter(t => t.card === 'HSBC Revolution')
      .reduce((s, t) => s + t.amount, 0).toFixed(2),
    uob_lady_dining_cap: milesConfig.uobLadyDining,
    uob_lady_dining_spent: +txns
      .filter(t => t.card === "UOB Lady's" && (milesConfig.diningCats || []).includes(t.category))
      .reduce((s, t) => s + t.amount, 0).toFixed(2),
    uob_lady_fashion_cap: milesConfig.uobLadyFashion,
    uob_lady_fashion_spent: +txns
      .filter(t => t.card === "UOB Lady's" && (milesConfig.fashionCats || []).includes(t.category))
      .reduce((s, t) => s + t.amount, 0).toFixed(2),
  };

  return {
    month: new Date(currentYear, currentMonth, 1).toLocaleString('en-SG', { month: 'long', year: 'numeric' }),
    day_of_month: dayOfMonth,
    days_in_month: days,
    total_spent_sgd: +totalSpent.toFixed(2),
    total_budget_sgd: +totalBudget.toFixed(2),
    daily_average_sgd: +dailyAvg.toFixed(2),
    projected_month_end_sgd: +projected.toFixed(2),
    txn_count: txns.length,
    per_category: perCategory,
    per_card: perCard,
    miles_tracker: milesContext,
    prior_month: prev.hasData
      ? { label: prev.label, total_spent_sgd: +prev.total.toFixed(2) }
      : null,
  };
}

// Build a combined data summary for one card — overall total + any miles
// caps that apply. Used by the dashboard card carousel (formerly two
// separate sections — "Spending by Card" and "Miles Promo Tracker" —
// now folded into one tile per card with a flip face for the rules).
function cardData(card, txns, cardTotals) {
  const cardTxns = txns.filter(t => t.card === card);
  const total = (cardTotals && cardTotals[card]) || 0;
  const miles = [];

  if (card === 'HSBC Revolution') {
    miles.push({
      label: 'Monthly bonus cap',
      shortLabel: 'Monthly cap',
      spent: total,
      cap: milesConfig.hsbc,
      rate: '4 mpd',
      note: 'Counts contactless + online spend (dining, shopping, transport, subscriptions). Excludes SimplyGo, fast-food delivery, and OTAs.',
    });
  } else if (card === "UOB Lady's") {
    const fashionSet = new Set(milesConfig.fashionCats || []);
    const diningSet  = new Set(milesConfig.diningCats || []);
    const fashionSpent = cardTxns.filter(t => fashionSet.has(t.category)).reduce((s,t)=>s+t.amount, 0);
    const diningSpent  = cardTxns.filter(t => diningSet.has(t.category)).reduce((s,t)=>s+t.amount, 0);
    miles.push({
      label: 'Fashion bonus',
      shortLabel: 'Fashion',
      spent: fashionSpent,
      cap: milesConfig.uobLadyFashion,
      rate: '4 mpd',
      note: 'Counts UOB Lady\'s spend in: ' + (milesConfig.fashionCats || []).join(', '),
    });
    miles.push({
      label: 'Dining bonus',
      shortLabel: 'Dining',
      spent: diningSpent,
      cap: milesConfig.uobLadyDining,
      rate: '4 mpd',
      note: 'Counts UOB Lady\'s spend in: ' + (milesConfig.diningCats || []).join(', '),
    });
  } else if (card === 'UOB KrisFlyer') {
    const ytd = getKrisFlyerYTD();
    miles.push({
      label: 'Annual SIA Group min',
      shortLabel: 'Annual SIA',
      spent: ytd,
      cap: milesConfig.kfAnnual,
      rate: '3 mpd on SQ/Scoot',
      note: 'Tracks all UOB KrisFlyer card spend Jan–Dec. Must hit $' + fmt(milesConfig.kfAnnual) + '/year to unlock the 2.4 mpd bonus tier on other spend.',
    });
  }
  // DBS Vantage, Cash, custom cards — no miles tracking → no flip.

  return { card, total, txnCount: cardTxns.length, miles };
}

function renderMilesRow(m) {
  const pct = m.cap > 0 ? Math.min(m.spent / m.cap, 1) : 0;
  const hit = m.spent >= m.cap;
  const close = !hit && m.spent >= m.cap * 0.75;
  const barClass = hit ? 'green' : close ? 'orange' : 'red';
  return `
    <div class="card-miles-row">
      <div class="card-miles-label">
        <span>${m.shortLabel}</span>
        <span class="card-miles-amounts">$${fmt(m.spent)} / $${fmt(m.cap)}</span>
      </div>
      <div class="card-miles-track"><div class="card-miles-bar ${barClass}" style="width:${(pct*100).toFixed(1)}%"></div></div>
    </div>
  `;
}

// Suppress the click that follows a long-press drag, so reordering a card
// doesn't also flip it or jump to Transactions.
let _recentlyReordered = false;
function flipCard(el) {
  if (_recentlyReordered) return;
  if (!el.classList.contains('has-back')) return;
  el.classList.toggle('flipped');
}

// Navigate to the Transactions page with a single filter applied.
function _navToTransactionsWithFilter({ card = '', category = '' } = {}) {
  if (_recentlyReordered) return;
  // Make sure the Category select has its options before we set a value
  // (renderTransactions used to populate them lazily on first render).
  const catEl    = document.getElementById('txnFilter');
  const cardEl   = document.getElementById('txnCardFilter');
  const searchEl = document.getElementById('txnSearch');
  if (catEl && catEl.options.length <= 1) {
    CATEGORIES.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.name; opt.textContent = c.name;
      catEl.appendChild(opt);
    });
  }
  if (catEl)    catEl.value    = category;
  if (cardEl)   cardEl.value   = card;
  if (searchEl) searchEl.value = '';
  const navTx = Array.from(document.querySelectorAll('.nav-item'))
    .find(n => /showPage\('transactions'/.test(n.getAttribute('onclick') || ''));
  showPage('transactions', navTx);
}
function openTxnsForCard(card)    { _navToTransactionsWithFilter({ card }); }
function openTxnsForCategory(cat) { _navToTransactionsWithFilter({ category: cat }); }

// Generic long-press drag-to-reorder for a horizontal carousel.
// dragSelector: which tiles are draggable (e.g. ".card-stat:not(.add-card-tile)").
// pinnedSelector (optional): a tile that stays at the end (e.g. the + Add tile);
// dragged items are kept in front of it.
// idAttr: dataset key to read the stable id from each tile (e.g. "card" → data-card).
// commit(newOrder): called with the post-drag string id list to persist.
function setupCarouselReorder({ containerId, dragSelector, pinnedSelector, idAttr, commit }) {
  const container = document.getElementById(containerId);
  if (!container || container.dataset.reorderBound === '1') return;
  container.dataset.reorderBound = '1';

  const LONG_PRESS_MS = 400;
  const CANCEL_MOVE_PX = 8;
  let pressTimer = null;
  let dragging = null;
  let startX = 0, startY = 0;
  let pointerId = null;

  container.addEventListener('pointerdown', (e) => {
    const tile = e.target.closest(dragSelector);
    if (!tile || !container.contains(tile)) return;
    startX = e.clientX; startY = e.clientY;
    pointerId = e.pointerId;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      dragging = tile;
      tile.classList.add('dragging');
      container.classList.add('reordering');
      container.style.scrollSnapType = 'none';
      try { tile.setPointerCapture(pointerId); } catch (_) {}
      if (navigator.vibrate) navigator.vibrate(12);
    }, LONG_PRESS_MS);
  });

  container.addEventListener('pointermove', (e) => {
    if (pressTimer && Math.hypot(e.clientX - startX, e.clientY - startY) > CANCEL_MOVE_PX) {
      clearTimeout(pressTimer); pressTimer = null;
    }
    if (!dragging) return;
    e.preventDefault();
    const siblings = Array.from(container.querySelectorAll(dragSelector));
    let insertBefore = null;
    for (const s of siblings) {
      if (s === dragging) continue;
      const r = s.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { insertBefore = s; break; }
    }
    const pinned = pinnedSelector ? container.querySelector(pinnedSelector) : null;
    if (insertBefore) {
      if (dragging.nextElementSibling !== insertBefore) container.insertBefore(dragging, insertBefore);
    } else if (pinned) {
      if (dragging.nextElementSibling !== pinned) container.insertBefore(dragging, pinned);
    } else if (container.lastElementChild !== dragging) {
      container.appendChild(dragging);
    }
  });

  const endDrag = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (!dragging) return;
    dragging.classList.remove('dragging');
    container.classList.remove('reordering');
    container.style.scrollSnapType = '';
    const newOrder = Array.from(container.querySelectorAll(dragSelector))
      .map(t => t.dataset[idAttr])
      .filter(Boolean);
    commit(newOrder);
    // Block the click that's about to fire so we don't flip the card we
    // just dropped.
    _recentlyReordered = true;
    setTimeout(() => { _recentlyReordered = false; }, 250);
    dragging = null;
  };
  container.addEventListener('pointerup',     endDrag);
  container.addEventListener('pointercancel', endDrag);
}

function setupCardReorder() {
  setupCarouselReorder({
    containerId: 'cardBreakdown',
    dragSelector: '.card-stat:not(.add-card-tile)',
    pinnedSelector: '.add-card-tile',
    idAttr: 'card',
    commit: (order) => {
      const prev = loadCardOrder();
      if (JSON.stringify(prev) === JSON.stringify(order)) return;
      saveCardOrder(order);
      refreshCards();
    },
  });
}

function setupMilesReorder() {
  setupCarouselReorder({
    containerId: 'milesGrid',
    dragSelector: '.miles-card',
    pinnedSelector: null,
    idAttr: 'milesId',
    commit: (order) => {
      const prev = loadMilesOrder();
      if (JSON.stringify(prev) === JSON.stringify(order)) return;
      saveMilesOrder(order);
    },
  });
}

function openAddCardModal() {
  document.getElementById('newCardName').value = '';
  document.getElementById('addCardErr').textContent = '';
  document.getElementById('addCardModal').style.display = 'flex';
  setTimeout(() => document.getElementById('newCardName').focus(), 40);
}
function closeAddCardModal() { document.getElementById('addCardModal').style.display = 'none'; }
function submitAddCard() {
  const name = document.getElementById('newCardName').value.trim();
  const errEl = document.getElementById('addCardErr');
  if (!name) { errEl.textContent = 'Card name is required'; return; }
  if (CARDS.some(c => c.toLowerCase() === name.toLowerCase())) {
    errEl.textContent = 'A card with that name already exists'; return;
  }
  const custom = loadCustomCards();
  custom.push({ name, color: nextCustomColor() });
  saveCustomCards(custom);
  refreshCards();
  populateCardSelects();
  renderDashboard();
  closeAddCardModal();
  toast(`Added "${name}"`);
}

function openAnalysisModal() {
  document.getElementById('analysisModal').style.display = 'flex';
}
function closeAnalysisModal() {
  document.getElementById('analysisModal').style.display = 'none';
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

  const overview = buildSpendOverview();
  const prompt = `You are a sharp personal finance coach. Look at this user's current-month dashboard data and write ONE paragraph (max 110 words) that:
- States the headline: are they on/under/over pace? quantify briefly
- Calls out the 1-2 categories driving the pace (good or bad)
- Notes any miles-card cap they should chase or avoid wasting
- Ends with one concrete, specific action for the rest of the month

Be direct and Singaporean-pragmatic. Use SGD. No bullet points, no preamble, no markdown — just the paragraph.

Dashboard data (JSON):
${JSON.stringify(overview, null, 2)}`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    body.classList.remove('loading');
    body.textContent = '⚠️ Network error calling Claude';
    btn.disabled = false;
    btn.textContent = 'Try again';
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    body.classList.remove('loading');
    body.textContent = `⚠️ Claude API ${res.status}`;
    console.warn('Analysis API error:', text);
    btn.disabled = false;
    btn.textContent = 'Try again';
    return;
  }

  const json = await res.json();
  const text = (json?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  body.classList.remove('loading');
  body.innerHTML = `<div>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
    <div class="analysis-meta">
      <span>${new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' })}</span>
      <a onclick="generateSpendAnalysis()">↻ Refresh</a>
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
    const k = storageKey(currentYear, currentMonth);
    try { transactions[k] = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { transactions[k] = []; }
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
      const k = storageKey(currentYear, currentMonth);
      try { transactions[k] = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { transactions[k] = []; }
      const savedBudgets = localStorage.getItem(budgetKey());
      if (savedBudgets) budgets = JSON.parse(savedBudgets);
      const savedMiles = localStorage.getItem(milesKey());
      if (savedMiles) milesConfig = Object.assign({}, milesConfig, JSON.parse(savedMiles));
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

  // Saved budgets: sum old-key values into their new-key buckets, drop stale keys
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
function loadRecurring() {
  try { return JSON.parse(localStorage.getItem(recurringKey()) || '[]'); } catch (e) { return []; }
}
function saveRecurringList(list) { localStorage.setItem(recurringKey(), JSON.stringify(list)); triggerSyncPush(); }
function loadRecurringApplied() {
  try { return JSON.parse(localStorage.getItem(recurringAppliedKey()) || '{}'); } catch (e) { return {}; }
}
function saveRecurringApplied(map) { localStorage.setItem(recurringAppliedKey(), JSON.stringify(map)); triggerSyncPush(); }

function isCurrentOrFutureMonth(y, m) {
  const today = new Date();
  return (y > today.getFullYear()) || (y === today.getFullYear() && m >= today.getMonth());
}

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
    if (transactions[txKey]) transactions[txKey] = txns;
  }
}

let editingRecurringId = null;

function openRecurringModal(id) {
  editingRecurringId = id || null;
  document.getElementById('recurringModalTitle').textContent = id ? 'Edit Recurring Transaction' : 'Add Recurring Transaction';
  document.getElementById('recSaveBtn').textContent = id ? 'Save Changes' : 'Add';

  // Populate category dropdown fresh each open
  document.getElementById('recCategory').innerHTML =
    CATEGORIES.map(c => `<option value="${c.name}">${c.emoji} ${c.name}</option>`).join('');

  if (id) {
    const r = loadRecurring().find(x => x.id === id);
    if (!r) { editingRecurringId = null; toast('Recurring not found'); return; }
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

function closeRecurringModal() {
  document.getElementById('recurringModal').style.display = 'none';
  editingRecurringId = null;
}

function saveRecurring() {
  const merchant = document.getElementById('recMerchant').value.trim();
  const category = document.getElementById('recCategory').value;
  const card     = document.getElementById('recCard').value;
  const amount   = parseFloat(document.getElementById('recAmount').value);
  const day      = parseInt(document.getElementById('recDay').value, 10);

  if (!merchant || !amount || amount <= 0 || !day || day < 1 || day > 28) {
    toast('Fill in all fields (day must be 1–28)'); return;
  }

  const list = loadRecurring();
  if (editingRecurringId) {
    const idx = list.findIndex(x => x.id === editingRecurringId);
    if (idx < 0) { toast('Recurring not found'); return; }
    list[idx] = { ...list[idx], merchant, category, card, amount, day };
    saveRecurringList(list);
    closeRecurringModal();
    renderRecurringList();
    toast('Recurring updated ✓');
    return;
  }

  const newRec = {
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    merchant, category, card, amount, day,
  };
  list.push(newRec);
  saveRecurringList(list);
  // Auto-apply to current month if applicable
  applyRecurringForMonth(currentYear, currentMonth);
  closeRecurringModal();
  renderRecurringList();
  renderAll();
  toast(`Recurring added — ${isCurrentOrFutureMonth(currentYear, currentMonth) ? 'applied to ' + monthLabel() : 'will apply going forward'}`);
}

function deleteRecurring(id) {
  const list = loadRecurring().filter(r => r.id !== id);
  saveRecurringList(list);
  // Also forget that it was applied, so if re-added it can re-apply
  const appliedMap = loadRecurringApplied();
  Object.keys(appliedMap).forEach(mk => {
    appliedMap[mk] = (appliedMap[mk] || []).filter(rid => rid !== id);
  });
  saveRecurringApplied(appliedMap);
  renderRecurringList();
  toast('Recurring deleted (existing month transactions kept)');
}

function renderRecurringList() {
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
          <button class="btn-edit" onclick="openRecurringModal('${r.id}')" title="Edit">✎</button>
          <button class="btn-del" onclick="if(confirm('Delete recurring &quot;${escHtml(r.merchant)}&quot;? Past auto-added rows are kept.')) deleteRecurring('${r.id}')" title="Delete">✕</button>
        </div>`;
      }).join('')}
    </div>
  `;
}

function loadData() {
  migrateStoredCategories();

  // Auto-apply recurring for the month we're about to render
  applyRecurringForMonth(currentYear, currentMonth);

  // Budgets
  const savedBudgets = localStorage.getItem(budgetKey());
  if (savedBudgets) budgets = JSON.parse(savedBudgets);
  else CATEGORIES.forEach(c => { budgets[c.name] = c.budget; });

  // Miles config — merge saved over defaults so new keys always have values
  const savedMiles = localStorage.getItem(milesKey());
  if (savedMiles) milesConfig = Object.assign({}, milesConfig, JSON.parse(savedMiles));

  // Transactions for current month
  const key = storageKey(currentYear, currentMonth);
  const raw = localStorage.getItem(key);
  if (raw) transactions[key] = JSON.parse(raw);
  else transactions[key] = [];
}

function saveTransactions() {
  const key = storageKey(currentYear, currentMonth);
  localStorage.setItem(key, JSON.stringify(transactions[key] || []));
  triggerSyncPush();
}

function currentTxns() {
  return transactions[storageKey(currentYear, currentMonth)] || [];
}

// ─── Month navigation ────────────────────────────────────────────────────────
function initMonth() {
  const now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth();
}

function syncMonthPicker() {
  const el = document.getElementById('monthPicker');
  if (el) el.value = `${currentYear}-${String(currentMonth+1).padStart(2,'0')}`;
}

function changeMonth(delta) {
  currentMonth += delta;
  if (currentMonth > 11) { currentMonth = 0; currentYear++; }
  if (currentMonth < 0)  { currentMonth = 11; currentYear--; }
  syncMonthPicker();
  loadData();
  renderAll();
}

function onMonthPickerChange() {
  const v = document.getElementById('monthPicker').value;
  if (!v) return;
  const [y, m] = v.split('-').map(Number);
  if (!y || !m) return;
  currentYear = y;
  currentMonth = m - 1;
  loadData();
  renderAll();
}

function monthLabel() {
  return new Date(currentYear, currentMonth, 1).toLocaleString('en-SG', { month: 'long', year: 'numeric' });
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

// ─── Dashboard ───────────────────────────────────────────────────────────────
function previousMonthData() {
  let y = currentYear, m = currentMonth - 1;
  if (m < 0) { m = 11; y--; }
  const k = storageKey(y, m);
  let prev = [];
  try { prev = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) {}
  const byCat = {};
  CATEGORIES.forEach(c => byCat[c.name] = 0);
  prev.forEach(t => { if (byCat[t.category] !== undefined) byCat[t.category] += t.amount; });
  const total = prev.reduce((s, t) => s + t.amount, 0);
  const label = new Date(y, m, 1).toLocaleString('en-SG', { month: 'short' });
  return { total, byCategory: byCat, hasData: prev.length > 0, label };
}

function deltaBadge(curr, prev) {
  if (prev === 0 && curr === 0) return '';
  if (prev === 0) return `<span class="mom-badge mom-up">▲ new</span>`;
  const delta = curr - prev;
  if (Math.abs(delta) < 0.01) return `<span class="mom-badge mom-flat">▬ flat</span>`;
  const pctChange = (delta / prev) * 100;
  const up = delta > 0;
  return `<span class="mom-badge ${up ? 'mom-up' : 'mom-down'}">${up ? '▲' : '▼'} ${up ? '+' : '−'}$${fmt(Math.abs(delta))} (${Math.abs(pctChange).toFixed(0)}%)</span>`;
}

function renderDashboard() {
  syncMonthPicker();
  const txns = currentTxns();
  const totalSpent = txns.reduce((s, t) => s + t.amount, 0);
  const totalBudget = Object.values(budgets).reduce((s, v) => s + v, 0);
  const remaining = totalBudget - totalSpent;
  const pct = totalBudget > 0 ? totalSpent / totalBudget : 0;

  const prev = previousMonthData();

  const days = new Date(currentYear, currentMonth + 1, 0).getDate();
  const today = new Date();
  const dayOfMonth = (today.getFullYear() === currentYear && today.getMonth() === currentMonth)
    ? today.getDate() : days;
  const dailyAvg = dayOfMonth > 0 ? totalSpent / dayOfMonth : 0;
  const projected = dailyAvg * days;

  // Vibe — based on projected pace (more honest than raw spent so far)
  const pace = totalBudget > 0 ? projected / totalBudget : 0;
  const vibe = pace < 0.85 ? { emoji: '😎', cls: 'vibe-good',   verdict: 'Well under', ring: 'good' }
            : pace < 1.0  ? { emoji: '🙂', cls: 'vibe-fine',   verdict: 'On pace',    ring: 'good' }
            : pace < 1.15 ? { emoji: '😬', cls: 'vibe-tight',  verdict: 'Tight',      ring: 'warn' }
            :               { emoji: '🔥', cls: 'vibe-danger', verdict: 'Over',       ring: 'over' };

  // Ring arc values (path normalised to 100 via pathLength)
  const spentArc = Math.max(0, Math.min(100, pct * 100));     // capped visually
  const dayArc   = days > 0 ? (dayOfMonth / days) * 100 : 0;

  // Hero — big ring + center stack
  document.getElementById('heroRing').innerHTML = `
    <svg class="hero-ring-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="ringGoodGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#10b981" /><stop offset="100%" stop-color="#34d399" />
        </linearGradient>
        <linearGradient id="ringWarnGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f59e0b" /><stop offset="100%" stop-color="#fbbf24" />
        </linearGradient>
        <linearGradient id="ringOverGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#dc2626" /><stop offset="100%" stop-color="#f87171" />
        </linearGradient>
      </defs>
      <g transform="rotate(-90 50 50)">
        <circle class="ring-track-day"  cx="50" cy="50" r="46" />
        <circle class="ring-arc-day"    cx="50" cy="50" r="46" pathLength="100"
                stroke-dasharray="0 100" data-target="${dayArc.toFixed(2)}" />
        <circle class="ring-track-main" cx="50" cy="50" r="38" />
        <circle class="ring-arc-main ${vibe.ring}" cx="50" cy="50" r="38" pathLength="100"
                stroke-dasharray="0 100" data-target="${spentArc.toFixed(2)}" />
      </g>
    </svg>
    <div class="hero-center">
      <div class="hero-day">Day ${dayOfMonth} of ${days}</div>
      <div class="hero-vibe ${vibe.cls}"><span class="hero-vibe-emoji">${vibe.emoji}</span> ${vibe.verdict}</div>
      <div class="hero-amount ${pct > 1 ? 'red' : pct > 0.8 ? 'orange' : 'green'}">$${fmt(totalSpent)}</div>
      <div class="hero-divider"></div>
      <div class="hero-of">of $${fmt(totalBudget)}</div>
      <div class="hero-pct">${(pct*100).toFixed(0)}% used${prev.hasData ? ` · ${deltaBadge(totalSpent, prev.total)} vs ${prev.label}` : ''}</div>
    </div>
  `;

  // Animate the arcs in on next paint (CSS transitions handle the easing)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('#heroRing .ring-arc-day, #heroRing .ring-arc-main').forEach(c => {
      const t = parseFloat(c.dataset.target) || 0;
      c.setAttribute('stroke-dasharray', `${t} ${(100 - t).toFixed(2)}`);
    });
  }));

  document.getElementById('heroChips').innerHTML = `
    <div class="hero-chip">
      <div class="hero-chip-label">Daily Average</div>
      <div class="hero-chip-value">$${fmt(dailyAvg)}</div>
      <div class="hero-chip-sub">Day ${dayOfMonth} of ${days}</div>
    </div>
    <div class="hero-chip">
      <div class="hero-chip-label">Projected Month-End</div>
      <div class="hero-chip-value ${projected > totalBudget ? 'orange' : 'green'}">$${fmt(projected)}</div>
      <div class="hero-chip-sub">at current pace</div>
    </div>
  `;

  // Card breakdown
  const cardTotals = {};
  CARDS.forEach(c => cardTotals[c] = 0);
  txns.forEach(t => { if (cardTotals[t.card] !== undefined) cardTotals[t.card] += t.amount; });
  const cardsHtml = CARDS.map(card => {
    const data = cardData(card, txns, cardTotals);
    const colorVar = `--card-color: ${CARD_COLOR[card] || 'var(--border)'};`;
    const badgeHtml = `<span class="txn-card-badge ${CARD_CLASS[card] || ''}" ${cardBadgeStyle(card)}>${card}</span>`;
    const safeCard = escHtml(card);
    const cardJs   = card.replace(/'/g, "\\'");
    const hasBack  = data.miles.length > 0;
    const rulesBtn = hasBack
      ? `<button class="card-rules-btn" onclick="event.stopPropagation(); flipCard(this.closest('.card-stat'))" title="See rules" aria-label="See rules">ⓘ</button>`
      : '';
    const frontInner = `
      ${rulesBtn}
      <div class="card-name">${badgeHtml}</div>
      <div class="card-total" style="margin-top:8px;">$${fmt(data.total)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px;">${data.txnCount} txn${data.txnCount===1?'':'s'}</div>
      ${data.miles.map(renderMilesRow).join('')}
    `;
    if (!hasBack) {
      return `<div class="card-stat" data-card="${safeCard}" style="${colorVar}" onclick="openTxnsForCard('${cardJs}')" title="View transactions on ${safeCard}">${frontInner}</div>`;
    }
    const backInner = `
      <div class="card-back-title">${badgeHtml} <span style="color:var(--small);font-weight:400;margin-left:6px;">rules</span></div>
      ${data.miles.map(m => `
        <div class="card-back-rule">
          <div class="card-back-rule-title">${m.label} · ${m.rate}</div>
          <div class="card-back-rule-text">${m.note}</div>
        </div>
      `).join('')}
      <div class="card-back-hint">tap to flip back ↺</div>
    `;
    return `
      <div class="card-stat has-back" data-card="${safeCard}" style="${colorVar}">
        <div class="card-faces">
          <div class="card-face card-front" onclick="openTxnsForCard('${cardJs}')" title="View transactions on ${safeCard}">${frontInner}</div>
          <div class="card-face card-back"  onclick="flipCard(this.closest('.card-stat'))" title="Tap to flip back">${backInner}</div>
        </div>
      </div>
    `;
  }).join('');
  const addTile = `
    <div class="card-stat add-card-tile" onclick="openAddCardModal()" title="Add a new card">
      <div class="add-card-plus">＋</div>
      <div class="add-card-label">Add card</div>
    </div>
  `;
  document.getElementById('cardBreakdown').innerHTML = cardsHtml + addTile;

  // Miles is now folded into each card's flip face — no standalone section.

  // Budget bars
  const spentByCategory = {};
  CATEGORIES.forEach(c => spentByCategory[c.name] = 0);
  txns.forEach(t => { if (spentByCategory[t.category] !== undefined) spentByCategory[t.category] += t.amount; });

  document.getElementById('budgetGrid').innerHTML = CATEGORIES.map(cat => {
    const spent = spentByCategory[cat.name] || 0;
    const bud   = budgets[cat.name] || cat.budget;
    const pct   = bud > 0 ? Math.min(spent / bud, 1) : 0;
    const over  = spent > bud;
    const warn  = spent > bud * 0.8;
    const barClass = over ? 'red' : warn ? 'orange' : 'green';
    const tagClass = cat.fixed ? 'tag-fixed' : over ? 'tag-over' : warn ? 'tag-warn' : 'tag-ok';
    const tagText  = cat.fixed ? 'Fixed' : over ? 'Over' : warn ? 'Near limit' : 'On track';
    const catJs = cat.name.replace(/'/g, "\\'");
    return `
      <div class="budget-item" style="--cat-color: ${cat.color || 'var(--border)'}; cursor: pointer;" onclick="openTxnsForCategory('${catJs}')" title="View ${escHtml(cat.name)} transactions">
        <div class="budget-header">
          <div>
            <div class="budget-cat"><span class="budget-emoji">${cat.emoji}</span>${cat.name}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
            <span class="budget-tag ${tagClass}">${tagText}</span>
            <div class="budget-amounts"><strong>$${fmt(spent)}</strong>of $${fmt(bud)}</div>
          </div>
        </div>
        <div class="progress-track"><div class="progress-bar ${barClass}" style="width:${(pct*100).toFixed(1)}%"></div></div>
        <div class="budget-footer">
          <span>${(pct*100).toFixed(0)}% used</span>
          <span>${over ? '⚠️ $'+fmt(spent-bud)+' over' : '$'+fmt(bud-spent)+' left'}</span>
        </div>
        ${prev.hasData ? `<div class="budget-mom">${deltaBadge(spent, prev.byCategory[cat.name] || 0)} <span style="color:var(--small);">vs ${prev.label} ($${fmt(prev.byCategory[cat.name] || 0)})</span></div>` : ''}
      </div>
    `;
  }).join('');
}

// ─── Miles Tracker ────────────────────────────────────────────────────────────
function getKrisFlyerYTD() {
  const year = new Date().getFullYear();
  let total = 0;
  for (let m = 0; m < 12; m++) {
    const key = `txns_${year}_${String(m+1).padStart(2,'0')}`;
    const raw = localStorage.getItem(key);
    if (raw) JSON.parse(raw).forEach(t => { if (t.card === 'UOB KrisFlyer') total += t.amount; });
  }
  return total;
}

function milesPanel({ id, label, subLabel, badgeClass, card, spent, threshold, rate, note, isAnnual }) {
  const cardColor = CARD_COLOR[card] || 'var(--border)';
  const pct = threshold > 0 ? Math.min(spent / threshold, 1) : 0;
  const hit = spent >= threshold;
  const close = !hit && spent >= threshold * 0.75;
  const barClass = hit ? 'green' : close ? 'orange' : 'red';
  const badgeCls = hit ? 'hit' : close ? 'close' : 'miss';
  const badgeText = hit ? '✅ Cap Hit' : close ? '⚡ Almost' : '❌ Not Yet';
  const remaining = Math.max(threshold - spent, 0);
  const periodLabel = isAnnual ? 'this year' : 'this month';
  return `
    <div class="miles-card" data-miles-id="${id}" style="--card-color: ${cardColor};">
      <div class="miles-card-header">
        <div>
          <div class="miles-card-name">
            <span class="txn-card-badge ${badgeClass}" style="font-size:12px;padding:3px 10px;">${label}</span>
          </div>
        </div>
        <span class="miles-badge ${badgeCls}">${badgeText}</span>
      </div>
      <div class="miles-amounts">
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Spent ${periodLabel}</div>
          <div class="spent-val" style="color:${hit ? 'var(--green)' : 'var(--text)'}">$${fmt(spent)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">${isAnnual ? 'Annual min' : 'Monthly cap'}</div>
          <div class="miles-cap-val" style="font-size:18px;font-weight:700;color:var(--muted);">$${fmt(threshold)}</div>
        </div>
      </div>
      <div class="miles-progress-track">
        <div class="miles-progress-bar ${barClass}" style="width:${(pct*100).toFixed(1)}%"></div>
      </div>
      <div class="miles-footer">
        <span>${(pct*100).toFixed(0)}% to ${isAnnual ? 'minimum' : 'cap'}</span>
        <span>${hit ? (isAnnual ? '🎉 Bonus unlocked!' : '🎉 Cap maxed!') : 'Need $'+fmt(remaining)+' more'}</span>
      </div>
      <div class="miles-card-note">${rate} · ${note}</div>
    </div>
  `;
}

function renderMilesTracker(txns, cardTotals) {
  // HSBC: total HSBC spend this month
  const hsbcSpent = cardTotals?.['HSBC Revolution'] || 0;

  // UOB Lady's Fashion: UOB Lady's card + fashion-mapped categories
  const fashionSet = new Set(milesConfig.fashionCats);
  const uobFashion = txns.filter(t => t.card === "UOB Lady's" && fashionSet.has(t.category))
                         .reduce((s, t) => s + t.amount, 0);

  // UOB Lady's Dining: UOB Lady's card + dining-mapped categories
  const diningSet = new Set(milesConfig.diningCats);
  const uobDining = txns.filter(t => t.card === "UOB Lady's" && diningSet.has(t.category))
                        .reduce((s, t) => s + t.amount, 0);

  // KrisFlyer: all UOB KrisFlyer spend year-to-date
  const kfYTD = getKrisFlyerYTD();

  const panels = {
    'hsbc': milesPanel({
      id: 'hsbc',
      label: 'HSBC Revolution',
      subLabel: 'Monthly cap — dining, shopping, transport, online',
      badgeClass: 'card-hsbc',
      card: 'HSBC Revolution',
      spent: hsbcSpent,
      threshold: milesConfig.hsbc,
      rate: '4 mpd',
      note: 'Contactless + online spend. Excludes SimplyGo, fast food delivery, OTAs.',
      isAnnual: false,
    }),
    'uob-fashion': milesPanel({
      id: 'uob-fashion',
      label: "UOB Lady's · Fashion",
      subLabel: milesConfig.fashionCats.join(' · '),
      badgeClass: 'card-uob-lady',
      card: "UOB Lady's",
      spent: uobFashion,
      threshold: milesConfig.uobLadyFashion,
      rate: '4 mpd',
      note: 'Tracks UOB Lady\'s card spend in Fashion-mapped categories.',
      isAnnual: false,
    }),
    'uob-dining': milesPanel({
      id: 'uob-dining',
      label: "UOB Lady's · Dining",
      subLabel: milesConfig.diningCats.join(' · '),
      badgeClass: 'card-uob-lady',
      card: "UOB Lady's",
      spent: uobDining,
      threshold: milesConfig.uobLadyDining,
      rate: '4 mpd',
      note: 'Tracks UOB Lady\'s card spend in Dining-mapped categories.',
      isAnnual: false,
    }),
    'kf': milesPanel({
      id: 'kf',
      label: 'UOB KrisFlyer',
      subLabel: 'Annual SIA Group minimum · Jan–Dec ' + new Date().getFullYear(),
      badgeClass: 'card-uob-kf',
      card: 'UOB KrisFlyer',
      spent: kfYTD,
      threshold: milesConfig.kfAnnual,
      rate: '3 mpd on SQ/Scoot',
      note: 'Tracks all UOB KrisFlyer card spend YTD. Must hit $' + milesConfig.kfAnnual + '/year to unlock 2.4 mpd bonus.',
      isAnnual: true,
    }),
  };

  // Apply saved order: ids in saved order first, then any not-yet-ordered ones.
  const defaultOrder = Object.keys(panels);
  const saved = loadMilesOrder();
  const final = [];
  saved.forEach(id => { if (panels[id] && !final.includes(id)) final.push(id); });
  defaultOrder.forEach(id => { if (!final.includes(id)) final.push(id); });

  document.getElementById('milesGrid').innerHTML = final.map(id => panels[id]).join('');
}

// ─── Transactions ─────────────────────────────────────────────────────────────
function renderTransactions() {
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

  let txns = [...currentTxns()].sort((a, b) => b.date.localeCompare(a.date));
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
    body.innerHTML = `<div class="empty">🧾<p>No transactions yet for ${monthLabel()}</p></div>`;
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
      <span><span class="txn-cat-badge">${CATEGORIES.find(c=>c.name===t.category)?.emoji||''} ${t.category}</span></span>
      <span><span class="txn-card-badge ${CARD_CLASS[t.card] || ''}" ${cardBadgeStyle(t.card)}>${t.card}</span></span>
      <span class="txn-amount">$${fmt(t.amount)}</span>
      <span class="txn-row-actions">
        <button class="btn-edit" onclick="openEditTxn('${t.id}')" title="Edit">✎</button>
        <button class="btn-del" onclick="deleteTxn('${t.id}')" title="Delete">✕</button>
      </span>
    </div>
  `;}).join('');
}

function deleteTxn(id) {
  const key = storageKey(currentYear, currentMonth);
  transactions[key] = (transactions[key] || []).filter(t => t.id !== id);
  saveTransactions();
  renderAll();
  toast('Transaction deleted');
}

// ─── Settings ────────────────────────────────────────────────────────────────
function renderSettings() {
  const table = document.getElementById('settingsTable');
  table.innerHTML = `
    <tr><th>Category</th><th>Type</th><th style="text-align:right">Monthly Budget (SGD)</th></tr>
    ${CATEGORIES.map(cat => `
      <tr>
        <td>${cat.emoji} ${cat.name}</td>
        <td>${cat.fixed ? '<span class="fixed-badge">Fixed</span>' : '<span style="font-size:11px;color:var(--muted)">Discretionary</span>'}</td>
        <td style="text-align:right">
          <input type="number" id="bud_${cat.name.replace(/\W/g,'_')}"
            value="${budgets[cat.name] || cat.budget}" min="0" step="1"
            ${cat.fixed ? 'style="opacity:0.5"' : ''}>
        </td>
      </tr>
    `).join('')}
  `;
}

function renderMilesSettings() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('miles_hsbc', milesConfig.hsbc);
  set('miles_uob_fashion', milesConfig.uobLadyFashion);
  set('miles_uob_dining', milesConfig.uobLadyDining);
  set('miles_kf_annual', milesConfig.kfAnnual);
  set('miles_fashion_cats', (milesConfig.fashionCats || []).join(', '));
  set('miles_dining_cats', (milesConfig.diningCats || []).join(', '));
}

function saveMilesSettings() {
  const get = (id, def) => parseFloat(document.getElementById(id)?.value) || def;
  const getCats = (id, def) => {
    const v = document.getElementById(id)?.value || '';
    const parsed = v.split(',').map(s => s.trim()).filter(Boolean);
    return parsed.length ? parsed : def;
  };
  milesConfig = {
    hsbc: get('miles_hsbc', 1000),
    uobLadyFashion: get('miles_uob_fashion', 750),
    uobLadyDining: get('miles_uob_dining', 750),
    kfAnnual: get('miles_kf_annual', 1000),
    fashionCats: getCats('miles_fashion_cats', ['Luxury Fashion', 'Clothing & Apparel']),
    diningCats: getCats('miles_dining_cats', ['Fine Dining', 'Casual Dining', 'Cafes & Coffee']),
  };
  localStorage.setItem(milesKey(), JSON.stringify(milesConfig));
  triggerSyncPush();
  renderDashboard();
  toast('Miles settings saved ✓');
}

function saveBudgets() {
  CATEGORIES.forEach(cat => {
    const id = `bud_${cat.name.replace(/\W/g,'_')}`;
    const el = document.getElementById(id);
    if (el) budgets[cat.name] = parseFloat(el.value) || 0;
  });
  localStorage.setItem(budgetKey(), JSON.stringify(budgets));
  triggerSyncPush();
  renderDashboard();
  toast('Budgets saved ✓');
}

// ─── Add / Edit Transaction Modal ────────────────────────────────────────────
let editingTxnId = null;

function populateTxnCategorySelect() {
  document.getElementById('txnCategory').innerHTML =
    CATEGORIES.map(c => `<option value="${c.name}">${c.emoji} ${c.name}</option>`).join('');
}

function onMccInputChange() {
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

function openAddTxn() {
  editingTxnId = null;
  document.getElementById('txnModalTitle').textContent = 'Add Transaction';
  document.getElementById('txnSaveBtn').textContent = 'Add Transaction';

  const now = new Date();
  const isCurrentMonth = now.getFullYear() === currentYear && now.getMonth() === currentMonth;
  document.getElementById('txnDate').value = isCurrentMonth
    ? now.toISOString().split('T')[0]
    : `${currentYear}-${String(currentMonth+1).padStart(2,'0')}-01`;
  document.getElementById('txnMerchant').value = '';
  document.getElementById('txnAmount').value = '';
  document.getElementById('txnMcc').value = '';
  document.getElementById('txnMccHint').textContent = '';
  document.getElementById('txnCard').value = 'DBS Vantage';

  populateTxnCategorySelect();
  document.getElementById('addModal').style.display = 'flex';
  setTimeout(() => document.getElementById('txnMerchant').focus(), 100);
}

function openEditTxn(id) {
  const key = storageKey(currentYear, currentMonth);
  const t = (transactions[key] || []).find(x => x.id === id);
  if (!t) { toast('Transaction not found'); return; }

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

function closeAddTxn() {
  document.getElementById('addModal').style.display = 'none';
  editingTxnId = null;
}

function saveTxn() {
  const date     = document.getElementById('txnDate').value;
  const merchant = document.getElementById('txnMerchant').value.trim();
  const category = document.getElementById('txnCategory').value;
  const card     = document.getElementById('txnCard').value;
  const amount   = parseFloat(document.getElementById('txnAmount').value);
  const mccRaw   = (document.getElementById('txnMcc').value || '').trim();

  if (!date || !merchant || !amount || amount <= 0) { toast('Please fill in all fields'); return; }
  if (mccRaw && !/^\d{4}$/.test(mccRaw)) { toast('MCC must be 4 digits (or empty)'); return; }
  const mcc = mccRaw || undefined;

  if (editingTxnId) {
    const key = storageKey(currentYear, currentMonth);
    const list = transactions[key] || [];
    const idx = list.findIndex(x => x.id === editingTxnId);
    if (idx < 0) { toast('Transaction not found'); return; }
    list[idx] = { ...list[idx], date, merchant, category, card, amount, mcc };
    saveTransactions();
    closeAddTxn();
    renderAll();
    toast('Transaction updated ✓');
    return;
  }

  addTxnToStore({ date, merchant, category, card, amount, mcc });
  closeAddTxn();
  renderAll();
  toast(`Added $${fmt(amount)} · ${merchant}`);
}

function addTxnToStore(t) {
  const key = storageKey(currentYear, currentMonth);
  if (!transactions[key]) transactions[key] = [];
  const row = { id: Date.now().toString() + Math.random().toString(36).slice(2), date: t.date, merchant: t.merchant, category: t.category, card: t.card, amount: t.amount };
  if (t.mcc) row.mcc = String(t.mcc);
  transactions[key].push(row);
  saveTransactions();
}

// ─── Import Modal ────────────────────────────────────────────────────────────
function openImport() {
  document.getElementById('importJson').value = '';
  document.getElementById('importResult').style.display = 'none';
  document.getElementById('importMonthLabel').textContent = monthLabel();
  document.getElementById('importModal').style.display = 'flex';
  renderImportEntries();
  setTimeout(() => document.getElementById('importJson').focus(), 100);
}

function closeImport() { document.getElementById('importModal').style.display = 'none'; }

function clearImportResult() { document.getElementById('importResult').style.display = 'none'; }

function onImportJsonInput() {
  clearImportResult();
  renderImportEntries();
}

// Fingerprint = the identifying fields of a purchase event. Used to flag
// duplicates in the import review list. Normalisation handles real-world
// divergences between manual entries, OCR re-scans, and synced data:
//   • date     → first 10 chars, so "2026-05-19T00:00:00Z" matches "2026-05-19"
//   • merchant → lowercase + collapsed whitespace + trim, so casing and
//                trailing spaces don't matter (substring differences like
//                "NTUC" vs "NTUC FAIRPRICE" intentionally still don't match —
//                fuzzy matching would produce false positives)
//   • amount   → abs + 2dp, so sign and trailing zeros don't matter
//   • card     → trimmed
// Category and MCC are deliberately excluded — they're post-hoc labels,
// not part of a purchase's identity. Two entries for the same NTUC charge
// labelled Groceries vs Shopping are still the same purchase.
function txnFingerprint(t) {
  const date = String(t.date || '').slice(0, 10);
  const merchant = String(t.merchant || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const card = String(t.card || '').trim();
  const amt = parseFloat(t.amount);
  const amtStr = isNaN(amt) ? '' : Math.abs(amt).toFixed(2);
  return [date, merchant, card, amtStr].join('|');
}

// Walk every txns_* bucket in localStorage (not just the current month) so a
// receipt re-scanned weeks later still flags as a dup.
function buildExistingTxnFingerprints() {
  const set = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('txns_')) continue;
    let arr;
    try { arr = JSON.parse(localStorage.getItem(k) || '[]'); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    arr.forEach(t => set.add(txnFingerprint(t)));
  }
  return set;
}

// Render the per-entry review list whenever the textarea holds a valid JSON
// array. Each row shows the entry's raw single-line JSON plus a × button to
// drop it before importing. Rows whose fingerprint already exists in storage
// get a red tint + "Duplicate" badge. Textarea remains the source of truth.
function renderImportEntries() {
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

function dropImportEntry(i) {
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
    if (!VALID_CARDS.has(t.card)) { errors.push(`Row ${i+1}: unknown card "${t.card}". Valid: ${CARDS.join(', ')}`); return; }
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

function validateImport() {
  try {
    const { valid, errors } = parseImportJson();
    if (errors.length) showImportResult(`⚠️ ${errors.length} error(s):<br>${errors.join('<br>')}`, false);
    else showImportResult(`✅ ${valid.length} transaction(s) look valid. Click <strong>Import All</strong> to add them.`, true);
  } catch(e) { showImportResult('❌ ' + e.message, false); }
}

function processImport() {
  try {
    const { valid, errors } = parseImportJson();
    if (errors.length) {
      showImportResult(`❌ Fix these errors before importing:<br>${errors.join('<br>')}`, false);
      return;
    }
    valid.forEach(t => addTxnToStore(t));
    closeImport();
    renderAll();
    toast(`✅ Imported ${valid.length} transaction(s)`);
  } catch(e) { showImportResult('❌ ' + e.message, false); }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function clearMonth() {
  if (!confirm(`Clear all transactions for ${monthLabel()}? This cannot be undone.`)) return;
  const key = storageKey(currentYear, currentMonth);
  transactions[key] = [];
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

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function closeModalOutside(e, id) { if (e.target.classList.contains('overlay')) document.getElementById(id).style.display = 'none'; }

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
      const key = storageKey(currentYear, currentMonth);
      try { transactions[key] = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { transactions[key] = []; }
      const savedBudgets = localStorage.getItem(budgetKey());
      if (savedBudgets) budgets = JSON.parse(savedBudgets);
      const savedMiles = localStorage.getItem(milesKey());
      if (savedMiles) milesConfig = Object.assign({}, milesConfig, JSON.parse(savedMiles));
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

// ─── Inline-handler compatibility shim ───────────────────────────────────────
// Phase 1 of the refactor — the 65 inline `onclick="…"` etc. attributes in
// index.html still expect these to be globals on `window`. Module scope hides
// them by default, so we re-export them here. Phase 6 will replace those
// attributes with addEventListener, and this block can then be deleted.
Object.assign(window, {
  changeMonth, clearMonth, clearOcrKeyFromUI,
  closeAddCardModal, closeAddTxn, closeAnalysisModal, closeImport,
  closeModalOutside, closeRecurringModal,
  connectSyncFromUI, deleteRecurring, deleteTxn, disconnectSyncFromUI,
  dropImportEntry, enrichTransactionsWithAI, exportData, flipCard,
  generateSpendAnalysis, handleScannedReceipt,
  manualRefreshApp, manualSync,
  onImportJsonInput, onMccInputChange, onMonthPickerChange,
  openAddCardModal, openAddTxn, openAnalysisModal, openEditTxn,
  openRecurringModal, openScanReceipt,
  openTxnsForCard, openTxnsForCategory, processImport, renderTransactions,
  saveBudgets, saveMilesSettings, saveOcrKeyFromUI, saveRecurring, saveTxn,
  showPage, submitAddCard, submitLock, togglePrivacy, validateImport,
});
