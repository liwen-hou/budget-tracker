// Shared mutable runtime state. One object, imported by every module that
// needs to read or write the in-memory view of the user's data.
//
// Writes go through direct property assignment (e.g. state.currentYear = y,
// state.transactions[key] = list). No reactive/observer machinery — re-render
// is still explicit via renderAll() / renderDashboard() / etc.
//
// The default values here are placeholders; bootApp() in app.js overwrites
// them from storage after unlock. cards/cardColor/validCards start with the
// defaults so the boot path can read them before refreshCards() runs.

import { DEFAULT_CARDS, DEFAULT_CARD_COLOR } from './config.js';

export const state = {
  // Month being viewed
  currentYear: undefined,
  currentMonth: undefined,

  // Transactions, keyed by `txns_YYYY_MM`
  transactions: {},

  // Budget caps, keyed by category name
  budgets: {},

  // Miles-card thresholds + category mappings.
  // Defaults match what the app shipped with; loadData() merges saved values
  // on top after unlock.
  milesConfig: {
    hsbc: 1000,
    uobLadyFashion: 750,
    uobLadyDining: 750,
    kfAnnual: 1000,
    fashionCats: ['Fashion'],
    diningCats: ['Dining Out'],
  },

  // Card list — defaults + user-added customs. Reassigned by refreshCards().
  cards: [...DEFAULT_CARDS],
  cardColor: { ...DEFAULT_CARD_COLOR },
  validCards: new Set(DEFAULT_CARDS),
};
