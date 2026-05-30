// Add-card modal — small modal for naming a new custom card.

import { state } from '../../state.js';

let _ctx = {
  loadCustomCards: () => [],
  saveCustomCards: () => {},
  nextCustomColor: () => '#666',
  refreshCards: () => {},
  populateCardSelects: () => {},
  renderDashboard: () => {},
  toast: () => {},
};
export function setAddCardContext(ctx) { _ctx = { ..._ctx, ...ctx }; }

export function openAddCardModal() {
  document.getElementById('newCardName').value = '';
  document.getElementById('addCardErr').textContent = '';
  document.getElementById('addCardModal').style.display = 'flex';
  setTimeout(() => document.getElementById('newCardName').focus(), 40);
}

export function closeAddCardModal() { document.getElementById('addCardModal').style.display = 'none'; }

export function submitAddCard() {
  const name = document.getElementById('newCardName').value.trim();
  const errEl = document.getElementById('addCardErr');
  if (!name) { errEl.textContent = 'Card name is required'; return; }
  if (state.cards.some(c => c.toLowerCase() === name.toLowerCase())) {
    errEl.textContent = 'A card with that name already exists'; return;
  }
  const custom = _ctx.loadCustomCards();
  custom.push({ name, color: _ctx.nextCustomColor() });
  _ctx.saveCustomCards(custom);
  _ctx.refreshCards();
  _ctx.populateCardSelects();
  _ctx.renderDashboard();
  closeAddCardModal();
  _ctx.toast(`Added "${name}"`);
}
