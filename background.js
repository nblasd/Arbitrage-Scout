/*
 * background.js — MV3 service worker (orchestrator)
 * -----------------------------------------------------------------------------
 * Message protocol
 * ----------------
 * POPUP  -> BACKGROUND
 *   { type: 'ARB_START',       query }          start a new comparison run
 *   { type: 'ARB_GET_STATE' }                   reply with current run state
 *   { type: 'ARB_FORCE_PARSE', sites: [...] }   re-scrape an already-open page
 *   { type: 'ARB_OPEN_RESULTS', site }          focus (or reopen) the results tab
 *
 * CONTENT -> BACKGROUND
 *   { type: 'ARB_RESULTS', site, query, url, items: [...], error }  scrape outcome
 *
 * BACKGROUND -> POPUP
 *   { type: 'ARB_STATE', state }                state snapshot pushed on every change
 *
 * Why real tabs instead of fetch()?
 *   A popup/service-worker fetch() to amazon.com or ebay.com would be far more
 *   bot-like (no session cookies / fingerprint) and still subject to CORS.
 *   Driving real, visible background tabs means results are rendered with the
 *   user's real session, and content.js only parses pages the user is "on".
 *
 * Why state in chrome.storage.session?
 *   MV3 service workers are killed after ~30s idle. Every step here is driven
 *   by an incoming event (message or alarm), and the run state survives in
 *   session storage, so a restart mid-run picks up exactly where it left off.
 *
 * Why chrome.alarms?
 *   A one-shot watchdog per stage prevents the run from hanging forever if a
 *   page never reports (e.g. Amazon CAPTCHA on a URL our content script is not
 *   allowed on). Chrome's minimum alarm delay is ~1 minute, so the watchdog is
 *   a failsafe — normal scrapes finish in ~10-25s and clear it early.
 */
'use strict';

/* Phase-1 matching engine (ebay2amazon.js): URL validation, eBay extraction,
 * title cleaning/query building and Amazon matching. Loaded eagerly so
 * Phase-2 orchestration (per-item lookup flow) can call self.ARBScout from
 * any message handler. Loading it here has no side effects — the module only
 * defines functions. See README "Phase 1" for the architecture map. */
try { importScripts('ebay2amazon.js'); }
catch (e) { console.warn('[arb] ebay2amazon.js failed to load:', e); }

/* Phase-2 profit engine (profit.js): dropshipping profit/ROI/margin math.
 * Pure functions — used by the analyze flow and by the legacy pairing table. */
try { importScripts('profit.js'); }
catch (e) { console.warn('[arb] profit.js failed to load:', e); }

/* Phase-3 safety harness (safety.js): variation-mismatch guard + quantity
 * discrepancy alerts over the matched (eBay, Amazon) pair. Pure logic. */
try { importScripts('safety.js'); }
catch (e) { console.warn('[arb] safety.js failed to load:', e); }

/* Phase-3: orphan-tab registry + sweep (see closeOwnedTab / sweepOrphanTabs). */
try { importScripts('cleanup.js'); }
catch (e) { console.warn('[arb] cleanup.js failed to load:', e); }

/* ------------------------------------------------------------------ *
 * Constants / config
 * ------------------------------------------------------------------ */
const SEARCH_URLS = {
  amazon: (q, page) => {
    const p = Math.max(1, Number(page) || 1);
    return `https://www.amazon.com/s?k=${encodeURIComponent(q)}&page=${p}&ref=sr_pg_${p}`;
  },
  ebay: (q, page) => {
    const p = Math.max(1, Number(page) || 1);
    return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=0&_pgn=${p}`;
  },
  aliexpress: (q, page) => {
    const p = Math.max(1, Number(page) || 1);
    return `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(q)}&page=${p}`;
  }
};

// eBay final-value fee is ~13.25% for most categories (2025); the popup lets
// the user override this per run. We only store raw prices here.
const MATCH_THRESHOLD = 0.34; // min title-similarity for a pair (0..1)
const MAX_PAIRS = 80;
// eBay page count is now DETECTED dynamically from the search page (content.js
// reports `maxPage`). This constant is only a safe fallback when the pagination
// element can't be found or is malformed — NOT a hard cap anymore.
const EBAY_FALLBACK_MAX_PAGES = 3;
// Hard safety ceiling so a malformed pagination element can't cause an
// unbounded loop. eBay typically caps search pagination at 100 pages.
const EBAY_ABSOLUTE_MAX_PAGES = 100;
const AMAZON_ABSOLUTE_MAX_PAGES = 20;
// Default user-configurable page limit when the popup doesn't send one.
const DEFAULT_PAGE_LIMIT = 3;
// Rate-limit / anti-blocking delays between Amazon page navigations (ms).
const AMAZON_PAGE_DELAY_MIN_MS = 800;
const AMAZON_PAGE_DELAY_MAX_MS = 3000;
// Consecutive unavailable Amazon pages (fast redirect/error reports) the
// analyze flow tolerates — WITH pacing — before failing the stage instead of
// machine-gunning the remaining fallback queries.
const ANALYZE_MAX_CONSECUTIVE_PAGE_ERRORS = 4;

// Per-stage hard timeout. The content script itself is bounded; this
// covers everything around it (navigation, first paint, message latency).
// It is implemented as a plain setTimeout — timers are cheap and reliable
// while the service worker is alive — plus a chrome.alarms failsafe for the
// case where Chrome kills the worker and never resumes it.
const STAGE_TIMEOUT_MS = 45000;
const ALARM_WATCHDOG_MIN = 2; // failsafe alarm, in minutes

/* Phase 3: orphan-tab sweep. Chrome may kill the MV3 worker between the tab
 * being created and any cleanup path running (the setTimeout/alarm watchdogs
 * die with the worker), so a purely event-driven "always close on settle"
 * guarantee is not enough on its own. Belt-and-braces: on every worker start
 * we sweep every tab still registered from a previous life; each stage close
 * unregisters its tab; and the periodic sweep alarm re-runs while any run is
 * active. cleanup.js keeps the registry in chrome.storage.session. */
const TAB_SWEEP_ALARM = 'arb.tabSweep';
const TAB_SWEEP_MINUTES = 5;

/* ------------------------------------------------------------------ *
 * Debug instrumentation (support diagnostics)                          *
/* ------------------------------------------------------------------ *
 * Phase 2: single-item analyze flow (eBay URL -> Amazon match -> profit)
 * ------------------------------------------------------------------ */
// Same per-stage ceiling structure as the keyword run, but with more room
// for the Phase-2 Amazon flow: the search now walks up to `pagesPerSite`
// pages (plus up to ANALYZE_FALLBACK_QUERIES_MAX broader fallback queries),
// so the watchdog must cover page-to-page navigation — NEVER close the tab on
// initial load, and NEVER drop the scrape on the first page's payload.
const ITEM_STAGE_TIMEOUT_MS = 60000;        // 60s total budget per stage
const ITEM_ALARM_WATCHDOG_MIN = 3;          // failsafe alarm, in minutes
// Hard cap on Amazon candidates scored per analyze (Phase 1 spec: top 5–10).
// Deep enough that a genuine match crowded below Amazon's sponsored blocks
// (often ranks 11–16 for niche queries) still reaches the matcher, shallow
// enough to keep scoring and profit work bounded. Prefilter still caps at 40.
// Total Amazon candidates aggregated across ALL pages before pagination stops.
// MUST comfortably exceed a single page's yield (Amazon serves ~16-24 organic
// cards/page) — at 16 it exactly equalled one page, so the cap branch settled
// and closed the tab after page 1 every run (the "instant close" bug).
// Maximum Amazon items to collect before stopping (increased to support 10+ pages)
// ~48 items per page * 15 pages = 720 items max
const ANALYZE_MAX_AMAZON_ITEMS = 1000;
// Amazon pages scraped per analyze run when the popup doesn't send a setting.
const DEFAULT_ANALYZE_PAGES_PER_SITE = 5;
// Maximum number of broader (fallback) Amazon queries tried after a 0-result
// page — prevents the instant "NO_AMAZON_RESULTS" drop before retrying.
const ANALYZE_FALLBACK_QUERIES_MAX = 2;
// Amazon items below this relevance are dropped before profit calc so the
// "best" match is never an irrelevant listing (0 = disabled).
const ANALYZE_MIN_CANDIDATE_SCORE = 0;
// Default user settings for the analyze profit engine (overridable per run
// from the popup; persisted in chrome.storage.local under 'arbSettings').
const DEFAULT_ANALYZE_SETTINGS = {
  ebayFeeRate: 13.25,   // % (eBay final-value fee, most categories)
  fixedFee: 0.30,       // $ per order
  estimatedSalesTax: 7, // % state sales tax paid when buying on Amazon
  extraCostBuffer: 0.0, // $ misc buffer
  pagesPerSite: DEFAULT_ANALYZE_PAGES_PER_SITE, // legacy shared cap (eBay run)
  // NOTE: must stay null (NOT a numeric default). The reader
  // (analyzeAmazonPagesPerSite) falls back to the legacy pagesPerSite when
  // this is unset; a numeric default here would shadow pagesPerSite for
  // runs started before the "Amazon pages" input existed.
  amazonPages: null
};

/* ------------------------------------------------------------------ *
 * State helpers
 * ------------------------------------------------------------------ */
let cache = null; // in-memory mirror; survives only while the SW is alive

/**
 * Active per-stage watchdog timers: { 'amazon': timerId, ... }.
 * Unlike a setInterval (which fires repeatedly and is easy to leak), each
 * stage arms exactly ONE one-shot timer; it is always cleared on completion,
 * on failure, or when a new run starts — so no stray callback can ever fire
 * against a newer run.
 */
const stageTimers = {};

function emptySiteState() {
  return { status: 'idle', items: [], error: null, tabId: null, url: null, page: 1, pagesDone: 0, maxPage: null };
}

function newRunState(query, runId, pageLimit) {
  return {
    runId,
    query,
    pageLimit: Math.max(1, Math.min(20, Math.floor(Number(pageLimit)) || DEFAULT_PAGE_LIMIT)),
    // A brand-new state is ALWAYS idle. 'searching' is only ever entered by an
    // explicit user command (startRun from the Compare click, forceParse from
    // "Parse again"). Booting into 'searching' here used to make the popup's
    // first ARB_GET_STATE restore a phantom run nobody started — the spinner
    // appeared with its elapsed-seconds counter climbing before any input.
    phase: 'idle', // 'idle' | 'searching' | 'done'
    startedAt: null,
    doneAt: null,
    sites: { amazon: emptySiteState(), ebay: emptySiteState(), aliexpress: emptySiteState() },
    pairs: [],       // [{ sim, amazon: {…}, ebay: {…}, aliexpress: {…} }]
    summary: { pairs: 0, amzTotal: 0, ebayTotal: 0, aliexpressTotal: 0, amzUsed: 0, ebayUsed: 0, aliexpressUsed: 0 }
  };
}

async function ensureState() {
  if (cache) return cache;
  try {
    const res = await chrome.storage.session.get('arbState');
    cache = res.arbState || newRunState('', '');
  } catch (_) {
    cache = newRunState('', '');
  }
  return cache;
}

async function commit() {
  try { await chrome.storage.session.set({ arbState: cache }); } catch (_) { /* noop */ }
  broadcast();
}

/** Push state to the popup if it happens to be open. */
function broadcast() {
  try { chrome.runtime.sendMessage({ type: 'ARB_STATE', state: cache }).catch(() => {}); }
  catch (_) { /* noop */ }
}

/* ------------------------------------------------------------------ *
 * Phase 3: orphan-tab hygiene (registry-backed, belt AND braces)       *
 * ------------------------------------------------------------------
 * Every temporary scraping tab passes through closeOwnedTab(), which closes
 * it if it still exists and unregisters it either way. sweepOrphanTabs()
 * runs on worker start and on a periodic alarm so tabs created by a worker
 * that Chrome then killed mid-stage can never survive as orphans. */

/** Close one owned tab: remove it (best-effort) and drop it from the registry.
 * `ownerHint` lets callers attribute the close even when they have already
 * nulled the stage's tabId (the common settle/fail pattern) — without it the
 * generic ownership lookup would log 'unowned' for our own closes. */
async function closeOwnedTab(tabId, ownerHint) {
  if (tabId == null) return;
  try { await chrome.tabs.remove(tabId); } catch (e) { /* tab already gone */ }
  try { await unregisterScrapeTab(tabId); } catch (_) { /* cleanup.js missing */ }
}

/** Close a list of tab ids, tolerating nulls and already-dead tabs. */
async function closeOwnedTabs(ids) {
  await Promise.all((ids || []).filter((t) => t != null).map(closeOwnedTab));
}

/** One sweep pass: close every registered tab that no longer belongs to a live stage. */
async function sweepOrphanTabs() {
  let owned = [];
  try { owned = await getOwnedScrapeTabs(); } catch (_) { return; }
  if (!owned.length) return;

  const live = new Set();
  if (cache && cache.sites) {
    for (const site of ['amazon', 'ebay', 'aliexpress']) {
      const ss = cache.sites[site];
      if (ss && ss.tabId != null) {
        // Live stage: keep. Blocked stage: keep too — the open tab is the
        // user's CAPTCHA recovery surface (banner instructs them to use it).
        if (ss.status === 'loading' ||
            (ss.status === 'error' && ss.error === 'blocked')) live.add(ss.tabId);
      }
    }
  }
  if (analyzeCache && analyzeCache.stages) {
    for (const stage of ['ebay', 'amazon']) {
      const st = analyzeCache.stages[stage];
      if (st && st.tabId != null) {
        if (st.status === 'loading' ||
            (st.status === 'error' && st.error === 'blocked')) live.add(st.tabId);
      }
    }
  }

  const orphans = owned.filter((id) => !live.has(id));

  if (orphans.length) {
    await closeOwnedTabs(orphans);
    console.log(`[arb] tab sweep closed ${orphans.length} orphan tab(s)`);
  }
  try { await updateTabSweepAlarm(); } catch (_) { /* noop */ }
}

/** Keep the periodic sweep alarm alive exactly while tabs are registered. */
async function updateTabSweepAlarm() {
  let owned = [];
  try { owned = await getOwnedScrapeTabs(); } catch (_) { owned = []; }
  const existing = await chrome.alarms.get(TAB_SWEEP_ALARM).catch(() => null);
  if (owned.length && !existing) {
    chrome.alarms.create(TAB_SWEEP_ALARM, { delayInMinutes: TAB_SWEEP_MINUTES, periodInMinutes: TAB_SWEEP_MINUTES });
  } else if (!owned.length && existing) {
    chrome.alarms.clear(TAB_SWEEP_ALARM);
  }
}

const alarmName = (runId, site) => `arb.${runId}.${site}`;

/**
 * Arm the watchdog for a stage: a one-shot setTimeout PLUS a 2-minute
 * alarm failsafe. Why both?
 *   - The setTimeout is the real deadline users feel (45s, not 1–2 min).
 *   - The alarm exists only because Chrome may kill an idle MV3 service
 *     worker, which silently destroys its setTimeout timers. The alarm re-arms
 *     the worker and lets it mark the run failed instead of leaving the popup
 *     spinner up forever. It is always cleared when the stage settles.
 */
function setWatch(site) {
  if (!cache) return;
  const runId = cache.runId;

  clearWatch(site);

  stageTimers[site] = setTimeout(() => {
    delete stageTimers[site];
    handleStageTimeout(runId, site)
      .catch((e) => console.warn('[arb] stage timeout error:', e));
  }, STAGE_TIMEOUT_MS);

  try { chrome.alarms.create(alarmName(runId, site), { delayInMinutes: ALARM_WATCHDOG_MIN }); } catch (_) {}
}

function clearWatch(site) {
  if (stageTimers[site]) { clearTimeout(stageTimers[site]); delete stageTimers[site]; }
  try { if (cache) chrome.alarms.clear(alarmName(cache.runId, site)); } catch (_) {}
}

/** All watchdogs cancelled (run finished or a new one is starting). */
function clearAllWatches() {
  for (const site of ['amazon', 'ebay', 'aliexpress']) clearWatch(site);
}

async function clearAlarmsForRun(runId) {
  try {
    const alarms = await chrome.alarms.getAll();
    const stale = alarms
      .map((a) => a.name)
      .filter((n) => n.startsWith(`arb.${runId}.`));
    await Promise.all(stale.map((n) => chrome.alarms.clear(n)));
  } catch (_) { /* noop */ }
}

/** A stage blew its deadline -> record the reason and move the run on. */
async function handleStageTimeout(runId, site) {
  await ensureState();
  if (!cache || cache.runId !== runId) return; // a newer run owns this slot
  if (cache.phase !== 'searching') return;
  const ss = cache.sites[site];
  if (!ss || ss.status !== 'loading') return;
  await failStage(site, 'timeout');
}

/* ------------------------------------------------------------------ *
 * Run lifecycle
 * ------------------------------------------------------------------ */

/**
 * Begin a fresh comparison run for `query`.
 * This is the ONLY place phase becomes 'searching' besides forceParse — both
 * are strictly event-driven: ARB_START arrives from the Compare click and
 * ARB_FORCE_PARSE from the "Parse again" button. Nothing on popup-open can
 * reach this function.
 */
async function startRun(query, pageLimit) {
  await ensureState();
  const old = cache;
  cache = newRunState(query, `r${Date.now()}`, pageLimit);
  cache.phase = 'searching'; // explicit, user-commanded transition
  cache.startedAt = Date.now();

  // Kill any watchdogs from the previous run FIRST — their callbacks must
  // never fire into the new run's state (checkRun still accepts old runIds,
  // but the timers are gone, and the alarm names differ).
  if (old && old.runId && old.runId !== cache.runId) {
    if (old.sites.amazon.status === 'loading') clearWatch('amazon');
    if (old.sites.ebay.status === 'loading') clearWatch('ebay');
  }
  await commit(); // show "eBay loading" immediately in the popup

  // Housekeeping for the previous run (best-effort): drop its stale alarms
  // and close its result tabs so they can't deliver late ARB_RESULTS messages.
  if (old && old.runId && old.runId !== cache.runId) {
    clearAlarmsForRun(old.runId);
    await closeOwnedTabs([old.sites.amazon.tabId, old.sites.ebay.tabId]);
  }

  // If opening the first tab fails (rare), fail back to idle instead of
  // leaving a 'searching' run with no active stage — that ghost state is
  // exactly what used to spin the popup forever.
  try {
    await openSearchTab('ebay', { page: 1, resetItems: true });
  } catch (e) {
    console.warn('[arb] could not open eBay tab:', e);
    cache.sites.ebay.status = 'error';
    cache.sites.ebay.error = 'open-failed';
    cache.phase = 'idle';
  }
  await commit();
}

/** Open (or refocus) the results tab for a marketplace and arm the watchdog. */
async function openSearchTab(site, opts) {
  opts = opts || {};
  const ss = cache.sites[site];
  const page = Math.max(1, Number(opts.page || ss.page || 1));
  const query = cache.query;
  let url;
  if (site === 'ebay') url = SEARCH_URLS.ebay(query, page);
  else if (site === 'amazon') url = SEARCH_URLS.amazon(query, page);
  else if (site === 'aliexpress') url = SEARCH_URLS.aliexpress(query, page);
  else url = SEARCH_URLS.amazon(query, page);
  let tab;
  try { tab = await chrome.tabs.get(ss.tabId); } catch (_) { tab = null; }

  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false });
    ss.tabId = tab.id;
  } else {
    tab = await chrome.tabs.update(tab.id, { url, active: false });
  }
  try { await registerScrapeTab(tab.id); await updateTabSweepAlarm(); } catch (_) { /* cleanup.js missing */ }
  ss.url = tab.url || url;
  ss.page = page;
  ss.status = 'loading';
  ss.error = null;
  if (opts.resetItems) {
    ss.items = [];
    ss.pagesDone = 0;
  }
  setWatch(site);
  await commit();
}

/** A keyword-run stage settled (successfully or not): reclaim its tab. */
async function settleSearchStage(site) {
  const ss = cache && cache.sites && cache.sites[site];
  const tabId = ss && ss.tabId;
  if (tabId != null) {
    ss.tabId = null;
    await closeOwnedTab(tabId, `keyword-run:${site}`);
  }
}

/**
 * Close a keyword-run stage's tab WITHOUT clearing ss.tabId — used at the
 * exact points where the stage is finished but state keeps a reference
 * (e.g. "Open eBay results" may want to reopen it from its url).
 * closeOwnedTab unregisters the id, so the sweep never re-closes it.
 */
async function retireSearchStageTab(site) {
  const ss = cache && cache.sites && cache.sites[site];
  const tabId = ss && ss.tabId;
  if (tabId != null) await closeOwnedTab(tabId, `keyword-run:${site}`);
}

function amazonCrossReferenceQuery(fallbackQuery, ebayItems) {
  // Tuning placeholder: this is where Amazon lookup strategy belongs.
  // Current behavior keeps one broad Amazon search using the original query,
  // then computePairs() cross-references those Amazon results against every
  // eBay item captured across all dynamically-detected eBay pages.
  //
  // For narrower dropshipping research, replace this with a normalized title
  // from ebayItems[0], a shared keyword extraction pass, or a per-item lookup
  // flow that opens/searches Amazon once per selected eBay listing.
  return fallbackQuery;
}

function searchUrlForSite(site) {
  if (site === 'ebay') {
    const page = (cache.sites.ebay && cache.sites.ebay.page) || 1;
    return SEARCH_URLS.ebay(cache.query, page);
  }
  const page = (cache.sites.amazon && cache.sites.amazon.page) || 1;
  return SEARCH_URLS.amazon(amazonCrossReferenceQuery(cache.query, cache.sites.ebay.items || []), page);
}

function dedupeItems(items) {
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const key = item.id || item.url || `${item.site}:${item.title}:${item.price}`;
    if (key && !byId.has(key)) byId.set(key, item);
  }
  return Array.from(byId.values());
}

async function continueEbayPagination() {
  const ss = cache.sites.ebay;
  const finishedWithEbay = () => retireSearchStageTab('ebay');

  // User-configured page limit (from the popup's "Pages per site" input,
  // default 3). This is the PRIMARY cap — the user explicitly said how many
  // pages they want scraped so long jobs finish faster.
  const userLimit = Number.isInteger(cache.pageLimit) && cache.pageLimit > 0
    ? cache.pageLimit
    : DEFAULT_PAGE_LIMIT;

  // Dynamic page limit: use the max page reported by content.js from eBay's
  // own pagination controls, THEN intersect with the user's limit. Falls
  // back to EBAY_FALLBACK_MAX_PAGES (3) when the pagination element was
  // missing/malformed, and is hard-capped by EBAY_ABSOLUTE_MAX_PAGES so a
  // corrupted page number can't cause an unbounded scrape.
  const detectedMax = Number.isInteger(ss.maxPage) && ss.maxPage > 0
    ? ss.maxPage
    : EBAY_FALLBACK_MAX_PAGES;
  const ebayMaxPages = Math.min(
    detectedMax,
    EBAY_ABSOLUTE_MAX_PAGES,
    userLimit
  );
  console.log(`[arb] eBay pagination: current=${ss.page}, maxPages=${ebayMaxPages} (user=${userLimit}, detected=${Number.isInteger(ss.maxPage) ? ss.maxPage : 'n/a'})`);

  const nextPage = (ss.page || 1) + 1;
  if (nextPage <= ebayMaxPages) {
    // Add a small human-like delay between eBay page navigations too, to keep
    // request volume low and avoid tripping bot detection.
    const delayMs = AMAZON_PAGE_DELAY_MIN_MS +
      Math.floor(Math.random() * (AMAZON_PAGE_DELAY_MAX_MS - AMAZON_PAGE_DELAY_MIN_MS + 1));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await openSearchTab('ebay', { page: nextPage, resetItems: false });
    return;
  }

  ss.status = 'done';
  await commit();
  await finishedWithEbay(); // eBay capture complete: reclaim its tab
  await openSearchTab('amazon', { page: 1, resetItems: true });
}

async function continueAmazonPagination() {
  const ss = cache.sites.amazon;

  // User-configured Amazon page limit (same "Pages per site" input as eBay).
  // Intersect with the hard 20-page safety ceiling so a malformed value can
  // never cause an unbounded scrape.
  const userLimit = Number.isInteger(cache.pageLimit) && cache.pageLimit > 0
    ? cache.pageLimit
    : DEFAULT_PAGE_LIMIT;
  const amazonMaxPages = Math.min(
    AMAZON_ABSOLUTE_MAX_PAGES,
    userLimit
  );
  const nextPage = (ss.page || 1) + 1;
  
  // DEBUG: Log pagination decision
  console.log(`[arb] [DEBUG] continueAmazonPagination: page=${ss.page}, nextPage=${nextPage}, amazonMaxPages=${amazonMaxPages}, userLimit=${userLimit}, ss.maxPage=${ss.maxPage}`);
  
  // A successful page payload re-arms the one-shot price-parse retry so a
  // later page's hydration hiccup still gets its own bounded retry.
  ss.priceParseRetried = false;
  ss.noResultsRetried = false; // same for the paced no-results retry
  if (nextPage <= amazonMaxPages) {
    console.log(`[arb] [DEBUG] Continuing to Amazon page ${nextPage}`);
    // Rate-limit handling: add a random human-like delay between Amazon page
    // navigations to avoid triggering bot detection.
    const delayMs = AMAZON_PAGE_DELAY_MIN_MS +
      Math.floor(Math.random() * (AMAZON_PAGE_DELAY_MAX_MS - AMAZON_PAGE_DELAY_MIN_MS + 1));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await openSearchTab('amazon', { page: nextPage, resetItems: false });
    return;
  }

  console.log(`[arb] [DEBUG] Stopping Amazon pagination at page ${ss.page} (nextPage=${nextPage} > amazonMaxPages=${amazonMaxPages})`);
  ss.status = 'done';
  await commit();
  await retireSearchStageTab('amazon'); // Amazon capture complete: reclaim its tab
  await finalizeRun();
}

async function continueAliExpressPagination() {
  const ss = cache.sites.aliexpress;

  // User-configured AliExpress page limit (same "Pages per site" input).
  const userLimit = Number.isInteger(cache.pageLimit) && cache.pageLimit > 0
    ? cache.pageLimit
    : DEFAULT_PAGE_LIMIT;
  const aliexpressMaxPages = Math.min(
    AMAZON_ABSOLUTE_MAX_PAGES, // Use same hard cap as Amazon
    userLimit
  );
  const nextPage = (ss.page || 1) + 1;

  console.log(`[arb] AliExpress pagination: current=${ss.page}, maxPages=${aliexpressMaxPages}, detected=${Number.isInteger(ss.maxPage) ? ss.maxPage : 'n/a'}`);

  // Reset retry flags on successful page
  ss.priceParseRetried = false;
  ss.noResultsRetried = false;

  if (nextPage <= aliexpressMaxPages) {
    // Add a random human-like delay between AliExpress page navigations
    const delayMs = AMAZON_PAGE_DELAY_MIN_MS +
      Math.floor(Math.random() * (AMAZON_PAGE_DELAY_MAX_MS - AMAZON_PAGE_DELAY_MIN_MS + 1));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await openSearchTab('aliexpress', { page: nextPage, resetItems: false });
    return;
  }

  console.log(`[arb] Stopping AliExpress pagination at page ${ss.page}`);
  ss.status = 'done';
  await commit();
  await retireSearchStageTab('aliexpress');
  await finalizeRun();
}

/** React to a failed stage: record the reason and keep the run moving. */
async function failStage(site, reason) {
  await ensureState();
  if (cache.phase !== 'searching') return;
  const ss = cache.sites[site];
  if (ss.status !== 'loading') return;

  ss.status = 'error';
  ss.error = reason;
  clearWatch(site);
  // Close the stage's tab on failure — EXCEPT a recoverable bot check, where
  // the open tab is the recovery surface ("solve the CAPTCHA there").
  if (reason !== 'blocked') await settleSearchStage(site);
  await commit();

  if (site === 'ebay') {
    // Extract a clean search query from eBay data for Amazon/AliExpress searches
    let searchQuery = cache.query;
    try {
      // Try to use the eBay product title if available
      if (cache.sites.ebay && cache.sites.ebay.items && cache.sites.ebay.items.length > 0) {
        const ebayItem = cache.sites.ebay.items[0];
        if (ebayItem.title) {
          // Use the same cleaning logic as analyze flow
          const qInfo = self.ARBScout.cleanTitleAndBuildQuery(ebayItem.title, ebayItem.specifics || {});
          searchQuery = qInfo.query;
          console.log(`[arb] [DEBUG] Using cleaned query for Amazon/AliExpress: "${searchQuery}" (strategy: ${qInfo.strategy})`);
        }
      }
    } catch (e) {
      console.warn('[arb] Could not clean query, using original:', e.message);
    }
    
    await openSearchTab('amazon', { page: 1, resetItems: true, query: searchQuery });
    await openSearchTab('aliexpress', { page: 1, resetItems: true, query: searchQuery });
  } else await finalizeRun();
}


/** Handle ARB_RESULTS coming from content.js on a search page. */
async function handleResults(msg, sender) {
  await ensureState();
  if (cache.phase !== 'searching') return;
  const site = msg && msg.site;
  if (site !== 'amazon' && site !== 'ebay' && site !== 'aliexpress') return;

  const ss = cache.sites[site];
  // Only accept results for the stage we are waiting on, from the tab we own,
  // for the query we asked. (Stale tabs from a previous run are ignored.)
  if (ss.status !== 'loading') return;
  const senderTabId = sender.tab ? sender.tab.id : null;
  if (ss.tabId != null && senderTabId !== ss.tabId) return;
  if (msg.query && normalize(msg.query) !== normalize(cache.query)) return;

  clearWatch(site);

  if (msg.error) {
    // Map 'no-results-page' onto 'no-results': a redirect to a non-search page
    // (Amazon often bounces to the homepage / signin) is functionally "the
    // page never produced results". Bounded reporting means we always land
    // here quickly instead of waiting on a page that will never report.
    const reason = msg.error === 'no-results-page' ? 'no-results' : msg.error;
    if (msg.error === 'price-parse' && msg.skippedForPrice) {
      console.log(`[arb] Amazon price parse: ${msg.skippedForPrice} cards had no parsable price`);
    }
    // price-parse is RECOVERABLE, not stage-fatal: the grid rendered but the
    // prices were unreadable (usually late hydration). Keep the tab open —
    // advance to the next page when candidates are already held, otherwise
    // retry the SAME page once in the SAME tab (openSearchTab re-arms the
    // watchdog) before ever failing the stage.
    if (reason === 'price-parse' && site === 'amazon') {
      if ((ss.items || []).length > 0) {
        console.log(`[arb] Amazon price parse on page ${ss.page} but ${ss.items.length} items held — advancing pagination`);
        await continueAmazonPagination();
        return;
      }
      if (!ss.priceParseRetried) {
        ss.priceParseRetried = true;
        console.log(`[arb] price-parse with no candidates — retrying Amazon page ${ss.page || 1} once in the same tab`);
        await new Promise((r) => setTimeout(r, AMAZON_PAGE_DELAY_MIN_MS +
          Math.floor(Math.random() * (AMAZON_PAGE_DELAY_MAX_MS - AMAZON_PAGE_DELAY_MIN_MS + 1))));
        await openSearchTab('amazon', { page: ss.page || 1, resetItems: false });
        return;
      }
    }
    // AliExpress price-parse handling (same logic as Amazon)
    if (reason === 'price-parse' && site === 'aliexpress') {
      if ((ss.items || []).length > 0) {
        console.log(`[arb] AliExpress price parse on page ${ss.page} but ${ss.items.length} items held — advancing pagination`);
        await continueAliExpressPagination();
        return;
      }
      if (!ss.priceParseRetried) {
        ss.priceParseRetried = true;
        console.log(`[arb] AliExpress price-parse with no candidates — retrying page ${ss.page || 1} once in the same tab`);
        await new Promise((r) => setTimeout(r, AMAZON_PAGE_DELAY_MIN_MS +
          Math.floor(Math.random() * (AMAZON_PAGE_DELAY_MAX_MS - AMAZON_PAGE_DELAY_MIN_MS + 1))));
        await openSearchTab('aliexpress', { page: ss.page || 1, resetItems: false });
        return;
      }
    }
    // A fast 'no-results' (redirect interstitial / empty grid) used to close
    // the stage tab immediately. Give it ONE paced same-page retry first —
    // late server-side redirects often resolve into the real search page.
    if (reason === 'no-results' && site === 'amazon' &&
        (ss.items || []).length === 0 && !ss.noResultsRetried) {
      ss.noResultsRetried = true;
      console.log(`[arb] Amazon page ${ss.page || 1} redirected/empty — paced retry in the same tab`);
      await new Promise((r) => setTimeout(r, AMAZON_PAGE_DELAY_MIN_MS +
        Math.floor(Math.random() * (AMAZON_PAGE_DELAY_MAX_MS - AMAZON_PAGE_DELAY_MIN_MS + 1))));
      await openSearchTab('amazon', { page: ss.page || 1, resetItems: false });
      return;
    }
    // AliExpress no-results handling (same logic as Amazon)
    if (reason === 'no-results' && site === 'aliexpress' &&
        (ss.items || []).length === 0 && !ss.noResultsRetried) {
      ss.noResultsRetried = true;
      console.log(`[arb] AliExpress page ${ss.page || 1} redirected/empty — paced retry in the same tab`);
      await new Promise((r) => setTimeout(r, AMAZON_PAGE_DELAY_MIN_MS +
        Math.floor(Math.random() * (AMAZON_PAGE_DELAY_MAX_MS - AMAZON_PAGE_DELAY_MIN_MS + 1))));
      await openSearchTab('aliexpress', { page: ss.page || 1, resetItems: false });
      return;
    }
    // failStage closes the stage tab unless the block is recoverable
    // (CAPTCHA) — in that case the tab stays open for the user to solve.
    await failStage(site, reason);
    return;
  }

  // Success. The tab itself is intentionally KEPT here: eBay pagination
  // reuses it via openSearchTab (tabs.update navigates in place), and the
  // terminal points below close it explicitly.

  if (site === 'ebay') {
    ss.items = dedupeItems([...(ss.items || []), ...(Array.isArray(msg.items) ? msg.items : [])]);
    ss.pagesDone = Math.max(ss.pagesDone || 0, ss.page || 1);
    // Capture the dynamically-detected page count (or null if unavailable).
    if (Number.isInteger(msg.maxPage)) ss.maxPage = msg.maxPage;
    await commit();
    await continueEbayPagination();
    return;
  }

  if (site === 'aliexpress') {
    ss.items = dedupeItems([...(ss.items || []), ...(Array.isArray(msg.items) ? msg.items : [])]);
    ss.pagesDone = Math.max(ss.pagesDone || 0, ss.page || 1);
    if (Number.isInteger(msg.maxPage)) ss.maxPage = msg.maxPage;
    await commit();
    await continueAliExpressPagination();
    return;
  }

  ss.items = dedupeItems([...(ss.items || []), ...(Array.isArray(msg.items) ? msg.items : [])]);
  ss.pagesDone = Math.max(ss.pagesDone || 0, ss.page || 1);
  // DEBUG: Log maxPage received from content script
  if (Number.isInteger(msg.maxPage)) {
    ss.maxPage = msg.maxPage;
    console.log(`[arb] [DEBUG] Amazon page ${ss.page}: received maxPage=${msg.maxPage} from content script`);
  } else {
    console.log(`[arb] [DEBUG] Amazon page ${ss.page}: NO maxPage from content script (msg.maxPage=${msg.maxPage})`);
  }
  await commit();
  await continueAmazonPagination();
}

const normalize = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Both stages finished (or errored): match items and store pairs. */
async function finalizeRun() {
  await ensureState();
  if (cache.phase !== 'searching') return;

  cache.phase = 'done';
  cache.doneAt = Date.now();
  clearAllWatches();
  // Safety net: any stage tab still referenced at finalize time is closed.
  // (Normal flows already retire tabs in continue*Pagination / failStage.)
  try { await closeOwnedTabs([cache.sites.ebay.tabId, cache.sites.amazon.tabId, cache.sites.aliexpress.tabId]); } catch (_) {}

  const amz = cache.sites.amazon.items || [];
  const ebay = cache.sites.ebay.items || [];
  const ali = cache.sites.aliexpress.items || [];

  console.log(`[arb] [DEBUG] Finalize: Amazon=${amz.length}, eBay=${ebay.length}, AliExpress=${ali.length}`);

  // Match eBay items with Amazon
  const matchedAmzEbay = computePairs(amz, ebay);
  
  // Match eBay items with AliExpress
  const matchedAliEbay = computePairs(ali, ebay);

  // Combine pairs - prioritize by confidence score
  const allPairs = [...matchedAmzEbay.pairs, ...matchedAliEbay.pairs.map(p => ({ ...p, source: 'aliexpress' }))];
  
  // Sort by similarity score and limit
  allPairs.sort((a, b) => (b.sim || 0) - (a.sim || 0));
  const finalPairs = allPairs.slice(0, MAX_PAIRS);

  cache.pairs = finalPairs;
  cache.summary = {
    pairs: finalPairs.length,
    amzTotal: amz.length,
    ebayTotal: ebay.length,
    aliexpressTotal: ali.length,
    amzUsed: matchedAmzEbay.amzUsed,
    ebayUsed: matchedAmzEbay.ebayUsed + matchedAliEbay.ebayUsed,
    aliexpressUsed: matchedAliEbay.amzUsed // aliexpress items used
  };
  await commit();
}

/* ------------------------------------------------------------------ *
 * Product matching (title similarity, greedy pairing)
 * ------------------------------------------------------------------ */
const STOPWORDS = new Set(('the a an and or for with without new used brand authentic original ' +
  'genuine free shipping fast delivery lot pack set box official licensed by from to of in on off').split(' '));

function tokenizeTitle(title) {
  const words = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

function titleSimilarity(a, b) {
  const A = tokenizeTitle(a);
  const B = tokenizeTitle(b);
  if (!A.size || !B.size) return 0;

  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  const jaccard = inter / union;
  const coverage = inter / Math.min(A.size, B.size); // short titles vs long ones
  let score = 0.5 * jaccard + 0.5 * coverage;

  // Small bonus when both titles carry the same long numeric token (model no.).
  const numsA = (a.match(/\d{3,}/g) || []);
  const numsB = (b.match(/\d{3,}/g) || []);
  if (numsA.length && numsB.length) {
    const same = numsA.filter((x) => numsB.includes(x)).length;
    if (same > 0) score = Math.min(1, score + 0.08 * same);
  }
  return score;
}

function computePairs(amazonItems, ebayItems) {
  const candidates = [];
  for (let ia = 0; ia < amazonItems.length; ia++) {
    for (let ib = 0; ib < ebayItems.length; ib++) {
      const s = titleSimilarity(amazonItems[ia].title, ebayItems[ib].title);
      if (s >= MATCH_THRESHOLD) candidates.push({ s, ia, ib });
    }
  }
  // Greedy one-to-one pairing: take the strongest title match first so each
  // Amazon product is paired with its single most-likely eBay listing.
  candidates.sort((x, y) => y.s - x.s);

  const usedA = new Set();
  const usedB = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedA.has(c.ia) || usedB.has(c.ib)) continue;
    usedA.add(c.ia);
    usedB.add(c.ib);
    pairs.push({
      sim: Math.round(c.s * 100),
      amazon: amazonItems[c.ia],
      ebay: ebayItems[c.ib]
    });
    if (pairs.length >= MAX_PAIRS) break;
  }
  return { pairs, amzUsed: usedA.size, ebayUsed: usedB.size };
}

/* ==================================================================== *
 * Phase 2: analyze flow (eBay URL -> Phase 1 match -> Phase 2 profit)  *
 * ==================================================================== */
/*
 * Message protocol additions:
 *   POPUP  -> BACKGROUND
 *     { type: 'ARB_ANALYZE', url, settings }      start an analyze run
 *     { type: 'ARB_ANALYZE_GET_STATE' }           reply { state: analyzeState }
 *     { type: 'ARB_ANALYZE_RETRY' }               re-scrape the stuck stage
 *     { type: 'ARB_ANALYZE_CANCEL' }              close tabs, drop the run
 *   CONTENT -> BACKGROUND
 *     { type: 'ARB_ITEM_DATA', site, itemId, url, item, error }
 *
 *   BACKGROUND -> POPUP
 *     { type: 'ARB_ANALYZE_STATE', state }        pushed on every change
 *
 * Why tabs (again): the eBay item page and the Amazon search page are opened
 * as REAL background tabs (same rationale as the keyword run — real session,
 * no CORS, content scripts parse pages that are genuinely open).
 *
 * Why chrome.storage.session (again): MV3 workers die mid-run; the analyze
 * state survives and the popup rehydrates via ARB_ANALYZE_GET_STATE.
 */

let analyzeCache = null; // mirrors arbAnalyzeState in session storage

/* Phase 3: BLOCKED recovery wording (shown verbatim by the popup). */
const BLOCKED_STAGE_MESSAGES = {
  ebay: 'eBay requires verification. Please complete the CAPTCHA in the opened tab and click Retry.',
  amazon: 'Amazon requires verification. Please complete the CAPTCHA in the opened tab and click Retry.'
};

function newAmazonStage() {
  return {
    status: 'idle',
    error: null,
    tabId: null,
    // Pagination / fallback orchestration fields (see handleAnalyzeAmazonResults):
    queries: [],   // ordered query strings (primary first, broader fallbacks after)
    queryIndex: 0, // active entry in `queries`
    page: 1,       // Amazon page currently requested (&page=)
    pagesDone: 0,  // pages successfully aggregated for the active query
    pagesPerSite: 1, // settings.pagesPerSite (clamped 1..AMAZON_ABSOLUTE_MAX_PAGES)
    items: []      // deduplicated candidates aggregated across pages/{queries}
  };
}

function newAliExpressStage() {
  return {
    status: 'idle',
    error: null,
    tabId: null,
    query: null,
    page: 1,
    pagesDone: 0,
    pagesPerSite: 1,
    items: [],
    priceParseRetried: false,
    noResultsRetried: false,
    maxPage: null
  };
}

function newAnalyzeState(url, runId, settings) {
  return {
    runId,
    url: url || null,
    phase: 'idle', // 'idle' | 'fetching-ebay' | 'searching-amazon' | 'calculating' | 'done' | 'error'
    startedAt: null,
    doneAt: null,
    settings: Object.assign({}, DEFAULT_ANALYZE_SETTINGS, settings || {}),
    manualMatch: null, // Phase 3: { asin, url, appliedAt } when user-corrected
    stages: {
      ebay: { status: 'idle', error: null, tabId: null },
      amazon: newAmazonStage(),
      aliexpress: newAliExpressStage()
    },
    ebayProduct: null,
    queryInfo: null,   // cleanTitleAndBuildQuery() result (strategy, gtin, …)
    amazonResults: [],
    aliexpressResults: [],
    match: null,       // matchAmazonProduct() result (candidates included)
    safety: null,      // Phase 3: assessSafety() result for the matched pair
    profit: null,      // calculateArbitrageProfit() result
    error: null        // { code, message, userMessage }
  };
}

async function ensureAnalyzeState() {
  if (analyzeCache) return analyzeCache;
  try {
    const res = await chrome.storage.session.get('arbAnalyzeState');
    analyzeCache = res.arbAnalyzeState || null;
  } catch (_) { analyzeCache = null; }
  return analyzeCache;
}

async function commitAnalyze() {
  try { await chrome.storage.session.set({ arbAnalyzeState: analyzeCache }); } catch (_) { /* noop */ }
  broadcastAnalyze();
}

function broadcastAnalyze() {
  try { chrome.runtime.sendMessage({ type: 'ARB_ANALYZE_STATE', state: analyzeCache }).catch(() => {}); }
  catch (_) { /* noop */ }
}

const itemAlarmName = (runId, stage) => `arbItem.${runId}.${stage}`;
const itemStageTimers = {};

function setItemWatch(stage) {
  if (!analyzeCache) return;
  const runId = analyzeCache.runId;
  clearItemWatch(stage);
  itemStageTimers[stage] = setTimeout(() => {
    delete itemStageTimers[stage];
    handleItemStageTimeout(runId, stage).catch((e) => console.warn('[arb] item watchdog error:', e));
  }, ITEM_STAGE_TIMEOUT_MS);
  try { chrome.alarms.create(itemAlarmName(runId, stage), { delayInMinutes: ITEM_ALARM_WATCHDOG_MIN }); } catch (_) {}
}

function clearItemWatch(stage) {
  if (itemStageTimers[stage]) { clearTimeout(itemStageTimers[stage]); delete itemStageTimers[stage]; }
  try { if (analyzeCache) chrome.alarms.clear(itemAlarmName(analyzeCache.runId, stage)); } catch (_) {}
}

function clearAllItemWatches() {
  for (const stage of ['ebay', 'amazon']) clearItemWatch(stage);
}

async function handleItemStageTimeout(runId, stage) {
  await ensureAnalyzeState();
  if (!analyzeCache || analyzeCache.runId !== runId) return;
  const st = analyzeCache.stages[stage];
  if (!st || st.status !== 'loading') return;
  await failAnalyzeStage(stage, 'timeout');
}

/** Open a tab for a stage and arm its watchdog. */
async function openAnalyzeTab(stage, url) {
  const st = analyzeCache.stages[stage];
  let tab = null;
  try { tab = await chrome.tabs.get(st.tabId); } catch (_) { tab = null; }
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false });
    st.tabId = tab.id;
  } else {
    tab = await chrome.tabs.update(tab.id, { url, active: false });
  }
  try { await registerScrapeTab(tab.id); await updateTabSweepAlarm(); } catch (_) { /* cleanup.js missing */ }
  st.url = tab.url || url;
  st.status = 'loading';
  st.error = null;
  setItemWatch(stage);
  await commitAnalyze();
  console.log(`[ARBScout] ${stage === 'amazon' ? 'Amazon' : 'eBay'} tab opened:`, tab.id);
}

/**
 * Navigate the (reused) Amazon search tab to a specific query/page. This is
 * the ONLY navigator the pagination loop uses: it keeps the tab OPEN while
 * content.js parses (never a quick 3s drop), re-arms the stage watchdog, and
 * records which page the reply must be aligned to.
 */
async function navigateAnalyzeAmazonTab(query, page) {
  const st = analyzeCache.stages.amazon;
  const url = self.ARBScout.buildAmazonSearchUrl(query, page);
  let tab = null;
  try { tab = await chrome.tabs.get(st.tabId); } catch (_) { tab = null; }
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false });
  } else {
    tab = await chrome.tabs.update(tab.id, { url, active: false });
  }
  st.tabId = tab.id;
  st.url = tab.url || url;
  st.status = 'loading';
  st.error = null;
  st.page = page;
  try { await registerScrapeTab(tab.id); await updateTabSweepAlarm(); } catch (_) { /* cleanup.js missing */ }
  setItemWatch('amazon');
  const pagesPer = analyzeAmazonPagesPerSite();
  await commitAnalyze();
  console.log(`[ARBScout] Amazon tab opened (page ${page}/${pagesPer}):`, tab.id, { query: String(query).slice(0, 60), pagesPer });
}

async function navigateAnalyzeAliExpressTab(query, page) {
  const st = analyzeCache.stages.aliexpress;
  const url = self.ARBScout.buildAliExpressSearchUrl(query, page);
  let tab = null;
  try { tab = await chrome.tabs.get(st.tabId); } catch (_) { tab = null; }
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false });
  } else {
    tab = await chrome.tabs.update(tab.id, { url, active: false });
  }
  st.tabId = tab.id;
  st.url = tab.url || url;
  st.status = 'loading';
  st.error = null;
  st.page = page;
  try { await registerScrapeTab(tab.id); await updateTabSweepAlarm(); } catch (_) { /* cleanup.js missing */ }
  setItemWatch('aliexpress');
  const pagesPer = analyzeAmazonPagesPerSite(); // Use same setting
  await commitAnalyze();
  console.log(`[ARBScout] AliExpress tab opened (page ${page}/${pagesPer}):`, tab.id, { query: String(query).slice(0, 60), pagesPer });
}

async function failAnalyzeStage(stage, reason) {
  await ensureAnalyzeState();
  if (!analyzeCache) return;
  const st = analyzeCache.stages[stage];
  if (!st || st.status !== 'loading') return;
  st.status = 'error';
  st.error = reason;
  clearItemWatch(stage);
  // Phase 3: the failed stage's tab is only needed for CAPTCHA recovery —
  // keep it OPEN when the block is recoverable (user solves it in place),
  // close it otherwise (timeout/parse failures can't be fixed in-tab).
  if (reason !== 'blocked') {
    const tabId = st.tabId;
    st.tabId = null;
    await closeOwnedTab(tabId, `analyze:${stage}`);
  }
  analyzeCache.phase = 'error';
  analyzeCache.error = analyzeErrorFor(stage, reason);
  await commitAnalyze();
}

/** Map stage failures onto the MatchError codes the popup already knows. */
function analyzeErrorFor(stage, reason) {
  const map = {
    'ebay:invalid-url': ['INVALID_URL', 'That doesn\'t look like a valid eBay listing URL.'],
    'ebay:not-ebay': ['NOT_EBAY_ITEM', 'Paste an eBay product page (ebay.com/itm/…), not a search or profile link.'],
    'ebay:blocked': ['FETCH_FAILED', BLOCKED_STAGE_MESSAGES.ebay],
    'ebay:timeout': ['TIMEOUT', 'The eBay listing took too long to load. Try again.'],
    'ebay:no-title': ['NO_TITLE', 'The eBay listing had no readable title.'],
    'ebay:parse-failed': ['PARSE_FAILED', 'Couldn\'t read the eBay listing — its layout may have changed.'],
    'ebay:closed': ['FETCH_FAILED', 'The eBay tab was closed before it could be read.'],
    'amazon:blocked': ['NO_AMAZON_RESULTS', BLOCKED_STAGE_MESSAGES.amazon],
    'amazon:timeout': ['NO_AMAZON_RESULTS', 'Amazon search timed out. Try again.'],
    'amazon:no-results': ['NO_AMAZON_RESULTS', 'No Amazon results came back for this product.'],
    'amazon:parse-failed': ['NO_AMAZON_RESULTS', 'Amazon results could not be parsed — layout may have changed.'],
    'amazon:closed': ['NO_AMAZON_RESULTS', 'The Amazon tab was closed before it could be read.'],
    'amazon:asin-invalid': ['ASIN_INVALID', 'That is not a valid Amazon ASIN or product URL.']
  };
  const hit = map[`${stage}:${reason}`] || ['FETCH_FAILED', `The ${stage} step failed (${reason}).`];
  return { code: hit[0], message: `${stage}: ${reason}`, userMessage: hit[1] };
}

/** Start an analyze run (the ONLY place analyze phase leaves 'idle'). */
async function startAnalyze(rawUrl, settings) {
  await ensureAnalyzeState();

  // Close the previous run's tabs so late ARB_ITEM_DATA/ARB_RESULTS messages
  // from stale tabs can never inject into the new run.
  if (analyzeCache && analyzeCache.stages) {
    const prevTabs = [analyzeCache.stages.ebay.tabId, analyzeCache.stages.amazon.tabId]
      .filter((t) => t != null);
    if (prevTabs.length) {
      console.log(`[ARBScout] previous run phase='${analyzeCache.phase}' — closing its tab(s) [${prevTabs.join(', ')}]`);
    }
    clearAllItemWatches();
    await closeOwnedTabs([analyzeCache.stages.ebay.tabId, analyzeCache.stages.amazon.tabId]);
  }

  let canonical;
  try {
    canonical = self.ARBScout.validateEbayUrl(rawUrl);
  } catch (err) {
    analyzeCache = newAnalyzeState(null, `a${Date.now()}`, settings);
    analyzeCache.phase = 'error';
    analyzeCache.error = { code: err.code || 'INVALID_URL', message: err.message, userMessage: err.userMessage || String(err.message || err) };
    await commitAnalyze();
    return;
  }

  analyzeCache = newAnalyzeState(canonical.canonicalUrl, `a${Date.now()}`, settings);
  analyzeCache.phase = 'fetching-ebay';
  analyzeCache.startedAt = Date.now();
  await commitAnalyze();

  try {
    await openAnalyzeTab('ebay', canonical.canonicalUrl);
  } catch (e) {
    console.warn('[arb] could not open eBay item tab:', e);
    await failAnalyzeStage('ebay', 'parse-failed');
  }
}

/** Handle ARB_ITEM_DATA from content-item.js (eBay stage completion). */
async function handleItemData(msg, sender) {
  await ensureAnalyzeState();
  if (!analyzeCache || analyzeCache.phase !== 'fetching-ebay') return;
  const st = analyzeCache.stages.ebay;
  if (st.status !== 'loading') return;
  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  if (st.tabId != null && senderTabId !== st.tabId) return;
  if (msg.itemId && analyzeCache.url) {
    const expected = (analyzeCache.url.match(/\/itm\/(\d{9,15})/) || [])[1];
    if (expected && msg.itemId !== expected) return; // stale tab guard
  }

  clearItemWatch('ebay');

  if (msg.error || !msg.item) {
    // failAnalyzeStage closes the tab unless the block is recoverable.
    await failAnalyzeStage('ebay', msg.error || 'parse-failed');
    return;
  }

  // Success: the eBay stage settled — reclaim its tab immediately.
  {
    const tabId = st.tabId;
    st.tabId = null;
    await closeOwnedTab(tabId, 'analyze:ebay');
  }

  st.status = 'done';
  analyzeCache.ebayProduct = msg.item;
  await commitAnalyze();
  await analyzeBuildQueryAndSearch();
}

/**
 * Amazon query straight from the eBay title ("search the same title we found").
 * Transport-level sanitization only — never rewrites the product wording:
 *   - collapse runs of whitespace (eBay titles often carry double spaces)
 *   - strip dangling quotes/parens/brackets/pipes at the ends
 *     (real titles end like ... 3/4" Bearings ( )
 *   - cap at 250 chars (Amazon's own search-box limit), then re-trim any
 *     punctuation the cut left dangling.
 * Returns '' for an unusable title — the plan builder filters that out and
 * the cleaned query becomes the primary.
 */
function exactTitleQuery(rawTitle) {
  let t = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // Always-junk edge characters (never meaningful at the very ends). Parens
  // and brackets are NOT here — they are handled by the balance check below
  // so titles like "(2 Pack) YITAMOTOR …" or "… (Black)" survive intact.
  const JUNK = '[\\s"\'`|,;:\\-–—]';
  t = t.replace(new RegExp('^' + JUNK + '+'), '').replace(new RegExp(JUNK + '+$'), '');
  // Dangling OPENERS at the end ("… 3/4\" Bearings ("): an opener with no
  // matching closer left in the string is truncation junk — strip it. A
  // trailing CLOSER is meaningful and kept. Mirror logic for stray closers
  // at the start.
  const OPENERS = { '(': ')', '[': ']', '{': '}' };
  for (let guard = 0; guard < 4; guard++) {
    const ch = t.slice(-1);
    if (!OPENERS[ch]) break;
    const closer = OPENERS[ch];
    if ((t.split(ch).length - 1) > (t.split(closer).length - 1)) t = t.slice(0, -1).trim();
    else break;
  }
  for (let guard = 0; guard < 4; guard++) {
    const ch = t.slice(0, 1);
    const opener = ch === ')' ? '(' : ch === ']' ? '[' : ch === '}' ? '{' : null;
    if (!opener) break;
    if ((t.split(ch).length - 1) > (t.split(opener).length - 1)) t = t.slice(1).trim();
    else break;
  }
  if (t.length > 250) t = t.slice(0, 250).replace(new RegExp(JUNK + '+$'), '');
  return t.trim();
}

/** Clean the title, build the query + broader fallbacks, open Amazon page 1. */
async function analyzeBuildQueryAndSearch() {
  await ensureAnalyzeState();
  const item = analyzeCache.ebayProduct;
  let q;
  try {
    q = self.ARBScout.cleanTitleAndBuildQuery(item.title, item.specifics || {});
  } catch (err) {
    analyzeCache.phase = 'error';
    analyzeCache.error = { code: err.code || 'NO_QUERY', message: err.message, userMessage: err.userMessage || String(err.message || err) };
    await commitAnalyze();
    return;
  }
  analyzeCache.queryInfo = {
    query: q.query,
    strategy: q.strategy,
    gtin: q.gtin,
    bundleQuantity: q.bundleQuantity,
    cleanedTitle: q.cleanedTitle
  };

  // Ordered query plan. PRIMARY = the eBay product's own title, searched on
  // Amazon as-is (sanitized only for transport: whitespace collapsed, dangling
  // punctuation stripped, capped at Amazon's search-box limit). Amazon's
  // relevance ranking puts exact-title matches first, so this maximizes the
  // chance the same product is result #1 — without depending on how well the
  // title cleaner extracted brand/model tokens. The cleaned query and the
  // broader fallbacks are kept BEHIND it as recovery tiers for the rare case
  // the exact title returns 0 results.
  const fallbacks = (typeof self.ARBScout.buildFallbackQueries === 'function')
    ? (self.ARBScout.buildFallbackQueries(item, q) || [])
        .filter((s) => typeof s === 'string' && s.trim())
        .slice(0, ANALYZE_FALLBACK_QUERIES_MAX)
    : [];
  const plan = [exactTitleQuery(item.title), q.query, ...fallbacks]
    .filter((x) => typeof x === 'string' && x.trim())
    .filter((x, i, arr) => arr.indexOf(x) === i); // dedupe

  const st = analyzeCache.stages.amazon;
  st.queries = plan;
  st.queryIndex = 0;
  st.page = 1;
  st.pagesDone = 0;
  st.items = [];
  st.priceParseRetried = false;
  st.pagesPerSite = analyzeAmazonPagesPerSite();
  console.log(`[ARBScout] Amazon stage init: pagesPerSite=${st.pagesPerSite}, queries=${plan.length}`);
  
  // Initialize AliExpress stage as well
  const aliSt = analyzeCache.stages.aliexpress;
  if (aliSt) {
    aliSt.query = q.query;
    aliSt.page = 1;
    aliSt.pagesDone = 0;
    aliSt.items = [];
    aliSt.priceParseRetried = false;
    aliSt.noResultsRetried = false;
    aliSt.pagesPerSite = analyzeAmazonPagesPerSite(); // Use same setting
    console.log(`[ARBScout] AliExpress stage init: pagesPerSite=${aliSt.pagesPerSite}`);
  }
  
  analyzeCache.phase = 'searching-amazon';
  await commitAnalyze();
  console.log(`[ARBScout] Amazon query plan (${plan.length}):`, plan);

  try {
    await navigateAnalyzeAmazonTab(st.queries[0], 1);
    // Also open AliExpress search tab
    if (aliSt) {
      await navigateAnalyzeAliExpressTab(q.query, 1);
    }
  } catch (e) {
    console.warn('[arb] could not open Amazon tab:', e);
    await failAnalyzeStage('amazon', 'parse-failed');
  }
}

/**
 * Handle ARB_RESULTS from the Amazon search tab while an analyze run is in
 * the 'searching-amazon' phase. The legacy keyword-run path in handleResults()
 * ignores these (phase gate), so the two flows never collide.
 *
 * Pagination + fallback pipeline (this is the fix for the premature-close bug):
 *   1. The Amazon tab is NEVER closed on its first payload. Each reply is
 *      accepted only when aligned (same sender tab, same ?k=, same ?page=).
 *   2. Items are aggregated into st.items across up to `pagesPerSite` pages,
 *      which the background drives by updating the SAME tab's URL (&page=…).
 *   3. A 0-result / empty page either ends a product-query (candidates exist)
 *      or activates the next BROADER fallback query in the same tab session —
 *      only after the whole plan is exhausted do we fail NO_AMAZON_RESULTS.
 */
async function handleAnalyzeAmazonResults(msg, sender) {
  await ensureAnalyzeState();
  if (!analyzeCache || analyzeCache.phase !== 'searching-amazon') return;
  const st = analyzeCache.stages.amazon;
  if (!st || st.status !== 'loading') {
    return;
  }

  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  if (st.tabId != null && senderTabId !== st.tabId) {
    return;
  }

  // Get pagesPer early to avoid initialization issues
  const pagesPer = analyzeAmazonPagesPerSite();

  // Alignment guards dodge stale payloads from earlier pages/queries.
  const activeQuery = analyzeCurrentQuery();
  if (!activeQuery) return;
  const msgPage = (Number.isInteger(Math.floor(Number(msg.page))) ? Math.floor(Number(msg.page)) : 1);
  if (st.page && Number.isInteger(st.page) && msgPage !== st.page) {
    if (msgPage > st.page) return;
    // Amazon silently redirects an out-of-range page (e.g. ?page=7 of a
    // 3-page result set) back to an earlier page. The pagination window is
    // over: settle on what we already hold instead of hanging until the
    // watchdog fires and reporting NO_AMAZON_RESULTS despite good data.
    console.log(`[ARBScout] Amazon redirected page ${st.page} -> ${msgPage}; end of pagination`);
    if ((st.items || []).length > 0) await settleAnalyzeAmazonStage('Amazon redirected to an earlier page (end of pagination)');
    else await advanceAnalyzeNextQueryOrFail();
    return;
  }
  if (msg.query && typeof msg.query === 'string' &&
      msg.query.trim().toLowerCase() !== activeQuery.toLowerCase()) {
    return;
  }

  clearItemWatch('amazon');

  /* ---- Failed page payload ------------------------------------------ */
  if (msg.error) {
    if (msg.error === 'price-parse' && msg.skippedForPrice) {
      console.log(`[ARBScout] Amazon price parse: ${msg.skippedForPrice} cards had no parsable price`);
    }
    // Manual-ASIN flow: a dp page that neither loads nor blocks just means
    // the ASIN is wrong/unavailable — say that instead of a generic failure.
    if (analyzeCache.manualMatch && msg.error !== 'blocked' && msg.error !== 'timeout') {
      const tabId = st.tabId;
      st.tabId = null;
      await closeOwnedTab(tabId, 'analyze:amazon');
      st.status = 'error';
      st.error = msg.error;
      analyzeCache.phase = 'error';
      analyzeCache.error = {
        code: 'NO_AMAZON_RESULTS',
        message: `asin page: ${msg.error}`,
        userMessage: 'The Amazon product page for that ASIN could not be read — it may not exist or is unavailable in your region.'
      };
      await commitAnalyze();
      return;
    }
    await handleAnalyzeQueryError(msg.error);
    return;
  }

  /* ---- Success: aggregate this page's candidates -------------------- */
  const pageItems = Array.isArray(msg.items) ? msg.items : [];
  console.log('[ARBScout] Received payload from Amazon content script:', pageItems.length);
  // A successful page re-arms the one-shot price-parse retry budget.
  st.priceParseRetried = false;
  st.consecutivePageErrors = 0; // a live page breaks the consecutive-error streak
  st.pagesDone = Math.max(st.pagesDone || 0, msgPage);
  st.items = mergeAnalyzeAmazonItems(st.items || [], pageItems);
  await commitAnalyze();

  // Manual-ASIN single /dp page: terminal — no pagination, close + finalize.
  if (analyzeCache.manualMatch) {
    await settleAnalyzeAmazonStage('manual ASIN match complete');
    return;
  }

  // 0 items on this page: if we already hold candidates, settle on them;
  // otherwise test the next broader fallback query before ever dropping.
  if (!pageItems.length) {
    if ((st.items || []).length > 0) {
      await settleAnalyzeAmazonStage('end of results with held candidates');
    } else {
      await advanceAnalyzeNextQueryOrFail();
    }
    return;
  }

  // Log current collection progress for debugging
  console.log(`[ARBScout] Progress: ${(st.items || []).length}/${ANALYZE_MAX_AMAZON_ITEMS} items collected, continuing to page ${msgPage + 1}/${pagesPer}`);

  // Candidate cap reached — no point crawling more pages.
  if ((st.items || []).length >= ANALYZE_MAX_AMAZON_ITEMS) {
    console.log(`[ARBScout] Reached candidate cap ${ANALYZE_MAX_AMAZON_ITEMS} — finishing early (tab closes by design, match continues)`);
    await settleAnalyzeAmazonStage('candidate cap reached');
    return;
  }

  // Last requested page consumed — settle (pagination window over).
  console.log(`[ARBScout] Page check: msgPage=${msgPage}, pagesPer=${pagesPer}, condition=${msgPage >= pagesPer}`);
  if (msgPage >= pagesPer) {
    console.log(`[ARBScout] Amazon page ${msgPage}/${pagesPer} parsed — pagination complete`);
    await settleAnalyzeAmazonStage('pagination window complete');
    return;
  }

  // Keep the SAME tab open and crawl the next page with a human-like pause.
  const nextDelay = AMAZON_PAGE_DELAY_MIN_MS +
    Math.floor(Math.random() * (AMAZON_PAGE_DELAY_MAX_MS - AMAZON_PAGE_DELAY_MIN_MS + 1));
  console.log(`[ARBScout] Waiting ${nextDelay}ms before next page (current: ${msgPage}, target: ${pagesPer})`);
  await new Promise((resolve) => setTimeout(resolve, nextDelay));
  if (!analyzeCache || analyzeCache.phase !== 'searching-amazon' ||
      analyzeCache.stages.amazon.status !== 'loading') {
    console.log(`[ARBScout] Aborting pagination: cache=${!!analyzeCache}, phase=${analyzeCache?.phase}, status=${analyzeCache?.stages?.amazon?.status}`);
    return;
  }
  console.log(`[ARBScout] Crawling Amazon page ${msgPage + 1}/${pagesPer} of query "${String(activeQuery).slice(0, 40)}"`);
  await navigateAnalyzeAmazonTab(activeQuery, msgPage + 1);
}

/**
 * React to a per-page error from the Amazon tab. 'blocked' / 'timeout' fail
 * the stage immediately (the CAPTCHA tab stays open for 'blocked'). Other
 * errors only fail after the fallback query plan is exhausted — if we already
 * collected candidates, an odd parse error on a later page settles the run.
 *
 * 'price-parse' (grid rendered but no card yielded a parsable price) is
 * recoverable: with candidates held we settle on them; with none we retry the
 * SAME query/page ONCE in the same tab (late price hydration is the usual
 * cause) before spending a fallback query on it. The tab is never closed on
 * a first price-parse miss.
 */
async function handleAnalyzeQueryError(reason) {
  const st = analyzeCache.stages.amazon;
  if (reason === 'blocked' || reason === 'timeout') {
    await failAnalyzeStage('amazon', reason);
    return;
  }
  if ((st.items || []).length > 0) {
    console.log(`[ARBScout] Amazon page error "${reason}" but ${st.items.length} candidates exist — settling on scraped data`);
    await settleAnalyzeAmazonStage('page error with held candidates');
    return;
  }
  if (reason === 'price-parse' && !st.priceParseRetried) {
    st.priceParseRetried = true;
    const query = analyzeCurrentQuery();
    const page = st.page || 1;
    console.log(`[ARBScout] Amazon price parse failed with 0 candidates — retrying "${String(query).slice(0, 40)}" page ${page} once in the same tab`);
    await new Promise((resolve) => setTimeout(resolve, AMAZON_PAGE_DELAY_MIN_MS +
      Math.floor(Math.random() * (AMAZON_PAGE_DELAY_MAX_MS - AMAZON_PAGE_DELAY_MIN_MS + 1))));
    try {
      await navigateAnalyzeAmazonTab(query, page);
    } catch (e) {
      console.warn('[ARBScout] price-parse retry navigation failed:', e && e.message);
      await advanceAnalyzeNextQueryOrFail();
    }
    return;
  }
  // Remaining errors advance the query plan. Redirect interstitials (sign-in
  // / bot-wall pages that dodged isBlockedPage) report fast, so advancing
  // without pacing machine-guns the whole plan in ~1s and slams the tab shut
  // with NO_AMAZON_RESULTS — the exact "closes after 1-2 seconds" symptom.
  // Pace every advance like a human page turn, and cap consecutive dead
  // pages so a hard block terminates cleanly instead of burning the plan.
  if ((st.items || []).length === 0) {
    st.consecutivePageErrors = (st.consecutivePageErrors || 0) + 1;
    if (st.consecutivePageErrors > ANALYZE_MAX_CONSECUTIVE_PAGE_ERRORS) {
      console.log(`[ARBScout] ${ANALYZE_MAX_CONSECUTIVE_PAGE_ERRORS}+ consecutive unavailable Amazon pages — failing before burning the query plan`);
      await failAnalyzeStage('amazon', 'no-results');
      return;
    }
    const delay = AMAZON_PAGE_DELAY_MIN_MS +
      Math.floor(Math.random() * (AMAZON_PAGE_DELAY_MAX_MS - AMAZON_PAGE_DELAY_MIN_MS + 1));
    console.log(`[ARBScout] Amazon page unavailable (${reason}) — pacing ${delay}ms before next step`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  await advanceAnalyzeNextQueryOrFail();
}

/**
 * Move the SAME tab to the next broader fallback query (page 1), or fail the
 * stage once every query in the plan returned nothing.
 */
async function advanceAnalyzeNextQueryOrFail() {
  const st = analyzeCache.stages.amazon;
  const queryPlan = Array.isArray(st.queries) && st.queries.length ? st.queries : null;
  const nextIndex = (st.queryIndex || 0) + 1;
  if (!queryPlan || nextIndex >= queryPlan.length) {
    console.log(`[ARBScout] All ${queryPlan ? queryPlan.length : 0} Amazon queries returned no results`);
    await failAnalyzeStage('amazon', 'no-results');
    return;
  }
  st.queryIndex = nextIndex;
  st.page = 1;
  st.pagesDone = 0;
  st.items = []; // fresh aggregation for the fallback query
  st.priceParseRetried = false; // fresh retry budget for the new query
  const query = queryPlan[nextIndex];
  console.log(`[ARBScout] Amazon 0 results — fallback query ${nextIndex + 1}/${queryPlan.length}:`, query);
  await navigateAnalyzeAmazonTab(query, 1);
}

/**
 * Terminal success path for the Amazon stage: reclaim the tab, record the
 * deduplicated candidates and hand off to match + profit. This is the ONLY
 * place the analyze Amazon tab is closed on success — pagination and the
 * fallback loop never close it early.
 */
async function settleAnalyzeAmazonStage(reason) {
  await ensureAnalyzeState();
  if (!analyzeCache) return;
  const st = analyzeCache.stages.amazon;
  const tabId = st.tabId;
  st.tabId = null;
  await closeOwnedTab(tabId, 'analyze:amazon');
  st.status = 'done';
  analyzeCache.amazonResults = (st.items || []).slice(0, ANALYZE_MAX_AMAZON_ITEMS);
  console.log(`[ARBScout] Amazon stage done — ${analyzeCache.amazonResults.length} candidates for matching`);
  await commitAnalyze();
  await finalizeAnalyze();
}

/** (Re)establish the Amazon stage's pagination metadata (survives restarts). */
function ensureAnalyzeAmazonPlan() {
  const st = analyzeCache.stages.amazon;
  if (!st.queries || !st.queries.length) {
    st.queries = (analyzeCache.queryInfo && analyzeCache.queryInfo.query)
      ? [analyzeCache.queryInfo.query]
      : [];
  }
  if (!Number.isInteger(st.queryIndex) || st.queryIndex < 0) st.queryIndex = 0;
  if (!Number.isInteger(st.page) || st.page < 1) st.page = 1;
  if (!Number.isInteger(st.pagesDone) || st.pagesDone < 0) st.pagesDone = 0;
  if (!Number.isInteger(st.pagesPerSite) || st.pagesPerSite < 1) st.pagesPerSite = analyzeAmazonPagesPerSite();
  if (!Array.isArray(st.items)) st.items = [];
}

/** The query string currently being scraped by the pagination loop (or null). */
function analyzeCurrentQuery() {
  const st = analyzeCache.stages.amazon;
  const list = (Array.isArray(st.queries) && st.queries.length)
    ? st.queries
    : (analyzeCache.queryInfo && analyzeCache.queryInfo.query ? [analyzeCache.queryInfo.query] : []);
  if (!list.length) return null;
  return list[Math.max(0, Math.min(st.queryIndex || 0, list.length - 1))];
}

/** Clamp the user's pages-per-site (settings) to the safe ceiling. */
function analyzeAmazonPagesPerSite() {
  const s = analyzeCache && analyzeCache.settings;
  // The dedicated "Amazon pages" input wins; fall back to the legacy shared
  // "Pages per site" value for runs started before that input existed.
  const raw = s && s.amazonPages != null ? s.amazonPages : s && s.pagesPerSite;
  let n = Math.floor(Number(raw));
  if (!Number.isInteger(n) || n < 1) n = DEFAULT_ANALYZE_PAGES_PER_SITE;
  const result = Math.min(AMAZON_ABSOLUTE_MAX_PAGES, n);
  console.log(`[ARBScout] analyzeAmazonPagesPerSite: raw=${raw}, parsed=${n}, final=${result} (user wanted ${s?.amazonPages ?? 'unset'})`);
  return result;
}

/** Merge incoming page items into the running list, de-duplicating by ASIN. */
function mergeAnalyzeAmazonItems(existing, incoming) {
  const out = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set();
  for (const it of out) {
    const key = it && (it.id || it.asin);
    if (key) seen.add(key);
  }
  for (const it of incoming || []) {
    if (!it) continue;
    const key = it.id || it.asin;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(it);
    if (out.length >= ANALYZE_MAX_AMAZON_ITEMS) break;
  }
  return out;
}
/** Match + profit (pure computation, no tabs). */
async function finalizeAnalyze() {
  await ensureAnalyzeState();
  if (!analyzeCache) return;

  analyzeCache.phase = 'calculating';
  await commitAnalyze();

  const item = analyzeCache.ebayProduct;
  const results = analyzeCache.amazonResults;

  const match = self.ARBScout.matchAmazonProduct(item, results);
  // POPUP CONTRACT: renderAnalyzeResult() reads st.match.bestMatch for the
  // Amazon product card, the profit recompute, the safety box and CSV export.
  // It must be the ACCEPTED match (matchedAmazon) — never the matcher's raw
  // bestMatch (top-scored candidate even when below threshold) — or the popup
  // would render/compute profit from a rejected candidate. Leaving it unset
  // (the old bug) rendered an "81% match" badge with an EMPTY product card.
  analyzeCache.match = {
    matched: match.matched,
    confidence: match.confidence,
    strategy: match.strategy,
    warnings: match.warnings || [],
    candidates: match.candidates,
    matches: match.matches || [],
    bestMatch: match.matchedAmazon || null,
    matchedAmazon: match.matchedAmazon || null,
    errorCode: match.error ? match.error.code : null,
    errorMessage: match.error ? match.error.message : null
  };

  // One-line diagnostics: everything needed to explain a no-match remotely —
  // what the matcher was given (eBay side), how many Amazon candidates it
  // had, and how the top candidates actually scored, signal by signal.
  try {
    console.log('[ARBScout] Match summary:', JSON.stringify({
      ebay: item ? {
        title: String(item.title || '').slice(0, 60),
        price: item.price, quantity: item.quantity,
        brand: item.specifics && item.specifics.brand,
        model: item.specifics && (item.specifics.model || item.specifics.mpn)
      } : null,
      candidatesGiven: Array.isArray(results) ? results.length : 0,
      matched: match.matched,
      confidence: match.confidence,
      warnings: match.warnings || [],
      top3: (match.candidates || []).slice(0, 3).map((c) => ({
        score: `${Math.round((c.score || 0) * 100)}%`,
        asin: c.asin,
        title: String(c.title || '').slice(0, 50),
        signals: c.signals
      }))
    }));
  } catch (_) { /* diagnostics must never break the run */ }

  // Phase 2 bug fix: use the ACCEPTED match (>= confidence threshold) when
  // present, not just the top-scored candidate. matchedAmazon is null when
  // nothing was accepted, so `best` falls back to bestMatch only for display
  // purposes ("No confident match found" card) — profit is NEVER computed
  // from a below-threshold candidate anymore.
  const best = match.matchedAmazon || null;
  if (best) {
    // Phase 2 profit engine with the run's (user-configurable) settings.
    const profit = self.ARBProfit.calculateArbitrageProfit(
      { price: item.price, shipping: item.shipping },
      { price: best.price, shipping: best.shipping || 0, isPrime: !!best.isPrime },
      analyzeCache.settings
    );
    analyzeCache.profit = profit;
    // Phase 3 safety harness: variation + quantity guards over the exact
    // pair the profit was computed from.
    try {
      if (self.ARBSafety) {
        analyzeCache.safety = self.ARBSafety.assessSafety(item, best);
      }
    } catch (e) { console.warn('[arb] safety assessment failed:', e); }
  }

  analyzeCache.phase = 'done';
  analyzeCache.doneAt = Date.now();
  if (!best) {
    analyzeCache.error = {
      code: match.error ? match.error.code : 'LOW_CONFIDENCE',
      message: match.error ? match.error.message : 'no match',
      userMessage: match.error ? match.error.userMessage : 'No confident Amazon match was found.'
    };
  }
  clearAllItemWatches();
  await commitAnalyze();
}

/**
 * Phase 3: manual match correction. The popup pastes a verified Amazon ASIN
 * or product URL when automatic confidence is low (<75%); we re-open the
 * exact product page, parse it, and recalculate profit + safety against the
 * real listing — no guesswork left in the pipeline.
 */
async function applyManualMatch(input) {
  await ensureAnalyzeState();
  if (!analyzeCache) return;
  if (!analyzeCache.ebayProduct) {
    analyzeCache.phase = 'error';
    analyzeCache.error = {
      code: 'ASIN_INVALID',
      message: 'manual match without an eBay product',
      userMessage: 'Run the analyze flow first — paste an eBay URL and Analyze, then correct the match.'
    };
    await commitAnalyze();
    return;
  }

  let asinInfo;
  try {
    asinInfo = self.ARBScout.validateAmazonAsin(input);
  } catch (err) {
    analyzeCache.phase = 'error';
    analyzeCache.error = {
      code: err.code || 'ASIN_INVALID',
      message: err.message,
      userMessage: err.userMessage || 'Paste an Amazon ASIN (B0XXXXXXXXXX) or product URL.'
    };
    await commitAnalyze();
    return;
  }

  // Fresh run shell reusing the already-parsed eBay product; the Amazon
  // stage now targets the exact dp URL.
  const next = newAnalyzeState(analyzeCache.url, `a${Date.now()}`, analyzeCache.settings);
  next.ebayProduct = analyzeCache.ebayProduct;
  next.queryInfo = analyzeCache.queryInfo;
  next.manualMatch = { asin: asinInfo.asin, url: asinInfo.url, appliedAt: Date.now() };
  next.phase = 'searching-amazon';
  next.startedAt = Date.now();

  // Close the old run's tabs/watchdogs before swapping state.
  clearAllItemWatches();
  await closeOwnedTabs([
    analyzeCache.stages && analyzeCache.stages.ebay && analyzeCache.stages.ebay.tabId,
    analyzeCache.stages && analyzeCache.stages.amazon && analyzeCache.stages.amazon.tabId
  ]);

  analyzeCache = next;
  await commitAnalyze();
  try {
    await openAnalyzeTab('amazon', asinInfo.url);
  } catch (e) {
    console.warn('[arb] could not open manual-ASIN tab:', e);
    await failAnalyzeStage('amazon', 'parse-failed');
  }
}

/** Popup wants the blocked stage's tab brought to the front (CAPTCHA recovery). */
async function focusAnalyzeStageTab(stage) {
  await ensureAnalyzeState();
  if (!analyzeCache) return;
  const st = analyzeCache.stages && analyzeCache.stages[stage];
  if (!st || st.tabId == null) return;
  try {
    // Activate the tab, then lift its WINDOW (windows.update expects a window
    // id, not a tab id — passing st.tabId here used to fail silently).
    const tab = await chrome.tabs.get(st.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {
    try {
      const w = await chrome.windows.getLastFocused();
      await chrome.windows.update(w.id, { focused: true });
    } catch (_) { /* popup context — focus is best-effort */ }
  }
}

/** Popup "Analyze again": re-open whichever stage errored (or both). */
/**
 * Popup "Analyze again": re-open whichever stage errored (or both).
 * A 'blocked' stage (CAPTCHA) re-opens its URL in the SAME tab when it is
 * still registered — the user may have already solved the CAPTCHA there, and
 * re-navigating to the same URL reloads/recognizes the solved session.
 */
async function retryAnalyze() {
  await ensureAnalyzeState();
  if (!analyzeCache) return;
  if (analyzeCache.phase === 'fetching-ebay' || analyzeCache.stages.ebay.status === 'error') {
    if (!analyzeCache.url) return;
    analyzeCache.phase = 'fetching-ebay';
    analyzeCache.error = null;
    const st = analyzeCache.stages.ebay;
    st.status = 'loading';
    st.error = null;
    await commitAnalyze();
    try {
      let tab = null;
      if (st.tabId != null) {
        try { tab = await chrome.tabs.get(st.tabId); } catch (_) { tab = null; }
      }
      if (tab) {
        // Recovery surface tab still exists: re-navigate it (reuses the
        // post-CAPTCHA session), re-arm the watchdog, re-register defensively.
        try { await registerScrapeTab(tab.id); await updateTabSweepAlarm(); } catch (_) { /* noop */ }
        await chrome.tabs.update(tab.id, { url: analyzeCache.url, active: false });
        setItemWatch('ebay');
        await commitAnalyze();
      } else {
        st.tabId = null;
        await openAnalyzeTab('ebay', analyzeCache.url);
      }
    } catch (_) { await failAnalyzeStage('ebay', 'parse-failed'); }
    return;
  }
  if (analyzeCache.phase === 'searching-amazon' || analyzeCache.stages.amazon.status === 'error') {
    if (!(analyzeCache.queryInfo || analyzeCache.manualMatch)) return;
    analyzeCache.phase = 'searching-amazon';
    analyzeCache.error = null;
    const st = analyzeCache.stages.amazon;
    st.status = 'loading';
    st.error = null;

    // Rebuild orchestration metadata if a worker restart left a pre-pagination
    // stage shape, then resume on the CURRENT active (fallback-aware) query.
    ensureAnalyzeAmazonPlan();

    let url = null;
    let navQuery = null;
    if (analyzeCache.manualMatch) {
      url = analyzeCache.manualMatch.url;
    } else {
      navQuery = analyzeCurrentQuery();
      if (!navQuery) { await failAnalyzeStage('amazon', 'no-results'); return; }
      // Restart page 1 of the active query with a fresh aggregation — a retry
      // after a CAPTCHA must not inherit garbage from the interrupted run.
      st.page = 1;
      st.pagesDone = 0;
      st.items = [];
      url = self.ARBScout.buildAmazonSearchUrl(navQuery, 1);
    }
    await commitAnalyze();
    try {
      let tab = null;
      if (st.tabId != null) {
        try { tab = await chrome.tabs.get(st.tabId); } catch (_) { tab = null; }
      }
      if (navQuery) {
        // Search flow: always go through the pagination-loop navigator so the
        // watchdog, tab registry and stage.page stay consistent (and a retry
        // reuses the tab where the CAPTCHA was just solved).
        st.tabId = tab ? tab.id : null;
        await navigateAnalyzeAmazonTab(navQuery, 1);
        console.log('[ARBScout] Amazon tab reopened on retry:', st.tabId);
      } else if (tab) {
        // Manual-ASIN flow with a live recovery tab: re-navigate it in place
        // (reuses the post-CAPTCHA session) and re-arm the watchdog.
        try { await registerScrapeTab(tab.id); await updateTabSweepAlarm(); } catch (_) { /* noop */ }
        await chrome.tabs.update(tab.id, { url, active: false });
        setItemWatch('amazon');
        await commitAnalyze();
        console.log('[ARBScout] Amazon product tab reopened on retry:', tab.id);
      } else {
        st.tabId = null;
        await openAnalyzeTab('amazon', url);
      }
    } catch (_) { await failAnalyzeStage('amazon', 'parse-failed'); }
  }
}

/** Popup cancel / new analyze: drop the run and close its tabs. */
async function cancelAnalyze() {
  await ensureAnalyzeState();
  clearAllItemWatches();
  if (analyzeCache && analyzeCache.stages) {
    await closeOwnedTabs([analyzeCache.stages.ebay.tabId, analyzeCache.stages.amazon.tabId]);
  }
  analyzeCache = null;
  try { await chrome.storage.session.remove('arbAnalyzeState'); } catch (_) {}
  broadcastAnalyze();
}

/** If the user closes a tab mid-analyze, fail that stage instead of hanging. */
async function handleAnalyzeTabClosed(tabId) {
  await ensureAnalyzeState();
  if (!analyzeCache) return;
  for (const stage of ['ebay', 'amazon']) {
    const st = analyzeCache.stages[stage];
    if (st && st.status === 'loading' && st.tabId === tabId) {
      await failAnalyzeStage(stage, 'closed');
    } else if (st && st.status === 'error' && st.error === 'blocked' && st.tabId === tabId) {
      // The user closed the CAPTCHA tab without solving it — stop claiming
      // the tab is open and unregister it so the sweep can't fight the user.
      st.tabId = null;
      try { await unregisterScrapeTab(tabId); } catch (_) { /* noop */ }
    }
  }
}

/** Load user-saved analyze settings (chrome.storage.local 'arbSettings'). */
async function loadAnalyzeSettings() {
  try {
    const res = await chrome.storage.local.get('arbSettings');
    const saved = res && res.arbSettings;
    if (saved && typeof saved === 'object') {
      return Object.assign({}, DEFAULT_ANALYZE_SETTINGS, saved);
    }
  } catch (_) { /* fall through to defaults */ }
  return Object.assign({}, DEFAULT_ANALYZE_SETTINGS);
}

/* ------------------------------------------------------------------ *
 * Popup helpers: retry / refocus / state
 * ------------------------------------------------------------------ */

/**
 * Re-scrape an already-open results page (e.g. after solving a CAPTCHA).
 *
 * Why this used to dead-end the popup: the old version kept the run phase at
 * 'done' and the popup's spinner logic only looks at phase === 'searching',
 * so the UI showed finished-with-errors even while the retry was in flight —
 * and if the retry's page had navigated away, nothing ever reported back and
 * the newly-armed alarm watchdog wrote an error into a phase the popup no
 * longer rendered. The fix: put the run back into a real 'searching' phase
 * (loading only the sites being retried), arm the stage watchdog, and ALWAYS
 * finalize (or continue to the next site) once the retried stages settle.
 */
async function forceParse(sites) {
  await ensureState();
  if (cache.phase !== 'searching' && cache.phase !== 'done') return;

  const wanted = sites.filter((s) => s === 'amazon' || s === 'ebay');
  if (!wanted.length) return;

  // eBay owns the first stage now. Retrying eBay restarts the full paginated
  // capture and then hands off to Amazon once all dynamically-detected pages
  // finish (maxPage is re-detected on the first page parse).
  if (wanted.includes('ebay')) {
    cache.phase = 'searching';
    cache.doneAt = null;
    cache.startedAt = Date.now();
    cache.pairs = [];
    cache.sites.amazon.status = 'idle';
    cache.sites.amazon.error = null;
    cache.sites.amazon.items = [];
    cache.sites.amazon.page = 1;
    cache.sites.amazon.pagesDone = 0;
    cache.sites.ebay.status = 'loading';
    cache.sites.ebay.error = null;
    cache.sites.ebay.items = [];
    cache.sites.ebay.page = 1;
    cache.sites.ebay.pagesDone = 0;
    await commit();
    await openSearchTab('ebay', { page: 1, resetItems: true });
    return;
  }

  // Verify the tabs actually exist before touching state; a dead tabId is the
  // classic reason a retry never answered and the UI spun forever.
  const reopened = {};
  for (const site of wanted) {
    const ss = cache.sites[site];
    let tab = null;
    try { tab = await chrome.tabs.get(ss.tabId); } catch (_) { tab = null; }
    if (!tab) {
      try {
        const url = searchUrlForSite(site);
        tab = await chrome.tabs.create({ url, active: false });
        ss.tabId = tab.id;
        ss.url = tab.url || url;
      } catch (_) { /* fall through; injection will report the failure */ }
    }
    reopened[site] = !!tab;
  }

  // Re-enter a searching phase for exactly the retried stages. phase='done'
  // here would leave the popup permanently stuck (see docstring above).
  cache.phase = 'searching';
  cache.doneAt = null;
  cache.startedAt = Date.now(); // restart the popup's elapsed timer
  cache.pairs = [];
  for (const site of wanted) {
    const ss = cache.sites[site];
    ss.status = 'loading';
    ss.error = null;
    ss.items = [];
    if (site === 'ebay') {
      ss.page = 1;
      ss.pagesDone = 0;
    } else if (site === 'amazon') {
      ss.page = 1;
      ss.pagesDone = 0;
    }
  }
  await commit();

  for (const site of wanted) {
    const ss = cache.sites[site];
    const tabId = ss.tabId;
    if (!reopened[site] || tabId == null) {
      await failStage(site, 'inject-failed');
      continue;
    }

    setWatch(site); // active watchdog for this retry

    // 1) Ask the already-injected content script to re-run (it validates the
    //    run token, so only the current script instance answers).
    let ok = false;
    try { await chrome.tabs.sendMessage(tabId, { type: 'ARB_SCRAPE_NOW' }); ok = true; }
    catch (_) { /* no receiver (page predates install or was reloaded) */ }

    // 2) If nothing answered, (re-)inject content.js so it runs its auto flow.
    if (!ok) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      } catch (e) {
        await failStage(site, 'inject-failed');
      }
    }
  }
  // Success/failure paths flow back through handleResults/failStage, both of
  // which finalize the run — the popup can never be left mid-flight.
}

/** Focus an existing results tab, or reopen it (search state preserved). */
async function openResultsTab(site) {
  await ensureState();
  if (site !== 'amazon' && site !== 'ebay' && site !== 'aliexpress') return;
  const ss = cache.sites[site];
  if (!ss) return;

  let tab = null;
  try { tab = await chrome.tabs.get(ss.tabId); } catch (_) {}
  if (tab) {
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
    return;
  }
  // Reopen — but only re-arm a pending stage if we are still waiting on it.
  const stillWaiting = cache.phase === 'searching' && ss.status === 'loading';
  const url = searchUrlForSite(site);
  const created = await chrome.tabs.create({ url, active: true });
  ss.tabId = created.id;
  ss.url = created.url || url;
  if (stillWaiting) setWatch(site);
  await commit();
}

/* ------------------------------------------------------------------ *
 * Event wiring
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse(Object.assign({ ok: true }, result)))
    .catch((err) => {
      console.warn('[arb] handler error:', err);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
  return true; // keep the message channel open for the async reply
});

async function handleMessage(msg, sender) {
  if (!msg || !msg.type) return {};

  switch (msg.type) {
    case 'ARB_START': {
      const query = String(msg.query || '').trim();
      if (query.length < 2) return { error: 'Query too short' };
      const pageLimit = Math.floor(Number(msg.pageLimit));
      await startRun(query, pageLimit);
      return {};
    }
    case 'ARB_GET_STATE': {
      await ensureState();
      return { state: cache };
    }
    case 'ARB_FORCE_PARSE': {
      const sites = Array.isArray(msg.sites) ? msg.sites : ['amazon', 'ebay'];
      await forceParse(sites);
      return {};
    }
    case 'ARB_OPEN_RESULTS': {
      await openResultsTab(msg.site);
      return {};
    }
    case 'ARB_RESULTS': {
      // Two flows share ARB_RESULTS: the legacy keyword run (phase gates in
      // handleResults ignore analyze runs) and the Phase-2 analyze run.
      await handleResults(msg, sender);
      await handleAnalyzeAmazonResults(msg, sender);
      return {};
    }
    case 'ARB_ITEM_DATA': {
      await handleItemData(msg, sender);
      return {};
    }
    case 'ARB_ANALYZE': {
      const url = String(msg.url || '').trim();
      const settings = msg.settings && typeof msg.settings === 'object' ? msg.settings : null;
      await startAnalyze(url, settings ? Object.assign({}, await loadAnalyzeSettings(), settings) : await loadAnalyzeSettings());
      return {};
    }
    case 'ARB_ANALYZE_GET_STATE': {
      await ensureAnalyzeState();
      return { state: analyzeCache };
    }
    case 'ARB_ANALYZE_RETRY': {
      await retryAnalyze();
      return {};
    }
    case 'ARB_ANALYZE_CANCEL': {
      await cancelAnalyze();
      return {};
    }
    case 'ARB_ANALYZE_FOCUS_TAB': {
      await focusAnalyzeStageTab(msg.stage === 'amazon' ? 'amazon' : 'ebay');
      return {};
    }
    case 'ARB_ANALYZE_MANUAL_MATCH': {
      const input = String((msg.input || msg.asin || msg.url) || '').trim();
      if (!input) return { error: 'Missing ASIN or URL' };
      await applyManualMatch(input);
      return {};
    }
    default:
      return {};
  }
}

/**
 * Failsafe: re-arm the worker after Chrome killed it while a stage was in
 * flight. The setTimeout watchdog dies with the worker; this alarm (set
 * at the same time) gives us one last chance to mark the stage 'timeout'
 * instead of leaving the popup spinner up forever.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TAB_SWEEP_ALARM) {
    sweepOrphanTabs().catch((e) => console.warn('[arb] tab sweep error:', e));
    return;
  }
  const m = /^arb\.(r\d+)\.(amazon|ebay)$/.exec(alarm.name);
  if (m) {
    handleAlarm(m[1], m[2]).catch((e) => console.warn('[arb] alarm error:', e));
    return;
  }
  // Phase-2 analyze watchdog failsafe (same pattern, separate namespace).
  const a = /^arbItem\.(a\d+)\.(ebay|amazon)$/.exec(alarm.name);
  if (a) {
    handleItemStageTimeout(a[1], a[2]).catch((e) => console.warn('[arb] item alarm error:', e));
  }
});

async function handleAlarm(runId, site) {
  await ensureState();
  if (!cache || cache.runId !== runId || cache.phase !== 'searching') return;
  const ss = cache.sites[site];
  if (!ss || ss.status !== 'loading') return;
  await failStage(site, 'timeout');
}



/** If the user closes the results tab while we wait on it, don't hang. */
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  handleTabClosed(tabId).catch((e) => console.warn('[arb] tabs.onRemoved error:', e));
});

async function handleTabClosed(tabId) {
  // Always drop closed tabs from the orphan registry, whatever run they
  // belonged to — otherwise the sweep would keep re-closing dead ids.
  try { await unregisterScrapeTab(tabId); } catch (_) { /* cleanup.js missing */ }

  await ensureState();
  if (cache.phase === 'searching') {
    for (const site of ['amazon', 'ebay']) {
      const ss = cache.sites[site];
      if (ss.status === 'loading' && ss.tabId === tabId) {
        await failStage(site, 'closed');
      }
    }
  }
  // Phase-2 analyze tabs: fail the stuck stage instead of hanging forever.
  await handleAnalyzeTabClosed(tabId);
}

/* ==================================================================== *
 * Worker (re)start: sweep tabs registered by a previous life            *
 * ====================================================================
 * MV3 kills this worker after ~30s idle. If that happened between a tab
 * being opened and its stage settling, the watchdog timers died with it.
 * On wake, sweepOrphanTabs() closes every registered tab that is not an
 * actively-loading stage — so no orphaned scraping tab can survive a
 * worker restart. */
(async () => {
  try {
    await ensureState();
    await ensureAnalyzeState();
    await sweepOrphanTabs();
  } catch (e) {
    console.warn('[arb] startup tab sweep failed:', e);
  }
})();
