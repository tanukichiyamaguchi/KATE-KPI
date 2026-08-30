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
// data/shared-link.json（合言葉で暗号化した連携URL）。既定では配信しない。
let SHARED_BLOB = null;
const server = http.createServer(function (req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/favicon.ico') { res.writeHead(404); res.end(); return; }
  if (urlPath === '/data/shared-link.json') {
    if (!SHARED_BLOB) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(SHARED_BLOB)); return;
  }
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

// 1回の読み込みで叩く取得先の本数。編集URLは /export と gviz の両方を並行して
// 取りに行き、取れた中から中身がいちばん新しいものを採用する（片方がCORSで
// 読めない環境／片方が古いキャッシュを返す場合の取りこぼしを防ぐため）。
const PER_LOAD = require('../assets/js/sheets.js')
  .csvEndpoints('https://docs.google.com/spreadsheets/d/X/edit#gid=0').length;

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
  check('起動時に1回読み込む（従来どおり）', hits, 1 * PER_LOAD);

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
  check('next: 1:10 → 当日1:30（窓は朝5時まで続く）', m2[4], '8/8 1:30');
  check('boundary: 日中9:00 → 当日5:00', m2[5], '8/7 5:00');
  check('boundary: 23:15 → 当日23:00', m2[6], '8/7 23:00');
  check('boundary: 0:10 → 当日0:00', m2[7], '8/8 0:00');
  check('boundary: 22:59 → 当日5:00', m2[8], '8/7 5:00');

  // ---- 発火タイミング ------------------------------------------------------
  // 各ジャンプ後に実時間を少し待つ: フェイククロックはタイマーだけを進め、
  // フェッチ応答の反映（dataLoadedAt の更新）は実時間の非同期で走るため。
  await page.clock.fastForward(60 * 1000);            // → 22:59
  await sleep(300);
  check('22:59 では再読み込みしない', hits, 1 * PER_LOAD);

  await page.clock.fastForward(2 * 60 * 1000);        // → 23:01（23:00:05 発火）
  await waitFor(function () { return hits; }, 2);
  await sleep(500);
  check('23:00 に自動で再読み込みする', hits, 2 * PER_LOAD);

  await page.clock.fastForward(30 * 60 * 1000);       // → 23:31（23:30:05 発火）
  await waitFor(function () { return hits; }, 3);
  await sleep(500);
  check('23:30 にも再読み込みする（30分おき）', hits, 3 * PER_LOAD);

  await page.clock.fastForward(30 * 60 * 1000);       // → 翌0:01（0:00:05 発火）
  await waitFor(function () { return hits; }, 4);
  await sleep(500);
  check('0:00 にも再読み込みする（日付またぎ）', hits, 4 * PER_LOAD);

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
  check('「今すぐ更新」ボタンで手動再読み込みできる', hits, 5 * PER_LOAD);

  // ---- スリープ復帰: タイマーを動かさず時刻だけ同日9:00へ（0:30/1:00を取りこぼし）
  await page.clock.setSystemTime(JST('2026-08-08T09:00:00'));
  await page.evaluate(function () { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(function () { return hits; }, 6);
  await sleep(500);
  check('画面復帰時に取りこぼし（1:00未読）を検知して読み込む', hits, 6 * PER_LOAD);

  await page.evaluate(function () { document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(300);
  check('取りこぼしが無ければ画面復帰でも読み込まない', hits, 6 * PER_LOAD);

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
  // ヘッダーの主役は「最終読込」＝読みに行って成功した時刻（押せば必ず進む）。
  // シート側の同期時刻は併記。シート側が止まっても読込時刻は動くため、
  // 「更新したのに日時が変わらない」という誤解が起きない。
  const hdrV2 = await headerStamp();
  check('更新後：ヘッダーの最終読込が進む', hdrV2.indexOf('最終読込 ') === 0, true);
  check('更新後：シートが最後に変わった時刻を併記する', hdrV2.indexOf('（シートは 8月8日 23:30 更新）') !== -1, true);
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
  const dataRow = (diag || []).find(function (r) { return /件/.test(r) && /2026年/.test(r); }) || '';
  check('診断: 取得データ内の最新日を示す（8/6）', dataRow.indexOf('2026年8月6日') !== -1, true);
  check('診断: 取得件数を示す', dataRow.indexOf('2件') !== -1, true);
  // 経路ごとの結果（どちらの経路が古いのかが一目で分かる切り分け材料）
  const routeRow = (diag || []).find(function (r) { return /経路ごとの取得結果/.test(r); }) || '';
  check('診断: 経路ごとの取得結果を出す', routeRow.indexOf('（採用）') !== -1, true);

  // ---- ヘッダーに「確認」時刻が併記される（押したことが必ず見える）----------
  const hdr = await headerStamp();
  check('ヘッダーの読込時刻は日時つきで出る', /^最終読込 \d{1,2}月\d{1,2}日 \d{2}:\d{2}/.test(hdr), true);
  check('ヘッダーにシートの更新時刻を併記する', /（シートは \d{1,2}月\d{1,2}日 \d{2}:\d{2} 更新）/.test(hdr), true);

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
  const bannerHtml = function () {
    return p2.evaluate(function () {
      var el = document.querySelector('#sheetAlert');
      return el ? el.innerHTML : '';
    });
  };
  const bannerText = await p2.evaluate(function () {
    var el = document.querySelector('#sheetAlert');
    return el ? el.textContent.replace(/\s+/g, ' ') : '';
  });
  check('失敗時: 警告バナーを出す', bannerText.indexOf('読み込めませんでした') !== -1, true);
  check('失敗時: サンプルデータであることを明示する', bannerText.indexOf('サンプルデータ') !== -1, true);
  check('失敗時: 試した取得経路を示す',
    bannerText.indexOf('CSV書き出し') !== -1 && bannerText.indexOf('クエリ') !== -1, true);
  // バナーは全ビュー（スタッフも見る画面）に出る。ここに取得先URLを載せると、
  // 管理ロックが隠しているシートのIDがそのまま漏れる。経路名だけを出すこと。
  const rawBanner = await bannerHtml();
  check('失敗時: シートのIDを画面に出さない', rawBanner.indexOf('FAILCASE') === -1, true);
  // 経路ごとに失敗理由が違うことがある。1本分だけ出すと本当の原因が隠れる。
  check('失敗時: 経路ごとの理由を並べる',
    bannerText.indexOf('CSV書き出し：') !== -1 && bannerText.indexOf('クエリ：') !== -1, true);
  check('失敗時: 取得先URLを画面に出さない', rawBanner.indexOf('docs.google.com') === -1 && rawBanner.indexOf('/export') === -1, true);
  for (const view of ['staff', 'trend', 'rfm', 'data']) {
    await p2.evaluate(function (v) { location.hash = '#' + v; }, view);
    await sleep(500);
    const shown = await p2.evaluate(function () {
      var el = document.querySelector('#sheetAlert');
      return !!el && /読み込めませんでした/.test(el.textContent);
    });
    check('失敗時: ' + view + 'タブでも警告が消えない', shown, true);
  }
  await p2.close(); await ctx2.close();

  // ---- 自動更新の実績を記録し、動いていなければそう表示する ----------------
  // 「毎日23時に更新のはずが更新されていない」の切り分け材料。ページを開いて
  // いない端末ではタイマーが動かないため、実績が無いことを画面で示す。
  // 直前のシナリオで合言葉を差し替えているので、元の OWNER_PASS に戻してから開く
  OWNER_LOCK = await crypto7.encrypt(OWNER_PASS, { role: 'owner' });
  const ctx3 = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const p3 = await ctx3.newPage();
  let hits3 = 0;
  await p3.route('https://docs.google.com/**', function (route) {
    hits3++; route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: CSV });
  });
  await ctx3.addInitScript(function () {
    try { localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/AUTOSTAT/edit#gid=0'); } catch (e) {}
  });
  await p3.clock.install({ time: JST('2026-08-20T22:50:00') });
  await p3.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
  await p3.clock.pauseAt(JST('2026-08-20T22:58:00'));
  await waitFor(function () { return hits3; }, 1);
  await p3.evaluate(function () { location.hash = '#data'; });
  await sleep(700);
  await p3.fill('#ownerPassInput', OWNER_PASS);
  await p3.click('#ownerPassBtn');
  // 時計を止めているとカードの表示アニメーション（rAF）も止まり「不可視」と
  // 判定されるため、可視ではなく DOM 上の存在で待つ。
  await p3.waitForSelector('#sheetRefreshNow', { state: 'attached', timeout: 5000 });
  const before3 = await p3.evaluate(function () {
    var el = [...document.querySelectorAll('#view-data .gsec')]
      .find(function (g) { return /取得したデータの中身/.test(g.textContent); });
    return el ? el.textContent.replace(/\s+/g, ' ') : '';
  });
  check('自動更新前: まだ動いていないと表示する', before3.indexOf('まだ一度も動いていません') !== -1, true);
  check('自動更新前: 次回の予定を表示する', before3.indexOf('次回の予定') !== -1, true);
  check('開いた端末でのみ動く旨を明示する', before3.indexOf('開いたままの端末でのみ動きます') !== -1, true);

  await p3.clock.fastForward(3 * 60 * 1000);   // → 23:01（23:00:05 発火）
  await waitFor(function () { return hits3; }, 2);
  await sleep(600);
  await p3.evaluate(function () { location.hash = '#overview'; location.hash = '#data'; });
  await sleep(700);
  // 「23:00」は予定時刻の固定ラベル（23:00 / 23:30 / …）にも含まれるため、
  // カード全体の文字列で探すと何を書いても通ってしまう。実績値そのものを読む。
  const lastFire = await p3.evaluate(function () {
    var d = [...document.querySelectorAll('#view-data .datainfo div')]
      .find(function (n) { return /前回の自動更新/.test(n.textContent); });
    var b = d && d.querySelector('b');
    return b ? b.textContent.trim() : '(なし)';
  });
  check('自動更新後: 前回の実績時刻を表示する', lastFire !== 'まだ一度も動いていません', true);
  // 記録されるのは「実際に発火した瞬間」。フェイククロックは 22:58 → 23:01 と
  // 飛ぶため 23:01 になるが、実運用では 23:00:05 に発火して 23:00 と出る。
  // どちらにせよ 8/20 の 23時台でなければ、予定時刻や別の値を出している。
  check('自動更新後: 発火時刻そのものを記録する',
    /^8月20日 23:0\d$/.test(lastFire) ? 'ok' : lastFire, 'ok');
  await p3.close(); await ctx3.close();

  // ---- 失敗しても「いま何が表示されているか」の記録を消さない／復旧で消える ----
  // 失敗行で診断表を置き換えると、表示中の数字がどのデータなのか分からなくなる。
  // また、復旧・連携解除のあともバナーが残ると、直しようのない警告になる。
  const ctx4 = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const p4 = await ctx4.newPage();
  let failMode = false;
  await p4.route('https://docs.google.com/**', function (route) {
    if (failMode) return route.abort('failed');
    route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: CSV });
  });
  await ctx4.addInitScript(function () {
    try { localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/DIAGCASE/edit#gid=0'); } catch (e) {}
  });
  await p4.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
  await p4.evaluate(function () { location.hash = '#data'; });
  await sleep(600);
  await p4.fill('#ownerPassInput', OWNER_PASS);
  await p4.click('#ownerPassBtn');
  await p4.waitForSelector('#sheetRefreshNow', { timeout: 5000 });
  const diagRows = function () {
    return p4.evaluate(function () {
      var c = [...document.querySelectorAll('#view-data .gsec')]
        .find(function (g) { return /取得したデータの中身/.test(g.textContent); });
      if (!c) return [];
      return [...c.querySelectorAll('tbody tr')].map(function (tr) { return tr.textContent.replace(/\s+/g, ' ').trim(); });
    });
  };
  const alertText = function () {
    return p4.evaluate(function () {
      var el = document.querySelector('#sheetAlert');
      return el ? el.textContent.replace(/\s+/g, ' ') : '';
    });
  };
  const okRows = await diagRows();
  check('成功時: 診断表にデータ行が出る', okRows.filter(function (r) { return /予約データ/.test(r) && /件/.test(r); }).length, 1);

  // 未連携の会計側URL欄に入力途中の文字を置く（再描画で消えないことの確認用）
  await p4.fill('#sheetUrlKaikei', 'https://docs.google.com/spreadsheets/d/TYPING-IN-PROGRESS/edit');
  failMode = true;
  await p4.click('#sheetRefreshNow');
  await sleep(1500);
  const failRows = await diagRows();
  check('失敗時: 診断表に失敗行を足す', failRows.some(function (r) { return /読み込み失敗/.test(r); }), true);
  check('失敗時: 診断表のデータ行を消さない', failRows.some(function (r) { return /予約データ/.test(r) && /件/.test(r); }), true);
  const failAlert = await alertText();
  check('失敗時: 前回の内容を表示中だと伝える', failAlert.indexOf('前回読み込んだ内容') !== -1, true);
  check('失敗時: サンプルだと誤って言わない', failAlert.indexOf('サンプルデータ') === -1, true);
  check('失敗時: 入力途中のURLを消さない',
    await p4.inputValue('#sheetUrlKaikei'), 'https://docs.google.com/spreadsheets/d/TYPING-IN-PROGRESS/edit');

  // 復旧したらバナーも失敗行も消える（消えなければ「直しようのない警告」になる）
  failMode = false;
  await p4.click('#sheetRefreshNow');
  await sleep(1500);
  check('復旧時: 警告バナーが消える', (await alertText()).indexOf('読み込めませんでした'), -1);
  check('復旧時: 診断表の失敗行が消える', (await diagRows()).some(function (r) { return /読み込み失敗/.test(r); }), false);

  // 連携を解除したら、その連携についての警告は残らない
  failMode = true;
  await p4.click('#sheetRefreshNow');
  await sleep(1500);
  check('解除前: 警告バナーが出ている', (await alertText()).indexOf('読み込めませんでした') !== -1, true);
  await p4.click('#sheetUnlinkBtnYoyaku');
  await sleep(800);
  check('解除後: 警告バナーが消える', (await alertText()).indexOf('読み込めませんでした'), -1);
  await p4.close(); await ctx4.close();

  // ---- 経路が複数あるとき、いちばん新しい内容が必ず採用される ---------------
  // 「シートは更新されているのに反映されない」の本丸。/export（常に最新だが
  // 別オリジンからは CORS で読めないことがある）と gviz（読めるが Google 側で
  // キャッシュされることがある）は、どちらが使えるか・どちらが新しいかが環境と
  // タイミングで変わる。片方に賭けると必ず取りこぼすので、両方取って新しい方を採る。
  const CSV_FRESH = [
    'ステータス,来店日,お名前,スタッフ名,予約時合計金額,会計時合計金額,データ更新日時',
    '会計済み,2026/08/28,新規花子,momo,30000,30000,2026/08/28 23:30:00'
  ].join('\n');
  const CSV_STALE = [
    'ステータス,来店日,お名前,スタッフ名,予約時合計金額,会計時合計金額,データ更新日時',
    '会計済み,2026/08/06,旧花子,momo,5000,5000,2026/08/06 1:00:00'
  ].join('\n');

  const freshCase = async function (label, handler) {
    const c = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
    const pg = await c.newPage();
    await pg.route('https://docs.google.com/**', handler);
    await c.addInitScript(function () {
      try { localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/FRESHPICK/edit#gid=0'); } catch (e) {}
    });
    await pg.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
    await sleep(1800);
    const hdr = await pg.evaluate(function () { return document.querySelector('#asof').textContent.trim(); });
    await pg.evaluate(function () { location.hash = '#data'; });
    await sleep(600);
    await pg.fill('#ownerPassInput', OWNER_PASS);
    await pg.click('#ownerPassBtn');
    await pg.waitForSelector('#sheetRefreshNow', { timeout: 5000 });
    const rows = await pg.evaluate(function () {
      var g = [...document.querySelectorAll('#view-data .gsec')].find(function (x) { return /取得したデータの中身/.test(x.textContent); });
      return g ? [...g.querySelectorAll('tbody tr')].map(function (r) { return r.textContent.replace(/\s+/g, ' ').trim(); }) : [];
    });
    const alert = await pg.evaluate(function () {
      var el = document.querySelector('#sheetAlert');
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    await pg.close(); await c.close();
    return { label: label, hdr: hdr, rows: rows, alert: alert };
  };

  // (1) gviz が 8/6 の古いキャッシュ、/export が 8/28 の最新 → 最新が勝つ
  const a = await freshCase('export新', function (route) {
    const u = route.request().url();
    route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: /\/export\?/.test(u) ? CSV_FRESH : CSV_STALE });
  });
  check('古いキャッシュより新しい内容を採用する', a.hdr.indexOf('（シートは 8月28日 23:30 更新）') !== -1, true);
  check('採用しなかった経路も診断に残す', a.rows.some(function (r) { return /経路ごとの取得結果/.test(r) && /2026年8月6日/.test(r); }), true);
  check('どちらを採用したかを診断に出す',
    a.rows.some(function (r) { return /CSV書き出し＝2026年8月28日（採用）/.test(r); }), true);

  // (2) 逆方向 — /export が古く gviz が新しい場合も、新しい方が勝つ
  const b2 = await freshCase('gviz新', function (route) {
    const u = route.request().url();
    route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: /\/export\?/.test(u) ? CSV_STALE : CSV_FRESH });
  });
  check('経路の優先順ではなく中身の新しさで選ぶ', b2.hdr.indexOf('（シートは 8月28日 23:30 更新）') !== -1, true);
  check('gviz を採用したことが診断で分かる',
    b2.rows.some(function (r) { return /クエリ＝2026年8月28日（採用）/.test(r); }), true);

  // (3) /export が CORS で読めない環境でも、gviz の最新が届く（取りこぼさない）
  const c3 = await freshCase('export不通', function (route) {
    const u = route.request().url();
    if (/\/export\?/.test(u)) return route.abort('failed');
    route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: CSV_FRESH });
  });
  check('片方の経路が遮断されても最新が反映される', c3.hdr.indexOf('（シートは 8月28日 23:30 更新）') !== -1, true);
  check('遮断された経路は診断に「読めず」と出る', c3.rows.some(function (r) { return /読めず/.test(r); }), true);
  // 片方が遮断されても内容は届いている。ここで「読み込めませんでした」と出すと
  // 「反映されていない」と誤解させるため、全経路が駄目だったときだけ出す。
  // （シートの更新が古いこと自体を知らせる別のバナーはこの限りではない）
  check('片方が生きていれば読み込み失敗の警告は出さない', c3.alert.indexOf('読み込めませんでした'), -1);
  check('全経路が生きているときも読み込み失敗の警告は出さない', a.alert.indexOf('読み込めませんでした'), -1);

  // ---- 連携URLを取り違えても、もう一方の連携URLを壊さない -------------------
  // 2枚の連携URLが（タブ指定が効かないなどで）どちらも同じ形式の内容を返すと、
  // 従来は検出フォーマット側のスロットへ無条件に書き込み、localStorage の
  // 連携URLまで上書きしていた。結果、片方のURLが端末から永久に消え、
  // 以後どれだけ直しても会計明細が入らない状態になっていた（恒久的な破損）。
  const ctx6 = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const p6 = await ctx6.newPage();
  // どのURLを叩いても「予約データ」の内容が返る（＝タブ指定が効いていない状態）
  await p6.route('https://docs.google.com/**', function (route) {
    route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: CSV });
  });
  await ctx6.addInitScript(function () {
    try {
      localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/AAA/edit#gid=0');
      localStorage.setItem('kate-sheet-url-kaikei', 'https://docs.google.com/spreadsheets/d/BBB/edit#gid=999');
    } catch (e) {}
  });
  await p6.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
  await sleep(2000);
  const saved6 = await p6.evaluate(function () {
    return { y: localStorage.getItem('kate-sheet-url'), k: localStorage.getItem('kate-sheet-url-kaikei') };
  });
  check('取り違えても予約データの連携URLを保つ', saved6.y, 'https://docs.google.com/spreadsheets/d/AAA/edit#gid=0');
  check('取り違えても会計明細の連携URLを保つ', saved6.k, 'https://docs.google.com/spreadsheets/d/BBB/edit#gid=999');
  check('2つの連携URLが同じものにならない', saved6.y !== saved6.k, true);
  const alert6 = await p6.evaluate(function () {
    var el = document.querySelector('#sheetAlert'); return el ? el.textContent.replace(/\s+/g, ' ') : '';
  });
  check('取り違えを黙って処理せず知らせる', alert6.indexOf('読み込めませんでした') !== -1, true);
  check('どのタブを見ているかを疑うよう案内する', alert6.indexOf('タブ（gid）') !== -1, true);
  await p6.close(); await ctx6.close();

  // ---- すでに壊れている端末（2つのキーが同じURL）を検知して復旧を案内する ----
  const ctx7 = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const p7 = await ctx7.newPage();
  await p7.route('https://docs.google.com/**', function (route) {
    route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: CSV });
  });
  await ctx7.addInitScript(function () {
    var dup = 'https://docs.google.com/spreadsheets/d/SAME/edit#gid=0';
    try { localStorage.setItem('kate-sheet-url', dup); localStorage.setItem('kate-sheet-url-kaikei', dup); } catch (e) {}
  });
  await p7.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
  await sleep(2000);
  const after7 = await p7.evaluate(function () {
    return {
      k: localStorage.getItem('kate-sheet-url-kaikei'),
      y: localStorage.getItem('kate-sheet-url'),
      alert: (document.querySelector('#sheetAlert') || {}).textContent.replace(/\s+/g, ' ') || ''
    };
  });
  check('壊れた重複リンクを検知して外す', after7.k, null);
  check('予約データ側は残す（どちらが正しいか分からないため）',
    after7.y, 'https://docs.google.com/spreadsheets/d/SAME/edit#gid=0');
  check('重複リンクを利用者に知らせる', after7.alert.indexOf('同じものになっています') !== -1, true);
  check('合言葉からの復元を案内する', after7.alert.indexOf('合言葉を入力し直す') !== -1, true);
  await p7.close(); await ctx7.close();

  // ---- 会計明細が1件も結合できないときは、全ビューで知らせる -----------------
  // 両方のシートが読めていても、フリガナ表記や期間が合わないと結合0件になり、
  // 会計明細は丸ごと捨てられて予約データ単独で集計される（売上・店販が変わる）。
  // 取得は成功しているので失敗バナーは出ず、突合レポートは管理ロックの内側に
  // あるため、従来はスタッフも店長も気づけなかった。
  const CSV_KAIKEI_NOMATCH = [
    '会計日,お名前,フリガナ,スタッフ名,メニュー,金額',
    '2020/01/05,別人太郎,ベツジンタロウ,aoi,ラッシュ,8000'
  ].join('\n');
  const ctx8 = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const p8 = await ctx8.newPage();
  await p8.route('https://docs.google.com/**', function (route) {
    const isKaikei = /gid=222/.test(route.request().url());
    route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: isKaikei ? CSV_KAIKEI_NOMATCH : CSV });
  });
  await ctx8.addInitScript(function () {
    try {
      localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/MERGE0/edit#gid=0');
      localStorage.setItem('kate-sheet-url-kaikei', 'https://docs.google.com/spreadsheets/d/MERGE0/edit#gid=222');
    } catch (e) {}
  });
  await p8.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
  await sleep(2200);
  const alert8 = await p8.evaluate(function () {
    var el = document.querySelector('#sheetAlert'); return el ? el.textContent.replace(/\s+/g, ' ') : '';
  });
  check('結合0件を全ビューで知らせる', alert8.indexOf('1件も結合できませんでした') !== -1, true);
  check('結合0件: 集計に入っていないことを明示する', alert8.indexOf('集計に入っていません') !== -1, true);
  // 概要タブでも消えない（管理ロックの内側だけに出しても誰も気づけない）
  await p8.evaluate(function () { location.hash = '#overview'; });
  await sleep(600);
  const alert8b = await p8.evaluate(function () {
    var el = document.querySelector('#sheetAlert'); return el ? el.textContent.replace(/\s+/g, ' ') : '';
  });
  check('結合0件: 概要タブでも出る', alert8b.indexOf('1件も結合できませんでした') !== -1, true);
  await p8.close(); await ctx8.close();

  // ---- 壊れた端末から復旧できること（復旧手段が画面から消えない）------------
  // 連携URLが「保存されているが読めない」端末では、合言葉カードが出ず、URL入力欄は
  // 管理ロックの内側にあるため、スタッフ端末からは二度と直せない状態だった。
  const SHARED = await crypto7.encrypt('store-pass', {
    yoyaku: 'https://docs.google.com/spreadsheets/d/RECOVERED/edit#gid=0'
  });
  SHARED_BLOB = SHARED;
  const ctx9 = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const p9 = await ctx9.newPage();
  await p9.route('https://docs.google.com/**', function (route) {
    if (/RECOVERED/.test(route.request().url())) {
      return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: CSV });
    }
    return route.abort('failed');            // 保存されている壊れたURLは読めない
  });
  await ctx9.addInitScript(function () {
    try { localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/BROKEN/edit#gid=0'); } catch (e) {}
  });
  await p9.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
  await sleep(2000);
  const alert9 = await p9.evaluate(function () {
    var el = document.querySelector('#sheetAlert'); return el ? el.textContent.replace(/\s+/g, ' ') : '';
  });
  check('壊れた連携: 警告を出す', alert9.indexOf('読み込めませんでした') !== -1, true);
  check('壊れた連携: 復旧の入口をバナーに置く', alert9.indexOf('合言葉を入力して連携をやり直す') !== -1, true);
  await p9.evaluate(function () { location.hash = '#data'; });
  await sleep(700);
  check('壊れた連携: データタブに合言葉カードが出る',
    await p9.$$eval('#sharedPassInput', function (n) { return n.length; }), 1);
  // 実際に復旧できる
  await p9.fill('#sharedPassInput', 'store-pass');
  await p9.click('#sharedPassBtn');
  await sleep(2000);
  const recovered = await p9.evaluate(function () {
    return {
      url: localStorage.getItem('kate-sheet-url'),
      alert: (document.querySelector('#sheetAlert') || {}).textContent.replace(/\s+/g, ' ') || ''
    };
  });
  check('壊れた連携: 合言葉で正しいURLに戻る',
    recovered.url, 'https://docs.google.com/spreadsheets/d/RECOVERED/edit#gid=0');
  check('壊れた連携: 復旧すると警告が消える', recovered.alert.indexOf('読み込めませんでした'), -1);
  await p9.close(); await ctx9.close();

  // ---- 端末の保存領域が消えた場合も、全ビューで「未接続」と知らせる ----------
  // Safari の自動削除やプライベートブラウズで連携URLが消えると、従来は概要タブの
  // 案内カードしか無く、他のタブではサンプルデータが実データの顔で出ていた。
  const ctx10 = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const p10 = await ctx10.newPage();
  await p10.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
  await sleep(1200);
  for (const v of ['overview', 'staff', 'trend', 'rfm']) {
    await p10.evaluate(function (x) { location.hash = '#' + x; }, v);
    await sleep(400);
    const a = await p10.evaluate(function () {
      var el = document.querySelector('#sheetAlert'); return el ? el.textContent : '';
    });
    check('未接続: ' + v + 'タブでもサンプルだと明示する', a.indexOf('店舗データに接続していません') !== -1, true);
  }
  await p10.close(); await ctx10.close();
  SHARED_BLOB = null;

  // ---- シートが1日以上更新されていないことを、こちらから知らせる ---------------
  // シートが更新されていなければ「昨日と同じ数字」が黙って出続ける。取得自体は
  // 成功しているので失敗バナーも出ない。実運用で、この状態が何日も気づかれなかった。
  //
  // 判定は「特定の時刻までに同期されたか」ではなく「26時間以上あいたか」で行う。
  // 同期が何時に走るかは運用で変わる（実測では深夜2時台だった）ため、時刻を前提に
  // すると、その時刻から実際の同期までの間、毎晩かならず誤警告が出てしまう。
  const syncCase = async function (nowIso, stamp) {
    const c = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
    const pg = await c.newPage();
    const body = [
      'ステータス,来店日,お名前,スタッフ名,予約時合計金額,会計時合計金額,データ更新日時',
      '会計済み,2026/08/28,同期太郎,momo,7000,7000,' + stamp
    ].join('\n');
    await pg.route('https://docs.google.com/**', function (route) {
      route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: body });
    });
    await c.addInitScript(function () {
      try { localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/SYNCCHK/edit#gid=0'); } catch (e) {}
    });
    await pg.clock.install({ time: JST(nowIso) });
    await pg.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle' });
    await sleep(1800);
    const txt = await pg.evaluate(function () {
      var el = document.querySelector('#sheetAlert'); return el ? el.textContent.replace(/\s+/g, ' ') : '';
    });
    await pg.close(); await c.close();
    return txt;
  };
  const STALE_MSG = 'スプレッドシートが1日以上更新されていません';

  // まる1日以上あいている（8/28 23:00 → 8/30 03:00 ＝ 28時間）
  const stale = await syncCase('2026-08-30T03:00:00', '2026/08/28 23:00:00');
  check('1日以上あいたら知らせる', stale.indexOf(STALE_MSG) !== -1, true);
  check('シートの最終更新時刻を出す', stale.indexOf('8月28日 23:00') !== -1, true);
  check('原因がシート側だと明示する', stale.indexOf('スプレッドシート側の同期') !== -1, true);

  // 回帰防止（実運用で誤警告を出した条件そのもの）:
  // 深夜0:35時点で最終更新が前日8:30（16時間前）。同期はこのあと深夜2時台に走る。
  // 「23:00までに同期されているはず」という前提で判定すると、ここで毎晩誤警告が出る。
  const notYet = await syncCase('2026-08-30T00:35:00', '2026/08/29 8:30:00');
  check('同期がまだの時間帯でも誤警告を出さない', notYet.indexOf(STALE_MSG), -1);

  // 深夜2時台に同期が走った直後 — 当然出さない
  const justSynced = await syncCase('2026-08-30T03:00:00', '2026/08/30 2:39:00');
  check('同期直後は警告しない', justSynced.indexOf(STALE_MSG), -1);

  // 何日も止まっている場合は日数で知らせる
  const long = await syncCase('2026-08-30T15:00:00', '2026/08/06 1:00:00');
  check('何日も止まっていれば日数で知らせる', long.indexOf('日前') !== -1, true);

  await browser.close(); server.close();
  console.log('\x1b[1mSUMMARY\x1b[0m  \x1b[32m' + pass + ' pass\x1b[0m · \x1b[31m' + fail + ' fail\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
