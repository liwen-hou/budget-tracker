// Long-press drag-to-reorder + 3D flip-card behaviour for the dashboard's
// horizontal carousels. Plus the helpers that jump to Transactions with a
// pre-applied filter when a card or category tile is tapped.

import { CATEGORIES } from '../config.js';
import { loadCardOrder, saveCardOrder, loadMilesOrder, saveMilesOrder, refreshCards } from './cards.js';

let _ctx = {
  showPage: () => {},
};
export function setCarouselContext(ctx) { _ctx = { ..._ctx, ...ctx }; }

// Suppress the click that follows a long-press drag, so reordering a card
// doesn't also flip it or jump to Transactions.
let _recentlyReordered = false;

export function flipCard(el) {
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
  _ctx.showPage('transactions', navTx);
}
export function openTxnsForCard(card)    { _navToTransactionsWithFilter({ card }); }
export function openTxnsForCategory(cat) { _navToTransactionsWithFilter({ category: cat }); }

// Generic long-press drag-to-reorder for a horizontal carousel.
//   containerId:    parent <div> id
//   dragSelector:   which tiles inside are draggable
//   pinnedSelector: optional tile that stays at the tail (e.g. + Add card)
//   idAttr:         dataset key for each tile's stable id
//   commit:         called with the post-drag id list to persist
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

export function setupCardReorder() {
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

export function setupMilesReorder() {
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
