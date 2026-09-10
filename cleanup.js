/*
 * cleanup.js — Phase 3: orphan-tab registry (belt & braces for MV3)
 * -----------------------------------------------------------------------------
 * Problem this solves:
 *   The orchestrator closes every scraping tab when its stage settles —
 *   success, failure, cancel, or tab-closed. But MV3 service workers are
 *   killed after ~30s idle, and Chrome may kill the worker BETWEEN a tab
 *   being created and any cleanup path running (watchdog setTimeouts die
 *   with the worker; alarms only fire ~1min later and were already cleared
 *   in the worst path). Result: an orphaned amazon/ebay tab that nobody
 *   will ever close.
 *
 * Mechanism:
 *   Every scraping tab is registered in chrome.storage.session under
 *   'arbOwnedTabs' the moment it is created. The orchestrator unregisters
 *   ids it closes itself; on every worker start (and on a periodic alarm
 *   while any tab is registered) it sweeps registered ids that no live
 *   stage still owns and closes them.
 *
 * Pure storage bookkeeping — no chrome.tabs calls here, so it can be unit
 * tested with a trivial storage shim. zero dependencies.
 */
'use strict';

(function arbCleanupModule() {

  const KEY = 'arbOwnedTabs';
  let mem = null; // in-memory mirror; authoritative copy is session storage

  async function readAll() {
    if (mem) return mem;
    try {
      const res = await chrome.storage.session.get(KEY);
      mem = (res && res[KEY] && typeof res[KEY] === 'object') ? res[KEY] : {};
    } catch (_) {
      mem = {};
    }
    return mem;
  }

  async function writeAll(map) {
    mem = map;
    try { await chrome.storage.session.set({ [KEY]: map }); } catch (_) { /* noop */ }
  }

  /**
   * Register a tab the extension opened for scraping. Idempotent.
   * @param {number} tabId
   * @param {object} [meta]  { site, stage, runId, openedAt }
   */
  async function registerScrapeTab(tabId, meta) {
    const id = Number(tabId);
    if (!Number.isFinite(id)) return;
    const map = await readAll();
    map[id] = Object.assign({ openedAt: Date.now() }, meta || {});
    await writeAll(map);
  }

  /**
   * Unregister a tab (after closing it, or when the user closed it first).
   * Idempotent; never throws for unknown ids.
   */
  async function unregisterScrapeTab(tabId) {
    const id = Number(tabId);
    if (!Number.isFinite(id)) return;
    const map = await readAll();
    if (!(id in map)) return;
    delete map[id];
    await writeAll(map);
  }

  /**
   * All currently-registered tab ids. The orchestrator subtracts the tabs
   * that live run/analyze state still needs, then closes the rest.
   * @returns {Promise<number[]>}
   */
  async function getOwnedScrapeTabs() {
    const map = await readAll();
    return Object.keys(map).map(Number).filter(Number.isFinite);
  }

  /** Test/edge hook: forget everything (e.g. after a full reset). */
  async function clearOwnedTabs() {
    mem = null;
    try { await chrome.storage.session.remove(KEY); } catch (_) { /* noop */ }
  }

  const ARBCleanup = { registerScrapeTab, unregisterScrapeTab, getOwnedScrapeTabs, clearOwnedTabs };

  if (typeof module !== 'undefined' && module.exports) module.exports = { ARBCleanup };
  if (typeof self !== 'undefined') {
    self.registerScrapeTab = ARBCleanup.registerScrapeTab;
    self.unregisterScrapeTab = ARBCleanup.unregisterScrapeTab;
    self.getOwnedScrapeTabs = ARBCleanup.getOwnedScrapeTabs;
    self.ARBCleanup = ARBCleanup;
  }

})();
