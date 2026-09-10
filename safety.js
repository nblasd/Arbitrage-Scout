/*
 * safety.js — Phase 3: multipack & variation safety harness
 * -----------------------------------------------------------------------------
 * Pure logic, no DOM, no network, no chrome.* APIs — runs in the service
 * worker, the popup, and Node tests (same convention as profit.js).
 *
 * Two independent guards over an (eBay product, matched Amazon product) pair:
 *
 *   1. VARIATION MISMATCH GUARD
 *      The eBay listing name is scanned for variation descriptors — colors,
 *      apparel sizes, capacity/volume figures ("128GB", "40oz") and a short
 *      style-word list — plus any color/size/style ITEM SPECIFICS eBay
 *      reported. Every descriptor found must also appear in the Amazon
 *      title; anything missing (or a "various colors" generic-parent title
 *      on Amazon) raises a soft alert:
 *        "Variation Alert: Verify color/size on Amazon before ordering."
 *      Why soft: the eBay variation may genuinely not be titled on Amazon
 *      (styling, case differences) — the user must eyeball it, so we flag
 *      without rejecting.
 *
 *   2. QUANTITY / UNIT-COST DISCREPANCY ALERT
 *      The eBay bundle quantity (Phase 1 `bundleQuantity`) is compared
 *      against the Amazon listing's quantity (its `quantity` field when the
 *      scraper captured one, else pack-language parsed from its title —
 *      no pack language at all means a single unit). A mismatch is a HARD
 *      alert because the profit math is structurally wrong:
 *        "Quantity Mismatch Detected — ROI calculation may be inaccurate."
 *
 * assessSafety() returns both as a render-ready alert list. The background
 * stores it on the analyze state; the popup paints it above the profit box.
 */
'use strict';

(function arbSafetyModule() {

  /* ------------------------------------------------------------------ *
   * Descriptor word lists (folded = lowercase)                          *
   * ------------------------------------------------------------------ */
  const COLOR_WORDS = new Set(('black white blue red green yellow orange purple pink brown gray grey ' +
    'silver gold beige tan teal navy maroon turquoise lavender clear multicolor matte glossy').split(' '));

  // Multi-char sizes only: single letters ("M", "L") substring-match almost
  // any title and would never fire — harmless but useless. Keep explicit
  // letter pairs (XS/XL) and bed/letters sizes that are distinctive.
  const SIZE_WORDS = new Set(('xs s:m l xl 2xl xxl 3xl xxxl small medium large xlarge ' +
    'petite tall twin full queen king californiaking').split(' ').filter((w) => !w.includes(':')));

  const STYLE_WORDS = new Set(('slim standard long short wide narrow compact mini pro max plus lite ultra ' +
    'classic premium deluxe elite folding foldable rechargeable wireless').split(' '));

  /** Fold text for comparison: lowercase, punctuation -> spaces, squeeze. */
  function foldVariationText(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Capacity/volume tokens: "128GB", "40 oz", "1.5L", "32 Count".
   * Normalized to value+unit with no space ("128gb", "40oz") so eBay's
   * "40 oz" matches Amazon's "40oz" spelling.
   */
  const CAPACITY_RE = /(\d+(?:\.\d+)?)\s*(gb|tb|mb|oz|ml|lb|kg|count|ct)\b/g;

  function extractVariationTokens(title, specifics) {
    const out = new Set();
    const add = (v) => { if (v) out.add(v); };

    const hay = foldVariationText(title);
    for (const w of hay.split(' ')) {
      if (COLOR_WORDS.has(w) || SIZE_WORDS.has(w) || STYLE_WORDS.has(w)) add(w);
    }
    // Capacity figures (also catches "128gb" already squashed in the title).
    let m;
    const flat = hay.replace(/ /g, '');
    CAPACITY_RE.lastIndex = 0;
    while ((m = CAPACITY_RE.exec(flat))) add(`${m[1]}${m[2]}`);
    // Same scan over the spaced text (unit separated by a space).
    CAPACITY_RE.lastIndex = 0;
    while ((m = CAPACITY_RE.exec(hay))) add(`${m[1]}${m[2]}`);

    // eBay item specifics override everything (structured beats guessed).
    if (specifics && typeof specifics === 'object') {
      for (const key of ['color', 'colour', 'size', 'style', 'capacity', 'model']) {
        const v = specifics[key];
        if (v == null || String(v).trim() === '') continue;
        const folded = foldVariationText(v);
        for (const w of folded.split(' ')) {
          if (COLOR_WORDS.has(w) || SIZE_WORDS.has(w) || STYLE_WORDS.has(w)) add(w);
        }
        CAPACITY_RE.lastIndex = 0;
        while ((m = CAPACITY_RE.exec(folded.replace(/ /g, '')))) add(`${m[1]}${m[2]}`);
      }
    }
    return Array.from(out);
  }

  /** Amazon titles for generic parent ASINs often list every variation. */
  const GENERIC_PARENT_RE = /(?:various|multiple|assorted|different|several)\s+(?:colors|colours|styles|sizes|patterns)|colors?\s*:?\s*\w+\s*\/\s*\w+/;

  /* ------------------------------------------------------------------ *
   * Guard 1: variation mismatch                                         *
   * ------------------------------------------------------------------ */
  /**
   * @param {object} ebayProduct   { title, specifics, ... }
   * @param {object} amazonProduct { title, quantity, ... }
   * @returns {{ hasVariation, conflict, missing: string[], messages: string[] }}
   */
  function detectVariationMismatch(ebayProduct, amazonProduct) {
    const result = { hasVariation: false, conflict: false, missing: [], messages: [] };
    const ep = ebayProduct || {};
    const ap = amazonProduct || {};
    if (!ep.title || !ap.title) return result;

    const vars = extractVariationTokens(ep.title, ep.specifics);
    if (!vars.length) return result; // eBay did not specify a variation — nothing to guard
    result.hasVariation = true;

    const amazonHay = foldVariationText(ap.title) + ' ' + foldVariationText(ap.title).replace(/ /g, '');
    const missing = vars.filter((v) => !amazonHay.includes(v));
    result.missing = missing;

    const generic = GENERIC_PARENT_RE.test(foldVariationText(ap.title));
    if (missing.length || generic) {
      result.conflict = true;
      result.messages.push('Variation Alert: Verify color/size on Amazon before ordering.');
      if (missing.length) {
        result.messages.push(`eBay specifies "${missing.slice(0, 4).join('", "')}" but the Amazon title does not mention it.`);
      }
      if (generic) {
        result.messages.push('The Amazon title looks like a generic parent listing (multiple variations).');
      }
    }
    return result;
  }

  /* ------------------------------------------------------------------ *
   * Guard 2: quantity / unit-cost discrepancy                           *
   * ------------------------------------------------------------------ */

  /**
   * Pack language on an Amazon title -> unit count. No pack language at all
   * means a single unit (Amazon search pages virtually never omit it for
   * multipacks). Mirrors the core patterns from ebay2amazon.js
   * extractBundleQuantity without importing it.
   */
  const AMAZON_QTY_PATTERNS = [
    /\bpack\s+of\s+(\d{1,4})\b/i,
    /\b(\d{1,4})\s*-?\s*pack\b/i,
    /\b(\d{1,4})\s*pk\b(?!\w)/i,
    /\b(\d{1,4})\s*(?:count|ct)\b/i,
    /\bset\s+of\s+(\d{1,4})\b/i,
    /\b(\d{1,4})\s*(?:bottles|cans|tabs|tablets|capsules|pods|bars|rolls|wipes|pouches)\b/i
  ];

  function amazonQuantityFromTitle(title) {
    const t = String(title == null ? '' : title).toLowerCase();
    for (const re of AMAZON_QTY_PATTERNS) {
      const m = re.exec(t);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isInteger(n) && n >= 1 && n <= 9999) return n;
      }
    }
    return 1; // no pack language => single unit
  }

  /**
   * @param {number|null} ebayQuantity  Phase-1 bundleQuantity (null = single/silent)
   * @param {object} amazonProduct      { title, quantity? }
   * @returns {{ level: 'ok'|'warning'|'unknown', ebayQuantity, amazonQuantity, messages }}
   */
  function checkQuantityAlignment(ebayQuantity, amazonProduct) {
    const ap = amazonProduct || {};
    const ebayQty = Number.isInteger(ebayQuantity) && ebayQuantity > 0
      ? ebayQuantity
      : (ebayQuantity == null ? 1 : null);
    const amazonQty = ap.quantity != null && Number.isInteger(ap.quantity) && ap.quantity > 0
      ? ap.quantity
      : amazonQuantityFromTitle(ap.title);

    const result = { level: 'unknown', ebayQuantity: ebayQty, amazonQuantity: amazonQty, messages: [] };
    if (ebayQty == null || amazonQty == null) return result; // can't compare

    if (ebayQty === amazonQty) {
      result.level = 'ok';
      return result;
    }
    result.level = 'warning';
    result.messages.push('Quantity Mismatch Detected — ROI calculation may be inaccurate.');
    result.messages.push(`eBay is a ${ebayQty === 1 ? 'single unit' : `${ebayQty}-pack`} but the Amazon listing is a ${amazonQty === 1 ? 'single unit' : `${amazonQty}-pack`}.`);
    return result;
  }

  /* ------------------------------------------------------------------ *
   * Combined assessment                                                 *
   * ------------------------------------------------------------------ */
  /**
   * @param {object} ebayProduct    Phase-1 EbayProduct (title, specifics, quantity…)
   * @param {object} amazonProduct  matched candidate (title, quantity?, isPrime…)
   * @returns {{
   *   alerts: [{code: 'VARIATION_MISMATCH'|'QUANTITY_MISMATCH', level: 'soft'|'hard', message}],
   *   hardWarning: boolean, variation: object, quantity: object
   * }}
   */
  function assessSafety(ebayProduct, amazonProduct) {
    const alerts = [];

    const variation = detectVariationMismatch(ebayProduct, amazonProduct);
    if (variation.conflict) {
      alerts.push({
        code: 'VARIATION_MISMATCH',
        level: 'soft',
        message: variation.messages.join(' ')
      });
    }

    const quantity = checkQuantityAlignment(
      ebayProduct && ebayProduct.quantity != null ? ebayProduct.quantity : null,
      amazonProduct
    );
    if (quantity.level === 'warning') {
      alerts.push({
        code: 'QUANTITY_MISMATCH',
        level: 'hard',
        message: quantity.messages.join(' ')
      });
    }

    return {
      alerts,
      hardWarning: alerts.some((a) => a.level === 'hard'),
      variation,
      quantity
    };
  }

  /* ---------------- export shim ---------------- */
  const ARBSafety = {
    assessSafety,
    detectVariationMismatch,
    checkQuantityAlignment,
    extractVariationTokens,
    amazonQuantityFromTitle
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = { ARBSafety };
  if (typeof self !== 'undefined') self.ARBSafety = ARBSafety;

})();
