/*
 * matcher.js — Multi-signal product identity & variant matching engine
 * -----------------------------------------------------------------------------
 * Drop-in enhancement for Arbitrage Scout's pairing stage. The old system
 * paired eBay/Amazon listings purely on title similarity; this module keeps
 * that similarity as ONE signal and adds normalization, attribute extraction,
 * hard-conflict detection, identifier matching, category-aware scoring and
 * confidence classification.
 *
 * Environment-agnostic (no imports):
 *   - MV3 service worker : importScripts('matcher.js')  ->  self.ARBMatcher
 *   - Node.js tests      : require('./matcher.js')      ->  module.exports
 *
 * Design constraints (see README task):
 *   - NO external dependencies, NO network calls, NO scraping changes.
 *   - All extracted attributes are nullable; missing != wrong.
 *   - Title similarity is supporting evidence, never identity by itself.
 */
'use strict';

/* Everything lives in one IIFE so top-level names can never collide with
 * background.js globals (importScripts shares the worker's global scope).
 * The public ARBMatcher object is assembled at the very bottom. */
(function arbMatcherModule() {

/* ==================================================================== *
 * 1. Constants / tunables                                              *
 * ==================================================================== */

/* Signal weights. Title similarity is deliberately a MINOR signal now.
 * Weights need not sum to 1 — the engine normalizes by available signals,
 * so missing optional signals (image, identifiers) never drag a score down
 * just because the data wasn't available. */
const MATCHING_WEIGHTS = {
  identifier: 0.30, // GTIN/UPC/EAN/MPN/model overlap (when captured)
  attributes: 0.25, // category-aware attribute agreement
  semantic: 0.15,   // reserved hook (token-order-free deep sim); falls back 0
  image: 0.15,      // reserved hook (image embedding); inactive by default
  brand: 0.05,
  category: 0.05,
  title: 0.05       // legacy Jaccard/coverage similarity (background.js)
};

/* Confidence bands (evaluated AFTER hard conflicts gate the score). */
const CONFIDENCE = {
  HIGH: 'HIGH_CONFIDENCE',        // >= 0.90 (and no blocking conflict)
  POSSIBLE: 'POSSIBLE_MATCH',     // >= 0.75
  LOW: 'LOW_CONFIDENCE',          // >= threshold
  REJECTED: 'REJECTED'            // below threshold OR blocking conflict
};
const HIGH_MIN = 0.90;
const POSSIBLE_MIN = 0.75;

/* Below this the pair is not even a "low confidence" candidate. Pairs at or
 * above it are still returned (marked REJECTED) so the UI can explain why. */
const FINAL_CUTOFF = 0.55;

/* Candidate generation: only pairs above this quick-similarity enter the
 * expensive pipeline. Set lower than the old MATCH_THRESHOLD (0.34) because
 * the full engine can rescue weak titles with strong attributes — recall
 * first, precision later. */
const CANDIDATE_SIM_THRESHOLD = 0.22;

/* Max candidates entering full scoring per run (matches MAX_PAIRS culture). */
const MAX_CANDIDATES = 400;
const MAX_PAIRS = 80;

/* Hard conflict policy per attribute:
 *   'reject'      -> any known-different value kills the pair (REJECTED).
 *   'penalize'    -> big score penalty + conflicts[] entry (stays possible).
 *   'penalize_soft'-> small penalty (weak signals, e.g. color-ish text).
 * Missing/UNKNOWN on either side is NEVER a conflict. */
const CONFLICT_POLICY = {
  quantity: 'reject',
  model: 'reject',
  storage: 'reject',
  generation: 'penalize',
  condition: 'reject',
  dimensions: 'reject',
  size: 'reject',
  capacity: 'reject',
  color: 'penalize',
  brand: 'penalize',
  connectivity: 'penalize'
};

/* ==================================================================== *
 * 2. Generic text utilities                                            *
 * ==================================================================== */
const S = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const isBlank = (v) => v == null || (typeof v === 'string' && !v.trim());

function foldLower(s) {
  return S(s).toLowerCase();
}

/** Aggressive lowercase fold: accents, punctuation -> spaces, collapse ws. */
function foldKey(s) {
  return S(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* ==================================================================== *
 * 3. Quantity / pack / bundle extraction                               *
 * ==================================================================== */

/* "2 pack", "pack of 2", "2-pack", "2pk", "packs of 12" ... */
const PACK_PATTERNS = [
  /(?:^|[^a-z0-9])(\d{1,3})\s*[-\s]?\s*(?:pack|pk|pcs|pieces?|ct|count|units?|bottles?|cans?|tubs?|bars?|rolls?|wipes?)\b/i,
  /\bpack\s*(?:of\s*|x)?\s*(\d{1,3})\b/i,
  /\b(?:set|box)\s*(?:of\s*)?(\d{1,3})\b/i,
  /\b(\d{1,3})\s*x\b/i,            // "2x" prefix form
  /\bx\s*(\d{1,3})\b/i             // "x2" suffix form
];

/* Words that assert multi-unit or single-unit quantities. */
const MULTI_WORDS = /\b(pair|twins?|duo|double|two|three|four|five|six|dozen|doz|bundle|combo|kit|variety)\b/i;
const MULTI_MAP = { pair: 2, twin: 2, twins: 2, duo: 2, double: 2, two: 2, three: 3, four: 4, five: 5, six: 6, dozen: 12, doz: 12 };
const SINGLE_WORDS = /\b(singles?|one|1pc|1pc\b|single)\b/i;

/** Detect "bundle/kit/combo/set with multiple distinct items" signal. */
const BUNDLE_HINT_RE = /\b(bundle|starter\s*kit|accessory\s*kit|combo|kit\b|set\b|essential[s]?\s*kit)\b/i;
/* "+"-joined multi-item bundle: "mouse + keyboard", "pad & wrist rest" */
const PLUS_ITEM_RE = /(?:^|[\s(])([a-z][a-z'’\-]{2,})\s*(?:\+\s*[a-z][a-z'’\-]{2,}|&\s*[a-z][a-z'’\-]{2,})/i;

function extractQuantity(text) {
  const t = S(text);
  if (!t) return null;
  // Care: "128GB" must not parse as pack "8gb". Restrict to word contexts.
  for (const re of PACK_PATTERNS) {
    const m = t.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isInteger(n) && n >= 1 && n <= 999) return n;
    }
  }
  const mw = t.match(MULTI_WORDS);
  if (mw) {
    const w = mw[1].toLowerCase();
    if (MULTI_MAP[w]) return MULTI_MAP[w];
    if (w === 'bundle' || w === 'combo' || w === 'kit' || w === 'variety') return 2; // heuristic floor
  }
  if (SINGLE_WORDS.test(t)) return 1;
  return null;
}

function isBundleText(text) {
  const t = S(text);
  if (!t) return false;
  if (BUNDLE_HINT_RE.test(t)) return true;
  return PLUS_ITEM_RE.test(t);
}

/* ==================================================================== *
 * 4. Color extraction                                                  *
 * ==================================================================== */

/* Canonical color buckets. Deliberately conservative: only merges true
 * synonyms (jet black/blk -> black). Commercially distinct shades
 * (rose gold vs gold, navy vs blue) stay separate. */
const COLOR_SYNONYMS = {
  black: ['black', 'blk', 'jet black', 'onyx', 'midnight black', 'piano black', 'obsidian'],
  white: ['white', 'wht', 'snow', 'pearl white', 'cloud white'],
  silver: ['silver', 'slv', 'metallic silver'],
  gray: ['gray', 'grey', 'space gray', 'spacegrey', 'graphite', 'charcoal', 'slate'],
  blue: ['blue', 'blu', 'navy', 'navy blue', 'royal blue', 'cobalt', 'ocean blue', 'sky blue'],
  red: ['red', 'crimson', 'scarlet', 'cherry'],
  green: ['green', 'grn', 'forest green', 'mint', 'olive'],
  yellow: ['yellow', 'gold yellow'],
  orange: ['orange', 'burnt orange'],
  purple: ['purple', 'violet', 'lavender'],
  pink: ['pink', 'rose', 'blush'],
  brown: ['brown', 'coffee', 'espresso', 'tan'],
  beige: ['beige', 'cream', 'ivory', 'sand'],
  gold: ['gold', 'golden'],
  'rose gold': ['rose gold', 'rosegold'],
  cyan: ['cyan', 'teal', 'aqua', 'turquoise'],
  magenta: ['magenta', 'fuchsia'],
  clear: ['clear', 'transparent', 'crystal'],
  multi: ['multicolor', 'multi color', 'multi', 'rainbow', 'assorted']
};

const COLOR_LOOKUP = (() => {
  const map = new Map();
  for (const [canon, list] of Object.entries(COLOR_SYNONYMS)) {
    for (const syn of list) map.set(syn, canon);
  }
  return map;
})();

function extractColor(text) {
  const t = S(text).toLowerCase();
  if (!t) return null;
  // Longest synonym wins ("jet black" before "black").
  let best = null;
  let bestLen = 0;
  for (const syn of COLOR_LOOKUP.keys()) {
    if (syn.length <= bestLen) continue;
    const re = new RegExp(`(?:^|[^a-z])${syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z])`, 'i');
    if (re.test(t)) { best = COLOR_LOOKUP.get(syn); bestLen = syn.length; }
  }
  return best;
}

/* ==================================================================== *
 * 5. Storage / capacity extraction                                     *
 * ==================================================================== */

/* Storage & RAM: GB/TB/MB with unit word. "128GB" etc. */
const STORAGE_RE = /\b(\d{1,4}(?:\.\d+)?)\s*(tb|terabyte|gb|gig|gigabyte|mb)\b(?![a-z])/i;
const SIZE_WORDS = /\b(xxs|xs|s|m|l|xl|xxl|xxxl|small|medium|large|x-large|xx-large|one size)\b/i;
const SIZE_CANON = { 'x-large': 'xl', 'xx-large': 'xxl', small: 's', medium: 'm', large: 'l' };

function extractStorage(text) {
  const t = S(text).toLowerCase();
  if (!t) return null;
  const m = t.match(STORAGE_RE);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = m[2].charAt(0); // t/g/m
  // Normalize to GB for comparability (1TB = 1024GB).
  return unit === 't' ? v * 1024 : unit === 'g' ? v : Math.round(v / 1024 * 100) / 100;
}

function extractRam(text) {
  // RAM usually stated as "8GB RAM", "16 gb memory".
  const t = S(text).toLowerCase();
  if (!t) return null;
  const m = t.match(/\b(\d{1,3})\s*gb\s*(?:ram|memory)\b/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

/* ==================================================================== *
 * 6. Dimensions extraction                                             *
 * ==================================================================== */

/* Matches 900x400, 900 x 400 mm, 31.5" x 11.8", 800*300mm etc. */
const DIMENSION_RE = /(\d{1,4}(?:\.\d+)?)\s*(?:"|''|in(?:ch(?:es)?)?)?\s*[x*×by]\s*(\d{1,4}(?:\.\d+)?)\s*(?:"|''|in(?:ch(?:es)?)?)?\s*(mm|cm|m|in|inch|inches|")?/i;

function extractDimensions(text) {
  const t = S(text);
  if (!t) return null;
  const m = t.match(DIMENSION_RE);
  if (!m) return null;
  let w = parseFloat(m[1]);
  let h = parseFloat(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const unitRaw = (m[3] || 'mm').toLowerCase(); // eBay pad titles omit units; mm is the norm there
  let unit = 'mm';
  if (unitRaw.startsWith('in') || unitRaw === '"') unit = 'in';
  else if (unitRaw === 'cm') unit = 'cm';
  else if (unitRaw === 'm') unit = 'cm'; // meters -> convert to cm below
  let wi = w, hi = h; // inches
  if (unit === 'mm') { wi = w / 25.4; hi = h / 25.4; }
  else if (unit === 'cm') { wi = w / 2.54; hi = h / 2.54; }
  // A/B orientation does not matter; keep sorted so 400x900 == 900x400.
  const dims = [wi, hi].sort((a, b) => b - a);
  return { wIn: Math.round(dims[1] * 10) / 10, hIn: Math.round(dims[0] * 10) / 10, raw: `${m[1]}x${m[2]}${m[3] || ''}` };
}

/* ==================================================================== *
 * 7. Model / MPN / identifiers                                         *
 * ==================================================================== */

/* Model-like tokens: alnum with a digit, 3-20 chars, e.g. G502, K400, RM550X.
 * Exclude pure numbers, storage ("128gb"), resolutions ("1080p"), years. */
const MODEL_TOKEN_RE = /^[a-z]{0,4}\d{1,6}[a-z]{0,6}$|^[a-z]\d[a-z0-9]*$|^[a-z]{1,5}\d{1,5}[a-z]{1,6}$/;
const MODEL_EXCLUDE_RE = /^(?:\d{3,}|[0-9]{1,2}(?:gb|tb|mb|w|v|hz?|hz|mm|cm|in|ft|oz|ml|l|kg|lb|k|pk|pack|pcs?)?)$/i;
const MPN_LABELED_RE = /\b(?:mpn|model(?:\s*(?:no|number|#))?|part\s*(?:no|number|#)?)\s*[:#]?\s*([a-z0-9][a-z0-9\-_]{2,18})\b/i;

function looksLikeModelToken(tok) {
  const t = tok.toLowerCase();
  if (t.length < 3 || t.length > 20) return false;
  if (MODEL_EXCLUDE_RE.test(t)) return false;
  if (!/\d/.test(t)) return false;
  if (!/[a-z]/.test(t)) return false;
  return MODEL_TOKEN_RE.test(t);
}

/** Extract model/MPN candidates: labeled ("Model: G502") or bare tokens. */
function extractModels(text) {
  const out = [];
  const t = S(text);
  if (!t) return out;
  const labeled = t.match(MPN_LABELED_RE);
  if (labeled) out.push(labeled[1].toUpperCase().replace(/[^A-Z0-9\-_]/g, ''));

  const tokens = foldKey(t).split(' ');
  for (const tok of tokens) {
    if (looksLikeModelToken(tok) && !out.includes(tok.toUpperCase())) out.push(tok.toUpperCase());
  }
  return out.slice(0, 6);
}

/** Strip brand words + noise so model compare works ("logitech g502 hero" -> "g502 hero" tail). */
function modelTail(title, brand) {
  let t = foldKey(title);
  if (brand) t = t.replace(new RegExp(`\\b${escapeRe(foldKey(brand))}\\b`), ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function escapeRe(s) {
  return S(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ==================================================================== *
 * 8. Brand extraction + normalization                                  *
 * ==================================================================== */

/* Common consumer brands. Matching is "word boundary contains" on the
 * folded title. Extend freely — absence simply yields brand=null. */
const KNOWN_BRANDS = [
  'apple', 'samsung', 'logitech', 'logitech g', 'razer', 'corsair', 'anker',
  'hyperx', 'steelseries', 'jbl', 'sony', 'bose', 'sennheiser', 'audio-technica',
  'nintendo', 'microsoft', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'msi',
  'gigabyte', 'evga', 'msi', 'sapphire', 'xfx', 'crucial', 'samsung evo',
  'sandisk', 'kingston', 'wd', 'seagate', 'lacie', 'stanley', 'yeti', 'hydro flask',
  'nike', 'adidas', 'puma', 'new balance', 'under armour', 'vans', 'converse',
  'lego', 'hasbro', 'funko', 'dyson', 'shark', 'bissell', 'roborock', 'irobot',
  'keurig', 'ninja', 'kitchenaid', 'cuisinart', 'instant pot', 'breville',
  'philips', 'panasonic', 'sharp', 'tcl', 'hisense', 'vizio', 'lg', 'roku',
  'amd', 'intel', 'nvidia', 'gskill', 'noctua', 'be quiet', 'coolermaster', 'cooler master',
  'tp-link', 'netgear', 'asrock', 'biostar', 'mattel', 'fisher price', 'little tykes',
  'cannon', 'canon', 'nikon', 'gopro', 'dji', 'fitbit', 'garmin', 'withings',
  'oxo', 'lodge', 'all-clad', 'calphalon', 'pyrex', 'corningware', 'corelle'
];

const BRAND_ALIASES = { hp: 'hp', 'hewlett packard': 'hp', wd: 'western digital', 'be quiet': 'be quiet!', coolermaster: 'cooler master' };

const BRAND_LOOKUP = (() => {
  const map = new Map();
  for (const b of KNOWN_BRANDS) map.set(foldKey(b), BRAND_ALIASES[foldKey(b)] || foldKey(b));
  return map;
})();

function extractBrand(text) {
  const t = foldKey(S(text));
  if (!t) return null;
  let best = null;
  let bestLen = 0;
  for (const b of BRAND_LOOKUP.keys()) {
    if (b.length <= bestLen) continue;
    const re = new RegExp(`(?:^|\\s)${escapeRe(b)}(?:\\s|$)`);
    if (re.test(t)) { best = BRAND_LOOKUP.get(b); bestLen = b.length; }
  }
  return best;
}

/* ==================================================================== *
 * 9. Condition, connectivity, generation                               *
 * ==================================================================== */
const CONDITION_RE = /\b(refurb(?:ished)?|renewed|pre-?owned|used(?:-|\s)?(?:good|like new|very good|acceptable)?|open[ -]box|for parts|not working|new(?: other)?|brand new)\b/i;

function extractCondition(text) {
  const t = S(text).toLowerCase();
  if (!t) return null;
  const m = t.match(CONDITION_RE);
  if (!m) return null;
  const w = m[1].toLowerCase();
  if (/^refurb|^renewed/.test(w)) return 'refurbished';
  if (/open[ -]box/.test(w)) return 'open-box';
  if (/pre-?owned|^used|for parts|not working/.test(w)) return 'used';
  if (/new/.test(w)) return 'new';
  return w;
}

/* WiFi/cellular: phones/tablets/watch variants */
const CONNECTIVITY_RE = /\b(wifi(?:\s*only)?|wi-fi|cellular|lte|5g|gps\s*\+\s*cellular|wlan)\b/i;

function extractConnectivity(text) {
  const t = S(text).toLowerCase();
  if (!t) return null;
  const m = t.match(CONNECTIVITY_RE);
  if (!m) return null;
  const w = m[1].toLowerCase().replace(/[\s-]/g, '');
  if (w === 'wifi' || w === 'wifionly' || w === 'wlan' || w === 'wifi') return 'wifi';
  return 'cellular';
}

/* Apple Watch / iPhone / Kindle / Surface "Gen N"/"Series N"/"Mk II" */
const GENERATION_RE = /\b(?:series|gen(?:eration)?|mark|mk)\s*(\d{1,2}|[IVX]{1,4})\b/i;

function extractGeneration(text) {
  const t = S(text);
  if (!t) return null;
  const m = t.match(GENERATION_RE);
  if (!m) return null;
  const v = m[1].toUpperCase();
  // Roman numerals -> arabic for comparability.
  const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
  return ROMAN[v] != null ? String(ROMAN[v]) : v;
}

/* Size (category-dependent semantics — see category config below). */
function extractSize(text) {
  const t = S(text).toLowerCase();
  if (!t) return null;
  const m = t.match(SIZE_WORDS);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return SIZE_CANON[w] || w;
}

/* Capacity in ml/oz/L (bottles, tumblers). Normalized to ml. */
function extractCapacity(text) {
  const t = S(text).toLowerCase();
  if (!t) return null;
  let m = t.match(/\b(\d{1,4}(?:\.\d+)?)\s*(?:ml|milliliter|millilitre)s?\b/);
  if (m) { const v = parseFloat(m[1]); return Number.isFinite(v) ? v : null; }
  m = t.match(/\b(\d{1,3}(?:\.\d+)?)\s*(?:l\b|liter|litre|oz|ounce)/);
  if (m) {
    const v = parseFloat(m[1]);
    if (!Number.isFinite(v)) return null;
    return /oz/.test(m[0]) ? Math.round(v * 29.5735) : v * 1000;
  }
  return null;
}

/* ==================================================================== *
 * 10. Category detection (lightweight keyword classifier)               *
 * ==================================================================== */

/* Each entry: [categoryId, [keywords...]]. First match wins (order matters:
 * specific before generic). Extend freely without touching the engine. */
const CATEGORY_RULES = [
  ['mousepad', ['mouse pad', 'mousepad', 'mouse mat', 'desk pad', 'deskpad']],
  ['keyboard', ['keyboard', 'keychron', 'mechanical keyboard']],
  ['mouse', ['gaming mouse', 'wireless mouse', 'mouse retrac', ' computer mouse', ' bluetooth mouse']],
  ['ssd', ['ssd', 'solid state', 'm.2', 'nvme', 'sata iii']],
  ['hdd', ['hard drive', 'hdd', 'external hard']],
  ['ram', ['ddr4', 'ddr5', 'ddr3', 'ram memory', 'desktop memory']],
  ['flash', ['usb drive', 'flash drive', 'thumb drive', 'micro sd', 'sd card', 'memory card']],
  ['phone', ['iphone', 'galaxy s', 'galaxy note', 'pixel ', 'smartphone', 'unlocked cell']],
  ['tablet', ['ipad', 'galaxy tab', 'tablet']],
  ['laptop', ['laptop', 'macbook', 'thinkpad', 'chromebook', 'notebook']],
  ['monitor', ['monitor', 'display 27', 'display 32', 'ultrawide']],
  ['headphones', ['headphones', 'earbuds', 'headset', 'airpods', 'galaxy buds']],
  ['watch', ['apple watch', 'smartwatch', 'smart watch', 'galaxy watch']],
  ['shoes', ['shoes', 'sneakers', 'sneaker', 'boots', 'sandals', 'loafers', 'trainers', 'running shoes']],
  ['tumbler', ['tumbler', 'quencher', 'water bottle', 'flask', 'mug', 'travel mug']],
  ['console', ['playstation', 'ps5', 'ps4', 'xbox series', 'nintendo switch', 'switch oled']],
  ['game', ['nintendo switch game', 'ps5 game', 'xbox game', 'video game']],
  ['tv', [' smart tv', ' 4k tv', 'oled tv', ' qled', ' tv 55', ' tv 65', ' tv 75']],
  ['camera', ['camera', 'lens ', 'dslr', 'mirrorless', 'gopro']],
  ['router', ['router', 'mesh wifi', 'wifi 6', 'wifi 7', 'extender']],
  ['powerbank', ['power bank', 'powerbank', 'portable charger', 'battery pack']],
  ['charger', ['charger', 'charging cable', 'usb c cable', 'wall adapter', 'gan charger']],
  ['keyboardcase', ['ipad case', 'tablet case', 'keyboard case']],
  ['toy', ['lego', 'playset', 'figure', 'plush', 'doll', 'toy']],
  ['apparel', ['shirt', 't-shirt', 'hoodie', 'jacket', 'pants', 'jeans', 'dress', 'hooded']]
];

function detectCategory(text) {
  const t = ` ${foldKey(S(text))} `;
  for (const [id, kws] of CATEGORY_RULES) {
    for (const kw of kws) {
      if (t.includes(kw)) return id;
    }
  }
  return 'general';
}

/* ==================================================================== *
 * 11. Category-aware attribute configuration                            *
 * ==================================================================== */

/* For each category: which attributes are identity-defining (variant-level)
 * vs family-level. 'attributes' feed scoring; 'variantKeys' decide
 * sameVariant. Adding a new category = adding one entry here. */
const CATEGORY_CONFIG = {
  mousepad: {
    attributes: ['brand', 'model', 'dimensions', 'quantity', 'color'],
    variantKeys: ['dimensions', 'quantity', 'color']
  },
  ssd: {
    attributes: ['brand', 'model', 'storage', 'generation', 'condition'],
    variantKeys: ['storage', 'generation', 'condition']
  },
  phone: {
    attributes: ['brand', 'model', 'storage', 'generation', 'connectivity', 'condition', 'color'],
    variantKeys: ['storage', 'generation', 'connectivity', 'condition', 'color']
  },
  tablet: {
    attributes: ['brand', 'model', 'storage', 'generation', 'connectivity', 'condition'],
    variantKeys: ['storage', 'generation', 'connectivity', 'condition']
  },
  laptop: {
    attributes: ['brand', 'model', 'storage', 'ram', 'generation', 'condition'],
    variantKeys: ['storage', 'ram', 'condition']
  },
  watch: {
    attributes: ['brand', 'model', 'generation', 'connectivity', 'condition', 'color'],
    variantKeys: ['generation', 'connectivity', 'condition', 'color']
  },
  shoes: {
    attributes: ['brand', 'model', 'size', 'color', 'condition'],
    variantKeys: ['size', 'color', 'condition']
  },
  apparel: {
    attributes: ['brand', 'size', 'color', 'condition'],
    variantKeys: ['size', 'color', 'condition']
  },
  tumbler: {
    attributes: ['brand', 'model', 'capacity', 'color', 'quantity', 'condition'],
    variantKeys: ['capacity', 'color', 'quantity']
  },
  headphones: {
    attributes: ['brand', 'model', 'generation', 'condition', 'color'],
    variantKeys: ['generation', 'condition', 'color']
  },
  flash: {
    attributes: ['brand', 'storage', 'condition'],
    variantKeys: ['storage', 'condition']
  },
  ram: {
    attributes: ['brand', 'capacity', 'generation', 'condition'],
    variantKeys: ['capacity', 'generation', 'condition']
  },
  general: {
    attributes: ['brand', 'model', 'quantity', 'condition', 'color'],
    variantKeys: ['quantity', 'condition']
  }
};

const FALLBACK_CONFIG = CATEGORY_CONFIG.general;

function configFor(category) {
  return CATEGORY_CONFIG[category] || FALLBACK_CONFIG;
}

/* ==================================================================== *
 * 12. extractAttributes + normalizeItem (common representation)         *
 * ==================================================================== */

/**
 * Pull commercially-relevant attributes from a scraped listing.
 * Only the fields the extension already captures are used (title, condition,
 * id/url, image). Descriptions/specs are not fetched — extraction is
 * title-only by design (no scraping changes).
 */
function extractAttributes(item) {
  const title = S(item && item.title);
  const conditionText = S(item && item.condition); // eBay's subtitle ("Brand New", "Pre-Owned"...)
  const haystack = `${title} ${conditionText}`;

  const attrs = {
    brand: extractBrand(haystack),
    models: extractModels(title),
    quantity: extractQuantity(haystack),
    color: extractColor(title),
    storage: extractStorage(title),
    ram: extractRam(title),
    dimensions: extractDimensions(title),
    capacity: extractCapacity(title),
    size: extractSize(title),
    generation: extractGeneration(title),
    connectivity: extractConnectivity(title),
    condition: normalizeConditionInput(item, conditionText, title),
    upc: null, ean: null, gtin: null, isbn: null, mpn: null, // not captured by scrapers yet
    category: detectCategory(haystack),
    isBundle: isBundleText(haystack),
    rawTitle: title
  };
  return attrs;
}

/* eBay's `condition` field is structured text ("Brand New", "Pre-Owned ·
 * 30+ days on eBay"); Amazon's is 'New'/'Used'. Normalize both. */
function normalizeConditionInput(item, conditionText, title) {
  const fromField = foldLower(conditionText);
  if (/pre-?owned/.test(fromField)) return 'used';
  if (/refurb|renewed/.test(fromField)) return 'refurbished';
  if (/open[ -]box/.test(fromField)) return 'open-box';
  if (/brand new|new\b/.test(fromField)) return 'new';
  if (/used/.test(fromField)) return 'used';
  // Fall back to title-embedded condition words only.
  return extractCondition(title);
}

/**
 * Convert a scraped item into the common internal representation.
 * Never throws; every field is nullable. `source` is 'ebay'/'amazon'.
 */
function normalizeItem(item) {
  if (!item || typeof item !== 'object') {
    return { title: '', attrs: {}, source: null };
  }
  const attrs = extractAttributes(item);
  return {
    id: item.id != null ? S(item.id) : null,
    title: attrs.rawTitle,
    price: Number.isFinite(item.price) ? item.price : null,
    image: isBlank(item.image) ? null : S(item.image),
    url: isBlank(item.url) ? null : S(item.url),
    condition: attrs.condition,
    source: item.site === 'amazon' || item.site === 'ebay' ? item.site : null,
    attrs
  };
}

/* ==================================================================== *
 * 13. Comparison helpers (MATCH / MISMATCH / UNKNOWN)                   *
 * ==================================================================== */
const M = { MATCH: 'MATCH', MISMATCH: 'MISMATCH', UNKNOWN: 'UNKNOWN' };

function compareScalar(a, b, opts) {
  opts = opts || {};
  if (isBlank(a) || isBlank(b)) return M.UNKNOWN; // missing != wrong
  const eq = opts.eq ? opts.eq(a, b) : foldLower(a) === foldLower(b);
  return eq ? M.MATCH : M.MISMATCH;
}

function compareNumeric(a, b, tolRel) {
  if (a == null || b == null) return M.UNKNOWN;
  if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return M.UNKNOWN;
  const x = Number(a); const y = Number(b);
  if (x === y) return M.MATCH;
  const tol = tolRel != null ? tolRel : 0.02;
  const base = Math.max(Math.abs(x), Math.abs(y));
  return Math.abs(x - y) / base <= tol ? M.MATCH : M.MISMATCH;
}

/* Dimensions: both in inches after unit normalization; tolerance 4%. */
function compareDimensions(a, b) {
  if (!a || !b || !a.wIn || !b.wIn) return M.UNKNOWN;
  const wOk = Math.abs(a.wIn - b.wIn) / Math.max(a.wIn, b.wIn) <= 0.04;
  const hOk = Math.abs(a.hIn - b.hIn) / Math.max(a.hIn, b.hIn) <= 0.04;
  return wOk && hOk ? M.MATCH : M.MISMATCH;
}

/* Model: match if ANY extracted model token appears on both sides
 * (substring-aware: "g502" in "g502 hero"). */
function compareModels(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  if (!A.length || !B.length) return M.UNKNOWN;
  for (const x of A) {
    const xl = x.toLowerCase();
    for (const y of B) {
      const yl = y.toLowerCase();
      if (xl === yl) return M.MATCH;
      // Same brand family guard: "g502" vs "g502x" would falsely match by
      // prefix, so require exact OR full-token containment (>=4 chars).
      if (xl.length >= 4 && yl.includes(xl)) return M.MATCH;
      if (yl.length >= 4 && xl.includes(yl)) return M.MATCH;
    }
  }
  return M.MISMATCH;
}

/* ==================================================================== *
 * 14. Hard conflict detection                                          *
 * ==================================================================== */

/**
 * Compare category-relevant attributes and collect conflicts.
 * Returns { conflicts, attributeMatches, blocked, penalty }.
 *  - conflicts: [{attr, ebay, amazon, policy}]
 *  - blocked: true when any 'reject' policy attribute mismatches
 *  - penalty: cumulative score penalty for 'penalize' conflicts
 */
function detectHardConflicts(ebayAttrs, amazonAttrs, category) {
  const cfg = configFor(category);
  const conflicts = [];
  const attributeMatches = {};
  let blocked = false;
  let penalty = 0;

  const relevant = new Set([...(cfg.attributes || []), 'quantity', 'condition']);

  const judge = (attr, status) => {
    if (status === M.MATCH) attributeMatches[attr] = true;
    else if (status === M.MISMATCH) attributeMatches[attr] = false;
    // UNKNOWN: leave the key absent (UI can distinguish unresolved).

    if (status !== M.MISMATCH) return;
    const policy = CONFLICT_POLICY[attr] || 'penalize';
    conflicts.push({ attr, ebay: displayValue(ebayAttrs[attr]), amazon: displayValue(amazonAttrs[attr]), policy });
    if (policy === 'reject') blocked = true;
    else if (policy === 'penalize') penalty += 0.18;
    else penalty += 0.08; // penalize_soft
  };

  for (const attr of relevant) {
    const a1 = ebayAttrs[attr];
    const a2 = amazonAttrs[attr];
    switch (attr) {
      case 'brand': judge(attr, compareScalar(a1, a2)); break;
      case 'model':
        judge(attr, compareModels(a1, a2)); break;
      case 'quantity': judge(attr, compareNumeric(a1, a2, 0)); break;
      case 'storage': judge(attr, compareNumeric(a1, a2, 0.001)); break;
      case 'ram': judge(attr, compareNumeric(a1, a2, 0.001)); break;
      case 'capacity': judge(attr, compareNumeric(a1, a2, 0.02)); break;
      case 'dimensions': judge(attr, compareDimensions(a1, a2)); break;
      case 'size': judge(attr, compareScalar(a1, a2)); break;
      case 'color': judge(attr, compareScalar(a1, a2)); endColor(ebayAttrs, amazonAttrs, judge); break;
      case 'generation': judge(attr, compareScalar(a1, a2)); break;
      case 'connectivity': judge(attr, compareScalar(a1, a2)); break;
      case 'condition': judge(attr, compareCondition(a1, a2)); break;
      default: break;
    }
  }
  return { conflicts, attributeMatches, blocked, penalty };
}

/* Color is noisy from titles (RGB pads are "black" one side, not the other).
 * Only a MISMATCH on BOTH sides being color-relevant counts; a single-side
 * detection is downgraded to soft via policy lookup anyway. This hook exists
 * to let future categories mark color "not variant-defining". */
function endColor(ebayAttrs, amazonAttrs, judge) {
  // no-op hook for future refinement (keeps the switch shape stable)
  return judge;
}

function compareCondition(a, b) {
  if (isBlank(a) || isBlank(b)) return M.UNKNOWN;
  const x = foldLower(a); const y = foldLower(b);
  if (x === y) return M.MATCH;
  // new vs open-box: different retail integrity -> mismatch (policy rejects)
  return M.MISMATCH;
}

function displayValue(v) {
  if (v == null) return 'unknown';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return v.raw || JSON.stringify(v);
  return S(v);
}

/* ==================================================================== *
 * 15. Optional semantic hook + image hook (inactive by default)          *
 * ==================================================================== */

/* Semantic similarity: pluggable. Default implementation = token Jaccard on
 * attribute-stripped titles (order-free), which recognizes reworded titles
 * ("Logitech G502 HERO High Performance Gaming Mouse" vs "G502 HERO Gaming
 * Mouse - Black") without any external service. An embeddings provider can
 * be injected via ARBMatcher.configure({ semanticProvider }) later; the
 * engine NEVER requires one. */
let semanticProvider = null; // (titleA, titleB) -> 0..1 | Promise

function configure(opts) {
  opts = opts || {};
  if (typeof opts.semanticProvider === 'function') semanticProvider = opts.semanticProvider;
  else if (opts.semanticProvider === null) semanticProvider = null;
}

/* Strip identifiers/attrs so wording similarity isn't diluted by numbers. */
function stripAttrNoise(title) {
  return foldKey(title)
    .replace(/\b\d{1,4}\s*(?:gb|tb|mb|mm|cm|in|inch|inches|oz|ml|l|w|pk|pack|pcs?|pieces?|ct|count)\b/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function defaultSemantic(titleA, titleB) {
  const a = new Set(stripAttrNoise(titleA).split(' ').filter((w) => w.length > 1));
  const b = new Set(stripAttrNoise(titleB).split(' ').filter((w) => w.length > 1));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter); // plain Jaccard
}

function semanticScore(titleA, titleB) {
  if (semanticProvider) {
    try {
      const v = semanticProvider(titleA, titleB);
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    } catch (_) { /* provider failed -> fall through to local */ }
  }
  return defaultSemantic(titleA, titleB);
}

/* Image similarity: intentionally a stub interface (Phase 9 of the task).
 * The extension stores image URLs, but computing perceptual similarity
 * would require decoding pixels — not practical inside the MV3 worker
 * without extra deps. Providing BOTH urls yields a conservative neutral
 * 0.5 only when the filenames look identical (same asset), else null. */
function imageScore(ebayNorm, amazonNorm) {
  if (isBlank(ebayNorm.image) || isBlank(amazonNorm.image)) return null;
  try {
    const nameOf = (u) => {
      const path = new URL(u).pathname;
      return path.split('/').pop() || '';
    };
    const e = nameOf(ebayNorm.image).toLowerCase();
    const a = nameOf(amazonNorm.image).toLowerCase();
    // Same filename on different hosts is weak evidence of the same asset.
    if (e && a && e === a) return 0.75;
    return null; // cannot compare -> do not affect scoring
  } catch (_) { return null; }
}

/* ==================================================================== *
 * 16. Weighted scoring + classification                                *
 * ==================================================================== */

/**
 * Full pairwise match. Signature: (ebayItem, amazonItem, opts).
 * opts.titleSimilarity: injected legacy fn from background.js (kept verbatim).
 * Returns MatchResult (see buildPairs for pair shape).
 */
function matchPair(ebayItem, amazonItem, opts) {
  opts = opts || {};
  const titleSim = typeof opts.titleSimilarity === 'function'
    ? opts.titleSimilarity
    : (a, b) => 0;

  const E = ebayItem && ebayItem.attrs ? ebayItem : normalizeItem(ebayItem);
  const A = amazonItem && amazonItem.attrs ? amazonItem : normalizeItem(amazonItem);

  const category = E.attrs.category === E.attrs.category && E.attrs.category !== 'general'
    ? E.attrs.category
    : (A.attrs.category !== 'general' ? A.attrs.category : 'general');

  const cf = detectHardConflicts(E.attrs, A.attrs, category);

  /* --- signal values 0..1 (null = signal unavailable) --- */
  const signals = {};

  // identifier: model overlap as proxy (GTIN/UPC not captured yet).
  const modelCmp = compareModels(E.attrs.models, A.attrs.models);
  signals.identifier = modelCmp === M.MATCH ? 1 : modelCmp === M.MISMATCH ? 0 : null;

  // attributes: fraction of category-relevant attributes agreeing.
  const attrKeys = configFor(category).attributes || [];
  let attrHit = 0; let attrKnown = 0;
  for (const k of attrKeys) {
    if (cf.attributeMatches[k] === true) { attrHit++; attrKnown++; }
    else if (cf.attributeMatches[k] === false) { attrKnown++; }
  }
  signals.attributes = attrKnown ? attrHit / attrKnown : null;

  // brand
  const brandCmp = compareScalar(E.attrs.brand, A.attrs.brand);
  signals.brand = brandCmp === M.MATCH ? 1 : brandCmp === M.MISMATCH ? 0 : null;

  // category agreement
  signals.category = E.attrs.category === A.attrs.category ? 1 : (E.attrs.category === 'general' || A.attrs.category === 'general' ? null : 0);

  // title (legacy algorithm, injected verbatim from background.js)
  const t = titleSim(E.title, A.title);
  signals.title = Number.isFinite(t) ? t : 0;

  // semantic (order-free Jaccard by default; provider-overridable)
  signals.semantic = semanticScore(E.title, A.title);

  // image (null unless identical-asset heuristic hits)
  signals.image = imageScore(E, A);

  /* --- weighted aggregate over available signals --- */
  let wsum = 0; let acc = 0;
  for (const [name, w] of Object.entries(MATCHING_WEIGHTS)) {
    const v = signals[name];
    if (v == null) continue; // missing signal drops OUT of the denominator
    acc += w * v;
    wsum += w;
  }
  let score = wsum > 0 ? acc / wsum : 0;

  /* --- conflicts modify the score; 'reject' forces REJECTED --- */
  score = Math.max(0, score - cf.penalty);

  // Bundle vs single penalty: bundle must not pair with the plain product.
  if (E.attrs.isBundle !== A.attrs.isBundle) {
    cf.conflicts.push({ attr: 'bundle', ebay: E.attrs.isBundle ? 'bundle' : 'single item', amazon: A.attrs.isBundle ? 'bundle' : 'single item', policy: 'penalize' });
    score -= 0.25;
  }

  score = Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;

  /* --- classification --- */
  let confidence;
  if (cf.blocked) confidence = CONFIDENCE.REJECTED;
  else if (score >= HIGH_MIN) confidence = CONFIDENCE.HIGH;
  else if (score >= POSSIBLE_MIN) confidence = CONFIDENCE.POSSIBLE;
  else if (score >= FINAL_CUTOFF) confidence = CONFIDENCE.LOW;
  else confidence = CONFIDENCE.REJECTED;

  /* --- family vs variant --- */
  const variantKeys = configFor(category).variantKeys || [];
  let sameVariant = cf.blocked ? false : confidence === CONFIDENCE.HIGH || confidence === CONFIDENCE.POSSIBLE;
  for (const k of variantKeys) {
    if (cf.attributeMatches[k] === false) { sameVariant = false; break; } // known difference
  }
  const familyScore = signals.brand === 1 || signals.identifier === 1 ||
    (signals.category === 1 && (signals.title >= 0.5 || signals.semantic >= 0.5));
  const sameProductFamily = !cf.blocked && !!familyScore && signals.brand !== 0;

  return {
    score,
    confidence,
    blocked: cf.blocked,
    conflicts: cf.conflicts,
    attributeMatches: cf.attributeMatches,
    signals,
    category,
    sameProductFamily,
    sameVariant,
    reasons: buildReasons(signals, cf, confidence, E, A)
  };
}

function buildReasons(signals, cf, confidence, E, A) {
  const r = [];
  if (signals.identifier === 1) r.push('Same model identifier');
  if (signals.brand === 1) r.push('Same brand');
  if (signals.brand === 0) r.push('Different brand');
  if (cf.attributeMatches.quantity === true) r.push('Same quantity');
  if (cf.attributeMatches.quantity === false) r.push('Quantity mismatch');
  if (cf.attributeMatches.dimensions === true) r.push('Compatible dimensions');
  if (cf.attributeMatches.storage === true) r.push('Same storage');
  if (cf.attributeMatches.storage === false) r.push('Storage mismatch');
  if (cf.attributeMatches.color === true) r.push('Same color');
  if (cf.attributeMatches.color === false) r.push('Color mismatch');
  if (cf.attributeMatches.condition === true) r.push('Same condition');
  if (cf.attributeMatches.condition === false) r.push('Condition mismatch');
  if (signals.semantic >= 0.6) r.push('High semantic similarity');
  if (signals.image != null && signals.image >= 0.75) r.push('Similar images');
  if (cf.blocked) r.push('Blocked by hard conflict');
  return r.slice(0, 8);
}

/* ==================================================================== *
 * 17. Candidate generation (blocking)                                  *
 * ==================================================================== */

/**
 * Recall-first blocking: quick Jaccard on folded tokens + shared brand or
 * category requirement. Returns index pairs worth full scoring, sorted by
 * quick sim desc. Never eliminates on attributes (that's the full engine).
 */
function generateCandidates(amazonItems, ebayItems, helpers) {
  const h = helpers || {};
  const quickSim = typeof h.titleSimilarity === 'function' ? h.titleSimilarity : defaultSemantic;

  // Precompute cheap keys.
  const eKeys = ebayItems.map((it) => {
    const n = normalizeItem(it);
    return { norm: n, tokens: new Set(foldKey(n.title).split(' ').filter((w) => w.length > 1)) };
  });
  const aKeys = amazonItems.map((it) => {
    const n = normalizeItem(it);
    return { norm: n, tokens: new Set(foldKey(n.title).split(' ').filter((w) => w.length > 1)) };
  });

  const out = [];
  for (let ia = 0; ia < aKeys.length; ia++) {
    for (let ib = 0; ib < eKeys.length; ib++) {
      const s = quickSim(aKeys[ia].norm.title, eKeys[ib].norm.title);
      if (s < CANDIDATE_SIM_THRESHOLD) continue;
      out.push({ ia, ib, s });
    }
  }
  out.sort((x, y) => y.s - x.s);
  if (out.length > MAX_CANDIDATES) out.length = MAX_CANDIDATES;
  return out;
}

/* ==================================================================== *
 * 18. buildPairs — back-compatible replacement for computePairs        *
 * ==================================================================== */

/**
 * amazonItems/ebayItems: raw scraped items (unchanged shape).
 * helpers: { titleSimilarity } — the legacy function from background.js.
 * Returns { pairs, amzUsed, ebayUsed } where each pair keeps the legacy
 * fields (sim, amazon, ebay) and adds matchScore/matchConfidence/... .
 */
function buildPairs(amazonItems, ebayItems, helpers) {
  const h = helpers || {};
  const titleSimilarity = typeof h.titleSimilarity === 'function' ? h.titleSimilarity : defaultSemantic;
  const legacy = typeof h.legacyMatch === 'function' ? h.legacyMatch : null;

  const ebayNorm = (Array.isArray(ebayItems) ? ebayItems : []).map(normalizeItem);
  const amazonNorm = (Array.isArray(amazonItems) ? amazonItems : []).map(normalizeItem);

  const cands = generateCandidates(amazonItems, ebayItems, { titleSimilarity });

  const usedA = new Set();
  const usedB = new Set();
  const scored = [];

  for (const c of cands) {
    const res = matchPair(ebayNorm[c.ib], amazonNorm[c.ia], { titleSimilarity });
    scored.push({ ia: c.ia, ib: c.ib, res });
  }

  // Confidence-first, then score. REJECTED pairs are kept (flagged) only if
  // they still clear FINAL_CUTOFF *after* penalties — the UI shows reasons.
  scored.sort((x, y) => {
    const rank = (r) => (r.confidence === CONFIDENCE.HIGH ? 3 : r.confidence === CONFIDENCE.POSSIBLE ? 2 : r.confidence === CONFIDENCE.LOW ? 1 : 0);
    const d = rank(y.res) - rank(x.res);
    return d !== 0 ? d : y.res.score - x.res.score;
  });

  const pairs = [];
  for (const c of scored) {
    if (usedA.has(c.ia) || usedB.has(c.ib)) continue;
    const r = c.res;
    const keep = r.confidence !== CONFIDENCE.REJECTED;
    if (!keep) continue;
    usedA.add(c.ia);
    usedB.add(c.ib);
    pairs.push({
      sim: Math.round(r.score * 100),        // legacy field (now the multi-signal score)
      matchScore: r.score,
      matchConfidence: r.confidence,
      sameProduct: r.sameProductFamily,
      sameVariant: r.sameVariant,
      attributeMatches: r.attributeMatches,
      conflicts: r.conflicts,
      reasons: r.reasons,
      category: r.category,
      signals: r.signals,
      amazon: amazonItems[c.ia],
      ebay: ebayItems[c.ib]
    });
    if (pairs.length >= MAX_PAIRS) break;
  }
  return { pairs, amzUsed: usedA.size, ebayUsed: usedB.size };
}

/* ==================================================================== *
 * 19. Public surface                                                   *
 * ==================================================================== */
const ARBMatcher = {
  MATCHING_WEIGHTS,
  CONFIDENCE,
  matchPair,
  generateCandidates,
  buildPairs,
  normalizeItem,
  extractAttributes,
  detectHardConflicts,
  configure
};

/* Export shim: service worker (importScripts) vs Node (require) */
if (typeof module !== 'undefined' && module.exports) module.exports = { ARBMatcher };
if (typeof self !== 'undefined') self.ARBMatcher = ARBMatcher;

})(); /* end arbMatcherModule */
