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
 *   4. any console/page error.
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

const TABS = ['概要', 'スタッフ', '傾向', '顧客', 'データ'];
const WIDTHS = [320, 375, 390, 414, 1280];

(async () => {
  await new Promise(function (ok) { server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: EXEC });
  const failures = [];

  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: width, height: 900 } });
    // Charts honor prefers-reduced-motion → render instantly, so measurements
    // are deterministic instead of racing entry animations.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', function (e) { errors.push(String(e.message)); });
    page.on('console', function (m) { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });
    await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(function () { return document.fonts ? document.fonts.ready : null; });

    for (const tab of TABS) {
      await page.evaluate(function (t) {
        var els = Array.prototype.slice.call(document.querySelectorAll('a, button'));
        var el = els.find(function (a) { return a.textContent.trim() === t && a.offsetParent !== null; });
        if (el) el.click();
      }, tab);
      await page.waitForTimeout(300);

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
        return out;
      });
      // dedupe identical findings within a tab so one bad column doesn't
      // produce 120 rows of noise
      var seen = {};
      found.forEach(function (f) {
        var key = f.type + '|' + f.text;
        if (seen[key]) return; seen[key] = 1;
        failures.push({ width: width, tab: tab, type: f.type, text: f.text });
      });
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
  console.log('\n\x1b[1mUI AUDIT SUMMARY\x1b[0m  \x1b[32mPASS\x1b[0m (' + WIDTHS.length + ' widths × ' + TABS.length + ' tabs: no vertical text, no clipped cells, no clipped chart labels, no console errors)');
  process.exit(0);
})().catch(function (e) { console.error('UI AUDIT: unexpected error', e); server.close(); process.exit(1); });
