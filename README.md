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

## Files

| File             | Role |
|------------------|------|
| `manifest.json`  | MV3 manifest: `storage`, `tabs`, `alarms`, `scripting` permissions; content-script registration for Amazon/ebay search pages. No remote code → default CSP is fine. |
| `content.js`     | Runs on the real Amazon/eBay search-result pages in real tabs. Waits with random human-like delays, scrolls gently, then extracts listings with **cascading selector fallbacks** ending in a generic anchor scan. Reports `ARB_RESULTS`. |
| `background.js`  | MV3 service worker orchestrator. Opens one marketplace tab at a time, collects scrape results, watchdog-timeouts stuck stages via `chrome.alarms`, persists run state in `chrome.storage.session` (survives worker restarts), and pairs items with greedy title-similarity matching. |
| `popup.html`     | Popup UI: search box + Compare button, progress chips, error banner, sortable results table, fee-% control. Styles inlined; **no inline scripts** (CSP-safe). |
| `popup.js`       | Popup controller: renders state pushes, computes fees/profit/margin from the current fee % client-side, sorts on header click. |

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

## Tuning knobs

| Where | What |
|---|---|
| `content.js` → `CFG` | Pacing delays, scroll simulation, max items per site. |
| `background.js` → `MATCH_THRESHOLD` | Min title similarity (0–1) for a pair; lower = looser matches, higher = stricter. `STOPWORDS` tweak matching vocabulary. |
| `background.js` → `SEARCH_URLS` | Marketplace search URLs. |
| `background.js` → `STAGE_TIMEOUT_MS` (30s) + 2-min alarm failsafe | Stage watchdog timeout. |
| `manifest.json` | Add regional TLDs (`amazon.co.uk`, `ebay.co.uk`, …) to `host_permissions` + `content_scripts` **and** handle non-USD currency in `content.js` (`parseEbayPrice` already skips non-USD money). |
| popup **Fee %** | Default 13% (eBay final-value fee ≈13.25% for most categories; actual rate varies by category, store, and whether fees apply to shipping/tax). |

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
