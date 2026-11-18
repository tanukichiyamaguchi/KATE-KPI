/* コントラスト監査（WCAG 2.x 1.4.3 文字のコントラスト・1.4.11 フォーカスリング）。
 * 実際のダッシュボード（同梱サンプル・あなた＝momo）をヘッドレス Chromium で開き、
 * 390px／1280px × ライト／ダーク で、すべてのタブと切り替えを表示して測る:
 *   ホーム／お店（売上・予約／リピート／曜日・時間、曜日別の4指標）／スタッフ（momo・aoi・比較）／
 *   顧客（呼び戻し候補だけ表示も）／データ（管理画面・成功と失敗のトースト）と、
 *   未接続の警告バナー（data/shared-link.json がある端末）。
 *
 *  1. 見えている HTML の文字（SVG は除く）ごとに、計算後の文字色と、実際にその下に
 *     塗られている背景（祖先の背景色を、半透明・opacity も含めてページの背景の上に
 *     重ねたもの）のコントラスト比を出す。
 *     通常の文字は 4.5:1 以上、大きい文字（24px 以上、または 18.66px 以上で太さ 700 以上）は 3:1 以上。
 *     閉じている <details> は開いて測り、入力欄の値・placeholder も同じ基準で測る。
 *     背景画像・グラデーションの上の文字は計算できないので、数えて件数を表示する（スキップ）。
 *     切り替えのボタンが見つからない・画面がほとんど描かれていない・ページのエラーも失敗にする。
 *  2. :focus-visible のリング（と .field / .me-pick の focus-within、.sheet-input）の色が、
 *     カード・ページ・実際の周囲の背景に対して 3:1 以上で、半透明でなく、
 *     overflow で切り取られる行（顧客のグループ一覧・並べ替えの見出し・スタッフ選択の行）でも
 *     リングが欠けないこと。
 *
 * テーマはアプリが prefers-color-scheme を見て <html data-theme> を付ける。ダークは
 * ブラウザの colorScheme を dark にして開き、data-theme="dark" とページ背景が黒に
 * なったことを確かめてから測る（付かなければ失敗にする）。
 * Run: node tests/contrast-audit.js（playwright-core / Chromium が無い環境では SKIP） */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (e) { /* not installed */ }
const EXEC = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
if (!chromium || !fs.existsSync(EXEC)) {
  console.log('CONTRAST AUDIT: SKIP (playwright-core / Chromium not available)');
  process.exit(0);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const server = http.createServer(function (req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  // 合言葉・管理ロックは無効（v:0 相当）にして、データタブの管理画面まで表示する
  if (urlPath === '/data/owner-lock.json' || urlPath === '/data/shared-link.json' || urlPath === '/favicon.ico') { res.writeHead(404); res.end(); return; }
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const WIDTHS = [390, 1280];
const SCHEMES = ['light', 'dark'];
// 表示する画面（ビュー＋タブ内の切り替え）。順に操作するので、前の操作の状態を引き継ぐ。
const STATES = [
  { name: '#home', view: 'home' },
  { name: '#overview>sales', view: 'overview', seg: ['storeSeg', 'sales'] },
  { name: '#overview>repeat', view: 'overview', seg: ['storeSeg', 'repeat'] },
  { name: '#overview>time', view: 'overview', seg: ['storeSeg', 'time'] },
  { name: '#overview>time>来店数', view: 'overview', dow: 'visits' },
  { name: '#overview>time>次回予約率', view: 'overview', dow: 'nextRes' },
  { name: '#overview>time>客単価', view: 'overview', dow: 'spend' },
  { name: '#overview>time>LTV', view: 'overview', dow: 'ltv' },
  { name: '#staff>momo', view: 'staff', seg: ['staffSeg', 'momo'] },
  { name: '#staff>aoi', view: 'staff', seg: ['staffSeg', 'aoi'] },
  { name: '#staff>比較', view: 'staff', seg: ['staffSeg', '__compare'] },
  { name: '#rfm', view: 'rfm' },
  { name: '#rfm>呼び戻し候補だけ', view: 'rfm', toggle: '#rfmCallbackToggle' },
  { name: '#data', view: 'data' }
];

// ---- ページ内で動かす測定（ES5・ページの文脈で実行） ----------------------------
function pageAudit(opts) {
  var cache = new Map();
  var cv = document.createElement('canvas'); cv.width = cv.height = 1;
  var cx = cv.getContext('2d', { willReadFrequently: true });
  function num(t, scale) { return /%$/.test(t) ? parseFloat(t) / 100 * scale : parseFloat(t); }
  function parseColor(s) {
    s = String(s || '').trim();
    if (!s || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    var m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      var p = m[1].split(/[\s,/]+/).filter(Boolean);
      return { r: num(p[0], 255), g: num(p[1], 255), b: num(p[2], 255), a: p[3] != null ? num(p[3], 1) : 1 };
    }
    m = /^color\(srgb\s+([^)]+)\)$/i.exec(s);
    if (m) {
      var q = m[1].split(/[\s/]+/).filter(Boolean);
      return { r: num(q[0], 1) * 255, g: num(q[1], 1) * 255, b: num(q[2], 1) * 255, a: q[3] != null ? num(q[3], 1) : 1 };
    }
    // それ以外の書式（oklab など）はキャンバスに塗って読み戻す
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1);
    var d = cx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  }
  // 乗算済みアルファ（0〜1）で重ねる
  function pm(c) { return { r: c.r / 255 * c.a, g: c.g / 255 * c.a, b: c.b / 255 * c.a, a: c.a }; }
  function over(top, bottom) { var k = 1 - top.a; return { r: top.r + bottom.r * k, g: top.g + bottom.g * k, b: top.b + bottom.b * k, a: top.a + bottom.a * k }; }
  function fade(c, o) { return { r: c.r * o, g: c.g * o, b: c.b * o, a: c.a * o }; }
  function unpm(c) { return c.a > 0 ? { r: c.r / c.a * 255, g: c.g / c.a * 255, b: c.b / c.a * 255 } : { r: 0, g: 0, b: 0 }; }
  function lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lum(c) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
  function ratio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function hex(c) { return '#' + [c.r, c.g, c.b].map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join(''); }
  var WHITE = { r: 1, g: 1, b: 1, a: 1 };   // ブラウザのキャンバスの地
  function styleOf(e) {
    var s = cache.get(e);
    if (!s) {
      var cs = getComputedStyle(e);
      s = { bg: pm(parseColor(cs.backgroundColor)), op: parseFloat(cs.opacity), img: !!cs.backgroundImage && cs.backgroundImage !== 'none' };
      cache.set(e, s);
    }
    return s;
  }
  // el の上に色 fg（乗算前の rgba）を置いたときの見た目の色と、その下の背景の色。
  // el から <html> まで、各要素の「背景 → 子の描画（opacity 込み）」の順に重ね、最後に白地へ。
  function paint(el, fg) {
    var T = null, B = null, skipped = false, opaqueBelow = false, opacity = 1;
    for (var e = el; e; e = e.parentElement) {
      var st = styleOf(e);
      if (st.img && !opaqueBelow) skipped = true;   // 子が不透明でなければ背景画像が透けて見える
      if (T === null) { B = st.bg; T = fg ? over(pm(fg), st.bg) : st.bg; }
      else { B = over(B, st.bg); T = over(T, st.bg); }
      if (st.op < 1) { B = fade(B, st.op); T = fade(T, st.op); }
      opacity *= st.op;
      opaqueBelow = B.a >= 0.999;
    }
    return { fg: unpm(over(T, WHITE)), bg: unpm(over(B, WHITE)), skipped: skipped, opacity: opacity };
  }
  function desc(e) {
    if (!e || !e.tagName) return '';
    var s = e.tagName.toLowerCase();
    if (e.id) return s + '#' + e.id;
    var cl = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return s + (cl.length ? '.' + cl.join('.') : '');
  }
  function sel(e) { var p = e.parentElement; return (p && p !== document.body ? desc(p) + ' > ' : '') + desc(e); }
  function clippedAway(e) {
    for (var a = e; a && a !== document.body; a = a.parentElement) {
      var cs = getComputedStyle(a);
      if (/^rect\(0px,? 0px,? 0px,? 0px\)$/.test(cs.clip)) return true;
      if (cs.overflow !== 'visible') { var r = a.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1) return true; }
    }
    return false;
  }

  if (opts.mode === 'text') {
    var root = opts.root ? document.querySelector(opts.root) : document.body;
    var out = { pass: 0, fail: [], skipped: [] };
    if (!root) return out;
    // 閉じている <details> も開いて、中の文字まで測る
    if (opts.openDetails) Array.prototype.forEach.call(root.querySelectorAll('details:not([open])'), function (d) { d.open = true; });
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var txt = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      var el = node.parentElement;
      if (!el || el.closest('svg, script, style, noscript, template, select, option, textarea, title')) continue;
      var range = document.createRange(); range.selectNodeContents(node);
      var rects = Array.prototype.filter.call(range.getClientRects(), function (r) { return r.width > 0.5 && r.height > 0.5; });
      if (!rects.length) continue;
      var cs = getComputedStyle(el);
      if (cs.visibility !== 'visible') continue;
      var fg = parseColor(cs.getPropertyValue('-webkit-text-fill-color') || cs.color);
      if (fg.a === 0) continue;
      if (clippedAway(el)) continue;
      var res = paint(el, fg);
      if (res.opacity <= 0.01) continue;   // 透明（例: 重ねて置いた <select>）
      var size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
      var large = size >= 24 || (size >= 18.66 && weight >= 700);
      var need = large ? 3 : 4.5;
      var item = { sel: sel(el), text: txt.slice(0, 28), size: Math.round(size * 10) / 10, weight: weight };
      if (res.skipped) { out.skipped.push(item); continue; }
      judge(item, res, need);
    }
    // 入力欄の文字（値、空なら placeholder）も同じ基準で測る
    Array.prototype.forEach.call(root.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea'), function (inp) {
      if (!inp.getClientRects().length) return;
      var ics = getComputedStyle(inp);
      if (ics.visibility !== 'visible' || clippedAway(inp)) return;
      var ph = !inp.value;
      if (ph && !inp.placeholder) return;
      var fg = parseColor(ph ? getComputedStyle(inp, '::placeholder').color : ics.color);
      if (fg.a === 0) return;
      var res = paint(inp, fg);
      if (res.opacity <= 0.01) return;
      var size = parseFloat(ics.fontSize), weight = parseInt(ics.fontWeight, 10) || 400;
      var item = { sel: sel(inp) + (ph ? '::placeholder' : ''), text: (ph ? inp.placeholder : inp.value).slice(0, 28), size: Math.round(size * 10) / 10, weight: weight };
      if (res.skipped) { out.skipped.push(item); return; }
      judge(item, res, size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5);
    });
    return out;
  }
  function judge(item, res, need) {   // out は上の var（関数全体で有効）
    var r = ratio(res.fg, res.bg);
    if (r + 1e-9 < need) {
      item.fg = hex(res.fg); item.bg = hex(res.bg); item.ratio = Math.floor(r * 100) / 100; item.need = need;
      out.fail.push(item);
    } else {
      out.pass++;
    }
  }

  if (opts.mode === 'tokens') {
    var rs = getComputedStyle(document.documentElement);
    return { theme: document.documentElement.getAttribute('data-theme'), bodyBg: getComputedStyle(document.body).backgroundColor,
      card: hex(parseColor(rs.getPropertyValue('--surface-1'))), page: hex(parseColor(rs.getPropertyValue('--page-bg'))) };
  }

  if (opts.mode === 'ring') {
    // フォーカスしてリングを測る。opts.target（フォーカスする要素）・opts.ringOn（リングを描く要素。既定は同じ）
    var t = document.querySelector(opts.target);
    if (!t || !t.getClientRects().length) return { missing: true };
    t.scrollIntoView({ block: 'center', inline: 'nearest' });
    t.focus();
    var ringEl = opts.ringOn ? t.closest(opts.ringOn) : t;
    var focusVisible = t.matches(':focus-visible');
    var rcs = getComputedStyle(ringEl);
    var col = parseColor(rcs.outlineColor), w = parseFloat(rcs.outlineWidth) || 0, off = parseFloat(rcs.outlineOffset) || 0;
    var rootCs = getComputedStyle(document.documentElement);
    var card = parseColor(rootCs.getPropertyValue('--surface-1')), page = parseColor(rootCs.getPropertyValue('--page-bg'));
    // 実際の周囲：リングの外側半分は ringEl の親の上に描かれる（offset が負なら ringEl 自身の上）
    var around = paint(off < 0 ? ringEl : (ringEl.parentElement || ringEl), null).bg;
    var ringOnAround = unpm(over(pm(col), pm({ r: around.r, g: around.g, b: around.b, a: 1 })));
    var ringOnCard = unpm(over(pm(col), pm(card))), ringOnPage = unpm(over(pm(col), pm(page)));
    // overflow で切り取られないか（リングの外周が、切り取る祖先の内側に収まっているか）
    var r0 = ringEl.getBoundingClientRect(), ext = Math.max(0, off + w);
    var box = { l: r0.left - ext, t: r0.top - ext, r: r0.right + ext, b: r0.bottom + ext };
    var clipBy = null;
    for (var a = ringEl.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      var acs = getComputedStyle(a);
      if (acs.overflowX === 'visible' && acs.overflowY === 'visible') continue;
      var ar = a.getBoundingClientRect();
      var pl = ar.left + a.clientLeft, pt = ar.top + a.clientTop, pr = pl + a.clientWidth, pb = pt + a.clientHeight;
      if (box.l < pl - 0.5 || box.t < pt - 0.5 || box.r > pr + 0.5 || box.b > pb + 0.5) { clipBy = desc(a) + ' (' + Math.round(pl) + ',' + Math.round(pt) + '–' + Math.round(pr) + ',' + Math.round(pb) + ' vs ring ' + Math.round(box.l) + ',' + Math.round(box.t) + '–' + Math.round(box.r) + ',' + Math.round(box.b) + ')'; break; }
    }
    var result = {
      sel: desc(ringEl), focusVisible: focusVisible, style: rcs.outlineStyle, width: w, offset: off, color: rcs.outlineColor, alpha: col.a,
      card: Math.floor(ratio(ringOnCard, unpm(pm(card))) * 100) / 100,
      page: Math.floor(ratio(ringOnPage, unpm(pm(page))) * 100) / 100,
      around: Math.floor(ratio(ringOnAround, around) * 100) / 100, aroundHex: hex(around), clipBy: clipBy
    };
    t.blur();
    return result;
  }
  return null;
}

(async () => {
  await new Promise(function (ok) { server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: EXEC });
  const failures = new Map();   // 同じ要素・文字・色の失敗はまとめて、出た画面を並べる
  let pass = 0, fail = 0, skipped = 0;
  const skippedSeen = new Map();
  const notes = [];

  function addFail(key, line, where) {
    if (!failures.has(key)) failures.set(key, { line: line, where: [] });
    const f = failures.get(key);
    if (f.where.indexOf(where) === -1) f.where.push(where);
  }
  function record(scope, res) {
    pass += res.pass;
    res.fail.forEach(function (f) {
      fail++;
      addFail([scope.scheme, f.sel, f.text, f.fg, f.bg, f.size, f.weight].join('|'),
        '[' + scope.scheme + '] ' + f.sel + ' 「' + f.text + '」 ' + f.size + 'px/' + f.weight + '  ' + f.fg + ' on ' + f.bg + '  ' + f.ratio.toFixed(2) + ':1 < ' + f.need + ':1',
        scope.width + ' ' + scope.state);
    });
    res.skipped.forEach(function (s) { skipped++; const k = s.sel + '|' + s.text; if (!skippedSeen.has(k)) skippedSeen.set(k, s); });
  }
  async function measure(page, scope, root) {
    const res = await page.evaluate(pageAudit, { mode: 'text', root: root || null, openDetails: true });
    record(scope, res);
    return res;
  }
  async function openPage(scheme, width, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: { width: width, height: width < 600 ? 844 : 800 }, colorScheme: scheme, reducedMotion: 'reduce', timezoneId: 'Asia/Tokyo' });
    await ctx.addInitScript(function () { try { localStorage.setItem('kate-me', 'momo'); } catch (e) {} });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', function (e) { errors.push(String(e.message)); });
    if (opts.sharedLink) {
      // 合言葉のファイルがある（＝この端末はまだ接続していない）状態：未接続の警告バナーと合言葉の入力欄が出る
      const body = fs.readFileSync(path.join(ROOT, 'data', 'shared-link.json'));
      await page.route('**/data/shared-link.json', function (route) { return route.fulfill({ status: 200, contentType: 'application/json', body: body }); });
    }
    await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(function () { return document.fonts ? document.fonts.ready.then(function () { return true; }) : true; });
    await page.waitForTimeout(300);
    // 測るのは落ち着いた後の色。色・不透明度のトランジション（タブ .2s・トースト .3s・説明 .15s など）の
    // 途中を測らないよう、以後の切り替えはすべて即時にする（アプリはトランジションのイベントを使っていない）
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    // ダークが本当に効いているか（data-theme とページの背景）
    const tk = await page.evaluate(pageAudit, { mode: 'tokens' });
    const want = scheme === 'dark' ? { theme: 'dark', bg: 'rgb(0, 0, 0)' } : { theme: 'light', bg: 'rgb(242, 242, 247)' };
    if (tk.theme !== want.theme || tk.bodyBg !== want.bg) {
      fail++;
      addFail('theme|' + scheme + '|' + width, '[' + scheme + '] テーマが効いていない: data-theme=' + tk.theme + ' body=' + tk.bodyBg + '（期待 ' + want.theme + ' / ' + want.bg + '）', String(width));
    }
    return { ctx: ctx, page: page, errors: errors, tokens: tk };
  }
  async function go(page, view) {
    await page.evaluate(function (v) { if (location.hash !== '#' + v) location.hash = '#' + v; }, view);
    await page.waitForFunction(function (v) { var el = document.getElementById('view-' + v); return el && el.classList.contains('active') && el.children.length > 0; }, view, { timeout: 5000 });
    await page.waitForTimeout(250);
  }
  async function clickWhere(page, fn, arg) {
    const ok = await page.evaluate(fn, arg);
    await page.waitForTimeout(250);
    return ok;
  }
  async function ring(page, scope, label, target, ringOn) {
    const r = await page.evaluate(pageAudit, { mode: 'ring', target: target, ringOn: ringOn || null });
    if (!r || r.missing) { notes.push('[' + scope.scheme + ' ' + scope.width + '] リング「' + label + '」の対象 ' + target + ' が見つからないため測っていません'); return; }
    const bad = [];
    if (!r.focusVisible && !ringOn) bad.push(':focus-visible にならない');
    if (r.style === 'none' || r.width < 2) bad.push('リングが無い・細い（' + r.style + ' ' + r.width + 'px）');
    if (r.alpha < 0.999) bad.push('半透明（' + r.color + '）');
    if (r.card < 3) bad.push('カード地で ' + r.card.toFixed(2) + ':1');
    if (r.page < 3) bad.push('ページ地で ' + r.page.toFixed(2) + ':1');
    if (r.around < 3) bad.push('周囲 ' + r.aroundHex + ' で ' + r.around.toFixed(2) + ':1');
    if (r.clipBy) bad.push('リングが切れる: ' + r.clipBy);
    if (bad.length) {
      fail++;
      addFail(['ring', scope.scheme, label, bad.join(';')].join('|'), '[' + scope.scheme + '] フォーカスリング ' + label + '（' + r.sel + ' ' + r.color + ' ' + r.width + 'px offset ' + r.offset + 'px）: ' + bad.join('・'), String(scope.width));
    } else {
      pass++;
      ringSummary.push(scope.scheme + ' ' + scope.width + ' ' + label + ': card ' + r.card.toFixed(2) + ' / page ' + r.page.toFixed(2) + ' / 周囲 ' + r.around.toFixed(2));
    }
  }
  const ringSummary = [];

  for (const scheme of SCHEMES) for (const width of WIDTHS) {
    const o = await openPage(scheme, width);
    const p = o.page;
    let perState = [];
    for (const st of STATES) {
      await go(p, st.view);
      let found = true;
      if (st.seg) {
        found = await clickWhere(p, function (a) {
          var b = Array.prototype.filter.call(document.querySelectorAll('#' + a[0] + ' button[data-k]'), function (x) { return x.dataset.k === a[1]; })[0];
          if (!b) return false; if (!b.classList.contains('active')) b.click(); return true;
        }, st.seg);
      }
      if (st.dow) {
        found = await clickWhere(p, function (k) {
          if (!document.getElementById('dowSeg')) { var s = Array.prototype.filter.call(document.querySelectorAll('#storeSeg button[data-k]'), function (x) { return x.dataset.k === 'time'; })[0]; if (s && !s.classList.contains('active')) s.click(); }
          var b = document.querySelector('#dowSeg button[data-m="' + k + '"]'); if (!b) return false; if (!b.classList.contains('active')) b.click(); return true;
        }, st.dow);
      }
      if (st.toggle) {
        found = await clickWhere(p, function (s) { var b = document.querySelector(s); if (!b) return false; if (b.getAttribute('aria-pressed') !== 'true') b.click(); return b.getAttribute('aria-pressed') === 'true'; }, st.toggle);
      }
      const scope = { scheme: scheme, width: width, state: st.name };
      // 切り替えのボタンが見つからない・画面がほとんど描かれていないのに「合格」としない
      if (!found) { fail++; addFail('missing|' + st.name, '[' + scheme + '] ' + st.name + ' の切り替えボタンが見つからず、その画面を測れません', String(width)); continue; }
      const res = await measure(p, scope);
      const n = res.pass + res.fail.length;
      if (n < 20) { fail++; addFail('empty|' + st.name, '[' + scheme + '] ' + st.name + ' の文字が ' + n + ' 件しかありません（画面が描かれていない）', String(width)); }
      perState.push(st.name + ' ' + n + (res.fail.length ? '（失敗 ' + res.fail.length + '）' : ''));
    }
    // データタブ：トースト（失敗＝URL未入力で「連携」、成功＝サンプルに戻す）
    for (const t of [{ name: '#data>トースト（失敗）', click: '#sheetLinkBtnYoyaku' }, { name: '#data>トースト（成功）', click: '#resetBtn' }]) {
      const clicked = await p.evaluate(function (s) { var b = document.querySelector(s); if (!b) return false; b.click(); return true; }, t.click);
      if (!clicked) { notes.push('[' + scheme + ' ' + width + '] ' + t.click + ' が無いため ' + t.name + ' を測っていません'); continue; }
      await p.waitForTimeout(150);
      const res = await measure(p, { scheme: scheme, width: width, state: t.name }, '#toast');
      if (!res.pass && !res.fail.length) notes.push('[' + scheme + ' ' + width + '] ' + t.name + ' のトーストが表示されませんでした');
    }
    // 説明（ⓘ）のポップオーバー
    await go(p, 'home');
    await p.evaluate(function () { var b = document.querySelector('.view.active .help-ico'); if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } });
    await p.waitForTimeout(250);
    const pop = await measure(p, { scheme: scheme, width: width, state: '#home>説明' }, '.help-pop.show');
    if (!pop.pass && !pop.fail.length) notes.push('[' + scheme + ' ' + width + '] 説明のポップオーバーが開かず、測っていません');
    await p.evaluate(function () { var b = document.querySelector('.help-ico.active'); if (b) b.click(); });

    // フォーカスリング：キーボード操作の状態にしてから、代表的な部品へフォーカス
    await p.keyboard.press('Tab');
    const scope = { scheme: scheme, width: width };
    await go(p, 'home');
    if (width >= 768) await ring(p, scope, 'タブ（ガラスの上）', '#tabs .tab.active');
    else await ring(p, scope, '下のタブバー', '#botnav button.active');
    await ring(p, scope, '税抜／税込', '.taxseg button[aria-checked="true"]');
    await ring(p, scope, 'あなたの選択（focus-within）', '#mePicker', '.me-pick');
    await ring(p, scope, '説明（ⓘ）', '.view.active .help-ico');
    await go(p, 'overview');
    await ring(p, scope, 'セグメント（ページの上）', '#storeSeg button.active');
    await go(p, 'staff');
    await ring(p, scope, 'スタッフ選択（横スクロールの行）', '#staffSeg button');
    await go(p, 'rfm');
    await ring(p, scope, '顧客グループの行（overflow:hidden の中）', '.view.active .ios-list summary');
    await ring(p, scope, '表の並べ替え見出し（スクロールの中）', '#rfmTable th[data-k] .th-sort');
    await ring(p, scope, 'カード内のボタン', '#rfmCallbackToggle');
    await go(p, 'data');
    await ring(p, scope, 'URLの入力欄（.sheet-input）', '#sheetUrlYoyaku');
    await ring(p, scope, 'アップロード（dropzone）', '.view.active .dropzone');
    console.log('  ' + scheme.padEnd(5) + ' ' + String(width).padStart(4) + 'px  ' + perState.join(' · '));
    o.errors.forEach(function (e) { fail++; addFail('pageerror|' + e, '[' + scheme + '] ページのエラー: ' + e.slice(0, 120), String(width)); });
    await o.ctx.close();
  }

  // 未接続の警告バナー（合言葉のファイルがある端末）＋合言葉の入力欄（.field）
  for (const scheme of SCHEMES) for (const width of WIDTHS) {
    const o = await openPage(scheme, width, { sharedLink: true });
    const p = o.page;
    await go(p, 'home');
    const banner = await p.evaluate(function () { return !!document.querySelector('#sheetAlert .alert-card'); });
    if (!banner) notes.push('[' + scheme + ' ' + width + '] 未接続の警告バナーが出ませんでした');
    await measure(p, { scheme: scheme, width: width, state: '#home（未接続バナー）' });
    await go(p, 'data');
    await measure(p, { scheme: scheme, width: width, state: '#data（合言葉の入力）' });
    await p.keyboard.press('Tab');
    await ring(p, { scheme: scheme, width: width }, '合言葉の入力欄（.field focus-within）', '.view.active .field input', '.field');
    await ring(p, { scheme: scheme, width: width }, '警告バナーのボタン', '#sheetAlert .alert-card .pill');
    o.errors.forEach(function (e) { fail++; addFail('pageerror|' + e, '[' + scheme + '] ページのエラー: ' + e.slice(0, 120), String(width)); });
    await o.ctx.close();
  }

  await browser.close();
  server.close();

  console.log('\n\x1b[1mCONTRAST AUDIT\x1b[0m（' + SCHEMES.join('/') + ' × ' + WIDTHS.join('/') + 'px、文字 4.5:1・大きい文字 3:1・フォーカスリング 3:1）');
  ringSummary.forEach(function (s) { console.log('  ring  ' + s); });
  notes.forEach(function (n) { console.log('  \x1b[33mnote\x1b[0m  ' + n); });
  if (skippedSeen.size) {
    console.log('  背景画像・グラデーションの上の文字（測れないためスキップ）: ' + skipped + '件');
    Array.from(skippedSeen.values()).slice(0, 20).forEach(function (s) { console.log('    skip  ' + s.sel + ' 「' + s.text + '」'); });
  } else {
    console.log('  背景画像・グラデーションの上の文字（スキップ）: 0件');
  }
  failures.forEach(function (f) { console.log('  \x1b[31mFAIL\x1b[0m  ' + f.line + '   — ' + f.where.join(', ')); });
  console.log('\nSUMMARY  ' + pass + ' pass · ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('CONTRAST AUDIT: unexpected error', e); server.close(); process.exit(1); });
