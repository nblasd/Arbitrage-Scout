/*
 * content.js — Search-result scraper for Amazon & eBay
 * -----------------------------------------------------------------------------
 * Runs (via manifest content_scripts) only on:
 *   - https://www.amazon.com/*        (search pages parse; other pages report
 *                                      'no-results-page' so the run never hangs)
 *   - https://www.ebay.com/*          (same policy)
 *
 * What it does:
 *   1. Detects which marketplace it is on and extracts the search query
 *      straight from the URL (no state passing needed).
 *   2. Waits a short random "human-like" amount of time, scrolls the page in a
 *      few small random steps, then extracts result cards.
 *   3. Uses a CASCADE of DOM selector strategies so a layout change on the
 *      site rarely bricks extraction — each strategy has fallbacks, ending in
 *      a generic anchor-based scan.
 *   4. Reports results to background.js with { type: 'ARB_RESULTS' }.
 *
 * Anti-hang design (the "spinner forever" fix):
 *   - Every await is wrapped so it can be *interrupted*. If the background
 *     re-runs the scraper (Parse again / re-injection), the old script
 *     instance aborts within one pause instead of silently racing the new one.
 *   - The whole parse is bounded by a hard wall-clock deadline (SCRAPE_DEADLINE_MS).
 *     setTimeout / scrolling / DOM-waiting can never exceed it — the run ends
 *     with a clear error instead of hanging forever.
 *   - If the result grid hasn't rendered yet, we wait on DOM mutations but
 *     with a *bounded* timeout — never an unbounded observer.
 *
 * Honest limitations (by design):
 *   - The random delays/scrolls below are *pacing* to keep request volume low
 *     and human-paced. They do NOT and cannot defeat bot detection. Amazon in
 *     particular may still serve a CAPTCHA — if that happens the background
 *     worker reports "blocked" and you can solve it in the open tab and click
 *     "Parse again". Respect each site's ToS, robots.txt and rate limits, and
 *     keep usage personal / low-volume. Prefer official APIs for production.
 *   - This file targets the US .com marketplaces (USD). For other regions add
 *     the TLD to manifest.json and adjust currency handling.
 */
(() => {
  'use strict';

  // If the extension was reloaded/updated, this page's script instance belongs
  // to a dead extension context: do nothing at all.
  if (!chrome.runtime || !chrome.runtime.id) return;

/* ------------------------------------------------------------------ *
 * Tunables (edit freely)
 * ------------------------------------------------------------------ */
const CFG = {
  // HARD ceiling for the whole scrape (pacing + scrolling + parsing).
  // Everything is raced against this deadline; a run can never outlive it.
  scrapeDeadlineMs: 15000,
  // Max extra time to wait for Amazon's lazy/client-rendered result grid,
  // once the page looks alive. Bounded — never an unbounded observer.
  gridWaitMs: 12000,
  // Random pre-parse wait (ms) — mimics a person reading the page first.
  // SKIPPED entirely when the tab is hidden/backgrounded (a background tab
  // would otherwise sit through the full pacing delay before reporting).
  preParseMinMs: 500,
  preParseMaxMs: 1500,
  // Pauses between parsing steps (ms).
  pauseMinMs: 100,
  pauseMaxMs: 300,
  // Scroll simulation parameters.
  scrollMinPx: 300,
  scrollMaxPx: 700,
  scrollStepsMin: 3,
  scrollStepsMax: 5,
  // Max items reported per site.
  maxItems: { amazon: 50, ebay: 80 }
};

/* ------------------------------------------------------------------ *
 * Site / page detection
 * ------------------------------------------------------------------ */
const HOST = location.hostname.toLowerCase();
const SITE = HOST === 'amazon.com' || HOST.endsWith('.amazon.com')
  ? 'amazon'
  : HOST === 'ebay.com' || HOST.endsWith('.ebay.com')
    ? 'ebay'
    : null;

// Not one of the supported marketplaces -> do nothing.
if (!SITE) return;

const isSearchPath =
  SITE === 'amazon' ? /^\/(s|gp\/search)(\/|$)/.test(location.pathname)
                    : /^\/sch(\/|$)/.test(location.pathname);

  function readQueryFromUrl() {
    try {
      const p = new URLSearchParams(location.search);
      return SITE === 'amazon' ? (p.get('k') || '').trim()
                               : (p.get('_nkw') || '').trim();
    } catch (_) { return ''; }
  }
  const QUERY = readQueryFromUrl();

  /* ------------------------------------------------------------------ *
   * Run token — makes every async step interruptible
   * ------------------------------------------------------------------ *
   * Two script instances can end up on one page: the original injection and
   * a re-injection triggered by "Parse again". Each gets a unique RUN token.
   * report() drops results from superseded runs, and every sleep/scroll
   * bails out early once its run is no longer current — so the old instance
   * can never deadlock the flow or race the new one.
   */
  let currentRun = null;

  function makeRun() {
    const run = { id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, dead: false };
    currentRun = run;
    return run;
  }
  const isCurrent = (run) => run && !run.dead && run === currentRun;
  const killCurrent = () => { if (currentRun) currentRun.dead = true; };

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Debug logger with site prefix and timestamp. */
function log(...args) {
  const prefix = `[${SITE.toUpperCase()}:${Date.now() % 10000}]`;
  console.debug(prefix, ...args);
}

/** Warn logger for selector failures. */
function warn(...args) {
  const prefix = `[${SITE.toUpperCase()}:WARN:${Date.now() % 10000}]`;
  console.warn(prefix, ...args);
}

/**
 * Interruptible sleep. Resolves after `ms` OR as soon as the run is
 * superseded/killed — never hangs on a dead run, never stacks delays.
 */
function sleepPaced(ms, run) {
  return new Promise((resolve) => {
    if (!isCurrent(run)) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      resolve();
    }
    run.onInterrupt = () => { run.onInterrupt = null; done(); };
  });
}

  /** Random human-like pause that also respects the run token. */
  const humanPause = (run, minMs, maxMs) => sleepPaced(rnd(minMs, maxMs), run);

  /**
   * Promise.race between `promise` and a timeout that REJECTS with a
   * `timeout:<label>` reason after `ms`. This is the core anti-hang primitive:
   * any single await (DOM wait, pacing chain, etc.) can never stall the run
   * past its ceiling.
   */
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** Simulate a human skimming the page: a few random scrolls with pauses. */
  async function humanScroll(run) {
    const steps = rnd(CFG.scrollStepsMin, CFG.scrollStepsMax);
    for (let i = 0; i < steps; i++) {
      window.scrollBy(0, rnd(CFG.scrollMinPx, CFG.scrollMaxPx));
      await humanPause(run, CFG.pauseMinMs, CFG.pauseMaxMs);
      if (!isCurrent(run)) return;
    }
    // Back to the top so we "read" the first results again.
    window.scrollTo({ top: 0, behavior: 'instant' });
    await humanPause(run, 100, 300);
  }

  /** Detect Amazon / eBay bot-check or error interstitial pages. */
  function isBlockedPage() {
    if (SITE === 'amazon') {
      // URL-based checks
      if (/captcha|robot|ap\/signin|errors\/validate|authentication/i.test(location.href)) return true;
      // DOM-based checks
      if (document.querySelector('#captcha-form, form[action*="captcha"], input[name="field-keywords"][autocomplete="off"]#captchacharacters, #auth-captcha-container, .a-captcha')) return true;
      // Text-based checks
      const head = (document.body ? document.body.innerText : '').slice(0, 3000);
      if (/type the characters you see|enter the characters|automated access|verify you are human|robot check|unusual activity|please verify/i.test(head)) return true;
      // Empty results page that's actually a redirect
      if (document.querySelector('.s-desktop-width-max.s-opposite-dir.sg-row') && !document.querySelector('[data-asin]')) {
        const noResults = document.querySelector('.s-no-results, #noResultsTitle, .a-alert-heading');
        if (noResults && /no results|did not match|try checking/i.test(noResults.textContent)) return true;
      }
      return false;
    }
    // eBay
    if (/\/errors\/|\/sch\/i\.html.*(signin|denied)|captcha|challenge/i.test(location.href)) return true;
    const head = (document.body ? document.body.innerText : '').slice(0, 3000);
    if (/unusual traffic|automated access|security challenge|are you a robot|verify your identity|please complete/i.test(head)) return true;
    return false;
  }

  /** Parse a "$1,234.56"-style money string to a number (assumes USD). */
  function parseMoney(text) {
    if (!text) return null;
    const m = text.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
    if (!m) return null;
    const v = parseFloat(m[0]);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /* ------------------------------------------------------------------ *
   * AMAZON extraction
   * ------------------------------------------------------------------ */

  /** Pull the 10-char ASIN out of any Amazon product URL. */
  function extractAsin(url) {
    if (!url) return null;
    // sspa/click (sponsored) URLs carry the real ASIN in a ?th=1&psc=1&... or
    // /sspa/click?...&url=%2Fdp%2FASIN redirect form — try the decoded param too.
    const direct = url.match(/\/(?:dp|gp\/product|gp\/aw\/d|sspa\/click)\/([A-Z0-9]{10})(?:[\/?&#]|$)/);
    if (direct) return direct[1];
    try {
      const u = new URL(url, location.origin);
      const inner = u.searchParams.get('url') || u.searchParams.get('redirect');
      if (inner) {
        const dec = decodeURIComponent(inner).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
        if (dec) return dec[1];
      }
    } catch (_) { /* not a URL we understand */ }
    return null;
  }

  /**
   * Wait until the Amazon result grid is present (or give up after a bounded
   * wait). Amazon increasingly renders results client-side and lazy-loads
   * them, so at document_idle the grid may not exist yet. We watch for DOM
   * mutations instead of polling in a loop — and the wait is strictly bounded
   * so a page that never renders still reports a clear error.
   */
  function waitAmazonGrid(run) {
    const gridSelectors = [
      'div[data-component-type="s-search-result"]',
      'div.s-result-item[data-asin]',
      'div[data-asin][data-index]',
      'div[data-asin].AdHolder',
      'div.sg-col[data-asin]',
      'li[data-asin]',
      'div[data-csa-c-type="item"]',
      'div[data-component-type="s-product-image"]',
      '.s-result-list .s-result-item',
      '[data-cel-widget*="search_result"]',
      // NEW: Additional modern selectors for 2024-2025 layouts
      'div.s-result-item[data-cy="asin-title"]',
      'div.a-section.s-result-card',
      'div[data-uuid]',  // Amazon's newer UUID-based containers
      'article[data-asin]'  // Semantic HTML adoption
    ];

    const present = () => {
      for (const sel of gridSelectors) {
        if (document.querySelector(sel)) {
          log('Grid detected via selector:', sel);
          return true;
        }
      }
      // Fallback: check if we have ANY product links even without proper containers
      const productLinks = document.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/sspa/click/"]');
      if (productLinks.length >= 3) {
        log('Grid detection: Found', productLinks.length, 'product links without standard containers');
        return true;
      }
      return false;
    };

    if (present()) return Promise.resolve(true);
    if (isBlockedPage()) return Promise.resolve(false);

    log('Waiting for Amazon grid to render...', { timeoutMs: CFG.gridWaitMs });

    return new Promise((resolve) => {
      let done = false;
      let mutationCount = 0;
      const finish = (ok) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(giveUp);
        resolve(ok);
      };
      const obs = new MutationObserver((mutations) => {
        if (!isCurrent(run)) return finish(false);
        mutationCount += mutations.length;
        // Check every few mutations to reduce overhead
        if (mutationCount % 3 === 0 && present()) finish(true);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const giveUp = setTimeout(() => {
        warn('Grid wait timeout - checking for partial render...');
        // Final check: even if timeout, if we found some elements, proceed
        finish(present());
      }, CFG.gridWaitMs);
    });
  }

  /** Strategy A (primary): modern result grid. Strategy B: anchor-based. */
  function amazonContainers() {
    // Multiple selector strategies for different Amazon layouts (2024-2025)
    const selectorGroups = [
      // Group 1: Modern primary grid (most common 2024-2025)
      {
        name: 'primary-grid',
        selectors: [
          'div[data-component-type="s-search-result"]',
          'div.s-result-item[data-asin]',
          'div[data-asin][data-index]:not([data-index=""])',
          'div[data-csa-c-type="item"][data-asin]',
          // NEW: Additional modern selectors
          'div.s-result-item[data-cy="asin-title"]',
          'div.a-section.s-result-card[data-asin]',
          'article[data-asin]'
        ]
      },
      // Group 2: Sponsored / Ad results
      {
        name: 'sponsored',
        selectors: [
          'div[data-asin].AdHolder',
          'div[data-asin][data-component-type="sp-sponsored-result"]',
          'div.s-result-item[data-asin].AdHolder',
          'div[data-component-type="s-sponsored-result"]',
          // NEW: More sponsored patterns
          'div[data-asin][data-ad-id]',
          '[data-cy="ad-badge"]'
        ]
      },
      // Group 3: Grid column layouts
      {
        name: 'grid-column',
        selectors: [
          'div.sg-col[data-asin]',
          'div[class*="sg-col-"][data-asin]',
          'div.a-section[data-asin][data-index]',
          // NEW: Additional column patterns
          'div.sg-row div[data-asin]',
          '.s-desktop-content div[data-asin]'
        ]
      },
      // Group 4: List/item layouts
      {
        name: 'list-item',
        selectors: [
          'li[data-asin]',
          'li.s-result-item[data-asin]',
          // NEW: Semantic HTML patterns
          'article.s-result-item'
        ]
      },
      // Group 5: Cel widget based (Amazon's internal widget system)
      {
        name: 'cel-widget',
        selectors: [
          '[data-cel-widget*="search_result_"]',
          '[data-cel-widget*="search-result"]',
          // NEW: UUID-based containers
          'div[data-uuid][data-asin]'
        ]
      },
      // Group 6: Data attribute fallbacks (when class names change)
      {
        name: 'data-attr-fallback',
        selectors: [
          '[data-asin]:not([data-asin=""])',
          '[data-index][data-asin]',
          '[data-cy="asin-title"]'
        ]
      }
    ];

    let allNodes = [];
    let matchedGroup = null;

    for (const group of selectorGroups) {
      for (const selector of group.selectors) {
        try {
          const nodes = Array.from(document.querySelectorAll(selector));
          if (nodes.length > 0) {
            log(`Selector group "${group.name}" matched ${nodes.length} nodes via: ${selector}`);
            allNodes = nodes;
            matchedGroup = group.name;
            break;
          }
        } catch (e) {
          warn(`Selector error in group "${group.name}": ${selector}`, e.message);
        }
      }
      if (allNodes.length >= 2) break;
    }

    // Filter to only containers that have valid ASINs and product links
    const filtered = allNodes.filter((n) => {
      const asin = n.getAttribute('data-asin');
      if (!asin || asin.length !== 10) return false;
      // Check for product link within container
      const hasProductLink = n.querySelector('a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/sspa/click/"]');
      return !!hasProductLink;
    });

    log(`Filtered containers: ${filtered.length}/${allNodes.length} (matched group: ${matchedGroup})`);

    if (filtered.length >= 2) return filtered;

    // Fallback: group every product anchor by its ASIN and use its wrapper.
    log('Attempting anchor-based fallback...');
    const byAsin = new Map();
    const anchorSelectors = [
      'a[href*="/dp/"]',
      'a[href*="/gp/product/"]',
      'a[href*="/sspa/click/"]',
      // NEW: aria-label based anchors (accessibility pattern)
      'a[aria-label*="product"][href]'
    ];

    for (const anchorSel of anchorSelectors) {
      document.querySelectorAll(anchorSel).forEach((a) => {
        const asin = extractAsin(a.href);
        if (!asin || byAsin.has(asin)) return;
        // Try multiple wrapper patterns with increasing specificity
        const wrap = a.closest(
          'div[data-component-type="s-search-result"], div.s-result-item, div[data-asin][data-index], div[data-asin], div[class*="sg-col"], div.a-section, li, [data-cel-widget*="search"], article[data-asin], div[data-uuid]'
        ) || a;
        byAsin.set(asin, wrap);
      });
      if (byAsin.size >= 2) break;
    }

    log(`Anchor fallback found ${byAsin.size} unique ASINs`);
    return Array.from(byAsin.values());
  }

  function amazonImage(node) {
    // Multiple image selector strategies
    const imgSelectors = [
      'img.s-image',
      'img[data-image-latency="s-product-image"]',
      'img[src*="m.media-amazon.com"]',
      'img[data-src*="images/I/"]',
      'img[data-a-hires]',
      'img[srcset*="m.media-amazon.com"]',
      'img[data-a-dynamic-image]',
      '.s-product-image-container img',
      'div[data-component-type="s-product-image"] img'
    ];

    let img = null;
    let matchedSel = null;
    for (const selector of imgSelectors) {
      img = node.querySelector(selector);
      if (img) { matchedSel = selector; break; }
    }
    if (!img) { warn('No image found in container'); return null; }

    const raw = (img.currentSrc && !img.currentSrc.startsWith('data:')) ? img.currentSrc
      : (img.src && !img.src.startsWith('data:')) ? img.src
      : (img.dataset && (img.dataset.src || img.dataset.aHires || img.dataset.imageLatency || img.dataset.aDynamicImage)) || '';
    if (/^https?:\/\//.test(raw) && !/\/images\/G\/01\//.test(raw) && !/\/s\/no-image/.test(raw)) {
      log('Image found via:', matchedSel);
      return raw;
    }
    return null;
  }

  function amazonPrice(node) {
    const priceStrategies = [
      {
        name: 'standard-offscreen',
        selectors: ['.a-price .a-offscreen', '.a-price[data-a-color="price"] .a-offscreen', '[data-a-color="price"] .a-offscreen']
      },
      {
        name: 'whole-fraction',
        fn: (node) => {
          const whole = node.querySelector('.a-price-whole');
          if (!whole) return null;
          const w = parseInt(String(whole.textContent).replace(/[^\d]/g, ''), 10);
          const priceBlock = whole.closest('.a-price');
          const fracEl = priceBlock && priceBlock.querySelector('.a-price-fraction');
          const f = fracEl ? parseInt(String(fracEl.textContent).replace(/[^\d]/g, ''), 10) : 0;
          return Number.isFinite(w) ? w + (Number.isFinite(f) ? f / 100 : 0) : null;
        }
      },
      {
        name: 'any-offscreen',
        selectors: ['span.a-offscreen']
      },
      {
        name: 'strike-price',
        selectors: ['.a-price[data-a-strike="true"] .a-offscreen', 'span[data-a-strike="true"] .a-offscreen']
      },
      {
        name: 'a-color-base',
        selectors: ['.a-color-base.a-text-price', '.a-price.a-text-price']
      }
    ];

    for (const strategy of priceStrategies) {
      if (strategy.selectors) {
        for (const selector of strategy.selectors) {
          const el = node.querySelector(selector);
          if (el) {
            const p = parseMoney(el.textContent);
            if (p != null) { log(`Price found via ${strategy.name}: ${selector}`); return p; }
          }
        }
      } else if (strategy.fn) {
        const p = strategy.fn(node);
        if (p != null) { log(`Price found via ${strategy.name} (fn)`); return p; }
      }
    }

    // 5) Crude last resort: first "$amount" in visible text
    const text = (node.innerText || node.textContent || '').slice(0, 500);
    const m = text.match(/\$\s?([\d,]+(?:\.\d+)?)/);
    if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (Number.isFinite(v) && v > 0) { log('Price found via text regex'); return v; } }
    warn('No price found in container');
    return null;
  }

  function parseAmazonNode(node) {
    try {
      // Multiple anchor selector strategies
      const anchorSelectors = [
        'h2 a[href*="/dp/"]',
        'h2 a[href*="/gp/product/"]',
        'h2 a[href*="/sspa/click/"]',
        'h2 a.a-link-normal[href]',
        'a.a-link-normal.s-link-style[href*="/dp/"]',
        'a.a-link-normal.s-link-style[href*="/gp/product/"]',
        'a[href*="/dp/"][aria-label]',
        'a[href*="/gp/product/"][aria-label]',
        'a[href*="/sspa/click/"]',
        'h2 a.a-link-normal',
        '.a-link-normal[href*="/dp/"]',
        '[data-cy="title-recipe"] a',
        '[data-cy="asin-title"] a'
      ];

      let anchor = null;
      let matchedAnchorSel = null;
      for (const selector of anchorSelectors) {
        anchor = node.querySelector(selector);
        if (anchor) { matchedAnchorSel = selector; break; }
      }
      if (!anchor) { warn('No anchor found in container'); return null; }

      let asin = node.getAttribute && node.getAttribute('data-asin');
      if (!asin) asin = extractAsin(anchor.href);
      if (!asin || asin.length !== 10) { warn('Invalid ASIN:', asin); return null; }

      // Title extraction with multiple fallbacks
      const titleSelectors = [
        'h2 span',
        'h2 a span',
        'h2',
        'a.a-link-normal.s-link-style span',
        'a[href*="/dp/"] span',
        'a[href*="/gp/product/"] span',
        '[data-cy="title-recipe"]',
        '[data-cy="asin-title"]',
        '.a-text-normal'
      ];

      let titleEl = null;
      let matchedTitleSel = null;
      for (const selector of titleSelectors) {
        titleEl = node.querySelector(selector);
        if (titleEl && titleEl.textContent.trim().length > 3) { matchedTitleSel = selector; break; }
      }
      if (!titleEl) titleEl = anchor;

      const title = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (title.length < 4) { warn('Title too short:', title); return null; }

      const price = amazonPrice(node);
      if (price == null) { warn('No valid price for:', title); return null; } // out of stock / unavailable -> not buyable

      // Rating (optional data, kept for future UI use)
      const ratingEl = node.querySelector('span.a-icon-alt');
      const ratingTxt = ratingEl ? ratingEl.textContent.trim() : '';
      const ratingMatch = ratingTxt.match(/(\d+(?:\.\d+)?)\s*out of 5/);

      // Condition detection
      let condition = 'New';
      const condText = (node.innerText || '').toLowerCase();
      if (condText.includes('used') || condText.includes('refurbished') || condText.includes('renewed')) {
        condition = 'Used';
      }

      log('Parsed item:', { asin, title: title.slice(0, 50), price, condition });

      return {
        id: asin,
        site: 'amazon',
        title,
        price,
        priceText: `$${price.toFixed(2)}`,
        image: amazonImage(node),
        url: `https://www.amazon.com/dp/${asin}`,
        rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
        condition
      };
    } catch (e) { warn('parseAmazonNode error:', e.message); return null; }
  }

  function extractAmazon() {
    const items = [];
    const seen = new Set();
    for (const node of amazonContainers()) {
      const it = parseAmazonNode(node);
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
      if (items.length >= CFG.maxItems.amazon) break;
    }
    return items;
  }

/* ------------------------------------------------------------------ *
 * EBAY extraction
 * ------------------------------------------------------------------ */

  /** Wait for eBay results grid to render (bounded, like Amazon). */
  function waitEbayGrid(run) {
    const gridSelectors = [
      'li.s-item',
      'div.s-card',
      'ul.srp-results li',
      '.s-item__wrapper',
      // NEW: Additional modern selectors for 2024-2025 layouts
      'div[data-testid="search-result"]',
      'article.s-item',
      'div[class*="srp-grid"]'
    ];

    const present = () => {
      for (const sel of gridSelectors) {
        if (document.querySelector(sel)) {
          log('eBay grid detected via selector:', sel);
          return true;
        }
      }
      // Fallback: check for any product links
      const productLinks = document.querySelectorAll('a[href*="/itm/"]');
      if (productLinks.length >= 3) {
        log('eBay grid detection: Found', productLinks.length, 'product links without standard containers');
        return true;
      }
      return false;
    };

    if (present()) return Promise.resolve(true);
    if (isBlockedPage()) return Promise.resolve(false);

    log('Waiting for eBay grid to render...', { timeoutMs: CFG.gridWaitMs });

    return new Promise((resolve) => {
      let done = false;
      let mutationCount = 0;
      const finish = (ok) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(giveUp);
        resolve(ok);
      };
      const obs = new MutationObserver((mutations) => {
        if (!isCurrent(run)) return finish(false);
        mutationCount += mutations.length;
        if (mutationCount % 3 === 0 && present()) finish(true);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const giveUp = setTimeout(() => {
        warn('eBay grid wait timeout - checking for partial render...');
        finish(present());
      }, CFG.gridWaitMs);
    });
  }

  function cleanEbayTitle(t) {
    let s = (t || '').replace(/\s+/g, ' ').trim();
    // Strip eBay list chrome prefixes ("New Listing", "Results for ...", ...)
    s = s.replace(/^(?:New Listing|Results for|Best Match|Sponsored|Ad)\s*[-:–]?\s*/i, '');
    if (s.length < 4 || /^shop on ebay$/i.test(s)) return '';
    return s;
  }

  /** eBay price may be "US $12.99", "C $15.00", "$9.99 to $14.99", etc. */
  function parseEbayPrice(text) {
    if (!text) return null;
    // Skip non-USD money (CAD "C $", GBP £, EUR €, AUD "A $", ...)
    if (/[£€]/.test(text) || /\b(?:CAD|AUD|GBP|EUR|JPY|CNY|MXN|NZD|SEK|NOK|DKK|CHF)\b/i.test(text)) return null;
    const amounts = Array.from(text.matchAll(/\$([\d,]+(?:\.\d+)?)/g))
      .map((m) => parseFloat(m[1].replace(/,/g, '')))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (!amounts.length) return null;
    // Ranges ("$9.99 to $14.99") -> use the low end as the listing's asking price.
    return Math.min.apply(null, amounts);
  }

  function ebayImage(node) {
    const imgSelectors = [
      '.s-item__image-wrapper img',
      'img.s-item__image',
      'div[class*="image"] img',
      '.s-item__image img',
      'img[src*="i.ebayimg.com"]'
    ];
    let img = null;
    for (const selector of imgSelectors) {
      img = node.querySelector(selector);
      if (img) break;
    }
    if (!img) return null;
    const raw = img.currentSrc || img.src || (img.dataset && img.dataset.src) || '';
    if (/^https?:\/\//.test(raw) && !/\/svg\//.test(raw)) return raw;
    return null;
  }

  function parseEbayNode(node) {
    try {
      // Multiple anchor selector strategies for eBay
      const anchorSelectors = [
        'a.s-item__link[href]',
        'a[href*="/itm/"]',
        'a[class*="s-item__link"]',
        // NEW: Additional patterns for modern layouts
        'div.s-item a[href*="/itm/"]',
        'article.s-item a[href]'
      ];
      
      let anchor = null;
      for (const selector of anchorSelectors) {
        anchor = node.querySelector(selector);
        if (anchor) break;
      }
      if (!anchor) { warn('No anchor found in eBay container'); return null; }
      
      const idMatch = anchor.href.match(/\/itm\/(\d{9,})/);
      if (!idMatch) return null;
      const id = idMatch[1];

      const titleSelectors = [
        '.s-item__title',
        '.s-item__title span',
        'h3.s-item__title',
        'span[role="heading"]',
        '.s-item__title-text',
        // NEW: Additional title patterns
        'div.s-item__title h3',
        '[data-testid="listing-title"]'
      ];
      let titleEl = null;
      for (const selector of titleSelectors) {
        titleEl = node.querySelector(selector);
        if (titleEl && titleEl.textContent.trim().length > 3) break;
      }
      const title = cleanEbayTitle(titleEl ? titleEl.textContent : anchor.title || '');
      if (!title) { warn('No valid title for eBay item'); return null; }

      const priceSelectors = [
        '.s-item__price',
        'span[class*="price"]',
        '.x-price-primary',
        '.s-item__detail--primary span',
        // NEW: Additional price patterns
        '.s-item__detail .s-item__price',
        'div[data-testid="item-price"]',
        '.price-display'
      ];
      let price = null;
      let matchedPriceSel = null;
      for (const selector of priceSelectors) {
        const priceEl = node.querySelector(selector);
        if (priceEl) {
          price = parseEbayPrice(priceEl.textContent);
          if (price != null) { matchedPriceSel = selector; break; }
        }
      }
      if (matchedPriceSel) { log(`eBay price found via: ${matchedPriceSel}`); }
      // Last resort: scan the card text for a $ amount.
      if (price == null) {
        const t = (node.innerText || '').slice(0, 500);
        if (/\$/.test(t) && !/[£€]/.test(t)) price = parseEbayPrice(t);
      }
      if (price == null) { warn('No valid price for eBay item:', title); return null; }

      const condSelectors = [
        '.s-item__condition',
        '.s-item__subtitle',
        'span.SECONDARY_INFO',
        '.s-item__condition-text',
        '.x-item-condition',
        // NEW: Additional condition patterns
        'div[itemprop="itemCondition"]',
        '[data-testid="item-condition"]'
      ];
      let condEl = null;
      for (const selector of condSelectors) {
        condEl = node.querySelector(selector);
        if (condEl && condEl.textContent.trim().length > 1) break;
      }

      return {
        id,
        site: 'ebay',
        title,
        price,
        priceText: `$${price.toFixed(2)}`,
        image: ebayImage(node),
        url: `https://www.ebay.com/itm/${id}`,
        rating: null,
        condition: condEl ? condEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
      };
    } catch (e) { warn('parseEbayNode error:', e.message); return null; }
  }

  function ebayContainers() {
    // Strategy A: classic river layout.
    let nodes = Array.from(document.querySelectorAll('li.s-item'))
      .filter((n) => n.querySelector('a[href*="/itm/"]'));
    if (nodes.length >= 3) return nodes;

    // Strategy B: newer card grid layout.
    nodes = Array.from(document.querySelectorAll('div.s-card, div[class*="s-card"], ul.srp-results li, li.s-item, div.srp-results li'))
      .filter((n) => n.querySelector('a[href*="/itm/"]'));
    if (nodes.length >= 3) return nodes;

    // Strategy C: data-testid based containers (modern eBay).
    nodes = Array.from(document.querySelectorAll('div[data-testid="search-result"], article.s-item'))
      .filter((n) => n.querySelector('a[href*="/itm/"]'));
    if (nodes.length >= 3) return nodes;

    // Strategy D: wrapper-based selection.
    nodes = Array.from(document.querySelectorAll('.s-item__wrapper, div.s-item'))
      .filter((n) => n.querySelector('a[href*="/itm/"]'));
    if (nodes.length >= 2) return nodes;

    // Strategy E: generic anchor-based fallback (layout fully changed).
    const byId = new Map();
    document.querySelectorAll('a[href*="/itm/"]').forEach((a) => {
      const m = a.href.match(/\/itm\/(\d{9,})/);
      if (!m || byId.has(m[1])) return;
      // Try multiple wrapper patterns with increasing specificity
      const wrap = a.closest('li, div[class*="s-card"], div[class*="s-item"], div[class*="srp"], div.s-item__wrapper, article.s-item, div[data-testid="search-result"]') || a;
      byId.set(m[1], wrap);
    });
    log(`eBay anchor fallback found ${byId.size} unique item IDs`);
    return Array.from(byId.values());
  }

  function extractEbay() {
    const items = [];
    const seen = new Set();
    for (const node of ebayContainers()) {
      const it = parseEbayNode(node);
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
      if (items.length >= CFG.maxItems.ebay) break;
    }
    return items;
  }

  /* ------------------------------------------------------------------ *
   * Orchestration
   * ------------------------------------------------------------------ */
  let autoRan = false; // one automatic attempt per page load, per instance

  function report(run, payload) {
    // A superseded (killed or re-injected) run must never report — its late
    // messages are exactly what confused the orchestrator before.
    if (!isCurrent(run)) return;
    const msg = Object.assign({
      type: 'ARB_RESULTS',
      runId: run.id,
      site: SITE,
      query: QUERY,
      url: location.href,
      title: document.title,
      items: [],
      error: null
    }, payload);
    try {
      if (!chrome.runtime || !chrome.runtime.id) return; // extension reloaded
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  /**
   * One full scrape attempt, hard-bounded by CFG.scrapeDeadlineMs.
   * The deadline race is what guarantees the popup can never spin forever on
   * our account: every await below (pacing, scrolling, grid wait) completes
   * or the run reports a timeout error.
   */
  async function runScrape(opts) {
    opts = opts || {};
    if (currentRun && isCurrent(currentRun)) killCurrent(); // abort any in-flight run
    const run = makeRun();

    const work = (async () => {
      if (isBlockedPage()) { report(run, { error: 'blocked' }); return; }

      // Human-like pacing BEFORE parsing — but only when the user can see the
      // tab. A backgrounded tab skips straight to parsing so a hidden scrape
      // finishes in ~1s instead of idling through the full delay chain.
      if (!document.hidden) {
        await humanPause(run, CFG.preParseMinMs, CFG.preParseMaxMs);
        if (!isCurrent(run)) return;
        await humanScroll(run);
        if (!isCurrent(run)) return;
      }

      // Amazon renders results client-side/lazy: wait (bounded) for the grid.
      if (SITE === 'amazon') {
        const gridReady = await waitAmazonGrid(run);
        if (!isCurrent(run)) return;
        if (isBlockedPage()) { report(run, { error: 'blocked' }); return; }
        if (!gridReady) {
          // Check if we're on a "no results" page vs a page that failed to load
          const noResultsEl = document.querySelector('.s-no-results, #noResultsTitle, .a-alert-heading, [data-component-type="s-no-results"]');
          if (noResultsEl && /no results|did not match|try checking|no products found/i.test(noResultsEl.textContent)) {
            report(run, { error: 'no-results' });
          } else {
            // Page loaded but grid didn't appear - likely layout change or partial load
            report(run, { error: 'parse-failed' });
          }
          return;
        }
      }
      // eBay also benefits from bounded grid wait
      if (SITE === 'ebay') {
        const gridReady = await waitEbayGrid(run);
        if (!isCurrent(run)) return;
        if (isBlockedPage()) { report(run, { error: 'blocked' }); return; }
        if (!gridReady) {
          report(run, { error: 'parse-failed' });
          return;
        }
      }
      if (!isCurrent(run)) return;

      if (isBlockedPage()) { report(run, { error: 'blocked' }); return; }

      const items = SITE === 'amazon' ? extractAmazon() : extractEbay();

      if (!items.length) {
        // For Amazon, double-check if it's a genuine no-results vs parsing failure
        if (SITE === 'amazon') {
          const hasProductLinks = document.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]').length > 0;
          if (hasProductLinks) {
            report(run, { error: 'parse-failed' });
          } else {
            report(run, { error: 'no-results' });
          }
        } else {
          // For eBay, check if product links exist but parsing failed
          const hasProductLinks = document.querySelectorAll('a[href*="/itm/"]').length > 0;
          if (hasProductLinks) {
            report(run, { error: 'parse-failed' });
          } else {
            report(run, { error: 'no-results' });
          }
        }
        return;
      }

      // Tiny settle pause before reporting (kept interruptible + short).
      await humanPause(run, CFG.pauseMinMs, CFG.pauseMaxMs);
      report(run, { items });
    })();

    try {
      await withTimeout(work, CFG.scrapeDeadlineMs, 'scrape');
      if (isCurrent(run)) killCurrent();
    } catch (err) {
      // Deadline exceeded or an unexpected throw: fail LOUDLY, not silently.
      const reason = err instanceof Error && /^timeout:/.test(err.message)
        ? 'timeout'
        : 'parse-failed';
      report(run, { error: reason });
      killCurrent();
    }
  }

  /**
   * The popup's "Parse again" button asks us to re-run immediately.
   * We only honour requests whose runId matches ours, so a stale instance
   * cannot answer a call meant for a newer one (and vice versa).
   */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'ARB_SCRAPE_NOW') return false;
    if (msg.runId && currentRun && msg.runId !== currentRun.id) return false;
    sendResponse({ ok: true, runId: currentRun ? currentRun.id : null });
    runScrape({ force: true });
    return false;
  });

  // Not a search-results page -> report that explicitly (background tags the
  // stage 'no-results-page' instead of waiting on a page that will never report).
  if (!isSearchPath) {
    report(makeRun(), { error: 'no-results-page' });
    return;
  }

  if (!QUERY) { report(makeRun(), { error: 'no-query' }); return; }
  if (isBlockedPage()) { report(makeRun(), { error: 'blocked' }); return; }

  // Kick off the automatic scrape as soon as the DOM is interactive — the
  // bounded grid wait handles the rest (no need to wait for full load, which
  // tracking pixels can delay indefinitely).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => runScrape({ force: false }));
  } else {
    runScrape({ force: false });
  }
})();
