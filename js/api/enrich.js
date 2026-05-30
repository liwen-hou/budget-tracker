// Claude review pass over an existing txn list — fills missing MCCs and
// fixes obviously-wrong categories. Returns the array of patches that the
// caller is expected to apply (each patch is { id, mcc?, category? }).

const ENRICH_MODEL = 'claude-sonnet-4-6';

export async function enrichTxnsWithClaude({ apiKey, txns, categoryNames }) {
  if (!apiKey) throw new Error('No API key');
  if (!txns?.length) throw new Error('No txns');

  const catList = categoryNames.join(', ');
  // Only send fields needed for inference; keep IDs for patching.
  const payload = txns.map(t => ({
    id: t.id,
    date: t.date,
    merchant: t.merchant,
    card: t.card,
    amount: t.amount,
    category: t.category,
    mcc: t.mcc || null,
  }));

  const prompt = `You are reviewing a Singapore credit-card transaction list. Fill in missing MCCs and fix obviously-wrong categories. Be confident — most Singapore merchants are recognisable even with the noisy prefixes banks add.

STRIP MERCHANT PREFIXES before classifying. Examples of the same merchant appearing in different forms:
- "GRAB*SG_XXXXXX", "Grab Rides", "GRAB SINGAPORE", "GRAB*A1B2C3D4" → Grab Rides (taxi)
- "GRABFOOD*XYZ", "GrabFood SG", "Foodpanda *MERCHANT" → food delivery
- "POSB AUTO-PAY SINGTEL", "SINGTEL MOBILE PMT" → Singtel
- "PAYPAL*ACME", "STRIPE*ACME" → look at the merchant after the *

SG MERCHANT CHEAT SHEET (use these MCCs unless statement says otherwise):
- Grab Rides / Gojek / ComfortDelGro / TADA → 4121 → Transport
- GrabFood / Foodpanda / Deliveroo → 5814 → Food Delivery
- GrabMart / RedMart → 5411 → Groceries
- NTUC / FairPrice / Sheng Siong / Cold Storage / Giant / Don Don Donki → 5411 → Groceries
- Singtel / StarHub / M1 / Circles.Life → 4812 → Bills & Subscriptions
- SP Group / Senoko / City Energy → 4900 → Bills & Subscriptions
- Netflix / Spotify / Apple iCloud / Google One / ChatGPT / Disney+ → 5817 → Bills & Subscriptions
- SQ / Singapore Airlines / Scoot / Jetstar / AirAsia → 3000-3299 (airlines) → Travel
- Klook / Trip.com / Agoda / Booking.com / Expedia / Airbnb → 4722 → Travel
- Uniqlo / Zara / H&M / Cotton On / Charles & Keith / Pedro → 5651 / 5621 → Fashion
- Sephora / Watsons / Guardian / Sephora.sg → 5977 → Shopping & Beauty
- Shopee / Lazada / Taobao / Amazon → 5399 → varies (Shopping & Beauty / Fashion / Other based on what's typically bought)
- Apple / Best Denki / Harvey Norman → 5732 → Other
- Pure Yoga / Anytime Fitness / Ally Health / ClassPass → 7991 / 7298 → Health & Fitness
- Mount Elizabeth / Raffles Medical / Q&M / Polyclinic → 8062 / 8021 → Medical & Dental
- Restaurants, hawker stalls, bars, cafes, Starbucks, Coffee Bean → 5812 / 5814 → Dining Out
- POSB / DBS / OCBC / UOB instalments / repayments / loans → 6012 → Debt & Instalments

Rules:
1. Always fill in MCC when you're confident (the cheat sheet covers most cases). Only omit MCC when the merchant is genuinely unrecognisable.
2. If the current category is clearly wrong given the merchant (e.g. Grab Rides categorised as Food Delivery), fix it using a category from the valid list. If the existing category is plausible, leave it.
3. Use ONLY these exact category strings: ${catList}

Return ONLY a JSON array of patches — one per txn that needs updating. Each patch has the original "id" plus only the fields that should change. Example:
[{"id":"abc","mcc":"4121","category":"Transport"},{"id":"def","mcc":"5411"}]

No markdown fences, no prose, no commentary.

Transactions:
${JSON.stringify(payload, null, 2)}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      // Sonnet handles merchant-name disambiguation and SG context far
      // better than Haiku — the previous version was missing obvious
      // Grab / NTUC / Singtel cases because Haiku played it too safe.
      model: ENRICH_MODEL,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Claude API ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const body = await res.json();
  const text = (body?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let patches;
  try { patches = JSON.parse(cleaned); }
  catch (e) {
    const err = new Error('Claude returned non-JSON');
    err.body = cleaned;
    throw err;
  }
  if (!Array.isArray(patches)) {
    const err = new Error('Unexpected response shape (not an array)');
    err.body = patches;
    throw err;
  }
  return patches;
}
