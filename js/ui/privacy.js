// Privacy mode — blur sensitive numbers behind a CSS filter. The pref lives
// in unencrypted localStorage (it's a UI preference, not data) so we use the
// origGetItem/origSetItem references that bypass the encryption override.

import { origGetItem, origSetItem, PRIVACY_PREF_KEY } from '../storage.js';
import { toast } from './toast.js';

export function loadPrivacyPref() {
  return origGetItem.call(localStorage, PRIVACY_PREF_KEY) === '1';
}

export function savePrivacyPref(on) {
  origSetItem.call(localStorage, PRIVACY_PREF_KEY, on ? '1' : '0');
}

export function applyPrivacyPref() {
  const on = loadPrivacyPref();
  document.body.classList.toggle('privacy-on', on);
  const btn = document.getElementById('privacyBtn');
  if (btn) {
    btn.textContent = on ? '🙈' : '👁️';
    btn.classList.toggle('active', on);
    btn.title = on ? 'Privacy mode ON — tap to reveal amounts' : 'Privacy mode — blur all amounts';
  }
}

export function togglePrivacy() {
  const next = !loadPrivacyPref();
  savePrivacyPref(next);
  applyPrivacyPref();
  toast(next ? '🙈 Amounts blurred' : '👁️ Amounts visible');
}

// Auto-blur when the tab loses focus (over-the-shoulder protection).
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('tab-hidden', document.hidden);
});
