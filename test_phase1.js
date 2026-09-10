#!/usr/bin/env node
/*
 * test_phase1.js — Node test harness for ebay2amazon.js (Phase 1)
 * -----------------------------------------------------------------------------
 * Run: node test_phase1.js      (exit 0 = pass, 1 = fail)
 *
 * Dependency-free on purpose (matches the extension's zero-dep culture).
 * Covers the three Phase-1 pillars:
 *   1. extractEbayData      — via extractFromDocument with embedded fixtures
 *                             (network paths are mocked with opts.fetcher)
 *   2. cleanTitleAndBuildQuery
 *   3. matchAmazonProduct
 * plus URL validation, error codes and edge cases.
 *
 * Node has no DOMParser, so HTML fixtures are parsed by a tiny regex-backed
 * DOM shim implementing just the surface extractFromDocument touches
 * (querySelector / querySelectorAll / getElementById). The service worker
 * path uses the real DOMParser — the shim only exists for these tests.
 */
'use strict';

const { ARBScout } = require('./ebay2amazon.js');

let passed = 0, failed = 0;
const failures = [];
const queue = [];

function test(name, fn) { queue.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertEq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const E = ARBScout.ERROR_CODES;

/* ==================================================================== *
 * 1. validateEbayUrl                                                   *
 * ==================================================================== */
test('URL: accepts canonical /itm/ URL and returns id + canonical form', () => {
  const r = ARBScout.validateEbayUrl('https://www.ebay.com/itm/126848442915');
  assertEq(r.itemId, '126848442915');
  assertEq(r.canonicalUrl, 'https://www.ebay.com/itm/126848442915');
});

test('URL: accepts slug URLs, mobile hosts, bare ids, tracking params', () => {
  assertEq(ARBScout.validateEbayUrl('https://www.ebay.com/itm/Sony-WH-1000XM5-Black/175590517615').itemId, '175590517615');
  assertEq(ARBScout.validateEbayUrl('https://www.ebay.com/itm/126848442915?_ul=US&hash=x#shp').itemId, '126848442915');
  assertEq(ARBScout.validateEbayUrl('https://cart.ebay.com/itm/111122223333').itemId, '111122223333');
  assertEq(ARBScout.validateEbayUrl('https://www.ebay.de/itm/222233334444').itemId, '222233334444');
  assertEq(ARBScout.validateEbayUrl('126848442915').itemId, '126848442915');
  assertEq(ARBScout.validateEbayUrl(' https://www.ebay.com/itm/1234567890 ').itemId, '1234567890');
});

test('URL: rejects non-eBay hosts, search pages, bad schemes, garbage', () => {
  const cases = [
    ['https://www.amazon.com/dp/B08N5WRWNW', E.NOT_EBAY_ITEM],
    ['https://www.ebay.com/sch/i.html?_nkw=stanley', E.NOT_EBAY_ITEM],
    ['https://evil.example.com/itm/123456789', E.NOT_EBAY_ITEM],
    ['javascript:alert(1)', E.INVALID_URL],
    ['ftp://www.ebay.com/itm/123456789', E.INVALID_URL],
    ['', E.INVALID_URL],
    [null, E.INVALID_URL],
    ['not a url at all', E.INVALID_URL]
  ];
  for (const [input, code] of cases) {
    let err = null;
    try { ARBScout.validateEbayUrl(input); } catch (e) { err = e; }
    assert(err && err.code === code, `expected ${code} for "${input}", got ${err && err.code}`);
  }
});

/* ==================================================================== *
 * 2. extractBundleQuantity                                             *
 * ==================================================================== */
test('Bundle: parses every pack notation', () => {
  const eq = (t, q) => assertEq(ARBScout.extractBundleQuantity(t).quantity, q, t);
  eq('Stanley Quencher 40oz 2 Pack', 2);
  eq('Pack of 12 Cotton Towels', 12);
  eq('Cotton Towels 6PK', 6);
  eq('Set of 3 Cutting Boards', 3);
  eq('2x USB-C Cables', 2);
  eq('Toothbrushes x4', 4);
  eq('Paper Towels 24 Count', 24);
  eq('One Dozen Golf Balls', 12);
  eq('Headphones Pair', 2);
  eq('Wireless Mouse Combo Kit', 2); // heuristic floor for bundle words
  eq('Single Toothbrush Holder', 1);
  eq('Stanley Quencher H2.0 Tumbler 40oz', null); // "40" is size, not pack
  eq('128GB USB Flash Drive', null);              // classic false-positive trap
});

/* ==================================================================== *
 * 3. cleanTitleAndBuildQuery                                           *
 * ==================================================================== */
test('Query: brand+model strategy strips spam and keeps identity', () => {
  const r = ARBScout.cleanTitleAndBuildQuery(
    'Logitech MX Master 3S Wireless Mouse - FAST FREE SHIPPING USA SELLER',
    { brand: 'Logitech' });
  assertEq(r.strategy, 'brand-model');
  assertEq(r.brand, 'logitech');
  assert(r.model && /\d/.test(r.model), `model token expected, got ${r.model}`);
  assertEq(r.query, 'logitech mx master 3s wireless mouse');
  assert(r.removedSpam === true);
});

test('Query: identifier strategy wins when UPC is present', () => {
  const r = ARBScout.cleanTitleAndBuildQuery(
    'Stanley Quencher H2.0 Tumbler 40oz FAST FREE SHIPPING',
    { brand: 'Stanley', upc: '041605401029' });
  assertEq(r.strategy, 'gtin');
  assertEq(r.query, '041605401029');
  assertEq(r.gtin, '041605401029');
  assertEq(r.bundleQuantity, null);
});

test('Query: brand-keywords strategy for brand-only titles', () => {
  // No model-like tokens in this title -> brand-keywords (not brand-model).
  const r = ARBScout.cleanTitleAndBuildQuery(
    'Stanley Quencher Tumbler with Handle FAST FREE SHIPPING BRAND NEW',
    { brand: 'Stanley' });
  assertEq(r.strategy, 'brand-keywords');
  assert(r.query.startsWith('stanley'), r.query);
  assert(/quencher/.test(r.query), `main noun kept: ${r.query}`);
  assert(!/brand|fast|shipp/i.test(r.query), r.query);
});

test('Query: MPN from specifics builds brand+MPN query', () => {
  const r = ARBScout.cleanTitleAndBuildQuery(
    'Replacement Filter for Air Purifier Model 24000 FAST SHIP',
    { brand: 'Honeywell', mpn: 'HRF-APP1' });
  assertEq(r.strategy, 'mpn');
  assert(/hrf/.test(r.query), `MPN kept in query: ${r.query}`);
  assert(!/fast|ship/i.test(r.query), r.query);
});

test('Query: keyword fallback without brand (4-6 highest-value words)', () => {
  const r = ARBScout.cleanTitleAndBuildQuery(
    'Stainless Steel Water Bottle Insulated 32oz FAST FREE SHIPPING BEST GIFT');
  assertEq(r.strategy, 'keywords');
  const words = r.query.split(' ');
  assert(words.length >= 4 && words.length <= 6, `4-6 keywords: ${r.query}`);
  assert(!/fast|free|shipp|gift|best/i.test(r.query), r.query);
  assert(/steel|bottle|insulated/.test(r.query), r.query);
});

test('Query: pure-spam title throws NO_QUERY', () => {
  let err = null;
  try { ARBScout.cleanTitleAndBuildQuery('FREE SHIPPING FAST DELIVERY WOW HOT GIFT'); }
  catch (e) { err = e; }
  assert(err && err.code === E.NO_QUERY, `expected NO_QUERY, got ${err && err.code}`);
});

test('Query: junk UPC is ignored, malformed input throws', () => {
  // 5-digit "UPC" is not a valid GTIN -> must fall back to another strategy.
  const r = ARBScout.cleanTitleAndBuildQuery('Logitech MX Mouse', { brand: 'Logitech', upc: '12345' });
  assert(r.strategy !== 'gtin', 'junk UPC must not win');
  assertEq(r.gtin, null);
  let err = null;
  try { ARBScout.cleanTitleAndBuildQuery('   '); } catch (e) { err = e; }
  assert(err && err.code === E.NO_QUERY);
});

/* ==================================================================== *
 * 4. extractEbayData / extractFromDocument (fixtures, no network)      *
 * ==================================================================== */

const GOOD_EBAY_HTML = `<!doctype html><html><head>
<title>Sony WH-1000XM5 Wireless Noise Canceling Headphones - eBay</title>
<meta property="og:title" content="Sony WH-1000XM5 Wireless Noise Canceling Headphones Black - FAST FREE SHIPPING | eBay">
<meta name="description" content="Sony WH-1000XM5 headphones. Brand new, sealed.">
<meta property="og:description" content="Sony flagship noise canceling headphones.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Sony WH-1000XM5 Wireless Noise Canceling Headphones Black","offers":{"@type":"Offer","price":"249.00","priceCurrency":"USD"},"itemCondition":"https://schema.org/NewCondition","additionalProperty":[{"@type":"PropertyValue","name":"Brand","value":"Sony"},{"@type":"PropertyValue","name":"MPN","value":"WW125974"},{"@type":"PropertyValue","name":"UPC","value":"027242920495"}]}</script>
</head><body>
<div class="x-price-primary"><span itemprop="price" content="249.00">US $249.00</span></div>
<div class="ux-labels-values--shipping"><div class="ux-textspans--BOLD">FREE shipping</div></div>
<div class="x-item-condition-text">Brand New</div>
<div class="ux-labels-values"><div class="ux-labels-values__labels">Brand:</div><div class="ux-labels-values__values">Sony</div></div>
<div class="ux-labels-values"><div class="ux-labels-values__labels">MPN:</div><div class="ux-labels-values__values">WW125974</div></div>
<div class="ux-labels-values"><div class="ux-labels-values__labels">Model:</div><div class="ux-labels-values__values">WH-1000XM5/B</div></div>
<div class="ux-labels-values"><div class="ux-labels-values__labels">Type:</div><div class="ux-labels-values__values">Headphones</div></div>
<div class="ux-labels-values"><div class="ux-labels-values__labels">Compatible Model:</div><div class="ux-labels-values__values">For Sony WH-1000XM4</div></div>
</body></html>`;

const NO_TITLE_HTML = `<!doctype html><html><head><title>eBay</title></head><body><div class="x-price-primary">US $9.99</div></body></html>`;

/** Regex-backed DOM shim: just the surface extractFromDocument touches. */
function makeDom(html) {
  // Class-only selector part (price / shipping / condition slots).
  function matchClassPart(part) {
    const classes = part.match(/\.([a-zA-Z0-9_-]+)/g) || [];
    if (!classes.length || part.includes('[')) return [];
    for (const c of classes) {
      const cls = c.slice(1);
      const re = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]{0,300}?)</`, 'i');
      const m = html.match(re);
      if (m) return [{ textContent: m[1], getAttribute: () => null }];
    }
    return [];
  }

  return {
    querySelector(sel) {
      // Handle comma lists: try each alternative until one hits.
      for (const part of sel.split(',')) {
        const hit = this.querySelectorSingle(part.trim());
        if (hit) return hit;
      }
      return null;
    },
    querySelectorSingle(sel) {
      const metaM = sel.match(/^meta\[(?:name|property)="([^"]+)"\]$/);
      if (metaM) {
        const re = new RegExp(`<meta[^>]*(?:name|property)="${metaM[1]}"[^>]*>`, 'i');
        const m = html.match(re);
        if (!m) return null;
        const content = (m[0].match(/content="([^"]*)"/i) || [])[1];
        return content != null ? { getAttribute: (a) => (a === 'content' ? content : null), textContent: '' } : null;
      }
      if (sel === 'script[type="application/ld+json"]') {
        return this.querySelectorAll(sel)[0] || null;
      }
      const all = this.querySelectorAll(sel);
      return all[0] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      if (sel === 'script[type="application/ld+json"]') {
        const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(html))) out.push({ textContent: m[1] });
        return out;
      }
      if (sel.endsWith(' dt')) { // dl/dt fallback (Layout B)
        const re = /<dt[^>]*>([^<]+)<\/dt>\s*<dd[^>]*>([^<]+)<\/dd>/gi;
        let m;
        while ((m = re.exec(html))) {
          out.push({ textContent: m[1], nextElementSibling: { textContent: m[2] } });
        }
        return out;
      }
      if (sel.includes('ux-labels-values__labels')) { // specifics rows (Layout A)
        const re = /ux-labels-values__labels"[^>]*>([^<]+)<\/div>\s*<div[^>]*ux-labels-values__values"[^>]*>([^<]+)<\/div>/gi;
        let m;
        while ((m = re.exec(html))) {
          const label = m[1], value = m[2];
          out.push({
            textContent: label,
            parentElement: {
              querySelector: (s2) => (s2.includes('__values') ? { textContent: value } : null)
            }
          });
        }
        return out;
      }
      // Comma-separated selector list: first matching alternative wins.
      for (const part of sel.split(',')) {
        const found = matchClassPart(part.trim());
        if (found.length) return found;
      }
      return out;
    },
    getElementById: () => null
  };
}

test('Extract: parses title/price/shipping/specifics from fixture HTML', () => {
  const url = 'https://www.ebay.com/itm/175590517615';
  const doc = makeDom(GOOD_EBAY_HTML);
  const p = ARBScout.extractFromDocument(doc, ARBScout.validateEbayUrl(url).canonicalUrl);
  assertEq(p.title, 'Sony WH-1000XM5 Wireless Noise Canceling Headphones Black');
  assertEq(p.price, 249.0);
  assertEq(p.shipping, 0);
  assertEq(p.totalPrice, 249.0);
  assertEq(p.brand, 'Sony');
  assertEq(p.mpn, 'WW125974');
  assertEq(p.model, 'WH-1000XM5/B');
  assertEq(p.gtin, '027242920495');
  assertEq(p.condition, 'Brand New');
  assertEq(p.itemId, '175590517615');
  assertEq(p.source, 'ebay');
  assertEq(p.specifics.type, 'Headphones');
  assertEq(p.specifics.compatibleModel, 'For Sony WH-1000XM4');
  assert(/Sony WH-1000XM5 headphones/.test(p.description), p.description);
});

test('Extract: fetcher path + NO_TITLE + FETCH_FAILED + TIMEOUT', async () => {
  const url = 'https://www.ebay.com/itm/111122223333';
  // NO_TITLE: fetcher returns a Document-like shim (Node lacks DOMParser).
  let err = null;
  try {
    await ARBScout.extractEbayData(url, { fetcher: async () => makeDom(NO_TITLE_HTML), domTimeoutMs: 50 });
  } catch (e) { err = e; }
  assert(err && err.code === E.NO_TITLE, `expected NO_TITLE, got ${err && err.code}`);

  // FETCH_FAILED when fetcher rejects.
  err = null;
  try {
    await ARBScout.extractEbayData(url, { fetcher: async () => { throw new Error('boom'); }, domTimeoutMs: 50 });
  } catch (e) { err = e; }
  assert(err && err.code === E.FETCH_FAILED, `expected FETCH_FAILED, got ${err && err.code}`);

  // TIMEOUT when fetcher hangs (raced against timeoutMs).
  err = null;
  try {
    await ARBScout.extractEbayData(url, { fetcher: () => new Promise(() => {}), timeoutMs: 120 });
  } catch (e) { err = e; }
  assert(err && err.code === E.TIMEOUT, `expected TIMEOUT, got ${err && err.code}`);
});

/* ==================================================================== *
 * 5. matchAmazonProduct                                                *
 * ==================================================================== */

const EBAY_SONY = {
  url: 'https://www.ebay.com/itm/175590517615',
  title: 'Sony WH-1000XM5 Wireless Noise Canceling Headphones Black - FAST FREE SHIPPING',
  price: 249.0,
  shipping: 0,
  totalPrice: 249.0,
  specifics: { brand: 'Sony', mpn: 'WW125974', upc: '027242920495' }
};

const AMAZON_SONY_RESULTS = [
  { asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Headphones, Black', price: 299.99, url: 'https://www.amazon.com/dp/B09XS7JWHH' },
  { asin: 'B0BXHMM4SJ', title: 'Sony WH-1000XM4 Wireless Noise Canceling Overhead Headphones, Black', price: 248.00, url: 'https://www.amazon.com/dp/B0BXHMM4SJ' },
  { asin: 'B08N5WRWNW', title: 'Echo Dot (5th Gen) Smart speaker with Alexa', price: 49.99, url: 'https://www.amazon.com/dp/B08N5WRWNW' }
];

test('Match: exact product wins with high confidence', () => {
  const r = ARBScout.matchAmazonProduct(EBAY_SONY, AMAZON_SONY_RESULTS);
  assert(r.matched, `should match; best=${r.bestMatch && r.bestMatch.score}`);
  assertEq(r.matchedAmazon.asin, 'B09XS7JWHH');
  assert(r.confidence >= 0.75, `confidence ${r.confidence} should be high`);
  assert(!r.error);
  const cand = r.candidates.find((c) => c.asin === 'B08N5WRWNW');
  assert(cand && cand.score < 0.6, `irrelevant product must score low: ${cand && cand.score}`);
});

test('Match: pack-size mismatch is rejected (single vs multipack)', () => {
  const ebay2pack = {
    title: 'Anker PowerPort Atom III 2 Pack USB C Charger FAST SHIPPING',
    price: 35.99, shipping: 0, totalPrice: 35.99,
    specifics: { brand: 'Anker' }
  };
  const results = [
    { asin: 'B0AAAA1111', title: 'Anker PowerPort Atom III USB C Wall Charger', price: 25.99 },
    { asin: 'B0BBBB2222', title: 'Anker PowerPort Atom III 2 Pack USB C Charger', price: 39.99 }
  ];
  const r = ARBScout.matchAmazonProduct(ebay2pack, results);
  assertEq(r.matchedAmazon.asin, 'B0BBBB2222', '2-pack must pair with the 2-pack');
  assert(r.matched, 'should match the 2-pack candidate');
});

test('Match: no results / no title produce structured errors', () => {
  let r = ARBScout.matchAmazonProduct(EBAY_SONY, []);
  assert(!r.matched && r.error && r.error.code === E.NO_AMAZON_RESULTS);

  r = ARBScout.matchAmazonProduct({ title: '' }, AMAZON_SONY_RESULTS);
  assert(!r.matched && r.error && r.error.code === E.PARSE_FAILED);

  r = ARBScout.matchAmazonProduct(null, AMAZON_SONY_RESULTS);
  assert(!r.matched && r.error && r.error.code === E.PARSE_FAILED);
});

test('Match: low-confidence best candidate returns LOW_CONFIDENCE', () => {
  const r = ARBScout.matchAmazonProduct(
    { title: 'Vintage Cast Iron Garden Gnome Statue 14 inch', price: 39.99, shipping: 5, totalPrice: 44.99 },
    [{ asin: 'B0XXXX0000', title: 'Solar Path Lights Outdoor Waterproof 8 Pack', price: 24.99 }]);
  assert(!r.matched);
  assert(r.error && (r.error.code === E.LOW_CONFIDENCE || r.error.code === E.QUANTITY_MISMATCH),
    `expected LOW_CONFIDENCE/QUANTITY_MISMATCH, got ${r.error && r.error.code}`);
  assert(r.confidence < 0.6);
});

test('Match: flat item shape (no specifics object) still matches', () => {
  const r = ARBScout.matchAmazonProduct(
    { title: 'Logitech MX Master 3S Wireless Mouse Graphite', price: 89.99, shipping: 0, totalPrice: 89.99, brand: 'Logitech' },
    [{ asin: 'B0AAAA3333', title: 'Logitech MX Master 3S Wireless Performance Mouse, Graphite', price: 99.99 }]);
  assert(r.matched, `flat shape should match; got ${r.bestMatch && r.bestMatch.score}`);
  assertEq(r.matchedAmazon.asin, 'B0AAAA3333');
});

test('Match: GTIN strategy tolerates different Amazon wording', () => {
  const r = ARBScout.matchAmazonProduct(
    { title: 'Stanley Quencher H2.0 Tumbler 40oz', price: 44.0, shipping: 0, totalPrice: 44.0, upc: '041605401029' },
    [{ asin: 'B0C1XXXXXX', title: 'Stanley 40 oz Stainless Steel H2.0 FlowState Quencher Tumbler', price: 45.00 }]);
  // GTIN not visible on Amazon search pages -> falls back to title signals.
  assert(r.candidates.length > 0);
  assert(r.matchedAmazon || r.confidence > 0, 'should produce a ranked candidate');
});

test('Match: unit-price tie-breaker prefers closer total price', () => {
  const ebay = { title: 'Generic AA Batteries 8 Pack', price: 9.99, shipping: 0, totalPrice: 9.99 };
  const results = [
    { asin: 'B0A1', title: 'AA Batteries 8 Pack', price: 10.49 },
    { asin: 'B0B2', title: 'AA Batteries 8 Pack', price: 27.99 }
  ];
  const r = ARBScout.matchAmazonProduct(ebay, results);
  assertEq(r.matchedAmazon.asin, 'B0A1');
});

test('Match: candidate cap respects top-N behavior', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    asin: `B0H${String(i).padStart(7, '0')}`,
    title: `Random item number ${i} unrelated gadget`,
    price: 9.99
  }));
  const r = ARBScout.matchAmazonProduct(EBAY_SONY, many);
  assert(r.candidates.length <= 10, `max 10 candidates scored, got ${r.candidates.length}`);
});

/* ==================================================================== *
 * 6. Unit helpers                                                      *
 * ==================================================================== */
test('Helpers: titleSimilarity + parseMoney basics', () => {
  assert(ARBScout.titleSimilarity('Logitech MX Master 3S Mouse', 'Logitech MX Master 3S Mouse') === 1);
  assert(ARBScout.titleSimilarity('Apple iPhone 15', 'Samsung Galaxy S24') < 0.2);
  assertEq(ARBScout.parseMoney('US $1,234.56'), 1234.56);
  assertEq(ARBScout.parseMoney('$12.99'), 12.99);
  assertEq(ARBScout.parseMoney('Free'), null);
  assertEq(ARBScout.parseMoney(''), null);
});

/* ==================================================================== *
 * Runner (sequential so output is deterministic)                       *
 * ==================================================================== */
(async () => {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      failures.push({ name, error: e });
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) {
      console.error(`  ✗ ${f.name}\n    ${f.error && f.error.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
