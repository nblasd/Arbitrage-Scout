/*
 * content-item.js — eBay ITEM page scraper (Phase 2)
 * -----------------------------------------------------------------------------
 * Registered in manifest.json for https://www.ebay.com/itm/* and
 * https://*.ebay.com/itm/*. When background.js opens a canonical eBay item
 * URL in a tab, this script parses the product and reports it:
 *
 *   { type: 'ARB_ITEM_DATA', site: 'ebay', itemId, url, item: {...} }
 *
 * The `item` payload is exactly the `EbayProduct` shape from Phase 1:
 *   { title, price, shipping, shippingLabel, totalPrice, condition,
 *     description, specifics: {brand, mpn, model, upc, ean, …},
 *     brand, mpn, model, gtin, quantity, isBundle, source: 'ebay' }
 *
 * Reuses the Phase-1 extractor (ebay2amazon.js) rather than duplicating the
 * selector logic — this file only handles the content-script environment:
 * run tokens, bounded waits, blocked-page reporting, and the message channel.
 *
 * Reuse of the extractor also keeps test coverage honest: the same
 * extractFromDocument code is exercised by test_phase1.js in Node.
 *
 * Anti-hang design mirrors content.js:
 *   - every async step checks a run token and bails when superseded,
 *   - the whole parse is raced against a wall-clock deadline,
 *   - blocked pages report 'blocked' instead of hanging.
 */
(() => {
  'use strict';

  // Dead extension context (extension reloaded/updated) -> do nothing.
  if (!chrome.runtime || !chrome.runtime.id) return;

  const HOST = location.hostname.toLowerCase();
  const IS_EBAY = HOST === 'ebay.com' || HOST.endsWith('.ebay.com');
  const IS_ITEM_PATH = /^\/itm\//.test(location.pathname);
  if (!IS_EBAY || !IS_ITEM_PATH) return;

  // Skip checkout/cart shells that embed an /itm/ path but no product.
  if (/\/cart\/|\/checkout\//.test(location.pathname)) return;

  /* The extractor (ebay2amazon.js) is loaded via manifest "js" array order
   * on /itm/ pages: [ebay2amazon.js, content-item.js] — so ARBScout is
   * defined here. Guard anyway: a failed load must not throw mid-parse. */
  const SCOUT = (typeof self !== 'undefined' && self.ARBScout) || null;
  if (!SCOUT) {
    try {
      chrome.runtime.sendMessage({
        type: 'ARB_ITEM_DATA', site: 'ebay', itemId: null, url: location.href,
        item: null, error: 'parse-failed'
      }).catch(() => {});
    } catch (_) { /* ignore */ }
    return;
  }

  const log = (...a) => console.debug('[EBAY-ITEM]', ...a);
  const warn = (...a) => console.warn('[EBAY-ITEM:WARN]', ...a);

  /* ------------------------------------------------------------------ *
   * Run token (same pattern as content.js)                              *
   * ------------------------------------------------------------------ */
  let currentRun = null;
  function makeRun() {
    const run = { id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, dead: false };
    currentRun = run;
    return run;
  }
  const isCurrent = (run) => run && !run.dead && run === currentRun;
  const killCurrent = () => { if (currentRun) currentRun.dead = true; };

  const withTimeout = (promise, ms, label) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  /** eBay item pages sometimes render the specifics table late; wait bounded. */
  function waitForProductContent(deadlineMs) {
    const ready = () => {
      const title = document.querySelector('h1, .x-item-title');
      const price = document.querySelector('.x-price-primary [itemprop="price"], .x-price-primary');
      return !!(title && title.textContent.trim().length > 3 && price);
    };
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const obs = new MutationObserver(() => { if (ready()) { obs.disconnect(); resolve(true); } });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(ready()); }, deadlineMs);
    });
  }

  function isBlockedPage() {
    if (/captcha|challenge|signin|error/i.test(location.href)) return true;
    const head = (document.body ? document.body.innerText : '').slice(0, 3000);
    return /unusual traffic|security challenge|are you a robot|verify your identity|please complete/i.test(head);
  }

  function report(run, payload) {
    if (!isCurrent(run)) return;
    const msg = Object.assign({
      type: 'ARB_ITEM_DATA',
      site: 'ebay',
      itemId: null,
      url: location.href,
      item: null,
      error: null
    }, payload);
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  /** One scrape attempt: parse the item page and report the payload. */
  function scrapeOnce(run) {
    if (isBlockedPage()) { report(run, { error: 'blocked' }); return; }
    try {
      const item = SCOUT.extractFromDocument(document, location.href);
      report(run, { itemId: item.itemId, item });
    } catch (e) {
      const code = e && e.code;
      // NO_TITLE with no item id usually means a soft-404; PARSE_FAILED covers
      // genuine layout changes. Both are reported, never thrown into the void.
      warn('extractFromDocument failed:', code || e.message);
      report(run, { error: code === 'NO_TITLE' ? 'no-title' : 'parse-failed' });
    }
  }

  async function runScrape() {
    if (currentRun && isCurrent(currentRun)) killCurrent();
    const run = makeRun();
    try {
      await withTimeout((async () => {
        await waitForProductContent(5000);
        if (!isCurrent(run)) return;
        scrapeOnce(run);
      })(), 8000, 'item-parse');
      if (isCurrent(run)) killCurrent();
    } catch (err) {
      const reason = err instanceof Error && /^timeout:/.test(err.message) ? 'timeout' : 'parse-failed';
      report(run, { error: reason });
      killCurrent();
    }
  }

  // "Analyze again" from the popup: only the current script instance answers.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'ARB_SCRAPE_ITEM_NOW') return false;
    if (msg.url && msg.url !== location.href.split('?')[0]) return false;
    sendResponse({ ok: true });
    runScrape();
    return false;
  });

  log('eBay item content script active on', location.href);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runScrape);
  } else {
    runScrape();
  }
})();
