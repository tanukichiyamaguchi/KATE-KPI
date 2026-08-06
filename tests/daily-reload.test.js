/* 毎日23時の自動再読み込み（app.js の scheduleDailyReload / lastReloadBoundary）
 * を、Playwright のフェイククロックで実時間を使わずに検証する:
 *
 *   1. boundary 計算 — 「直近で過ぎた23時」が日中・23時台・深夜0時台で正しい
 *   2. 23時ちょうどにシートを再フェッチする（22:59では発火しない）
 *   3. 発火後に翌日の23時へ再スケジュールされる
 *   4. タイマーが止まっていた端末（スリープ）でも、画面復帰イベントで
 *      23時またぎを検知して読み込む
 *
 * Run: node tests/daily-reload.test.js（`npm test` に組み込み済み）。
 * ui-audit.js と同じく、playwright-core / Chromium が無い環境では SKIP。 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (e) { /* not installed */ }
const EXEC = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
if (!chromium || !fs.existsSync(EXEC)) {
  console.log('DAILY RELOAD: \x1b[33mSKIP\x1b[0m (playwright-core / Chromium not available)');
  process.exit(0);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml'
};
const server = http.createServer(function (req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ingest が「予約データ」と認識する最小のCSV（REQUIRED はステータス列のみ）
const CSV = [
  'ステータス,来店日,お名前,スタッフ名,予約時合計金額,会計時合計金額',
  '会計済み,2026/08/05,テスト花子,momo,6000,6600',
  '受付待ち,2026/08/20,テスト花子,momo,6000,'
].join('\n');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? '  \x1b[32mok\x1b[0m    ' : '  \x1b[31mFAIL\x1b[0m  ') + name + (ok ? '' : ('  got=' + got + '  want=' + want)));
}
// フェッチ回数が期待値に達するのを実時間で少しだけ待つ（fulfill は非同期のため）
function waitFor(fn, want, ms) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    (function poll() {
      if (fn() >= want || Date.now() - t0 > (ms || 3000)) return resolve(fn());
      setTimeout(poll, 50);
    })();
  });
}
const JST = function (s) { return new Date(s + '+09:00'); };

(async () => {
  await new Promise(function (ok) { server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: EXEC });
  const context = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  let hits = 0;
  await page.route('https://docs.google.com/**', function (route) {
    hits++;
    route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: CSV });
  });
  await context.addInitScript(function () {
    try { localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/TESTDAILY/edit#gid=0'); } catch (e) {}
  });
  const errors = [];
  page.on('console', function (m) {
    if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  // 22:58 JST で時計を固定してから起動（boot の初回フェッチが hit #1）
  await page.clock.install({ time: JST('2026-08-06T22:50:00') });
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
  await page.clock.pauseAt(JST('2026-08-06T22:58:00'));
  await waitFor(function () { return hits; }, 1);
  check('起動時に1回読み込む（従来どおり）', hits, 1);

  // ---- boundary 計算（ページ内の実装をそのまま検証）------------------------
  const b = await page.evaluate(function (isoList) {
    return isoList.map(function (iso) {
      var d = window.KATE.dailyReload.boundary(new Date(iso));
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
    });
  }, ['2026-08-07T10:00:00+09:00', '2026-08-07T23:30:00+09:00', '2026-08-08T00:10:00+09:00']);
  check('boundary: 日中10時 → 前日の23:00', b[0], '2026-8-6 23:00');
  check('boundary: 23時30分 → 当日の23:00', b[1], '2026-8-7 23:00');
  check('boundary: 深夜0時10分 → 前日の23:00', b[2], '2026-8-7 23:00');

  // ---- 22:59 ではまだ発火しない --------------------------------------------
  await page.clock.fastForward(60 * 1000);            // → 22:59
  await new Promise(function (r) { setTimeout(r, 300); });
  check('22:59 では再読み込みしない', hits, 1);

  // ---- 23:00:05 のタイマーで発火 -------------------------------------------
  // 各ジャンプの後に実時間を少し待つ: フェイククロックはタイマーだけを進め、
  // フェッチ応答の反映（dataLoadedAt の更新）は実時間の非同期で走るため。
  await page.clock.fastForward(2 * 60 * 1000);        // → 23:01
  await waitFor(function () { return hits; }, 2);
  await new Promise(function (r) { setTimeout(r, 500); });
  check('23時に自動で再読み込みする', hits, 2);

  // ---- 読み込み成功後、10分後の成否確認タイマーは再試行しない --------------
  await page.clock.fastForward(15 * 60 * 1000);       // → 23:16（23:10 の verify を消化）
  await new Promise(function (r) { setTimeout(r, 300); });
  check('成功後の確認タイマーは再試行しない', hits, 2);

  // ---- 翌日23時にも発火（再スケジュール）-----------------------------------
  await page.clock.fastForward(24 * 60 * 60 * 1000);  // → 翌日 23:16
  await waitFor(function () { return hits; }, 3);
  await new Promise(function (r) { setTimeout(r, 500); });
  check('翌日の23時にも再読み込みする（再スケジュール）', hits, 3);
  await page.clock.fastForward(15 * 60 * 1000);       // 翌日分の verify も消化 → 23:31
  await new Promise(function (r) { setTimeout(r, 300); });

  // ---- スリープ復帰: タイマーを動かさず時刻だけ翌々日23:30へ ---------------
  await page.clock.setSystemTime(JST('2026-08-09T23:30:00'));
  await page.evaluate(function () { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(function () { return hits; }, 4);
  await new Promise(function (r) { setTimeout(r, 500); });
  check('画面復帰時に23時またぎを検知して読み込む', hits, 4);

  // ---- 復帰しても23時をまたいでいなければ読み込まない ----------------------
  await page.evaluate(function () { document.dispatchEvent(new Event('visibilitychange')); });
  await new Promise(function (r) { setTimeout(r, 300); });
  check('またいでいなければ画面復帰でも読み込まない', hits, 4);

  check('コンソールエラーなし', errors.length, 0);

  await browser.close(); server.close();
  console.log('\x1b[1mSUMMARY\x1b[0m  \x1b[32m' + pass + ' pass\x1b[0m · \x1b[31m' + fail + ' fail\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
