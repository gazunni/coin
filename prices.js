/* prices.js (Chainwolf v0.4.2): fetches prices from your own price Worker and turns amounts into fiat values. */
(function (root) {
  'use strict';
  var REFRESH_MS = 60000, STALE_MS = 300000;
  var url = (root.CHAINWOLF && root.CHAINWOLF.priceUrl) || '';
  var state = { data: null, failed: false, at: 0 };
  var listeners = [];
  var AMT = /^([+\u2212-])?(<)?([\d,]+(?:\.\d+)?) (BTC|ETH|SOL|TRX|XRP|LTC|DOGE|BCH|USDT|USDC|sats)$/;

  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) { /* a listener failing must not stop the others */ } }); }
  async function load() {
    if (!url) return;
    try {
      var r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      if (!j || !j.usd) throw new Error('bad price data');
      state.data = j; state.failed = false; state.at = Date.now();
    } catch (e) { state.failed = true; }
    emit();
  }
  function usd(sym) {
    var p = state.data && state.data.usd && state.data.usd[sym];
    if (typeof p === 'number' && isFinite(p) && p > 0) return p;
    return (sym === 'USDT' || sym === 'USDC') && state.data ? 1 : null;
  }
  function rate(cur) {
    if (cur === 'USD') return 1;
    var r = state.data && state.data.cadPerUsd;
    return typeof r === 'number' && isFinite(r) && r > 0 ? r : null;
  }
  function price(sym, cur) { var u = usd(sym), r = rate(cur); return u === null || r === null ? null : u * r; }
  function change(sym) {
    var c = state.data && state.data.chg && state.data.chg[sym];
    return typeof c === 'number' && isFinite(c) ? c : null;
  }
  function money(n, cur, digits) {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  }
  function priceText(n, cur) { return money(n, cur, n >= 1 ? 2 : (n >= 0.01 ? 4 : 6)); }
  function parseAmount(text) {
    var m = AMT.exec(String(text).trim());
    if (!m || m[2] === '<') return null;
    var n = parseFloat(m[3].replace(/,/g, ''));
    if (!isFinite(n)) return null;
    var sym = m[4];
    if (sym === 'sats') { n = n / 1e8; sym = 'BTC'; }
    return { n: (m[1] === '-' || m[1] === '\u2212') ? -n : n, sym: sym };
  }
  function fiatText(text, cur) {
    var a = parseAmount(text);
    if (!a) return '';
    var p = price(a.sym, cur);
    if (p === null) return '';
    var v = a.n * p, abs = Math.abs(v);
    var s = abs > 0 && abs < 0.01 ? '<$0.01' : money(abs, cur, 2);
    return '\u2248 ' + (v < 0 ? '\u2212' : (/^\s*\+/.test(text) ? '+' : '')) + s + ' ' + cur;
  }

  var api = {
    enabled: function () { return !!url; },
    has: function () { return !!state.data; },
    failed: function () { return state.failed; },
    delayed: function () { return !!(state.data && (state.data.stale || Date.now() - state.at > STALE_MS)); },
    updatedAt: function () { return state.at; },
    rate: rate, price: price, change: change, priceText: priceText, fiatText: fiatText, parseAmount: parseAmount,
    onUpdate: function (f) { listeners.push(f); },
    start: function () {
      if (!url) return;
      load();
      setInterval(function () { if (!root.document || !root.document.hidden) load(); }, REFRESH_MS);
      if (root.document) root.document.addEventListener('visibilitychange', function () { if (!root.document.hidden && Date.now() - state.at > REFRESH_MS) load(); });
    },
    _set: function (d) { state.data = d; state.at = Date.now(); state.failed = false; }
  };
  root.Prices = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
