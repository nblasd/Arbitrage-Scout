# Arbitrage Scout — Amazon ⇄ eBay price/profit comparator (MV3)

A Manifest V3 Chrome extension that searches the same product on **Amazon**
(where you'd buy) and **eBay** (where you'd sell), matches similar listings by
title, and shows an estimated resale profit after marketplace fees in a
sortable table.

```
┌──────────┐  ARB_START (query)   ┌──────────────┐  opens tab   ┌──────────────────┐
│  popup   │ ───────────────────▶ │  background  │ ───────────▶ │ amazon.com/s?k=… │
│ (UI)     │ ◀─────────────────── │ (service     │ ◀─ content ─ │ content.js parses│
│          │   ARB_STATE pushes   │  worker)     │    script    └──────────────────┘
└──────────┘                      └──────────────┘   opens tab   ┌──────────────────┐
                                        │           ───────────▶ │ ebay.com/sch/…   │
                                        │  matches + pairs       │ content.js parses│
                                        └──────▶ profit rows      └──────────────────┘
```

## Phase 1 — eBay-URL → Amazon match engine (`ebay2amazon.js`)

New (in progress) flow: paste an **eBay product URL**, get the **single best
Amazon match + confidence %**. The engine lives in one dependency-free module
loaded by the service worker via `importScripts`:

```
eBay URL
   │
   ▼
validateEbayUrl()          host allowlist + /itm/<id> extraction → canonical URL
   │                        errors: INVALID_URL / NOT_EBAY_ITEM
   ▼
extractEbayData(url)       fetch (real tab in Phase 2)
   │                       → title, price, shipping, condition, description,
   │                         item specifics (brand / MPN / model / UPC / EAN)
   │                       errors: FETCH_FAILED / TIMEOUT / PARSE_FAILED / NO_TITLE
   ▼
cleanTitleAndBuildQuery()  1. strip spam ("FAST FREE SHIPPING", "WOW GIFT", …)
   │                       2. extract bundle quantity ("2 Pack", "6PK", …)
   │                       3. build query by priority:
   │                            GTIN  →  brand+MPN  →  brand+model
   │                            fallback: top 4–6 value keywords
   │                       errors: NO_QUERY
   ▼
Amazon search (Phase 2 wiring — content.js tab flow reused as-is)
   │
   ▼
matchAmazonProduct()       scores the best of up to 80 aggregated candidates (sponsored blocks can
   │                       crowd the genuine match past rank 10):
   │                       title similarity (Jaccard+containment) 30%
   │                       identifier lock (GTIN/MPN/model)      35%
   │                       brand agreement 15% · type words 12% · pack size 8%
   │                       + unit-price tie-breaker, −0.45 pack mismatch,
   │                       +0.10 identifier+brand double lock
   ▼
{ matched, matchedAmazon, confidence 0–100, candidates[], warnings, error }
                           errors: NO_AMAZON_RESULTS / LOW_CONFIDENCE /
                                   QUANTITY_MISMATCH
```

All failures surface as `MatchError` with a stable `code` (`ARBScout.ERROR_CODES`)
and a ready-to-display `userMessage`.

## Phase 2 — Analyze flow: eBay URL → Amazon match → profit → popup card

Paste an eBay item URL in the popup, click **Analyze Product**, and get a
side-by-side comparison card with match confidence and a full profit
breakdown. The orchestration lives in `background.js` (message
`ARB_ANALYZE`); the UI section is the `analyze*` block in `popup.html`.

```
popup: eBay URL + quick settings (fee %, fixed fee, sales tax, buffer)
   │  ARB_ANALYZE
   ▼
background: startAnalyze()
   │  opens REAL tab → ebay.com/itm/<id>            (session cookies, no CORS)
   ▼
content-item.js: ARBScout.extractFromDocument(document)
   │  ARB_ITEM_DATA { title, price, shipping, specifics {brand,mpn,upc,…} }
   ▼
background: build the ordered query plan       →  buildAmazonSearchUrl()
   │  plan[0] = the EXACT eBay title, searched on Amazon as-is
   │  ("search the same title we found") — sanitized only for
   │  transport: whitespace collapsed, dangling quotes/parens/pipes
   │  stripped (only when unbalanced — "(2 Pack) …" and "… (Black)"
   │  survive), capped at Amazon's 250-char search-box limit
   │  plan[1+] = recovery tiers: cleanTitleAndBuildQuery() result,
   │  then up to 2 broader fallbacks (brand+model, first tokens)
   │  opens REAL tab → amazon.com/s?k=<exact eBay title>
   │  pagination loop: same tab walks &page=2…N ("Amazon pages" setting,
   │  default 3, ceiling 20; legacy pagesPerSite used when unset)
   │  aggregating up to 80 candidates; on 0 results it drops to the next
   │  tier of the plan in the SAME tab — the tab only ever closes at
   │  settle or after the whole plan is exhausted
   ▼
content.js: existing search scraper (+ isPrime, rating)
   │  ARB_RESULTS { items: [{asin, title, price, isPrime, rating, …}],
   │                 query, page }   ← page/query echo aligns each payload
   ▼
background: matchAmazonProduct()  →  calculateArbitrageProfit()
   │  ARB_ANALYZE_STATE { match {confidence, candidates, matches[]},
   │                      profit {netProfit, roi, margin, breakdownLines} }
   ▼
popup: comparison card + confidence badge + color-coded profit box,
       plus a list of ALL matches scoring ≥50% (match.matches[])
       (settings edits re-compute profit instantly — no re-scrape)
```

Every stage has a 60s watchdog + alarm failsafe (long enough to cover the
multi-page Amazon crawl and fallback queries — the tab is never closed on its
first payload), a tab-closed guard, and a structured error (`code` +
`userMessage`) shown in the popup with an **Analyze again** button. Amazon
CAPTCHAs are handled exactly like the keyword flow: solve the check in the
opened tab and re-run.

### Profit math (`profit.js`, user-configurable)

```
Revenue  = ebaySellPrice + ebayShippingCollected
Sourcing = (amazonBuyPrice + amazonShippingCost) × (1 + salesTax)   ← Prime ⇒ $0 ship
Fees     = Revenue × ebayFeeRate + fixedFee                          (default 13.25% + $0.30)
Net      = Revenue − Sourcing − Fees − extraCostBuffer
ROI      = Net / Sourcing      Margin = Net / Revenue
```

Defaults: 13.25% eBay fee, $0.30 fixed, 7% sales tax, $0 buffer — editable
in the popup's ⚙ Settings and persisted in `chrome.storage.local`.

## Phase 3 — Safety harness, resilience & production polish

Phase 3 hardens the analyze flow for real-world edge cases. All new logic is
pure (`safety.js`, `export.js`, `cleanup.js` — no DOM/chrome APIs) so it runs
in the service worker and the popup.

```
ebayProduct + matched amazonProduct
   │
   ▼
safety.js: assessSafety()                          (runs in background on finalize)
   ├─ Guard 1  evaluateVariationMismatch()
   │     eBay color/size/style/capacity words (title + ITEM SPECIFICS) vs the
   │     Amazon title; generic-parent Amazon titles ("Various Colors") flagged.
   │     SOFT ALERT:
   │       "Variation Alert: Verify color/size on Amazon before ordering."
   └─ Guard 2  checkQuantityAlignment()
         eBay bundleQuantity vs Amazon pack size (explicit field, else title).
         HARD ALERT:
           "Quantity Mismatch Detected — ROI calculation may be inaccurate."
   ▼
popup: red/yellow badges above the profit box
         + "Copy Breakdown" (clipboard) / "Export CSV" (spreadsheet-ready)
         + manual ASIN/URL override when confidence < 75%
```

### CAPTCHA & rate-limit recovery

- `content.js` / `content-item.js` detect bot-check pages and report
  `error: 'blocked'` instead of hanging.
- `background.js` keeps the blocked stage's tab **open** (it is the recovery
  surface) and the popup shows:
  *"Amazon requires verification. Please complete the CAPTCHA in the opened
  tab and click Retry."* **Focus tab** opens the CAPTCHA tab, **Retry**
  re-navigates the same tab (reusing the solved session); **Analyze Product**
  restarts from scratch.
- Timeouts arm a per-stage watchdog (`ITEM_STAGE_TIMEOUT_MS`) plus an alarm
  failsafe that survives worker kills; both fail the stage cleanly instead of
  spinning forever.

### Orphan-tab cleanup (no tab left behind)

- Every scraping tab is registered the moment it opens
  (`cleanup.js` → `chrome.storage.session` `arbOwnedTabs`).
- `closeOwnedTab()` closes *and* unregisters on every settle path: success,
  failure, timeout, cancel, and the tab-closed event (`tabs.onRemoved`).
- `sweepOrphanTabs()` runs on every worker (re)start and on a periodic alarm
  while any tab is registered — it closes anything registered that no live
  stage owns, so a worker killed mid-stage can never leak a tab.

### Manual match correction (fallback for low confidence)

When automatic confidence is **< 75%** (or no match was accepted), the popup
shows a field to paste a verified **ASIN** or **Amazon product URL**.
`background.js` validates it (`ARBScout.validateAmazonAsin`), opens the exact
`/dp/<ASIN>` page, and `content.js` now parses *product pages* (buybox price,
title, Prime) and reports them as a one-item result — profit, ROI and safety
alerts are then recomputed against the listing the user actually verified.

### Export (log your leads)

`export.js` normalizes either flow's result into one stable row:
`buildBreakdownText()` (multi-line clipboard paste) and `buildCsv()` (RFC-4180:
CRLF lines, quoted cells, safety alerts included). The popup buttons load the
file (``arbitrage-lead-YYYY-MM-DD.csv``) or the clipboard directly.

## Files

| File             | Role |
|------------------|------|
| `manifest.json`  | MV3 manifest: `storage`, `tabs`, `alarms`, `scripting` permissions; content-script registration for Amazon/ebay search pages. No remote code → default CSP is fine. |
| `content.js`     | Runs on the real Amazon/eBay search-result pages in real tabs. Waits with random human-like delays, scrolls gently, then extracts listings with **cascading selector fallbacks** ending in a generic anchor scan. Reports `ARB_RESULTS`. **Phase 3:** detects CAPTCHA/bot-check pages (reports `blocked`), and parses Amazon `/dp/` product pages (buybox) for the manual-ASIN override. |
| `background.js`  | MV3 service worker orchestrator. Opens one marketplace tab at a time, collects scrape results, watchdog-timeouts stuck stages via `chrome.alarms`, persists run state in `chrome.storage.session` (survives worker restarts), and pairs items with greedy title-similarity matching. Also loads `ebay2amazon.js` via `importScripts` for the Phase-1 engine. **Phase 3:** analyze-flow stages with blocked-tab CAPTCHA recovery, `ARB_ANALYZE_MANUAL_MATCH` (ASIN/URL override), and `closeOwnedTab`/`sweepOrphanTabs` guaranteeing zero orphaned tabs. |
| `matcher.js`     | Multi-signal pairing engine (attributes, hard-conflict detection, category awareness) layered over title similarity for the keyword-comparison flow. Drop-in: `importScripts` + replace `computePairs` with `ARBMatcher.buildPairs`. |
| `ebay2amazon.js` | **Phase 1 engine:** `validateEbayUrl` → `extractEbayData` (eBay item data) → `cleanTitleAndBuildQuery` (spam strip, bundle detection, query build) → `matchAmazonProduct` (confidence-scored Amazon match). Zero dependencies, environment-agnostic (service worker). Also `buildAmazonSearchUrl` for Phase 2. |
| `profit.js` | **Phase 2 profit engine:** `calculateArbitrageProfit(ebay, amazon, settings)` — revenue/sourcing/fees/net/ROI/margin with user-configurable rates, Prime-aware shipping, warning strings and human-readable breakdown lines. Pure math (worker + popup + Node). |
| `content-item.js` | **Phase 2:** runs on `ebay.com/itm/*` pages, reuses the Phase-1 extractor to parse the open listing, reports `ARB_ITEM_DATA`. Same run-token/anti-hang pattern as `content.js`. |
| `safety.js`   | **Phase 3 safety harness:** `detectVariationMismatch` (color/size/style/capacity guard + generic-parent-asin detection) and `checkQuantityAlignment` (multipack vs single-unit hard alert). Pure logic, environment-agnostic. |
| `cleanup.js`  | **Phase 3 orphan-tab registry:** `registerScrapeTab` / `unregisterScrapeTab` / `getOwnedScrapeTabs` in `chrome.storage.session` — the data layer behind `sweepOrphanTabs()` in `background.js`. |
| `export.js`   | **Phase 3 lead export:** `buildBreakdownText` (clipboard paste) and `buildCsv` (RFC-4180 spreadsheet rows with safety alerts). Pure logic. |
| `popup.html`     | Popup UI: search box + Compare button, progress chips, error banner, sortable results table, fee-% control. **Phase 3:** safety-badge box, blocked-CAPTCHA banner, manual ASIN/URL override, Copy Breakdown / Export CSV buttons. Styles inlined; **no inline scripts** (CSP-safe). |
| `popup.js`       | Popup controller: renders state pushes, computes fees/profit/margin from the current fee % client-side, sorts on header click. **Phase 3:** paints safety alerts, blocked-recovery actions, manual-match recalculate and CSV/clipboard export. |

## Why it works this way

- **Real tabs, not `fetch()`.** A popup/service-worker `fetch()` to
  amazon.com/ebay.com triggers far stronger bot detection than a real tab and
  is also subject to CORS. The extension opens *actual background tabs* with
  your real session, and `content.js` only parses pages that are genuinely
  open. This is also far more maintainable than HTML parsing done remotely.
- **Human-like pacing ≠ evasion.** The random waits/scrolls in `content.js`
  are rate-limit courtesy and can be turned down/up in its `CFG` block. They do
  **not** defeat CAPTCHAs. Amazon in particular will still block automated
  access periodically; the UI tells you, and **"Parse again"** re-runs the
  parser after you solve the check in the open tab.
- **Resilient selectors.** Each extractor tries several DOM strategies in
  order (`li.s-item` classic river → card grid → generic `/itm/` anchor scan on
  eBay; `[data-component-type="s-search-result"]` → generic `/dp/` anchor scan
  on Amazon). When Amazon/eBay change classes, only the selector lists need
  editing — the item model, matcher and UI stay untouched.
- **State survives popup closes / worker restarts.** Everything lives in
  `chrome.storage.session`, so reopening the popup mid-run restores progress.

## Load the extension (local test)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `arbitrage-scout/` folder.
4. Pin the extension (puzzle icon → 📌 next to "Arbitrage Scout").
5. Open the popup, type a product (e.g. `stanley 40 oz quencher`), click
   **Compare**.

### Expected behavior

1. A background tab opens on `amazon.com/s?k=…`. The popup shows
   *"Step 1 of 2 — searching Amazon…"* and the Amazon chip turns to a spinner.
2. After a few seconds `content.js` reports the parsed items; the chip shows
   *"Amazon: 24 items"*.
3. A second background tab opens on `ebay.com/sch/i.html?_nkw=…`.
4. When eBay reports, the worker matches titles, and the table appears with
   rows sorted by estimated profit (descending). Click any column header to
   sort; toggle **Profitable only**; adjust **Fee %** to see numbers change
   instantly (no re-scrape).

### If nothing appears

- **CAPTCHA / bot check:** the tab opens anyway. Solve the check in the tab,
  then click **Parse again** in the popup. If the tab predates the extension
  install, background injects `content.js` automatically.
- **Timed out:** the popup shows the elapsed timer; the run fails safely at its
  deadline instead of spinning forever. The 30s per-stage watchdog in the
  background (plus a 2-minute alarm failsafe in case Chrome killed the service
  worker) marks the stage as timed out and moves the run on. Click **Parse
  again** after checking the tab.
- **Layout changed:** open the marketplace tab, right-click → Inspect, and
  check the result-item DOM. Update the selector lists in `content.js`
  (`amazonContainers` / `parseAmazonNode` and `ebayContainers` /
  `parseEbayNode`), then click the extension's **↻ Reload** on
  `chrome://extensions` and retry.
- **Tab closes instantly / stage fails for no visible reason:** click
  **Copy Debug Log** at the bottom of the popup. That copies the background's
  tagged event ring (last 300 events) to your clipboard: `RUN_START`, every
  tab navigation (`NAV`), each accepted page payload (`PAGE_RESULT`), dropped
  messages (`DROP` + reason), stage failures (`STAGE_FAIL` + reason), and
  every `TAB_CLOSE` attributed to its owning stage and the exact code
  call-site. The content script also prints a `[ARBScout:DBG] PAGE`
  classification line (URL, is-search/product, query, readyState) in the
  marketplace tab's own console — together these pinpoint the exact
  instant-close cause (redirect, empty query, foreign-tab drop, timeout).

## Tuning knobs

| Where | What |
|---|---|
| `content.js` → `CFG` | Pacing delays, scroll simulation, max items per site. |
| `background.js` → `MATCH_THRESHOLD` | Min title similarity (0–1) for a pair; lower = looser matches, higher = stricter. `STOPWORDS` tweak matching vocabulary. |
| `background.js` → `SEARCH_URLS` | Marketplace search URLs. |
| `background.js` → `STAGE_TIMEOUT_MS` (30s) + 2-min alarm failsafe | Stage watchdog timeout. |
| `manifest.json` | Add regional TLDs (`amazon.co.uk`, `ebay.co.uk`, …) to `host_permissions` + `content_scripts` **and** handle non-USD currency in `content.js` (`parseEbayPrice` already skips non-USD money). |
| popup **Fee %** | Default 13% (eBay final-value fee ≈13.25% for most categories; actual rate varies by category, store, and whether fees apply to shipping/tax). |
| popup **⚙ Settings** (analyze flow) | `ebayFeeRate` (13.25%), `fixedFee` ($0.30), `estimatedSalesTax` (7%), `extraCostBuffer` ($0) — persisted in `chrome.storage.local`, applied live to the result card. |
| `background.js` → `ANALYZE_MAX_AMAZON_ITEMS` | Cap on Amazon candidates scored per analyze run (default 10). |
| `background.js` → `DEFAULT_ANALYZE_SETTINGS` | Fallback profit settings when the popup sends none. |
| `popup.js` → `CONFIDENCE_MANUAL_THRESHOLD` | Below this confidence % (default 75) the popup shows the manual ASIN/URL override. |
| `background.js` → `TAB_SWEEP_MINUTES` (5) | Orphan-tab sweep alarm period while any scrape tab is registered. |
| `safety.js` → descriptor word lists | `COLOR_WORDS` / `SIZE_WORDS` / `STYLE_WORDS` / `CAPACITY_RE` — add/remove variation vocabulary without touching the guards. |

## Final verification checklist (all 3 phases — ready for local unpacking)

| # | Phase 1 — eBay→Amazon match engine | Status |
|---|------------------------------------|--------|
| 1.1 | `validateEbayUrl` accepts canonical/slug/mobile/bare-id URLs, rejects non-eBay/garbage | ✅ |
| 1.2 | `extractEbayData` / `extractFromDocument` extract title, price, shipping, condition, description, item specifics (brand/MPN/model/UPC/EAN), bundle `quantity` | ✅ |
| 1.3 | `cleanTitleAndBuildQuery` strips spam, lifts multipacks, builds GTIN → brand+MPN → brand+model → keyword queries | ✅ |
| 1.4 | `matchAmazonProduct` scores ≥ threshold, back-compat flat-item shape, unit-price tie-breaker, candidate cap, `QUANTITY_MISMATCH` rejection | ✅ |
| 1.5 | Every failure surfaces a stable `MatchError.code` + `userMessage` | ✅ |

| # | Phase 2 — Analyze flow & profit | Status |
|---|---------------------------------|--------|
| 2.1 | Popup → `ARB_ANALYZE` → background opens real eBay item tab → `content-item.js` parses → Amazon search tab → match → profit card | ✅ |
| 2.2 | `profit.js` math: Revenue − (Buy+Ship)×(1+tax) − Revenue×rate − fixed − buffer; ROI & margin; Prime ⇒ $0 ship if unspecified; settings clamped; warnings for missing money | ✅ |
| 2.3 | Analyze state survives worker restarts (`chrome.storage.session`); popup rehydrates on reopen | ✅ |
| 2.4 | Per-stage watchdog (timer + alarm failsafe) → fail cleanly, never spin forever; tab-closed guard | ✅ |
| 2.5 | Live re-computation when the popup ⚙ settings change (no re-scrape) | ✅ |

| # | Phase 3 — Safety, resilience & production polish | Status |
|---|--------------------------------------------------|--------|
| 3.1 | **Variation guard**: eBay color/size/style/capacity words (+ ITEM SPECIFICS) not present on the matched Amazon title — or a generic-parent Amazon title — raises the exact soft alert `Variation Alert: Verify color/size on Amazon before ordering.` | ✅ |
| 3.2 | **Quantity guard**: eBay pack count vs Amazon unit count mismatch raises the hard `Quantity Mismatch Detected — ROI calculation may be inaccurate.` badge; explicit Amazon `quantity` field wins over title parsing; storage strings (`128GB`) never misread as packs | ✅ |
| 3.3 | **CAPTCHA/block handling**: `content.js` + `content-item.js` report `blocked`; `background.js` keeps the recovery tab open; popup shows `*…requires verification. Please complete the CAPTCHA in the opened tab and click Retry.*` with Focus-tab and Retry actions | ✅ |
| 3.4 | **Orphan-tab cleanup**: every scrape tab registered on open (`cleanup.js`), closed+unregistered on success/failure/timeout/cancel/`onRemoved`, plus `sweepOrphanTabs()` on worker restart and a periodic alarm — zero orphans | ✅ |
| 3.5 | **Export**: `Copy Breakdown` (clipboard text) and `Export CSV` (RFC-4180, one row per lead incl. safety alerts) | ✅ |
| 3.6 | **Manual match correction**: pasted ASIN or `/dp/` URL is validated (`ASIN_INVALID` guard), re-opened as a real product page, buybox-parsed by `content.js`, and profit/safety recomputed on the exact listing | ✅ |
| 3.7 | Syntax-check clean (`node --check` on every JS file, incl. the matcher fix) | ✅ |

**Ship it:** load `manifest.json` via `chrome://extensions → Load unpacked` on
Chrome 102+. Remember: personal, low-volume, educational use only — scraping
violates the marketplaces' ToS, and CAPTCHAs cannot (and should not) be
bypassed. Prefer the official Amazon/eBay APIs for anything production-grade.

## Compliance & honesty notes (read before shipping this)

- Scraping Amazon/eBay **violates their Terms of Service**, and Amazon
  actively enforces against it (CAPTCHAs, account throttling). Use this only
  for **personal, low-volume, educational** exploration. Do not sell or
  redistribute scraped data; respect `robots.txt`, rate limits and data
  protection law.
- For anything production-grade, use the **official APIs** (Amazon Product
  Advertising API / SP-API, eBay Browse & Finding APIs) — they are legal,
  stable, and this code's matching/margin math ports over almost unchanged.
- Profit numbers are **estimates**: no shipping, returns, ad costs, sales tax,
  payment fees (≈$0.30/order), or eBay's variable-category fee adjustments.
- The matcher is greedy title-similarity — it can mis-pair visually similar
  but different SKUs. Verify each listing before buying.

Requires Chrome **102+** (for `chrome.storage.session`).
