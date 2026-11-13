/* app.js (Chainwolf v0.4.1): page logic. Network specifics live in chains.js. */
(function () {
  'use strict';
  var C = window.Chains;
  var P = window.Prices;
  var WATCH_TICK = 60000, MAX_WATCH = 25, KEEP_MS = 7 * 86400000;
  var KEY = 'btcwatch.v1', SEL_KEY = 'chainwolf.net', CUR_KEY = 'chainwolf.cur', DEFTITLE = 'Chainwolf';

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* ---------- selected network ---------- */
  var selected = 'bitcoin';
  try { var s0 = localStorage.getItem(SEL_KEY); if (s0 && C.byId[s0]) selected = s0; } catch (e) { /* storage blocked: keep the default network */ }
  function setSelected(id) {
    selected = id;
    try { localStorage.setItem(SEL_KEY, id); } catch (e) { /* storage blocked: the choice just is not remembered */ }
    renderNets(); renderStrip(); renderAllPrices();
  }
  function pickNet(id) {
    setSelected(id);
    var raw = $('txid').value.trim();
    if (raw) start(raw, null, id, true);
  }
  function renderNets() {
    var box = $('nets'); box.textContent = '';
    C.NETS.forEach(function (n) {
      var b = el('button', 'net', n.name); b.type = 'button';
      b.setAttribute('aria-pressed', n.id === selected ? 'true' : 'false');
      b.addEventListener('click', function () { pickNet(n.id); });
      box.appendChild(b);
    });
  }

  /* ---------- audio / title alerts ---------- */
  var actx = null;
  function unlockAudio() {
    try {
      if (!actx) { var A = window.AudioContext || window.webkitAudioContext; if (A) actx = new A(); }
      if (actx && actx.state === 'suspended') actx.resume();
    } catch (e) { /* audio unavailable: skip the chime */ }
  }
  function chime() {
    try {
      unlockAudio();
      if (actx) {
        var t = actx.currentTime;
        [660, 880].forEach(function (f, i) {
          var o = actx.createOscillator(), g = actx.createGain(), s = t + i * 0.18;
          o.frequency.value = f; o.connect(g); g.connect(actx.destination);
          g.gain.setValueAtTime(0.0001, s);
          g.gain.exponentialRampToValueAtTime(0.2, s + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, s + 0.16);
          o.start(s); o.stop(s + 0.18);
        });
      }
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    } catch (e) { /* audio or vibration unavailable: skip the alert */ }
  }
  function resetTitle() { document.title = DEFTITLE; }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) resetTitle(); });

  /* ---------- watchlist storage ---------- */
  var storageOK = true;
  function validItem(it) {
    return it && (it.type === 'tx' || it.type === 'address') && typeof it.id === 'string' && it.id.length < 200 && C.byId[it.net];
  }
  function loadW() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(v)) return [];
      v.forEach(function (it) {
        if (it && !it.net) it.net = 'bitcoin';
        if (it && it.last) {
          if (it.last.state === 'confirmed' && it.last.final === undefined) it.last.final = (it.last.conf || 0) >= 6;
          if (typeof it.last.bal === 'number') it.last.bal = C.fmt(it.last.bal, 8, 'BTC');
        }
      });
      return v.filter(validItem).slice(0, MAX_WATCH);
    } catch (e) { storageOK = false; return []; }
  }
  var watch = loadW();
  function saveW() { try { localStorage.setItem(KEY, JSON.stringify(watch)); storageOK = true; } catch (e) { storageOK = false; } }
  function findW(net, id) {
    for (var i = 0; i < watch.length; i++) if (watch[i].id === id && watch[i].net === net) return watch[i];
    return null;
  }
  function isFinalTx(it) { return it.type === 'tx' && it.last && it.last.final && (it.last.state === 'confirmed' || it.last.state === 'failed'); }
  function markDone(it) { if (isFinalTx(it) && !it.doneAt) it.doneAt = Date.now(); }
  function prune() {
    var n = watch.length, now = Date.now();
    watch = watch.filter(function (it) { return !(it.doneAt && now - it.doneAt > KEEP_MS); });
    if (watch.length !== n) saveW();
  }

  /* ---------- state ---------- */
  var cur = null, timer = null, prevPending = null, backAddr = null, curLast = null;

  function showError(t) { var m = $('msg'); m.textContent = t; m.hidden = false; }
  function clearError() { $('msg').hidden = true; }
  function hideResult() { $('result').hidden = true; }

  /* ---------- prices ---------- */
  var fiat = 'CAD';
  try { var f0 = localStorage.getItem(CUR_KEY); if (f0 === 'USD' || f0 === 'CAD') fiat = f0; } catch (e) { /* storage blocked: keep CAD */ }
  function eff() { return fiat === 'CAD' && P.has() && P.rate('CAD') === null ? 'USD' : fiat; }
  function addFx(parent, text) {
    var d = el('div', 'fx'); d.dataset.amt = text; d.hidden = true;
    parent.appendChild(d);
    return d;
  }
  function applyFiat() {
    var c = eff(), list = document.querySelectorAll('.fx'), any = false;
    for (var i = 0; i < list.length; i++) {
      var n = list[i], t = n.dataset.amt ? P.fiatText(n.dataset.amt, c) : '';
      n.textContent = t; n.hidden = !t;
      if (t) any = true;
    }
    $('fxNote').hidden = !any;
  }
  function chgText(g) { return (g >= 0 ? '▲ ' : '▼ ') + Math.abs(g).toFixed(2) + '%'; }
  function renderStrip() {
    var strip = $('pstrip');
    if (!P.enabled()) { strip.hidden = true; return; }
    strip.hidden = false;
    var net = C.byId[selected], c = eff();
    var pr = P.has() ? P.price(net.sym, c) : null, g = P.has() ? P.change(net.sym) : null;
    $('pName').textContent = net.name + ' (' + net.sym + ')';
    $('pPrice').textContent = pr === null ? (P.failed() ? 'Price unavailable' : 'Loading price…') : P.priceText(pr, c) + ' ' + c;
    $('pChg').textContent = pr === null || g === null ? '' : chgText(g) + ' 24h';
    $('pChg').className = 'pchg' + (pr === null || g === null ? '' : (g >= 0 ? ' up' : ' down'));
    var notes = [];
    if (pr !== null) notes.push('today\'s price');
    if (P.delayed()) notes.push('delayed');
    if (fiat === 'CAD' && c === 'USD') notes.push('CAD rate unavailable');
    $('pNote').textContent = notes.join(', ');
    $('curBtn').textContent = c;
  }
  function renderAllPrices() {
    var panel = $('allp'), box = $('pitems');
    if (!P.enabled()) { panel.hidden = true; return; }
    panel.hidden = false;
    box.textContent = '';
    var c = eff();
    C.NETS.forEach(function (n) {
      var b = el('button', 'prow'); b.type = 'button';
      b.setAttribute('aria-current', n.id === selected ? 'true' : 'false');
      var left = el('div', 'pl');
      left.appendChild(el('div', 'pn', n.name));
      left.appendChild(el('div', 'pm', n.sym));
      var right = el('div', 'pv'), p = P.has() ? P.price(n.sym, c) : null, g = P.has() ? P.change(n.sym) : null;
      right.appendChild(el('div', 'pp', p === null ? '–' : P.priceText(p, c)));
      if (p !== null && g !== null) right.appendChild(el('div', 'pchg ' + (g >= 0 ? 'up' : 'down'), chgText(g)));
      b.appendChild(left); b.appendChild(right);
      b.addEventListener('click', function () { pickNet(n.id); });
      box.appendChild(b);
    });
  }
  function syncCols() {
    $('rcols').className = 'rcols' + ($('outs').hidden && $('txlist').hidden ? ' solo' : '');
  }

  /* ---------- rendering ---------- */
  function setRows(rows) {
    var dl = $('rows'); dl.textContent = '';
    (rows || []).forEach(function (r) {
      var d = el('div', 'row');
      var dd = el('dd', null, r[1]);
      if (P.parseAmount(r[1])) addFx(dd, r[1]);
      d.appendChild(el('dt', null, r[0])); d.appendChild(dd);
      dl.appendChild(d);
    });
    dl.hidden = !(rows && rows.length);
  }
  function setPips(n) {
    var box = $('pips'), show = n !== null && n !== undefined;
    box.hidden = !show;
    var s = box.children;
    for (var i = 0; i < s.length; i++) s[i].className = show && i < n ? 'on' : '';
  }
  function setNote(t) { var n = $('sNote'); n.hidden = !t; n.textContent = t || ''; }
  function setHeader(c) {
    var net = C.byId[c.net];
    $('kind').textContent = net.name + (c.kind === 'tx' ? ' transaction' : ' address');
    $('idText').textContent = c.id;
    var x = $('ext');
    x.href = c.kind === 'tx' ? net.explorer.tx(c.id) : net.explorer.addr(c.id);
    x.textContent = 'Open in ' + net.explorer.name;
    $('back').hidden = !backAddr;
    $('result').hidden = false;
  }
  function updateWatchBar() {
    var on = cur && findW(cur.net, cur.id);
    $('wfield').hidden = !!on;
    $('wstate').hidden = !on;
    $('wbtn').textContent = on ? 'Stop watching' : 'Watch';
  }
  function checkedLine(v, c) {
    var net = C.byId[c.net];
    var now = new Date().toLocaleTimeString(undefined, { timeStyle: 'short' });
    var line = 'Data from ' + v.source + ', checked ' + now +
      (v.pending ? '. Refreshes every ' + Math.round(net.refreshMs / 1000) + ' seconds while pending.' : '.');
    return v.footNote ? v.footNote + ' ' + line : line;
  }
  function renderOuts(outs, title) {
    var box = $('outitems'); box.textContent = '';
    $('outsTitle').textContent = title || 'Outputs';
    (outs || []).forEach(function (o) {
      var tag = o.tag, mine = false;
      if (o.addr && backAddr && o.addr === backAddr) { tag = 'The address you were viewing'; mine = true; }
      else if (o.addr && findW(cur.net, o.addr)) { tag = 'On your watchlist'; mine = true; }
      else if (o.kind === 'payment') mine = true;
      var row = el('div', 'orow' + (mine ? ' mine' : ''));
      var left = el('div', 'oa');
      left.appendChild(el('div', 'oaddr', o.addr || 'Unknown'));
      if (tag) left.appendChild(el('div', 'otag', tag));
      row.appendChild(left);
      if (o.amount) { var amt = el('div', 'oamt', o.amount); addFx(amt, o.amount); row.appendChild(amt); }
      box.appendChild(row);
    });
    $('outs').hidden = !(outs && outs.length);
  }
  function renderTx(v, c) {
    setHeader(c);
    $('txlist').hidden = true;
    $('status').className = 'status ' + (v.state === 'failed' ? 'bad' : v.state);
    $('sBig').textContent = v.big;
    $('sFx').dataset.amt = '';
    $('sSmall').textContent = v.small;
    setPips(v.pips);
    setNote(v.note);
    setRows(v.rows);
    renderOuts(v.outs, v.outsTitle);
    $('foot').textContent = checkedLine(v, c);
    curLast = { state: v.state === 'failed' ? 'failed' : (v.pending ? 'pending' : 'confirmed'), conf: v.conf, final: !!v.final };
    syncCols(); applyFiat();
  }
  function renderAddr(v, c) {
    setHeader(c);
    $('outs').hidden = true;
    $('status').className = 'status ' + (v.pending ? 'pending' : 'done');
    $('sBig').textContent = v.big;
    $('sFx').dataset.amt = v.big;
    $('sSmall').textContent = v.small;
    setPips(null); setNote(v.note);
    setRows(v.rows);
    var list = $('txitems'); list.textContent = '';
    (v.txs || []).forEach(function (t) {
      var b = el('button', 'trow'); b.type = 'button';
      var left = el('div', 'tl');
      left.appendChild(el('div', 't1' + (t.pend ? ' p' : ''), t.left1));
      left.appendChild(el('div', 't2', t.left2));
      b.appendChild(left);
      if (t.amount) { var tr = el('div', 'tr' + (t.pos ? ' in' : ''), t.amount); addFx(tr, t.amount); b.appendChild(tr); }
      b.addEventListener('click', function () { start(t.id, c.id, c.net); window.scrollTo(0, 0); });
      list.appendChild(b);
    });
    $('txlist').hidden = !(v.txs && v.txs.length);
    $('foot').textContent = checkedLine(v, c);
    curLast = { state: v.pending ? 'pending' : 'ok', bal: v.big };
    syncCols(); applyFiat();
  }

  /* ---------- main flow ---------- */
  function msgFor(d) {
    if (d.error === 'ambiguous') return 'This format is used on ' + d.nets.join(', ') + '. Pick the network above, then tap Check.';
    if (d.error === 'invalid' && d.net) return 'That is not a valid ' + d.net + ' transaction ID or address.';
    return 'Enter a transaction ID or a wallet address for one of the networks above.';
  }
  function start(raw, back, forceNet, lock) {
    clearTimeout(timer); clearError(); resetTitle();
    if (forceNet) setSelected(forceNet);
    var d = C.detect(raw, selected, !!lock);
    if (d.error) { cur = null; hideResult(); showError(msgFor(d)); return; }
    if (d.net !== selected) setSelected(d.net);
    unlockAudio();
    $('txid').value = d.id; syncClear();
    cur = { net: d.net, kind: d.kind, id: d.id };
    prevPending = null; backAddr = back || null; curLast = null;
    $('wlabel').value = '';
    try { history.replaceState(null, '', '#' + d.net + '/' + d.id); } catch (e) { /* the address-bar update is cosmetic */ }
    run(cur, false);
  }

  async function run(c, quiet) {
    var net = C.byId[c.net];
    $('go').disabled = true;
    try {
      var v = c.kind === 'tx' ? await net.lookupTx(c.id) : await net.lookupAddr(c.id);
      if (!cur || cur.id !== c.id || cur.net !== c.net) return;
      if (c.kind === 'tx') renderTx(v, c); else renderAddr(v, c);
      updateWatchBar();
      syncWatch();
      if (prevPending === true && !v.pending) {
        chime();
        document.title = (c.kind === 'tx' ? '\u2713 Confirmed' : '\u2713 No longer pending') + ' \u2013 ' + DEFTITLE;
      }
      prevPending = v.pending;
      clearTimeout(timer);
      if (v.pending) timer = setTimeout(function () { run(c, true); }, net.refreshMs);
    } catch (e) {
      if (!cur || cur.id !== c.id || cur.net !== c.net) return;
      if (!quiet) hideResult();
      clearTimeout(timer);
      if (e.notFound) {
        if (c.kind === 'tx') {
          var others = C.NETS.filter(function (n) { return n.id !== c.net && n.matchTx(c.id); }).map(function (n) { return n.name; });
          showError('No transaction found on ' + net.name + '.' + (others.length
            ? ' IDs in this format also exist on ' + others.join(', ') + '. Pick another network above to try it.'
            : ' Check for a missing character, or it may not have been broadcast yet.'));
        } else showError('No record of that address on ' + net.name + '.');
      } else if (e.badRequest) showError('The ' + net.name + ' data source rejected that ' + (c.kind === 'tx' ? 'transaction ID' : 'address') + '. Check it for typos.');
      else showError('Could not reach the ' + net.name + ' data sources. Check your connection and try again. If it keeps failing for this network only, the source may be blocking the page.');
    } finally {
      if (cur && cur.id === c.id && cur.net === c.net) $('go').disabled = false;
    }
  }

  function clearAll() {
    clearTimeout(timer); cur = null; prevPending = null; backAddr = null; curLast = null;
    $('txid').value = ''; syncClear(); clearError(); hideResult(); resetTitle();
    $('go').disabled = false;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* the address-bar update is cosmetic */ }
  }
  function syncClear() { $('clr').hidden = !$('txid').value; }

  /* ---------- watchlist ---------- */
  function syncWatch() {
    if (!cur || !curLast) return;
    var it = findW(cur.net, cur.id);
    if (!it) return;
    it.last = curLast; it.checked = Date.now(); markDone(it); saveW(); renderWatch();
  }
  function addW() {
    if (!cur || findW(cur.net, cur.id)) return;
    if (watch.length >= MAX_WATCH) { showError('Watchlist is full (' + MAX_WATCH + '). Remove one first.'); return; }
    var it = { net: cur.net, type: cur.kind, id: cur.id, label: $('wlabel').value.trim().slice(0, 40), added: Date.now(), last: curLast, checked: Date.now() };
    markDone(it);
    watch.push(it); saveW(); renderWatch(); updateWatchBar();
  }
  function removeW(net, id) {
    watch = watch.filter(function (it) { return !(it.id === id && it.net === net); });
    saveW(); renderWatch(); updateWatchBar();
  }
  function chipText(it) {
    var l = it.last;
    if (!l) return 'Checking\u2026';
    if (l.state === 'pending') return it.type === 'tx' ? 'Pending' : 'Pending activity';
    if (l.state === 'failed') return 'Failed';
    if (l.state === 'confirmed') return l.final ? 'Confirmed' : (l.conf ? l.conf + (l.conf === 1 ? ' confirmation' : ' confirmations') : 'Confirmed');
    if (l.state === 'ok') return l.bal || '';
    if (l.state === 'missing') return 'Not found';
    return 'Unavailable';
  }
  function chipClass(it) {
    var s = it.last && it.last.state;
    return 'chip' + (s === 'pending' ? ' pending' : (s === 'confirmed' || s === 'ok') ? ' done' : s === 'failed' ? ' bad' : '');
  }
  function renderWatch() {
    var box = $('witems'); box.textContent = '';
    $('watch').hidden = watch.length === 0;
    watch.forEach(function (it) {
      var net = C.byId[it.net];
      var row = el('div', 'witem');
      var main = el('button', 'wmain'); main.type = 'button';
      var wl = el('div', 'wl');
      wl.appendChild(el('div', 'w1', it.label || (it.type === 'tx' ? 'Transaction ' : 'Address ') + C.short(it.id)));
      wl.appendChild(el('div', 'w2', net.name + (it.label ? ', ' + C.short(it.id) : '')));
      main.appendChild(wl); main.appendChild(el('div', chipClass(it), chipText(it)));
      main.addEventListener('click', function () { start(it.id, null, it.net); window.scrollTo(0, 0); });
      var x = el('button', 'wx', '\u00d7'); x.type = 'button'; x.setAttribute('aria-label', 'Remove from watchlist');
      x.addEventListener('click', function () { removeW(it.net, it.id); });
      row.appendChild(main); row.appendChild(x); box.appendChild(row);
    });
    var note = [];
    if (watch.length) note.push('Saved on this device only. Confirmed transactions drop off 7 days after they become final.');
    if (!storageOK) note.push('This browser is blocking saved lists, so the watchlist will be lost when you close the page.');
    $('wnote').textContent = note.join(' ');
  }
  var wbusy = false;
  async function refreshWatch(force) {
    if (wbusy) return;
    wbusy = true;
    try {
      prune();
      var now = Date.now();
      var todo = watch.filter(function (it) {
        if (isFinalTx(it)) return false;
        return force || now - (it.checked || 0) >= C.byId[it.net].watchMs;
      });
      var alerts = 0;
      for (var i = 0; i < todo.length; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map(async function (it) {
          var prev = it.last, nowS = await C.peek(it.net, it.type, it.id);
          if (nowS.state === 'unknown' && prev) return;
          it.last = nowS; it.checked = Date.now(); markDone(it);
          var fine = nowS.state === 'confirmed' || nowS.state === 'ok' || nowS.state === 'failed';
          if (prev && prev.state === 'pending' && fine && !(cur && cur.id === it.id && cur.net === it.net)) alerts++;
        }));
      }
      saveW(); renderWatch();
      if (alerts) { chime(); document.title = '\u2713 Watchlist update \u2013 ' + DEFTITLE; }
    } finally { wbusy = false; }
  }

  /* ---------- copy ---------- */
  function copyText(t, btn) {
    function ok() { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1200); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { /* clipboard blocked: nothing more to try */ }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, fallback);
    else fallback();
  }

  /* ---------- wiring ---------- */
  $('f').addEventListener('submit', function (ev) { ev.preventDefault(); start($('txid').value); });
  $('txid').addEventListener('input', syncClear);
  $('txid').addEventListener('focus', function () { var t = this; setTimeout(function () { t.select(); }, 0); });
  $('clr').addEventListener('click', function () { clearAll(); $('txid').focus(); });
  $('copyBtn').addEventListener('click', function () { if (cur) copyText(cur.id, this); });
  $('back').addEventListener('click', function (ev) { ev.preventDefault(); if (backAddr && cur) start(backAddr, null, cur.net); });
  $('wbtn').addEventListener('click', function () { if (cur && findW(cur.net, cur.id)) removeW(cur.net, cur.id); else addW(); });
  $('curBtn').addEventListener('click', function () {
    fiat = eff() === 'CAD' ? 'USD' : 'CAD';
    try { localStorage.setItem(CUR_KEY, fiat); } catch (e) { /* storage blocked: the choice just is not remembered */ }
    renderStrip(); renderAllPrices(); applyFiat();
  });
  $('wrefresh').addEventListener('click', function () { unlockAudio(); refreshWatch(true); });
  setInterval(function () { if (!document.hidden) refreshWatch(false); }, WATCH_TICK);

  renderNets();
  renderWatch();
  refreshWatch(false);
  if (window.matchMedia) $('allp').open = window.matchMedia('(min-width: 1000px)').matches;
  P.onUpdate(function () { renderStrip(); renderAllPrices(); applyFiat(); });
  renderStrip(); renderAllPrices();
  P.start();

  /* open from a link: #network/id, or an older #id link */
  var h = (location.hash || '').replace(/^#/, '');
  if (h) {
    var slash = h.indexOf('/'), hn = slash > 0 ? h.slice(0, slash) : null;
    if (hn && C.byId[hn]) start(h.slice(slash + 1), null, hn);
    else start(h);
  }
})();
