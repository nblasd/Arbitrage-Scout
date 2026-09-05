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
  openEbay: $('btnOpenEbay')
};

const fmtUSD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtPct = (n) => `${n >= 0 ? '' : '−'}${Math.abs(n).toFixed(1)}%`;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
let state = null; // last snapshot received from background
let sort = { key: 'profit', dir: 'desc' };

const ERROR_LABELS = {
  blocked: 'blocked (bot check / CAPTCHA)',
  timeout: 'timed out (30s ceiling)',
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
    case 'loading': return `${siteName}: loading…`;
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
    let step;
    if (amz.status === 'loading') {
      step = 'Step 1 of 2 — searching Amazon…';
    } else if (amz.status === 'done' && ebay.status === 'loading') {
      step = 'Step 2 of 2 — searching eBay & comparing…';
    } else {
      step = 'Comparing results…';
    }
    // The run is hard-bounded in the background (30s per stage), so a spinner
    // older than that is a stale optimistic state from before the worker
    // replied — tell the user instead of spinning silently.
    els.progressText.textContent = elapsed >= 60
      ? `${step} (${elapsed}s — still waiting; the run fails safely after its deadline)`
      : `${step} (${elapsed}s)`;
  } else {
    els.progressText.textContent = 'Done.';
  }

  renderChip(els.chipAmazon, els.chipAmazon.querySelector('.lbl'), 'Amazon', state.sites.amazon);
  renderChip(els.chipEbay, els.chipEbay.querySelector('.lbl'), 'eBay', state.sites.ebay);

  // "Parse again" appears whenever some site is in an error state.
  const anyError = ['amazon', 'ebay'].some((s) => state.sites[s].status === 'error');
  els.retry.classList.toggle('hidden', !anyError);

  renderBanner();
  renderResults();
}

function renderBanner() {
  const lines = [];
  for (const s of ['amazon', 'ebay']) {
    const st = state.sites[s];
    if (st.status === 'error') {
      const label = ERROR_LABELS[st.error] || st.error;
      if (st.error === 'blocked') {
        lines.push(`<b>${name}</b> served a bot check (${label}). ` +
          `The results tab is open in the background — solve the check there, then click <b>Parse again</b>.`);
      } else if (st.error === 'timeout') {
        lines.push(`<b>${name}</b> hit the 30s load ceiling (${label}). The page may be slow, or Amazon served a layout/bot check the parser did not recognize. Check the tab, then click <b>Parse again</b>.`);
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
 * has been silent for 40s (its own per-stage watchdog is 30s, so silence
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
    if (Date.now() - lastStateAt > 40000) {
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

function buildRow(p) {
  const v = rowValues(p);
  const tr = document.createElement('tr');

  // --- Product column (Amazon title, image, link) ---
  const tdProd = document.createElement('td');
  const prod = makeEl('div', 'prod');
  const img = p.amazon.image;
  if (img) {
    const im = document.createElement('img');
    im.src = img;
    im.alt = '';
    im.loading = 'lazy';
    im.addEventListener('error', () => im.remove());
    prod.appendChild(im);
  } else {
    prod.appendChild(makeEl('span', 'ph', (p.amazon.title[0] || '?').toUpperCase()));
  }
  const aTitle = makeEl('a', 't', p.amazon.title);
  aTitle.href = safeUrl(p.amazon.url, 'amazon') || '#';
  aTitle.target = '_blank';
  aTitle.rel = 'noopener';
  aTitle.title = p.amazon.title;
  prod.appendChild(aTitle);
  tdProd.appendChild(prod);
  tr.appendChild(tdProd);

  // --- Buy (Amazon price) ---
  const tdBuy = makeEl('td', 'money');
  tdBuy.textContent = p.amazon.price != null ? fmtUSD.format(v.buy) : '—';
  tr.appendChild(tdBuy);

  // --- eBay listing column ---
  const tdEbay = document.createElement('td');
  const ebayCell = makeEl('div', 'ebay-cell');
  const eTitle = makeEl('a', 't ellipsis', p.ebay.title);
  eTitle.href = safeUrl(p.ebay.url, 'ebay') || '#';
  eTitle.target = '_blank';
  eTitle.rel = 'noopener';
  eTitle.title = p.ebay.title;
  const matchLbl = makeEl('span', 'match', `title match ${p.sim}%`);
  ebayCell.appendChild(eTitle);
  ebayCell.appendChild(matchLbl);
  tdEbay.appendChild(ebayCell);
  tr.appendChild(tdEbay);

  // --- Sell, Fees, Profit, Margin ---
  const tdSell = makeEl('td', 'money');
  tdSell.textContent = fmtUSD.format(v.sell);
  tr.appendChild(tdSell);

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
  if (sum.amzTotal) detail.push(`${sum.amzTotal} Amazon`);
  if (sum.ebayTotal) detail.push(`${sum.ebayTotal} eBay`);
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
      text = 'eBay could not be parsed, so no comparisons were made. Amazon was searched successfully — try "Parse again" after fixing eBay.';
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

  // Optimistic local state so the UI responds instantly; the background's
  // authoritative ARB_STATE pushes will replace it as the run progresses.
  state = {
    runId: 'local',
    query,
    phase: 'searching',
    startedAt: Date.now(),
    sites: {
      amazon: { status: 'loading', items: [], error: null, tabId: null, url: null },
      ebay: { status: 'idle', items: [], error: null, tabId: null, url: null }
    },
    pairs: [],
    summary: {}
  };
  els.banner.classList.add('hidden');
  render();
  startTicker(); // optimistic local state — keep the elapsed readout live

  try {
    await chrome.runtime.sendMessage({ type: 'ARB_START', query });
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

function rerenderFromConfig() {
  if (!state || state.phase !== 'done') return;
  if (!(sort.key === 'profit' || sort.key === 'margin' || sort.key === 'fees')) {
    // Sorting by a money column depends on the fee too.
    renderResults();
  }
  renderResults();
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function init() {
  // Restore saved fee %.
  chrome.storage.local.get('feeRate').then((res) => {
    if (res && res.feeRate != null) els.feeRate.value = res.feeRate;
  }).catch(() => {});

  els.compare.addEventListener('click', startCompare);
  els.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') startCompare(); });

  els.retry.addEventListener('click', forceParse);
  els.openAmazon.addEventListener('click', () => openResults('amazon'));
  els.openEbay.addEventListener('click', () => openResults('ebay'));

  els.feeRate.addEventListener('change', () => {
    chrome.storage.local.set({ feeRate: els.feeRate.value }).catch(() => {});
    renderResults();
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
    }
  });

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
