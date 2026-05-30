// Miles-related domain helpers.
//
// Currently just the year-to-date UOB KrisFlyer total, which is used by the
// dashboard card carousel to show progress against the annual SIA Group
// minimum spend. Walks localStorage directly rather than the in-memory
// transactions cache because it spans 12 months, not just the visible one.

export function getKrisFlyerYTD(year = new Date().getFullYear()) {
  let total = 0;
  for (let m = 0; m < 12; m++) {
    const key = `txns_${year}_${String(m + 1).padStart(2, '0')}`;
    const raw = localStorage.getItem(key);
    if (raw) JSON.parse(raw).forEach(t => { if (t.card === 'UOB KrisFlyer') total += t.amount; });
  }
  return total;
}
