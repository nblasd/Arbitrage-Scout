#!/usr/bin/env node
/*
 * test_amazon_price.js — unit tests for the content script's amazonPrice()
 * -----------------------------------------------------------------------------
 * Run: node test_amazon_price.js      (exit 0 = pass, 1 = fail)
 *
 * Dependency-free on purpose (matches the extension's zero-dep culture).
 * amazonPrice() is extracted VERBATIM from content.js by brace matching, so
 * the tests always exercise the shipped code, then driven against a minimal
 * fake DOM. Covers the modern price-layout selector cascade (.a-price
 * .a-offscreen variants, .a-price-whole + .a-price-fraction, hydration data
 * attributes, text fallback), the null-never-throw contract, strike/list
 * price rejection, and [data-asin] card escalation for sibling-column prices.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const SRC = fs.readFileSync(__dirname + '/content.js', 'utf8');

/** Pull a top-level-in-IIFE function source out of content.js by brace matching. */
function extractFn(name) {
  const sig = 'function ' + name + '(';
  const i = SRC.indexOf(sig);
  if (i < 0) throw new Error('function not found in content.js: ' + name);
  const open = SRC.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(i, j + 1); }
  }
  throw new Error('unbalanced braces extracting ' + name);
}

const code =
  extractFn('parseMoney') + '\n' +
  extractFn('amazonPrice') + '\n' +
  'globalThis.__t = { parseMoney, amazonPrice };';

const sandbox = { console, log: () => {}, warn: () => {} };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'extracted-from-content.js' });
const { amazonPrice } = sandbox.__t;

/* Minimal fake DOM: nodes answer querySelector/closest from literal-selector maps. */
function fe(spec) {
  spec = spec || {};
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  return {
    textContent: spec.text != null ? spec.text : '',
    innerText: spec.text != null ? spec.text : '',
    className: spec.cls || '',
    getAttribute: (n) => (spec.attrs && spec.attrs[n] != null) ? spec.attrs[n] : null,
    querySelector: (sel) => {
      if (spec.throwOnQuery) throw new Error('querySelector exploded');
      return has(spec.q, sel) ? fe(spec.q[sel]) : null;
    },
    closest: (sel) => (has(spec.c, sel) ? fe(spec.c[sel]) : null),
  };
}

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const ok = actual === expected;
  if (ok) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error(`  ✗ FAIL: ${msg} — expected ${expected}, got ${actual}`); }
}

const OFF = '.a-price:not(.a-text-price) .a-offscreen';
const SPAN_OFF = 'span.a-price span.a-offscreen';
const DATA_SEL = '[data-price], [data-a-price], [data-price-whole], [data-csa-c-price], [data-eq-price]';
const CARD_SEL = 'div[data-asin], div[data-component-type="s-search-result"]';

console.log('== amazonPrice selector cascade ==');

eq(amazonPrice(fe({ q: { [OFF]: { text: '  $24.99 ' } } })), 24.99,
  'T1 non-strike .a-price .a-offscreen primary');
eq(amazonPrice(fe({ q: { [SPAN_OFF]: { text: '$19.95' } } })), 19.95,
  'T2 span.a-price span.a-offscreen variant');
eq(amazonPrice(fe({ q: { '.a-price-whole': { text: '24', c: { '.a-price': { cls: 'a-price', q: { '.a-price-fraction': { text: '99' } } } } } } })), 24.99,
  'T3 .a-price-whole + .a-price-fraction combined');
eq(amazonPrice(fe({ q: { '.a-price-whole': { text: '$24' } } })), 24,
  'T4 .a-price-whole alone (no fraction span)');
eq(amazonPrice(fe({ q: { '.a-price-whole': { text: '5', c: { '.a-price': { cls: 'a-price', q: { '.a-price-fraction': { text: '0' } } } } } } })), 5,
  'T5 one-digit fraction "$5.0" treated as tenths, not $5.00x');
eq(amazonPrice(fe({ q: { [DATA_SEL]: { attrs: { 'data-price': ' 31.20 ' } } } })), 31.2,
  'T6 hydration data-attribute price');
eq(amazonPrice(fe({
  text: 'Currently unavailable',
  q: {
    'span.a-offscreen': { text: 'List: $39.99', c: { '.a-text-price, .a-price[data-a-strike="true"]': { cls: 'a-text-price' } } },
    '.a-price-whole': { text: '39', c: { '.a-price': { cls: 'a-price a-text-price' } } },
  },
})), null,
  'T7 strike-only (unavailable) card returns null — list price never used as buy price');
eq(amazonPrice(fe({ c: { [CARD_SEL]: { q: { [OFF]: { text: '$49.00' } } } } })), 49,
  'T8 escalation to enclosing [data-asin] card finds sibling-column price');
eq(amazonPrice(fe({ text: 'Now only $12.34 with coupon' })), 12.34,
  'T9 text-regex last resort');
eq(amazonPrice(fe({})), null, 'T10 empty card -> null (no throw)');
eq(amazonPrice(fe({ throwOnQuery: true })), null, 'T11 throwing querySelector -> null (never halts caller)');
eq(amazonPrice(null), null, 'T12 null node -> null');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
