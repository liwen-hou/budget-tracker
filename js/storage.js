// ─── Storage layer ─────────────────────────────────────────────────────────
// Owns: localStorage key naming + encryption-at-rest (AES-GCM, PBKDF2-SHA256)
// + the Storage.prototype override that makes encryption transparent to callers
// + the in-memory plaintext cache + the pending-writes Map for async durability.
//
// Phase-3 extraction note: the AES-GCM Storage.prototype override and the
// pending-writes Map were moved as a single chunk with no internal refactor.
// Callers see "localStorage works as normal" but reads return decrypted JSON
// strings and writes encrypt + persist asynchronously. Privacy-related reads
// that must bypass the override use the exported orig* references.

import { b64Enc, b64Dec } from './crypto.js';

// ─── Storage key naming ──────────────────────────────────────────────────────
// One source of truth for localStorage key conventions. Everything that reads
// or writes to localStorage goes through these helpers so a key rename is
// a single-file change.
export function storageKey(y, m) { return `txns_${y}_${String(m + 1).padStart(2, '0')}`; }
export function budgetKey()           { return 'budgets_liwen'; }
export function milesKey()            { return 'miles_config_liwen'; }
export function recurringKey()        { return 'recurring_liwen'; }
export function recurringAppliedKey() { return 'recurring_applied_liwen'; }
export function syncConfigKey()       { return 'sync_config_liwen'; }
export function ocrConfigKey()        { return 'ocr_config_liwen'; }
export function cardsKey()            { return 'cards_liwen'; }
export function cardOrderKey()        { return 'card_order_liwen'; }
export function milesOrderKey()       { return 'miles_order_liwen'; }
export function monthKeyOf(y, m)      { return `${y}_${String(m + 1).padStart(2, '0')}`; }

// Derive the bucket key (`txns_YYYY_MM`) from a transaction's date field.
// Accepts "YYYY-MM-DD" and "YYYY-MM-DD…" (e.g. ISO timestamps). Returns null
// if the date is missing or malformed — callers decide the fallback policy.
export function bucketKeyFromDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = dateStr.slice(0, 7).match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  if (y < 1900 || y > 9999 || mo < 1 || mo > 12) return null;
  return `txns_${m[1]}_${m[2]}`;
}

// Sweep every txns_* bucket and re-file any rows whose date.slice(0,7)
// doesn't match the bucket they're in. Uses the regular getItem/setItem so
// the encryption layer round-trips correctly. Returns { moved, scanned }.
// Called from:
//   1. loadData() once at app boot, gated by the BUCKETING_MIGRATION_V1 flag
//   2. applySyncPayload() after every gist pull, so mis-bucketed data from
//      another device (or an older client) gets corrected on receive
export function rebucketAllTransactions() {
  const txnKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('txns_')) txnKeys.push(k);
  }
  let moved = 0, scanned = 0;
  txnKeys.forEach(key => {
    let bucket;
    try { bucket = JSON.parse(localStorage.getItem(key) || '[]'); } catch { return; }
    if (!Array.isArray(bucket)) return;
    scanned += bucket.length;
    const keep = [];
    bucket.forEach(t => {
      const correctKey = bucketKeyFromDate(t.date);
      if (!correctKey || correctKey === key) {
        keep.push(t);
        return;
      }
      let target;
      try { target = JSON.parse(localStorage.getItem(correctKey) || '[]'); } catch { target = []; }
      target.push(t);
      localStorage.setItem(correctKey, JSON.stringify(target));
      moved++;
    });
    if (keep.length < bucket.length) {
      localStorage.setItem(key, JSON.stringify(keep));
    }
  });
  return { moved, scanned };
}

export const BUCKETING_MIGRATION_V1 = 'bucketing_migration_v1_done';

// ─── Encryption-at-rest (S5/S6) ──────────────────────────────────────────────
// AES-GCM with a key derived (PBKDF2/SHA-256, 250k iters) from a user passphrase.
// All transaction + config + credential keys are stored encrypted in localStorage,
// and the gist sync payload is encrypted before it leaves the device.
export const ENC_META_KEY         = 'enc_meta_liwen';
export const ENC_SESSION_KEY      = 'enc_session_key_liwen';
export const ENC_SESSION_PASS_KEY = 'enc_session_pass_liwen';
export const PRIVACY_PREF_KEY     = 'privacy_pref_liwen';
const ENC_VERIFIER_PT = 'budget-tracker:ok:v1';
const ENC_PREFIX      = 'enc:v1:';
const KDF_ITERATIONS  = 250000;

// Originals captured before the override is installed. Exported so the
// privacy module (and any other read-before-unlock path) can bypass the
// encryption layer for keys we explicitly choose not to encrypt.
export const origGetItem    = Storage.prototype.getItem;
export const origSetItem    = Storage.prototype.setItem;
export const origRemoveItem = Storage.prototype.removeItem;

export let masterKey = null;             // CryptoKey (AES-GCM)
export let currentPassphrase = null;     // kept in memory after unlock; needed to re-derive
                                         // the key when a remote gist uses a different salt

let plaintextCache = {};                 // key → parsed JSON (or raw string)
let cacheLoaded = false;
const pendingWrites = new Map();         // key → Promise (in-flight encrypt+persist)

async function deriveMasterKey(passphrase, saltBytes) {
  const km = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    km,
    { name: 'AES-GCM', length: 256 },
    true, // extractable — so we can stash the raw key in sessionStorage for reload survival
    ['encrypt', 'decrypt']
  );
}
export { deriveMasterKey };

export async function encryptString(plaintext, key = masterKey) {
  if (!key) throw new Error('encryptString: no master key');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
  );
  return ENC_PREFIX + b64Enc(iv) + ':' + b64Enc(new Uint8Array(ct));
}

export async function decryptString(envelope, key = masterKey) {
  if (!key) throw new Error('decryptString: no master key');
  if (!envelope.startsWith(ENC_PREFIX)) throw new Error('decryptString: not encrypted');
  const parts = envelope.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 2) throw new Error('decryptString: bad envelope');
  const iv = b64Dec(parts[0]);
  const ct = b64Dec(parts[1]);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export function loadEncMeta() {
  try { const raw = origGetItem.call(localStorage, ENC_META_KEY); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
function saveEncMeta(meta) {
  origSetItem.call(localStorage, ENC_META_KEY, JSON.stringify(meta));
}

function shouldEncryptKey(k) {
  if (!k) return false;
  if (k.startsWith('txns_')) return true;
  return k === budgetKey() || k === milesKey() || k === recurringKey() ||
         k === recurringAppliedKey() || k === syncConfigKey() || k === ocrConfigKey() ||
         k === cardsKey() || k === cardOrderKey() || k === milesOrderKey();
}

export function installStorageOverride() {
  // iOS Safari quirk: `localStorage.getItem = fn` is interpreted as
  // `setItem('getItem', String(fn))` — it stores the function source as a
  // storage entry instead of installing an instance property, so the override
  // never actually runs and the app gets back raw ciphertext. Patch the
  // prototype instead; that path doesn't go through Storage's setItem.
  // First, sweep up any polluted entries from a previous buggy install.
  ['getItem', 'setItem', 'removeItem'].forEach(name => {
    try { origRemoveItem.call(localStorage, name); } catch (e) {}
  });

  Storage.prototype.getItem = function(k) {
    if (this === localStorage && shouldEncryptKey(k)) {
      if (!cacheLoaded || !(k in plaintextCache)) return null;
      const v = plaintextCache[k];
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    return origGetItem.call(this, k);
  };
  Storage.prototype.setItem = function(k, v) {
    if (this === localStorage && shouldEncryptKey(k)) {
      try { plaintextCache[k] = JSON.parse(v); } catch (e) { plaintextCache[k] = v; }
      const p = encryptString(v).then(env => {
        origSetItem.call(localStorage, k, env);
      }).catch(e => { console.error('Encrypted write failed', k, e); })
        .finally(() => { if (pendingWrites.get(k) === p) pendingWrites.delete(k); });
      pendingWrites.set(k, p);
      return;
    }
    return origSetItem.call(this, k, v);
  };
  Storage.prototype.removeItem = function(k) {
    if (this === localStorage && shouldEncryptKey(k)) delete plaintextCache[k];
    return origRemoveItem.call(this, k);
  };
}

// Block until every encrypt+persist promise the override scheduled has landed
// in real localStorage. Call before any reload, navigation, or "we're safe to
// refresh now" checkpoint — otherwise iOS Safari can tear down the page while
// the async writes are still pending and lose data.
export async function flushPendingWrites() {
  while (pendingWrites.size > 0) {
    await Promise.all([...pendingWrites.values()]);
  }
}

export async function decryptAllToCache() {
  plaintextCache = {};
  // Snapshot keys first — we'll be re-writing during migration.
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (shouldEncryptKey(k)) keys.push(k);
  }
  for (const k of keys) {
    const raw = origGetItem.call(localStorage, k);
    if (raw == null) continue;
    if (raw.startsWith(ENC_PREFIX)) {
      try {
        const pt = await decryptString(raw);
        plaintextCache[k] = JSON.parse(pt);
      } catch (e) { console.error('Decrypt failed for', k, e); }
    } else {
      // Legacy plaintext — migrate to ciphertext.
      try { plaintextCache[k] = JSON.parse(raw); }
      catch (e) { plaintextCache[k] = raw; }
      try {
        const env = await encryptString(
          typeof plaintextCache[k] === 'string' ? plaintextCache[k] : JSON.stringify(plaintextCache[k])
        );
        origSetItem.call(localStorage, k, env);
      } catch (e) { console.error('Migration encrypt failed', k, e); }
    }
  }
  cacheLoaded = true;
}

async function stashSessionKey(key, passphrase) {
  const raw = await crypto.subtle.exportKey('raw', key);
  sessionStorage.setItem(ENC_SESSION_KEY, b64Enc(new Uint8Array(raw)));
  if (passphrase != null) {
    sessionStorage.setItem(ENC_SESSION_PASS_KEY, btoa(unescape(encodeURIComponent(passphrase))));
  }
}
export async function restoreSessionKey() {
  const raw = sessionStorage.getItem(ENC_SESSION_KEY);
  const rawPass = sessionStorage.getItem(ENC_SESSION_PASS_KEY);
  // Require both — if the session lacks the passphrase, force re-unlock so
  // we can handle cross-device salt mismatches via re-derivation.
  if (!raw || !rawPass) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', b64Dec(raw), 'AES-GCM', true, ['encrypt', 'decrypt']
    );
    try { currentPassphrase = decodeURIComponent(escape(atob(rawPass))); } catch (e) {}
    return key;
  } catch (e) { return null; }
}

// Setter exported so app.js can install the key after restoreSessionKey returns one.
export function setMasterKey(key) { masterKey = key; }

export async function setupPassphrase(passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveMasterKey(passphrase, salt);
  masterKey = key;
  currentPassphrase = passphrase;
  const verifier = await encryptString(ENC_VERIFIER_PT, key);
  saveEncMeta({ version: 1, salt: b64Enc(salt), verifier, kdf: 'PBKDF2-SHA256', iter: KDF_ITERATIONS });
  await stashSessionKey(key, passphrase);
}

export async function unlockWithPassphrase(passphrase) {
  const meta = loadEncMeta();
  if (!meta) throw new Error('No encryption set up');
  const salt = b64Dec(meta.salt);
  const key = await deriveMasterKey(passphrase, salt);
  let pt;
  try { pt = await decryptString(meta.verifier, key); }
  catch (e) { throw new Error('Wrong passphrase'); }
  if (pt !== ENC_VERIFIER_PT) throw new Error('Wrong passphrase');
  masterKey = key;
  currentPassphrase = passphrase;
  await stashSessionKey(key, passphrase);
}

// Re-encrypt local state under a key derived from the REMOTE salt. Called when
// a v2 gist payload was encrypted by another device whose salt differs from
// ours. After this, both devices are aligned on the same salt+key.
export async function adoptRemoteEncryption(saltBytes, key) {
  await flushPendingWrites();              // any in-flight writes still use the old key
  masterKey = key;
  const verifier = await encryptString(ENC_VERIFIER_PT, key);
  saveEncMeta({ version: 1, salt: b64Enc(saltBytes), verifier, kdf: 'PBKDF2-SHA256', iter: KDF_ITERATIONS });
  if (currentPassphrase) await stashSessionKey(key, currentPassphrase);
  // Re-encrypt every cached entry so post-reload decrypts succeed.
  for (const k of Object.keys(plaintextCache)) {
    const v = plaintextCache[k];
    const env = await encryptString(typeof v === 'string' ? v : JSON.stringify(v), key);
    origSetItem.call(localStorage, k, env);
  }
}
