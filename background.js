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

/* ------------------------------------------------------------------ *
 * Constants / config
 * ------------------------------------------------------------------ */
const SEARCH_URLS = {
  amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}&ref=nb_sb_noss`,
  ebay: (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=0`
};

// eBay final-value fee is ~13.25% for most categories (2025); the popup lets
// the user override this per run. We only store raw prices here.
const MATCH_THRESHOLD = 0.34; // min title-similarity for a pair (0..1)
const MAX_PAIRS = 80;

// Per-stage hard timeout. The content script itself is bounded to 10s; this
// covers everything around it (navigation, first paint, message latency).
// It is implemented as a plain setTimeout — timers are cheap and reliable
// while the service worker is alive — plus a chrome.alarms failsafe for the
// case where Chrome kills the worker and never resumes it.
const STAGE_TIMEOUT_MS = 30000;
const ALARM_WATCHDOG_MIN = 2; // failsafe alarm, in minutes

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
  return { status: 'idle', items: [], error: null, tabId: null, url: null };
}

function newRunState(query, runId) {
  return {
    runId,
    query,
    // A brand-new state is ALWAYS idle. 'searching' is only ever entered by an
    // explicit user command (startRun from the Compare click, forceParse from
    // "Parse again"). Booting into 'searching' here used to make the popup's
    // first ARB_GET_STATE restore a phantom run nobody started — the spinner
    // appeared with its elapsed-seconds counter climbing before any input.
    phase: 'idle', // 'idle' | 'searching' | 'done'
    startedAt: null,
    doneAt: null,
    sites: { amazon: emptySiteState(), ebay: emptySiteState() },
    pairs: [],       // [{ sim, amazon: {…}, ebay: {…} }]
    summary: { pairs: 0, amzTotal: 0, ebayTotal: 0, amzUsed: 0, ebayUsed: 0 }
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

const alarmName = (runId, site) => `arb.${runId}.${site}`;

/**
 * Arm the watchdog for a stage: a one-shot 30s setTimeout PLUS a 2-minute
 * alarm failsafe. Why both?
 *   - The setTimeout is the real deadline users feel (30s, not 1–2 min).
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
  for (const site of ['amazon', 'ebay']) clearWatch(site);
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

/** A stage blew its 30s deadline -> record the reason and move the run on. */
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
async function startRun(query) {
  await ensureState();
  const old = cache;
  cache = newRunState(query, `r${Date.now()}`);
  cache.phase = 'searching'; // explicit, user-commanded transition
  cache.startedAt = Date.now();

  // Kill any watchdogs from the previous run FIRST — their callbacks must
  // never fire into the new run's state (checkRun still accepts old runIds,
  // but the timers are gone, and the alarm names differ).
  if (old && old.runId && old.runId !== cache.runId) {
    if (old.sites.amazon.status === 'loading') clearWatch('amazon');
    if (old.sites.ebay.status === 'loading') clearWatch('ebay');
  }
  await commit(); // show "Amazon loading" immediately in the popup

  // Housekeeping for the previous run (best-effort): drop its stale alarms
  // and close its result tabs so they can't deliver late ARB_RESULTS messages.
  if (old && old.runId && old.runId !== cache.runId) {
    clearAlarmsForRun(old.runId);
    const ids = [old.sites.amazon.tabId, old.sites.ebay.tabId].filter((t) => t != null);
    if (ids.length) { try { await chrome.tabs.remove(ids); } catch (_) {} }
  }

  // If opening the first tab fails (rare), fail back to idle instead of
  // leaving a 'searching' run with no active stage — that ghost state is
  // exactly what used to spin the popup forever.
  try {
    await openSearchTab('amazon');
  } catch (e) {
    console.warn('[arb] could not open Amazon tab:', e);
    cache.sites.amazon.status = 'error';
    cache.sites.amazon.error = 'open-failed';
    cache.phase = 'idle';
  }
  await commit();
}

/** Open (or refocus) the results tab for a marketplace and arm the watchdog. */
async function openSearchTab(site) {
  const ss = cache.sites[site];
  let tab;
  try { tab = await chrome.tabs.get(ss.tabId); } catch (_) { tab = null; }

  if (!tab) {
    tab = await chrome.tabs.create({ url: SEARCH_URLS[site](cache.query), active: false });
    ss.tabId = tab.id;
  } else {
    await chrome.tabs.update(tab.id, { active: true });
  }
  ss.url = tab.url || SEARCH_URLS[site](cache.query);
  ss.status = 'loading';
  ss.error = null;
  ss.items = [];
  setWatch(site);
  await commit();
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
  await commit();

  if (site === 'amazon') await openSearchTab('ebay');
  else await finalizeRun();
}


/** Handle ARB_RESULTS coming from content.js on a search page. */
async function handleResults(msg, sender) {
  await ensureState();
  if (cache.phase !== 'searching') return;
  const site = msg && msg.site;
  if (site !== 'amazon' && site !== 'ebay') return;

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
    await failStage(site, reason);
    return;
  }

  ss.status = 'done';
  ss.items = Array.isArray(msg.items) ? msg.items : [];
  await commit();

  if (site === 'amazon') await openSearchTab('ebay');
  else await finalizeRun();
}

const normalize = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Both stages finished (or errored): match items and store pairs. */
async function finalizeRun() {
  await ensureState();
  if (cache.phase !== 'searching') return;

  cache.phase = 'done';
  cache.doneAt = Date.now();
  clearAllWatches();

  const amz = cache.sites.amazon.items || [];
  const ebay = cache.sites.ebay.items || [];

  const matched = computePairs(amz, ebay);
  cache.pairs = matched.pairs;
  cache.summary = {
    pairs: matched.pairs.length,
    amzTotal: amz.length,
    ebayTotal: ebay.length,
    amzUsed: matched.amzUsed,
    ebayUsed: matched.ebayUsed
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
 * (loading only the sites being retried), arm the 30s watchdog, and ALWAYS
 * finalize (or continue to the next site) once the retried stages settle.
 */
async function forceParse(sites) {
  await ensureState();
  if (cache.phase !== 'searching' && cache.phase !== 'done') return;

  const wanted = sites.filter((s) => s === 'amazon' || s === 'ebay');
  if (!wanted.length) return;

  // Verify the tabs actually exist before touching state; a dead tabId is the
  // classic reason a retry never answered and the UI spun forever.
  const reopened = {};
  for (const site of wanted) {
    const ss = cache.sites[site];
    let tab = null;
    try { tab = await chrome.tabs.get(ss.tabId); } catch (_) { tab = null; }
    if (!tab) {
      try {
        tab = await chrome.tabs.create({ url: SEARCH_URLS[site](cache.query), active: false });
        ss.tabId = tab.id;
        ss.url = tab.url || SEARCH_URLS[site](cache.query);
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
  }
  await commit();

  for (const site of wanted) {
    const ss = cache.sites[site];
    const tabId = ss.tabId;
    if (!reopened[site] || tabId == null) {
      await failStage(site, 'inject-failed');
      continue;
    }

    setWatch(site); // 30s active watchdog for this retry

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
  if (site !== 'amazon' && site !== 'ebay') return;
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
  const created = await chrome.tabs.create({ url: SEARCH_URLS[site](cache.query), active: true });
  ss.tabId = created.id;
  ss.url = created.url || SEARCH_URLS[site](cache.query);
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
      await startRun(query);
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
      await handleResults(msg, sender);
      return {};
    }
    default:
      return {};
  }
}

/**
 * Failsafe: re-arm the worker after Chrome killed it while a stage was in
 * flight. The 30s setTimeout watchdog dies with the worker; this alarm (set
 * at the same time) gives us one last chance to mark the stage 'timeout'
 * instead of leaving the popup spinner up forever.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  const m = /^arb\.(r\d+)\.(amazon|ebay)$/.exec(alarm.name);
  if (!m) return;
  handleAlarm(m[1], m[2]).catch((e) => console.warn('[arb] alarm error:', e));
});

async function handleAlarm(runId, site) {
  await ensureState();
  if (!cache || cache.runId !== runId || cache.phase !== 'searching') return;
  const ss = cache.sites[site];
  if (!ss || ss.status !== 'loading') return;
  await failStage(site, 'timeout');
}



/** If the user closes the results tab while we wait on it, don't hang. */
chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabClosed(tabId).catch((e) => console.warn('[arb] tabs.onRemoved error:', e));
});

async function handleTabClosed(tabId) {
  await ensureState();
  if (cache.phase !== 'searching') return;
  for (const site of ['amazon', 'ebay']) {
    const ss = cache.sites[site];
    if (ss.status === 'loading' && ss.tabId === tabId) {
      await failStage(site, 'closed');
    }
  }
}
