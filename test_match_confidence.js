#!/usr/bin/env node
/*
 * test_match_confidence.js — Node test harness for ebay2amazon.js matching
 * -----------------------------------------------------------------------------
 * Run: node test_match_confidence.js      (exit 0 = pass, 1 = fail)
 *
 * Regression net for the "tab closes after 3s / no match" bug:
 *   - exact-product candidates are accepted (not rejected at the 60% floor)
 *   - realistic stuffed-title Amazon results still produce a match
 *   - the candidate cap keeps enough results that a genuine match crowded to
 *     organic rank ~13 (below sponsored blocks) is still scored and found
 *   - genuinely unrelated results fail cleanly with NO_AMAZON_RESULTS
 */
'use strict';

const { ARBScout } = require('./ebay2amazon.js');

let passed = 0, failed = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const assertEqName = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const EBAY_TITLE = 'YITAMOTOR 15x6.00-6 Flat Free Lawn Mower Tires & Wheel Assemblies 4 Ply Pneumatic Front Tires Replacement Fits John Deere, Lawn Tractors, More Riding Mowers | 3" Centered Hub, 3/4" Bearings (';
/* matchAmazonProduct may mutate quantity — fresh product per test. */
const mkProduct = (over) => Object.assign({
  title: EBAY_TITLE, price: 56.99, shipping: 0, condition: 'New',
  itemId: '295123456789', quantity: 2, specifics: { brand: 'YITAMOTOR' },
}, over || {});

test('cleanTitleAndBuildQuery: brand-model strategy for the tire listing', () => {
  const q = ARBScout.cleanTitleAndBuildQuery(EBAY_TITLE, { brand: 'YITAMOTOR' });
  assertOk(q && q.query, 'query built');
  assertMatch(/yitamotor/i.test(q.query), `query keeps brand: ${q.query}`);
  assertMatch(/15x6/i.test(q.query), `query keeps size/model token: ${q.query}`);
});

test('exact product candidate is accepted well above the 60% floor', () => {
  const results = [{
    id: 'B0EXACT01', asin: 'B0EXACT01',
    title: 'YITAMOTOR 15x6.00-6 Flat Free Lawn Mower Tires with Wheel Assemblies, 4 Ply Pneumatic Replacement Tires for Lawn Tractors Riding Mowers, 3" Centered Hub, 3/4" Bushings, Set of 2',
    price: 79.99, rating: 4.5,
  }];
  const m = ARBScout.matchAmazonProduct(mkProduct(), results);
  assertEqName(m.matched, true, 'exact candidate matched');
  assertMatch(m.confidence >= 0.6, `confidence ${m.confidence} clears the 0.6 floor`);
});

test('realistic stuffed-title results still match (regression: silent 0-match)', () => {
  const stuffed = [
    { id: 'B0SPON001', asin: 'B0SPON001', title: 'Sponsored: Lawn Mower Tires 15x6.00-6 Flat Free Heavy Duty Replacement Tire and Wheel Assemblies with 3" Centered Hub and 3/4" Bushings, Universal Fit for Riding Mowers, Garden Tractors, Golf Carts, 2 Pack, 350 lbs Capacity, All Season', price: 59.99, rating: 4.0 },
    { id: 'B0SPON002', asin: 'B0SPON002', title: 'WEIZE 15x6.00-6 Tire and Wheel Assembly, 4 Ply Tubeless, 3" Centered Hub, 5/8" Ball Bearings, Compatible with John Deere, Craftsman, Troy Bilt, MTD, Cub Cadet Riding Lawn Mower Tractor Front Tires, Set of 2', price: 62.99, rating: 4.5 },
    { id: 'B0ORG004', asin: 'B0ORG004', title: 'HALBERD 15x6.00-6 Flat Free Tires and Wheels Assembly for Lawn Mower, 4 Ply Rated, 3" Centered Hub, 3/4" Bushing, Compatible with Most Riding Mowers Garden Tractors, 2 PCS', price: 65.99, rating: 4.4 },
    { id: 'B0ORG005', asin: 'B0ORG005', title: '15x6.00-6 Lawn Mower Tires Flat Free, Tire and Wheel Assemblies with 3/4" Bearings 3" Hub, 4 PLY Tubeless Replace for John Deere D110 LA105 Riding Mowers Tractors Front, 2Pack', price: 61.99, rating: 4.2 },
    { id: 'B0ORG006', asin: 'B0ORG006', title: 'AR-PRO 15x6.00-6 Tire and Wheel Assemblies (2 Pack) Flat Free with 3" Centered Hub and 3/4" Bushings | Replacement for 50+ Brands Riding Mowers and Lawn Tractors', price: 57.99, rating: 4.6 },
  ];
  const m = ARBScout.matchAmazonProduct(mkProduct(), stuffed);
  assertEqName(m.matched, true, 'stuffed-title page still matches');
});

test('candidate cap: genuine match crowded past old rank-10 cutoff is still scored', () => {
  // 12 token-sharing decoys + the genuine item at organic rank 13 (index 12).
  // The old maxCandidates=10 dropped it before scoring -> NO_AMAZON_RESULTS.
  const decoys = [];
  for (let i = 0; i < 12; i++) {
    const id = `B0DECOY${String(i).padStart(2, '0')}`;
    decoys.push({
      id, asin: id,
      title: `Lawn Mower Tire 15x6.00-6 Flat Free Replacement Wheel Assembly 3" Hub 3/4" Bushing for Riding Mower Garden Tractor, Variant ${i}, 2 Pack`,
      price: 55 + i, rating: 4.2,
    });
  }
  const genuine = {
    id: 'B0GENUINE', asin: 'B0GENUINE',
    title: 'YITAMOTOR 15x6.00-6 Flat Free Lawn Mower Tires on Wheels, 4 Ply Tubeless Replacement for John Deere Riding Mowers Garden Tractors, 3" Centered Hub, 3/4" Precision Ball Bearings, 570 lbs Capacity, Set of 2, Black',
    price: 79.99, rating: 4.5,
  };
  const m = ARBScout.matchAmazonProduct(mkProduct(), [...decoys, genuine]);
  assertMatch(m.candidates.some((c) => c.asin === 'B0GENUINE'),
    'genuine rank-13 candidate was scored (cap >= 13)');
  assertEqName(m.matched, true, 'crowded genuine product still yields a match');
});

test('unrelated results fail cleanly with NO_AMAZON_RESULTS (no throw)', () => {
  const unrelated = [
    { id: 'B0UNREL01', asin: 'B0UNREL01', title: 'Garden Hose Splitter 2 Way, Heavy Duty Brass Connector for Outdoor Faucet', price: 9.99, rating: 4.1 },
    { id: 'B0UNREL02', asin: 'B0UNREL02', title: 'LED Strip Lights 32.8ft Color Changing with Remote and Power Supply', price: 19.99, rating: 4.3 },
  ];
  const m = ARBScout.matchAmazonProduct(mkProduct(), unrelated); // must not throw
  assertEqName(m.matched, false, 'unrelated results do not match');
  // Candidates existed but none cleared the floor -> LOW_CONFIDENCE
  // (NO_AMAZON_RESULTS is reserved for an empty result set).
  assertMatch(m.error && m.error.code === 'LOW_CONFIDENCE',
    `clean error, got ${m.error && m.error.code}`);
test('matches[] lists EVERY candidate at/above the 50% floor, best first', () => {
  // The popup's "Other matches >= 50%" list renders from this array, so it
  // must include all sub-100% viable alternatives, not just the primary pick.
  const pool = [
    {
      id: 'B0EXACT01', asin: 'B0EXACT01',
      title: 'YITAMOTOR 15x6.00-6 Flat Free Lawn Mower Tires with Wheel Assemblies, 4 Ply Pneumatic Replacement Tires for Lawn Tractors Riding Mowers, 3" Centered Hub, 3/4" Bushings, Set of 2',
      price: 79.99, rating: 4.5,
    },
    {
      id: 'B0ALT0001', asin: 'B0ALT0001',
      title: 'YITAMOTOR 15x6.00-6 Lawn Mower Tires and Wheels, 4 Ply Pneumatic, 3" Centered Hub, 3/4" Bushings, Set of 2',
      price: 72.99, rating: 4.2,
    },
    { id: 'B0HOSE01', asin: 'B0HOSE01', title: 'Garden Hose Splitter 2 Way, Heavy Duty Brass Connector for Outdoor Faucet', price: 9.99, rating: 4.1 },
  ];
  const m = ARBScout.matchAmazonProduct(mkProduct(), pool);
  assertEqName(m.matched, true, 'pool yields a primary match');
  const asins = m.matches.map((c) => c.asin);
  assertMatch(asins.includes('B0EXACT01') && asins.includes('B0ALT0001'),
    `both viable candidates listed, got [${asins.join(', ')}]`);
  assertMatch(!asins.includes('B0HOSE01'), 'unrelated candidate excluded from the list');
  assertMatch(m.matches.every((c, i, a) => i === 0 || a[i - 1].score >= c.score),
    'matches[] sorted best-first');
  assertMatch(m.matches[0].asin === m.bestMatch.asin, 'list head equals the primary pick');
});
});

test('empty result list fails cleanly (no throw, no match)', () => {
  const m = ARBScout.matchAmazonProduct(mkProduct(), []);
  assertEqName(m.matched, false, 'empty results do not match');
  assertMatch(m.error && m.error.code === 'NO_AMAZON_RESULTS', 'clean NO_AMAZON_RESULTS error');
});

function assertOk(v, m) { if (!v) throw new Error(`${m || 'assertOk'}: got ${JSON.stringify(v)}`); }
function assertMatch(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  for (const { name, fn } of queue) {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();