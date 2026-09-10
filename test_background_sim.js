#!/usr/bin/env node
/*
 * arb_sim.js — Node VM harness that drives the REAL background.js analyze
 * orchestration with stubbed chrome.* APIs. Validates the premature-close /
 * pagination / fallback-query fixes end-to-end without a browser.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const DIR = '/home/infiniti/Projects/scraper/arbitrage-scout';
const src = (f) => fs.readFileSync(`${DIR}/${f}`, 'utf8');

/* ---------------- chrome stubs ---------------- */
const calls = { tabsCreated: [], tabsUpdated: [], tabsRemoved: [], alarms: [] };
let nextTabId = 100;
const tabs = new Map();
const mkTab = (url) => { const t = { id: ++nextTabId, url, windowId: 7 }; tabs.set(t.id, t); return t; };
const chrome = {
  runtime: {
    id: 'sim',
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    sendMessage: async (m) => { void m; },
  },
  storage: {
    session: {
      data: {},
      async get(k) { return this.data[k] !== undefined ? { [k]: this.data[k] } : {}; },
      async set(o) { Object.assign(this.data, o); },
      async remove(k) { delete this.data[k]; },
    },
    local: {
      data: {},
      async get(k) { return this.data[k] !== undefined ? { [k]: this.data[k] } : {}; },
      async set(o) { Object.assign(this.data, o); },
    },
  },
  alarms: {
    onAlarm: { addListener() {} },
    create(name, info) { calls.alarms.push(name); },
    clear(name) { const i = calls.alarms.indexOf(name); if (i >= 0) calls.alarms.splice(i, 1); },
  },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    async create(o) { const t = mkTab(o.url); calls.tabsCreated.push(t.id); return t; },
    async update(id, o) { const t = tabs.get(id); if (!t) throw new Error('no tab ' + id); if (o.url) t.url = o.url; calls.tabsUpdated.push({ id, url: t.url }); return t; },
    async get(id) { const t = tabs.get(id); if (!t) throw new Error('no tab ' + id); return t; },
    async remove(id) { if (!tabs.delete(id)) throw new Error('no tab ' + id); calls.tabsRemoved.push(id); },
    async sendMessage() { throw new Error('no receiver'); },
  },
  scripting: { executeScript: async () => {} },
  windows: { update: async () => {}, getLastFocused: async () => ({ id: 7 }) },
};

/* ---------------- sandbox ---------------- */
const sandbox = {
  chrome, console, setTimeout, clearTimeout, setInterval, clearInterval,
  URL, URLSearchParams, TextDecoder, TextEncoder,
  importScripts: () => {},
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['cleanup.js', 'ebay2amazon.js', 'profit.js', 'safety.js']) {
  vm.runInContext(src(f), sandbox, { filename: f });
}
// background.js is 'use strict' — append an export shim to reach its internals.
const shim = `
;globalThis.__api = {
  handleMessage,
  getCache: () => analyzeCache,
  getDebugRing: () => dbgRing.slice(),
  clearDebugRing: () => { dbgRing.length = 0; },
  constants: { ITEM_STAGE_TIMEOUT_MS, ANALYZE_MAX_AMAZON_ITEMS, DEFAULT_ANALYZE_PAGES_PER_SITE,
               ANALYZE_FALLBACK_QUERIES_MAX, AMAZON_ABSOLUTE_MAX_PAGES },
};`;
vm.runInContext(src('background.js') + shim, sandbox, { filename: 'background.js' });
const api = sandbox.__api;

/* ---------------- driver helpers ---------------- */
const EBAY_ITEM = {
  title: 'Sony WH-1000XM4 Wireless Noise Canceling Overhead Headphones Black',
  price: 199.99, shipping: 0, condition: 'Open Box', itemId: '295123456789',
  specifics: { brand: 'Sony', model: 'WH-1000XM4', type: 'Headphones' },
};
const amzItem = (n, title) => {
  const asin = `B000000000${n}`;
  return {
    id: asin, asin,
    title: title || 'Sony WH-1000XM4 Wireless Noise Canceling Overhead Headphones',
    price: 220 + n, isPrime: true, rating: 4.5, reviews: 1200 + n,
    // Real content.js always emits the canonical /dp/ URL (content.js:1014);
    // the matcher carries it through and the popup card links to it.
    url: `https://www.amazon.com/dp/${asin}`,
  };
};
const assert = (cond, msg) => { if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; } else console.log('  ✓', msg); };
const lastUpdate = () => calls.tabsUpdated[calls.tabsUpdated.length - 1];
const snap = () => { const c = api.getCache(); return { phase: c.phase, err: c.error && c.error.code, amz: c.stages.amazon, res: c.amazonResults, match: c.match }; };

async function startRun(settings, itemOverride) {
  calls.tabsUpdated.length = 0; calls.tabsRemoved.length = 0;
  await api.handleMessage({ type: 'ARB_ANALYZE', url: 'https://www.ebay.com/itm/295123456789', settings }, {});
  const c = api.getCache();
  await api.handleMessage({ type: 'ARB_ITEM_DATA', itemId: '295123456789', item: Object.assign({}, EBAY_ITEM, itemOverride) }, { tab: { id: c.stages.ebay.tabId } });
  return api.getCache();
}
const sendAmazon = async (over) => {
  const c = api.getCache(); const st = c.stages.amazon;
  const msg = Object.assign({ type: 'ARB_RESULTS', site: 'amazon', query: st.queries[st.queryIndex], page: st.page, items: [], error: null }, over);
  await api.handleMessage(msg, { tab: { id: st.tabId } });
};

(async () => {
  const C = api.constants;
  console.log('\n== Watchdog / constants ==');
  assert(C.ITEM_STAGE_TIMEOUT_MS === 60000, `ITEM_STAGE_TIMEOUT_MS = ${C.ITEM_STAGE_TIMEOUT_MS} (60s, not ~3s)`);
  assert(C.DEFAULT_ANALYZE_PAGES_PER_SITE === 5, `DEFAULT_ANALYZE_PAGES_PER_SITE = ${C.DEFAULT_ANALYZE_PAGES_PER_SITE}`);
  assert(C.AMAZON_ABSOLUTE_MAX_PAGES === 20, `AMAZON_ABSOLUTE_MAX_PAGES = ${C.AMAZON_ABSOLUTE_MAX_PAGES}`);

  console.log('\n== S1: multi-page pagination (pagesPerSite=2), tab stays open between pages ==');
  {
    await startRun({ pagesPerSite: 2 });
    let s = snap();
    const amazonTab = s.amz.tabId;
    assert(s.phase === 'searching-amazon' && s.amz.tabId != null, 'amazon tab open, phase=searching-amazon');
    await sendAmazon({ items: [amzItem(1), amzItem(2)] });
    s = snap();
    assert(s.amz.items.length === 2 && s.phase === 'searching-amazon' && s.amz.tabId != null, 'after page 1: 2 candidates, tab STILL OPEN');
    assert((lastUpdate().url || '').includes('page=2'), `page 2 requested in SAME tab: ${lastUpdate().url}`);
    await sendAmazon({ items: [amzItem(2), amzItem(3)] });
    s = snap();
    assert(s.phase === 'done' && s.res.length === 3, `pagination settled: ${s.res.length} aggregated candidates (deduped), run done`);
    assert(s.match && s.match.matched === true, 'match found across pages');
    assert(calls.tabsRemoved.filter((id) => id === amazonTab).length === 1, `amazon tab ${amazonTab} closed exactly once at settle`);
  }

  console.log('\n== S2: 0-result primary query -> broader fallback query in SAME tab ==');
  {
    await startRun({ pagesPerSite: 5 });
    let s = snap();
    const primary = s.amz.queries[0];
    assert(primary === EBAY_ITEM.title, 'plan[0] = EXACT eBay title (same-title search), not a reduced query');
    assert(new URL(snap().amz.url || '').searchParams.get('k') === EBAY_ITEM.title, 'first Amazon navigation searched the exact eBay title');
    assert(s.amz.queries.length >= 2, `query plan has fallbacks: ${JSON.stringify(s.amz.queries)}`);
    await sendAmazon({ items: [] });               // primary returns 0 results
    s = snap();
    assert(s.phase === 'searching-amazon' && s.amz.queryIndex === 1, 'tab NOT closed; fallback query 2 active');
    assert((lastUpdate().url || '').includes('page=1'), 'fallback navigates to page 1');
    assert(new URL(lastUpdate().url).searchParams.get('k') === s.amz.queries[1] && s.amz.queries[1] !== primary, 'fallback URL uses the broader query, not the primary');
    await sendAmazon({ items: [amzItem(5)] });     // fallback page 1 returns results
    s = snap();
    assert(s.phase === 'searching-amazon' && (lastUpdate().url || '').includes('page=2'), 'fallback keeps paginating (page 2 requested, tab open)');
    await sendAmazon({ items: [] });               // fallback page 2 empty -> settle on what we hold
    s = snap();
    assert(s.phase === 'done' && s.res.length === 1, 'fallback results settled and matched');
  }

  console.log('\n== S3: whole plan exhausted -> NO_AMAZON_RESULTS, tab closed ==');
  {
    await startRun({ pagesPerSite: 5 });
    const planLen = snap().amz.queries.length;
    for (let i = 0; i <= planLen; i++) await sendAmazon({ items: [] }); // one 0-result page per plan entry
    const s = snap();
    assert(s.phase === 'error' && s.err === 'NO_AMAZON_RESULTS', `failed cleanly with ${s.err}`);
    assert(s.amz.tabId == null && calls.tabsRemoved.length >= 1, 'tab closed after plan exhaustion');
  }

  console.log('\n== S4: Amazon redirects out-of-range page back to page 1 -> settle, no hang ==');
  {
    await startRun({ pagesPerSite: 5 });
    await sendAmazon({ items: [amzItem(1)] });
    await sendAmazon({ items: [amzItem(2)] });     // now st.page === 3 requested
    // Page-3 payload arrives reporting page=1 (Amazon bounced ?page=3 -> page 1)
    const c = api.getCache();
    const updatesBefore = calls.tabsUpdated.length;
    await api.handleMessage({ type: 'ARB_RESULTS', site: 'amazon', query: c.stages.amazon.queries[0], page: 1, items: [amzItem(3)], error: null }, { tab: { id: c.stages.amazon.tabId } });
    const s = snap();
    assert(s.phase === 'done' && s.res.length === 2, `redirect detected -> settled with ${s.res.length} held candidates instead of timing out`);
    assert(calls.tabsUpdated.length === updatesBefore, 'redirect settled WITHOUT further navigation');
  }

  console.log('\n== S5: CAPTCHA blocked -> tab KEPT open -> retry reuses it ==');
  {
    await startRun({ pagesPerSite: 5 });
    await sendAmazon({ error: 'blocked' });
    let s = snap();
    const blockedTab = s.amz.tabId;
    assert(s.phase === 'error' && s.err === 'NO_AMAZON_RESULTS' && blockedTab != null, 'blocked stage keeps its tab for CAPTCHA recovery');
    await api.handleMessage({ type: 'ARB_ANALYZE_RETRY' }, {});
    s = snap();
    assert(s.phase === 'searching-amazon' && s.amz.tabId === blockedTab, 'retry reused the SAME tab');
    assert(s.amz.page === 1 && s.amz.items.length === 0, 'retry restarted page 1 with fresh aggregation');
    await sendAmazon({ items: [amzItem(9)] });
    s = snap();
    assert(s.phase === 'searching-amazon', 'post-retry page 1 payload keeps paginating (tab open)');
    await sendAmazon({ items: [] });
    s = snap();
    assert(s.phase === 'done', 'post-retry run completes on end-of-results');
  }

  console.log('\n== S6: manual-ASIN /dp/ payload bypasses pagination ==');
  {
    await startRun({ pagesPerSite: 5 });
    await sendAmazon({ items: [] });
    await api.handleMessage({ type: 'ARB_ANALYZE_MANUAL_MATCH', input: 'B0BV3SBDZP' }, {});
    let s = snap();
    assert(s.phase === 'searching-amazon' && s.amz.tabId != null && s.amz.page === 1, 'manual match opened /dp/ tab');
    await sendAmazon({ items: [amzItem(7)] });     // single product payload, page 1
    s = snap();
    assert(s.phase === 'done' && s.res.length === 1, 'manual /dp/ item settled immediately');
  }

  console.log('\n== S7: price-parse WITH candidates -> settle on held data, no fallback burned ==');
  {
    await startRun({ pagesPerSite: 5 });
    let s = snap();
    const amazonTab = s.amz.tabId;
    await sendAmazon({ items: [amzItem(1), amzItem(4)] });                      // page 1 ok
    await sendAmazon({ error: 'price-parse', skippedForPrice: 48, items: [] }); // page 2 prices unreadable
    s = snap();
    assert(s.phase === 'done' && s.res.length === 2, `settled on ${s.res.length} held candidates despite price-parse`);
    assert(s.amz.queryIndex === 0, 'fallback query plan NOT burned by a recoverable price-parse');
    assert(calls.tabsRemoved.filter((id) => id === amazonTab).length === 1, 'tab closed exactly once at settle');
  }

  console.log('\n== S8: price-parse with 0 candidates -> ONE same-tab same-page retry, then success ==');
  {
    await startRun({ pagesPerSite: 5 });
    let s = snap();
    const amazonTab = s.amz.tabId;
    const createdBefore = calls.tabsCreated.length;
    await sendAmazon({ error: 'price-parse', skippedForPrice: 48, items: [] }); // hydration miss
    s = snap();
    assert(s.phase === 'searching-amazon' && s.amz.tabId === amazonTab, 'tab NOT closed on price-parse');
    assert(s.amz.priceParseRetried === true, 'retry budget marked spent');
    assert(calls.tabsCreated.length === createdBefore, 'retry reused the SAME tab (no new tab created)');
    assert((lastUpdate().url || '').includes('page=1'), 'retry navigated to the SAME page 1');
    await sendAmazon({ items: [amzItem(6)] });                                  // retry payload: prices hydrated
    s = snap();
    assert(s.phase === 'searching-amazon' && s.amz.items.length === 1 && s.amz.priceParseRetried === false, 'retry payload accepted, budget re-armed, paginating');
    await sendAmazon({ error: 'price-parse', skippedForPrice: 30, items: [] }); // page 2 fails WITH candidates held
    s = snap();
    assert(s.phase === 'done' && s.res.length === 1, 'later price-parse settles on held candidates');
  }

  console.log('\n== S9: price-parse retry ALSO fails -> fallback query with fresh budget ==');
  {
    await startRun({ pagesPerSite: 5 });
    let s = snap();
    const amazonTab = s.amz.tabId;
    await sendAmazon({ error: 'price-parse', skippedForPrice: 48, items: [] }); // 1st miss -> same-page retry
    await sendAmazon({ error: 'price-parse', skippedForPrice: 48, items: [] }); // retry fails -> next query
    s = snap();
    assert(s.phase === 'searching-amazon' && s.amz.queryIndex === 1, 'plan advanced to fallback query after spent retry');
    assert(s.amz.tabId === amazonTab, 'still the SAME tab session');
    assert(s.amz.priceParseRetried === false, 'fresh retry budget for the fallback query');
    assert((lastUpdate().url || '').includes('page=1'), 'fallback starts at page 1');
    await sendAmazon({ items: [amzItem(8)] });
    await sendAmazon({ items: [] });
    s = snap();
    assert(s.phase === 'done' && s.res.length === 1, 'fallback query scraped and settled');
  }

  console.log('\n== S10: fast no-results-page errors are PACED, not machine-gunned ==');
  {
    const t0 = Date.now();
    await startRun({ pagesPerSite: 5 });
    const planLen10 = snap().amz.queries.length;
    for (let i = 0; i <= planLen10; i++) await sendAmazon({ error: 'no-results-page' }); // one fast-fail per plan entry
    const elapsed = Date.now() - t0;
    const s = snap();
    assert(s.phase === 'error' && s.err === 'NO_AMAZON_RESULTS', `plan still exhausts cleanly (${s.err})`);
    assert(elapsed >= 1600, `advances were paced (${elapsed}ms >= 1600ms), not burned in ~1s`);
    assert(calls.tabsRemoved.length >= 1, 'tab closed only at terminal failure');
  }

  console.log('\n== S11: crowded page (sponsored first) -> 16 candidates -> genuine match at rank 13 ==');
  {
    // The user's real scenario: Amazon results dominated by sponsored/compatible
    // decoys, the genuine YITAMOTOR listing at organic rank 13. Background must
    // aggregate the full page-1 yield, KEEP PAGINATING (cap 80 > one page's
    // yield — page 1 alone must never settle), then settle at end-of-results
    // and hand the FULL pool — rank-13 item included — to the real matcher.
    const YITA_ITEM = {
      title: 'YITAMOTOR 15x6.00-6 Flat Free Lawn Mower Tires & Wheel Assemblies 4 Ply Pneumatic Front Tires Replacement Fits John Deere, Lawn Tractors, More Riding Mowers | 3" Centered Hub, 3/4" Bearings (',
      price: 56.99, shipping: 0, condition: 'New',
      specifics: { brand: 'YITAMOTOR' },
    };
    const decoyTitles = [
      'USB C Charger Cable 6FT Fast Charging Cord for Android Phones',
      'Phone Case for iPhone 15 with Screen Protector, Clear Anti-Yellow',
      'Stainless Steel Water Bottle 32oz Insulated with Straw Lid',
      'LED Desk Lamp with Wireless Charger, 3 Color Modes Dimmable',
      'Microfiber Cleaning Cloth Pack of 12 for Cars Glasses Screens',
      'Bluetooth Transmitter for TV, 3.5mm AUX Audio Adapter',
      'Garden Hose Splitter 2 Way Heavy Duty Brass Connector Y Valve',
      'Cabinet Drawer Organizer Trays Set of 5 Adjustable Bins',
      'Car Cup Holder Expander Adapter with Phone Mount Slot',
      'Wireless Doorbell Camera 1080p with Chime, Night Vision',
      'Heavy Duty Bungee Cords Assorted Lengths 16 Pack with Hooks',
      'Tire Pressure Gauge 0-100 PSI Dial with Straight Chuck',
    ];
    const items = decoyTitles.map((t, i) => amzItem(i + 1, t));
    // Organic rank 13: BELOW the old 10-item scoring window, above nothing.
    items.push(amzItem(99, 'YITAMOTOR 15x6.00-6 Flat Free Lawn Mower Tires on Wheels, 4 Ply Tubeless Replacement for John Deere Riding Mowers Garden Tractors, 3" Centered Hub, 3/4" Precision Ball Bearings, 570 lbs Capacity, Set of 2, Black'));
    items[items.length - 1].asin = items[items.length - 1].id = 'B0GENUINE1';
    items[items.length - 1].url = 'https://www.amazon.com/dp/B0GENUINE1';
    for (const t of ['Trailer Hitch Ball Mount 2 Inch Drop with Pin', 'Wheel Chock Rubber Pair for Trailers and Garage', 'Ratchet Tie Down Straps 15ft 4 Pack 500lb Limit']) items.push(amzItem(items.length + 1, t));

    await startRun({ pagesPerSite: 5 }, YITA_ITEM);
    const amazonTab = snap().amz.tabId;
    const p0 = snap().amz.queries[0];
    assert(p0.startsWith('YITAMOTOR 15x6.00-6 Flat Free') && p0.includes('Bearings') && !/[()\[\]|]$/.test(p0), `exact-title primary, sanitized (trailing "(" stripped, ends: ...${p0.slice(-16)})`);
    assert(!!snap().amz.queries[1] && snap().amz.queries[1] !== p0, 'cleaned query retained as fallback tier behind the exact title');
    await sendAmazon({ items });
    const s1 = snap();
    assert(s1.phase === 'searching-amazon', `page-1 yield (16) alone does NOT settle the run (cap 80 > page yield) — got ${s1.phase}`);
    assert((lastUpdate().url || '').includes('page=2'), 'pagination continues to page 2 in the SAME tab');
    await sendAmazon({ items: [] }); // page 2: no further results -> end of pagination
    const s = snap();
    assert(s.res.length === 16, `full pool of ${s.res.length}/16 candidates handed to the matcher (no 10-item trim)`);
    assert(s.res.some((x) => x.asin === 'B0GENUINE1'), 'rank-13 genuine candidate present in the pool');
    assert(s.phase === 'done', `settled on end-of-results, run completed (${s.phase}${s.err ? ': ' + s.err : ''})`);
    assert(s.match && s.match.matched === true, 'genuine crowded candidate WON the match end-to-end');
    // Popup contract (renderAnalyzeResult): st.match.bestMatch IS the accepted
    // match — the product card, profit box, safety box and CSV export all read
    // it. These asserts would have caught the "81% badge, empty card" bug.
    const bm = s.match && s.match.bestMatch;
    assert(bm && bm.asin === 'B0GENUINE1', `st.match.bestMatch.asin = ${bm && bm.asin} (popup product card renders from this)`);
    assert(bm && typeof bm.price === 'number' && bm.price > 0, 'bestMatch carries a numeric price for the profit box');
    assert(bm && !!bm.title && !!bm.url, 'bestMatch carries title + url for the card and listing link');
    assert(s.match.matchedAmazon && s.match.matchedAmazon.asin === 'B0GENUINE1', 'matchedAmazon alias populated for export/background consumers');
    const cache11 = api.getCache();
    assert(cache11.profit && typeof cache11.profit.netProfit === 'number', 'profit stored for the accepted pair');
    assert(calls.tabsRemoved.filter((id) => id === amazonTab).length === 1, `amazon tab ${amazonTab} closed exactly once at settle`);
  }

  console.log('\n== S12: decoys-only pool -> done state with bestMatch strictly NULL (no below-threshold leak) ==');
  {
    // Inverse of S11: when NOTHING clears the confidence floor, the popup must
    // show "No confident match found" — not a product card for a rejected
    // candidate with profit computed from it. bestMatch stays null.
    const decoyItems = ['USB C Charger Cable 6FT Fast Charging Cord', 'Phone Case for iPhone 15 Clear',
      'Stainless Steel Water Bottle 32oz Insulated', 'LED Desk Lamp with Wireless Charger',
      'Microfiber Cleaning Cloth Pack of 12', 'Bluetooth Transmitter for TV AUX',
      'Garden Hose Splitter 2 Way Brass', 'Cabinet Drawer Organizer Trays Set of 5',
      'Car Cup Holder Expander Adapter', 'Wireless Doorbell Camera 1080p',
      'Heavy Duty Bungee Cords 16 Pack', 'Tire Pressure Gauge 0-100 PSI Dial',
      'Trailer Hitch Ball Mount 2 Inch', 'Wheel Chock Rubber Pair', 'Ratchet Tie Down Straps 15ft',
      'Bike Lock Heavy Duty Combination'].map((t, i) => amzItem(i + 1, t));
    await startRun({ pagesPerSite: 5 }, {
      title: 'YITAMOTOR 15x6.00-6 Flat Free Lawn Mower Tires & Wheel Assemblies 4 Ply Pneumatic Front Tires Replacement Fits John Deere, Lawn Tractors, More Riding Mowers | 3" Centered Hub, 3/4" Bearings (',
      price: 56.99, shipping: 0, condition: 'New', specifics: { brand: 'YITAMOTOR' },
    });
    const tab12 = snap().amz.tabId;
    await sendAmazon({ items: decoyItems }); // 16 decoys -> pagination continues (cap 80)
    await sendAmazon({ items: [] });         // page 2 empty -> end of results -> settle
    const s = snap();
    assert(s.phase === 'done', `decoys-only pool settled into a done state (${s.phase}${s.err ? ': ' + s.err : ''})`);
    assert(s.match && s.match.matched === false, 'matcher correctly rejected the unrelated pool');
    assert(!s.match.bestMatch, 'bestMatch stays NULL — no below-threshold candidate leaks into the product card');
    assert(!s.match.matchedAmazon, 'matchedAmazon stays NULL for export consumers');
    const c = api.getCache();
    assert(c.error && c.error.code === 'LOW_CONFIDENCE', `empty-card state surfaced error ${c.error && c.error.code}`);
    assert(!c.profit, 'Phase-2 invariant: no profit computed from below-threshold candidates');
    assert(calls.tabsRemoved.filter((id) => id === tab12).length === 1, 'tab closed exactly once at settle');
  }

  console.log(`\nSim complete — exitCode=${process.exitCode || 0}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
