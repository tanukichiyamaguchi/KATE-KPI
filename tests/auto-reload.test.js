/* 夜間の自動再読み込み（毎日23時〜翌1時・30分おき）と「今すぐ更新」ボタンを、
 * Playwright のフェイククロックで実時間を使わずに検証する:
 *
 *   1. next / boundary 計算 — 発火時刻 23:00/23:30/0:00/0:30/1:00 の前後で正しい
 *   2. 22:59では発火しない → 23:00に発火 → 23:30・0:00（日付またぎ）にも発火
 *   3. 「今すぐ更新」ボタンで手動再読み込みできる
 *   4. スリープで発火を取りこぼした端末は、画面復帰時に検知して読み込む
 *      （取りこぼしが無ければ復帰しても読まない）
 *
 * Run: node tests/auto-reload.test.js（`npm test` に組み込み済み）。
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
  console.log('AUTO RELOAD: \x1b[33mSKIP\x1b[0m (playwright-core / Chromium not available)');
  process.exit(0);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml'
};
// テスト用の管理ロック（合言葉 = OWNER_PASS）。crypto.js で生成して配信する。
const OWNER_PASS = 'test-owner-pass';
let OWNER_LOCK = null;
const server = http.createServer(function (req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/favicon.ico') { res.writeHead(404); res.end(); return; }
  if (urlPath === '/data/owner-lock.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(OWNER_LOCK)); return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ingest が「予約データ」と認識する最小のCSV（REQUIRED はステータス列のみ）。
// V2 は金額とシート側の「データ更新日時」を変えたもの＝シートが同期された状態。
const CSV = [
  'ステータス,来店日,お名前,スタッフ名,予約時合計金額,会計時合計金額,データ更新日時',
  '会計済み,2026/08/05,テスト花子,momo,6000,6600,2026/08/06 1:00:00',
  '受付待ち,2026/08/20,テスト花子,momo,6000,,'
].join('\n');
const CSV_V2 = [
  'ステータス,来店日,お名前,スタッフ名,予約時合計金額,会計時合計金額,データ更新日時',
  '会計済み,2026/08/05,テスト花子,momo,99000,99000,2026/08/08 23:30:00',
  '会計済み,2026/08/06,テスト太郎,aoi,99000,99000,'
].join('\n');
let CSV_BODY = CSV;   // ルートハンドラが返す本文（テスト中に差し替える）

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? '  \x1b[32mok\x1b[0m    ' : '  \x1b[31mFAIL\x1b[0m  ') + name + (ok ? '' : ('  got=' + got + '  want=' + want)));
}
function waitFor(fn, want, ms) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    (function poll() {
      if (fn() >= want || Date.now() - t0 > (ms || 3000)) return resolve(fn());
      setTimeout(poll, 50);
    })();
  });
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
const JST = function (s) { return new Date(s + '+09:00'); };

(async () => {
  // 管理ロックの暗号文を crypto.js で生成（ブラウザ側と同じ実装を Node で実行）
  const crypto7 = require('../assets/js/crypto.js');
  OWNER_LOCK = await crypto7.encrypt(OWNER_PASS, { role: 'owner' });

  await new Promise(function (ok) { server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: EXEC });
  const context = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  let hits = 0;
  await page.route('https://docs.google.com/**', function (route) {
    hits++;
    route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: CSV_BODY });
  });
  await context.addInitScript(function () {
    try { localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/TESTNIGHT/edit#gid=0'); } catch (e) {}
  });
  const errors = [];
  page.on('console', function (m) {
    if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  // 22:58 JST で時計を固定してから起動（boot の初回フェッチが hit #1）
  await page.clock.install({ time: JST('2026-08-07T22:50:00') });
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
  await page.clock.pauseAt(JST('2026-08-07T22:58:00'));
  await waitFor(function () { return hits; }, 1);
  check('起動時に1回読み込む（従来どおり）', hits, 1);

  // ---- next / boundary 計算（ページ内の実装をそのまま検証）-----------------
  const fmt = 'function(d){return (d.getMonth()+1)+"/"+d.getDate()+" "+d.getHours()+":"+("0"+d.getMinutes()).slice(-2);}';
  const m2 = await page.evaluate(function (isoList) {
    var fmt = function (d) { return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); };
    return isoList.map(function (pair) {
      var d = new Date(pair[1]);
      return fmt(pair[0] === 'n' ? window.KATE.autoReload.next(d) : window.KATE.autoReload.boundary(d));
    });
  }, [
    ['n', '2026-08-07T22:00:00+09:00'], ['n', '2026-08-07T23:10:00+09:00'], ['n', '2026-08-07T23:40:00+09:00'],
    ['n', '2026-08-08T00:40:00+09:00'], ['n', '2026-08-08T01:10:00+09:00'],
    ['b', '2026-08-07T09:00:00+09:00'], ['b', '2026-08-07T23:15:00+09:00'], ['b', '2026-08-08T00:10:00+09:00'], ['b', '2026-08-07T22:59:00+09:00']
  ]);
  check('next: 22:00 → 当日23:00', m2[0], '8/7 23:00');
  check('next: 23:10 → 当日23:30', m2[1], '8/7 23:30');
  check('next: 23:40 → 翌日0:00', m2[2], '8/8 0:00');
  check('next: 0:40 → 当日1:00', m2[3], '8/8 1:00');
  check('next: 1:10 → 当日23:00（窓の外は夜まで待つ）', m2[4], '8/8 23:00');
  check('boundary: 日中9:00 → 当日1:00', m2[5], '8/7 1:00');
  check('boundary: 23:15 → 当日23:00', m2[6], '8/7 23:00');
  check('boundary: 0:10 → 当日0:00', m2[7], '8/8 0:00');
  check('boundary: 22:59 → 当日1:00', m2[8], '8/7 1:00');

  // ---- 発火タイミング ------------------------------------------------------
  // 各ジャンプ後に実時間を少し待つ: フェイククロックはタイマーだけを進め、
  // フェッチ応答の反映（dataLoadedAt の更新）は実時間の非同期で走るため。
  await page.clock.fastForward(60 * 1000);            // → 22:59
  await sleep(300);
  check('22:59 では再読み込みしない', hits, 1);

  await page.clock.fastForward(2 * 60 * 1000);        // → 23:01（23:00:05 発火）
  await waitFor(function () { return hits; }, 2);
  await sleep(500);
  check('23:00 に自動で再読み込みする', hits, 2);

  await page.clock.fastForward(30 * 60 * 1000);       // → 23:31（23:30:05 発火）
  await waitFor(function () { return hits; }, 3);
  await sleep(500);
  check('23:30 にも再読み込みする（30分おき）', hits, 3);

  await page.clock.fastForward(30 * 60 * 1000);       // → 翌0:01（0:00:05 発火）
  await waitFor(function () { return hits; }, 4);
  await sleep(500);
  check('0:00 にも再読み込みする（日付またぎ）', hits, 4);

  // ---- 「今すぐ更新」は管理ロック解除後のみ（ロック中は出さない）-----------
  await page.evaluate(function () { location.hash = '#data'; });
  await sleep(700);
  check('ロック中は「今すぐ更新」ボタンを出さない', await page.$$eval('#sheetRefreshNow', function (n) { return n.length; }), 0);
  check('ロック中は年商カードも出さない', await page.$$eval('#annualCard', function (n) { return n.length; }), 0);

  // ---- 合言葉でロック解除 → ボタンが出る -----------------------------------
  await page.fill('#ownerPassInput', OWNER_PASS);
  await page.click('#ownerPassBtn');
  await page.waitForSelector('#sheetRefreshNow', { timeout: 5000 });
  check('解除後は「今すぐ更新」ボタンが出る', await page.$$eval('#sheetRefreshNow', function (n) { return n.length; }), 1);

  await page.click('#sheetRefreshNow');
  await waitFor(function () { return hits; }, 5);
  await sleep(500);
  check('「今すぐ更新」ボタンで手動再読み込みできる', hits, 5);

  // ---- スリープ復帰: タイマーを動かさず時刻だけ同日9:00へ（0:30/1:00を取りこぼし）
  await page.clock.setSystemTime(JST('2026-08-08T09:00:00'));
  await page.evaluate(function () { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(function () { return hits; }, 6);
  await sleep(500);
  check('画面復帰時に取りこぼし（1:00未読）を検知して読み込む', hits, 6);

  await page.evaluate(function () { document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(300);
  check('取りこぼしが無ければ画面復帰でも読み込まない', hits, 6);

  // ---- 合言葉はこの端末で記憶される（リロードしても再入力を求めない）------
  const stored = await page.evaluate(function () { return localStorage.getItem('kate-owner-unlocked'); });
  check('解除の記録を端末に保存する', typeof stored === 'string' && stored.length > 0, true);
  check('合言葉そのものは保存しない', stored.indexOf(OWNER_PASS) === -1, true);

  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(function () { location.hash = '#data'; });
  await sleep(900);
  check('リロード後も解除済み（合言葉の再入力を求めない）', await page.$$eval('#ownerPassInput', function (n) { return n.length; }), 0);
  check('リロード後も年商カードが見える', await page.$$eval('#annualCard', function (n) { return n.length; }), 1);

  // ---- 「この端末を再ロックする」で元に戻せる -------------------------------
  await page.click('#ownerRelockBtn');
  await page.waitForSelector('#ownerPassInput', { timeout: 5000 });
  check('再ロックすると合言葉の入力に戻る', await page.$$eval('#ownerPassInput', function (n) { return n.length; }), 1);
  check('再ロックで端末の記録も消える',
    await page.evaluate(function () { return localStorage.getItem('kate-owner-unlocked'); }), null);

  // ---- 合言葉を差し替えると、古い解除は無効になる --------------------------
  await page.fill('#ownerPassInput', OWNER_PASS);
  await page.click('#ownerPassBtn');
  await page.waitForSelector('#ownerRelockBtn', { timeout: 5000 });
  const ROTATED_PASS = 'rotated-owner-pass';
  OWNER_LOCK = await crypto7.encrypt(ROTATED_PASS, { role: 'owner' });   // オーナーが作り直した
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(function () { location.hash = '#data'; });
  await sleep(900);
  check('合言葉を差し替えると再入力を求める', await page.$$eval('#ownerPassInput', function (n) { return n.length; }), 1);

  // ---- 更新が全タブに波及すること（「データタブしか変わらない」の回帰防止）----
  // シートの中身を差し替えて「今すぐ更新」→ データタブの更新日時と、概要タブの
  // 数字の両方が変わることを確認する。
  await page.fill('#ownerPassInput', ROTATED_PASS);   // 直前で差し替えた合言葉
  await page.click('#ownerPassBtn');
  await page.waitForSelector('#sheetRefreshNow', { timeout: 5000 });
  const overviewTiles = function () {
    return page.evaluate(function () { return [...document.querySelectorAll('#view-overview .stat-value')].map(function (n) { return n.textContent.trim(); }).join('|'); });
  };
  const headerStamp = function () { return page.evaluate(function () { return document.querySelector('#asof').textContent.trim(); }); };
  CSV_BODY = CSV_V2;                      // シートが更新された
  await page.click('#sheetRefreshNow');
  await sleep(1500);
  check('更新後：ヘッダーのデータ更新日時が変わる', (await headerStamp()).indexOf('データ更新 8月8日 23:30') === 0, true);
  await page.evaluate(function () { location.hash = '#overview'; });
  // 数値はカウントアップ演出で徐々に上がるため、確定値になるまで待ってから判定
  await page.waitForFunction(function () {
    return [...document.querySelectorAll('#view-overview .stat-value')].some(function (n) { return n.textContent.indexOf('90,000') !== -1; });
  }, {}, { timeout: 5000 }).catch(function () {});
  const tilesV2 = await overviewTiles();
  check('更新後：概要タブの数字も新しいデータになる（¥90,000）', tilesV2.indexOf('¥90,000') !== -1, true);

  // ---- 内容が同一なら「変わっていません」と伝える --------------------------
  await page.evaluate(function () { location.hash = '#data'; });
  await sleep(700);
  await page.click('#sheetRefreshNow');           // CSV は差し替えていない＝同一
  await sleep(1200);
  const toastText = await page.evaluate(function () {
    var t = document.querySelector('.toast'); return t ? t.textContent : '';
  });
  check('同じ内容なら「変わっていません」と伝える', toastText.indexOf('変わっていません') !== -1, true);

  // ---- 取得内容の診断（更新しても変わらないときの切り分け材料）--------------
  const diag = await page.evaluate(function () {
    var c = [...document.querySelectorAll('#view-data .gsec')].find(function (g) { return /取得したデータの中身/.test(g.textContent); });
    return c ? [...c.querySelectorAll('tbody tr')].map(function (r) { return [...r.children].map(function (td) { return td.textContent.trim(); }).join('|'); }) : null;
  });
  check('診断テーブルを表示する', Array.isArray(diag) && diag.length >= 1, true);
  check('診断: 取得データ内の最新日を示す（8/6）', diag[0].indexOf('2026年8月6日') !== -1, true);
  check('診断: 取得件数を示す', diag[0].indexOf('2件') !== -1, true);

  // ---- ヘッダーに「確認」時刻が併記される（押したことが必ず見える）----------
  const hdr = await headerStamp();
  check('ヘッダーに確認時刻を併記する', /（確認 \d{1,2}:\d{2}）/.test(hdr), true);

  check('コンソールエラーなし', errors.length, 0);

  // ---- 取得に失敗したら黙って隠さず、全ビューに警告を出す ------------------
  // 起動時の自動読み込みは silent なので、従来は失敗しても何も表示されず
  // サンプルデータのまま「反映されない」状態に見えていた（実運用で発生）。
  const ctx2 = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1100, height: 900 } });
  const p2 = await ctx2.newPage();
  const tried = [];
  await p2.route('https://docs.google.com/**', function (route) { tried.push(route.request().url()); route.abort('failed'); });
  await ctx2.addInitScript(function () {
    try { localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/FAILCASE/edit#gid=0'); } catch (e) {}
  });
  await p2.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
  await sleep(2000);
  check('失敗時: 候補を2つとも試す（/export → gviz）', tried.length, 2);
  const bannerText = await p2.evaluate(function () {
    var el = [...document.querySelectorAll('#view-overview .gsec')]
      .find(function (g) { return /読み込めませんでした/.test(g.textContent); });
    return el ? el.textContent.replace(/\s+/g, ' ') : '';
  });
  check('失敗時: 概要に警告バナーを出す', bannerText.indexOf('読み込めませんでした') !== -1, true);
  check('失敗時: サンプルデータであることを明示する', bannerText.indexOf('サンプルデータ') !== -1, true);
  check('失敗時: 試した取得先を示す', bannerText.indexOf('/export?format=csv') !== -1, true);
  for (const view of ['staff', 'trend', 'rfm', 'data']) {
    await p2.evaluate(function (v) { location.hash = '#' + v; }, view);
    await sleep(500);
    const shown = await p2.evaluate(function (v) {
      return [...document.querySelectorAll('#view-' + v + ' .gsec')]
        .some(function (g) { return /読み込めませんでした/.test(g.textContent); });
    }, view);
    check('失敗時: ' + view + 'タブにも警告を出す', shown, true);
  }
  await p2.close(); await ctx2.close();

  await browser.close(); server.close();
  console.log('\x1b[1mSUMMARY\x1b[0m  \x1b[32m' + pass + ' pass\x1b[0m · \x1b[31m' + fail + ' fail\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
