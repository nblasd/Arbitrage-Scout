#!/usr/bin/env node
/*
 * test_phase3.js — Node test harness for the Phase-3 hardening modules
 * -----------------------------------------------------------------------------
 * Run: node test_phase3.js      (exit 0 = pass, 1 = fail)
 *
 * Covers the four Phase-3 deliverables:
 *   1. safety.js    — variation-mismatch guard (colors/sizes/capacity/generic
 *                     parent ASINs) and quantity/unit-cost discrepancy alert.
 *   2. export.js    — clipboard breakdown text + RFC-4180 CSV (spreadsheet log).
 *   3. cleanup.js   — orphan-tab registry (register/unregister/sweep data)
 *                     against a chrome.storage.session shim.
 *   4. ebay2amazon.js — validateAmazonAsin + the manual-match recalculate
 *                     pipeline (single Amazon result -> match -> profit).
 *
 * Zero dependencies, same harness style as test_phase1.js / test_phase2.js.
 */
'use strict';

/* ---- chrome.storage.session shim (needed before cleanup.js is required) ---- */
const sessionStore = {};
if (typeof globalThis.chrome === 'undefined') {
  globalThis.chrome = { storage: { session: {
    async get(key) {
      return typeof key === 'string'
        ? { [key]: sessionStore[key] }
        : Object.fromEntries((key || []).map((k) => [k, sessionStore[k]]));
    },
    async set(obj) { Object.assign(sessionStore, obj); },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete sessionStore[k];
    }
  } } };
}

const { ARBSafety } = require('./safety.js');
const { ARBExport } = require('./export.js');
const { ARBCleanup } = require('./cleanup.js');
const { ARBScout } = require('./ebay2amazon.js');
const { ARBProfit } = require('./profit.js');

let passed = 0, failed = 0;
const failures = [];
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const assertEq = (a, b, m) => {
  if (a !== b) throw new Error(`${m || 'assertEq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const approx = (a, b, tol, m) => {
  if (Math.abs(a - b) > (tol == null ? 0.01 : tol)) {
    throw new Error(`${m || 'approx'}: expected ~${b}, got ${a}`);
  }
};

function amazonHoodie(color, size) {
  return { title: `Premium Hoodie Sweatshirt ${color} ${size}` };
}

/* ==================================================================== *
 * 1. safety.js — variation mismatch guard (Guard 1)                    *
 * ==================================================================== */

test('Safety/variation: conflicting color on Amazon title raises the soft alert', () => {
  const ebay = { title: 'Nike Air Max 270 Running Shoe Black Size 10', price: 89.99, quantity: null };
  const amazon = { title: 'Nike Air Max 270 Running Shoe White', price: 79.99, isPrime: true };
  const v = ARBSafety.detectVariationMismatch(ebay, amazon);
  assertEq(v.hasVariation, true);
  assertEq(v.conflict, true);
  assert(v.missing.includes('black'), `missing should list black, got ${v.missing.join(',')}`);
  assert(v.messages.some((m) => /Variation Alert: Verify color\/size on Amazon before ordering\./.test(m)),
    `must carry the exact variation-alert wording; got: ${v.messages.join(' | ')}`);
});

test('Safety/variation: generic parent ASIN (assorted colors) is flagged', () => {
  const ebay = { title: 'Sony WH-1000XM5 Headphones Black', price: 299.99 };
  const amazon = { title: 'Sony WH-1000XM5 Various Colors Wireless Noise Cancelling Headphone', price: 299.99 };
  const v = ARBSafety.detectVariationMismatch(ebay, amazon);
  assertEq(v.conflict, true);
  assert(v.messages.some((m) => /generic parent/i.test(m)), 'should mention a generic parent listing');
});

test('Safety/variation: matching variation stays quiet', () => {
  const ebay = { title: 'Logitech MX Master 3S Wireless Mouse Graphite', price: 99.99 };
  const amazon = { title: 'Logitech MX Master 3S Wireless Performance Mouse, Graphite USB', price: 99.99 };
  const v = ARBSafety.detectVariationMismatch(ebay, amazon);
  assertEq(v.conflict, false);
});

test('Safety/variation: capacity figure mismatch (128GB vs 256GB) is flagged', () => {
  const ebay = { title: 'SanDisk Ultra 128GB microSDXC Card', price: 15.99 };
  const amazon = { title: 'SanDisk Ultra 256gb microSDXC Memory Card', price: 23.99 };
  const v = ARBSafety.detectVariationMismatch(ebay, amazon);
  assertEq(v.conflict, true);
  assert(v.missing.includes('128gb'), `expected 128gb missing, got ${v.missing.join(',')}`);
});

test('Safety/variation: no variation words on eBay => nothing to guard', () => {
  const ebay = { title: 'Stainless Steel Insulated Water Bottle', price: 24.99 };
  const amazon = { title: 'Generic Reusable Water Bottle', price: 9.99 };
  const v = ARBSafety.detectVariationMismatch(ebay, amazon);
  assertEq(v.conflict, false);
});

test('Safety/variation: color/size ITEM SPECIFICS from eBay count as variations', () => {
  const ebay = {
    title: 'Premium Hoodie Sweatshirt',
    price: 39.99,
    specifics: { color: 'Navy', size: 'XL' }
  };
  const v = ARBSafety.detectVariationMismatch(ebay, amazonHoodie('Navy', 'M'));
  assertEq(v.conflict, true);
  const vOk = ARBSafety.detectVariationMismatch(ebay, amazonHoodie('navy', 'XL'));
  assertEq(vOk.conflict, false);
});

/* ==================================================================== *
 * 2. safety.js — quantity / unit-cost discrepancy (Guard 2)            *
 * ==================================================================== */

test('Safety/quantity: eBay 3-pack vs Amazon single => hard warning + exact wording', () => {
  const q = ARBSafety.checkQuantityAlignment(3, { title: 'Replacement Razor Blade' });
  assertEq(q.level, 'warning');
  assertEq(q.ebayQuantity, 3);
  assertEq(q.amazonQuantity, 1);
  assert(q.messages.some((m) => /Quantity Mismatch Detected — ROI calculation may be inaccurate\./.test(m)),
    `must carry the hard-warning wording; got: ${q.messages.join(' | ')}`);
});

test('Safety/quantity: Amazon pack-size parsed from its title', () => {
  const q = ARBSafety.checkQuantityAlignment(12, { title: 'Eveready AAA Batteries 12-Pack' });
  assertEq(q.amazonQuantity, 12);
  assertEq(q.level, 'ok');
  const single = ARBSafety.checkQuantityAlignment(1, { title: 'Eveready AAA Battery Single Cell' });
  assertEq(single.level, 'ok');
});

test('Safety/quantity: explicit Amazon `quantity` field wins over title parsing', () => {
  const q = ARBSafety.checkQuantityAlignment(4, { title: 'Soda Refills', quantity: 4 });
  assertEq(q.level, 'ok');
});

test('Safety/quantity: storage-size titles are NOT misread as pack counts', () => {
  assertEq(ARBSafety.amazonQuantityFromTitle('SanDisk Ultra 128GB microSDXC'), 1);
  assertEq(ARBSafety.amazonQuantityFromTitle('Stanley 40 oz Quencher Tumbler Cup'), 1);
  assertEq(ARBSafety.amazonQuantityFromTitle('Clorox Wipes 75 count canister'), 75);
});

test('Safety/combined: assessSafety aggregates soft + hard and sets hardWarning', () => {
  const ebay = { title: 'Bath Towels 6 Pack Dark Blue', price: 31.99, quantity: 6 };
  const amazon = { title: 'Premium Bath Towels White', price: 9.99, quantity: 1 };
  const s = ARBSafety.assessSafety(ebay, amazon);
  assertEq(s.hardWarning, true);
  assert(s.alerts.some((a) => a.code === 'QUANTITY_MISMATCH' && a.level === 'hard'), 'quantity alert must be hard');
  assert(s.alerts.some((a) => a.code === 'VARIATION_MISMATCH' && a.level === 'soft'), 'variation alert must be soft');
});

test('Safety/combined: a clean matched pair produces no alerts', () => {
  const ebay = { title: 'Logitech MX Master 3S Mouse Graphite', quantity: 1 };
  const amazon = { title: 'Logitech MX Master 3S Performance Wireless Mouse Graphite', quantity: 1 };
  const s = ARBSafety.assessSafety(ebay, amazon);
  assertEq(s.alerts.length, 0);
  assertEq(s.hardWarning, false);
});

/* ==================================================================== *
 * 3. export.js — clipboard breakdown + CSV                             *
 * ==================================================================== */

function sampleLead() {
  return {
    ebayProduct: {
      title: 'Logitech, MX Master 3S, Wireless Mouse, Graphite',
      price: 89.99, shipping: 0, url: 'https://www.ebay.com/itm/123456789012'
    },
    amazonMatch: {
      title: 'Logitech MX Master 3S Wireless Performance Mouse, Graphite',
      price: 69.99, shipping: 0, isPrime: true, asin: 'B0AAAA1111',
      url: 'https://www.amazon.com/dp/B0AAAA1111', confidence: 0.96
    },
    profit: ARBProfit.calculateArbitrageProfit(
      { price: 89.99, shipping: 0 }, { price: 69.99, shipping: 0, isPrime: true },
      { ebayFeeRate: 13.25, fixedFee: 0.30, estimatedSalesTax: 7, extraCostBuffer: 0 }),
    safety: { alerts: [{ code: 'VARIATION_MISMATCH', level: 'soft', message: 'Variation Alert: Verify color/size on Amazon before ordering.' }] }
  };
}

test('Export/breakdown: text includes both listings, prices, ASIN and net profit', () => {
  const txt = ARBExport.buildBreakdownText(sampleLead());
  assert(/Logitech, MX Master 3S/.test(txt), 'eBay title present');
  assert(/B0AAAA1111/.test(txt), 'ASIN present');
  assert(/\$89\.99/.test(txt), 'eBay sell price present');
  assert(/NET PROFIT/.test(txt), 'net profit line present');
  assert(/ROI/.test(txt), 'ROI present');
});

test('Export/CSV: header row matches the stable column order', () => {
  const csv = ARBExport.buildCsv([]);
  assertEq(csv.split('\r\n')[0], ARBExport.CSV_HEADERS.join(','));
});

test('Export/CSV: RFC-4180 quoting for commas/quotes/CRLF inside cells', () => {
  assertEq(ARBExport.csvEscapeCell('a,b'), '"a,b"');
  assertEq(ARBExport.csvEscapeCell('say "hi"'), '"say ""hi"""');
  assertEq(ARBExport.csvEscapeCell('line\nbreak'), '"line\nbreak"');
  assertEq(ARBExport.csvEscapeCell('plain'), 'plain');
});

test('Export/CSV: one lead = one data row with safety alerts concatenated', () => {
  const csv = ARBExport.buildCsv([sampleLead()]);
  const lines = csv.trim().split('\r\n');
  assertEq(lines.length, 2, 'header + 1 row');
  assert(lines[1].includes('B0AAAA1111'), 'ASIN in the data row');
  assert(lines[1].includes('Variation Alert'), 'safety alert exported into the row');
  // The comma-containing eBay title is quoted properly.
  assert(/\"Logitech, MX Master 3S/.test(lines[1]), 'comma-containing title quoted');
});

test('Export/CSV: pins a deterministic timestamp when injected (testability)', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const csv = ARBExport.buildCsv([sampleLead()], now);
  assert(csv.includes('2026-09-10T12:00:00.000Z'), 'capturedAt uses injected clock');
});

/* ==================================================================== *
 * 4. cleanup.js — orphan-tab registry (storage shim)                   *
 * ==================================================================== */

test('Cleanup: register/unregister/sweep round-trips against session storage', async () => {
  await ARBCleanup.clearOwnedTabs();
  assertEq((await ARBCleanup.getOwnedScrapeTabs()).length, 0);

  await ARBCleanup.registerScrapeTab(101, { site: 'amazon', stage: 'amazon', runId: 'a1' });
  await ARBCleanup.registerScrapeTab(202, { site: 'ebay', stage: 'ebay', runId: 'a1' });
  await ARBCleanup.registerScrapeTab(202, { site: 'ebay', stage: 'ebay', runId: 'a1' }); // idempotent

  const owned = await ARBCleanup.getOwnedScrapeTabs();
  assertEq(owned.sort().join(','), '101,202');

  await ARBCleanup.unregisterScrapeTab(101);
  await ARBCleanup.unregisterScrapeTab(999); // unknown id must not throw
  assertEq((await ARBCleanup.getOwnedScrapeTabs()).join(','), '202');

  await ARBCleanup.clearOwnedTabs();
  assertEq((await ARBCleanup.getOwnedScrapeTabs()).length, 0);
});

/* ==================================================================== *
 * 5. Manual-match path — validateAmazonAsin + recalculate from a       *
 *    single Amazon product (as parsed from a /dp/ page)                *
 * ==================================================================== */

test('Manual-match: bare ASIN and /dp/ URL both normalize to a product URL', () => {
  const bare = ARBScout.validateAmazonAsin('b0aaaa1111');
  assertEq(bare.asin, 'B0AAAA1111');
  assertEq(bare.url, 'https://www.amazon.com/dp/B0AAAA1111');
  const url = ARBScout.validateAmazonAsin('https://www.amazon.com/dp/B0AAAA1111?th=1&psc=1');
  assertEq(url.asin, 'B0AAAA1111');
  const slug = ARBScout.validateAmazonAsin('https://www.amazon.com/gp/product/B0AAAA1111');
  assertEq(slug.asin, 'B0AAAA1111');
});

test('Manual-match: rejects junk, non-Amazon hosts and non-product URLs', () => {
  const bad = ['', 'https://google.com/dp/B0AAAA1111', 'https://www.amazon.com/s?k=mouse', 'B0AAA', 'https://www.ebay.com/itm/123'];
  for (const input of bad) {
    let code = null;
    try { ARBScout.validateAmazonAsin(input); } catch (e) { code = e.code; }
    assertEq(code, 'ASIN_INVALID', `expected ASIN_INVALID for "${input}"`);
  }
});

test('Manual-match: a single /dp/ result drives match + profit + safety', () => {
  const ebay = { title: 'Logitech MX Master 3S Wireless Mouse Graphite', price: 89.99, shipping: 0, quantity: 1, brand: 'Logitech' };
  const dpResult = [{
    asin: 'B0AAAA1111', id: 'B0AAAA1111', site: 'amazon',
    title: 'Logitech MX Master 3S Wireless Performance Mouse, Graphite',
    price: 69.99, isPrime: true, url: 'https://www.amazon.com/dp/B0AAAA1111'
  }];

  const match = ARBScout.matchAmazonProduct(ebay, dpResult);
  assert(match.matched, `single-item match should be accepted; error=${match.error && match.error.code}`);
  assertEq(match.matchedAmazon.asin, 'B0AAAA1111');

  const profit = ARBProfit.calculateArbitrageProfit(
    { price: ebay.price, shipping: 0 },
    { price: match.matchedAmazon.price, shipping: 0, isPrime: true },
    { ebayFeeRate: 13.25, fixedFee: 0.30, estimatedSalesTax: 7, extraCostBuffer: 0 });
  assert(profit.isProfitable, 'profit should be positive');
  // Revenue 89.99 − sourcing (69.99×1.07) − fees (89.99×0.1325 + 0.30) = ~$2.88
  approx(profit.netProfit, 2.88, 0.02, 'hand-computed net profit');

  const safety = ARBSafety.assessSafety(ebay, match.matchedAmazon);
  assertEq(safety.hardWarning, false, 'matching single units and same color = clean');
});

/* ==================================================================== *
 * Runner (sequential so output is deterministic)                       *
 * ==================================================================== */
(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; }
    catch (e) { failed++; failures.push({ name, error: e }); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.error(`  \u2717 ${f.name}\n    ${f.error && f.error.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
