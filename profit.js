/*
 * profit.js — Dropshipping arbitrage profit calculator
 * -----------------------------------------------------------------------------
 * Pure math, no DOM, no network, no chrome.* APIs — runs identically in the
 * MV3 service worker, the popup, and Node tests.
 *
 * Formula set (all percentages are 0-100 in settings, normalized to fractions
 * internally):
 *   Total eBay Revenue        = ebaySellPrice + ebayShippingCollected
 *   Total Amazon Sourcing     = (amazonBuyPrice + amazonShippingCost) * (1 + estimatedSalesTax)
 *   Total eBay Fees           = Total eBay Revenue * ebayFeeRate + fixedFee
 *   Net Profit                = Revenue - Sourcing - Fees - extraCostBuffer
 *   ROI    (%)                = Net Profit / Sourcing * 100
 *   Margin (%)                = Net Profit / Revenue * 100
 *
 * Environment-agnostic export shim (same convention as matcher.js /
 * ebay2amazon.js): self.ARBProfit in the worker, module.exports in Node.
 */
'use strict';

(function arbProfitModule() {

  /** Default overhead assumptions — every value user-configurable. */
  const DEFAULT_SETTINGS = {
    ebayFeeRate: 13.25,      // % of revenue (Standard eBay Managed Payments)
    fixedFee: 0.30,          // $ per order (payment/fixed portion)
    estimatedSalesTax: 7,    // % sales tax paid when buying on Amazon
    extraCostBuffer: 0.0     // $ optional buffer for misc costs
  };

  const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  const clampMoney = (v) => Math.max(0, Number(v) || 0);

  /** "$1,234.56" / "US $12.99" / number -> number|null (never negative). */
  function toMoney(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
    const m = String(v).replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  const round2 = (v) => Math.round(v * 100) / 100;

  const fmtUSD = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(Number.isFinite(v) ? v : 0);

  /**
   * Calculate dropshipping arbitrage profitability.
   *
   * @param {object} ebayProduct   { price, shipping, ... } (price = listing price)
   * @param {object} amazonProduct { price, shipping, isPrime, ... }
   * @param {object} [settings]    { ebayFeeRate, fixedFee, estimatedSalesTax, extraCostBuffer }
   * @returns {{
   *   inputs: {...}, breakdown: {...}, netProfit, roi, margin,
   *   isProfitable, breakdownLines: string[]
   * }} All monetary values rounded to cents; roi/margin in percent (1 decimal
   *    in breakdown text, raw numbers on the fields).
   */
  function calculateArbitrageProfit(ebayProduct, amazonProduct, settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});

    /* ---- Inputs (null-safe; missing money counts as $0 with a note) ---- */
    const ebaySellPrice = toMoney(
      ebayProduct && ebayProduct.price != null ? ebayProduct.price
        : ebayProduct && ebayProduct.ebaySellPrice);
    const ebayShippingCollected = toMoney(
      ebayProduct && ebayProduct.shipping != null ? ebayProduct.shipping
        : ebayProduct && ebayProduct.ebayShippingCollected) || 0;
    const amazonBuyPrice = toMoney(
      amazonProduct && amazonProduct.price != null ? amazonProduct.price
        : amazonProduct && amazonProduct.amazonBuyPrice);
    const amazonShippingRaw = toMoney(
      amazonProduct && amazonProduct.shipping != null ? amazonProduct.shipping
        : amazonProduct && amazonProduct.amazonShippingCost);
    // Prime shipping (or Prime-eligible listing with no stated cost) ships free.
    const prime = !!(amazonProduct && amazonProduct.isPrime);
    const amazonShippingCost = amazonShippingRaw != null ? amazonShippingRaw : (prime ? 0 : null);

    const ebayFeeRate = clampPct(s.ebayFeeRate) / 100;
    const fixedFee = clampMoney(s.fixedFee);
    const estimatedSalesTax = clampPct(s.estimatedSalesTax) / 100;
    const extraCostBuffer = clampMoney(s.extraCostBuffer);

    const warnings = [];
    if (ebaySellPrice == null) warnings.push('eBay sell price missing — treated as $0.');
    if (amazonBuyPrice == null) warnings.push('Amazon buy price missing — treated as $0.');
    if (amazonShippingCost == null) {
      warnings.push('Amazon shipping unknown and not Prime — $0 assumed (check the listing).');
    }

    /* ---- The math (exactly the spec formulas) ---- */
    const totalEbayRevenue = (ebaySellPrice || 0) + ebayShippingCollected;
    const totalAmazonSourcingCost =
      ((amazonBuyPrice || 0) + (amazonShippingCost || 0)) * (1 + estimatedSalesTax);
    const totalEbayFees = totalEbayRevenue * ebayFeeRate + fixedFee;
    const netProfit = totalEbayRevenue - totalAmazonSourcingCost - totalEbayFees - extraCostBuffer;

    // ROI denominator is the capital you lay out; margin denominator is revenue.
    const roi = totalAmazonSourcingCost > 0 ? (netProfit / totalAmazonSourcingCost) * 100 : null;
    const margin = totalEbayRevenue > 0 ? (netProfit / totalEbayRevenue) * 100 : null;

    const r2 = round2;
    const breakdownLines = [
      `Revenue: ${fmtUSD(ebaySellPrice || 0)} (item) + ${fmtUSD(ebayShippingCollected)} (shipping) = ${fmtUSD(totalEbayRevenue)}`,
      `Sourcing: (${fmtUSD(amazonBuyPrice || 0)} + ${fmtUSD(amazonShippingCost || 0)}) × ${((1 + estimatedSalesTax) * 100).toFixed(1)}% tax = ${fmtUSD(totalAmazonSourcingCost)}`,
      `Fees: ${fmtUSD(totalEbayRevenue)} × ${(ebayFeeRate * 100).toFixed(2)}% + ${fmtUSD(fixedFee)} = ${fmtUSD(totalEbayFees)}`,
      `Buffer: ${fmtUSD(extraCostBuffer)}`,
      `Net profit: ${fmtUSD(totalEbayRevenue)} − ${fmtUSD(totalAmazonSourcingCost)} − ${fmtUSD(totalEbayFees)} − ${fmtUSD(extraCostBuffer)} = ${fmtUSD(netProfit)}`
    ];

    return {
      inputs: {
        ebaySellPrice: ebaySellPrice || 0,
        ebayShippingCollected,
        amazonBuyPrice: amazonBuyPrice || 0,
        amazonShippingCost: amazonShippingCost || 0,
        amazonIsPrime: prime
      },
      settings: {
        ebayFeeRate: clampPct(s.ebayFeeRate),
        fixedFee,
        estimatedSalesTax: clampPct(s.estimatedSalesTax),
        extraCostBuffer
      },
      breakdown: {
        totalEbayRevenue: r2(totalEbayRevenue),
        totalAmazonSourcingCost: r2(totalAmazonSourcingCost),
        totalEbayFees: r2(totalEbayFees),
        extraCostBuffer: r2(extraCostBuffer),
        netProfit: r2(netProfit)
      },
      netProfit: r2(netProfit),
      roi: roi != null ? Math.round(roi * 10) / 10 : null,
      margin: margin != null ? Math.round(margin * 10) / 10 : null,
      isProfitable: netProfit > 0,
      warnings,
      breakdownLines
    };
  }

  /* ---------------- export shim ---------------- */
  const ARBProfit = { DEFAULT_SETTINGS, calculateArbitrageProfit, toMoney, fmtUSD };

  if (typeof module !== 'undefined' && module.exports) module.exports = { ARBProfit };
  if (typeof self !== 'undefined') self.ARBProfit = ARBProfit;

})();
