// Dashboard page render — the hero ring, two chip stats, card carousel
// (with flip-faces for miles), and the per-category budget bars.
//
// cardData and renderMilesRow used to be standalone helpers; they're scoped
// here because they're only called from renderDashboard's card-tile loop.

import { CATEGORIES, CARD_CLASS } from '../../config.js';
import { fmt, escHtml } from '../../utils.js';
import { state } from '../../state.js';
import { previousMonthData, deltaBadge } from '../../domain/budgets.js';
import { getKrisFlyerYTD } from '../../domain/miles.js';
import { cardBadgeStyle } from '../cards.js';

let _ctx = {
  currentTxns: () => [],
  syncMonthPicker: () => {},
};
export function setDashboardContext(ctx) { _ctx = { ..._ctx, ...ctx }; }

// One card's data summary — overall total + any miles caps that apply.
// Powers the dashboard card carousel (tiles flip to show rules on back).
function cardData(card, txns, cardTotals) {
  const cardTxns = txns.filter(t => t.card === card);
  const total = (cardTotals && cardTotals[card]) || 0;
  const miles = [];

  if (card === 'HSBC Revolution') {
    miles.push({
      label: 'Monthly bonus cap',
      shortLabel: 'Monthly cap',
      spent: total,
      cap: state.milesConfig.hsbc,
      rate: '4 mpd',
      note: 'Counts contactless + online spend (dining, shopping, transport, subscriptions). Excludes SimplyGo, fast-food delivery, and OTAs.',
    });
  } else if (card === "UOB Lady's") {
    const fashionSet = new Set(state.milesConfig.fashionCats || []);
    const diningSet  = new Set(state.milesConfig.diningCats || []);
    const fashionSpent = cardTxns.filter(t => fashionSet.has(t.category)).reduce((s, t) => s + t.amount, 0);
    const diningSpent  = cardTxns.filter(t => diningSet.has(t.category)).reduce((s, t) => s + t.amount, 0);
    miles.push({
      label: 'Fashion bonus',
      shortLabel: 'Fashion',
      spent: fashionSpent,
      cap: state.milesConfig.uobLadyFashion,
      rate: '4 mpd',
      note: "Counts UOB Lady's spend in: " + (state.milesConfig.fashionCats || []).join(', '),
    });
    miles.push({
      label: 'Dining bonus',
      shortLabel: 'Dining',
      spent: diningSpent,
      cap: state.milesConfig.uobLadyDining,
      rate: '4 mpd',
      note: "Counts UOB Lady's spend in: " + (state.milesConfig.diningCats || []).join(', '),
    });
  } else if (card === 'UOB KrisFlyer') {
    const ytd = getKrisFlyerYTD();
    miles.push({
      label: 'Annual SIA Group min',
      shortLabel: 'Annual SIA',
      spent: ytd,
      cap: state.milesConfig.kfAnnual,
      rate: '3 mpd on SQ/Scoot',
      note: 'Tracks all UOB KrisFlyer card spend Jan–Dec. Must hit $' + fmt(state.milesConfig.kfAnnual) + '/year to unlock the 2.4 mpd bonus tier on other spend.',
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
      <div class="card-miles-track"><div class="card-miles-bar ${barClass}" style="width:${(pct * 100).toFixed(1)}%"></div></div>
    </div>
  `;
}

export function renderDashboard() {
  _ctx.syncMonthPicker();
  const txns = _ctx.currentTxns();
  const totalSpent = txns.reduce((s, t) => s + t.amount, 0);
  const totalBudget = Object.values(state.budgets).reduce((s, v) => s + v, 0);
  const pct = totalBudget > 0 ? totalSpent / totalBudget : 0;

  const prev = previousMonthData({ year: state.currentYear, month: state.currentMonth });

  const days = new Date(state.currentYear, state.currentMonth + 1, 0).getDate();
  const today = new Date();
  const dayOfMonth = (today.getFullYear() === state.currentYear && today.getMonth() === state.currentMonth)
    ? today.getDate() : days;
  const dailyAvg = dayOfMonth > 0 ? totalSpent / dayOfMonth : 0;
  const projected = dailyAvg * days;

  // Vibe — based on projected pace (more honest than raw spent so far)
  const pace = totalBudget > 0 ? projected / totalBudget : 0;
  const vibe = pace < 0.85 ? { emoji: '😎', cls: 'vibe-good',   verdict: 'Well under', ring: 'good' }
            : pace < 1.0  ? { emoji: '🙂', cls: 'vibe-fine',   verdict: 'On pace',    ring: 'good' }
            : pace < 1.15 ? { emoji: '😬', cls: 'vibe-tight',  verdict: 'Tight',      ring: 'warn' }
            :               { emoji: '🔥', cls: 'vibe-danger', verdict: 'Over',       ring: 'over' };

  const spentArc = Math.max(0, Math.min(100, pct * 100));
  const dayArc   = days > 0 ? (dayOfMonth / days) * 100 : 0;

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
      <div class="hero-pct">${(pct * 100).toFixed(0)}% used${prev.hasData ? ` · ${deltaBadge(totalSpent, prev.total)} vs ${prev.label}` : ''}</div>
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

  // Card breakdown carousel
  const cardTotals = {};
  state.cards.forEach(c => cardTotals[c] = 0);
  txns.forEach(t => { if (cardTotals[t.card] !== undefined) cardTotals[t.card] += t.amount; });
  const cardsHtml = state.cards.map(card => {
    const data = cardData(card, txns, cardTotals);
    const colorVar = `--card-color: ${state.cardColor[card] || 'var(--border)'};`;
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
      <div style="font-size:11px;color:var(--muted);margin-top:2px;">${data.txnCount} txn${data.txnCount === 1 ? '' : 's'}</div>
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

  // Budget bars
  const spentByCategory = {};
  CATEGORIES.forEach(c => spentByCategory[c.name] = 0);
  txns.forEach(t => { if (spentByCategory[t.category] !== undefined) spentByCategory[t.category] += t.amount; });

  document.getElementById('budgetGrid').innerHTML = CATEGORIES.map(cat => {
    const spent = spentByCategory[cat.name] || 0;
    const bud   = state.budgets[cat.name] || cat.budget;
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
        <div class="progress-track"><div class="progress-bar ${barClass}" style="width:${(pct * 100).toFixed(1)}%"></div></div>
        <div class="budget-footer">
          <span>${(pct * 100).toFixed(0)}% used</span>
          <span>${over ? '⚠️ $' + fmt(spent - bud) + ' over' : '$' + fmt(bud - spent) + ' left'}</span>
        </div>
        ${prev.hasData ? `<div class="budget-mom">${deltaBadge(spent, prev.byCategory[cat.name] || 0)} <span style="color:var(--small);">vs ${prev.label} ($${fmt(prev.byCategory[cat.name] || 0)})</span></div>` : ''}
      </div>
    `;
  }).join('');
}
