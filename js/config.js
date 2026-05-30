// Static reference data — categories, cards, MCC lookup, card bonus rules.
// Pure constants and pure functions only. No DOM, no storage, no mutable state.

export const CATEGORIES = [
  { name: "Dining Out",            emoji: "🍽️",  budget: 1100, fixed: false, color: "#f97316" }, // orange
  { name: "Food Delivery",         emoji: "🥡",  budget: 80,   fixed: false, color: "#ef4444" }, // red-orange
  { name: "Groceries",             emoji: "🛒",  budget: 300,  fixed: false, color: "#22c55e" }, // green
  { name: "Fashion",               emoji: "👗",  budget: 450,  fixed: false, color: "#ec4899" }, // pink
  { name: "Shopping & Beauty",     emoji: "💄",  budget: 200,  fixed: false, color: "#d946ef" }, // magenta
  { name: "Health & Fitness",      emoji: "🏋️",  budget: 692,  fixed: true,  color: "#14b8a6" }, // teal
  { name: "Travel",                emoji: "✈️",  budget: 833,  fixed: false, color: "#0ea5e9" }, // sky
  { name: "Entertainment",         emoji: "🎭",  budget: 100,  fixed: false, color: "#a855f7" }, // purple
  { name: "Bills & Subscriptions", emoji: "📱",  budget: 170,  fixed: true,  color: "#64748b" }, // slate
  { name: "Transport",             emoji: "🚗",  budget: 300,  fixed: false, color: "#eab308" }, // amber
  { name: "Medical & Dental",      emoji: "🏥",  budget: 100,  fixed: false, color: "#dc2626" }, // red
  { name: "Debt & Instalments",    emoji: "🏠",  budget: 1305, fixed: true,  color: "#6366f1" }, // indigo
  { name: "Other",                 emoji: "📦",  budget: 300,  fixed: false, color: "#78716c" }, // stone
];

// Old → new category remapping for users with pre-consolidation data.
export const CATEGORY_MIGRATION = {
  "Fine Dining":           "Dining Out",
  "Casual Dining":         "Dining Out",
  "Cafes & Coffee":        "Dining Out",
  "Luxury Fashion":        "Fashion",
  "Clothing & Apparel":    "Fashion",
  "Wellness (Pure Yoga)":  "Health & Fitness",
  "Fitness (Ally+Class)":  "Health & Fitness",
  "Subscriptions":         "Bills & Subscriptions",
  "Telco":                 "Bills & Subscriptions",
  "Personal Loan (Reno)":  "Debt & Instalments",
  "Instalments (IPP)":     "Debt & Instalments",
  "Lifestyle Services":    "Other",
};

export const DEFAULT_CARDS = ["DBS Vantage","HSBC Revolution","UOB Lady's","UOB KrisFlyer","Cash"];
export const DEFAULT_CARD_COLOR = {
  "DBS Vantage":     "#4f8ef7",
  "HSBC Revolution": "#ef4444",
  "UOB Lady's":      "#22c55e",
  "UOB KrisFlyer":   "#7c5cbf",
  "Cash":            "#f59e0b",
};
export const CUSTOM_CARD_PALETTE = ["#14b8a6","#ec4899","#f97316","#a855f7","#06b6d4","#84cc16","#f43f5e","#0ea5e9"];

// MCC → { friendly name, suggested category from our consolidated list }.
// Used to auto-suggest a category when the user enters an MCC.
export const MCC_LOOKUP = {
  // Food & Groceries
  "5411": { name: "Grocery Stores",            category: "Groceries" },
  "5499": { name: "Misc Food Stores",          category: "Groceries" },
  "5462": { name: "Bakeries",                  category: "Dining Out" },
  "5812": { name: "Restaurants",               category: "Dining Out" },
  "5813": { name: "Bars & Pubs",               category: "Dining Out" },
  "5814": { name: "Fast Food / Delivery",      category: "Dining Out" },
  // Shopping & Fashion
  "5311": { name: "Department Stores",         category: "Shopping & Beauty" },
  "5611": { name: "Men's Clothing",            category: "Fashion" },
  "5621": { name: "Women's Clothing",          category: "Fashion" },
  "5641": { name: "Children's Clothing",       category: "Shopping & Beauty" },
  "5651": { name: "Family Clothing",           category: "Fashion" },
  "5661": { name: "Shoe Stores",               category: "Fashion" },
  "5691": { name: "Men's & Women's Clothing",  category: "Fashion" },
  "5699": { name: "Misc Apparel",              category: "Fashion" },
  "5944": { name: "Jewelry",                   category: "Fashion" },
  "5977": { name: "Cosmetics",                 category: "Shopping & Beauty" },
  "7230": { name: "Beauty / Barber",           category: "Shopping & Beauty" },
  "5732": { name: "Electronics",               category: "Other" },
  "5942": { name: "Bookstores",                category: "Other" },
  "5912": { name: "Drug Stores / Pharmacy",    category: "Medical & Dental" },
  "5921": { name: "Liquor Stores",             category: "Other" },
  // Transport
  "4111": { name: "Bus / MRT / Transit",       category: "Transport" },
  "4121": { name: "Taxi / Limo",               category: "Transport" },
  "4789": { name: "Transportation Services",   category: "Transport" },
  "5541": { name: "Service Stations",          category: "Transport" },
  // Travel
  "4511": { name: "Airlines",                  category: "Travel" },
  "4722": { name: "Travel Agencies",           category: "Travel" },
  "7011": { name: "Hotels / Lodging",          category: "Travel" },
  "7512": { name: "Car Rental",                category: "Travel" },
  // Bills & Subscriptions
  "4814": { name: "Telco",                     category: "Bills & Subscriptions" },
  "4899": { name: "Cable / Streaming",         category: "Bills & Subscriptions" },
  "4900": { name: "Utilities",                 category: "Bills & Subscriptions" },
  // Entertainment & Wellness
  "7832": { name: "Cinemas",                   category: "Entertainment" },
  "7922": { name: "Theatrical Producers",      category: "Entertainment" },
  "7991": { name: "Tourist Attractions",       category: "Entertainment" },
  "7997": { name: "Country Clubs / Fitness",   category: "Health & Fitness" },
  "7298": { name: "Health & Beauty Spas",      category: "Health & Fitness" },
  // Medical
  "8011": { name: "Doctors",                   category: "Medical & Dental" },
  "8021": { name: "Dentists",                  category: "Medical & Dental" },
  "8041": { name: "Chiropractors",             category: "Medical & Dental" },
  "8062": { name: "Hospitals",                 category: "Medical & Dental" },
  // Financial
  "6011": { name: "ATM / Bank",                category: "Other" },
  "6012": { name: "Financial Services",        category: "Other" },
};

export function mccDisplayName(mcc) {
  return MCC_LOOKUP[mcc]?.name || '';
}

// Card Bonus Rules — used by getMissedBonus() in app.js to flag missed-bonus
// combinations. Conservative ruleset based on publicly-documented terms.
// DBS Vantage and UOB KrisFlyer aren't flagged here (Vantage earns broadly;
// KF's bonus is SQ-Group-merchant-based, not MCC).
export const CARD_BONUS_RULES = {
  "HSBC Revolution": {
    type: "excluded-list",
    // MCCs that don't earn 4 mpd and don't count toward the monthly $1k cap.
    excludedMCCs: new Set([
      "6300","6320","6381","6399",                       // Insurance
      "8211","8220","8241","8244","8249","8299",         // Education
      "9211","9222","9223","9311","9399","9402","9405",  // Government
      "8050","8062",                                     // Hospitals
      "8398",                                            // Charity
      "4900",                                            // Utilities
      "4111","4131","4112",                              // Transit (SimplyGo, bus, rail)
      "6010","6011","6012",                              // Bank / ATM
      "6051","6540",                                     // e-wallet / cash top-ups
      "4829",                                            // Wire transfer
    ]),
  },
  "UOB Lady's": {
    type: "category-bonus",
    // Bonus categories pulled live from milesConfig (fashion + dining mappings).
  },
};

// Derived from CATEGORIES — pure, so safe to export alongside the source data.
export const VALID_CATS = new Set(CATEGORIES.map(c => c.name));

// Mapping from canonical card name → CSS class on the .txn-card-badge pill.
export const CARD_CLASS = {
  "DBS Vantage":    "card-dbs",
  "HSBC Revolution":"card-hsbc",
  "UOB Lady's":     "card-uob-lady",
  "UOB KrisFlyer":  "card-uob-kf",
  "Cash":           "card-cash",
};
