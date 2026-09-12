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
  // Increased from 15s to 25s to allow more time for dynamic content rendering.
  scrapeDeadlineMs: 25000,
  // Max extra time to wait for Amazon's lazy/client-rendered result grid,
  // once the page looks alive. Increased from 12s to 18s for slower connections.
  gridWaitMs: 18000,
  // Grace window (ms) for a redirect/interstitial page (sign-in wall, bot
  // check, error page) to resolve into the real search page before we report
  // 'no-results-page'. Prevents instant fast-fails when Amazon bounces a
  // background tab off the requested search URL.
  redirectWaitMs: 10000,
  // Random pre-parse wait (ms) — mimics a person reading the page first.
  // SKIPPED entirely when the tab is hidden/backgrounded (a background tab
  // would otherwise sit through the full pacing delay before reporting).
  preParseMinMs: 300,
  preParseMaxMs: 900,
  // Pauses between parsing steps (ms).
  pauseMinMs: 80,
  pauseMaxMs: 200,
  // Scroll simulation parameters.
  scrollMinPx: 200,
  scrollMaxPx: 500,
  scrollStepsMin: 2,
  scrollStepsMax: 4,
  // Max items reported per site. Amazon shows 48 per page; with 5 pages
  // that's 240 potential items. eBay shows ~60 per page; with dynamic
  // pagination (up to 9+ pages) that's ~540+ potential items. We cap
  // generously to avoid memory bloat.
  maxItems: { amazon: 240, ebay: 600 },
  // Amazon pagination / rate-limit handling
  amazon: {
    // Max retries for a single page before giving up
    maxRetries: 2,
    // Base delay (ms) between retries — grows exponentially
    retryBaseDelayMs: 1500,
    // Max delay (ms) between page navigations to avoid rate-limiting
    maxPageDelayMs: 3000,
    // Min delay (ms) between page navigations
    minPageDelayMs: 800
  }
};

/* ------------------------------------------------------------------ *
 * Site / page detection
 * ------------------------------------------------------------------ */
const HOST = location.hostname.toLowerCase();
const SITE = HOST === 'amazon.com' || HOST.endsWith('.amazon.com')
  ? 'amazon'
  : HOST === 'ebay.com' || HOST.endsWith('.ebay.com')
    ? 'ebay'
    : HOST === 'aliexpress.com' || HOST.endsWith('.aliexpress.com')
      ? 'aliexpress'
      : null;

// Not one of the supported marketplaces -> do nothing.
if (!SITE) return;

const isSearchPath =
  SITE === 'amazon' ? /^\/(s|gp\/search)(\/|$)/.test(location.pathname)
  : SITE === 'ebay' ? /^\/sch(\/|$)/.test(location.pathname)
  : SITE === 'aliexpress' ? /^\/wholesale/.test(location.pathname)
  : false;

// Phase 3 (manual-match flow): Amazon single-product pages (/dp/<ASIN>,
// /gp/product/<ASIN>) are valid parse targets. The popup's "paste a verified
// ASIN/URL" override opens one of these, so we must parse the buybox instead
// of reporting the page as a non-search redirect.
const isProductPath =
  SITE === 'amazon' &&
  /^\/(dp|gp\/product)\//.test(location.pathname) &&
  !/\/cart\/|\/checkout\//.test(location.pathname);

  function readQueryFromUrl() {
    try {
      const p = new URLSearchParams(location.search);
      return SITE === 'amazon' ? (p.get('k') || '').trim()
             : SITE === 'ebay' ? (p.get('_nkw') || '').trim()
             : SITE === 'aliexpress' ? (p.get('SearchText') || '').trim()
             : '';
    } catch (_) { return ''; }
  }
  const QUERY = readQueryFromUrl();
  // Page classification trace: the instant-close cause usually shows up right
  // here (e.g. a redirect landing us on a non-search page, or QUERY empty).
  console.log('[ARBScout:DBG] PAGE', JSON.stringify({
    href: String(location.href).slice(0, 160),
    isSearchPath,
    isProductPath,
    query: QUERY || null,
    readyState: document.readyState,
  }));

  /**
   * Page number of the results page currently loaded — Amazon uses ?page=,
   * eBay uses ?_pgn=. The background orchestrator drives pagination by
   * navigating the SAME tab, and uses this echo to make sure a reply is for
   * the page it asked for (a late page-1 payload can never be mistaken for
   * page-3, and stale duplicate payloads are ignored instead of double-counted).
   */
  const PAGE = (() => {
    try {
      const sp = new URLSearchParams(location.search);
      const raw = sp.get('page') || sp.get('_pgn') || '';
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n > 0) return n;
    } catch (_) { /* no search params */ }
    return 1;
  })();

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

  /**
   * Landed on a marketplace URL that is neither a search nor a product page.
   * This is almost always a REDIRECT from the page the background asked for:
   * sign-in walls, bot checks and error interstitials all still match
   * amazon.com/* (or ebay.com/*), so this script runs there too. Do NOT
   * fast-fail — an instant "no-results-page" is exactly what made the Amazon
   * tab close 1-2 seconds after opening. Instead: classify known block pages
   * immediately (that keeps the tab open for recovery), otherwise wait out
   * one bounded grace window for late server-side redirects to resolve into
   * the real search page, then report so the background can advance.
   * Bounded = the run can never hang on a page that will never produce data.
   */
  function scheduleRedirectReport() {
    const run = makeRun();
    const startedAt = Date.now();
    const tick = () => {
      if (!isCurrent(run)) return;
      if (isBlockedPage()) { report(run, { error: 'blocked' }); return; }
      if (Date.now() - startedAt >= CFG.redirectWaitMs) {
        report(run, { error: 'no-results-page' });
        return;
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  }

  /** Parse a "$1,234.56"-style money string to a number (assumes USD). */
  function parseMoney(text) {
    if (!text) return null;
    const m = text.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
    if (!m) return null;
    const v = parseFloat(m[0]);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /** Extract the first URL from a srcset attribute value. */
  function firstUrlFromSrcset(srcset) {
    if (!srcset) return '';
    const first = String(srcset).split(',')[0];
    return (first || '').trim().split(/\s+/)[0] || '';
  }

  /** Extract a URL from Amazon's data-a-dynamic-image JSON attribute. */
  function firstUrlFromDynamicImage(value) {
    if (!value) return '';
    try {
      const parsed = JSON.parse(value);
      const urls = Object.keys(parsed || {});
      return urls.find((url) => /^https?:\/\//.test(url)) || '';
    } catch (_) {
      const match = String(value).match(/https?:\/\/[^"'\s]+/);
      return match ? match[0] : '';
    }
  }

  /** Extract the best available image URL from an <img> or <source> element. */
  function imageUrlFromElement(el) {
    if (!el) return '';
    const values = [
      el.currentSrc,
      el.src,
      el.getAttribute('data-src') ||
      el.getAttribute('data-lazy-src') ||
      el.getAttribute('data-original') ||
      el.getAttribute('data-a-hires') ||
      firstUrlFromSrcset(el.getAttribute('srcset') || el.getAttribute('data-srcset')) ||
      firstUrlFromDynamicImage(el.getAttribute('data-a-dynamic-image'))
    ];
    return values.find((value) => /^https?:\/\//.test(value || '')) || '';
  }

  /* ------------------------------------------------------------------ *
   * AMAZON extraction (robust scoped selectors)
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
      'article[data-asin]',  // Semantic HTML adoption
      '[data-component-type="s-search-result-card"]',
      'div[data-component="hasResult"]',
      'div[data-csa-c-type="item"][data-csa-c-item-id]',
      '[data-component-type="s-search-result"][data-asin]'
    ];

    const present = () => {
      for (const sel of gridSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          log('Grid detected via selector:', sel, '- element:', el.tagName);
          return true;
        }
      }
      // Fallback: check if we have ANY product links even without proper containers.
      // NOTE: no trailing slash after "click" — real sspa links are
      // ".../sspa/click?ie=..." so "/sspa/click/" would never match.
      const productLinks = document.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/sspa/click"]');
      if (productLinks.length >= 3) {
        log('Grid detection: Found', productLinks.length, 'product links without standard containers');
        return true;
      }
      log('Grid check: No selectors matched, productLinks count:', productLinks.length);
      return false;
    };

    log('[GRID CHECK] Initial check at document.readyState:', document.readyState);
    if (present()) {
      log('[GRID CHECK] Grid already present on first check');
      return Promise.resolve(true);
    }
    if (isBlockedPage()) {
      log('[GRID CHECK] Blocked page detected, aborting grid wait');
      return Promise.resolve(false);
    }

    log('Waiting for Amazon grid to render...', { timeoutMs: CFG.gridWaitMs });

    return new Promise((resolve) => {
      let done = false;
      let mutationCount = 0;
      let checkInterval = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(giveUp);
        if (checkInterval) clearInterval(checkInterval);
        log('[GRID WAIT] Finishing with result:', ok);
        resolve(ok);
      };
      const obs = new MutationObserver((mutations) => {
        if (!isCurrent(run)) {
          log('[GRID WAIT] Mutation: run no longer current, aborting');
          return finish(false);
        }
        mutationCount += mutations.length;
        // Check every few mutations to reduce overhead
        if (mutationCount % 2 === 0 && present()) {
          log('[GRID WAIT] Grid detected via mutation observer after', mutationCount, 'mutations');
          finish(true);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      log('[GRID WAIT] MutationObserver started, watching for DOM changes...');
      
      // Fallback: periodic check in case mutations don't trigger (e.g., JS replacing innerHTML)
      let fallbackChecks = 0;
      checkInterval = setInterval(() => {
        if (!isCurrent(run)) {
          log('[GRID WAIT] Fallback check: run no longer current');
          return finish(false);
        }
        fallbackChecks++;
        log('[GRID WAIT] Fallback check #', fallbackChecks);
        if (present()) {
          log('[GRID WAIT] Grid detected via fallback check #', fallbackChecks);
          finish(true);
        }
        // Stop checking after 80% of timeout to avoid race with giveUp
        if (fallbackChecks >= Math.floor(CFG.gridWaitMs / 500) - 1) {
          log('[GRID WAIT] Stopping fallback checks at', fallbackChecks);
          clearInterval(checkInterval);
        }
      }, 500);
      
      const giveUp = setTimeout(() => {
        warn('Grid wait timeout - checking for partial render...');
        // Final check: even if timeout, if we found some elements, proceed
        const finalCheck = present();
        log('[GRID WAIT] Timeout reached - final check result:', finalCheck);
        finish(finalCheck);
      }, CFG.gridWaitMs);
      log('[GRID WAIT] Timeout set for', CFG.gridWaitMs, 'ms');
    });
  }

  /**
   * Strong ad detection — only unambiguous, structural markers.
   * NOTE: the old implementation rejected ANY card whose text/aria-label
   * contained the substring "Ad" (e.g. "/* Ad taus" or "Add to cart"),
   * and treated a distant ancestor carousel as proof-of-ad. Amazon cards
   * routinely carry such markup, which nuked the organic grid down to a
   * handful of survivors per page. This version uses only strong markers.
   */
  function isAmazonSponsored(node) {
    if (!node) return false;
    if (node.matches && node.matches(
      '.AdHolder, [data-ad-id], [data-ad-placement], [data-ad-creative], ' +
      '[data-ad-slot], [data-component-type*="sponsored" i], ' +
      '[data-cel-widget*="sponsored" i], [data-csa-c-type*="sponsored" i], ' +
      '[data-csa-c-content-id*="sponsored" i], [data-csa-c-slot-id*="sponsored" i]'
    )) return true;
    if (node.querySelector && node.querySelector(
      '.AdHolder, [data-ad-id], [data-ad-placement], [data-ad-creative], ' +
      '[data-ad-slot], [data-cy="ad-badge"], .ad-badge, ' +
      '[data-component-type*="sponsored" i], [data-cel-widget*="sponsored" i], ' +
      '[data-csa-c-type*="sponsored" i], [data-csa-c-content-id*="sponsored" i], ' +
      '[data-csa-c-slot-id*="sponsored" i], .p13n-asin, .p13n-sc-truncate'
    )) return true;
    if (node.querySelector) {
      const links = node.querySelectorAll('a[href*="/sspa/click"]');
      for (const a of links) {
        // Prefer the resolved href, fall back to the raw attribute (some
        // anchors — e.g. in detached/SVG trees — expose no .href property).
        const href = a.href || (a.getAttribute && a.getAttribute('href')) || '';
        if (/[?&](?:adId|adGroupId|advertiserId|creativeId|adSlot)=/.test(href)) return true;
      }
    }
    // Only a LEADING "Sponsored" text badge proves an ad card; never a
    // substring in the middle/end of the label.
    const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return /^sponsored(?:\s+ad)?\b/i.test(text);
  }

  /**
   * Robust carousel detection — scoped to the card itself or its DIRECT
   * parent only. The old version scanned every ancestor (closest), so an
   * organic card anywhere on a page that also had a "related items"
   * carousel would be discarded. Amazon search returns DO include
   * carousels, but they never CONTAIN the organic grid cards.
   */
  function isAmazonCarousel(node) {
    if (!node) return false;
    const sel = '.a-carousel-container, .a-carousel-card, .a-carousel-viewport, ' +
      '.a-carousel-row, [data-a-carousel-options], [data-component-type*="carousel" i], ' +
      '[data-csa-c-type="carousel"], .p13n-carousel';
    if (node.matches && node.matches(sel)) return true;
    const parent = node.parentElement;
    if (parent && parent.matches && parent.matches(sel)) return true;
    // Legacy "sims"/p13n wrappers are handled by the slot-scope filter and
    // isAmazonRecommendationBlock — never by an ancestor scan here.
    return false;
  }

  /** Filter editorial / recommendation / related-blocks (never products). */
  function isAmazonRecommendationBlock(node) {
    if (!node) return false;
    const recSelectors = [
      '[data-component-type="s-instant-results"]',
      '[data-component-type="s-related-keywords"]',
      '[data-component-type="s-breadcrumb"]',
      '[data-component-type="s-suggestion"]',
      '[data-component-type="s-quick-links"]',
      '[data-component-type="s-feedback"]',
      '[data-component-type="s-pagination"]',
      '[data-component-type="s-refinements"]',
      '[data-component-type="s-sort"]',
      '[data-component-type="s-filter"]',
      '[data-component-type="s-banner"]',
      '[data-component-type="s-announcement"]',
      '[data-component-type^="s-inline-"]',
      '[data-component-type="widget-cpd"]',
      '[data-component-type="sp-also-bought"]',
      '[data-component-type="sp-related"]'
    ];
    if (node.matches && node.matches(recSelectors.join(', '))) return true;
    if (node.closest && node.closest(recSelectors.join(', '))) return true;
    // id-based / class-based fallbacks for the "related"/suggestion rows.
    if (node.id && /s-(suggestion|breadcrumb|pagination|refinements|quick-links|related)/i.test(node.id)) return true;
    return false;
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

    // CRITICAL FIX: Collect ALL nodes from ALL selector groups, not just the first match.
    // Use a Map keyed by ASIN to deduplicate while maximizing coverage.
    const byAsin = new Map();
    let totalFound = 0;

    for (const group of selectorGroups) {
      for (const selector of group.selectors) {
        try {
          // querySelectorAll returns ALL matching elements, not just the first
          const nodes = Array.from(document.querySelectorAll(selector));
          if (nodes.length > 0) {
            log(`Selector group "${group.name}" matched ${nodes.length} nodes via: ${selector}`);
            totalFound += nodes.length;
            
            // Add each node to our collection, keyed by ASIN to avoid duplicates.
            // CRITICAL: Skip sponsored, carousel, and recommendation blocks so
            // only valid organic products are captured.
            for (const node of nodes) {
              const asin = node.getAttribute('data-asin');
              if (asin && asin.length === 10 && !byAsin.has(asin)) {
                // Stable organic results MUST live inside Amazon's main
                // search-result slot. Carousels / related / sponsored /
                // editorial widgets are rendered on other slots, so this
                // single scope check drops the overwhelming majority of
                // non-organic nodes before any per-card filter runs.
                const scopeSel = '.s-main-slot, .s-search-results, .s-result-list, #search, .s-desktop-grid';
                const inMainSlot = node.closest
                  ? (node.closest(scopeSel) || (node.matches && node.matches(scopeSel)))
                  : false;
                // On A/B layouts where the slot wrapper is missing we still
                // accept cards; the strong ad/carousel/rec filters below are
                // then responsible for weeding out the rest.
                const scopeAbsent = !document.querySelector('.s-main-slot, .s-search-results, .s-result-list, #search');
                if (!inMainSlot && !scopeAbsent) {
                  log('Skipping out-of-slot container:', asin);
                  continue;
                }

                // Verify this container has a real product link.
                if (node.querySelector('a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/sspa/click"]')) {
                  if (isAmazonSponsored(node) || isAmazonCarousel(node) || isAmazonRecommendationBlock(node)) {
                    log('Skipping non-organic Amazon block:', asin);
                    continue;
                  }
                  byAsin.set(asin, node);
                }
              }
            }
          }
        } catch (e) {
          warn(`Selector error in group "${group.name}": ${selector}`, e.message);
        }
      }
    }

    const allNodes = Array.from(byAsin.values());
    log(`Total unique ASIN containers found: ${allNodes.length} (from ${totalFound} raw matches)`);

    if (allNodes.length >= 2) return allNodes;

    // Fallback: group every product anchor by its ASIN and use its wrapper.
    log('Attempting anchor-based fallback...');
    const anchorSelectors = [
      'a[href*="/dp/"]',
      'a[href*="/gp/product/"]',
      'a[href*="/sspa/click"]',
      // NEW: aria-label based anchors (accessibility pattern)
      'a[aria-label*="product"][href]'
    ];

    for (const anchorSel of anchorSelectors) {
      document.querySelectorAll(anchorSel).forEach((a) => {
        const asin = extractAsin(a.href);
        if (!asin || byAsin.has(asin)) return;
        // Try match patterns with increasing specificity. Also respect the
        // main-slot scope when it exists, so anchors living inside an inline
        // carousel / related-item widget don't pollute the organic set.
        let wrap = a.closest(
          'div[data-component-type="s-search-result"], div.s-result-item, div[data-asin][data-index], div[data-asin], div[class*="sg-col"], div.a-section, li, [data-cel-widget*="search"], article[data-asin], div[data-uuid]'
        ) || a;
        const scopeSel = '.s-main-slot, .s-search-results, .s-result-list, #search';
        if (wrap.closest && !(wrap.closest(scopeSel) || wrap.matches(scopeSel))) {
          const slotScope = document.querySelector(scopeSel);
          if (slotScope && !slotScope.contains(wrap)) return;
        }
        if (!byAsin.has(asin)) byAsin.set(asin, wrap);
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

  /**
   * Parse the buyable price out of a search-result card.
   *
   * Contract: NEVER throws and NEVER halts the caller — a missing or
   * unreadable price degrades the single card, never the page scan (see
   * parseAmazonNode / extractAmazon). Returns a positive number or null.
   *
   * Ordered cascade for modern Amazon search layouts:
   *   1. Non-strike `.a-price .a-offscreen` variants — the machine-readable,
   *      visually-hidden price (masked until hydration but present in DOM).
   *   2. `.a-price-whole` + `.a-price-fraction` split spans (and whole-only).
   *   3. Hydration data attributes (data-price / data-csa-c-price / …).
   *   4. Any `.a-offscreen` catch-all.
   *   5. Strike-through / list prices LAST — not the buy price.
   *   6. First "$amount" in the card's visible text.
   * If the card node itself carries no price (some layouts put the price in a
   * sibling grid column outside the resolved wrapper), the scan escalates ONCE
   * to the enclosing [data-asin] result card so the neighbor column is covered.
   */
  function amazonPrice(node, escalated) {
    try {
      if (!node || typeof node.querySelector !== 'function') return null;

      const selectorStrategies = [
        { name: 'offscreen-nonstrike', sels: [
          '.a-price:not(.a-text-price) .a-offscreen',
          'span.a-price span.a-offscreen',
          '.a-price[data-a-color="price"] .a-offscreen',
          '.a-price[data-a-size="xl"] .a-offscreen',
          '[data-cy="price-recipe"] .a-price .a-offscreen',
          '[data-cy="price-recipe"] .a-offscreen',
          '[data-component-type="s-price"] .a-offscreen',
          '.s-price .a-offscreen',
          'span[class*="price"] .a-offscreen'
        ] },
        { name: 'any-offscreen', sels: ['span.a-offscreen', '.a-offscreen'] },
        { name: 'strike-price', sels: [
          '.a-price[data-a-strike="true"] .a-offscreen',
          'span[data-a-strike="true"] .a-offscreen'
        ] },
        { name: 'list-price', sels: [
          '.a-text-price .a-offscreen',
          '.a-color-base.a-text-price',
          '.a-price.a-text-price .a-offscreen'
        ] }
      ];

      const fnStrategies = [
        {
          name: 'whole-fraction',
          fn: (n) => {
            const whole = n.querySelector('.a-price-whole');
            if (!whole) return null;
            const priceBlock = whole.closest('.a-price');
            // A strike-through block shows the LIST price, not the buy price.
            if (priceBlock && /\ba-text-price\b/.test(priceBlock.className || '')) return null;
            const w = parseInt(String(whole.textContent).replace(/[^\d]/g, ''), 10);
            const fracEl = priceBlock && priceBlock.querySelector('.a-price-fraction');
            const fracStr = fracEl ? String(fracEl.textContent).replace(/[^\d]/g, '') : '';
            const f = fracStr ? parseInt(fracStr, 10) : 0;
            if (!Number.isFinite(w) || w <= 0) return null;
            // A one-digit fraction ("$5.0") renders tenths, not hundredths.
            const cents = fracStr.length === 1 ? (f * 10) / 100 : f / 100;
            const v = w + (Number.isFinite(f) ? cents : 0);
            return Number.isFinite(v) && v > 0 ? v : null;
          }
        },
        {
          name: 'whole-only',
          fn: (n) => {
            const whole = n.querySelector('.a-price-whole');
            if (!whole) return null;
            const priceBlock = whole.closest('.a-price');
            if (priceBlock && /\ba-text-price\b/.test(priceBlock.className || '')) return null;
            const w = parseInt(String(whole.textContent).replace(/[^\d]/g, ''), 10);
            return Number.isFinite(w) && w > 0 ? w : null;
          }
        },
        {
          name: 'data-attribute',
          fn: (n) => {
            // Modern layouts cache the price in hydration data attributes.
            const el = n.querySelector(
              '[data-price], [data-a-price], [data-price-whole], [data-csa-c-price], [data-eq-price]'
            );
            if (!el) return null;
            const raw = el.getAttribute('data-price') || el.getAttribute('data-a-price') ||
                        el.getAttribute('data-price-whole') || el.getAttribute('data-csa-c-price') ||
                        el.getAttribute('data-eq-price') || '';
            const m = String(raw).replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
            if (!m) return null;
            const v = parseFloat(m[0]);
            return Number.isFinite(v) && v > 0 ? v : null;
          }
        }
      ];

      for (const strategy of selectorStrategies) {
        for (const selector of strategy.sels) {
          const el = node.querySelector(selector);
          if (el) {
            // Catch-all tiers must not swallow strike-through (list) prices.
            if (strategy.name === 'any-offscreen' && typeof el.closest === 'function' &&
                el.closest('.a-text-price, .a-price[data-a-strike="true"]')) continue;
            const p = parseMoney(el.textContent);
            if (p != null) { log(`Price found via ${strategy.name}: ${selector}`); return p; }
          }
        }
      }
      for (const strategy of fnStrategies) {
        const p = strategy.fn(node);
        if (p != null) { log(`Price found via ${strategy.name} (fn)`); return p; }
      }

      // Last resort: first "$amount" in visible text (strip commas, accept ranges).
      const text = (node.innerText || node.textContent || '').slice(0, 800);
      const m = text.match(/\$\s?([\d,]+(?:\.\d+)?)/);
      if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (Number.isFinite(v) && v > 0) { log('Price found via text regex'); return v; } }

      // Escalate once to the enclosing result card: anchor-fallback wrappers
      // can resolve to an inner section while the price lives in a sibling
      // grid column of the same [data-asin] card.
      if (!escalated && typeof node.closest === 'function') {
        const card = node.closest('div[data-asin], div[data-component-type="s-search-result"]');
        if (card && card !== node) {
          const p = amazonPrice(card, true);
          if (p != null) { log('Price found via card-container escalation'); return p; }
        }
      }

      warn('No price found in container');
      return null;
    } catch (e) {
      // A price failure must never bubble into the parse loop — skip the card.
      warn('amazonPrice error (card skipped):', e && e.message);
      return null;
    }
  }

  function parseAmazonNode(node, stats) {
    try {
      // Multiple anchor selector strategies
      const anchorSelectors = [
        'h2 a[href*="/dp/"]',
        'h2 a[href*="/gp/product/"]',
        'h2 a[href*="/sspa/click"]',
        'h2 a.a-link-normal[href]',
        'a.a-link-normal.s-link-style[href*="/dp/"]',
        'a.a-link-normal.s-link-style[href*="/gp/product/"]',
        'a[href*="/dp/"][aria-label]',
        'a[href*="/gp/product/"][aria-label]',
        'a[href*="/sspa/click"]',
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
      if (!anchor) { if (stats) stats.noAnchor++; warn('No anchor found in container'); return null; }

      let asin = node.getAttribute && node.getAttribute('data-asin');
      if (!asin) asin = extractAsin(anchor.href);
      if (!asin || asin.length !== 10) { if (stats) stats.badAsin++; warn('Invalid ASIN:', asin); return null; }

      // Title extraction with multiple fallbacks.
      // FIXED: Previously we took the FIRST selector match with >3 chars and
      // rejected the item if that single candidate was too short. On some pages
      // (e.g. page 3) a short non-title element (badge, "Sponsored" label,
      // truncated aria text) matched first, causing valid listings to be
      // falsely rejected with "title is too short". Now we collect ALL
      // candidate title elements, score them, and pick the best one — only
      // rejecting if EVERY candidate is genuinely too short.
      const titleSelectors = [
        'h2 span',
        'h2 a span',
        'h2',
        'a.a-link-normal.s-link-style span',
        'a[href*="/dp/"] span',
        'a[href*="/gp/product/"] span',
        '[data-cy="title-recipe"]',
        '[data-cy="asin-title"]',
        '.a-text-normal',
        'span.a-size-medium',
        'span.a-size-base-plus',
        'span.a-text-normal'
      ];

      const titleCandidates = [];
      for (const selector of titleSelectors) {
        try {
          const els = node.querySelectorAll(selector);
          for (const el of els) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t) continue;
            // Skip obvious non-title chrome text.
            if (/^(sponsored|ad|best seller|amazon's choice|new|used|refurbished|renewed|limited time deal|#\d+)\b/i.test(t)) continue;
            titleCandidates.push({ text: t, el, selector, len: t.length });
          }
        } catch (_) { /* ignore selector errors */ }
      }

      // Also consider the anchor's aria-label / title attributes — these are
      // often the most complete product titles on modern Amazon layouts.
      const anchorLabel = (anchor.getAttribute && (anchor.getAttribute('aria-label') || anchor.getAttribute('title'))) || '';
      if (anchorLabel) {
        const t = anchorLabel.replace(/\s+/g, ' ').trim();
        if (t) titleCandidates.push({ text: t, el: anchor, selector: 'anchor-aria-label', len: t.length });
      }

      // Score candidates: prefer longer, more descriptive text. This avoids
      // short badge/label matches winning over the real product title.
      titleCandidates.sort((a, b) => {
        // Strong preference for longer text (real titles are usually 20+ chars).
        if (b.len !== a.len) return b.len - a.len;
        // Tie-break: prefer h2-based selectors (semantic title containers).
        const aScore = /^h2/.test(a.selector) ? 1 : 0;
        const bScore = /^h2/.test(b.selector) ? 1 : 0;
        return bScore - aScore;
      });

      let best = titleCandidates[0];
      if (!best) {
        // Last resort: use the anchor's raw text content.
        const anchorText = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
        if (anchorText.length >= 4) {
          log('Title fallback: used anchor text');
          titleCandidates.push({ text: anchorText, el: anchor, selector: 'anchor-text', len: anchorText.length });
          best = titleCandidates[0];
        }
      }

      const title = best ? best.text : '';
      if (title.length < 4) {
        // Only reject when we truly have no usable title. Log the candidates
        // for debugging instead of crashing the whole page parse.
        if (stats) stats.noTitle++;
        warn('Title too short for ASIN', asin, '- candidates:', titleCandidates.map((c) => c.text.slice(0, 40)));
        return null;
      }
      if (best && best.selector !== 'anchor-aria-label') {
        log('Title found via:', best.selector, `(${best.len} chars)`);
      }

      const price = amazonPrice(node);
      if (price == null) {
        // Out of stock / unavailable / price not yet hydrated -> the card is
        // not buyable, but the PAGE SCAN must keep going. Count it and move
        // on; extractAmazon() retries once when the whole page came back
        // priceless (Amazon paints titles before it hydrates prices).
        if (stats) stats.noPrice++;
        warn('No valid price for:', title);
        return null;
      }

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

      // Prime detection (Phase 2 profit math): "Get Fast, Free Shipping with
      // Amazon Prime" / .prima-badge / delivery blocks all carry it. Absence
      // of any marker is NOT evidence of non-Prime, so this is best-effort.
      const primeEl = node.querySelector(
        '.prima-badge, .s-prime-badge, i.a-icon-prime, [aria-label*="Prime" i], ' +
        '.s-image[alt*="Prime" i]'
      );
      const primeText = /\bprime\b/i.test((node.innerText || '').slice(0, 400));
      const isPrime = !!(primeEl || primeText);

      return {
        id: asin,
        site: 'amazon',
        title,
        price,
        priceText: `$${price.toFixed(2)}`,
        image: amazonImage(node),
        url: `https://www.amazon.com/dp/${asin}`,
        rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
        ratingText: ratingTxt || null,
        isPrime,
        condition
      };
    } catch (e) { warn('parseAmazonNode error:', e.message); return null; }
  }

  /**
   * Phase 3 (manual-match flow): extract a single Amazon product page.
   * The popup's ASIN/URL override opens /dp/<ASIN> and we need its real
   * buybox price — search-grid selectors don't exist on product pages. Any
   * missing core field (title, price) returns null and reports 'no-title',
   * which background.js already translates into a region/availability error.
   */
  function parseAmazonProductPage() {
    try {
      const asin = (location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i) || [])[1];
      if (!asin) { warn('Product page has no ASIN:', location.pathname); return null; }

      const titleEl = document.querySelector('#productTitle, h1#title, .product-title-word-break, #itemTitle');
      const title = titleEl
        ? titleEl.textContent.replace(/\s+/g, ' ').trim()
        : '';
      if (title.length < 4) { warn('Product page title missing:', asin); return null; }

      // Buybox price selectors (in descending order of specificity). The
      // .a-offscreen value is masked-but-machine-readable; #price_inside_buybox
      // is the legacy fallback; the generic buybox scan is last resort.
      const priceSelectors = [
        '#corePrice_feature_div .a-price .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
        '#apex_desktop .a-price .a-offscreen',
        '#apex_desktop_newAccordionRow .a-price .a-offscreen',
        '.priceToPay .a-offscreen',
        'span.a-price[data-a-size="xl"] .a-offscreen',
        '#price_inside_buybox',
        '#outOfStock .a-price .a-offscreen'
      ];
      let price = null;
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const p = parseMoney(el.textContent);
        if (p != null) { price = p; break; }
      }
      if (price == null) {
        // Last resort: the first "$amount" anywhere in the buybox column.
        const box = document.querySelector('#buybox, #desktop_buybox, #centerCol') || document.body;
        const m = (box.innerText || '').match(/\$\s?([\d,]+(?:\.\d+)?)/);
        if (m) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (Number.isFinite(v) && v > 0) price = v;
        }
      }
      if (price == null) { warn('Product page price missing:', asin); return null; }

      // Prime / free shipping: the delivery block ("FREE delivery … with
      // Amazon Prime"). Rarely a checkbox, always text — best effort, same
      // semantics as the search-card prime detection.
      const bodyText = (document.body ? document.body.innerText || '' : '');
      const primeArea = (bodyText.slice(0, 4000) || '').toLowerCase();
      const isPrime = /\bprime\b/i.test(primeArea) && /free shipping|free delivery/i.test(primeArea);

      const ratingEl = document.querySelector('#acrPopover, #acrPopoverLink, span.a-icon-alt, [data-hook="rating-out-of-text"]');
      const ratingTxt = ratingEl ? ratingEl.textContent.trim() : '';
      const ratingMatch = ratingTxt.match(/(\d+(?:\.\d+)?)\s*out of 5/);

      const img = document.querySelector('#landingImage, #imgBlkFront, img[data-a-dynamic-image], img[src*="images/I/"]');
      const rawImg = (img && (img.currentSrc || img.src)) || '';
      const image = /^https?:\/\//.test(rawImg) && !/\/images\/G\/01\//.test(rawImg) ? rawImg : null;

      return {
        id: asin,
        site: 'amazon',
        title,
        price,
        priceText: `$${price.toFixed(2)}`,
        image,
        url: `https://www.amazon.com/dp/${asin}`,
        rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
        ratingText: ratingTxt || null,
        isPrime,
        condition: /used|refurbished|renewed/i.test(bodyText.slice(0, 2000)) ? 'Used' : 'New'
      };
    } catch (e) { warn('parseAmazonProductPage error:', e.message); return null; }
  }

  /**
   * Extract Amazon search results.
   *
   * Amazon renders the first viewport immediately on some 2024-2026 A/B
   * layouts and lazy-hydrates the rest of the grid only after the tab
   * finishes loading and the user scrolls. A single synchronous read was
   * clutching only the ~6 visible cards — the main reason pages were
   * reporting ~1-6 instead of 16-24. This version re-scans after a bounded
   * scroll + wait so the full organic set is in the DOM before parsing.
   */
  async function extractAmazon(run) {
    let containers = amazonContainers();
    const minExpected = 8; // a fully-loaded page exposes 16-24 organic cards

    for (let attempt = 0; attempt < 2 && containers.length < minExpected; attempt++) {
      log(`Amazon grid still thin (${containers.length} < ${minExpected}); scrolling for lazy render...`);
      window.scrollTo(0, document.body.scrollHeight);
      await sleepPaced(800 + attempt * 500, run);
      if (!isCurrent(run)) return [];
      containers = amazonContainers();
    }

    // Return to the top so pagination starts from a clean scroll position.
    window.scrollTo({ top: 0, behavior: 'instant' });

    const stats = { scanned: 0, noAnchor: 0, badAsin: 0, noTitle: 0, noPrice: 0 };
    const parseAll = () => {
      const items = [];
      const seen = new Set();
      for (const node of containers) {
        stats.scanned++;
        const it = parseAmazonNode(node, stats);
        if (!it || seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
        if (items.length >= CFG.maxItems.amazon) break;
      }
      return items;
    };

    let items = parseAll();

    // Price hydration retry: Amazon frequently renders titles/links first and
    // fills in the masked prices a beat later. If the grid clearly rendered
    // organic cards but NONE carried a parsable price, give hydration ONE
    // bounded retry instead of reporting a dead page (which used to cascade
    // into 'parse-failed' -> stage failure -> premature tab close).
    if (!items.length && stats.noPrice > 0) {
      log(`Grid has cards but 0 priced items (${stats.noPrice} skipped) — retrying once after hydration wait...`);
      await sleepPaced(1200, run);
      if (!isCurrent(run)) return { items: [], stats };
      stats.scanned = 0; stats.noAnchor = 0; stats.badAsin = 0; stats.noTitle = 0; stats.noPrice = 0;
      items = parseAll();
    }

    if (stats.noPrice > 0) {
      warn(`${stats.noPrice}/${stats.scanned} cards skipped: no parsable price (page scan continues with the rest)`);
    }
    return { items, stats };
  }

/* ------------------------------------------------------------------ *
 * EBAY extraction — FIXED for new .s-card layout
 * ------------------------------------------------------------------ */

  /** Wait for eBay results grid to render (bounded, like Amazon). */
  function waitEbayGrid(run) {
    const gridSelectors = [
      'li.s-card',           // primary new layout
      'li.s-item',           // old layout fallback
      'div.s-card',
      'ul.srp-results li',
      '.s-item__wrapper',
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
      let checkInterval = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(giveUp);
        if (checkInterval) clearInterval(checkInterval);
        resolve(ok);
      };
      const obs = new MutationObserver((mutations) => {
        if (!isCurrent(run)) return finish(false);
        mutationCount += mutations.length;
        if (mutationCount % 2 === 0 && present()) finish(true);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      
      // Fallback: periodic check in case mutations don't trigger (e.g., JS replacing innerHTML)
      let fallbackChecks = 0;
      checkInterval = setInterval(() => {
        if (!isCurrent(run)) return finish(false);
        fallbackChecks++;
        if (present()) finish(true);
        // Stop checking after 80% of timeout to avoid race with giveUp
        if (fallbackChecks >= Math.floor(CFG.gridWaitMs / 500) - 1) {
          clearInterval(checkInterval);
        }
      }, 500);
      
      const giveUp = setTimeout(() => {
        warn('eBay grid wait timeout - checking for partial render...');
        finish(present());
      }, CFG.gridWaitMs);
    });
  }

  /** Clean eBay title by removing common prefixes. */
  function cleanEbayTitle(t) {
    let s = (t || '').replace(/\s+/g, ' ').trim();
    // Strip eBay list chrome prefixes ("New Listing", "Results for ...", ...)
    s = s.replace(/^(?:New Listing|Results for|Best Match|Sponsored|Ad)\s*[-:–]?\s*/i, '');
    if (s.length < 4 || /^shop on ebay$/i.test(s)) return '';
    return s;
  }

  /** eBay price may be "US $12.99", "C $15.00", "$9.99 to $14.99", etc.
   *  Returns the lowest price in USD, ignoring non-USD currencies. */
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

  /**
   * Extract image URL from eBay card.
   * FIXED: Handles <picture> elements, <source> srcset, lazy-loaded images,
   * data-src/data-lazy-src attributes, and upgrades to a higher-res URL.
   */
  function ebayImage(node) {
    // 1) Try <picture> <source> elements first (eBay's new lazy-loading pattern)
    const pictureSource = node.querySelector('picture source[srcset], picture source[data-srcset]');
    if (pictureSource) {
      const srcset = pictureSource.getAttribute('srcset') || pictureSource.getAttribute('data-srcset') || '';
      const url = firstUrlFromSrcset(srcset);
      if (/^https?:\/\//.test(url) && !/\/svg\//.test(url)) {
        return url.replace(/\/s-l(?:64|96|140|225)\./, '/s-l300.');
      }
    }

    // 2) Try <img> elements with multiple selector strategies
    const imgSelectors = [
      '.su-media-carousel img.s-card__image',
      '.su-image img',
      'img.s-card__image',
      'img[src*="i.ebayimg.com"]',
      '.s-item__image-wrapper img',
      'img.s-item__image',
      'img[data-src*="i.ebayimg.com"]',
      'img[data-lazy-src*="i.ebayimg.com"]',
      'img[srcset*="i.ebayimg.com"]',
      'img[data-srcset*="i.ebayimg.com"]',
      'img[alt]'
    ];

    let img = null;
    let matchedSel = null;
    for (const selector of imgSelectors) {
      img = node.querySelector(selector);
      if (img) { matchedSel = selector; break; }
    }
    if (!img) return null;

    // 3) Extract URL from the image element using all known attribute sources
    const raw = imageUrlFromElement(img).replace(/\/s-l(?:64|96|140|225)\./, '/s-l300.');
    if (/^https?:\/\//.test(raw) && !/\/svg\//.test(raw)) {
      log('eBay image found via:', matchedSel);
      return raw;
    }
    return null;
  }

  /** Parse a single eBay product card (li.s-card or similar). */
  function parseEbayNode(node) {
    try {
      // --- 1. Find the main link (product URL) ---
      const anchorSelectors = [
        'a.s-card__link[href*="/itm/"]',
        'a[href*="/itm/"]',
        'a.s-item__link[href]'
      ];
      let anchor = null;
      for (const selector of anchorSelectors) {
        anchor = node.querySelector(selector);
        if (anchor && anchor.href && anchor.href.includes('/itm/')) break;
      }
      // Fallback: scan all anchors in the node
      if (!anchor || !anchor.href || !anchor.href.includes('/itm/')) {
        const allAnchors = node.querySelectorAll('a[href]');
        for (const a of allAnchors) {
          if (a.href && a.href.includes('/itm/')) {
            anchor = a;
            break;
          }
        }
      }
      if (!anchor) {
        log('eBay container has no valid anchor');
        return null;
      }

      // --- 2. Extract item ID ---
      let id = node.getAttribute('data-listingid');
      if (!id) {
        const match = anchor.href.match(/\/itm\/(\d{9,})/);
        if (match) id = match[1];
      }
      if (!id) {
        warn('eBay item ID not found');
        return null;
      }

      // --- 3. Title ---
      // New layout: .s-card__title span.su-styled-text.primary.default
      const titleSelectors = [
        '.s-card__title span.su-styled-text.primary.default',
        '.s-card__title',
        '.s-item__title',
        '.s-item__title span',
        'h3.s-item__title',
        'span[role="heading"]'
      ];
      let titleEl = null;
      for (const selector of titleSelectors) {
        titleEl = node.querySelector(selector);
        if (titleEl && titleEl.textContent.trim().length > 3) break;
      }
      if (!titleEl) titleEl = anchor; // fallback
      const title = cleanEbayTitle(titleEl ? titleEl.textContent : anchor.title || '');
      if (!title) {
        warn('No valid title for eBay item');
        return null;
      }

      // --- 4. Price ---
      // New layout: .s-card__price (there may be multiple; take the first that has a number)
      let price = null;
      const priceSelectors = [
        '.s-card__price',
        '.s-item__price',
        'span[class*="price"]',
        '.x-price-primary',
        '.s-item__detail--primary span',
        'div[data-testid="item-price"]'
      ];
      for (const selector of priceSelectors) {
        const elements = node.querySelectorAll(selector);
        for (const el of elements) {
          const p = parseEbayPrice(el.textContent);
          if (p != null) {
            price = p;
            break;
          }
        }
        if (price != null) break;
      }

      // Fallback: scan the entire card text for $ amounts.
      if (price == null) {
        const t = (node.innerText || '').slice(0, 800);
        if (/\$/.test(t) && !/[£€]/.test(t)) {
          price = parseEbayPrice(t);
        }
      }
      if (price == null) {
        warn('No valid price for eBay item:', title.slice(0, 80));
        return null;
      }

      // --- 5. Condition ---
      const condSelectors = [
        '.s-card__subtitle span.su-styled-text.secondary.default',
        '.s-item__condition',
        '.s-item__subtitle',
        'span.SECONDARY_INFO',
        '.s-item__condition-text',
        '.x-item-condition',
        'div[itemprop="itemCondition"]'
      ];
      let condEl = null;
      for (const selector of condSelectors) {
        condEl = node.querySelector(selector);
        if (condEl && condEl.textContent.trim().length > 1) break;
      }
      const condition = condEl ? condEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : '';

      // --- 6. Image ---
      const image = ebayImage(node);

      // --- 7. Build result ---
      log('Parsed eBay item:', { id, title: title.slice(0, 50), price, condition });
      return {
        id,
        site: 'ebay',
        title,
        price,
        priceText: `$${price.toFixed(2)}`,
        image,
        url: `https://www.ebay.com/itm/${id}`,
        rating: null,
        condition
      };
    } catch (e) {
      warn('parseEbayNode error:', e.message);
      return null;
    }
  }

  /** Collect all product container nodes from the eBay search results page. */
  function ebayContainers() {
    // Use a Map keyed by item ID to deduplicate.
    const byId = new Map();
    let totalFound = 0;

    // Strategy A: new .s-card layout (horizontal and vertical)
    const cardSelectors = [
      'li.s-card',
      'div.s-card',
      'li.s-card--horizontal',
      'li.s-card--vertical',
      'div[data-testid="search-result"]',
      'article.s-item'
    ];
    for (const sel of cardSelectors) {
      try {
        const nodes = Array.from(document.querySelectorAll(sel));
        if (nodes.length > 0) {
          log(`eBay selector "${sel}" matched ${nodes.length} nodes`);
          totalFound += nodes.length;
          for (const n of nodes) {
            const id = n.getAttribute('data-listingid');
            if (id && !byId.has(id)) {
              // Verify it has a link to a product
              if (n.querySelector('a[href*="/itm/"]')) {
                byId.set(id, n);
              }
            }
          }
        }
      } catch (_) { /* ignore */ }
    }

    if (byId.size >= 2) {
      log(`Total unique eBay items found: ${byId.size} (from ${totalFound} raw matches)`);
      return Array.from(byId.values());
    }

    // Strategy B: fallback – old .s-item or generic list items
    const fallbackSelectors = [
      'li.s-item',
      'ul.srp-results li',
      'div.s-item__wrapper'
    ];
    for (const sel of fallbackSelectors) {
      try {
        const nodes = Array.from(document.querySelectorAll(sel));
        if (nodes.length > 0) {
          log(`eBay fallback selector "${sel}" matched ${nodes.length} nodes`);
          for (const n of nodes) {
            const anchor = n.querySelector('a[href*="/itm/"]');
            if (!anchor) continue;
            const match = anchor.href.match(/\/itm\/(\d{9,})/);
            if (match && !byId.has(match[1])) {
              byId.set(match[1], n);
            }
          }
        }
      } catch (_) { /* ignore */ }
    }

    if (byId.size >= 2) {
      log(`eBay fallback found ${byId.size} unique items`);
      return Array.from(byId.values());
    }

    // Strategy C: last-resort – any container with an /itm/ link
    log('Attempting eBay anchor-based fallback...');
    document.querySelectorAll('a[href*="/itm/"]').forEach((a) => {
      const match = a.href.match(/\/itm\/(\d{9,})/);
      if (!match || byId.has(match[1])) return;
      // Find the closest reasonable container
      const container = a.closest('li, div[class*="s-card"], div[class*="s-item"], div[class*="srp"], article, div[data-testid="search-result"]') || a.parentElement;
      if (container) {
        byId.set(match[1], container);
      }
    });

    if (byId.size > 0) {
      log(`eBay anchor fallback found ${byId.size} items`);
      return Array.from(byId.values());
    }

    return [];
  }

  /**
   * Detect the total number of available pages from eBay's pagination controls.
   *
   * Strategy:
   *   1. Collect every pagination item's text or aria-label (e.g. "1", "2",
   *      "…", "Next"). The highest numeric value seen is the max page.
   *   2. If a "Next" button is still present beyond the highest number shown
   *      (eBay sometimes clips the last digit), assume max + 1.
   *   3. Fall back to scanning anchor hrefs carrying the `_pgn=` page param.
   *
   * Returns null when the pagination element is missing or malformed so the
   * caller can fall back to a safe default instead of looping forever.
   */
  function ebayMaxPage() {
    try {
      const numbers = new Set();
      let sawNext = false;

      // 1) Primary: numbered pagination items (ol.pagination__items is eBay's
      //    classic pager; .x-pagination is the newer layout).
      const pagerSelectors = [
        'ol.pagination__items li',
        '.pagination__items li',
        '.srp-controls__pagination li',
        '.x-pagination li',
        'nav.pagination li',
        'div.pagination li',
        'li[class*="pagination"]'
      ];
      for (const sel of pagerSelectors) {
        try {
          const nodes = document.querySelectorAll(sel);
          if (!nodes.length) continue;
          for (const n of nodes) {
            const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
            const asNum = parseInt(t, 10);
            if (Number.isInteger(asNum) && asNum > 0 && asNum <= 500) {
              numbers.add(asNum);
            }
            const label = (n.getAttribute && n.getAttribute('aria-label')) || '';
            if (/next/i.test(t) || /next/i.test(label)) sawNext = true;
          }
        } catch (_) { /* ignore selector errors */ }
      }

      if (numbers.size) {
        const max = Math.max(...numbers);
        return sawNext ? max + 1 : max;
      }

      // 2) Fallback: scrape page numbers from pagination anchors / _pgn= hrefs.
      try {
        const linkSelectors = [
          'ol.pagination__items a[href]',
          '.pagination a[href]',
          '.srp-controls__pagination a[href]',
          'li.pagination__item a[href]',
          'a[href*="_pgn="]'
        ];
        for (const sel of linkSelectors) {
          const links = document.querySelectorAll(sel);
          if (!links.length) continue;
          for (const a of links) {
            const label = (a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').trim();
            const m = label.match(/(?:page\s*)?(\d{1,3})/i);
            if (m) {
              const asNum = parseInt(m[1], 10);
              if (Number.isInteger(asNum) && asNum > 0 && asNum <= 500) numbers.add(asNum);
            }
          }
          if (numbers.size) break;
        }
      } catch (_) { /* ignore */ }

      if (numbers.size) {
        const max = Math.max(...numbers);
        const hasNext = document.querySelector(
          '.pagination__next, .pagination__next[href], a[aria-label*="next" i], button.pagination__next, [class*="pagination__next"]'
        );
        return hasNext ? max + 1 : max;
      }

      // 3) Nothing usable found — caller decides the fallback.
      log('eBay pagination element not found - maxPage unknown');
      return null;
    } catch (e) {
      warn('ebayMaxPage error:', e.message);
      return null;
    }
  }

  /**
   * Detect the total number of available pages from Amazon's pagination controls.
   *
   * Strategy:
   *   1. Look for Amazon's pagination container with class "s-pagination-container"
   *   2. Extract page numbers from pagination links (a[href*="page="])
   *   3. Check for "Next" or "Siguiente" button to determine if more pages exist
   *   4. Fall back to URL parameters and page count displays
   *
   * Returns null when pagination element is missing or malformed.
   */
  function amazonMaxPage() {
    try {
      const numbers = new Set();
      let sawNext = false;

      // DEBUG: Log what we're finding
      log('[DEBUG amazonMaxPage] Starting detection...');
      
      // 1) Primary: Amazon's pagination container
      const paginationContainer = document.querySelector('.s-pagination-container');
      log('[DEBUG amazonMaxPage] paginationContainer found:', !!paginationContainer);
      
      if (paginationContainer) {
        // Get all page number links
        const pageLinks = paginationContainer.querySelectorAll('a[href*="page="], a[href*="ref=sr_pg_"]');
        log('[DEBUG amazonMaxPage] pageLinks count:', pageLinks.length);
        
        for (const link of pageLinks) {
          const text = (link.textContent || '').replace(/\s+/g, ' ').trim();
          const asNum = parseInt(text, 10);
          if (Number.isInteger(asNum) && asNum > 0 && asNum <= 500) {
            numbers.add(asNum);
            log('[DEBUG amazonMaxPage] Found page number:', asNum);
          }
          // Check for next button
          if (/next|siguiente|suivant|weiter|prossimo|avançar/i.test(text) || 
              /next|siguiente|suivant|weiter|prossimo|avançar/i.test(link.getAttribute('aria-label') || '')) {
            sawNext = true;
            log('[DEBUG amazonMaxPage] Found Next button via link text');
          }
        }

        // Also check for span/page elements with numbers
        const pageElements = paginationContainer.querySelectorAll('span, div, li');
        log('[DEBUG amazonMaxPage] pageElements count:', pageElements.length);
        
        for (const el of pageElements) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          const asNum = parseInt(text, 10);
          if (Number.isInteger(asNum) && asNum > 0 && asNum <= 500) {
            numbers.add(asNum);
            log('[DEBUG amazonMaxPage] Found page number from element:', asNum);
          }
        }
      }

      // 2) Fallback: scan all links with page parameter
      if (numbers.size === 0) {
        const links = document.querySelectorAll('a[href*="page="]');
        log('[DEBUG amazonMaxPage] Fallback: scanning all page= links, count:', links.length);
        
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/[?&]page=(\d+)/);
          if (match) {
            const asNum = parseInt(match[1], 10);
            if (Number.isInteger(asNum) && asNum > 0 && asNum <= 500) {
              numbers.add(asNum);
              log('[DEBUG amazonMaxPage] Found page from href:', asNum);
            }
          }
        }
      }

      // 3) Check for "Next" button separately
      if (!sawNext) {
        const nextButton = document.querySelector(
          '.s-pagination-next, a[href*="page="][aria-label*="next" i], a[href*="page="][aria-label*="siguiente" i], button[class*="next"], [role="button"][aria-label*="next" i]'
        );
        if (nextButton) {
          sawNext = true;
          log('[DEBUG amazonMaxPage] Found Next button via selector');
        }
      }

      log('[DEBUG amazonMaxPage] numbers set:', [...numbers], 'sawNext:', sawNext);

      if (numbers.size) {
        const max = Math.max(...numbers);
        const result = sawNext ? Math.max(max, max + 1) : max;
        log('[DEBUG amazonMaxPage] Returning maxPage:', result);
        return result;
      }

      // 4) Last resort: check current page URL and estimate from result count
      const currentPageMatch = location.search.match(/[?&]page=(\d+)/);
      if (currentPageMatch) {
        const currentPage = parseInt(currentPageMatch[1], 10);
        // If we're on a page and there are results, assume at least this many pages exist
        const resultItems = document.querySelectorAll('[data-asin]');
        log('[DEBUG amazonMaxPage] Current page from URL:', currentPage, 'resultItems:', resultItems.length);
        
        if (resultItems.length > 0) {
          log('[DEBUG amazonMaxPage] Returning current page as maxPage:', currentPage);
          return currentPage;
        }
      }

      log('[DEBUG amazonMaxPage] Amazon pagination element not found - maxPage unknown');
      return null;
    } catch (e) {
      warn('[DEBUG amazonMaxPage] error:', e.message);
      return null;
    }
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
   * Orchestration (unchanged)
   * ------------------------------------------------------------------ */
  let autoRan = false;

  function report(run, payload) {
    if (!isCurrent(run)) return;
    const msg = Object.assign({
      type: 'ARB_RESULTS',
      runId: run.id,
      site: SITE,
      query: QUERY,
      page: PAGE,
      url: location.href,
      title: document.title,
      items: [],
      error: null
    }, payload);
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  async function runScrape(opts) {
    opts = opts || {};
    if (currentRun && isCurrent(currentRun)) killCurrent();
    const run = makeRun();
    log('[SCRAPE START] runId:', run.id, 'hidden:', document.hidden, 'readyState:', document.readyState);

    const work = (async () => {
      if (isBlockedPage()) { 
        log('[BLOCKED] Detected blocked page immediately');
        report(run, { error: 'blocked' }); 
        return; 
      }

      // Phase 3: Amazon single-product pages (manual-match ASIN/URL override)
      // skip the search-grid machinery entirely — parse the buybox directly.
      if (SITE === 'amazon' && isProductPath) {
        log('[PRODUCT PAGE] Parsing buybox instead of search grid');
        const item = parseAmazonProductPage();
        if (!isCurrent(run)) return;
        if (item) {
          log('Parsed product page:', { asin: item.id, title: item.title.slice(0, 50), price: item.price });
          report(run, { items: [item] });
        } else {
          report(run, { error: 'no-title' });
        }
        return;
      }

      if (!document.hidden) {
        log('[PAUSE] Starting pre-parse human pause...');
        await humanPause(run, CFG.preParseMinMs, CFG.preParseMaxMs);
        log('[PAUSE] Pre-parse pause complete, checking run status...');
        if (!isCurrent(run)) { log('[ABORT] Run superseded after pre-parse pause'); return; }
        log('[SCROLL] Starting human scroll...');
        await humanScroll(run);
        log('[SCROLL] Scroll complete, checking run status...');
        if (!isCurrent(run)) { log('[ABORT] Run superseded after scroll'); return; }
        log('[PAUSE] Starting post-scroll pause...');
        await humanPause(run, 200, 400);
        log('[PAUSE] Post-scroll pause complete');
        if (!isCurrent(run)) { log('[ABORT] Run superseded after post-scroll pause'); return; }
      } else {
        log('[SKIP] Document hidden, skipping human pacing');
      }

      if (SITE === 'amazon') {
        log('[GRID WAIT] Starting waitAmazonGrid...');
        const gridReady = await waitAmazonGrid(run);
        log('[GRID WAIT] Result:', gridReady, 'run still current:', isCurrent(run));
        if (!isCurrent(run)) { log('[ABORT] Run superseded during grid wait'); return; }
        if (isBlockedPage()) { 
          log('[BLOCKED] Detected blocked page after grid wait');
          report(run, { error: 'blocked' }); 
          return; 
        }
        if (!gridReady) {
          log('[GRID FAIL] Grid did not render, checking for no-results message...');
          const noResultsEl = document.querySelector('.s-no-results, #noResultsTitle, .a-alert-heading, [data-component-type="s-no-results"]');
          if (noResultsEl && /no results|did not match|try checking|no products found/i.test(noResultsEl.textContent)) {
            report(run, { error: 'no-results' });
          } else {
            report(run, { error: 'parse-failed' });
          }
          return;
        }
        log('[GRID OK] Grid ready, proceeding to extraction');
      }
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

      let items = [];
      let priceStats = null;
      try {
        const extraction = SITE === 'amazon' ? await extractAmazon(run) : null;
        if (extraction) {
          items = extraction.items;
          priceStats = extraction.stats;
        } else {
          items = extractEbay();
        }
      } catch (e) {
        warn('Extraction error:', e.message);
        report(run, { error: 'parse-failed' });
        return;
      }

      if (!items.length) {
        log('[NO ITEMS] Extraction returned empty array');
        if (SITE === 'amazon') {
          const hasProductLinks = document.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]').length > 0;
          log('[NO ITEMS] Amazon - hasProductLinks:', hasProductLinks, 'priceStats:', priceStats);
          if (priceStats && priceStats.noPrice > 0 && hasProductLinks) {
            // Cards rendered with titles/links but no parsable price — a
            // DISTINCT, recoverable reason. background.js keeps the tab open
            // and retries / falls back instead of treating the stage as dead
            // and calling chrome.tabs.remove() on it.
            log('[NO ITEMS] Reporting price-parse error');
            report(run, { error: 'price-parse', skippedForPrice: priceStats.noPrice });
          } else if (hasProductLinks) {
            log('[NO ITEMS] Reporting parse-failed (has links but no items)');
            report(run, { error: 'parse-failed' });
          } else {
            log('[NO ITEMS] Reporting no-results');
            report(run, { error: 'no-results' });
          }
        } else {
          const hasProductLinks = document.querySelectorAll('a[href*="/itm/"]').length > 0;
          log('[NO ITEMS] eBay - hasProductLinks:', hasProductLinks);
          if (hasProductLinks) {
            report(run, { error: 'parse-failed' });
          } else {
            report(run, { error: 'no-results' });
          }
        }
        return;
      }

      log('[EXTRACTION OK] Items extracted:', items.length, '- proceeding to report');
      await humanPause(run, CFG.pauseMinMs, CFG.pauseMaxMs);
      if (SITE === 'ebay') {
        // Report how many pages eBay exposed so background.js can iterate all
        // of them dynamically (instead of stopping at a hardcoded page count).
        const maxPage = ebayMaxPage();
        log('eBay max page detected:', maxPage);
        log('[REPORT] Sending eBay results:', items.length, 'items, maxPage:', maxPage);
        report(run, { items, maxPage });
      } else if (SITE === 'aliexpress') {
        // AliExpress: detect and report maxPage for pagination
        const aliexpressMax = aliexpressMaxPage();
        log('[DEBUG] AliExpress page', window.location.href);
        log('[DEBUG] AliExpress items found:', items.length);
        log('[DEBUG] AliExpress maxPage detected:', aliexpressMax);
        log('[REPORT] Sending AliExpress results:', items.length, 'items, maxPage:', aliexpressMax);
        report(run, { items, maxPage: aliexpressMax });
      } else {
        // Amazon
        const amazonMax = amazonMaxPage();
        log('[DEBUG] Amazon page', window.location.href);
        log('[DEBUG] Amazon items found:', items.length);
        log('[DEBUG] Amazon maxPage detected:', amazonMax);
        log('[REPORT] Sending Amazon results:', items.length, 'items, maxPage:', amazonMax);
        report(run, { items, maxPage: amazonMax });
      }
    })();

    try {
      log('[TIMEOUT WATCH] Starting scrape with deadline:', CFG.scrapeDeadlineMs, 'ms');
      await withTimeout(work, CFG.scrapeDeadlineMs, 'scrape');
      log('[SCRAPE COMPLETE] Finished within deadline');
      if (isCurrent(run)) killCurrent();
    } catch (err) {
      const reason = err instanceof Error && /^timeout:/.test(err.message)
        ? 'timeout'
        : 'parse-failed';
      log('[SCRAPE ERROR]', reason, '-', err.message);
      report(run, { error: reason });
      killCurrent();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'ARB_SCRAPE_NOW') return false;
    if (msg.runId && currentRun && msg.runId !== currentRun.id) return false;
    sendResponse({ ok: true, runId: currentRun ? currentRun.id : null });
    runScrape({ force: true });
    return false;
  });

  if (!isSearchPath && !isProductPath) {
    // Never fast-fail a redirect: classify + grace-wait first (see
    // scheduleRedirectReport). This gate used to report 'no-results-page'
    // instantly, burning the whole fallback query plan in ~1-2s and closing
    // the Amazon tab before any real page could load.
    scheduleRedirectReport();
    return;
  }

  // Phase 3: product pages carry no ?k= search query — run the buybox parse.
  if (isProductPath) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => runScrape({ force: false }));
    } else {
      runScrape({ force: false });
    }
    return;
  }

  if (!QUERY) { report(makeRun(), { error: 'no-query' }); return; }
  if (isBlockedPage()) { report(makeRun(), { error: 'blocked' }); return; }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => runScrape({ force: false }));
  } else {
    runScrape({ force: false });
  }
})();