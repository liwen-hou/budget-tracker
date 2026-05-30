// Pure formatting / escaping helpers. No DOM, no storage, no state.

// SGD-style number with two fixed decimal places. fmt(null) → "0.00".
export function fmt(n) {
  return (n || 0).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "YYYY-MM-DD" → short locale date like "20 May"; falsy → em-dash.
export function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-SG', { day: '2-digit', month: 'short' });
}

// Minimal HTML escaping for safe interpolation into template strings.
export function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
