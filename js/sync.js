// ─── Cross-Device Sync (GitHub Gist) ────────────────────────────────────────
// Push/pull an encrypted blob to a private GitHub Gist using the user's
// fine-grained PAT. The payload is encrypted client-side before it leaves the
// device so the gist holds ciphertext only. Cross-device key reconciliation
// (different salts → re-derive under remote salt + adopt) lives in
// applySyncPayload and storage.adoptRemoteEncryption.
//
// Module split note: the three orchestration handlers that re-hydrate app
// state after a sync (manualSync, connectSyncFromUI, disconnectSyncFromUI)
// stay in app.js because they mutate the in-memory transactions/budgets/
// milesConfig objects. They call into this module via the named exports.

import { b64Dec } from './crypto.js';
import {
  encryptString, decryptString, deriveMasterKey,
  loadEncMeta, adoptRemoteEncryption, currentPassphrase,
  syncConfigKey, budgetKey, milesKey, recurringKey, recurringAppliedKey,
  cardsKey, cardOrderKey, milesOrderKey, rebucketAllTransactions,
} from './storage.js';

const SYNC_FILE = 'budget-tracker.json';
const SYNC_DEBOUNCE_MS = 3000;
let syncPushTimer = null;
let syncInFlight = false;

export function loadSyncConfig() {
  try { return JSON.parse(localStorage.getItem(syncConfigKey()) || '{}'); } catch (e) { return {}; }
}
export function saveSyncConfig(cfg) { localStorage.setItem(syncConfigKey(), JSON.stringify(cfg)); }

export function syncableKeys() {
  return [budgetKey(), milesKey(), recurringKey(), recurringAppliedKey(), cardsKey(), cardOrderKey(), milesOrderKey()];
}

async function gatherSyncPayload() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (k.startsWith('txns_') || syncableKeys().includes(k)) {
      try { data[k] = JSON.parse(localStorage.getItem(k)); } catch (e) {}
    }
  }
  // S5: encrypt the data block client-side so the gist holds ciphertext only.
  // Include our salt so another device with the same passphrase can re-derive
  // the same key (salt isn't secret — it just prevents pre-computation attacks).
  const ciphertext = await encryptString(JSON.stringify(data));
  const meta = loadEncMeta();
  return {
    version: 2,
    encrypted: true,
    salt: meta?.salt || null,
    lastModified: new Date().toISOString(),
    ciphertext,
  };
}

async function applySyncPayload(env) {
  if (!env) return;
  let data;
  if (env.version === 2 && env.encrypted && env.ciphertext) {
    const localMeta = loadEncMeta();
    const sameSalt = env.salt && localMeta?.salt === env.salt;
    if (sameSalt) {
      try { data = JSON.parse(await decryptString(env.ciphertext)); }
      catch (e) { throw new Error('Could not decrypt remote payload — different passphrase?'); }
    } else if (env.salt && currentPassphrase) {
      // Cross-device: remote was encrypted under a different salt. Re-derive
      // the key with our passphrase + remote salt; if it decrypts, adopt that
      // salt locally so future writes stay consistent.
      const remoteSaltBytes = b64Dec(env.salt);
      const remoteKey = await deriveMasterKey(currentPassphrase, remoteSaltBytes);
      let ptStr;
      try { ptStr = await decryptString(env.ciphertext, remoteKey); }
      catch (e) { throw new Error('Could not decrypt remote payload — different passphrase?'); }
      data = JSON.parse(ptStr);
      await adoptRemoteEncryption(remoteSaltBytes, remoteKey);
    } else if (!env.salt) {
      // Legacy v2 envelope without salt info — best-effort with current key.
      // Only the device that pushed will be able to read this; others must wait
      // for that device to re-push with the new (salt-bearing) format.
      try { data = JSON.parse(await decryptString(env.ciphertext)); }
      catch (e) { throw new Error("Could not decrypt — re-push from the device that has your data so the gist gets salt info."); }
    } else {
      throw new Error('Could not decrypt remote payload — different passphrase?');
    }
  } else if (env.data) {
    data = env.data; // legacy v1 plaintext — accept and let next push re-encrypt
  } else {
    return;
  }
  // Replace all syncable keys with what's in the payload.
  // First, remove any local txns_*/syncable keys not present (so deletions propagate).
  const remoteKeys = new Set(Object.keys(data));
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if ((k.startsWith('txns_') || syncableKeys().includes(k)) && !remoteKeys.has(k)) toRemove.push(k);
  }
  toRemove.forEach(k => localStorage.removeItem(k));
  Object.entries(data).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
  // Re-file any rows whose date.slice(0,7) disagrees with the bucket the
  // pushing device used. Without this, mis-bucketed data from an older
  // client (or a buggy device) would re-corrupt this device on every pull.
  const { moved } = rebucketAllTransactions();
  if (moved > 0) console.log(`sync apply: re-bucketed ${moved} transaction(s) by date`);
}

async function gistApi(method, path, body) {
  const cfg = loadSyncConfig();
  if (!cfg.pat) throw new Error('Not connected — no PAT');
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${cfg.pat}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function syncConnect(pat) {
  if (!pat || !pat.trim()) throw new Error('PAT required');
  // Validate and create a private gist with current data
  saveSyncConfig({ pat: pat.trim() });
  const payload = await gatherSyncPayload();
  const gist = await gistApi('POST', '/gists', {
    description: 'Encrypted data',
    public: false,
    files: { [SYNC_FILE]: { content: JSON.stringify(payload, null, 2) } },
  });
  saveSyncConfig({ pat: pat.trim(), gistId: gist.id, lastSyncedAt: new Date().toISOString() });
  return gist.id;
}

export async function syncDisconnect() {
  saveSyncConfig({});
}

export async function syncPull() {
  const cfg = loadSyncConfig();
  if (!cfg.pat || !cfg.gistId) return { skipped: true };
  const gist = await gistApi('GET', `/gists/${cfg.gistId}`);
  const file = gist.files?.[SYNC_FILE];
  if (!file?.content) return { skipped: true, reason: 'no file' };
  let env;
  try { env = JSON.parse(file.content); } catch (e) { throw new Error('Remote payload is not JSON'); }
  const remoteTime = new Date(env.lastModified || 0).getTime();
  const localSynced = new Date(cfg.lastSyncedAt || 0).getTime();
  // Pull if remote is newer than what we last saw, OR we've never synced
  if (remoteTime > localSynced || !cfg.lastSyncedAt) {
    await applySyncPayload(env);
    saveSyncConfig({ ...cfg, lastSyncedAt: env.lastModified });
    return { pulled: true, remoteTime: env.lastModified };
  }
  return { pulled: false, reason: 'local is up-to-date' };
}

export async function syncPush() {
  const cfg = loadSyncConfig();
  if (!cfg.pat || !cfg.gistId) return { skipped: true };
  const payload = await gatherSyncPayload();
  await gistApi('PATCH', `/gists/${cfg.gistId}`, {
    files: { [SYNC_FILE]: { content: JSON.stringify(payload, null, 2) } },
  });
  saveSyncConfig({ ...cfg, lastSyncedAt: payload.lastModified });
  return { pushed: true };
}

export function triggerSyncPush() {
  const cfg = loadSyncConfig();
  if (!cfg.pat || !cfg.gistId) return;
  if (syncPushTimer) clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(async () => {
    syncPushTimer = null;
    if (syncInFlight) return;
    syncInFlight = true;
    try {
      await syncPush();
      renderSyncPanel();
    } catch (e) {
      console.warn('Sync push failed', e);
      renderSyncPanel(e.message);
    } finally {
      syncInFlight = false;
    }
  }, SYNC_DEBOUNCE_MS);
}

export function renderSyncPanel(errorMsg) {
  const el = document.getElementById('syncPanel');
  if (!el) return;
  const cfg = loadSyncConfig();
  if (!cfg.pat || !cfg.gistId) {
    el.innerHTML = `
      <div class="form-row">
        <label>GitHub Personal Access Token (fine-grained, Gists scope)</label>
        <input type="password" id="syncPatInput" placeholder="github_pat_..." autocomplete="off">
      </div>
      <div class="form-row">
        <label>Existing gist ID <span style="color:var(--small);font-weight:400;">— leave blank to create a new gist</span></label>
        <input type="text" id="syncGistIdInput" placeholder="paste gist ID to reconnect" autocomplete="off" autocapitalize="off" spellcheck="false">
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <button class="btn" data-act="connect-sync">Connect</button>
        <span id="syncStatus" style="font-size:12px;color:${errorMsg ? 'var(--red)' : 'var(--muted)'};">${errorMsg || ''}</span>
      </div>
    `;
    return;
  }
  const last = cfg.lastSyncedAt ? new Date(cfg.lastSyncedAt).toLocaleString('en-SG') : 'never';
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <div style="font-size:13px;">
        <div>Connected · gist <code style="font-size:11px;">${cfg.gistId.slice(0,7)}</code></div>
        <div id="syncStatus" style="font-size:11px;color:${errorMsg ? 'var(--red)' : 'var(--muted)'};margin-top:2px;">${errorMsg ? '⚠️ ' + errorMsg : 'Last sync: ' + last}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" data-act="manual-sync">Sync now</button>
        <button class="btn btn-outline" data-act="disconnect-sync">Disconnect</button>
      </div>
    </div>
  `;
}
