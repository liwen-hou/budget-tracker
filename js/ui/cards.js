// Custom-card management — persistence of user-added cards, their order,
// the miles-tile order, plus the helpers that rebuild state.cards /
// state.cardColor / state.validCards and populate <select> elements.

import { DEFAULT_CARDS, DEFAULT_CARD_COLOR, CUSTOM_CARD_PALETTE, CARD_CLASS } from '../config.js';
import { state } from '../state.js';
import { cardsKey, cardOrderKey, milesOrderKey } from '../storage.js';
import { triggerSyncPush } from '../sync.js';

export function loadCustomCards() {
  try { return JSON.parse(localStorage.getItem(cardsKey()) || '[]'); } catch (e) { return []; }
}

export function saveCustomCards(list) {
  localStorage.setItem(cardsKey(), JSON.stringify(list));
  triggerSyncPush();
}

export function loadCardOrder() {
  try { return JSON.parse(localStorage.getItem(cardOrderKey()) || '[]'); } catch (e) { return []; }
}

export function saveCardOrder(order) {
  localStorage.setItem(cardOrderKey(), JSON.stringify(order));
  triggerSyncPush();
}

export function loadMilesOrder() {
  try { return JSON.parse(localStorage.getItem(milesOrderKey()) || '[]'); } catch (e) { return []; }
}

export function saveMilesOrder(order) {
  localStorage.setItem(milesOrderKey(), JSON.stringify(order));
  triggerSyncPush();
}

export function nextCustomColor() {
  const used = Object.values(state.cardColor);
  return CUSTOM_CARD_PALETTE.find(c => !used.includes(c)) || CUSTOM_CARD_PALETTE[0];
}

// Rebuild state.cards / state.cardColor / state.validCards from the defaults
// plus persisted customs, applying the user's saved drag order on top.
export function refreshCards() {
  const custom = loadCustomCards();
  const universe = [...DEFAULT_CARDS];
  custom.forEach(c => { if (c?.name && !universe.includes(c.name)) universe.push(c.name); });
  const saved = loadCardOrder();
  const ordered = [];
  saved.forEach(n => { if (universe.includes(n)) ordered.push(n); });
  universe.forEach(n => { if (!ordered.includes(n)) ordered.push(n); });
  state.cards = ordered;
  // Colour map: defaults are authoritative for built-in cards; custom-card
  // colours come from the saved {name, color} pair.
  state.cardColor = { ...DEFAULT_CARD_COLOR };
  custom.forEach(c => { if (c?.name && !state.cardColor[c.name]) state.cardColor[c.name] = c.color || nextCustomColor(); });
  state.validCards = new Set(state.cards);
}

// Inline-style fallback for badges of cards that don't have a preset CSS
// class (custom cards). Returns an empty string for built-in cards.
export function cardBadgeStyle(card) {
  if (CARD_CLASS[card]) return '';
  const color = state.cardColor[card] || '#7b809a';
  return `style="background: color-mix(in srgb, ${color} 18%, transparent); color: ${color};"`;
}

// Push the current state.cards list into the three <select> elements that
// reference it. Preserves the current selection when possible.
export function populateCardSelects() {
  const opts = state.cards.map(c => `<option value="${c}">${c}</option>`).join('');
  ['txnCard', 'recCard'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = opts;
    if (cur && state.cards.includes(cur)) sel.value = cur;
  });
  const fil = document.getElementById('txnCardFilter');
  if (fil) {
    const cur = fil.value;
    fil.innerHTML = '<option value="">All cards</option>' + opts;
    if (cur === '' || state.cards.includes(cur)) fil.value = cur;
  }
}
