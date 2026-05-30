// Duplicate detection for the import-review flow.
//
// Fingerprint = the identifying fields of a purchase event. Normalisation
// handles real-world divergences between manual entries, OCR re-scans, and
// synced data:
//   • date     → first 10 chars, so "2026-05-19T00:00:00Z" matches "2026-05-19"
//   • merchant → lowercase + collapsed whitespace + trim, so casing and
//                trailing spaces don't matter (substring differences like
//                "NTUC" vs "NTUC FAIRPRICE" intentionally still don't match —
//                fuzzy matching would produce false positives)
//   • amount   → abs + 2dp, so sign and trailing zeros don't matter
//   • card     → trimmed
// Category and MCC are deliberately excluded — they're post-hoc labels,
// not part of a purchase's identity.

export function txnFingerprint(t) {
  const date = String(t.date || '').slice(0, 10);
  const merchant = String(t.merchant || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const card = String(t.card || '').trim();
  const amt = parseFloat(t.amount);
  const amtStr = isNaN(amt) ? '' : Math.abs(amt).toFixed(2);
  return [date, merchant, card, amtStr].join('|');
}

// Walk every txns_* bucket in localStorage (not just the current month) so a
// receipt re-scanned weeks later still flags as a dup.
export function buildExistingTxnFingerprints() {
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
