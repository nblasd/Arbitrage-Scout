/*
 * export.js — Phase 3: lead export utilities (clipboard breakdown + CSV)
 * -----------------------------------------------------------------------------
 * Pure functions, no DOM, no chrome.* APIs — runs in the popup, the worker,
 * and Node tests (same convention as profit.js / safety.js).
 *
 *   buildBreakdownText(result)  — human-readable clipboard paste
 *   buildCsv(results)           — spreadsheet-ready CSV (one row per lead)
 *   csvEscapeCell(s)            — RFC 4180 quoting (quote, escape, CRLF)
 *
 * One profit row = one arbitrage lead; the compare-table rows and the analyze
 * card both funnel through the same normalized shape so the CSV stays stable.
 */
'use strict';

(function arbExportModule() {

  /* ------------------------------------------------------------------ *
   * Cell helpers                                                        *
   * ------------------------------------------------------------------ */

  /** RFC 4180: wrap in quotes when needed and double embedded quotes. */
  function csvEscapeCell(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function csvRow(cells) {
    return cells.map(csvEscapeCell).join(',');
  }

  /** Money for display cells: $1,234.56 (or $0.00 for null). */
  const fmtMoney = (v) => {
    const n = Number(v);
    return Number.isFinite(n)
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
      : '$0.00';
  };

  const fmtPctCell = (v) => (Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)}%` : '');

  /* ------------------------------------------------------------------ *
   * Clipboard breakdown (analyze card)                                  *
   * ------------------------------------------------------------------ */
  /**
   * @param {object} result  { ebayProduct, amazonMatch, profit, safety }
   * @returns {string} multi-line, paste-anywhere text breakdown
   */
  function buildBreakdownText(result) {
    const r = result || {};
    const ep = r.ebayProduct || {};
    const am = r.amazonMatch || {};
    const pf = r.profit || {};
    const line = (c) => '='.repeat(c);
    const lines = [];

    lines.push('ARBITRAGE SCOUT — Profit Breakdown');
    lines.push(line(40));

    lines.push(`eBay:  ${ep.title || '—'}`);
    lines.push(`       ${fmtMoney(ep.price)}${Number(ep.shipping) > 0 ? ` + ${fmtMoney(ep.shipping)} shipping` : ' + Free shipping'}`);
    if (ep.url) lines.push(`       ${ep.url}`);

    lines.push(`Amazon: ${am.title || '—'}`);
    lines.push(`        ${am.price != null ? fmtMoney(am.price) : '—'}${am.isPrime ? ' (Prime)' : ''}`);
    if (am.asin) lines.push(`        ASIN: ${am.asin}`);
    if (am.url) lines.push(`        ${am.url}`);

    if (am.confidence != null) {
      lines.push(`Match confidence: ${Math.round(am.confidence * 100)}%`);
    }

    lines.push(line(40));

    const bd = pf.breakdown || {};
    lines.push(`Total eBay Revenue:       ${fmtMoney(bd.totalEbayRevenue)}`);
    lines.push(`Total Amazon Sourcing:    ${fmtMoney(bd.totalAmazonSourcingCost)}`);
    lines.push(`Total eBay Fees:          ${fmtMoney(bd.totalEbayFees)}`);
    if (Number(bd.extraCostBuffer) > 0) {
      lines.push(`Extra Cost Buffer:        ${fmtMoney(bd.extraCostBuffer)}`);
    }
    lines.push(line(40));
    lines.push(`NET PROFIT:  ${fmtMoney(pf.netProfit)}`);
    lines.push(`ROI:         ${pf.roi != null ? `${Number(pf.roi).toFixed(1)}%` : '—'}`);
    lines.push(`Margin:      ${pf.margin != null ? `${Number(pf.margin).toFixed(1)}%` : '—'}`);
    lines.push(`Verdict:     ${pf.isProfitable ? 'PROFITABLE ✓' : 'NOT PROFITABLE ✗'}`);

    const warnings = []
      .concat(pf.warnings || [])
      .concat((r.safety && r.safety.alerts ? r.safety.alerts.map((a) => a.message) : []));
    if (warnings.length) {
      lines.push('');
      lines.push('Warnings:');
      for (const w of warnings) lines.push(`  ! ${w}`);
    }

    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * CSV export (leads log)                                              *
   * ------------------------------------------------------------------ */
  const CSV_HEADERS = [
    'Captured At',
    'eBay Title',
    'eBay Price',
    'eBay Shipping',
    'eBay URL',
    'Amazon ASIN',
    'Amazon Title',
    'Amazon Price',
    'Prime',
    'Amazon URL',
    'Match Confidence %',
    'Total eBay Revenue',
    'Total Amazon Sourcing',
    'Total eBay Fees',
    'Extra Cost Buffer',
    'Net Profit',
    'ROI %',
    'Margin %',
    'Profitable',
    'Safety Alerts'
  ];

  /**
   * Normalize either flow's result into the CSV row shape.
   * Accepts {ebayProduct, amazonMatch, profit} (analyze card) or
   * {ebay, amazon, profit} (compare-table pair with `.sim`).
   */
  function normalizeLead(result, capturedAt) {
    const r = result || {};
    const ep = r.ebayProduct || r.ebay || {};
    const am = r.amazonMatch || r.amazon || {};
    const pf = r.profit || {};

    const confidence = am.confidence != null ? am.confidence
      : (r.sim != null ? r.sim / 100 : null);

    const alerts = (r.safety && Array.isArray(r.safety.alerts))
      ? r.safety.alerts.map((a) => a.message)
      : [];
    if (pf && Array.isArray(pf.warnings)) alerts.push(...pf.warnings);

    return {
      capturedAt: capturedAt instanceof Date
        ? capturedAt.toISOString()
        : String(capturedAt || new Date().toISOString()),
      ebayTitle: ep.title || '',
      ebayPrice: Number.isFinite(Number(ep.price)) ? Number(ep.price) : null,
      ebayShipping: Number.isFinite(Number(ep.shipping)) ? Number(ep.shipping) : 0,
      ebayUrl: ep.url || '',
      amazonAsin: am.asin || '',
      amazonTitle: am.title || '',
      amazonPrice: am.price != null && Number.isFinite(Number(am.price)) ? Number(am.price) : null,
      amazonPrime: !!am.isPrime,
      amazonUrl: am.url || '',
      matchConfidence: confidence != null && Number.isFinite(Number(confidence))
        ? Math.round(Number(confidence) * 100)
        : null,
      totalEbayRevenue: pf.breakdown ? pf.breakdown.totalEbayRevenue : null,
      totalAmazonSourcing: pf.breakdown ? pf.breakdown.totalAmazonSourcingCost : null,
      totalEbayFees: pf.breakdown ? pf.breakdown.totalEbayFees : null,
      extraCostBuffer: pf.breakdown ? pf.breakdown.extraCostBuffer : null,
      netProfit: pf.netProfit != null ? pf.netProfit : null,
      roi: pf.roi != null ? pf.roi : null,
      margin: pf.margin != null ? pf.margin : null,
      profitable: !!pf.isProfitable,
      safetyAlerts: alerts.join('; ')
    };
  }

  /**
   * @param {Array<object>} results  lead list (see normalizeLead)
   * @param {Date|undefined} now     timestamp source (injectable for tests)
   * @returns {string} full CSV document with header row, CRLF line endings
   */
  function buildCsv(results, now) {
    const leads = (Array.isArray(results) ? results : [])
      .map((r) => normalizeLead(r, now));
    const rows = [CSV_HEADERS.join(',')];
    for (const l of leads) {
      rows.push(csvRow([
        l.capturedAt,
        l.ebayTitle,
        l.ebayPrice,
        l.ebayShipping,
        l.ebayUrl,
        l.amazonAsin,
        l.amazonTitle,
        l.amazonPrice,
        l.amazonPrime ? 'yes' : 'no',
        l.amazonUrl,
        l.matchConfidence,
        l.totalEbayRevenue,
        l.totalAmazonSourcing,
        l.totalEbayFees,
        l.extraCostBuffer,
        l.netProfit,
        l.roi,
        l.margin,
        l.profitable ? 'yes' : 'no',
        l.safetyAlerts
      ]));
    }
    return rows.join('\r\n') + '\r\n';
  }

  /* ---------------- export shim ---------------- */
  const ARBExport = { buildBreakdownText, buildCsv, csvEscapeCell, CSV_HEADERS };

  if (typeof module !== 'undefined' && module.exports) module.exports = { ARBExport };
  if (typeof self !== 'undefined') self.ARBExport = ARBExport;

})();
