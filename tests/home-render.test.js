/* ホーム画面（お店の今月・あなたの今月・目標の達成度）の描画テスト。
 * 実際のダッシュボードをヘッドレス Chromium で開き、docs.google.com への取得を
 * 差し替えて「スプレッドシート連携中」を再現する（予約データ＝同梱サンプルをCSV化、
 * 「目標」タブ＝tests/helpers/sample-sheet.js の例）。
 *  1. ホームに「お店の今月」の実績（¥125,410・税抜）と、目標 ¥1,200,000 の達成率が出る
 *  2. 「あなた」を選ぶと、そのスタッフの今月と目標（momo ¥700,000）が出る
 *  3. 税込に切り替えると、税抜で書いた目標も ×1.1 で比べる
 *  4. 「目標」タブが無い（gviz が1枚目の予約データを返す）ときは、目標を出さない
 *  5. スタッフタブは「あなた」を開き、比較に切り替えられる
 * Run: node tests/home-render.test.js（Chromium が無い環境では SKIP） */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const { sampleCsv, targetsCsv } = require('./helpers/sample-sheet.js');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (e) { /* not installed */ }
const EXEC = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
if (!chromium || !fs.existsSync(EXEC)) {
  console.log('HOME RENDER: \x1b[33mSKIP\x1b[0m (playwright-core / Chromium not available)');
  process.exit(0);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const server = http.createServer(function (req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  // 合言葉・管理ロックは無効（v:0 相当）にして、データタブの目標カードまで見られるようにする
  if (urlPath === '/data/owner-lock.json' || urlPath === '/data/shared-link.json' || urlPath === '/favicon.ico') { res.writeHead(404); res.end(); return; }
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? '  \x1b[32mok\x1b[0m    ' : '  \x1b[31mFAIL\x1b[0m  ') + name + (ok ? '' : '  got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)));
}
const DATA = sampleCsv(), TARGETS = targetsCsv();
const TAB = encodeURIComponent('目標');

async function open(browser, opts) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 844 }, timezoneId: 'Asia/Tokyo' });
  await ctx.addInitScript(function (me) {
    try {
      localStorage.setItem('kate-sheet-url', 'https://docs.google.com/spreadsheets/d/HOMETEST/edit#gid=0');
      if (me) localStorage.setItem('kate-me', me); else localStorage.removeItem('kate-me');
    } catch (e) {}
  }, opts.me || null);
  const page = await ctx.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', function (e) { errors.push(String(e.message)); });
  page.on('console', function (m) { if (m.type() === 'error' && !/favicon|404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  let targetHits = 0;
  await page.route('https://docs.google.com/**', function (route) {
    const u = route.request().url();
    if (u.indexOf('sheet=' + TAB) !== -1) {
      targetHits++;
      // 目標タブが無い場合、gviz は1枚目（予約データ）を返すことがある → それを再現
      return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: opts.noTargets ? DATA : TARGETS });
    }
    return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: DATA });
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(function () { var a = document.querySelector('#asof'); return a && /最終読込/.test(a.textContent); }, {}, { timeout: 8000 }).catch(function () {});
  await page.waitForTimeout(600);
  return { ctx: ctx, page: page, errors: errors, targetHits: function () { return targetHits; } };
}
function text(page, sel) { return page.evaluate(function (s) { var e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel); }

(async () => {
  await new Promise(function (ok) { server.listen(0, '127.0.0.1', ok); });
  const browser = await chromium.launch({ executablePath: EXEC });

  console.log('\n\x1b[1m■ 目標タブあり・あなた＝momo（390px）\x1b[0m');
  {
    const o = await open(browser, { me: 'momo' });
    const p = o.page;
    check('目標タブを読みに行った', o.targetHits() >= 1, true);
    const store = await text(p, '[data-kpi="home-store-revenue"]');
    check('お店の今月の実績 ¥125,410（税抜）', store && store.indexOf('¥125,410') !== -1, true);
    check('お店の今月の目標 ¥1,200,000', store && store.indexOf('¥1,200,000') !== -1, true);
    check('お店の達成率（実績）10%', store && /達成率（実績 ／ 予約込み）\s*10% ／ 73%/.test(store), true);
    check('お店の目標リングが描かれる', await p.$$eval('#hStoreRing svg', function (n) { return n.length; }), 1);
    const me = await text(p, '[data-kpi="home-me-revenue"]');
    check('あなた（momo）の今月 ¥76,209', me && me.indexOf('¥76,209') !== -1, true);
    check('momo の目標 ¥700,000', me && me.indexOf('¥700,000') !== -1, true);
    check('momo の担当割合 61%', me && /お店の今月の売上のうち 61% を担当/.test(me), true);
    check('あなたのリングが描かれる', await p.$$eval('#hMeRing svg', function (n) { return n.length; }), 1);
    const hint = await text(p, '[data-kpi="home-me-next-hint"]');
    check('次の一手（momo はリピート 67% → 目安70%）', hint && /リピート/.test(hint) && /67%/.test(hint), true);
    // 来店タイル（今月16件 / 先月の同じ時期7件）
    const visits = await text(p, '[data-kpi="home-store-visits"]');
    check('来店 16件・先月同時期 7件', visits && /16件/.test(visits) && /先月同時期 7件/.test(visits), true);

    // 税込に切り替え → 目標（税抜で記入）は ×1.1 で比べる
    await p.click('#taxLabelIncl');
    await p.waitForTimeout(500);
    const storeIncl = await text(p, '[data-kpi="home-store-revenue"]');
    check('税込表示: 目標は ¥1,320,000', storeIncl && storeIncl.indexOf('¥1,320,000') !== -1, true);
    check('税込表示: 実績は ¥137,951', storeIncl && storeIncl.indexOf('¥137,951') !== -1, true);
    check('税込表示でも達成率は同じ 10%', storeIncl && /達成率（実績 ／ 予約込み）\s*10% ／ 73%/.test(storeIncl), true);
    await p.click('#taxLabelExcl');
    await p.waitForTimeout(300);

    // スタッフタブは「あなた」を開く → 比較に切り替えられる
    await p.evaluate(function () { location.hash = '#staff'; });
    await p.waitForTimeout(500);
    check('スタッフタブは momo を表示', await p.$$eval('#staffSeg button.active', function (n) { return n.map(function (b) { return b.textContent; }).join(); }), 'momo');
    check('momo の定着メーターがある', await p.$$eval('#stMeterRepeat .meter', function (n) { return n.length; }), 1);
    check('momo の月ごとの数字の表がある', await p.$$eval('[data-kpi="staff-momo-rev-periods"]', function (n) { return n.length; }), 1);
    await p.click('#staffSeg button[data-k="__compare"]');
    await p.waitForTimeout(500);
    check('比較に切り替えると比較表が出る', await p.$$eval('.vs-table', function (n) { return n.length; }), 1);

    // データタブの目標カード
    await p.evaluate(function () { location.hash = '#data'; });
    await p.waitForTimeout(500);
    const dataTxt = await p.evaluate(function () { return document.querySelector('#view-data').textContent.replace(/\s+/g, ' '); });
    check('データタブ: 目標を読み込み済み', /読み込み済み/.test(dataTxt) && /7月の目標：お店 ¥1,200,000/.test(dataTxt), true);
    check('データタブ: 見出しのコピー用ボタン', await p.$$eval('#view-data [data-copy]', function (n) { return n.length >= 3; }), true);
    check('コンソールエラーなし', o.errors.length, 0);
    if (o.errors.length) console.log('    ' + o.errors.join('\n    '));
    await o.ctx.close();
  }

  console.log('\n\x1b[1m■ 目標タブなし（gviz が予約データを返す）・あなた未選択（1280px）\x1b[0m');
  {
    const o = await open(browser, { noTargets: true, width: 1280 });
    const p = o.page;
    const store = await text(p, '[data-kpi="home-store-revenue"]');
    check('実績は出る', store && store.indexOf('¥125,410') !== -1, true);
    check('目標は出さない（予約データを目標と取り違えない）', store && store.indexOf('目標') === -1, true);
    check('リングは描かない', await p.$$eval('#hStoreRing', function (n) { return n.length; }), 0);
    check('あなた未選択: 名前を選ぶボタンが出る', await p.$$eval('#view-home [data-me]', function (n) { return n.length; }), 2);
    await p.click('#view-home [data-me="aoi"]');
    await p.waitForTimeout(500);
    check('名前を選ぶと aoi の今月が出る', !!(await text(p, '[data-kpi="home-me-revenue"]')), true);
    check('選んだ名前は端末に記憶される', await p.evaluate(function () { return localStorage.getItem('kate-me'); }), 'aoi');
    await p.evaluate(function () { location.hash = '#data'; });
    await p.waitForTimeout(500);
    const dataTxt = await p.evaluate(function () { return document.querySelector('#view-data').textContent.replace(/\s+/g, ' '); });
    check('データタブ: 目標タブが見つからない旨を出す', /「目標」という名前のタブが見つかりません/.test(dataTxt), true);
    check('コンソールエラーなし', o.errors.length, 0);
    if (o.errors.length) console.log('    ' + o.errors.join('\n    '));
    await o.ctx.close();
  }

  await browser.close();
  server.close();
  console.log('\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m' + pass + ' pass\x1b[0m · \x1b[31m' + fail + ' fail\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('HOME RENDER: unexpected error', e); server.close(); process.exit(1); });
