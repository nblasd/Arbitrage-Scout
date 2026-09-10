/*
 * ebay2amazon.js — Phase 1: eBay-URL → Amazon match engine
 * -----------------------------------------------------------------------------
 * Given an eBay product URL, this module turns it into the single best-matched
 * Amazon product with a 0–100 confidence score. It implements the three
 * Phase-1 pillars from the task:
 *
 *   1. DATA EXTRACTION ......... extractEbayData(url)
 *      Pulls title, price (item + shipping), description and item specifics
 *      (brand / MPN / model / UPC / EAN) out of a real eBay item page.
 *
 *   2. TITLE CLEANING / QUERY .. cleanTitleAndBuildQuery(rawTitle, specifics)
 *      Strips spam & marketing fluff, lifts out bundle quantities, extracts
 *      the core identity (brand + model/MPN + main noun) and builds an
 *      optimized Amazon search query (or a UPC/MPN-style query when we have
 *      real identifiers).
 *
 *   3. MATCHING ................ matchAmazonProduct(ebayProduct, amazonResults)
 *      Scores the top N Amazon results with token overlap + identifier locks +
 *      bundle-quantity verification and returns the best candidate with a
 *      confidence score, per-candidate breakdowns and reason strings.
 *
 * Environment-agnostic (same convention as matcher.js — no imports):
 *   - MV3 service worker : importScripts('ebay2amazon.js')  ->  self.ARBScout
 *   - Node.js tests      : require('./ebay2amazon.js')      ->  module.exports
 *
 * Design constraints:
 *   - NO external dependencies. All extraction is bounded so a poisoned /
 *     oversized page can never hang the service worker (every network or DOM
 *     wait must be raced against a timeout by the caller — see extractEbayData
 *     notes; this module adds its own wall-clock guards around DOM readiness).
 *   - All extracted fields are nullable; "missing" is never "wrong".
 *   - Scrape URLs are validated against the real eBay item-host allowlist and
 *     normalized (`/itm/<id>` canonical form) before any navigation.
 *   - Identifiers (UPC/EAN/MPN) get a huge boost but a MISMATCHED GTIN is a
 *     hard reject — matching the wrong SKU is the worst outcome for arbitrage.
 */
'use strict';

(function arbScoutModule() {

  /* ==================================================================== *
   * 1. Errors                                                            *
   * ==================================================================== */

  /**
   * Domain error class. Callers can branch on `err.code` without brittle
   * message-string matching, and the popup can show `err.userMessage`
   * verbatim while logging `err.message` for debugging.
   */
  class MatchError extends Error {
    /**
     * @param {string} code    stable machine code, see ERROR_CODES
     * @param {string} message developer-facing detail
     * @param {object} [extra] { cause, details }
     */
    constructor(code, message, extra) {
      super(message);
      this.name = 'MatchError';
      this.code = code;
      this.userMessage = USER_MESSAGES[code] || message;
      this.details = (extra && extra.details) || null;
      if (extra && extra.cause) this.cause = extra.cause;
      // Phase 3: allow callers (e.g. validateAmazonAsin) to override the
      // generic template with a situation-specific user-facing message.
      if (extra && typeof extra.userMessage === 'string' && extra.userMessage) {
        this.userMessage = extra.userMessage;
      }
    }
  }

  const ERROR_CODES = {
    INVALID_URL: 'INVALID_URL',
    NOT_EBAY_ITEM: 'NOT_EBAY_ITEM',
    FETCH_FAILED: 'FETCH_FAILED',
    TIMEOUT: 'TIMEOUT',
    PARSE_FAILED: 'PARSE_FAILED',
    NO_TITLE: 'NO_TITLE',
    NO_QUERY: 'NO_QUERY',
    NO_AMAZON_RESULTS: 'NO_AMAZON_RESULTS',
    LOW_CONFIDENCE: 'LOW_CONFIDENCE',
    QUANTITY_MISMATCH: 'QUANTITY_MISMATCH'
  };

  const USER_MESSAGES = {
    INVALID_URL: 'That doesn\'t look like a valid URL. Paste a full eBay listing link (https://www.ebay.com/itm/…).',
    NOT_EBAY_ITEM: 'This extension matches eBay *product* pages (ebay.com/itm/…). Paste an item page, not a search or profile link.',
    FETCH_FAILED: 'Couldn\'t load the eBay listing. Check your connection (or the page) and try again.',
    TIMEOUT: 'The eBay page took too long to respond. Try again, or open it once in a tab first.',
    PARSE_FAILED: 'Opened the listing but couldn\'t read the product data. eBay may have changed its layout — try another listing.',
    NO_TITLE: 'The eBay listing has no readable title, so no Amazon search could be built.',
    NO_QUERY: 'Couldn\'t build a search query from this title — it appears to be all marketing filler. Try a listing with a more descriptive title.',
    NO_AMAZON_RESULTS: 'No Amazon results came back for this product. Try searching manually.',
    LOW_CONFIDENCE: 'No confident Amazon match was found — the best candidate scored too low. Verify manually before trusting it.',
    QUANTITY_MISMATCH: 'Only quantity-mismatched candidates were found (e.g. a 12-pack vs a single). Check the pack size before buying.'
  };

  /* ==================================================================== *
   * 2. Config / tunables                                                 *
   * ==================================================================== */

  const CFG = {
    // Whole page-fetch is raced against this by the host environment's fetch
    // wrapper; we also enforce it inside extractEbayData's DOM-ready wait.
    fetchTimeoutMs: 20000,
    // DOM wait for eBay's client-side title render (eBay injects it late).
    domReadyTimeoutMs: 8000,
    // Match pipeline tunables - IMPROVED for higher match rates.
    minConfidence: 0.45,     // FINAL acceptance floor lowered from 50% to 45%
    matchListFloor: 0.35,    // Show more candidates in list, lowered from 50% to 35%
    // Reduced floor applied ONLY when the model identifier AND brand (or a
    // GTIN) both lock — the most reliable signal in e-commerce matching.
    // Real Amazon search titles are keyword-stuffed (200+ chars of fitment
    // lists), which dilutes token similarity and lands genuine same-product
    // pairs just under the generic floor; the identifier lock de-risks them.
    identifierFloor: 0.40,   // Lowered from 50% to 40%
    candidateSimThreshold: 0.15, // quick pre-filter before full scoring (lowered from 0.18)
    maxCandidates: 15,       // Increased from 10 to consider more candidates
    // Identifier queries: eBay title text is ignored for matching, but keep a
    // low-title fallback score so a GTIN hit with an odd Amazon title still wins.
    identifierQueryTokenFallback: 0.15,
    // Unit-cost bonus (cents): reward candidates whose per-unit price is closest.
    // Keeps "1x $9.99" above "12x $89.99" when everything else ties.
    unitPriceBonusMax: 0.05, // Increased from 0.03
    // Price preference: bonus for Amazon items priced LOWER than eBay
    pricePreferenceBonus: 0.08 // New: 8% bonus if Amazon price is lower
  };

  /* ==================================================================== *
   * 3. Small utilities                                                   *
   * ==================================================================== */

  const S = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

  const isBlank = (v) => v == null || (typeof v === 'string' && !v.trim());

  function escapeRe(s) {
    return S(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Lowercase fold: punctuation -> spaces, collapse whitespace. */
  function foldKey(s) {
    return S(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

  function round4(v) { return Math.round(v * 10000) / 10000; }

  /**
   * "$1,234.56" / "US $12.99" / "USD 12,99" -> 1234.56 | null.
   * (This file is .com/USD-first; regional formats fall back gracefully.)
   */
  function parseMoney(text) {
    if (text == null) return null;
    let t = S(text).replace(/\u00a0/g, ' ').trim();
    if (!t) return null;
    // European decimal comma ("12,99") when there is no thousands separator.
    const euro = /^\D*\d{1,3}(?:\.\d{3})*,\d{2}\D*$/.test(t);
    t = t.replace(/[^\d.,]/g, '');
    if (euro) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
    const m = t.match(/\d+(?:\.\d{1,2})?/);
    if (!m) return null;
    const v = parseFloat(m[0]);
    return Number.isFinite(v) && v >= 0 ? v : null;
  }

  function firstMatch(text, patterns) {
    for (const re of patterns) {
      const m = S(text).match(re);
      if (m) return m;
    }
    return null;
  }

  /* ==================================================================== *
   * 4. URL validation & normalization                                    *
   * ==================================================================== */

  const EBAY_ITEM_ID_RE = /\/itm\/(?:[^/?#]*\/)?(\d{9,15})(?=[/?#]|$)/;

  /**
   * Validate an eBay URL and extract the numeric item id.
   * Accepts full URLs, bare item ids and mobile/short forms; rejects
   * everything else (search pages, other hosts, javascript: URIs…).
   * @returns {{ itemId: string, canonicalUrl: string }}
   * @throws MatchError INVALID_URL / NOT_EBAY_ITEM
   */
  function validateEbayUrl(input) {
    const raw = S(input).trim();
    if (!raw) throw new MatchError(ERROR_CODES.INVALID_URL, 'Empty URL');

    // Bare item id?
    if (/^\d{9,15}$/.test(raw)) {
      return { itemId: raw, canonicalUrl: `https://www.ebay.com/itm/${raw}` };
    }

    let u;
    try { u = new URL(raw); }
    catch (e) {
      // Second chance: scheme-less "www.ebay.com/itm/…" input.
      try { u = new URL(`https://${raw}`); }
      catch (_) { throw new MatchError(ERROR_CODES.INVALID_URL, `Unparseable URL: ${raw}`, { cause: e }); }
    }

    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new MatchError(ERROR_CODES.INVALID_URL, `Refusing non-HTTP scheme: ${u.protocol}`);
    }
    const host = u.hostname.toLowerCase();
    // ebay.com plus regional TLDs (ebay.de, ebay.co.uk, …). Item ids are
    // global, so the canonical URL below can always point at the .com item.
    const isEbayHost = /(^|\.)ebay\.(com|[a-z]{2}(\.uk)?)$/.test(host);
    if (!isEbayHost) {
      throw new MatchError(ERROR_CODES.NOT_EBAY_ITEM, `Not an eBay host: ${host}`);
    }

    const m = u.pathname.match(EBAY_ITEM_ID_RE);
    if (!m) {
      throw new MatchError(ERROR_CODES.NOT_EBAY_ITEM,
        `URL is an eBay page but not an /itm/ product page: ${u.pathname}`);
    }
    const itemId = m[1];

    // Canonical navigation target: strip tracking params, keep the id only.
    return { itemId, canonicalUrl: `https://www.ebay.com/itm/${itemId}` };
  }

  /* ==================================================================== *
   * 5. Data extraction — extractEbayData(url)                            *
   * ==================================================================== */

  /* Item-specifics table: eBay row label -> canonical product field. */
  const SPEC_KEY_MAP = {
    'brand': 'brand',
    'manufacturer': 'brand',
    'mpn': 'mpn',
    'manufacturer part number': 'mpn',
    'part number': 'mpn',
    'model': 'model',
    'model number': 'model',
    'upc': 'upc',
    'ean': 'ean',
    'gtin': 'gtin',
    'isbn': 'isbn',
    'type': 'type',
    'color': 'color',
    'size': 'size',
    'material': 'material',
    'compatible model': 'compatibleModel'
  };

  /* GTIN shapes: UPC-A(12), EAN-13, EAN-8, GTIN-14, ISBN-13 (leading 978/979). */
  const GTIN_RE = /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/;

  function normalizeDigits(v) { return S(v).replace(/\D+/g, '') || null; }

  function looksLikeGtin(v) { return GTIN_RE.test(S(v).trim()); }

  /**
   * Parse the JSON-LD <script type="application/ld+json"> blocks eBay embeds.
   * Returns the first Product node (or null). Bounded: JSON.parse of the
   * *first* block only, wrapped in try/catch — a malformed block must never
   * throw out of extraction.
   */
  function parseLdProduct(doc) {
    if (!doc || !doc.querySelectorAll) return null;
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
      try {
        const data = JSON.parse(scripts[i].textContent || '');
        const nodes = Array.isArray(data) ? data : [data];
        for (const n of nodes) {
          if (!n || typeof n !== 'object') continue;
          // @graph wraps node lists in some eBay layouts.
          const candidates = n['@type'] ? [n] : (Array.isArray(n['@graph']) ? n['@graph'] : []);
          for (const c of candidates) {
            const t = c['@type'];
            const isProduct = t === 'Product' || (Array.isArray(t) && t.includes('Product'));
            if (isProduct) return c;
          }
        }
      } catch (_) { /* malformed JSON-LD block — try the next one */ }
    }
    return null;
  }

  /** Pull a money value out of an LD-JSON offers node (single or AggregateOffer). */
  function priceFromLdOffers(offers) {
    if (!offers) return null;
    if (offers.price != null) return parseMoney(offers.price);
    if (offers.lowPrice != null) return parseMoney(offers.lowPrice);
    if (Array.isArray(offers.offers) && offers.offers.length) {
      const prices = offers.offers.map((o) => parseMoney(o && o.price)).filter((v) => v != null);
      if (prices.length) return Math.min.apply(null, prices);
    }
    return null;
  }

  /**
   * Static-string title fallbacks, tried in order. Only *specific* slots —
   * og:title carries raw titles on every modern eBay layout.
   */
  const TITLE_FALLBACK_SELECTORS = [
    'meta[property="og:title"]',
    'h1.it-ttl',              // classic layout (struct "x-item-title")
    'h1[data-testid="x-item-title"]',
    'h1.x-item-title__mainTitle',
    '.product-title'
  ];

  /**
   * Extract product data from an already-loaded eBay item DOM.
   * (Separate from extractEbayData so the network fetch can be swapped/mocked.)
   * @param {Document} doc      parsed document (or any DOM-like root)
   * @param {string} sourceUrl  the canonical URL the doc came from
   * @returns {EbayProduct}
   */
  function extractFromDocument(doc, sourceUrl) {
    if (!doc) throw new MatchError(ERROR_CODES.PARSE_FAILED, 'No document to parse');

    /* ---- Title ---- */
    let title = '';
    const ld = parseLdProduct(doc);
    if (ld && !isBlank(ld.name)) title = S(ld.name).trim();

    if (!title) {
      for (const sel of TITLE_FALLBACK_SELECTORS) {
        const el = doc.querySelector(sel);
        const v = el && (el.getAttribute && el.getAttribute('content') != null
          ? el.getAttribute('content')
          : el.textContent);
        if (!isBlank(v)) { title = S(v).trim(); break; }
      }
    }
    // og:title sometimes carries a " | eBay" suffix.
    title = title.replace(/\s*[|·]\s*eBay\s*$/i, '').trim();

    /* ---- Price (item) ---- */
    let price = null;
    let priceText = '';
    if (ld) price = priceFromLdOffers(ld.offers);
    if (price == null) {
      const priceEl = doc.querySelector(
        '.x-price-primary [itemprop="price"], .x-price-primary, ' +
        '[data-testid="x-price-primary"] span, .display-price'
      );
      if (priceEl) {
        priceText = S(priceEl.getAttribute && priceEl.getAttribute('content') || priceEl.textContent);
        price = parseMoney(priceText);
      }
    }

    /* ---- Shipping ---- */
    let shipping = 0; // absent / "Free" both mean 0 for the buyer
    let shippingLabel = null;
    const shipEl = doc.querySelector(
      '.ux-labels-values--shipping .ux-textspans--BOLD, ' +
      '[data-testid="ux-labels-values--shipping"] .ux-textspans--BOLD, ' +
      '.vim .ux-textspans--BOLD'
    );
    if (shipEl) {
      shippingLabel = S(shipEl.textContent).trim();
      const m = shippingLabel.match(/([\d.,]+)\s*(USD|EUR|GBP|US \$|\$|€|£)/i) ||
        shippingLabel.match(/(\$|€|£|US\s*\$)\s*([\d.,]+)/i);
      if (m) {
        const v = parseMoney(m[0]);
        if (v != null) shipping = v;
      } else if (/^free/i.test(shippingLabel)) {
        shipping = 0;
      }
    }

    /* ---- Condition ---- */
    let condition = null;
    const condEl = doc.querySelector('.x-item-condition-text, [data-testid="x-item-condition-text"]');
    if (condEl) condition = S(condEl.textContent).replace(/\s+/g, ' ').trim() || null;
    if (!condition && ld && ld.itemCondition) {
      condition = S(ld.itemCondition).replace(/^https?:\/\/schema.org\//i, '');
    }

    /* ---- Description ---- */
    let description = '';
    const descEl = doc.querySelector('#desc_ifr, iframe#desc_ifr'); // classic iframe
    const descMeta = doc.querySelector('meta[name="description"], meta[property="og:description"]');
    if (descMeta) description = S(descMeta.getAttribute('content') || '').trim();
    if (descEl && descEl.getAttribute && descEl.getAttribute('src')) {
      // The description lives in a cross-origin iframe we cannot read
      // synchronously; record its URL so a caller may fetch it separately.
      description = description || '';
    }
    if (description.length > 500) description = `${description.slice(0, 497)}...`;

    /* ---- Item specifics (Brand / MPN / Model / UPC…) ---- */
    const specifics = {};
    // Layout A: rows of <dt>/<dd> inside the specifics table.
    const rows = doc.querySelectorAll('.ux-labels-values__labels, [data-testid="ux-labels-values__labels"]');
    rows.forEach((labelEl) => {
      const row = labelEl.parentElement;
      if (!row) return;
      const valueEl = row.querySelector(
        '.ux-labels-values__values, [data-testid="ux-labels-values__values"]'
      );
      if (!valueEl) return;
      const k = S(labelEl.textContent).replace(/:$/, '').trim().toLowerCase();
      const v = S(valueEl.textContent).replace(/\s+/g, ' ').trim();
      if (!k || !v) return;
      const canon = SPEC_KEY_MAP[k] || k;
      if (isBlank(specifics[canon])) specifics[canon] = v;
    });
    // Layout B: definition list (older pages).
    if (!Object.keys(specifics).length) {
      doc.querySelectorAll('dl[data-testid="ux-labels-values"] dt, div.item-details dl dt').forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (!dd) return;
        const k = S(dt.textContent).replace(/:$/, '').trim().toLowerCase();
        const v = S(dd.textContent).replace(/\s+/g, ' ').trim();
        if (!k || !v) return;
        const canon = SPEC_KEY_MAP[k] || k;
        if (isBlank(specifics[canon])) specifics[canon] = v;
      });
    }
    // Layout C: LD-JSON additionalProperty.
    if (ld && Array.isArray(ld.additionalProperty)) {
      for (const p of ld.additionalProperty) {
        const k = S(p && p.name).trim().toLowerCase();
        const v = S(p && p.value).trim();
        if (!k || !v) continue;
        const canon = SPEC_KEY_MAP[k] || k;
        if (isBlank(specifics[canon])) specifics[canon] = v;
      }
    }
    // eBay also ships identifiers in a global JS object; peek safely.
    try {
      const raw = doc.getElementById('_eeJSInit') || null; // rare; keep generic
      if (raw && raw.textContent && /"upc"/i.test(raw.textContent)) {
        const data = JSON.parse(raw.textContent);
        const item = data && (data.item || data.listing);
        if (item) {
          if (isBlank(specifics.upc) && item.upc) specifics.upc = S(item.upc);
          if (isBlank(specifics.ean) && item.ean) specifics.ean = S(item.ean);
        }
      }
    } catch (_) { /* optional path — ignore */ }

    /* ---- GTIN normalization ---- */
    const gtin = specifics.upc || specifics.ean || specifics.gtin || specifics.isbn || null;
    if (gtin && !looksLikeGtin(gtin)) {
      const digits = normalizeDigits(gtin);
      if (digits && looksLikeGtin(digits)) specifics.gtin = digits;
      else specifics.gtin = null; // junk in the field — ignore rather than poison matching
    } else if (gtin) {
      specifics.gtin = S(gtin).trim();
    }
    if (specifics.mpn) specifics.mpn = S(specifics.mpn).trim();
    if (specifics.brand) specifics.brand = S(specifics.brand).trim();

    if (!title) {
      throw new MatchError(ERROR_CODES.NO_TITLE,
        'No product title found on the eBay item page',
        { details: { sourceUrl } });
    }

    // Main product image: ordered cascade over eBay's layout variants
    // (classic #icImg hero, modern carousel, itemprop, og:image fallback).
    // Never throws — '' when nothing usable is found.
    let image = '';
    try {
      const imgSels = [
        '#icImg',
        'img[itemprop="image"]',
        '.ux-image-carousel-item.image img',
        '.ux-image-carousel-item img',
        '.ux-image-grid img',
        'meta[property="og:image"]'
      ];
      for (const sel of imgSels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const raw = el.tagName === 'META'
          ? (el.getAttribute('content') || '')
          : (el.getAttribute('src') || el.getAttribute('data-src') ||
             el.getAttribute('data-zoom-src') ||
             (el.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0] || '');
        if (/^https?:\/\//i.test(raw) && !/pixel\.gif|transparent|1x1/i.test(raw)) {
          image = raw;
          break;
        }
      }
    } catch (_) { image = ''; }

    return {
      url: sourceUrl,
      itemId: (sourceUrl.match(EBAY_ITEM_ID_RE) || [])[1] || null,
      title,
      image,
      price,
      priceText: priceText || null,
      shipping,
      shippingLabel,
      totalPrice: price != null ? round4(price + shipping) : null,
      condition,
      description,
      specifics,
      brand: specifics.brand || null,
      mpn: specifics.mpn || null,
      model: specifics.model || null,
      gtin: specifics.gtin || null,
      quantity: extractBundleQuantity(title).quantity,
      isBundle: extractBundleQuantity(title).isBundle,
      source: 'ebay',
      extractedAt: new Date().toISOString()
    };
  }

  /**
   * Fetch an eBay item page and extract product data.
   *
   * The extension's architecture (see README) drives *real tabs* rather than
   * raw fetch() to dodge CORS + bot detection. This function therefore ships
   * two fetch strategies:
   *
   *   - custom fetcher (opts.fetcher)  — used by background.js with
   *     chrome.tabs + DOMParser, or by tests with fixtures. Receives the
   *     canonical URL and must resolve to either an HTML string or a Document.
   *   - default fetch()                — plain fetch when no fetcher is given
   *     (works only where CORS allows; the service worker path always passes
   *     a fetcher). Always raced against CFG.fetchTimeoutMs.
   *
   * @param {string} url
   * @param {{ fetcher?: (url: string) => Promise<string|Document>, timeoutMs?: number }} [opts]
   * @returns {Promise<EbayProduct>}
   */
  async function extractEbayData(url, opts) {
    opts = opts || {};
    const { canonicalUrl } = validateEbayUrl(url);
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : CFG.fetchTimeoutMs;

    let html;
    try {
      if (typeof opts.fetcher === 'function') {
        // Custom fetchers (the tabs pipeline in Phase 2, test fixtures) get
        // the same wall-clock guard as the default fetch path.
        html = await withTimeout(Promise.resolve(opts.fetcher(canonicalUrl)), timeoutMs, 'fetch');
      } else if (typeof fetch === 'function') {
        html = await withTimeout(fetch(canonicalUrl, { credentials: 'omit' })
          .then((res) => {
            if (!res.ok) throw new MatchError(ERROR_CODES.FETCH_FAILED, `HTTP ${res.status} for ${canonicalUrl}`);
            return res.text();
          }), timeoutMs, 'fetch');
      } else {
        throw new MatchError(ERROR_CODES.FETCH_FAILED,
          'No fetch strategy available (pass opts.fetcher in non-DOM environments)');
      }
    } catch (err) {
      if (err instanceof MatchError) throw err;
      if (err && err.message === 'timeout:fetch') {
        throw new MatchError(ERROR_CODES.TIMEOUT, `eBay fetch timed out after ${timeoutMs}ms`, { cause: err });
      }
      throw new MatchError(ERROR_CODES.FETCH_FAILED,
        `eBay fetch failed: ${S(err && err.message || err)}`, { cause: err });
    }

    // Fetcher may return a pre-parsed Document (tabs path) or HTML string.
    let doc;
    if (typeof html === 'object' && html && typeof html.querySelector === 'function') {
      doc = html;
    } else {
      const parser = typeof DOMParser !== 'undefined' ? new DOMParser() : null;
      if (!parser) {
        throw new MatchError(ERROR_CODES.PARSE_FAILED,
          'DOMParser unavailable; pass a Document from the fetcher instead of HTML');
      }
      doc = parser.parseFromString(S(html), 'text/html');
    }

    // Bounded wait for eBay's late-rendered title (client-side layouts).
    await waitForTitle(doc, Number.isFinite(opts.domTimeoutMs) ? opts.domTimeoutMs : CFG.domReadyTimeoutMs);

    return extractFromDocument(doc, canonicalUrl);
  }

  /** Poll the doc for a title for up to `ms` (never throws; 8×100ms probes). */
  function waitForTitle(doc, ms) {
    if (!doc || typeof doc.querySelector !== 'function') return Promise.resolve(false);
    const hasTitle = () => TITLE_FALLBACK_SELECTORS.some((sel) => {
      const el = doc.querySelector(sel);
      return !!(el && S(el.textContent || (el.getAttribute && el.getAttribute('content')) || '').trim());
    }) || doc.querySelectorAll('script[type="application/ld+json"]').length > 0;

    if (hasTitle()) return Promise.resolve(true);
    const deadline = Date.now() + Math.max(0, ms);
    return new Promise((resolve) => {
      const tick = setInterval(() => {
        if (hasTitle() || Date.now() >= deadline) {
          clearInterval(tick);
          resolve(hasTitle());
        }
      }, 250);
      // Hard stop so a dead page can never leave the interval alive.
      setTimeout(() => { clearInterval(tick); resolve(hasTitle()); }, ms + 500);
    });
  }

  /** Promise.race helper — rejects with Error('timeout:<label>') after ms. */
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /* ==================================================================== *
   * 6. Bundle / multipack detection                                      *
   * ==================================================================== */

  /* "2 pack", "pack of 2", "2-pack", "2pk", "set of 3", "6 count"… */
  const PACK_PATTERNS = [
    /\bpack\s*(?:of\s*|x)?\s*(\d{1,3})\b/i,
    /(?:^|[^a-z0-9])(\d{1,3})\s*[-\s]?\s*(?:pack|pk|pcs|pieces?|ct|count|units?|bottles?|cans?|tubs?|bars?|rolls?|wipes?)\b/i,
    /\b(?:set|box)\s*(?:of\s*)?(\d{1,3})\b/i,
    /\b(\d{1,3})\s*x\b/i,
    /\bx\s*(\d{1,3})\b/i
  ];

  const MULTI_WORDS_RE = /\b(pair|twins?|duo|double|two|three|four|five|six|dozen|doz|bundle|combo|kit|variety)\b/i;
  const MULTI_MAP = { pair: 2, twin: 2, twins: 2, duo: 2, double: 2, two: 2, three: 3, four: 4, five: 5, six: 6, dozen: 12, doz: 12 };
  const SINGLE_WORDS_RE = /\b(singles?|1\s*pc|one)\b/i;

  const BUNDLE_HINT_RE = /\b(bundle|starter\s*kit|accessory\s*kit|combo|kit\b|set\b|essential[s]?\s*kit)\b/i;
  const PLUS_ITEM_RE = /(?:^|[\s(])([a-z][a-z'\-]{2,})\s*(?:\+\s*[a-z][a-z'\-]{2,}|&\s*[a-z][a-z'\-]{2,})/i;

  /**
   * Extract the multipack quantity from free text.
   * Care case: "128GB" must not parse as "8 GB" pack — patterns are anchored
   * to pack/count words, never bare digits.
   * @returns {{ quantity: number|null, isBundle: boolean, raw: string|null }}
   */
  function extractBundleQuantity(text) {
    const t = S(text);
    if (!t) return { quantity: null, isBundle: false, raw: null };

    for (const re of PACK_PATTERNS) {
      const m = t.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isInteger(n) && n >= 1 && n <= 999) {
          return { quantity: n, isBundle: n > 1, raw: m[0].trim() };
        }
      }
    }
    const mw = t.match(MULTI_WORDS_RE);
    if (mw) {
      const w = mw[1].toLowerCase();
      if (MULTI_MAP[w]) return { quantity: MULTI_MAP[w], isBundle: true, raw: w };
      if (/bundle|combo|kit|variety/.test(w)) {
        return { quantity: 2, isBundle: true, raw: w }; // heuristic floor
      }
    }
    if (SINGLE_WORDS_RE.test(t)) return { quantity: 1, isBundle: false, raw: null };
    return { quantity: null, isBundle: BUNDLE_HINT_RE.test(t) || PLUS_ITEM_RE.test(t), raw: null };
  }

  /* ==================================================================== *
   * 7. Spam / marketing keyword removal                                  *
   * ==================================================================== */

  /**
   * Marketing & filler phrases. Longest/most specific first so
   * "free fast shipping" dies in one pass instead of leaving "fast".
   * { removeAll: true } kills every word of the phrase; default removes the
   * phrase only (e.g. "NEW" but not every standalone "n").
   */
  const SPAM_PHRASES = [
    { re: /\bfast\s+(?:free\s+)?(?:and\s+)?(?:free\s+)?shipping\b/gi },
    { re: /\bfree\s+(?:fast\s+)?shipping\b/gi },
    { re: /\bfree\s+(?:shipping|returns?|delivery|gift|bonus)\b/gi },
    { re: /\bsame\s+day\s+(?:shipping|dispatch|delivery)\b/gi },
    { re: /\bfreight\s+free\b/gi },
    { re: /\bfrees?\s*ship(?:ping)?\b/gi },
    { re: /\b(?:fast|quick|express|expedited|priority|super\s*fast)\s+(?:shipping|delivery|dispatch|postage)\b/gi },
    { re: /\b(?:ships?|shipped|dispatch(?:ed)?|sent)\s+(?:from|out)\s+(?:the\s+)?(?:usa?|us|uk|united\s+states|europe|germany|france|australia|canada)\b/gi },
    { re: /\b(?:usa?|uk|eu)\s+seller\b/gi },
    { re: /\b(?:fast|immediate|same\s*day)\s+(?:dispatch|handling|postage)\b/gi },
    { re: /\bbrand\s+new\b/gi },
    { re: /\bfactory\s+(?:sealed|new|fresh)\b/gi },
    { re: /\bnew\s+(?:sealed|in\s+box|unopened)\b/gi },
    { re: /\bsealed\s+(?:new|box|in\s+box)\b/gi },
    { re: /\b(?:unopened|unused|unboxed|in\s+hand|in\s+stock|ready\s+to\s+ship|ships?\s+today|arrives?\s+before\s+(?:christmas|xmas)|in\s+time\s+for\s+(?:christmas|xmas))\b/gi },
    { re: /\bbest\s+(?:seller|price|quality|deal|value|gift)\b/gi, removeAll: true },
    { re: /\btop\s+(?:quality|seller|rated)\b/gi },
    { re: /\bhot\s+(?:sale|deal|gift|item)\b/gi },
    { re: /\b(?:wow|omg)\b/gi, removeAll: true },
    { re: /\b(?:limited|special)\s+(?:time|edition\s+sale|offer|deal)\b/gi },
    { re: /\b(?:great|perfect)\s+(?:gift|present)\b/gi },
    { re: /\bgift\s+(?:idea|set|box|wrap(?:ping)?)\b/gi },
    { re: /\b(?:christmas|xmas|birthday|holiday)\s+gift\b/gi },
    { re: /\b(?:bonus|extra|free)\s+(?:gift|item|bundle)\b/gi },
    { re: /\b(?:no\s+)?tax(?:es)?\b/gi },
    { re: /\bcustomer\s+(?:service|support)\b/gi },
    { re: /\bsatisfaction\s+guaranteed?\b/gi },
    { re: /\bmoney\s*[- ]?back\s+guarantee\b/gi },
    { re: /\breturn(?:s)?\s+accepted\b/gi },
    { re: /\b(?:genuine|authentic|original|legit)\b/gi },
    { re: /\b(?:sale|deal|offer|discount|cheapest|lowest\s+price)\b/gi },
    { re: /\bmust\s+have\b/gi },
    { re: /\btrending\b/gi },
    { re: /\bhigh\s+quality\b/gi },
    { re: /\bpremium\s+quality\b/gi },
    { re: /\bindustry[\s-]*leading\b/gi },
    { re: /\bleading[\s-]*edge\b/gi },
    { re: /\bfast\s+&?\s*free\b/gi }
  ];

  /* Condition words are noise for *identity* matching (an eBay "NEW!" prefix
   * must not dilute the query), but are not spam on Amazon either. */
  const CONDITION_NOISE_RE = /\b(?:brand[ -]?new|new|newly|unopened|opened|unsealed|sealed|unused|used|pre[ -]?owned|refurb(?:ished)?|renewed|open[ -]?box|for\s+parts|not\s+working|damaged|defective)\b/gi;

  /* These single words are always safe to drop from a query. */
  const SPAM_WORDS_RE = /\b(?:shipping|shipped|shipment|ship|ships|delivery|returns?|refunds?|seller|sale|deal|gift|bonus|free|fast|quick|expedited|priority|wow|hot|l\.a\.|new|genuine|authentic|original|musthave|trending|limited|edition|warranty|guarantee|guaranteed)\b/gi;

  /* Symbol noise: separators eBay uses everywhere. */
  const SEPARATOR_RE = /\s*(?:[|·•●★☆✅✔⭐🔥🎁⚡️→]+|\+\+|–|—)\s*/g;

  function stripSpam(title) {
    let t = ` ${S(title).replace(/\u00a0/g, ' ')} `;
    for (const { re } of SPAM_PHRASES) t = t.replace(re, ' ');
    t = t
      .replace(SEPARATOR_RE, ' ')
      .replace(/\s+[-–—]\s+/g, ' ')   // " - " used as a separator
      .replace(/^\s*[-–—|]+\s*/, '')
      .replace(/\s*[-–—|]+\s*$/, '')
      .replace(/\((?:[^()]*(?:shipping|gift|new|free|fast|sale)[^()]*)\)/gi, ' ') // parenthetical filler
      .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')                          // dates
      .replace(CONDITION_NOISE_RE, ' ')
      .replace(SPAM_WORDS_RE, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  /* ==================================================================== *
   * 8. Brand / model / MPN extraction for query building                 *
   * ==================================================================== */

  const KNOWN_BRANDS = [
    'apple', 'samsung', 'logitech', 'logitech g', 'razer', 'corsair', 'anker',
    'hyperx', 'steelseries', 'jbl', 'sony', 'bose', 'sennheiser', 'audio-technica',
    'nintendo', 'microsoft', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'msi',
    'gigabyte', 'evga', 'sapphire', 'xfx', 'crucial', 'sandisk', 'kingston',
    'wd', 'western digital', 'seagate', 'lacie', 'stanley', 'yeti', 'hydro flask',
    'nike', 'adidas', 'puma', 'new balance', 'under armour', 'vans', 'converse',
    'lego', 'hasbro', 'funko', 'dyson', 'shark', 'bissell', 'roborock', 'irobot',
    'keurig', 'ninja', 'kitchenaid', 'cuisinart', 'instant pot', 'breville',
    'philips', 'panasonic', 'sharp', 'tcl', 'hisense', 'vizio', 'lg', 'roku',
    'amd', 'intel', 'nvidia', 'gskill', 'noctua', 'be quiet', 'coolermaster',
    'cooler master', 'tp-link', 'netgear', 'asrock', 'biostar', 'mattel',
    'fisher price', 'canon', 'nikon', 'gopro', 'dji', 'fitbit', 'garmin',
    'oxo', 'lodge', 'all-clad', 'calphalon', 'pyrex', 'corningware', 'corelle',
    'brita', 'cotopaxi', 'jbl', 'sonos', 'polk', 'yamaha', 'pioneer'
  ];

  const BRAND_ALIASES = {
    'hewlett packard': 'hp', 'wd': 'western digital', 'be quiet': 'be quiet!',
    'coolermaster': 'cooler master', 'logitech g': 'logitech'
  };

  const BRAND_LOOKUP = (() => {
    const map = new Map();
    for (const b of KNOWN_BRANDS) {
      const key = foldKey(b);
      if (!map.has(key)) map.set(key, BRAND_ALIASES[key] || key);
    }
    return map;
  })();

  function extractBrandFromText(text) {
    const t = foldKey(text);
    if (!t) return null;
    
    // Check for generic/unbranded keywords first - these should NOT be treated as real brands
    const genericBrands = ['unbranded', 'generic', 'oem', 'aftermarket', 'no brand', 'nobrand'];
    for (const gb of genericBrands) {
      if (t.includes(gb)) return null; // Return null instead of treating as a brand
    }
    
    let best = null, bestLen = 0;
    for (const b of BRAND_LOOKUP.keys()) {
      if (b.length <= bestLen) continue;
      const re = new RegExp(`(?:^|\\s)${escapeRe(b)}(?:\\s|$)`);
      if (re.test(t)) { best = BRAND_LOOKUP.get(b); bestLen = b.length; }
    }
    return best;
  }

  /* Model-like tokens: alnum WITH a digit, 3–20 chars (G502, K400, RM550X).
   * Excludes pure numbers, storage ("128gb"), resolutions, years, pack counts. */
  const MODEL_EXCLUDE_RE = /^(?:\d{3,}(?:gb|tb|mb)|\d{3,}|\d{1,2}(?:gb|tb|mb|w|v|hz|mm|cm|in|ft|oz|ml|l|kg|lb|k|pk|pack|pcs?|ct|count))$/;
  // Model shapes: G502, K400, MX3S, RM550X, 1000XM5, WH1000XM5 — i.e. a
  // compact mix of <=4 leading letters and 1–6 digits with up to two trailing
  // letter/digit groups. Pure numbers, sizes ("32oz"), storage ("128gb") and
  // resolutions stay excluded via MODEL_EXCLUDE_RE + the letter requirement.
  const MODEL_TOKEN_RE = /^[a-z]{0,4}\d{1,6}[a-z]{0,3}(?:\d{0,3}[a-z]{0,3})?$|^[a-z]\d[a-z0-9]*$/;
  const MPN_LABELED_RE = /\b(?:mpn|model(?:\s*(?:no|number|#))?|part\s*(?:no|number|#)?)\s*[:#]?\s*([a-z0-9][a-z0-9\-_]{2,18})\b/i;

  function looksLikeModelToken(tok) {
    const t = tok.toLowerCase();
    if (t.length < 2 || t.length > 20) return false; // "3S", "H2" are real models
    if (MODEL_EXCLUDE_RE.test(t)) return false;
    if (!/\d/.test(t) || !/[a-z]/.test(t)) return false;
    return MODEL_TOKEN_RE.test(t);
  }

  function extractModelTokens(text) {
    const out = [];
    const labeled = S(text).match(MPN_LABELED_RE);
    if (labeled) out.push(labeled[1].toUpperCase().replace(/[^A-Z0-9\-_]/g, ''));
    for (const tok of foldKey(text).split(' ')) {
      if (looksLikeModelToken(tok) && !out.includes(tok.toUpperCase())) {
        out.push(tok.toUpperCase());
      }
    }
    return out.slice(0, 6);
  }

  /* ==================================================================== *
   * 9. Token scoring (TF-IDF-lite value ranking for the fallback path)   *
   * ==================================================================== */

  /* Ultra-generic nouns that survive spam-stripping but say nothing. */
  const LOW_VALUE_WORDS = new Set((
    'the a an and or for with without your our their this that these those ' +
    'from to of in on at by as is are was were be been being it its ' +
    'item products product parts piece pieces set kit pack lot pair case cover ' +
    'compatible replacement fits fit for use used new old generic style type ' +
    'model no number number.part size color colours colors standard regular basic deluxe value ' +
    'usa us uk eu canada australia germany france japan china'
  ).split(' '));

  /** IDF-lite: shorter tokens + rarer-in-corpus tokens are worth more. */
  function scoreTokens(tokens, corpusCounts) {
    return tokens.map((tok) => {
      const corpusFreq = corpusCounts.get(tok) || 1;
      const idf = 1 / Math.log(1 + corpusFreq);
      const lenBonus = Math.min(tok.length, 12) / 12;
      const hasDigit = /\d/.test(tok) ? 0.25 : 0;
      return { tok, score: (0.5 + 0.5 * lenBonus + hasDigit) * (0.6 + 0.4 * idf) };
    });
  }

  function countTokens(allTitles) {
    const counts = new Map();
    for (const t of allTitles) {
      const seen = new Set();
      for (const tok of foldKey(t).split(' ')) {
        if (tok.length > 1 && !seen.has(tok)) { counts.set(tok, (counts.get(tok) || 0) + 1); seen.add(tok); }
      }
    }
    return counts;
  }

  /* ==================================================================== *
   * 10. cleanTitleAndBuildQuery(rawTitle, specifics)                     *
   * ==================================================================== */

  /**
   * Turn a raw eBay title (+ optional item specifics) into an optimized
   * Amazon search query plus the metadata the matcher needs later.
   *
   * Pipeline:
   *   raw title ─▶ spam strip ─▶ bundle extraction ─▶ identity assembly
   * Identity priority:
   *   1. GTIN (UPC/EAN) present            -> identifier query ("upc …")
   *   2. MPN / model present               -> "brand + mpn + type"
   *   3. Brand + model tokens in title     -> "brand + model + main noun"
   *   4. Fallback: top 4–6 value keywords  -> first 4–6 highest-value tokens
   *
   * @param {string} rawTitle
   * @param {object} [specifics]  eBay item specifics ({ brand, mpn, model, upc, ean, … })
   * @returns {{ query, cleanedTitle, brand, model, mpn, gtin,
   *            bundleQuantity, isBundle, coreTokens, strategy, removedSpam }}
   * @throws MatchError NO_QUERY when nothing searchable survives
   */
  function cleanTitleAndBuildQuery(rawTitle, specifics) {
    const raw = S(rawTitle);
    if (!raw.trim()) {
      throw new MatchError(ERROR_CODES.NO_QUERY, 'Empty eBay title');
    }
    specifics = specifics || {};

    /* ---- 1. Strip spam / marketing fluff ---- */
    const cleaned = stripSpam(raw);
    if (!cleaned) {
      throw new MatchError(ERROR_CODES.NO_QUERY,
        `Title was entirely marketing filler: "${raw}"`);
    }

    /* ---- 2. Bundle / multipack ---- */
    const bundle = extractBundleQuantity(raw);

    /* ---- 3. Identity extraction ---- */
    const specBrand = !isBlank(specifics.brand) ? foldKey(specifics.brand) : null;
    const specMpn = !isBlank(specifics.mpn) ? S(specifics.mpn).trim() : null;
    const specModel = !isBlank(specifics.model) ? S(specifics.model).trim() : null;
    const specGtinRaw = specifics.upc || specifics.ean || specifics.gtin || null;

    const brand = specBrand || extractBrandFromText(cleaned);
    const modelTokens = [
      ...(specModel ? [specModel] : []),
      ...(specMpn ? [specMpn] : []),
      ...extractModelTokens(cleaned)
    ].filter((m, i, arr) => m && arr.indexOf(m) === i).slice(0, 6);

    // A GTIN only counts when well-formed (junk digits would poison the query).
    const gtin = specGtinRaw && looksLikeGtin(specGtinRaw) ? S(specGtinRaw).trim() : null;

    /* ---- 4. Query assembly ---- */
    let query = '';
    let strategy = '';

    if (gtin) {
      // Amazon honors raw GTIN search remarkably well — strongest possible key.
      query = gtin;
      strategy = 'gtin';
    } else if (specMpn || (specModel && modelTokens.length)) {
      const idToken = specMpn || specModel;
      const typeWords = coreTypeWords(cleaned, brand, [idToken], 4);
      // foldKey normalizes case AND splits "HRF-APP1" -> "hrf app1", which is
      // exactly how Amazon tokenizes hyphenated model numbers anyway.
      query = [brand, foldKey(idToken), ...typeWords].filter(Boolean).join(' ');
      strategy = 'mpn';
    } else if (brand && modelTokens.length) {
      // Preserve the title's own word order around brand+model+type words —
      // "logitech mx master 3s wireless mouse" reads exactly like the Amazon
      // listing instead of a reshuffled bag of tokens.
      const keep = new Set([
        foldKey(brand),
        ...modelTokens.map((m) => foldKey(m)),
        ...coreTypeWords(cleaned, brand, modelTokens, 5)
      ]);
      const words = foldKey(cleaned).split(' ').filter((w) => keep.has(w));
      query = [...new Set(words)].slice(0, 8).join(' ');
      strategy = 'brand-model';
    } else if (brand) {
      const typeWords = coreTypeWords(cleaned, brand, [], 6);
      query = [brand, ...typeWords].filter(Boolean).join(' ');
      strategy = 'brand-keywords';
    } else {
      // Fallback: 4–6 highest-value keywords from the cleaned title.
      const tokens = foldKey(cleaned).split(' ').filter((w) => w.length > 1);
      const corpus = countTokens([raw, cleaned]);
      const ranked = scoreTokens(tokens, corpus).sort((a, b) => b.score - a.score);
      const picked = ranked.slice(0, 6).map((r) => r.tok);
      if (!picked.length) {
        throw new MatchError(ERROR_CODES.NO_QUERY,
          `No searchable tokens left after spam-stripping: "${raw}"`);
      }
      // Preserve original left-to-right order (reads naturally on Amazon).
      query = tokens.filter((t) => picked.includes(t)).slice(0, 6).join(' ');
      strategy = 'keywords';
    }

    // Amazon search is case-insensitive; lowercase keeps the query visually
    // consistent with coreTokens (which are folded).
    query = query.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!query) {
      throw new MatchError(ERROR_CODES.NO_QUERY, 'Assembled query was empty');
    }

    return {
      query,
      strategy,
      cleanedTitle: cleaned,
      brand,
      model: modelTokens[0] || null,
      models: modelTokens,
      mpn: specMpn || null,
      gtin,
      bundleQuantity: bundle.quantity,
      isBundle: bundle.isBundle,
      coreTokens: foldKey(query).split(' '),
      removedSpam: raw !== cleaned
    };
  }

  /**
   * Pick the "main noun" words that follow the brand/model in the cleaned
   * title — the product TYPE words that Amazon needs to disambiguate
   * (e.g. "wireless mouse", "mechanical keyboard").
   */
  function coreTypeWords(cleanedTitle, brand, modelTokens, max) {
    let t = foldKey(cleanedTitle);
    if (brand) t = t.replace(new RegExp(`\\b${escapeRe(foldKey(brand))}\\b`, 'g'), ' ');
    for (const m of modelTokens) {
      // foldKey("WH-1000XM5") is "wh 1000xm5"; the folded title splits
      // hyphenated tokens the same way, so join the pieces with \s* to
      // remove both "wh 1000xm5" and "wh1000xm5" spellings.
      const pat = escapeRe(foldKey(m)).split(' ').join('\\s*');
      t = t.replace(new RegExp(`\\b${pat}\\b`, 'g'), ' ');
    }
    const words = t.split(' ').filter((w) =>
      w.length > 1 && !LOW_VALUE_WORDS.has(w) && !/^\d+$/.test(w));
    // Dedupe, keep order, cap.
    return [...new Set(words)].slice(0, max);
  }

  /**
   * Build progressively BROADER Amazon search queries to retry when the
   * primary cleaned query (from cleanTitleAndBuildQuery) returns zero
   * results. A strict MPN / long model string often produces an Amazon
   * no-hit page; re-searching `brand + core noun` or the first 3 key tokens
   * in the same tab session gets the search out of the 0-result dead-end.
   *
   * Order is "more specific first": brand + 3 title tokens, then brand + 2,
   * then brand + 1 noun, then query tokens without the brand. Each candidate
   * is deduplicated against the primary query and against the others, capped
   * at 2 alternatives (matching ANALYZE_FALLBACK_QUERIES_MAX in background).
   *
   * @param {object} ebayProduct  { title, specifics } from extractEbayData
   * @param {object} qInfo        result of cleanTitleAndBuildQuery()
   * @returns {string[]}  ordered broad-query fallbacks, [] if none derivable
   */
  function buildFallbackQueries(ebayProduct, qInfo) {
    if (!qInfo || !qInfo.query) return [];
    const rawTitle = S((ebayProduct && ebayProduct.title) || '');
    if (!rawTitle.trim()) return [];
    const specifics = (ebayProduct && ebayProduct.specifics) || {};

    const primary = qInfo.query.toLowerCase();
    const brand = qInfo.brand ||
      (!isBlank(specifics.brand) ? foldKey(specifics.brand) : null) ||
      extractBrandFromText(qInfo.cleanedTitle || rawTitle);
    const cleaned = qInfo.cleanedTitle || rawTitle;
    const brandKey = brand ? foldKey(brand) : null;

    // Product-type tokens of the cleaned title in original order (brand gone).
    const titleTokens = foldKey(cleaned).split(' ').filter((w) =>
      w.length > 1 && w !== brandKey && !LOW_VALUE_WORDS.has(w));
    // Distinctive tokens of the current query (may include explicit MPN/model).
    const queryTokens = (Array.isArray(qInfo.coreTokens) ? qInfo.coreTokens : [])
      .filter((w) => w.length > 1 && w !== brandKey);

    const out = [];
    const push = (str) => {
      const s = String(str).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!s || s.length < 4) return;
      if (s === primary || out.includes(s)) return;
      out.push(s);
    };

    // Level 1 — Brand + first 3 title tokens (e.g. "logitech mx master 3s").
    if (brand && titleTokens.length >= 2) {
      push([brand, ...titleTokens.slice(0, 3)].filter(Boolean).join(' '));
    }
    // Level 2 — Brand + first 2 title tokens (a bit wider).
    if (brand && titleTokens.length >= 2) {
      push([brand, ...titleTokens.slice(0, 2)].filter(Boolean).join(' '));
    }
    // Level 3 — Brand + single core noun (broadest still-branded query).
    if (brand && titleTokens.length >= 1) {
      push([brand, titleTokens[0]].filter(Boolean).join(' '));
    }
    // Level 4 — first 3 key tokens of the query itself (brand-less listings).
    if (queryTokens.length >= 3) {
      push(queryTokens.slice(0, 3).join(' '));
    }

    return out.slice(0, 2);
  }

  /* ==================================================================== *
   * 11. Text similarity (Jaccard + token containment)                    *
   * ==================================================================== */

  /**
   * Blend of Jaccard (overlap/union) and containment (overlap/smaller side).
   * Containment stops a short, precise Amazon title from losing to a long,
   * rambling eBay one purely on union size.
   */
  function titleSimilarity(a, b) {
    const A = new Set(foldKey(a).split(' ').filter((w) => w.length > 1));
    const B = new Set(foldKey(b).split(' ').filter((w) => w.length > 1));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const union = A.size + B.size - inter;
    const jaccard = inter / union;
    const containment = inter / Math.min(A.size, B.size);
    return clamp01(0.5 * jaccard + 0.5 * containment);
  }

  /* ==================================================================== *
   * 12. matchAmazonProduct(ebayProduct, amazonResults)                   *
   * ==================================================================== */

  /**
   * Score every Amazon candidate and return the best match + confidence.
   *
   * Scoring blend (weights renormalize over the signals that are available,
   * so a candidate with no comparable brand is not unfairly punished):
   *   - title similarity (Jaccard+containment, spam-stripped both sides)
   *   - identifier lock: GTIN/MPN/model token overlap on BOTH sides
   *     (both-sides-match => big boost; both-present-and-different => reject)
   *   - brand agreement (soft)
   *   - category/type-word agreement (soft)
   *   - bundle-quantity verification (both sides known & equal => boost;
   *     known & different => hard penalty, possible REJECT)
   *   - unit-price proximity tie-breaker (cents-scale nudge)
   *
   * @param {EbayProduct} ebayProduct     from extractEbayData (or {title, …})
   * @param {AmazonItem[]} amazonResults  top N search results
   * @returns {{
   *   matched: boolean, bestMatch: AmazonMatch|null,
   *   candidates: AmazonMatch[], confidence: number, matchedAmazon: AmazonMatch|null,
   *   strategy: string, warnings: string[], error: MatchError|null
   * }}
   */
  function matchAmazonProduct(ebayProduct, amazonResults) {
    const warnings = [];

    if (!ebayProduct || isBlank(ebayProduct.title)) {
      const err = new MatchError(ERROR_CODES.PARSE_FAILED,
        'ebayProduct is missing (or has no title) — run extractEbayData first');
      return { matched: false, bestMatch: null, candidates: [], confidence: 0, matchedAmazon: null, strategy: null, warnings, error: err };
    }
    const results = Array.isArray(amazonResults) ? amazonResults.filter(Boolean) : [];
    if (!results.length) {
      const err = new MatchError(ERROR_CODES.NO_AMAZON_RESULTS,
        'amazonResults was empty — nothing to match against');
      return { matched: false, bestMatch: null, candidates: [], confidence: 0, matchedAmazon: null, strategy: null, warnings, error: err };
    }

    /* ---- Build the cleaned side of the eBay listing ONCE ----
     * Accept both shapes: {title, specifics:{…}} from extractEbayData and
     * flat {title, brand, mpn, upc, …} from ad-hoc callers. Top-level fields
     * only fill gaps; they never overwrite real item specifics. */
    const specs = Object.assign({}, ebayProduct.specifics || {});
    for (const k of ['brand', 'mpn', 'model', 'upc', 'ean', 'gtin']) {
      if (!isBlank(ebayProduct[k]) && isBlank(specs[k])) specs[k] = ebayProduct[k];
    }
    let q;
    try {
      q = cleanTitleAndBuildQuery(ebayProduct.title, specs);
    } catch (err) {
      return { matched: false, bestMatch: null, candidates: [], confidence: 0, matchedAmazon: null, strategy: null, warnings, error: err };
    }
    if (ebayProduct.quantity == null) {
      // Callers that skipped extractEbayData may not carry a quantity yet.
      ebayProduct.quantity = q.bundleQuantity;
    }

    const ebayClean = q.cleanedTitle;
    const ebayTokens = new Set(q.coreTokens);

    /* ---- Stage 1: cheap candidate pre-filter (recall-first) ---- */
    const pre = [];
    for (let i = 0; i < Math.min(results.length, CFG.maxCandidates * 4); i++) {
      const a = results[i];
      const sim = titleSimilarity(ebayClean, stripSpam(S(a.title)));
      if (sim >= CFG.candidateSimThreshold || q.gtin) pre.push({ idx: i, item: a, sim });
    }
    if (!pre.length && results.length) {
      // Keep at least the top-3 by position — a GTIN-less exact rename can
      // survive only via position prior; better to score it than to fail.
      results.slice(0, 3).forEach((item, idx) => pre.push({ idx, item, sim: 0 }));
    }
    pre.sort((x, y) => y.sim - x.sim);
    const candidatesIn = pre.slice(0, CFG.maxCandidates);

    /* ---- Stage 2: full scoring ---- */
    // Category/type agreement compares the full cleaned titles (a GTIN query
    // carries no type words, so q.coreTokens would be useless there).
    const ebayTitleTokens = new Set(foldKey(ebayClean).split(' ').filter((w) => w.length > 1));
    const scored = candidatesIn.map(({ idx, item }) => {
      const r = scoreCandidate(q, ebayProduct, ebayClean, ebayTitleTokens, item);
      r.rank = idx; // preserve original Amazon search order
      return r;
    });

    scored.sort((x, y) => y.score - x.score || x.rank - y.rank);

    const best = scored[0] || null;
    // Acceptance floor: CFG.minConfidence for generic title-driven matches;
    // CFG.identifierFloor when the model identifier AND brand (or a GTIN) both
    // lock. A dual lock cannot be explained by a coincidentally similar title,
    // so a stuffed-title similarity dip must not silently discard the pair.
    const dualLock = !!(best && best.signals &&
      best.signals.identifier === 1 &&
      (best.signals.brand === 1 || q.gtin));
    const floor = dualLock
      ? Math.min(CFG.minConfidence, CFG.identifierFloor)
      : CFG.minConfidence;
    const matchedAmazon = best && best.score >= floor ? best : null;
    const matched = !!matchedAmazon;

    if (!matched && best) {
      if (best.signals.bundleVerdict === 'mismatch') {
        warnings.push('Best candidate was rejected: pack-size mismatch (single vs multipack).');
      }
      warnings.push(`Best candidate scored ${(best.score * 100).toFixed(0)}% (below the ${(floor * 100).toFixed(0)}% threshold).`);
    }
    if (matched && dualLock && best.score < CFG.minConfidence) {
      warnings.push(`Accepted via model+brand identifier lock (scored ${(best.score * 100).toFixed(0)}%).`);
    }
    // Strict-identifier hit with weak title = trust the identifiers, add note.
    if (matched && q.gtin && best.signals.identifier === 1 && best.signals.title < 0.35) {
      warnings.push('Matched by UPC/GTIN — Amazon title differs from the eBay wording.');
    }

    return {
      matched,
      bestMatch: best,
      matchedAmazon, // alias for call sites that expect "the accepted one"
      candidates: scored,
      // Every candidate at/above the 50% floor, best first — the popup lists
      // these under the primary pick so the user can pick an alternative.
      matches: scored.filter((c) => c.score >= CFG.matchListFloor),
      confidence: best ? round4(best.score) : 0,
      strategy: q.strategy,
      warnings,
      error: matched ? null
        : (best && best.signals.bundleVerdict === 'mismatch'
          ? new MatchError(ERROR_CODES.QUANTITY_MISMATCH,
            'Only quantity-mismatched candidates found', { details: { best } })
          : new MatchError(ERROR_CODES.LOW_CONFIDENCE,
            `Best candidate ${best ? `${(best.score * 100).toFixed(0)}%` : 'n/a'} < ${CFG.minConfidence * 100}%`,
            { details: { best } }))
    };
  }

  /**
   * Score one (cleaned-ebay, amazon-candidate) pair.
   * Kept separate from matchAmazonProduct for testability.
   */
  function scoreCandidate(q, ebayProduct, ebayClean, ebayTokens, amazonItem) {
    const amazonTitle = S(amazonItem.title);
    const amazonCleanFull = stripSpam(amazonTitle);
    // Amazon search titles are keyword-stuffed far past the identity info
    // (fitment lists, compat claims, marketing) — identity tokens are
    // front-loaded. Comparing the FULL stuffed title dilutes token-overlap
    // similarity and systematically under-scores genuine matches, so the
    // title-similarity input is bounded to the identity-bearing prefix while
    // the full text still feeds the model/brand/category signals.
    const amazonClean = amazonCleanFull.slice(0, 160);
    const amazonTokensSet = new Set(foldKey(amazonCleanFull).split(' ').filter((w) => w.length > 1));
    const signals = {};
    const reasons = [];

    /* --- Title similarity (on CLEANED text, both sides) --- */
    signals.title = titleSimilarity(ebayClean, amazonClean);

    /* --- Identifier lock: GTIN / MPN / model overlap --- */
    let identifier = null; // null = not comparable
    if (q.gtin) {
      const amazonGtin = amazonItem.asin || amazonItem.upc || amazonItem.ean || null;
      // Amazon hides UPCs from search pages; a GTIN match against ASIN is not
      // meaningful. Instead: presence of the GTIN in the Amazon title/desc.
      const inTitle = foldKey(amazonTitle).includes(foldKey(q.gtin));
      identifier = inTitle ? 1 : null; // absence is not evidence of difference
      if (inTitle) reasons.push('GTIN appears in Amazon listing');
    }
    const modelCmp = compareModelTokens(q.models, extractModelTokens(amazonCleanFull));
    if (identifier == null) {
      identifier = modelCmp === 'match' ? 1 : modelCmp === 'mismatch' ? 0 : null;
      if (modelCmp === 'match') reasons.push(`Model identifier matches (${q.models.join('/')})`);
      if (modelCmp === 'mismatch') reasons.push('Model identifier differs');
    }
    signals.identifier = identifier;

    /* --- Brand agreement --- */
    const amazonBrand = !isBlank(amazonItem.brand) ? S(amazonItem.brand) : extractBrandFromText(amazonClean);
    if (q.brand && amazonBrand) {
      signals.brand = foldKey(q.brand) === foldKey(amazonBrand) ? 1 : 0;
      if (signals.brand === 0) reasons.push(`Brand differs (${q.brand} vs ${amazonBrand})`);
    } else signals.brand = null;

    /* --- Category / type-word agreement --- */
    const sharedType = [...ebayTokens].filter((w) => amazonTokensSet.has(w) && !LOW_VALUE_WORDS.has(w));
    const typeUnion = new Set([...ebayTokens, ...amazonTokensSet]).size;
    signals.category = typeUnion ? sharedType.length / typeUnion : null;
    if (sharedType.length >= 3) reasons.push(`Shared descriptors: ${sharedType.slice(0, 4).join(', ')}`);

    /* --- Multipack verification --- */
    const amzBundle = amazonItem.quantity != null
      ? { quantity: amazonItem.quantity, isBundle: amazonItem.quantity > 1 }
      : extractBundleQuantity(amazonTitle);
    let bundleScore = null;
    let bundleVerdict = 'unknown';
    if (q.bundleQuantity != null && amzBundle.quantity != null) {
      if (q.bundleQuantity === amzBundle.quantity) {
        bundleScore = 1; bundleVerdict = 'match';
        if (q.bundleQuantity > 1) reasons.push(`Both are ${q.bundleQuantity}-packs`);
      } else {
        bundleScore = 0; bundleVerdict = 'mismatch';
        reasons.push(`Pack size differs: eBay ${q.bundleQuantity} vs Amazon ${amzBundle.quantity}`);
      }
    } else if (q.bundleQuantity == null && amzBundle.quantity === 1) {
      // Amazon explicitly says 1, eBay silent — compatible.
      bundleScore = 0.9; bundleVerdict = 'compatible';
    }
    signals.bundle = bundleScore;

    /* --- Unit-price proximity tie-breaker (when quantities match) --- */
    let unitPriceBonus = 0;
    if (bundleVerdict !== 'mismatch' &&
        Number.isFinite(ebayProduct.totalPrice) && Number.isFinite(amazonItem.price) &&
        ebayProduct.totalPrice > 0 && amazonItem.price > 0) {
      const ratio = Math.min(ebayProduct.totalPrice, amazonItem.price) /
        Math.max(ebayProduct.totalPrice, amazonItem.price);
      unitPriceBonus = clamp01(ratio) * CFG.unitPriceBonusMax;
    }

    /* --- Weighted blend (available signals renormalize) --- */
    // Rebalanced weights: heavier on title/semantic, lighter on strict identifiers
    const WEIGHTS = { identifier: 0.20, title: 0.40, brand: 0.12, category: 0.15, bundle: 0.13 };
    let acc = 0, wsum = 0;
    for (const [k, w] of Object.entries(WEIGHTS)) {
      const v = signals[k];
      if (v == null) continue;
      acc += w * v;
      wsum += w;
    }
    let score = wsum > 0 ? acc / wsum : 0;

    /* --- Hard penalties --- */
    if (bundleVerdict === 'mismatch') score -= 0.45;      // single vs 12-pack
    // Relaxed brand penalty: only penalize if BOTH brand AND identifier conflict
    if (signals.brand === 0 && signals.identifier === 0) score -= 0.20;
    else if (signals.brand === 0 && q.brand && q.brand.toLowerCase() !== 'unbranded' && q.brand.toLowerCase() !== 'generic') score -= 0.10;
    
    score += unitPriceBonus;
    
    // NEW: Price preference bonus - reward Amazon items priced LOWER than eBay
    if (Number.isFinite(ebayProduct.totalPrice) && Number.isFinite(amazonItem.price) &&
        amazonItem.price > 0 && ebayProduct.totalPrice > 0) {
      if (amazonItem.price < ebayProduct.totalPrice) {
        score += CFG.pricePreferenceBonus; // 8% bonus for lower Amazon price
      }
    }

    // Identifier double-lock bonus: model AND brand both confirmed => the
    // single most reliable signal in e-commerce matching.
    if (signals.identifier === 1 && signals.brand === 1) score += 0.10;
    else if (signals.identifier === 1) score += 0.08;

    score = round4(clamp01(score));

    return {
      asin: amazonItem.asin || null,
      title: amazonTitle,
      price: Number.isFinite(amazonItem.price) ? amazonItem.price : null,
      url: amazonItem.url || null,
      image: amazonItem.image || null,
      // Carried through for the Phase-2 profit engine ($0 shipping when Prime).
      isPrime: !!amazonItem.isPrime,
      rating: Number.isFinite(amazonItem.rating) ? amazonItem.rating : null,
      score,
      signals,
      reasons: reasons.slice(0, 6),
      rank: 0
    };
  }

  /** Compare two model-token lists: exact or (>=4-char) token containment. */
  function compareModelTokens(a, b) {
    const A = Array.isArray(a) ? a : [];
    const B = Array.isArray(b) ? b : [];
    if (!A.length || !B.length) return 'unknown';
    for (const x of A) {
      const xl = x.toLowerCase();
      for (const y of B) {
        const yl = y.toLowerCase();
        if (xl === yl) return 'match';
        if (xl.length >= 4 && yl.includes(xl)) return 'match';
        if (yl.length >= 4 && xl.includes(yl)) return 'match';
      }
    }
    return 'mismatch';
  }

  /* ==================================================================== *
   * 13. Amazon identifier validation (Phase 3: manual match override)    *
   * ==================================================================== */

  const ASIN_RE = /^B[0-9A-Z]{9}$/;

  /**
   * Phase 3 manual match override: accept a pasted Amazon ASIN or URL and
   * normalize it to a clean { asin, url } pair. Accepts:
   *   - a bare ASIN:            "B08N5WRWNW"
   *   - a dp/product URL:       https://www.amazon.com/dp/B08N5WRWNW?th=1
   *   - a short URL:            https://amzn.to/3xyz (no ASIN extractable —
   *     rejected; the user must paste the full product link)
   *
   * @param {string} input
   * @returns {{ asin: string, url: string }}
   * @throws MatchError code ASIN_INVALID (stable branchable code)
   */
  function validateAmazonAsin(input) {
    const raw = S(input).trim();
    if (!raw) {
      throw new MatchError('ASIN_INVALID', 'Empty ASIN/URL input',
        { userMessage: 'Paste an Amazon ASIN (B0XXXXXXXXXX) or product URL.' });
    }

    // Bare ASIN (case-insensitive on the B; canonicalize to uppercase).
    if (/^[0-9A-Za-z]{10}$/.test(raw) && ASIN_RE.test(raw.toUpperCase())) {
      const asin = raw.toUpperCase();
      return { asin, url: `https://www.amazon.com/dp/${asin}` };
    }

    // Otherwise it must be a URL that embeds an ASIN.
    let u = null;
    try { u = new URL(raw); } catch (_) { u = null; }
    if (!u || !/^https?:$/.test(u.protocol) ||
        !/(^|\.)amazon\.(com|ca|co\.uk|de|fr|es|it|co\.jp|com\.au|com\.mx)$/i.test(u.hostname)) {
      throw new MatchError('ASIN_INVALID', `Not an Amazon ASIN or product URL: "${raw.slice(0, 80)}"`,
        { userMessage: 'That is not an Amazon ASIN or amazon.com product URL.' });
    }

    const m = /(?:\/dp\/|\/(?:gp\/)?product\/)(?:-\/en\/)?([0-9A-Za-z]{10})(?:[/?#]|$)/.exec(u.pathname) ||
              /[?&]asin=([0-9A-Za-z]{10})/i.exec(u.search);
    const asin = m ? m[1].toUpperCase() : null;
    if (!asin || !ASIN_RE.test(asin)) {
      throw new MatchError('ASIN_INVALID', `No ASIN found in Amazon URL: "${raw.slice(0, 120)}"`,
        { userMessage: 'Could not find an ASIN in that link — paste the product page URL (amazon.com/dp/B0XXXXXXXXXX).' });
    }
    return { asin, url: `https://www.amazon.com/dp/${asin}` };
  }

  /* ==================================================================== *
   * 14. Amazon search URL (Phase 2 helper)                               *
   * ==================================================================== */

  /**
   * Build the Amazon search URL for a cleaned query.
   * content.js already auto-runs on /s?k=… pages and extracts `k` from the
   * URL, so no state passing is needed — background.js only has to open this
   * URL in a tab and wait for ARB_RESULTS.
   * @param {string} query  cleaned query from cleanTitleAndBuildQuery().query
   * @param {number} [page] 1-based page number
   */
  function buildAmazonSearchUrl(query, page) {
    const q = S(query).trim();
    if (!q) throw new MatchError(ERROR_CODES.NO_QUERY, 'Empty Amazon search query');
    const p = Math.max(1, Math.floor(Number(page) || 1));
    return `https://www.amazon.com/s?k=${encodeURIComponent(q)}&page=${p}&ref=sr_pg_${p}`;
  }

  /* ==================================================================== *
   * 15. Public surface + export shim                                     *
   * ==================================================================== */

  const ARBScout = {
    ERROR_CODES,
    MatchError,
    CFG,
    validateEbayUrl,
    validateAmazonAsin,
    buildAmazonSearchUrl,
    extractEbayData,
    extractFromDocument,
    cleanTitleAndBuildQuery,
    buildFallbackQueries,
    extractBundleQuantity,
    stripSpam,
    extractBrandFromText,
    extractModelTokens,
    titleSimilarity,
    matchAmazonProduct,
    parseMoney
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = { ARBScout };
  if (typeof self !== 'undefined') self.ARBScout = ARBScout;

})(); /* end arbScoutModule */
