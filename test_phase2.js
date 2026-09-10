#!/usr/bin/env node
/*
 * test_phase2.js — Node test harness for profit.js (Phase 2)
 * -----------------------------------------------------------------------------
 * Run: node test_phase2.js      (exit 0 = pass, 1 = fail)
 *
 * Verifies the dropshipping profit engine against hand-computed cases:
 *   Revenue = sell + shipCollected
 *   Sourcing = (buy + ship) * (1 + tax)
 *   Fees = Revenue * rate + fixed
 *   Net = Revenue - Sourcing - Fees - buffer
 *   ROI = Net / Sourcing, Margin = Net / Revenue
 */
'use strict';

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

test('Spec example: hand-computed breakdown', () => {
  // sell 100, ship 0 | buy 60, ship 0 | tax 7% | fee 13.25% + 0.30 | buffer 0
  const p = ARBProfit.calculateArbitrageProfit(
    { price: 100, shipping: 0 },
    { price: 60, shipping: 0, isPrime: true },
    { ebayFeeRate: 13.25, fixedFee: 0.30, estimatedSalesTax: 7, extraCostBuffer: 0 });
  approx(p.breakdown.totalEbayRevenue, 100, 0.001, 'revenue');
  approx(p.breakdown.totalAmazonSourcingCost, 64.2, 0.001, 'sourcing'); // 60*1.07
  approx(p.breakdown.totalEbayFees, 13.55, 0.001, 'fees');              // 13.25 + 0.30
  approx(p.netProfit, 22.25, 0.01, 'net');                              // 100 - 64.2 - 13.55
  approx(p.roi, 34.7, 0.06, 'roi');                                     // 22.25/64.2
  approx(p.margin, 22.25, 0.06, 'margin');                              // 22.25/100
  assertEq(p.isProfitable, true);
});

test('Shipping collected counts as revenue; shipping paid counts in sourcing', () => {
  // Revenue 100+5=105; sourcing (50+5)*1.07=58.85; fees 105*.1325+.30=14.2125
  // Net = 105 - 58.85 - 14.2125 - 2 = 29.9375
  const p = ARBProfit.calculateArbitrageProfit(
    { price: 100, shipping: 5 },
    { price: 50, shipping: 5 },
    { ebayFeeRate: 13.25, fixedFee: 0.30, estimatedSalesTax: 7, extraCostBuffer: 2 });
  approx(p.breakdown.totalEbayRevenue, 105, 0.001);
  approx(p.breakdown.totalAmazonSourcingCost, 58.85, 0.001);
  approx(p.breakdown.totalEbayFees, 14.2125, 0.01); // breakdown rounds to cents
  approx(p.netProfit, 29.94, 0.01);
  approx(p.roi, (29.9375 / 58.85) * 100, 0.1); // roi is stored at 0.1% precision
  approx(p.margin, (29.9375 / 105) * 100, 0.1); // margin is stored at 0.1% precision
});

test('Defaults apply when settings omitted (13.25% + $0.30, 7% tax)', () => {
  const p = ARBProfit.calculateArbitrageProfit({ price: 100, shipping: 0 }, { price: 50, shipping: 0, isPrime: true });
  assertEq(p.settings.ebayFeeRate, 13.25);
  assertEq(p.settings.fixedFee, 0.30);
  assertEq(p.settings.estimatedSalesTax, 7);
  assertEq(p.settings.extraCostBuffer, 0);
  approx(p.breakdown.totalAmazonSourcingCost, 53.5, 0.001);
});

test('Prime implies $0 Amazon shipping when not stated', () => {
  const prime = ARBProfit.calculateArbitrageProfit({ price: 100 }, { price: 50, isPrime: true }, { estimatedSalesTax: 0, ebayFeeRate: 0, fixedFee: 0 });
  assertEq(profitShipping(prime), 0);
  const notPrime = ARBProfit.calculateArbitrageProfit({ price: 100 }, { price: 50, isPrime: false }, { estimatedSalesTax: 0, ebayFeeRate: 0, fixedFee: 0 });
  assertEq(profitShipping(notPrime), 0); // unknown -> warning, $0 assumed
  assert(notPrime.warnings.length > 0, 'unknown shipping must warn');
});

test('Unprofitable deal: negative net, ROI, margin + isProfitable=false', () => {
  const p = ARBProfit.calculateArbitrageProfit(
    { price: 30, shipping: 0 },
    { price: 45, shipping: 0, isPrime: true },
    { ebayFeeRate: 13.25, fixedFee: 0.30, estimatedSalesTax: 7, extraCostBuffer: 0 });
  // Revenue 30; sourcing 48.15; fees 4.275; net = -22.425
  assertEq(p.isProfitable, false);
  assert(p.netProfit < 0 && p.roi < 0 && p.margin < 0);
  approx(p.netProfit, -22.43, 0.01);
});

test('String money inputs and formatting are accepted', () => {
  const p = ARBProfit.calculateArbitrageProfit(
    { price: '$1,234.56', shipping: 'Free' },
    { price: 'US $900.00', shipping: 0, isPrime: true },
    { estimatedSalesTax: 0, ebayFeeRate: 0, fixedFee: 0 });
  approx(p.breakdown.totalEbayRevenue, 1234.56, 0.001);
  approx(p.breakdown.totalAmazonSourcingCost, 900, 0.001);
});

test('Missing/invalid inputs degrade gracefully (never throw)', () => {
  const p = ARBProfit.calculateArbitrageProfit(null, null, {});
  assertEq(p.isProfitable, false);
  assert(p.warnings.length >= 2, 'missing prices should warn');
  const p2 = ARBProfit.calculateArbitrageProfit({ price: -5 }, { price: 'abc' });
  assertEq(p2.inputs.ebaySellPrice, 0);
  assertEq(p2.inputs.amazonBuyPrice, 0);
  // Extreme settings are clamped, not trusted.
  const p3 = ARBProfit.calculateArbitrageProfit({ price: 100 }, { price: 10 }, { ebayFeeRate: 999, estimatedSalesTax: -4, fixedFee: -3 });
  assertEq(p3.settings.ebayFeeRate, 100);
  assertEq(p3.settings.estimatedSalesTax, 0);
  assertEq(p3.settings.fixedFee, 0);
});

test('Breakdown lines are human-readable and mention the key figures', () => {
  const p = ARBProfit.calculateArbitrageProfit({ price: 100, shipping: 0 }, { price: 60, shipping: 0, isPrime: true }, {});
  const text = p.breakdownLines.join(' ');
  assert(/\$100\.00/.test(text), 'revenue present');
  assert(/\$64\.20/.test(text), 'sourcing present');
  assert(/\$13\.55/.test(text), 'fees present');
  assert(/\$22\.25/.test(text), 'net present');
});

function profitShipping(p) { return p.inputs.amazonShippingCost; }

/* Runner */
(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; }
    catch (e) { failed++; failures.push({ name, error: e }); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.error(`  ✗ ${f.name}\n    ${f.error && f.error.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
