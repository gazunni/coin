/* chains.js (Chainwolf v0.4.2)
   One adapter per network. Every lookup returns a "view" object the page renders,
   so app.js never needs to know how a given chain works. */
(function (root) {
  'use strict';

  /* ---------- utilities ---------- */
  function toBig(x) {
    if (typeof x === 'bigint') return x;
    if (typeof x === 'number') return BigInt(Math.round(x));
    if (x === null || x === undefined || x === '' || x === '0x') return 0n;
    return BigInt(x);
  }
  function fmt(v, dec, sym, signed, maxFrac) {
    v = toBig(v);
    var neg = v < 0n; if (neg) v = -v;
    var s = v.toString();
    while (s.length <= dec) s = '0' + s;
    var ip = s.slice(0, s.length - dec), fp = dec ? s.slice(s.length - dec) : '';
    var mf = maxFrac === undefined ? Math.min(dec, 8) : Math.min(maxFrac, dec);
    var cut = fp.slice(0, mf).replace(/0+$/, '');
    var tiny = v > 0n && ip === '0' && cut === '';
    var body = tiny
      ? '<0.' + '0'.repeat(Math.max(mf - 1, 0)) + '1'
      : ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + (cut || '0');
    return (neg ? '\u2212' : (signed && v > 0n ? '+' : '')) + body + (sym ? ' ' + sym : '');
  }
  function short(id) { id = String(id || ''); return id.length > 18 ? id.slice(0, 8) + '\u2026' + id.slice(-6) : id; }
  function fmtTime(sec) { return new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function pipsFor(conf, fin) {
    if (conf >= fin) return 6;
    return Math.max(conf > 0 ? 1 : 0, Math.min(5, Math.round(conf / fin * 6)));
  }
  function NF() { var e = new Error('not found'); e.notFound = true; return e; }
  function BR() { var e = new Error('bad request'); e.badRequest = true; return e; }

  async function httpJSON(url, opts) {
    var r = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    if (r.status === 404) throw NF();
    if (r.status === 400) throw BR();
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function httpText(url) {
    var r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }
  function postJSON(url, body) {
    return httpJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  async function rpcFirst(urls, method, params) {
    var last = null;
    for (var i = 0; i < urls.length; i++) {
      try {
        var j = await postJSON(urls[i], { jsonrpc: '2.0', id: 1, method: method, params: params });
        if (j.error) throw new Error(j.error.message || 'rpc error');
        return j.result;
      } catch (e) { last = e; }
    }
    throw last || new Error('rpc failed');
  }
  async function tryEach(list, fn) {
    var last = null, soft = 0;
    for (var i = 0; i < list.length; i++) {
      try { return await fn(list[i]); }
      catch (e) { if (e.notFound || e.badRequest) soft++; last = e; }
    }
    if (soft === list.length) throw last;
    throw last || new Error('Lookup failed');
  }

  /* split outputs into payments and change (change = goes back to an input address) */
  function analyze(ins, outs, dec, sym) {
    var changeCount = 0, paid = 0n;
    outs.forEach(function (o) {
      o.change = !!(o.addr && ins[o.addr]);
      if (o.change) changeCount++; else paid += toBig(o.value);
    });
    return {
      changeCount: changeCount,
      paid: paid,
      outs: outs.map(function (o) {
        var kind = o.change ? 'change' : (changeCount > 0 ? 'payment' : 'other');
        return {
          addr: o.addr || (/op_return|nulldata/.test(o.type || '') ? 'Data (OP_RETURN)' : 'Non-standard output'),
          amount: fmt(o.value, dec, sym),
          kind: kind,
          tag: o.change ? 'Change (probably), back to an address that funded this transaction' : (changeCount > 0 ? 'Payment' : '')
        };
      })
    };
  }
  function confSmall(conf, fin) {
    return conf >= fin
      ? conf.toLocaleString() + ' confirmations. Generally considered final.'
      : conf + ' of ' + fin + ' confirmations. Larger amounts usually wait for ' + fin + '.';
  }

  /* ---------- base58 / sha256 (Tron addresses) ---------- */
  var ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function hexToBytes(h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
  function b58enc(bytes) {
    var n = 0n, i;
    for (i = 0; i < bytes.length; i++) n = n * 256n + BigInt(bytes[i]);
    var s = '';
    while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n = n / 58n; }
    for (i = 0; i < bytes.length && bytes[i] === 0; i++) s = '1' + s;
    return s;
  }
  function b58decHex(str) {
    var n = 0n, i;
    for (i = 0; i < str.length; i++) n = n * 58n + BigInt(ALPH.indexOf(str[i]));
    var hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
    for (i = 0; i < str.length && str[i] === '1'; i++) hex = '00' + hex;
    return hex;
  }
  async function sha256(bytes) {
    var c = root.crypto || (typeof require !== 'undefined' ? require('crypto').webcrypto : null);
    return new Uint8Array(await c.subtle.digest('SHA-256', bytes));
  }
  async function hexToB58Check(hex) {
    var b = hexToBytes(hex), h = await sha256(await sha256(b));
    var out = new Uint8Array(b.length + 4); out.set(b); out.set(h.slice(0, 4), b.length);
    return b58enc(out);
  }

  /* ================= Bitcoin (mempool.space, blockstream.info fallback) ================= */
  var BTC_APIS = [
    { name: 'mempool.space', base: 'https://mempool.space/api' },
    { name: 'blockstream.info', base: 'https://blockstream.info/api' }
  ];
  var btcTipCache = {};
  async function btcTip(api) {
    var c = btcTipCache[api.name], now = Date.now();
    if (c && now - c.t < 20000) return c.h;
    var h = parseInt(await httpText(api.base + '/blocks/tip/height'), 10);
    if (!isFinite(h)) throw new Error('bad tip');
    btcTipCache[api.name] = { t: now, h: h };
    return h;
  }
  function btcEta(rate, blocks) {
    if (!blocks || !blocks.length) return null;
    for (var i = 0; i < blocks.length; i++) {
      var lo = blocks[i].feeRange && blocks[i].feeRange[0];
      if (lo !== undefined && rate >= lo) return { n: i + 1 };
    }
    return { beyond: blocks.length };
  }
  async function btcTx(id) {
    var r = await tryEach(BTC_APIS, async function (api) {
      var tx = await httpJSON(api.base + '/tx/' + id);
      var tip = await btcTip(api), blocks = null;
      if (api.name === 'mempool.space' && !tx.status.confirmed) {
        try { blocks = await httpJSON(api.base + '/v1/fees/mempool-blocks'); } catch (e) { /* fee estimate is optional */ }
      }
      return { api: api, tx: tx, tip: tip, blocks: blocks };
    });
    var tx = r.tx, st = tx.status, fin = 6;
    var vsize = Math.ceil(tx.weight / 4), rate = tx.fee / vsize;
    var ins = {};
    tx.vin.forEach(function (v) { if (v.prevout && v.prevout.scriptpubkey_address) ins[v.prevout.scriptpubkey_address] = 1; });
    var total = tx.vout.reduce(function (s, o) { return s + BigInt(o.value); }, 0n);
    var an = analyze(ins, tx.vout.map(function (o) { return { addr: o.scriptpubkey_address || null, value: o.value, type: o.scriptpubkey_type }; }), 8, 'BTC');
    var pending = !st.confirmed, rows = [], v = { pending: pending, outs: an.outs, outsTitle: 'Outputs', source: r.api.name, note: '' };
    if (!pending) {
      var conf = Math.max(1, r.tip - st.block_height + 1);
      v.state = 'done'; v.big = 'Confirmed'; v.small = confSmall(conf, fin); v.conf = conf; v.final = conf >= fin; v.pips = pipsFor(conf, fin);
      rows.push(['Confirmations', conf.toLocaleString()], ['Block', '#' + st.block_height]);
      if (st.block_time) rows.push(['Confirmed at', fmtTime(st.block_time)]);
    } else {
      var e = btcEta(rate, r.blocks), rbf = tx.vin.some(function (x) { return x.sequence < 0xfffffffe; });
      var line = 'Waiting in the mempool.';
      if (e && e.n) line += ' At this fee rate it should land in about ' + (e.n * 10) + ' minutes (projected block ' + e.n + ').';
      else if (e && e.beyond) {
        line += ' This fee rate is below the next ' + e.beyond + ' projected blocks, so expect a long wait.';
        v.note = rbf ? 'If your wallet supports it, you can raise the fee (RBF) to speed this up.'
          : 'This transaction is not marked replaceable. Whoever receives an output, or you if you control one, can speed it up with a child-pays-for-parent (CPFP) transaction.';
      }
      v.state = 'pending'; v.big = 'Not confirmed yet'; v.small = line; v.conf = 0; v.final = false; v.pips = 0;
      rows.push(['Confirmations', '0'], ['Replaceable (RBF)', rbf ? 'Yes' : 'No']);
    }
    if (an.changeCount > 0 && an.paid > 0n) rows.push(['Amount sent', fmt(an.paid, 8, 'BTC')]);
    else rows.push(['Total output', fmt(total, 8, 'BTC')]);
    rows.push(['Fee rate', rate.toFixed(1) + ' sat/vB'], ['Fee paid', tx.fee.toLocaleString() + ' sats'], ['Size', vsize.toLocaleString() + ' vB'], ['Inputs / outputs', tx.vin.length + ' / ' + tx.vout.length]);
    v.rows = rows;
    return v;
  }
  async function btcAddr(addr) {
    var r = await tryEach(BTC_APIS, async function (api) {
      var info = await httpJSON(api.base + '/address/' + addr);
      var txs = await httpJSON(api.base + '/address/' + addr + '/txs');
      return { api: api, info: info, txs: txs, tip: await btcTip(api) };
    });
    var c = r.info.chain_stats, m = r.info.mempool_stats;
    var bal = c.funded_txo_sum - c.spent_txo_sum, pend = m.funded_txo_sum - m.spent_txo_sum, pending = m.tx_count > 0;
    var list = r.txs.map(function (tx) {
      var ok = tx.status.confirmed, conf = ok ? Math.max(1, r.tip - tx.status.block_height + 1) : 0, n = 0n;
      tx.vout.forEach(function (o) { if (o.scriptpubkey_address === addr) n += BigInt(o.value); });
      tx.vin.forEach(function (x) { if (x.prevout && x.prevout.scriptpubkey_address === addr) n -= BigInt(x.prevout.value); });
      return { id: tx.txid, pend: !ok, left1: ok ? plural(conf, 'confirmation') : 'Pending',
        left2: ok && tx.status.block_time ? fmtTime(tx.status.block_time) : short(tx.txid), amount: fmt(n, 8, 'BTC', true), pos: n > 0n };
    });
    var total = c.tx_count + m.tx_count, rows = [];
    if (pending) rows.push(['Pending (net)', fmt(pend, 8, 'BTC', true)]);
    rows.push(['Total received', fmt(c.funded_txo_sum, 8, 'BTC')], ['Transactions', total.toLocaleString()]);
    return {
      pending: pending, big: fmt(bal, 8, 'BTC'), rows: rows, txs: list, source: r.api.name,
      small: pending ? plural(m.tx_count, 'pending transaction') + ', net ' + fmt(pend, 8, 'BTC', true) + ' once confirmed.' : 'Confirmed balance. No pending transactions.',
      footNote: total > list.length ? 'Showing the latest ' + list.length + ' of ' + total.toLocaleString() + ' transactions.' : ''
    };
  }

  /* ================= Litecoin / Dogecoin / Bitcoin Cash (Blockchair) ================= */
  var BC = 'https://api.blockchair.com';
  async function bcTx(net, id) {
    var j = await httpJSON(BC + '/' + net.slug + '/dashboards/transaction/' + id);
    var data = j && j.data, d = data && !Array.isArray(data) ? (data[id] || data[Object.keys(data)[0]]) : null;
    if (!d || !d.transaction) throw NF();
    var t = d.transaction, tip = j.context && j.context.state, fin = net.final;
    var pending = !(t.block_id > 0), conf = pending ? 0 : (tip ? Math.max(1, tip - t.block_id + 1) : 1);
    var ins = {};
    (d.inputs || []).forEach(function (i) { if (i.recipient) ins[i.recipient] = 1; });
    var total = (d.outputs || []).reduce(function (s, o) { return s + toBig(o.value); }, 0n);
    var an = analyze(ins, (d.outputs || []).map(function (o) { return { addr: o.recipient || null, value: o.value, type: o.type }; }), 8, net.sym);
    var rows = [], v = { pending: pending, outs: an.outs, outsTitle: 'Outputs', source: 'Blockchair', note: '', conf: conf, final: conf >= fin };
    if (!pending) {
      v.state = 'done'; v.big = 'Confirmed'; v.small = confSmall(conf, fin); v.pips = pipsFor(conf, fin);
      rows.push(['Confirmations', conf.toLocaleString()], ['Block', '#' + t.block_id]);
      if (t.time) rows.push(['Confirmed at', fmtTime(Date.parse(String(t.time).replace(' ', 'T') + 'Z') / 1000)]);
    } else {
      v.state = 'pending'; v.big = 'Not confirmed yet'; v.small = 'Waiting in the mempool.'; v.pips = 0;
      rows.push(['Confirmations', '0']);
    }
    if (an.changeCount > 0 && an.paid > 0n) rows.push(['Amount sent', fmt(an.paid, 8, net.sym)]);
    else rows.push(['Total output', fmt(total, 8, net.sym)]);
    rows.push(['Fee paid', fmt(t.fee || 0, 8, net.sym)]);
    if (t.size) rows.push(['Size', t.size.toLocaleString() + ' bytes']);
    rows.push(['Inputs / outputs', (d.inputs || []).length + ' / ' + (d.outputs || []).length]);
    v.rows = rows;
    return v;
  }
  async function bcAddr(net, addr) {
    var j = await httpJSON(BC + '/' + net.slug + '/dashboards/address/' + addr + '?transaction_details=true&limit=25');
    var data = j && j.data, key = data && !Array.isArray(data) ? Object.keys(data)[0] : null, d = key ? data[key] : null;
    if (!d || !d.address) throw NF();
    var a = d.address, tip = j.context && j.context.state, pendN = 0, pendNet = 0n;
    var list = (d.transactions || []).map(function (t) {
      if (typeof t === 'string') t = { hash: t };
      var ok = t.block_id > 0, conf = ok && tip ? Math.max(1, tip - t.block_id + 1) : 0;
      if (t.block_id !== undefined && !ok) { pendN++; pendNet += toBig(t.balance_change); }
      var ts = t.time ? Date.parse(String(t.time).replace(' ', 'T') + 'Z') / 1000 : 0;
      var n = t.balance_change !== undefined ? toBig(t.balance_change) : null;
      return { id: t.hash, pend: t.block_id !== undefined && !ok,
        left1: ok ? plural(conf, 'confirmation') : (t.block_id !== undefined ? 'Pending' : 'Transaction'),
        left2: ts ? fmtTime(ts) : short(t.hash), amount: n === null ? '' : fmt(n, 8, net.sym, true), pos: n !== null && n > 0n };
    });
    var rows = [];
    if (pendN) rows.push(['Pending (net)', fmt(pendNet, 8, net.sym, true)]);
    rows.push(['Total received', fmt(a.received || 0, 8, net.sym)], ['Transactions', (a.transaction_count || 0).toLocaleString()]);
    return {
      pending: pendN > 0, big: fmt(a.balance || 0, 8, net.sym), rows: rows, txs: list, source: 'Blockchair',
      small: pendN ? plural(pendN, 'pending transaction') + ', net ' + fmt(pendNet, 8, net.sym, true) + ' once confirmed.' : 'Balance. No pending transactions.',
      footNote: (a.transaction_count || 0) > list.length ? 'Showing the latest ' + list.length + ' of ' + a.transaction_count.toLocaleString() + ' transactions.' : ''
    };
  }

  /* ================= Ethereum (public JSON-RPC) + USDT / USDC ================= */
  var ETH_RPC = ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'];
  var TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  var ETH_TOKENS = {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { sym: 'USDT', dec: 6 },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { sym: 'USDC', dec: 6 }
  };
  function ethRpc(m, p) { return rpcFirst(ETH_RPC, m, p); }
  async function ethTx(id) {
    var tx = await ethRpc('eth_getTransactionByHash', [id]);
    if (!tx) throw NF();
    var fin = 12, tip = parseInt(await ethRpc('eth_blockNumber', []), 16);
    var mined = !!tx.blockNumber, rcpt = null, blk = null, finNum = null;
    if (mined) {
      rcpt = await ethRpc('eth_getTransactionReceipt', [id]);
      if (rcpt) {
        blk = await ethRpc('eth_getBlockByNumber', [tx.blockNumber, false]);
        try { var fb = await ethRpc('eth_getBlockByNumber', ['finalized', false]); finNum = fb ? parseInt(fb.number, 16) : null; } catch (e) { /* finality check is optional: falls back to the confirmation count */ }
      } else mined = false;
    }
    var outs = [];
    if (toBig(tx.value) > 0n) outs.push({ addr: tx.to || '', amount: fmt(tx.value, 18, 'ETH'), kind: 'payment', tag: 'Payment' });
    function tokenOut(contract, to, amt) {
      var tk = ETH_TOKENS[String(contract).toLowerCase()];
      outs.push(tk
        ? { addr: to, amount: fmt(amt, tk.dec, tk.sym), kind: 'payment', tag: 'Payment (' + tk.sym + ' on Ethereum)' }
        : { addr: to, amount: 'Unrecognized token', kind: 'other', tag: 'Token contract ' + short(contract) + ' is not USDT or USDC. Verify before trusting it.' });
    }
    if (rcpt) {
      (rcpt.logs || []).forEach(function (lg) {
        if (lg.topics && lg.topics[0] === TRANSFER_TOPIC && lg.topics.length === 3) tokenOut(lg.address, '0x' + lg.topics[2].slice(26), toBig(lg.data));
      });
    } else if (/^0xa9059cbb/i.test(tx.input || '') && (tx.input || '').length >= 138) {
      tokenOut(tx.to, '0x' + tx.input.slice(34, 74), BigInt('0x' + tx.input.slice(74, 138)));
    }
    if (!outs.length) outs.push({ addr: tx.to || 'Contract creation', amount: fmt(0, 18, 'ETH'), kind: 'other', tag: 'Contract call' });
    var v = { pending: !mined, outs: outs, outsTitle: 'Transfers', source: 'Ethereum public node', note: '' }, rows = [];
    if (!mined) {
      v.state = 'pending'; v.big = 'Not confirmed yet'; v.small = 'Waiting to be included in a block.'; v.conf = 0; v.final = false; v.pips = 0;
      rows.push(['Confirmations', '0']);
      var mf = tx.maxFeePerGas || tx.gasPrice;
      if (mf) rows.push(['Max gas price', fmt(mf, 9, 'gwei', false, 2)]);
    } else {
      var bn = parseInt(tx.blockNumber, 16), conf = Math.max(1, tip - bn + 1), ok = rcpt.status === '0x1';
      var finalized = finNum !== null ? bn <= finNum : conf >= fin;
      v.conf = conf; v.final = finalized; v.pips = finalized ? 6 : pipsFor(conf, fin);
      if (ok) { v.state = 'done'; v.big = 'Confirmed'; v.small = plural(conf, 'confirmation') + '. ' + (finalized ? 'Finalized. Generally considered final.' : 'Ethereum finalizes after about 13 minutes.'); }
      else { v.state = 'failed'; v.big = 'Failed'; v.small = 'The transaction was mined but reverted. Any transfer did not happen, and the gas fee was still spent.'; }
      rows.push(['Confirmations', conf.toLocaleString()], ['Block', '#' + bn]);
      if (blk && blk.timestamp) rows.push(['Confirmed at', fmtTime(parseInt(blk.timestamp, 16))]);
      rows.push(['Finality', finalized ? 'Finalized' : 'Not yet finalized']);
      var gp = rcpt.effectiveGasPrice || tx.gasPrice;
      rows.push(['Fee paid', fmt(toBig(rcpt.gasUsed) * toBig(gp), 18, 'ETH', false, 8)], ['Gas price', fmt(gp, 9, 'gwei', false, 2)]);
    }
    rows.push(['From', tx.from]);
    v.rows = rows;
    return v;
  }
  async function ethAddr(addr) {
    var keys = Object.keys(ETH_TOKENS);
    var res = await Promise.all([ethRpc('eth_getBalance', [addr, 'latest'])].concat(keys.map(function (c) {
      return ethRpc('eth_call', [{ to: c, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
    }), [ethRpc('eth_getCode', [addr, 'latest']).catch(function () { return '0x'; })]));
    var code = res[keys.length + 1];
    var rows = [];
    keys.forEach(function (c, i) { rows.push([ETH_TOKENS[c].sym, fmt(res[i + 1], ETH_TOKENS[c].dec, ETH_TOKENS[c].sym)]); });
    return {
      pending: false, big: fmt(res[0], 18, 'ETH'), small: 'Balance. Token balances below.', rows: rows, txs: [],
      source: 'Ethereum public node',
      note: code && code !== '0x' ? 'This address is a smart contract, not a personal wallet. The balances are what the contract itself holds.' : '',
      footNote: 'Transaction history for Ethereum addresses needs a paid indexer, so only balances are shown. Paste a transaction ID to check a payment.'
    };
  }

  /* ================= Solana (public JSON-RPC) ================= */
  var SOL_RPC = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
  var SOL_TOKENS = {
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { sym: 'USDC', dec: 6 },
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { sym: 'USDT', dec: 6 }
  };
  function solRpc(m, p) { return rpcFirst(SOL_RPC, m, p); }
  async function solTx(id) {
    var st = await solRpc('getSignatureStatuses', [[id], { searchTransactionHistory: true }]);
    var s = st && st.value && st.value[0];
    if (!s) throw NF();
    var tx = null;
    try { tx = await solRpc('getTransaction', [id, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); } catch (e) { /* transaction details are optional: the status alone is enough */ }
    var level = s.confirmationStatus || 'processed', failed = !!s.err, outs = [], rows = [];
    if (tx && tx.meta) {
      var keys = tx.transaction.message.accountKeys.map(function (k) { return typeof k === 'string' ? k : k.pubkey; });
      var pre = tx.meta.preBalances || [], post = tx.meta.postBalances || [];
      post.forEach(function (p, i) {
        var delta = BigInt(p) - BigInt(pre[i] || 0);
        if (i === 0) delta += BigInt(tx.meta.fee || 0);
        if (delta > 0n) outs.push({ addr: keys[i], amount: fmt(delta, 9, 'SOL'), kind: 'payment', tag: 'Received' });
      });
      var preT = {};
      (tx.meta.preTokenBalances || []).forEach(function (b) { preT[b.accountIndex + ':' + b.mint] = toBig(b.uiTokenAmount.amount); });
      (tx.meta.postTokenBalances || []).forEach(function (b) {
        var diff = toBig(b.uiTokenAmount.amount) - (preT[b.accountIndex + ':' + b.mint] || 0n);
        if (diff <= 0n) return;
        var tk = SOL_TOKENS[b.mint], owner = b.owner || keys[b.accountIndex];
        outs.push(tk
          ? { addr: owner, amount: fmt(diff, tk.dec, tk.sym), kind: 'payment', tag: 'Received (' + tk.sym + ' on Solana)' }
          : { addr: owner, amount: 'Unrecognized token', kind: 'other', tag: 'Token ' + short(b.mint) + ' is not USDT or USDC. Verify before trusting it.' });
      });
      rows.push(['Fee payer', keys[0]], ['Fee', fmt(tx.meta.fee || 0, 9, 'SOL')]);
    }
    var v = { pending: level !== 'finalized', outs: outs, outsTitle: 'Transfers', source: 'Solana public node', note: '', conf: null, final: level === 'finalized' };
    if (failed) { v.state = 'failed'; v.big = 'Failed'; v.small = 'The transaction was recorded but failed, so its transfers did not happen. The fee was still charged.'; v.pips = level === 'finalized' ? 6 : 3; }
    else if (level === 'processed') { v.state = 'pending'; v.big = 'Not confirmed yet'; v.small = 'Seen by the network, waiting for confirmation.'; v.pips = 2; }
    else if (level === 'confirmed') { v.state = 'done'; v.big = 'Confirmed'; v.small = 'Confirmed by the network. Finalizing, usually within a minute.'; v.pips = 4; }
    else { v.state = 'done'; v.big = 'Confirmed'; v.small = 'Finalized. Generally considered final.'; v.pips = 6; }
    var head = [['Confirmation level', level.charAt(0).toUpperCase() + level.slice(1)], ['Slot', Number(s.slot).toLocaleString()]];
    if (tx && tx.blockTime) head.push(['Confirmed at', fmtTime(tx.blockTime)]);
    v.rows = head.concat(rows);
    return v;
  }
  async function solAddr(addr) {
    var mints = Object.keys(SOL_TOKENS);
    var res = await Promise.all([
      solRpc('getBalance', [addr]),
      solRpc('getSignaturesForAddress', [addr, { limit: 25 }])
    ].concat(mints.map(function (m) { return solRpc('getTokenAccountsByOwner', [addr, { mint: m }, { encoding: 'jsonParsed' }]); })));
    var sigs = res[1] || [], pendN = 0, rows = [];
    mints.forEach(function (m, i) {
      var sum = 0n, dec = SOL_TOKENS[m].dec;
      ((res[i + 2] && res[i + 2].value) || []).forEach(function (a) { sum += toBig(a.account.data.parsed.info.tokenAmount.amount); });
      rows.push([SOL_TOKENS[m].sym, fmt(sum, dec, SOL_TOKENS[m].sym)]);
    });
    var list = sigs.map(function (x) {
      var fin = x.confirmationStatus === 'finalized';
      if (!fin && !x.err) pendN++;
      return { id: x.signature, pend: !fin && !x.err, left1: x.err ? 'Failed' : (fin ? 'Finalized' : 'Pending'),
        left2: x.blockTime ? fmtTime(x.blockTime) : short(x.signature), amount: '', pos: false };
    });
    return {
      pending: pendN > 0, big: fmt((res[0] && res[0].value) || 0, 9, 'SOL'), small: pendN ? plural(pendN, 'transaction') + ' not yet finalized.' : 'Balance. Token balances below.',
      rows: rows, txs: list, source: 'Solana public node', footNote: 'Amounts are not shown in this list. Tap a transaction to see them.'
    };
  }

  /* ================= XRP Ledger (public JSON-RPC) ================= */
  var XRP_RPC = ['https://s1.ripple.com:51234/', 'https://s2.ripple.com:51234/', 'https://xrplcluster.com/'];
  var XRP_EPOCH = 946684800;
  async function xrpCall(method, params) {
    var last = null;
    for (var i = 0; i < XRP_RPC.length; i++) {
      try {
        var j = await postJSON(XRP_RPC[i], { method: method, params: [params] });
        if (!j || !j.result) throw new Error('bad response');
        return j.result;
      } catch (e) { last = e; }
    }
    throw last || new Error('XRP lookup failed');
  }
  function xrpCurrency(c) {
    if (c && c.length === 40) { var s = ''; for (var i = 0; i < 40; i += 2) { var n = parseInt(c.substr(i, 2), 16); if (n > 31 && n < 127) s += String.fromCharCode(n); } return s || c; }
    return c;
  }
  function xrpAmt(a) { return typeof a === 'string' ? fmt(a, 6, 'XRP', false, 6) : (a ? a.value + ' ' + xrpCurrency(a.currency) : ''); }
  async function xrpTx(id) {
    var r = await xrpCall('tx', { transaction: id.toUpperCase(), binary: false });
    if (r.error === 'txnNotFound') throw NF();
    if (r.error === 'invalidParams') throw BR();
    if (r.error) throw new Error(r.error);
    var validated = r.validated === true, code = r.meta && r.meta.TransactionResult;
    var amt = (r.meta && r.meta.delivered_amount) || r.Amount, outs = [], rows = [];
    if (r.TransactionType === 'Payment' && r.Destination) {
      outs.push({ addr: r.Destination, amount: xrpAmt(amt), kind: 'payment',
        tag: 'Payment' + (r.DestinationTag !== undefined ? ', destination tag ' + r.DestinationTag : '') });
    }
    var v = { pending: !validated, outs: outs, outsTitle: 'Transfers', source: 'XRP Ledger public server', note: '', conf: null, final: validated };
    if (!validated) { v.state = 'pending'; v.big = 'Not confirmed yet'; v.small = 'Submitted, waiting for the ledger to validate it.'; v.pips = 0; }
    else if (code === 'tesSUCCESS') { v.state = 'done'; v.big = 'Confirmed'; v.small = 'Validated in ledger ' + r.ledger_index + '. XRP Ledger transactions are final once validated.'; v.pips = 6; }
    else { v.state = 'failed'; v.big = 'Failed'; v.small = 'The ledger recorded the result ' + code + '. The transfer did not happen, but the fee was still charged.'; v.pips = 6; }
    rows.push(['Type', r.TransactionType]);
    if (code) rows.push(['Result', code]);
    if (validated) rows.push(['Ledger', '#' + r.ledger_index]);
    if (r.date) rows.push(['Confirmed at', fmtTime(r.date + XRP_EPOCH)]);
    rows.push(['From', r.Account]);
    if (r.DestinationTag !== undefined) rows.push(['Destination tag', String(r.DestinationTag)]);
    rows.push(['Fee', fmt(r.Fee || 0, 6, 'XRP', false, 6)]);
    v.rows = rows;
    return v;
  }
  async function xrpAddr(addr) {
    var res = await Promise.all([
      xrpCall('account_info', { account: addr, ledger_index: 'validated' }),
      xrpCall('account_tx', { account: addr, limit: 25, ledger_index_min: -1, ledger_index_max: -1 })
    ]);
    var info = res[0], atx = res[1];
    if (info.error && info.error !== 'actNotFound') { if (info.error === 'actMalformed') throw BR(); throw new Error(info.error); }
    var unfunded = info.error === 'actNotFound';
    var bal = unfunded ? 0n : toBig(info.account_data.Balance), pendN = 0;
    var list = ((atx && atx.transactions) || []).map(function (x) {
      var p = x.tx || x.tx_json || {}, d = (x.meta && x.meta.delivered_amount) || p.Amount, n = null, sign = '';
      var fee = toBig(p.Fee || 0);
      if (p.TransactionType === 'Payment' && typeof d === 'string') {
        if (p.Destination === addr && p.Account !== addr) n = toBig(d);
        else if (p.Account === addr && p.Destination !== addr) n = -(toBig(d) + fee);
        else n = -fee;
      } else if (p.Account === addr) n = -fee;
      var iou = p.TransactionType === 'Payment' && d && typeof d !== 'string';
      if (iou) sign = (p.Destination === addr ? '+' : '\u2212') + xrpAmt(d);
      if (!x.validated) pendN++;
      return { id: p.hash, pend: !x.validated, left1: x.validated ? (p.TransactionType || 'Transaction') : 'Pending',
        left2: p.date ? fmtTime(p.date + XRP_EPOCH) : short(p.hash), amount: iou ? sign : (n === null ? '' : fmt(n, 6, 'XRP', true, 6)), pos: iou ? p.Destination === addr : (n !== null && n > 0n) };
    });
    return {
      pending: pendN > 0, big: fmt(bal, 6, 'XRP', false, 6), small: unfunded ? 'This account has not been activated (never funded).' : 'Balance.',
      rows: [], txs: list, source: 'XRP Ledger public server', footNote: ''
    };
  }

  /* ================= Tron (TronGrid) + USDT / USDC ================= */
  var TRX = 'https://api.trongrid.io';
  var TRC20 = {
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': { sym: 'USDT', dec: 6 },
    'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8': { sym: 'USDC', dec: 6 }
  };
  var TRX_TYPES = {
    TransferContract: 'TRX transfer', TransferAssetContract: 'Token transfer (TRC-10)',
    TriggerSmartContract: 'Smart contract call', CreateSmartContract: 'Contract created'
  };
  function friendlyTronType(t) {
    if (!t) return '';
    return TRX_TYPES[t] || t.replace(/Contract$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  }
  async function trxTx(id) {
    var t = await postJSON(TRX + '/wallet/gettransactionbyid', { value: id, visible: true });
    if (!t || !t.txID) throw NF();
    var info = await postJSON(TRX + '/wallet/gettransactioninfobyid', { value: id });
    var bn = info && info.blockNumber, fin = 19, conf = 0;
    if (bn) {
      var nb = await postJSON(TRX + '/wallet/getnowblock', {});
      var tip = nb && nb.block_header && nb.block_header.raw_data && nb.block_header.raw_data.number;
      conf = tip ? Math.max(1, tip - bn + 1) : 1;
    }
    var c = t.raw_data && t.raw_data.contract && t.raw_data.contract[0];
    var val = (c && c.parameter && c.parameter.value) || {}, outs = [];
    if (c && c.type === 'TransferContract') {
      outs.push({ addr: val.to_address, amount: fmt(val.amount, 6, 'TRX', false, 6), kind: 'payment', tag: 'Payment' });
    } else if (c && c.type === 'TriggerSmartContract' && /^a9059cbb/i.test(val.data || '') && val.data.length >= 136) {
      var to = await hexToB58Check('41' + val.data.slice(32, 72)), amt = BigInt('0x' + val.data.slice(72, 136)), tk = TRC20[val.contract_address];
      outs.push(tk
        ? { addr: to, amount: fmt(amt, tk.dec, tk.sym), kind: 'payment', tag: 'Payment (' + tk.sym + ' on Tron)' }
        : { addr: to, amount: 'Unrecognized token', kind: 'other', tag: 'Token contract ' + short(val.contract_address) + ' is not USDT or USDC. Verify before trusting it.' });
    } else {
      outs.push({ addr: val.contract_address || val.to_address || '', amount: '', kind: 'other', tag: friendlyTronType(c && c.type) || 'Contract call' });
    }
    var res = (t.ret && t.ret[0] && t.ret[0].contractRet) || (info && info.receipt && info.receipt.result) || '';
    var failed = !!bn && !!res && res !== 'SUCCESS';
    var v = { pending: !bn, outs: outs, outsTitle: 'Transfers', source: 'TronGrid', note: '', conf: conf, final: conf >= fin }, rows = [];
    if (!bn) { v.state = 'pending'; v.big = 'Not confirmed yet'; v.small = 'Broadcast, waiting to be included in a block.'; v.pips = 0; rows.push(['Confirmations', '0']); }
    else if (failed) { v.state = 'failed'; v.big = 'Failed'; v.small = 'The transaction was recorded as ' + res + '. The transfer did not happen, but fees were still spent.'; v.pips = pipsFor(conf, fin); }
    else { v.state = 'done'; v.big = 'Confirmed'; v.small = confSmall(conf, fin); v.pips = pipsFor(conf, fin); }
    if (bn) {
      rows.push(['Confirmations', conf.toLocaleString()], ['Block', '#' + bn]);
      if (info.blockTimeStamp) rows.push(['Confirmed at', fmtTime(info.blockTimeStamp / 1000)]);
      rows.push(['Fee', fmt(info.fee || 0, 6, 'TRX', false, 6)]);
    }
    if (val.owner_address) rows.push(['From', val.owner_address]);
    v.rows = rows;
    return v;
  }
  async function trxAddr(addr) {
    var res = await Promise.all([
      httpJSON(TRX + '/v1/accounts/' + addr),
      httpJSON(TRX + '/v1/accounts/' + addr + '/transactions?limit=25'),
      httpJSON(TRX + '/v1/accounts/' + addr + '/transactions/trc20?limit=25'),
      postJSON(TRX + '/wallet/getcontract', { value: addr, visible: true }).catch(function () { return null; })
    ]);
    var ct = res[3], isContract = !!(ct && (ct.contract_address || ct.bytecode || ct.origin_address));
    var acct = res[0] && res[0].data && res[0].data[0], rows = [];
    var myHex = b58decHex(addr).slice(0, 42).toLowerCase();
    var items = [];
    ((res[1] && res[1].data) || []).forEach(function (t) {
      var c = t.raw_data && t.raw_data.contract && t.raw_data.contract[0], vv = (c && c.parameter && c.parameter.value) || {}, n = null;
      if (c && c.type === 'TransferContract') {
        if (String(vv.owner_address).toLowerCase() === myHex) n = -toBig(vv.amount);
        else if (String(vv.to_address).toLowerCase() === myHex) n = toBig(vv.amount);
      }
      items.push({ id: t.txID, ts: t.block_timestamp || 0, left1: friendlyTronType(c && c.type) || 'Transaction',
        amount: n === null ? '' : fmt(n, 6, 'TRX', true, 6), pos: n !== null && n > 0n });
    });
    ((res[2] && res[2].data) || []).forEach(function (t) {
      var ti = t.token_info || {}, tk = TRC20[ti.address], dec = tk ? tk.dec : Number(ti.decimals || 0), sym = tk ? tk.sym : 'unverified ' + (ti.symbol || 'token');
      var incoming = t.to === addr;
      items.push({ id: t.transaction_id, ts: t.block_timestamp || 0, left1: tk ? tk.sym + ' transfer' : 'Unverified token transfer',
        amount: (incoming ? '+' : '\u2212') + fmt(t.value, dec, sym, false, 6), pos: incoming });
    });
    items.sort(function (a, b) { return b.ts - a.ts; });
    var seen = {}, list = [];
    items.forEach(function (x) { if (!seen[x.id + x.amount] && list.length < 25) { seen[x.id + x.amount] = 1; list.push({ id: x.id, pend: false, left1: x.left1, left2: x.ts ? fmtTime(x.ts / 1000) : short(x.id), amount: x.amount, pos: x.pos }); } });
    Object.keys(TRC20).forEach(function (k) {
      var bal = 0n;
      ((acct && acct.trc20) || []).forEach(function (o) { if (o[k] !== undefined) bal = toBig(o[k]); });
      rows.push([TRC20[k].sym, fmt(bal, TRC20[k].dec, TRC20[k].sym)]);
    });
    return {
      pending: false, big: fmt((acct && acct.balance) || 0, 6, 'TRX', false, 6), small: acct ? 'Balance. Token balances below.' : 'This account has not been activated (never received anything).',
      rows: rows, txs: list, source: 'TronGrid', footNote: 'Only confirmed activity is listed here.',
      note: isContract ? 'This address is a smart contract' + (ct.name ? ' (' + ct.name + ')' : '') + ', not a personal wallet. The balances are what the contract itself holds, and the list shows calls made to it.' : ''
    };
  }

  /* ================= network registry and detection ================= */
  var HEX64 = /^[0-9a-fA-F]{64}$/, B58C = '[1-9A-HJ-NP-Za-km-z]';
  var RX = {
    btcLegacy: new RegExp('^[13]' + B58C + '{25,34}$'),
    ltcLegacy: new RegExp('^[LM]' + B58C + '{26,33}$'),
    ltcP2sh: new RegExp('^3' + B58C + '{25,34}$'),
    dogeAny: new RegExp('^[DA9]' + B58C + '{25,34}$'),
    bchCash: /^(bitcoincash:)?[qp][a-z0-9]{41}$/,
    sol: new RegExp('^' + B58C + '{32,44}$'),
    solStrict: new RegExp('^' + B58C + '{43,44}$'),
    solSig: new RegExp('^' + B58C + '{86,90}$'),
    tron: new RegExp('^T' + B58C + '{33}$'),
    xrp: new RegExp('^r' + B58C + '{24,34}$'),
    ethTx: /^0x[0-9a-fA-F]{64}$/,
    ethAddr: /^0x[0-9a-fA-F]{40}$/
  };
  function bech(prefix, s) {
    var l = s.toLowerCase();
    if (s !== l && s !== s.toUpperCase()) return null;
    return new RegExp('^' + prefix + '1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,100}$').test(l) ? l : null;
  }
  function lowerHex64(s) { return HEX64.test(s) ? s.toLowerCase() : null; }

  var NETS = [
    { id: 'bitcoin', name: 'Bitcoin', sym: 'BTC', final: 6, refreshMs: 30000, watchMs: 60000,
      explorer: { name: 'mempool.space', tx: function (i) { return 'https://mempool.space/tx/' + i; }, addr: function (i) { return 'https://mempool.space/address/' + i; } },
      matchTx: lowerHex64,
      matchAddr: function (s) { return RX.btcLegacy.test(s) ? s : bech('bc', s); },
      lookupTx: btcTx, lookupAddr: btcAddr },
    { id: 'ethereum', name: 'Ethereum', sym: 'ETH', final: 12, refreshMs: 30000, watchMs: 60000,
      explorer: { name: 'Etherscan', tx: function (i) { return 'https://etherscan.io/tx/' + i; }, addr: function (i) { return 'https://etherscan.io/address/' + i; } },
      matchTx: function (s) { return RX.ethTx.test(s) ? s.toLowerCase() : null; },
      matchAddr: function (s) { return RX.ethAddr.test(s) ? s.toLowerCase() : null; },
      lookupTx: ethTx, lookupAddr: ethAddr },
    { id: 'solana', name: 'Solana', sym: 'SOL', final: 1, refreshMs: 20000, watchMs: 60000,
      explorer: { name: 'Solscan', tx: function (i) { return 'https://solscan.io/tx/' + i; }, addr: function (i) { return 'https://solscan.io/account/' + i; } },
      matchTx: function (s) { return RX.solSig.test(s) ? s : null; },
      matchAddr: function (s, strict) { return (strict ? RX.solStrict : RX.sol).test(s) ? s : null; },
      lookupTx: solTx, lookupAddr: solAddr },
    { id: 'tron', name: 'Tron', sym: 'TRX', final: 19, refreshMs: 30000, watchMs: 60000,
      explorer: { name: 'Tronscan', tx: function (i) { return 'https://tronscan.org/#/transaction/' + i; }, addr: function (i) { return 'https://tronscan.org/#/address/' + i; } },
      matchTx: lowerHex64,
      matchAddr: function (s) { return RX.tron.test(s) ? s : null; },
      lookupTx: trxTx, lookupAddr: trxAddr },
    { id: 'xrp', name: 'XRP', sym: 'XRP', final: 1, refreshMs: 15000, watchMs: 60000,
      explorer: { name: 'XRPSCAN', tx: function (i) { return 'https://xrpscan.com/tx/' + i; }, addr: function (i) { return 'https://xrpscan.com/account/' + i; } },
      matchTx: function (s) { return HEX64.test(s) ? s.toUpperCase() : null; },
      matchAddr: function (s) { return RX.xrp.test(s) ? s : null; },
      lookupTx: xrpTx, lookupAddr: xrpAddr },
    { id: 'litecoin', name: 'Litecoin', sym: 'LTC', slug: 'litecoin', final: 12, refreshMs: 90000, watchMs: 300000,
      explorer: { name: 'Blockchair', tx: function (i) { return 'https://blockchair.com/litecoin/transaction/' + i; }, addr: function (i) { return 'https://blockchair.com/litecoin/address/' + i; } },
      matchTx: lowerHex64,
      matchAddr: function (s, strict) { return RX.ltcLegacy.test(s) ? s : (!strict && RX.ltcP2sh.test(s) ? s : bech('ltc', s)); } },
    { id: 'dogecoin', name: 'Dogecoin', sym: 'DOGE', slug: 'dogecoin', final: 20, refreshMs: 90000, watchMs: 300000,
      explorer: { name: 'Blockchair', tx: function (i) { return 'https://blockchair.com/dogecoin/transaction/' + i; }, addr: function (i) { return 'https://blockchair.com/dogecoin/address/' + i; } },
      matchTx: lowerHex64,
      matchAddr: function (s) { return RX.dogeAny.test(s) ? s : null; } },
    { id: 'bitcoin-cash', name: 'Bitcoin Cash', sym: 'BCH', slug: 'bitcoin-cash', final: 6, refreshMs: 90000, watchMs: 300000,
      explorer: { name: 'Blockchair', tx: function (i) { return 'https://blockchair.com/bitcoin-cash/transaction/' + i; }, addr: function (i) { return 'https://blockchair.com/bitcoin-cash/address/' + i; } },
      matchTx: lowerHex64,
      matchAddr: function (s, strict) { return RX.bchCash.test(s) ? s.replace(/^bitcoincash:/, '') : (!strict && RX.btcLegacy.test(s) ? s : null); } }
  ];
  var byId = {};
  NETS.forEach(function (n) {
    byId[n.id] = n;
    if (n.slug) {
      n.lookupTx = function (id) { return bcTx(n, id); };
      n.lookupAddr = function (a) { return bcAddr(n, a); };
    }
  });

  function tryNet(n, s, strict) {
    var t = n.matchTx(s, strict);
    if (t) return { net: n.id, kind: 'tx', id: t };
    var a = n.matchAddr(s, strict);
    if (a) return { net: n.id, kind: 'address', id: a };
    return null;
  }
  /* lock = only accept the selected network (used when the person taps a network chip) */
  function detect(raw, selId, lock) {
    var s = String(raw || '').trim();
    if (!s) return { error: 'empty' };
    var sel = byId[selId] || NETS[0];
    var r = tryNet(sel, s, false);
    if (r) return r;
    if (lock) return { error: 'invalid', net: sel.name };
    var hits = [];
    NETS.forEach(function (n) { if (n !== sel) { var x = tryNet(n, s, true); if (x) hits.push(x); } });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return { error: 'ambiguous', nets: hits.map(function (h) { return byId[h.net].name; }) };
    return { error: 'invalid' };
  }

  /* light status check used by the watchlist */
  async function peek(netId, type, id) {
    var n = byId[netId];
    try {
      if (type === 'tx') {
        var v = await n.lookupTx(id);
        return { state: v.state === 'failed' ? 'failed' : (v.pending ? 'pending' : 'confirmed'), conf: v.conf, final: !!v.final };
      }
      var a = await n.lookupAddr(id);
      return { state: a.pending ? 'pending' : 'ok', bal: a.big };
    } catch (e) { return { state: e.notFound ? 'missing' : 'unknown' }; }
  }

  var api = { NETS: NETS, byId: byId, detect: detect, peek: peek, fmt: fmt, short: short, _b58: { enc: b58enc, decHex: b58decHex, hexToB58Check: hexToB58Check, hexToBytes: hexToBytes } };
  root.Chains = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
