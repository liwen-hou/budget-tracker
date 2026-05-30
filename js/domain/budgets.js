// Budget-related domain calculations.
//
// All functions take their state as parameters — no module-scoped mutables,
// no DOM reads. The UI layer (renderDashboard, generateSpendAnalysis) is
// responsible for gathering the current state and passing it in.

import { CATEGORIES } from '../config.js';
import { fmt } from '../utils.js';
import { storageKey } from '../storage.js';

// Read the previous month's transactions (one month before `{year, month}`,
// rolling over the year boundary) and roll them up by category for the
// month-over-month delta badges on the dashboard.
export function previousMonthData({ year, month }) {
  let y = year, m = month - 1;
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

// MoM delta badge for a single category (or overall total).
// Returns an inline HTML span — the only function in here that emits HTML.
export function deltaBadge(curr, prev) {
  if (prev === 0 && curr === 0) return '';
  if (prev === 0) return `<span class="mom-badge mom-up">▲ new</span>`;
  const delta = curr - prev;
  if (Math.abs(delta) < 0.01) return `<span class="mom-badge mom-flat">▬ flat</span>`;
  const pctChange = (delta / prev) * 100;
  const up = delta > 0;
  return `<span class="mom-badge ${up ? 'mom-up' : 'mom-down'}">${up ? '▲' : '▼'} ${up ? '+' : '−'}$${fmt(Math.abs(delta))} (${Math.abs(pctChange).toFixed(0)}%)</span>`;
}

// One-shot "current month at a glance" object — fed to the AI spend-analysis
// prompt and (later, possibly) to weekly summaries. Pure; takes everything it
// needs as input.
export function buildSpendOverview({ year, month, txns, budgets, milesConfig, cards }) {
  const totalSpent = txns.reduce((s, t) => s + t.amount, 0);
  const totalBudget = Object.values(budgets).reduce((s, v) => s + (v || 0), 0);
  const days = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const dayOfMonth = (today.getFullYear() === year && today.getMonth() === month)
    ? today.getDate() : days;
  const dailyAvg = dayOfMonth > 0 ? totalSpent / dayOfMonth : 0;
  const projected = dailyAvg * days;

  const perCategory = CATEGORIES.map(c => {
    const spent = txns.filter(t => t.category === c.name).reduce((s, t) => s + t.amount, 0);
    const bud = budgets[c.name] ?? c.budget;
    return { category: c.name, spent: +spent.toFixed(2), budget: +bud, fixed: !!c.fixed };
  }).filter(c => c.spent > 0 || c.budget > 0);

  const perCard = cards.map(card => {
    const cardTxns = txns.filter(t => t.card === card);
    return {
      card,
      spent: +cardTxns.reduce((s, t) => s + t.amount, 0).toFixed(2),
      txns: cardTxns.length,
    };
  }).filter(c => c.txns > 0);

  const prev = previousMonthData({ year, month });

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
    month: new Date(year, month, 1).toLocaleString('en-SG', { month: 'long', year: 'numeric' }),
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
