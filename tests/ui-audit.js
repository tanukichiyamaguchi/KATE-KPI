/* UI regression audit: renders the real dashboard (sample data) in headless
 * Chromium at phone and desktop widths, walks every tab, and FAILS on layout
 * defects that unit tests can't see:
 *
 *   1. vertical-text  — a short label (≤10 chars) rendered ≥3 lines tall,
 *                       i.e. text stacking one character per line inside a
 *                       too-narrow column (the recurring 「文字が縦になる」bug);
 *   2. clipped-cell   — a table cell whose content overflows its box
 *                       (digits silently cut off at the cell edge);
 *   3. clipped-chart-label — an SVG value label pushed above its chart's
 *                       top edge;
 *   4. any console/page error;
 *   5. page-level horizontal overflow, and buttons/chips sticking out of
 *      their card (e.g. a long pill label at 320px).
 *
 * Three scenarios: (a) the bundled sample (2 staff) with the owner area locked;
 * (b) a linked sheet with 6 staff, some with long names, and the owner area
 * unlocked — the staff selector and the data tab's admin buttons must still
 * fit a 320px phone; (c) the same as (b) with glyph widths close to a real
 * iPhone (Inter ≈ SF Pro for Latin/digits, IPAGothic = 1em kana/kanji like
 * Hiragino). This container's default Japanese fallback (IPAPGothic) is about
 * 11% narrower than a phone's, which hid a button sticking out at 320px.
 *
 * Run: node tests/ui-audit.js  (wired into `npm test`).
 * Requires playwright-core + a Chromium binary (PW_CHROMIUM env var, or the
 * preinstalled /opt/pw-browsers/chromium). When neither is available — e.g. a
 * bare clone without browsers — it SKIPs with exit 0 rather than failing,
 * so the pure-Node calculation tests stay runnable anywhere. */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (e) { /* not installed */ }
const EXEC = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
if (!chromium || !fs.existsSync(EXEC)) {
  console.log('UI AUDIT: \x1b[33mSKIP\x1b[0m (playwright-core / Chromium not available — layout checks not run)');
  process.exit(0);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2'
};
const server = http.createServer(function (req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }  // repo has none — don't pollute the console-error check
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const TABS = ['ホーム', 'お店', 'スタッフ', '顧客', 'データ'];
const WIDTHS = [320, 375, 390, 414, 1280];
const { recordsCsv, sampleRows } = require('./helpers/sample-sheet.js');
// 6人のスタッフ（長い名前・全角スペース入りを含む）。サンプルの momo の担当分を
// お客様ごとに5人へ振り分け、aoi はそのまま残す。
function sixStaffCsv() {
  const extra = ['momo', '佐藤　美咲', '高橋ゆきの', 'Kobayashi', '山本あやの'];
  const rows = sampleRows().map(function (r) {
    if (r.staff === 'momo') {
      var h = 0; String(r.custKey).split('').forEach(function (ch) { h = (h * 31 + ch.charCodeAt(0)) >>> 0; });
      r.staff = extra[h % extra.length];
    }
    return r;
  });
  return recordsCsv(rows);
}
const SCENARIOS = [
  { name: 'サンプル', widths: WIDTHS, linked: false },
  { name: '6人・管理画面あり', widths: [320, 375, 390, 1280], linked: true },
  { name: '6人・管理画面あり・実機に近い字幅', widths: [320, 375], linked: true, deviceFont: true }
];

(async () => {
  await new Promise(function (ok) { server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: EXEC });
  const failures = [];

  const SIX = sixStaffCsv();
  for (const sc of SCENARIOS) for (const width of sc.widths) {
    // スマホ幅は実機に近い高さ（640px）にする。説明ポップオーバーが画面下に
    // はみ出す不具合は、高さが十分だと再現しないため。
    const page = await browser.newPage({ viewport: { width: width, height: width < 600 ? 640 : 900 } });
    await page.addInitScript(function (linked) {
      try {
        localStorage.setItem('kate-me', 'momo');
        if (linked) localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/AUDIT6/edit#gid=0');
      } catch (e) {}
    }, sc.linked);
    if (sc.deviceFont) {
      // index.html の <head> に字体の指定を差し込む（最初の描画から効かせるため、HTML そのものを書き換える）
      await page.route('**/index.html', async function (route) {
        const resp = await route.fetch();
        const body = (await resp.text()).replace('</head>', "<style>*, *::before, *::after { font-family: 'Inter', 'IPAGothic', sans-serif !important; }</style></head>");
        await route.fulfill({ response: resp, body: body });
      });
    }
    if (sc.linked) {
      // 連携中のシート（6人）。「目標」タブは無い（gviz が1枚目を返す）扱い。
      await page.route('https://docs.google.com/**', function (route) { return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: SIX }); });
      // 管理用のロックと共有リンクを無効にして、データタブの管理画面（長いボタン）も表示する
      await page.route('**/data/owner-lock.json', function (route) { return route.fulfill({ status: 404, body: '' }); });
      await page.route('**/data/shared-link.json', function (route) { return route.fulfill({ status: 404, body: '' }); });
    }
    // Charts honor prefers-reduced-motion → render instantly, so measurements
    // are deterministic instead of racing entry animations.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', function (e) { errors.push(String(e.message)); });
    page.on('console', function (m) {
      if (m.type() !== 'error' || /favicon/i.test(m.text())) return;
      // 管理ロック・共有リンクを 404 にして無効化した場面では、その 404 は想定どおり
      if (sc.linked && /Failed to load resource: .*404/.test(m.text())) return;
      errors.push(m.text());
    });
    await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(function () { return document.fonts ? document.fonts.ready : null; });
    if (sc.linked) {
      await page.waitForFunction(function () { var a = document.querySelector('#asof'); return a && /最終読込/.test(a.textContent); }, {}, { timeout: 8000 }).catch(function () {});
    }

    for (const tab of TABS) {
      await page.evaluate(function (t) {
        var els = Array.prototype.slice.call(document.querySelectorAll('a, button'));
        var el = els.find(function (a) { return a.textContent.trim() === t && a.offsetParent !== null; });
        if (el) el.click();
      }, tab);
      await page.waitForTimeout(300);
      // タブの中の切り替え（「お店」の売上・予約／リピート／曜日・時間、「スタッフ」の各スタッフ／比較）も
      // それぞれ表示して検査する。切り替えが無いタブはそのまま1回だけ検査する。
      const segKeys = await page.evaluate(function () {
        return Array.prototype.slice.call(document.querySelectorAll('.view.active .subnav .segmented button[data-k]')).map(function (b) { return b.dataset.k; });
      });
      for (const key of (segKeys.length ? segKeys : [null])) {
        if (key !== null) {
          await page.evaluate(function (k) {
            // data-k はスタッフ名（全角スペースなどを含む）なので、セレクタを組み立てずに比べる
            var b = Array.prototype.filter.call(document.querySelectorAll('.view.active .subnav .segmented button[data-k]'), function (x) { return x.dataset.k === k; })[0];
            if (b && !b.classList.contains('active')) b.click();
          }, key);
          await page.waitForTimeout(300);
        }
        const label = (sc.linked ? '[' + sc.name + '] ' : '') + tab + (key !== null ? ' > ' + key : '');
        const found = await page.evaluate(function () {
          var out = [];
          function txt(el) { return (el.innerText || '').trim(); }
          // Count rendered text lines of an element. Table cells stretch to
          // their ROW's height, so box height says nothing about how many lines
          // the cell's own text occupies; and non-text children (color swatches
          // like .seg-tag i) would inflate a whole-element Range measurement.
          // Walk only the text nodes and count distinct line tops.
          function lineCount(el) {
            var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            var tops = [], node;
            while ((node = walker.nextNode())) {
              if (!node.textContent.trim()) continue;
              var range = document.createRange();
              range.selectNodeContents(node);
              var rects = range.getClientRects();
              for (var i = 0; i < rects.length; i++) {
                var r = rects[i];
                if (!r.width || !r.height) continue;
                var isNew = true;
                for (var j = 0; j < tops.length; j++) if (Math.abs(tops[j] - r.top) < 3) { isNew = false; break; }
                if (isNew) tops.push(r.top);
              }
            }
            return tops.length;
          }
          // 1) vertical text: a short label (≤10 chars) should never occupy 3+
          //    lines. (2 lines is a legitimate wrap on very narrow phones; 3+
          //    means the text is stacking a character or two per line.)
          var els = document.querySelectorAll('th, td, .chip, .seg-tag, .pb-tag, .mini-stat span, .kate-legend-item');
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!el.offsetParent) continue;
            var t = txt(el);
            if (!t || t.length > 10) continue;
            if (lineCount(el) >= 3) out.push({ type: 'vertical-text', text: t.slice(0, 20) });
          }
          // 2) clipped table cells (content wider than the box)
          var cells = document.querySelectorAll('th, td');
          for (var j2 = 0; j2 < cells.length; j2++) {
            var c = cells[j2];
            if (!c.offsetParent) continue;
            if (c.scrollWidth > c.clientWidth + 2) out.push({ type: 'clipped-cell', text: txt(c).slice(0, 20) });
          }
          // 3) chart value labels escaping the top of their SVG
          var svgs = document.querySelectorAll('.chart-box svg');
          for (var k = 0; k < svgs.length; k++) {
            var top = svgs[k].getBoundingClientRect().top;
            var box = svgs[k].closest('.chart-box');
            var texts = svgs[k].querySelectorAll('text');
            for (var m = 0; m < texts.length; m++) {
              if (texts[m].getBoundingClientRect().top < top - 1) {
                out.push({ type: 'clipped-chart-label', text: (box && box.id ? box.id + ': ' : '') + texts[m].textContent });
                break;
              }
            }
          }
          // 4) page-level horizontal overflow: a phone page must never scroll
          //    sideways. Wide tables/charts are allowed BEHIND an
          //    overflow-x:auto scroll container; anything else poking past the
          //    viewport's right edge is the 「横スクロール」bug. Name the widest
          //    offending leaf so the failure is actionable.
          var docW = document.documentElement.clientWidth;
          if (document.documentElement.scrollWidth > docW + 1) {
            function inScrollX(el) {
              for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                var ox = getComputedStyle(p).overflowX;
                if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 2) return true;
              }
              return false;
            }
            var all = document.body.querySelectorAll('*'), culprits = [];
            for (var o = 0; o < all.length; o++) {
              var e2 = all[o];
              if (!e2.offsetParent) continue;
              var r2 = e2.getBoundingClientRect();
              if (r2.right > docW + 1 && !inScrollX(e2)) {
                var sel = (e2.id ? '#' + e2.id : (typeof e2.className === 'string' && e2.className.trim()
                  ? '.' + e2.className.trim().split(/\s+/).slice(0, 2).join('.') : e2.tagName.toLowerCase()));
                culprits.push({ w: Math.round(r2.right), sel: sel });
              }
            }
            culprits.sort(function (a, b) { return b.w - a.w; });
            var seenC = {};
            culprits.slice(0, 30).forEach(function (c) {
              if (seenC[c.sel]) return; seenC[c.sel] = 1;
              out.push({ type: 'h-overflow', text: c.sel + ' →' + c.w + 'px / vw' + docW });
            });
            if (!culprits.length) out.push({ type: 'h-overflow', text: 'page ' + document.documentElement.scrollWidth + 'px / vw' + docW });
          }
          // 4b) ボタン・チップがカードの右端からはみ出していない（ページ全体は横に
          //     スクロールしなくても、長いラベルのボタンがカードの外へ突き出す）。
          //     横スクロールする行（.seg-scroll・.table-wrap）の中は対象外。
          var pills = document.querySelectorAll('.card .pill, .card button, .hc .pill, .chip');
          for (var q = 0; q < pills.length; q++) {
            var pe = pills[q];
            if (!pe.offsetParent) continue;
            var inX = false;
            for (var pp = pe.parentElement; pp && !pp.classList.contains('card') && !pp.classList.contains('hc'); pp = pp.parentElement) {
              var oxs = getComputedStyle(pp).overflowX; if (oxs === 'auto' || oxs === 'scroll') { inX = true; break; }
            }
            if (inX) continue;
            var cardEl = pe.closest('.card, .hc');
            if (!cardEl) continue;
            var cr = cardEl.getBoundingClientRect(), pr = pe.getBoundingClientRect();
            if (pr.right > cr.right + 1 || pr.left < cr.left - 1) out.push({ type: 'out-of-card', text: (pe.id ? '#' + pe.id : txt(pe).slice(0, 20)) + ' ' + Math.round(pr.left) + '..' + Math.round(pr.right) + ' / card ' + Math.round(cr.left) + '..' + Math.round(cr.right) });
          }
          // 5) スタッフ比較表は横スクロールさせず画面内に必ず収める設計。.table-wrap は
          //    overflow-x:auto なので #4 の全体検査では拾えないため個別に確認する。
          //    ただし4人以上（.many）は表を横にスクロールさせる設計なので、代わりに
          //    左の項目名の列が固定（position: sticky）されていることを確認する。
          var vt = document.querySelector('.vs-table');
          if (vt && vt.offsetParent) {
            var vw = vt.closest('.table-wrap');
            if (vt.classList.contains('many')) {
              var fc = vt.querySelector('tbody td:first-child');
              if (vw && vt.scrollWidth > vw.clientWidth + 2 && fc && getComputedStyle(fc).position !== 'sticky') {
                out.push({ type: 'vs-table-first-col-not-sticky', text: vt.scrollWidth + 'px > wrap ' + vw.clientWidth + 'px' });
              }
            } else if (vw && vt.scrollWidth > vw.clientWidth + 2) {
              out.push({ type: 'vs-table-overflow', text: vt.scrollWidth + 'px > wrap ' + vw.clientWidth + 'px' });
            }
          }
          return out;
        });
        // 6) 説明ポップオーバー（?）: このタブの ? を順に開き、(a) <b> などのタグが
        //    文字として見えていない、(b) 画面の中に収まっている（下にはみ出すと
        //    スクロールで閉じてしまい末尾が読めない）ことを確認する。
        const icoCount = await page.evaluate(function () { return document.querySelectorAll('.help-ico').length; });
        for (let hi = 0; hi < icoCount; hi++) {
          const res = await page.evaluate(function (idx) {
            var btn = document.querySelectorAll('.help-ico')[idx];
            if (!btn || !btn.offsetParent) return null;
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            var pop = document.querySelector('.help-pop.show');
            var head = String(btn.dataset.help || '').slice(0, 24);
            if (!pop) return { type: 'help-pop-missing', text: head };
            var r = pop.getBoundingClientRect(), t = pop.textContent || '';
            var out = null;
            if (/<\/?(b|br|code|i)>/.test(t)) out = { type: 'help-literal-tag', text: head };
            else if (r.top < 0 || r.bottom > window.innerHeight + 1 || r.left < 0 || r.right > window.innerWidth + 1) {
              out = { type: 'help-pop-offscreen', text: Math.round(r.top) + '..' + Math.round(r.bottom) + 'px / vh' + window.innerHeight + ' ' + head };
            }
            btn.click();   // 閉じる
            return out;
          }, hi);
          if (res) found.push(res);
        }
        // dedupe identical findings within a tab so one bad column doesn't
        // produce 120 rows of noise
        var seen = {};
        found.forEach(function (f) {
          var key = f.type + '|' + f.text;
          if (seen[key]) return; seen[key] = 1;
          failures.push({ width: width, tab: label, type: f.type, text: f.text });
        });
      }
    }
    errors.forEach(function (e) { failures.push({ width: width, tab: '(page)', type: 'console-error', text: e.slice(0, 120) }); });
    await page.close();
  }
  await browser.close();
  server.close();

  if (failures.length) {
    console.log('\n\x1b[1mUI AUDIT\x1b[0m');
    failures.forEach(function (f) {
      console.log('  \x1b[31mFAIL\x1b[0m  [' + f.width + 'px ' + f.tab + '] ' + f.type + ': ' + JSON.stringify(f.text));
    });
    console.log('\n\x1b[1mUI AUDIT SUMMARY\x1b[0m  \x1b[31m' + failures.length + ' fail\x1b[0m');
    process.exit(1);
  }
  console.log('\n\x1b[1mUI AUDIT SUMMARY\x1b[0m  \x1b[32mPASS\x1b[0m (' + SCENARIOS.map(function (x) { return x.name + ' ' + x.widths.length + ' widths'; }).join(' + ') + ' × ' + TABS.length + ' tabs and their sub-sections: no vertical text, no clipped cells, no clipped chart labels, no horizontal page scroll, nothing sticking out of its card, help popovers on-screen without literal tags, no console errors)');
  process.exit(0);
})().catch(function (e) { console.error('UI AUDIT: unexpected error', e); server.close(); process.exit(1); });
