/*
 * popup.js — UI controller for the extension popup
 * -----------------------------------------------------------------------------
 * Talks to background.js with chrome.runtime.sendMessage:
 *   -> { type: 'ARB_START', query }          begin a run
 *   -> { type: 'ARB_GET_STATE' }             snapshot on popup open
 *   -> { type: 'ARB_FORCE_PARSE', sites }    re-scrape (after CAPTCHA etc.)
 *   -> { type: 'ARB_OPEN_RESULTS', site }    focus/reopen a results tab
 *   <- { type: 'ARB_STATE', state }          pushed on every state change
 *
 * Profit math lives HERE (not background) so changing the fee % re-sorts the
 * table instantly without re-scraping:
 *   fees   = sellPrice * feeRate
 *   profit = sellPrice - fees - buyPrice
 *   margin = profit / buyPrice  (%)
 */
'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  q: $('q'),
  compare: $('btnCompare'),
  feeRate: $('feeRate'),
  pageLimit: $('pageLimit'),
  progressBox: $('progressBox'),
  progressText: $('progressText'),
  chipAmazon: $('chipAmazon'),
  chipEbay: $('chipEbay'),
  retry: $('btnRetry'),
  banner: $('banner'),
  resultsBox: $('resultsBox'),
  summary: $('summary'),
  hideNeg: $('hideNeg'),
  rows: $('rows'),
  emptyState: $('emptyState'),
  readyHint: $('readyHint'),
  openAmazon: $('btnOpenAmazon'),
  openEbay: $('btnOpenEbay'),
  reset: $('btnReset'),
  debugLog: $('btnDebugLog'),
  toast: $('toast'),

  // Phase 2: analyze flow
  ebayUrl: $('ebayUrl'),
  analyzeBtn: $('btnAnalyze'),
  quickSettingsBtn: $('btnQuickSettings'),
  quickSettings: $('quickSettings'),
  anEbayFeeRate: $('anEbayFeeRate'),
  anFixedFee: $('anFixedFee'),
  anSalesTax: $('anSalesTax'),
  anBuffer: $('anBuffer'),
  amazonPages: $('amazonPages'),
  analyzeProgress: $('analyzeProgress'),
  analyzeStep: $('analyzeStep'),
  analyzeElapsed: $('analyzeElapsed'),
  chipStepEbay: $('chipStepEbay'),
  chipStepAmazon: $('chipStepAmazon'),
  chipStepProfit: $('chipStepProfit'),
  analyzeRetry: $('btnAnalyzeRetry'),
  analyzeCancel: $('btnAnalyzeCancel'),
  analyzeError: $('analyzeError'),
  analyzeResult: $('analyzeResult'),
  anEbayThumb: $('anEbayThumb'),
  anEbayTitle: $('anEbayTitle'),
  anEbayPrice: $('anEbayPrice'),
  anEbayShip: $('anEbayShip'),
  anEbayLink: $('anEbayLink'),
  anAmazonThumb: $('anAmazonThumb'),
  anAmazonTitle: $('anAmazonTitle'),
  anAmazonPrice: $('anAmazonPrice'),
  anMatches: $('anMatches'),
  anAmazonPrime: $('anAmazonPrime'),
  anAmazonLink: $('anAmazonLink'),
  anConfidence: $('anConfidence'),
  anStrategy: $('anStrategy'),
  anProfitBox: $('anProfitBox'),
  anNetProfit: $('anNetProfit'),
  anRoi: $('anRoi'),
  anMargin: $('anMargin'),
  anBreakdown: $('anBreakdown'),
  anProfitWarn: $('anProfitWarn'),

  // Phase 3: safety harness, blocked recovery, manual match, export
  anSafetyBox: $('anSafetyBox'),
  anManualMatch: $('anManualMatch'),
  anAsinInput: $('anAsinInput'),
  applyAsin: $('btnApplyAsin'),
  copyBreakdown: $('btnCopyBreakdown'),
  exportCsv: $('btnExportCsv'),
  anExportHint: $('anExportHint'),
  blockedRecovery: $('blockedRecovery'),
  blockedRecoveryMsg: $('blockedRecoveryMsg'),
  focusBlockedTab: $('btnFocusBlockedTab'),
  blockedRetry: $('btnBlockedRetry')
};

const fmtUSD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtPct = (n) => `${n >= 0 ? '' : '−'}${Math.abs(n).toFixed(1)}%`;

const CONFIDENCE_MANUAL_THRESHOLD = 75; // below this: show manual-override UI

/** Validate the page-limit input: positive integer 1..20, default 3 when empty/invalid. */
function getPageLimit() {
  const raw = els.pageLimit.value.trim();
  if (!raw) return 3;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(n, 20);
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
let state = null; // last snapshot received from background
let sort = { key: 'profit', dir: 'desc' };

const ERROR_LABELS = {
  blocked: 'blocked (bot check / CAPTCHA)',
  timeout: 'timed out (45s ceiling)',
  'no-results': 'no results found',
  'no-results-page': 'redirected to a non-search page',
  closed: 'tab was closed',
  'parse-failed': 'could not parse the page',
  'inject-failed': 'could not inject the parser',
  'no-query': 'page had no search query',
  'chrome-error': 'page failed to load (network error)'
};

function chipText(siteName, st) {
  const count = st.items ? st.items.length : 0;
  switch (st.status) {
    case 'idle': return `${siteName}: queued`;
    case 'loading': return st.page ? `${siteName}: page ${st.page} loading…` : `${siteName}: loading…`;
    case 'done': return `${siteName}: ${count} item${count === 1 ? '' : 's'}`;
    case 'error': return `${siteName}: ${ERROR_LABELS[st.error] || st.error}`;
    default: return `${siteName}: —`;
  }
}

function renderChip(chipEl, labelEl, siteName, st) {
  chipEl.classList.toggle('busy', st.status === 'loading');
  chipEl.classList.toggle('done', st.status === 'done');
  chipEl.classList.toggle('err', st.status === 'error');
  chipEl.title = st.error ? ERROR_LABELS[st.error] || st.error : '';
  labelEl.textContent = chipText(siteName, st);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
function render() {
  if (!state || state.phase === 'idle') {
    stopTicker(); // no run in flight -> no interval may outlive it
    els.progressBox.classList.add('hidden');
    els.resultsBox.classList.add('hidden');
    els.banner.classList.add('hidden');
    els.readyHint.classList.remove('hidden');
    els.compare.disabled = false;
    return;
  }

  els.readyHint.classList.add('hidden');
  const searching = state.phase === 'searching';
  els.progressBox.classList.toggle('hidden', !searching);
  els.compare.disabled = searching;

  if (searching) {
    const amz = state.sites.amazon;
    const ebay = state.sites.ebay;
    const elapsed = Math.min(99, Math.floor((Date.now() - (state.startedAt || Date.now())) / 1000));
    const pageLimit = Number.isInteger(state.pageLimit) && state.pageLimit > 0 ? state.pageLimit : 3;
    let step;
    if (ebay.status === 'loading') {
      const page = ebay.page || 1;
      step = `Step 1 of 2 — searching eBay page ${page} of ${pageLimit}…`;
    } else if ((ebay.status === 'done' || ebay.status === 'error') && amz.status === 'loading') {
      const page = amz.page || 1;
      step = `Step 2 of 2 — searching Amazon page ${page} of ${pageLimit} & comparing…`;
    } else {
      step = 'Comparing results…';
    }
    // The run is hard-bounded in the background (45s per stage), so a spinner
    // older than that is a stale optimistic state from before the worker
    // replied — tell the user instead of spinning silently.
    els.progressText.textContent = elapsed >= 60
      ? `${step} (${elapsed}s — still waiting; the run fails safely after its deadline)`
      : `${step} (${elapsed}s)`;
  } else {
    els.progressText.textContent = 'Done.';
  }

  renderChip(els.chipEbay, els.chipEbay.querySelector('.lbl'), 'eBay', state.sites.ebay);
  renderChip(els.chipAmazon, els.chipAmazon.querySelector('.lbl'), 'Amazon', state.sites.amazon);

  // "Parse again" appears whenever some site is in an error state.
  const anyError = ['ebay', 'amazon'].some((s) => state.sites[s].status === 'error');
  els.retry.classList.toggle('hidden', !anyError);

  renderBanner();
  renderResults();
}

function renderBanner() {
  const lines = [];
  for (const s of ['ebay', 'amazon']) {
    const st = state.sites[s];
    if (st.status === 'error') {
      const name = s === 'amazon' ? 'Amazon' : 'eBay';
      const label = ERROR_LABELS[st.error] || st.error;
      if (st.error === 'blocked') {
        lines.push(`<b>${name}</b> served a bot check (${label}). ` +
          `The results tab is open in the background — solve the check there, then click <b>Parse again</b>.`);
      } else if (st.error === 'timeout') {
        lines.push(`<b>${name}</b> hit the 45s load ceiling (${label}). The page may be slow, or the marketplace served a layout/bot check the parser did not recognize. Check the tab, then click <b>Parse again</b>.`);
      } else if (st.error === 'no-results') {
        lines.push(`<b>${name}</b> loaded but no parsable results were found (${label}). If the page shows results, the layout may have changed — click <b>Parse again</b> after checking the tab.`);
      } else if (st.error === 'closed') {
        lines.push(`<b>${name}</b> results tab was closed (${label}).`);
      } else {
        lines.push(`<b>${s === 'amazon' ? 'Amazon' : 'eBay'}</b>: ${label}.`);
      }
    }
  }
  const msg = lines.join('<br/>');
  if (msg) {
    els.banner.innerHTML = `<span class="msg">${msg}</span>`;
    els.banner.classList.remove('hidden');
  } else {
    els.banner.classList.add('hidden');
    els.banner.innerHTML = '';
  }
}

/** Background-worker reachability probe (used by the mid-run watchdog below). */
function ping() {
  return chrome.runtime.sendMessage({ type: 'ARB_GET_STATE' });
}

/**
 * Popup-side watchdog, active ONLY while a run is in its searching phase:
 * re-renders the elapsed timer each second and probes the background if it
 * has been silent for 50s (its own per-stage watchdog is 45s, so silence
 * past that means the worker was killed or the channel is broken — say so
 * instead of spinning forever). The interval self-cancels the moment the
 * run leaves the searching phase; nothing times out here permanently.
 */
let lastStateAt = 0;
let ticker = null;

/** Kill the popup watchdog. The ONLY owner of setInterval in this file. */
function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

function startTicker() {
  if (ticker) return;
  lastStateAt = Date.now();
  ticker = setInterval(() => {
    if (!(state && state.phase === 'searching')) {
      stopTicker();
      return;
    }
    render(); // updates the elapsed-seconds readout
    if (Date.now() - lastStateAt > 50000) {
      lastStateAt = Date.now();
      ping().then((res) => {
        if (res && res.ok && res.state) {
          applyState(res.state);
          lastStateAt = Date.now();
        }
      }).catch(() => {
        els.banner.innerHTML =
          '<span class="msg">Background worker is not responding. Reload the extension on <b>chrome://extensions</b>, then click <b>Parse again</b>.</span>';
        els.banner.classList.remove('hidden');
      });
    }
  }, 1000);
}

/**
 * Accept a background snapshot ONLY if it is coherent: a 'searching' phase
 * must have at least one stage actually 'loading'. Anything else (a phantom
 * run left by an older build, or leftovers from an extension reload) drops
 * the popup back to the idle Ready state. This is the second guard that
 * makes auto-running impossible: rendering can never invent a run.
 */
function applyState(st) {
  const statusOf = (s) => (st.sites && st.sites[s] && st.sites[s].status) || null;
  const coherent =
    st.phase === 'idle' ||
    st.phase === 'done' ||
    (st.phase === 'searching' &&
      (statusOf('amazon') === 'loading' || statusOf('ebay') === 'loading'));
  if (!coherent) { state = null; render(); return; }
  state = st;
  if (st.phase === 'searching') startTicker();
  render();
}

/** Row economics computed from the current fee % (no re-scrape needed). */
function rowValues(p) {
  const buy = p.amazon.price || 0;
  const sell = p.ebay.price || 0;
  const feeRate = Math.max(0, parseFloat(els.feeRate.value) || 0) / 100;
  const fees = sell * feeRate;
  const profit = sell - fees - buy;
  const margin = buy > 0 ? (profit / buy) * 100 : 0;
  return { buy, sell, fees, profit, margin };
}

const sortValue = {
  product: (p) => p.amazon.title.toLowerCase(),
  ebay: (p) => p.ebay.title.toLowerCase(),
  buy: (p) => p.amazon.price || 0,
  sell: (p) => p.ebay.price || 0,
  fees: (p) => rowValues(p).fees,
  profit: (p) => rowValues(p).profit,
  margin: (p) => rowValues(p).margin
};
const NUMERIC_KEYS = new Set(['buy', 'sell', 'fees', 'profit', 'margin']);

function makeEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function cell(value, cls) {
  const td = document.createElement('td');
  td.className = (cls || '') + (NUMERIC_KEYS.has(sort.key) ? '' : '');
  td.textContent = value;
  return td;
}

function productCell(item, host, extra) {
  const td = document.createElement('td');
  const wrap = makeEl('div', extra || 'prod');
  const img = item.image;
  if (img) {
    const imWrap = makeEl('div', 'img-wrap');
    const im = document.createElement('img');
    im.src = img;
    im.alt = '';
    im.loading = 'lazy';
    im.addEventListener('error', () => imWrap.remove());
    imWrap.appendChild(im);
    wrap.appendChild(imWrap);
  } else {
    wrap.appendChild(makeEl('span', 'ph', (item.title[0] || '?').toUpperCase()));
  }
  const title = makeEl('a', 't ellipsis', item.title);
  title.href = safeUrl(item.url, host) || '#';
  title.target = '_blank';
  title.rel = 'noopener';
  title.title = item.title;
  wrap.appendChild(title);
  td.appendChild(wrap);
  return td;
}

function buildRow(p) {
  const v = rowValues(p);
  const tr = document.createElement('tr');

  // --- eBay listing column first (source listing for dropshipping review) ---
  const tdEbay = productCell(p.ebay, 'ebay', 'prod ebay-cell');
  tdEbay.querySelector('.prod').appendChild(makeEl('span', 'match', `title match ${p.sim}%`));
  tr.appendChild(tdEbay);

  const tdSell = makeEl('td', 'money');
  tdSell.textContent = fmtUSD.format(v.sell);
  tr.appendChild(tdSell);

  // --- Amazon product column second (cross-reference/buy side) ---
  tr.appendChild(productCell(p.amazon, 'amazon', 'prod'));

  const tdBuy = makeEl('td', 'money');
  tdBuy.textContent = p.amazon.price != null ? fmtUSD.format(v.buy) : '—';
  tr.appendChild(tdBuy);

  // --- Fees, Profit, Margin ---
  const tdFees = makeEl('td', 'money');
  tdFees.textContent = `−${fmtUSD.format(v.fees)}`;
  tr.appendChild(tdFees);

  const tdProfit = makeEl('td', 'money ' + (v.profit >= 0 ? 'pos' : 'neg'));
  tdProfit.textContent = (v.profit >= 0 ? '+' : '−') + fmtUSD.format(Math.abs(v.profit));
  tr.appendChild(tdProfit);

  const tdMargin = makeEl('td', 'money ' + (v.margin >= 0 ? 'pos' : 'neg'));
  tdMargin.textContent = fmtPct(v.margin);
  tr.appendChild(tdMargin);

  return tr;
}

function renderResults() {
  const done = state.phase === 'done';
  els.resultsBox.classList.toggle('hidden', !done);
  if (!done) return;

  const sum = state.summary || {};
  const base = `Matched <b>${sum.pairs}</b> pair${sum.pairs === 1 ? '' : 's'}`;
  const detail = [];
  if (sum.ebayTotal) detail.push(`${sum.ebayTotal} eBay`);
  if (sum.amzTotal) detail.push(`${sum.amzTotal} Amazon`);
  const unmatched = (sum.ebayTotal || 0) - (sum.ebayUsed || 0);
  const unmatchedTxt = unmatched > 0 ? ` (${unmatched} eBay listings unpaired)` : '';
  els.summary.innerHTML = `${base} · ${detail.join(' / ')}${unmatchedTxt}`;

  let pairs = (state.pairs || []).slice();

  // Filter.
  const hideNeg = els.hideNeg.checked;
  if (hideNeg) pairs = pairs.filter((p) => rowValues(p).profit > 0);

  // Sort.
  const getVal = sortValue[sort.key] || sortValue.profit;
  const dir = sort.dir === 'asc' ? 1 : -1;
  pairs.sort((a, b) => {
    const va = getVal(a);
    const vb = getVal(b);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });

  els.rows.replaceChildren(...pairs.map(buildRow));
  markSortHeader();

  const amzErr = state.sites.amazon.status === 'error';
  const ebayErr = state.sites.ebay.status === 'error';
  if (!pairs.length) {
    let text;
    if (sum.pairs === 0 && amzErr && ebayErr) {
      text = 'Neither marketplace could be parsed. Solve any bot check in the open tab(s), then click "Parse again".';
    } else if (sum.pairs === 0 && amzErr) {
      text = 'Amazon could not be parsed, so no comparisons were made. eBay still found items — try "Parse again" after fixing Amazon.';
    } else if (sum.pairs === 0 && ebayErr) {
      text = 'eBay could not be parsed, so the Amazon cross-reference was not completed. Try "Parse again" after fixing eBay.';
    } else if (sum.pairs === 0) {
      text = 'No matching product pairs were found across the two marketplaces. Try a more specific or brand-inclusive query (e.g. "Stanley 40 oz Quencher"), or lower your fee assumption.';
    } else {
      text = `All ${sum.pairs} matched pair${sum.pairs === 1 ? '' : 's'} are unprofitable at the current fee — untick "Profitable only" to see them anyway.`;
    }
    els.emptyState.textContent = text;
    els.emptyState.classList.remove('hidden');
  } else {
    els.emptyState.classList.add('hidden');
  }
}

function markSortHeader() {
  document.querySelectorAll('#table thead th').forEach((th) => {
    const arr = th.querySelector('.arr');
    if (arr) arr.remove();
    if (th.dataset.key === sort.key) {
      const arrow = makeEl('span', 'arr', sort.dir === 'asc' ? ' ▲' : ' ▼');
      th.appendChild(arrow);
    }
  });
}

/** Only ever link to the marketplace hosts we scraped. */
function safeUrl(url, host) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const allowed = host === 'amazon' ? /(^|\.)amazon\.com$/ : /(^|\.)ebay\.com$/;
    return allowed.test(u.hostname) && (u.protocol === 'https:') ? u.href : null;
  } catch (_) { return null; }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */
async function startCompare() {
  const query = els.q.value.trim();
  if (query.length < 2) {
    els.q.focus();
    els.q.setCustomValidity('Enter a product search query (2+ characters).');
    els.q.reportValidity();
    return;
  }
  els.q.setCustomValidity('');

  // Persist the page limit and validate it (positive integer, default 3).
  const pageLimit = getPageLimit();
  els.pageLimit.value = String(pageLimit);
  chrome.storage.local.set({ pageLimit }).catch(() => {});

  // Optimistic local state so the UI responds instantly; the background's
  // authoritative ARB_STATE pushes will replace it as the run progresses.
  state = {
    runId: 'local',
    query,
    pageLimit,
    phase: 'searching',
    startedAt: Date.now(),
    sites: {
      amazon: { status: 'idle', items: [], error: null, tabId: null, url: null, page: 1, pagesDone: 0 },
      ebay: { status: 'loading', items: [], error: null, tabId: null, url: null, page: 1, pagesDone: 0 }
    },
    pairs: [],
    summary: {}
  };
  els.banner.classList.add('hidden');
  render();
  startTicker(); // optimistic local state — keep the elapsed readout live

  try {
    await chrome.runtime.sendMessage({ type: 'ARB_START', query, pageLimit });
  } catch (e) {
    els.banner.innerHTML =
      '<span class="msg">Background worker is unavailable. Reload the extension on <b>chrome://extensions</b> and try again.</span>';
    els.banner.classList.remove('hidden');
    els.compare.disabled = false;
  }
}

async function forceParse() {
  const sites = ['amazon', 'ebay'].filter((s) => state && state.sites[s] && state.sites[s].status === 'error');
  if (!sites.length) return;
  for (const s of sites) {
    state.sites[s].status = 'loading';
    state.sites[s].error = null;
  }
  render();
  try { await chrome.runtime.sendMessage({ type: 'ARB_FORCE_PARSE', sites }); }
  catch (_) { /* background will push fresh state when it wakes */ }
}

async function openResults(site) {
  try { await chrome.runtime.sendMessage({ type: 'ARB_OPEN_RESULTS', site }); }
  catch (_) { /* ignore */ }
}

/** Reset all stored data and UI state back to pristine defaults. */
async function resetData() {
  // Clear all chrome.storage.local keys (comparison history, cached results, fee prefs, etc.)
  try {
    await chrome.storage.local.clear();
  } catch (e) {
    console.error('[popup] Failed to clear storage:', e);
  }

  // Reset local state reference
  state = null;

  // Hide all dynamic UI sections
  els.progressBox.classList.add('hidden');
  els.resultsBox.classList.add('hidden');
  els.banner.classList.add('hidden');
  els.readyHint.classList.remove('hidden');

  // Clear input fields
  els.q.value = '';
  els.feeRate.value = '13'; // default fee rate
  els.pageLimit.value = '3'; // default page limit

  // Reset chips to idle state
  els.chipEbay.classList.remove('busy', 'done', 'err');
  els.chipAmazon.classList.remove('busy', 'done', 'err');
  els.chipEbay.querySelector('.lbl').textContent = 'eBay: waiting';
  els.chipAmazon.querySelector('.lbl').textContent = 'Amazon: waiting';

  // Clear table rows and summary
  els.rows.innerHTML = '';
  els.summary.textContent = '';
  els.emptyState.classList.add('hidden');

  // Reset sort order to default
  sort = { key: 'profit', dir: 'desc' };
  markSortHeader();

  // Re-enable compare button
  els.compare.disabled = false;
  els.retry.classList.add('hidden');

  // Stop any running ticker
  stopTicker();

  // Show success toast
  showToast();
}

/** Display a temporary success toast notification. */
function showToast() {
  els.toast.classList.remove('hide');
  els.toast.classList.add('show');
  setTimeout(() => {
    els.toast.classList.remove('show');
    els.toast.classList.add('hide');
  }, 2000);
}

function rerenderFromConfig() {
  if (!state || state.phase !== 'done') return;
  if (!(sort.key === 'profit' || sort.key === 'margin' || sort.key === 'fees')) {
    // Sorting by a money column depends on the fee too.
    renderResults();
  }
  renderResults();
}

/* ==================================================================== *
 * Phase 2: eBay-URL → Amazon analyze flow (UI controller)             *
 * ====================================================================
 * State comes from the background via ARB_ANALYZE_STATE pushes; the popup
 * never computes the match itself. Profit math is available locally via
 * profit.js (self.ARBProfit) so settings changes re-render instantly
 * without re-scraping — same pattern as the fee % in the compare table.
 */
let analyzeState = null;
let analyzeTicker = null;

const ANALYZE_STEP_TEXT = {
  'fetching-ebay': 'Fetching eBay listing…',
  'searching-amazon': 'Matching on Amazon…',
  'calculating': 'Calculating profit…'
};
const ANALYZE_ERROR_LABELS = {
  blocked: 'bot check / CAPTCHA',
  timeout: 'timed out',
  'no-title': 'no readable title',
  'parse-failed': 'could not parse the page',
  closed: 'tab was closed',
  'no-results': 'no results found',
  'no-results-page': 'redirected to a non-search page',
  'no-query': 'page had no search query',
  'chrome-error': 'page failed to load (network error)'
};
const ANALYZE_ACTIVE_PHASES = ['fetching-ebay', 'searching-amazon', 'calculating'];

function stopAnalyzeTicker() {
  if (analyzeTicker) { clearInterval(analyzeTicker); analyzeTicker = null; }
}

function startAnalyzeTicker() {
  if (analyzeTicker) return;
  analyzeTicker = setInterval(() => {
    if (!(analyzeState && ANALYZE_ACTIVE_PHASES.includes(analyzeState.phase))) {
      stopAnalyzeTicker();
      return;
    }
    const s = Math.floor((Date.now() - (analyzeState.startedAt || Date.now())) / 1000);
    els.analyzeElapsed.textContent = `${s}s`;
  }, 1000);
}

/** Read + clamp the four quick-settings inputs into a settings object. */
function readAnalyzeSettings() {
  const num = (el, min, max, dflt) => {
    const v = parseFloat(el.value);
    if (!Number.isFinite(v)) return dflt;
    return Math.max(min, Math.min(max, v));
  };
  return {
    ebayFeeRate: num(els.anEbayFeeRate, 0, 40, 13.25),
    fixedFee: num(els.anFixedFee, 0, 5, 0.30),
    estimatedSalesTax: num(els.anSalesTax, 0, 15, 7),
    extraCostBuffer: num(els.anBuffer, 0, 50, 0),
    amazonPages: num(els.amazonPages, 1, 20, 3)
  };
}

function saveAnalyzeSettings(settings) {
  chrome.storage.local.set({ arbSettings: settings }).catch(() => {});
}

function applyAnalyzeSettings(settings) {
  if (!settings) return;
  if (settings.ebayFeeRate != null) els.anEbayFeeRate.value = settings.ebayFeeRate;
  if (settings.fixedFee != null) els.anFixedFee.value = settings.fixedFee;
  if (settings.estimatedSalesTax != null) els.anSalesTax.value = settings.estimatedSalesTax;
  if (settings.extraCostBuffer != null) els.anBuffer.value = settings.extraCostBuffer;
  if (settings.amazonPages != null) els.amazonPages.value = settings.amazonPages;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function confidenceInfo(c) {
  if (c == null) return { label: 'No match', cls: 'none' };
  const pct = Math.round(c * 100);
  if (pct >= 90) return { label: `${pct}% Match — High Confidence`, cls: 'high' };
  if (pct >= 75) return { label: `${pct}% Match — Possible Match`, cls: 'mid' };
  return { label: `${pct}% Match — Low Confidence`, cls: 'low' };
}

function setThumb(wrap, src, letter) {
  wrap.replaceChildren();
  if (src && /^https:\/\//.test(src)) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      wrap.replaceChildren(makeEl('span', 'ph', letter));
    });
    wrap.appendChild(img);
  } else {
    wrap.appendChild(makeEl('span', 'ph', letter));
  }
}

function renderAnalyzeChip(chipEl, name, stageStatus, stageError, hint) {
  const lbl = chipEl.querySelector('.lbl');
  chipEl.classList.toggle('busy', stageStatus === 'loading');
  chipEl.classList.toggle('done', stageStatus === 'done');
  chipEl.classList.toggle('err', stageStatus === 'error');
  if (stageStatus === 'loading') lbl.textContent = hint ? `${name}: loading… ${hint}` : `${name}: loading…`;
  else if (stageStatus === 'done') lbl.textContent = `${name}: done`;
  else if (stageStatus === 'error') lbl.textContent = `${name}: ${ANALYZE_ERROR_LABELS[stageError] || stageError}`;
  else lbl.textContent = `${name}: waiting`;
}

function renderAnalyze() {
  const st = analyzeState;
  const active = !!(st && ANALYZE_ACTIVE_PHASES.includes(st.phase));

  els.analyzeProgress.classList.toggle('hidden', !active);
  els.analyzeError.classList.toggle('hidden', !(st && st.phase === 'error'));
  els.analyzeResult.classList.toggle('hidden', !(st && st.phase === 'done' && st.match));
  els.analyzeBtn.disabled = active;
  els.ebayUrl.disabled = active;
  els.analyzeCancel.classList.toggle('hidden', !active);
  // "Analyze again" appears on failure — it re-runs the whole flow with the
  // same URL (the stage-level retry path stays available to power users via
  // ARB_ANALYZE_RETRY, but a full re-run is the safer default after CAPTCHAs).
  els.analyzeRetry.classList.toggle('hidden', !(st && st.phase === 'error'));

  if (!st) { stopAnalyzeTicker(); return; }

  if (active) {
    els.analyzeStep.textContent = ANALYZE_STEP_TEXT[st.phase] || 'Working…';
    startAnalyzeTicker();
  } else {
    stopAnalyzeTicker();
  }

  renderAnalyzeChip(els.chipStepEbay, 'eBay', st.stages.ebay.status, st.stages.ebay.error);
  const amz = st.stages.amazon;
  const amzHint = (amz.status === 'loading' && amz.pagesDone > 0 && Number.isInteger(amz.pagesPerSite))
    ? `page ${amz.pagesDone}/${amz.pagesPerSite}` : null;
  renderAnalyzeChip(els.chipStepAmazon, 'Amazon', amz.status, amz.error, amzHint);
  const profitStatus = st.phase === 'calculating' ? 'loading'
    : st.phase === 'done' && st.profit ? 'done' : 'idle';
  renderAnalyzeChip(els.chipStepProfit, 'Profit', profitStatus, null);
  if (st.phase === 'done' && !st.profit) {
    els.chipStepProfit.querySelector('.lbl').textContent = 'Profit: no match';
  }

  if (st.phase === 'error') {
    const um = (st.error && (st.error.userMessage || st.error.message)) || 'Something went wrong.';
    els.analyzeError.innerHTML = `<span class="msg">${escapeHtml(um)} Click <b>Analyze Product</b> to try again.</span>`;
  } else {
    els.analyzeError.innerHTML = '';
  }

  // Phase 3: blocked-stage recovery banner. failAnalyzeStage deliberately
  // keeps the blocked stage's tab OPEN — that tab is the CAPTCHA surface.
  const blockedStage = ['ebay', 'amazon'].find((s) =>
    st.stages[s].status === 'error' && st.stages[s].error === 'blocked');
  if (st.phase === 'error' && blockedStage) {
    const name = blockedStage === 'amazon' ? 'Amazon' : 'eBay';
    els.blockedRecoveryMsg.innerHTML =
      `<b>${name} requires verification.</b> Please complete the CAPTCHA in the opened tab, then click <b>Retry</b>.`;
    els.blockedRecovery.classList.remove('hidden');
  } else {
    els.blockedRecovery.classList.add('hidden');
  }

  if (st.phase === 'done' && st.match) renderAnalyzeResult();
}

function renderAnalyzeResult() {
  const st = analyzeState;
  const ep = st.ebayProduct || {};
  const best = (st.match && st.match.bestMatch) || null;

  /* ---- eBay side ---- */
  setThumb(els.anEbayThumb, ep.image, 'e');
  els.anEbayTitle.textContent = ep.title || '—';
  els.anEbayTitle.title = ep.title || '';
  els.anEbayPrice.textContent = ep.price != null ? ARBProfit.fmtUSD(ep.price) : '—';
  els.anEbayShip.textContent = ep.shippingLabel
    ? ` · ${ep.shippingLabel}`
    : (ep.shipping > 0 ? ` + ${ARBProfit.fmtUSD(ep.shipping)} ship` : '');
  const ebayHref = safeUrl(ep.url, 'ebay');
  els.anEbayLink.href = ebayHref || '#';
  els.anEbayLink.style.visibility = ebayHref ? 'visible' : 'hidden';

  /* ---- Amazon side ---- */
  if (best) {
    setThumb(els.anAmazonThumb, best.image, 'a');
    els.anAmazonTitle.textContent = best.title;
    els.anAmazonTitle.title = best.title;
    els.anAmazonPrice.textContent = best.price != null ? ARBProfit.fmtUSD(best.price) : '—';
    els.anAmazonPrime.classList.toggle('hidden', !best.isPrime);
    const amzHref = safeUrl(best.url, 'amazon');
    els.anAmazonLink.href = amzHref || '#';
    els.anAmazonLink.style.visibility = amzHref ? 'visible' : 'hidden';
  } else {
    setThumb(els.anAmazonThumb, null, 'a');
    els.anAmazonTitle.textContent = 'No confident match found';
    els.anAmazonTitle.title = '';
    els.anAmazonPrice.textContent = '—';
    els.anAmazonPrime.classList.add('hidden');
    els.anAmazonLink.style.visibility = 'hidden';
  }

  /* ---- Confidence badge ---- */
  const info = confidenceInfo(st.match.matched ? st.match.confidence : null);
  els.anConfidence.textContent = info.label;
  els.anConfidence.className = `conf ${info.cls}`;
  // On a no-match outcome the matcher's own warnings carry the actionable
  // detail ("Best candidate scored 43% (below the 60% threshold).") — show
  // them where the strategy label normally sits instead of hiding them.
  const matchWarns = (!st.match.matched && Array.isArray(st.match.warnings))
    ? st.match.warnings : [];
  els.anStrategy.textContent = matchWarns.length
    ? matchWarns.join(' ')
    : (st.match.strategy ? `via ${st.match.strategy}` : '');

  /* ---- All other candidates >= the 50% floor ---- */
  renderMatchesList(st, best);

  /* ---- Profit box (recomputed locally so settings edits are instant) ---- */
  let p = st.profit;
  if (ep && best) {
    // Recompute locally so quick-settings edits re-render instantly; the
    // inputs always carry values (HTML defaults + storage restore), so the
    // run's stored settings are only a fallback for a fresh profile.
    p = ARBProfit.calculateArbitrageProfit(
      { price: ep.price, shipping: ep.shipping },
      { price: best.price, shipping: best.shipping || 0, isPrime: !!best.isPrime },
      readAnalyzeSettings()
    );
  }
  if (p) {
    els.anNetProfit.textContent = ARBProfit.fmtUSD(p.netProfit);
    els.anNetProfit.className = 'p-value ' + (p.netProfit >= 0 ? 'pos' : 'neg');
    els.anRoi.textContent = p.roi != null ? fmtPct(p.roi) : '—';
    els.anRoi.className = 'p-value ' + ((p.roi || 0) >= 0 ? 'pos' : 'neg');
    els.anMargin.textContent = p.margin != null ? fmtPct(p.margin) : '—';
    els.anMargin.className = 'p-value ' + ((p.margin || 0) >= 0 ? 'pos' : 'neg');
    els.anBreakdown.innerHTML = p.breakdownLines.map(escapeHtml).join('<br/>');
    const warns = p.warnings || [];
    els.anProfitWarn.classList.toggle('hidden', !warns.length);
    els.anProfitWarn.textContent = warns.join(' ');
    els.anProfitBox.classList.remove('hidden');
  } else {
    els.anProfitBox.classList.add('hidden');
  }

  renderSafetyBox(st);
  renderManualMatch(st);
}

/**
 * Render every candidate that scored >= the 50% acceptance floor (the
 * matcher's `matches` list), minus the primary pick already shown in the
 * Amazon card. Rows link straight to the Amazon listing. Styling is inline
 * so the list needs no popup.css changes.
 */
function renderMatchesList(st, best) {
  const box = els.anMatches;
  if (!box) return;
  box.replaceChildren();
  const all = (st.match && Array.isArray(st.match.matches)) ? st.match.matches : [];
  const others = all.filter((m) => !best || !m.asin || m.asin !== best.asin);
  if (!others.length) { box.classList.add('hidden'); return; }

  const head = makeEl('div', '');
  head.textContent = `Other matches ≥ 50% (${others.length})`;
  head.style.cssText = 'font-size:11px;opacity:.7;margin:6px 2px 2px;text-transform:uppercase;letter-spacing:.04em;';
  box.appendChild(head);

  for (const m of others.slice(0, 9)) {
    const row = document.createElement('a');
    row.className = 'match-row';
    const href = safeUrl(m.url, 'amazon');
    row.href = href || '#';
    row.target = '_blank';
    row.rel = 'noopener';
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 2px;border-top:1px solid rgba(128,128,128,.2);text-decoration:none;color:inherit;';

    const thumb = makeEl('span', '');
    thumb.style.cssText = 'flex:0 0 28px;height:28px;border-radius:4px;background:rgba(128,128,128,.15);display:flex;align-items:center;justify-content:center;font-size:12px;overflow:hidden;';
    if (m.image && /^https:\/\//.test(m.image)) {
      const img = document.createElement('img');
      img.src = m.image;
      img.alt = '';
      img.loading = 'lazy';
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
      img.addEventListener('error', () => { thumb.textContent = 'a'; });
      thumb.appendChild(img);
    } else {
      thumb.textContent = 'a';
    }

    const mid = makeEl('span', '');
    mid.style.cssText = 'flex:1 1 auto;min-width:0;';
    const title = makeEl('div', '');
    title.textContent = m.title || m.asin || 'Amazon listing';
    title.title = title.textContent;
    title.style.cssText = 'font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    const price = makeEl('div', '');
    price.textContent = m.price != null ? ARBProfit.fmtUSD(m.price) : '—';
    price.style.cssText = 'font-size:11px;opacity:.8;';
    mid.append(title, price);

    const conf = makeEl('span', '');
    conf.textContent = `${Math.round((m.score || 0) * 100)}%`;
    conf.style.cssText = `flex:0 0 auto;font-size:11px;font-weight:600;color:${(m.score || 0) >= 0.75 ? '#1a7f37' : (m.score || 0) >= 0.6 ? '#9a6700' : '#8a8a8a'};`;

    row.append(thumb, mid, conf);
    box.appendChild(row);
  }
  box.classList.remove('hidden');
}

/* ------------------------------------------------------------------ *
 * Phase 3: safety harness (variation + quantity alerts)               *
 * ------------------------------------------------------------------ */

/**
 * Paint the safety box from the background's assessSafety() result. When the
 * background module is unavailable (defensive), fall back to a local pass so
 * the user still gets the warnings.
 */
function renderSafetyBox(st) {
  const box = els.anSafetyBox;
  if (!box) return;
  box.replaceChildren();

  let safety = st.safety || null;
  const ep = st.ebayProduct || {};
  const best = (st.match && st.match.bestMatch) || null;
  if (!safety && best && self.ARBSafety) {
    try { safety = self.ARBSafety.assessSafety(ep, best); } catch (_) { safety = null; }
  }
  if (!safety) return;

  if (!safety.alerts.length) {
    // Quiet green confirmation only when there was something worth checking.
    const hadVariation = safety.variation && safety.variation.hasVariation;
    if (hadVariation || safety.quantity && safety.quantity.level === 'ok' && (safety.quantity.ebayQuantity > 1 || safety.quantity.amazonQuantity > 1)) {
      box.appendChild(makeEl('div', 'safe-ok', '✓ Variation & quantity verified against the Amazon listing'));
    }
    return;
  }

  for (const alert of safety.alerts) {
    const div = document.createElement('div');
    div.className = `safety-alert ${alert.level}`;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = alert.level === 'hard' ? '⛔' : '⚠️';
    const txt = document.createElement('span');
    txt.textContent = alert.message;
    div.appendChild(icon);
    div.appendChild(txt);
    box.appendChild(div);
  }
}

/* ------------------------------------------------------------------ *
 * Phase 3: manual match correction (low-confidence fallback)          *
 * ------------------------------------------------------------------ */

function renderManualMatch(st) {
  const wrap = els.anManualMatch;
  if (!wrap) return;
  const conf = st.match && st.match.matched ? st.match.confidence : null;
  const show = st.match && (!st.match.matched ||
    (conf != null && Math.round(conf * 100) < CONFIDENCE_MANUAL_THRESHOLD));
  wrap.classList.toggle('hidden', !show);
  if (show) {
    els.anAsinInput.placeholder = st.manualMatch && st.manualMatch.asin
      ? `Currently overridden: ${st.manualMatch.asin} — paste another ASIN or /dp/ URL…`
      : 'Paste the verified Amazon ASIN or product URL…';
  }
}

async function applyManualMatch() {
  const input = els.anAsinInput.value.trim();
  if (!input) { els.anAsinInput.focus(); return; }
  // Client-side validation gives instant feedback; the background re-validates.
  try {
    self.ARBScout.validateAmazonAsin(input);
  } catch (err) {
    els.anExportHint.textContent = err.userMessage || 'That is not a valid Amazon ASIN or product URL.';
    els.anAsinInput.focus();
    return;
  }
  els.anExportHint.textContent = '';
  els.applyAsin.disabled = true;
  // Optimistic UI: show the Amazon stage as loading until the next push.
  if (analyzeState) {
    analyzeState.phase = 'searching-amazon';
    analyzeState.manualMatch = { asin: input, url: null, appliedAt: Date.now() };
    if (analyzeState.stages) {
      analyzeState.stages.amazon.status = 'loading';
      analyzeState.stages.amazon.error = null;
    }
    renderAnalyze();
  }
  try {
    await chrome.runtime.sendMessage({ type: 'ARB_ANALYZE_MANUAL_MATCH', input });
  } catch (_) {
    els.anExportHint.textContent = 'Background worker unavailable — reload the extension and try again.';
  } finally {
    els.applyAsin.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Phase 3: export — Copy Breakdown / Export CSV                       *
 * ------------------------------------------------------------------ */

/** Assemble the current analyze result into the export.js shape. */
function currentAnalyzeResult() {
  const st = analyzeState;
  if (!st || st.phase !== 'done') return null;
  const ep = st.ebayProduct || {};
  const best = (st.match && st.match.bestMatch) || null;
  if (!best) return null;

  // Recompute profit with the LIVE settings (same as the rendered card).
  const profit = ARBProfit.calculateArbitrageProfit(
    { price: ep.price, shipping: ep.shipping },
    { price: best.price, shipping: best.shipping || 0, isPrime: !!best.isPrime },
    readAnalyzeSettings()
  );

  let safety = st.safety || null;
  if (!safety && self.ARBSafety) {
    try { safety = self.ARBSafety.assessSafety(ep, best); } catch (_) { safety = null; }
  }

  return {
    ebayProduct: ep,
    amazonMatch: {
      title: best.title,
      price: best.price,
      shipping: best.shipping || 0,
      isPrime: !!best.isPrime,
      asin: best.asin || null,
      url: best.url || null,
      confidence: st.match.matched ? st.match.confidence : null
    },
    profit,
    safety
  };
}

async function copyBreakdown() {
  const result = currentAnalyzeResult();
  if (!result) {
    els.anExportHint.textContent = 'Nothing to copy — run an analyze first.';
    return;
  }
  const text = self.ARBExport.buildBreakdownText(result);
  try {
    await navigator.clipboard.writeText(text);
    els.anExportHint.textContent = 'Breakdown copied to clipboard ✓';
  } catch (_) {
    // Clipboard API can be denied in some popup contexts — fall back to a
    // hidden textarea + execCommand (deprecated but universally available).
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      els.anExportHint.textContent = 'Breakdown copied to clipboard ✓';
    } catch (_) {
      els.anExportHint.textContent = 'Copy failed — your browser blocked clipboard access.';
    }
  }
  setTimeout(() => { els.anExportHint.textContent = ''; }, 4000);
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportCsv() {
  const result = currentAnalyzeResult();
  if (!result) {
    els.anExportHint.textContent = 'Nothing to export — run an analyze first.';
    setTimeout(() => { els.anExportHint.textContent = ''; }, 4000);
    return;
  }
  const csv = self.ARBExport.buildCsv([result]);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsv(csv, `arbitrage-lead-${stamp}.csv`);
  els.anExportHint.textContent = 'CSV exported ✓';
  setTimeout(() => { els.anExportHint.textContent = ''; }, 4000);
}

/* ------------------------------------------------------------------ *
 * Phase 3: blocked-stage recovery actions                             *
 * ------------------------------------------------------------------ */

function blockedAnalyzeStage() {
  const st = analyzeState;
  if (!st) return null;
  return ['ebay', 'amazon'].find((s) =>
    st.stages && st.stages[s] && st.stages[s].status === 'error' && st.stages[s].error === 'blocked') || null;
}

async function focusBlockedTab() {
  const stage = blockedAnalyzeStage();
  if (!stage) return;
  try { await chrome.runtime.sendMessage({ type: 'ARB_ANALYZE_FOCUS_TAB', stage }); } catch (_) { /* ignore */ }
}

async function blockedRetry() {
  // Stage-level retry re-uses the (solved) tab session — the best recovery
  // path after a CAPTCHA. Falls back to a full re-run when no URL is known.
  try { await chrome.runtime.sendMessage({ type: 'ARB_ANALYZE_RETRY' }); }
  catch (_) { if (els.ebayUrl.value.trim()) await startAnalyze(); }
}

async function applyAnalyzeState(st) {
  // Coherence guard (mirrors applyState): an in-flight phase must have a
  // loading stage; anything else is a phantom and drops back to idle.
  const loading = st && ANALYZE_ACTIVE_PHASES.includes(st.phase);
  if (loading && !(st.stages && (st.stages.ebay.status === 'loading' || st.stages.amazon.status === 'loading'))) {
    analyzeState = null;
    renderAnalyze();
    return;
  }
  analyzeState = st;
  renderAnalyze();
}

async function startAnalyze() {
  const raw = els.ebayUrl.value.trim();
  if (!raw) { els.ebayUrl.focus(); return; }
  const settings = readAnalyzeSettings();
  saveAnalyzeSettings(settings);

  // Optimistic local state; authoritative pushes replace it.
  analyzeState = {
    runId: 'local', url: raw, phase: 'fetching-ebay', startedAt: Date.now(),
    settings,
    stages: {
      ebay: { status: 'loading', error: null, tabId: null },
      amazon: { status: 'idle', error: null, tabId: null }
    },
    ebayProduct: null, queryInfo: null, amazonResults: [], match: null, profit: null, error: null,
    manualMatch: null, safety: null
  };
  els.analyzeError.classList.add('hidden');
  renderAnalyze();

  try {
    await chrome.runtime.sendMessage({ type: 'ARB_ANALYZE', url: raw, settings });
  } catch (e) {
    analyzeState = null;
    renderAnalyze();
    els.analyzeError.innerHTML =
      '<span class="msg">Background worker is unavailable. Reload the extension on <b>chrome://extensions</b> and try again.</span>';
    els.analyzeError.classList.remove('hidden');
  }
}

async function cancelAnalyze() {
  analyzeState = null;
  renderAnalyze();
  try { await chrome.runtime.sendMessage({ type: 'ARB_ANALYZE_CANCEL' }); } catch (_) { /* ignore */ }
}

async function retryAnalyze() {
  // Full re-run with the same URL + current settings (robust after CAPTCHAs;
  // a stage-level retry would not survive an eBay session invalidation).
  if (els.ebayUrl.value.trim()) { await startAnalyze(); return; }
  try { await chrome.runtime.sendMessage({ type: 'ARB_ANALYZE_RETRY' }); } catch (_) { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function init() {
  // Restore saved fee %.
  chrome.storage.local.get('feeRate').then((res) => {
    if (res && res.feeRate != null) els.feeRate.value = res.feeRate;
  }).catch(() => {});

  // Restore saved page limit.
  chrome.storage.local.get('pageLimit').then((res) => {
    if (res && res.pageLimit != null) {
      const n = Math.floor(Number(res.pageLimit));
      if (Number.isFinite(n) && n >= 1 && n <= 20) {
        els.pageLimit.value = String(n);
      } else {
        els.pageLimit.value = '3';
      }
    }
  }).catch(() => {});

  els.compare.addEventListener('click', startCompare);
  els.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') startCompare(); });

  // Phase 2: analyze flow wiring.
  els.analyzeBtn.addEventListener('click', startAnalyze);
  els.ebayUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') startAnalyze(); });
  els.quickSettingsBtn.addEventListener('click', () => {
    els.quickSettings.classList.toggle('hidden');
  });
  els.analyzeCancel.addEventListener('click', cancelAnalyze);
  els.analyzeRetry.addEventListener('click', retryAnalyze);

  // Phase 3: safety / manual match / export / blocked recovery.
  if (els.applyAsin) els.applyAsin.addEventListener('click', applyManualMatch);
  if (els.anAsinInput) {
    els.anAsinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyManualMatch();
    });
  }
  if (els.copyBreakdown) els.copyBreakdown.addEventListener('click', copyBreakdown);
  if (els.exportCsv) els.exportCsv.addEventListener('click', exportCsv);
  if (els.focusBlockedTab) els.focusBlockedTab.addEventListener('click', focusBlockedTab);
  if (els.blockedRetry) els.blockedRetry.addEventListener('click', blockedRetry);

  // Restore saved analyze settings and keep them persisted + live.
  chrome.storage.local.get('arbSettings').then((res) => {
    if (res && res.arbSettings) applyAnalyzeSettings(res.arbSettings);
  }).catch(() => {});
  for (const input of [els.anEbayFeeRate, els.anFixedFee, els.anSalesTax, els.anBuffer]) {
    input.addEventListener('change', () => {
      saveAnalyzeSettings(readAnalyzeSettings());
      // Instant re-render of a finished run under the new settings (no re-scrape).
      if (analyzeState && analyzeState.phase === 'done') renderAnalyze();
    });
  }

  els.retry.addEventListener('click', forceParse);
  els.openEbay.addEventListener('click', () => openResults('ebay'));
  els.openAmazon.addEventListener('click', () => openResults('amazon'));
  els.reset.addEventListener('click', resetData);

  els.feeRate.addEventListener('change', () => {
    chrome.storage.local.set({ feeRate: els.feeRate.value }).catch(() => {});
    renderResults();
  });
  els.pageLimit.addEventListener('change', () => {
    const v = getPageLimit();
    els.pageLimit.value = String(v);
    chrome.storage.local.set({ pageLimit: v }).catch(() => {});
  });
  els.pageLimit.addEventListener('blur', () => {
    const v = getPageLimit();
    els.pageLimit.value = String(v);
  });
  els.hideNeg.addEventListener('change', renderResults);

  document.querySelectorAll('#table thead th').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sort.key === key) {
        sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sort.key = key;
        sort.dir = NUMERIC_KEYS.has(key) ? 'desc' : 'asc';
      }
      renderResults();
    });
  });

  // Live state pushes from background.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ARB_STATE' && msg.state) {
      applyState(msg.state);
    } else if (msg && msg.type === 'ARB_ANALYZE_STATE') {
      if (msg.state && msg.state.phase && msg.state.phase !== 'idle') {
        applyAnalyzeState(msg.state);
      } else {
        analyzeState = null; // cancelled
        renderAnalyze();
      }
    }
  });

  // Rehydrate an in-flight/finished analyze run after popup reopen.
  chrome.runtime.sendMessage({ type: 'ARB_ANALYZE_GET_STATE' })
    .then((res) => {
      if (!(res && res.ok && res.state && res.state.phase && res.state.phase !== 'idle')) return;
      if (res.state.url && !els.ebayUrl.value) els.ebayUrl.value = res.state.url;
      applyAnalyzeState(res.state);
    })
    .catch(() => { /* background asleep; it will push state on next event */ });

  // Ask for the current snapshot (covers popup reopen mid-run / after a run).
  // NOTE: this only ever RENDERS an existing in-flight run — it cannot start
  // one. A stale/phantom snapshot renders as the idle Ready state.
  chrome.runtime.sendMessage({ type: 'ARB_GET_STATE' })
    .then((res) => {
      if (!(res && res.ok && res.state)) return;
      if (res.state.phase !== 'idle') {
        els.q.value = res.state.query || els.q.value; // prefill from the run
      }
      applyState(res.state);
    })
    .catch(() => { /* background asleep; it will push state on next event */ });
}

init();
