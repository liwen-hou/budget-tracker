// Lock-overlay UI. Owns showing/hiding the passphrase prompt and the
// submit handler that runs the unlock/setup flow.

import {
  loadEncMeta, setupPassphrase, unlockWithPassphrase,
  installStorageOverride, decryptAllToCache,
} from '../storage.js';

let _onUnlock = () => {};
export function setLockContext({ onUnlock }) { _onUnlock = onUnlock; }

export function showLockOverlay({ setup }) {
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

export function hideLockOverlay() {
  document.getElementById('lockOverlay').classList.remove('show');
  document.getElementById('lockPass1').value = '';
  document.getElementById('lockPass2').value = '';
}

export async function submitLock() {
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
    await _onUnlock();
  } catch (e) {
    console.error(e);
    errEl.textContent = e.message || 'Something went wrong.';
  } finally {
    btn.disabled = false;
  }
}
