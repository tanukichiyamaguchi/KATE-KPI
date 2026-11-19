/* ホーム画面（お店の今月・あなたの今月・目標の達成度）の描画テスト。
 * 実際のダッシュボードをヘッドレス Chromium で開き、docs.google.com への取得を
 * 差し替えて「スプレッドシート連携中」を再現する（予約データ＝同梱サンプルをCSV化、
 * 「目標」タブ＝tests/helpers/sample-sheet.js の例）。
 *  1. ホームに「お店の今月」の実績（¥125,410・税抜）と、目標 ¥1,200,000 の達成率が出る
 *  2. 「あなた」を選ぶと、そのスタッフの今月と目標（momo ¥700,000）が出る
 *  3. 税込に切り替えると、税抜で書いた目標も ×1.1 で比べる
 *  4. 「目標」タブが無い（gviz が1枚目の予約データを返す）ときは、目標を出さない
 *  5. スタッフタブは「あなた」を開き、比較に切り替えられる
 *  6. 目標リングの値・目標ペースの行・次回予約率のポイント差・「月ごとの数字」の表のセル
 *  7. 「お店だけ表示」を選んだ端末では、あなたの列を出さない（未選択のときだけ名前を尋ねる）
 *  8. スタッフ名に HTML が入っていても、画面に埋め込まれない（XSS にならない）
 *  9. 会計明細だけのデータ（これからの予約が無い）では、「残りの予約 0件」「次の予約あり 0人」と書かない
 * 10. 次の一手：リピート率だけ判定できたときに「固定化率も達成」と書かない
 * Run: node tests/home-render.test.js（Chromium が無い環境では SKIP） */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const { sampleCsv, targetsCsv, recordsCsv, sampleRows } = require('./helpers/sample-sheet.js');

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
      // me: 名前＝その人、''＝お店だけ表示、null＝未選択
      if (me !== null) localStorage.setItem('kate-me', me); else localStorage.removeItem('kate-me');
    } catch (e) {}
  }, opts.me == null ? null : opts.me);
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
      return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: opts.noTargets ? (opts.data || DATA) : (opts.targets || TARGETS) });
    }
    return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: opts.data || DATA });
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(function () { var a = document.querySelector('#asof'); return a && /最終読込/.test(a.textContent); }, {}, { timeout: 8000 }).catch(function () {});
  await page.waitForTimeout(600);
  return { ctx: ctx, page: page, errors: errors, targetHits: function () { return targetHits; } };
}
function text(page, sel) { return page.evaluate(function (s) { var e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel); }
// 「月ごとの数字」の表 → { 行の見出し: [直近3ヶ月, 先月, 今月] }（金額は .full-num の表記）
function periodCells(page, sel) {
  return page.evaluate(function (s) {
    var t = document.querySelector(s); if (!t) return null;
    var out = {};
    Array.prototype.forEach.call(t.querySelectorAll('tbody tr'), function (tr) {
      var tds = tr.querySelectorAll('td');
      out[tds[0].textContent.trim()] = Array.prototype.slice.call(tds, 1).map(function (td) {
        var f = td.querySelector('.full-num'); var sm = td.querySelector('small');
        var main = f ? f.textContent : td.childNodes[0] ? td.childNodes[0].textContent : '';
        return main.trim() + (sm ? '|' + sm.textContent.trim() : '');
      });
    });
    return out;
  }, sel);
}
// 小さなデータを作るための予約レコード
function rec(o) {
  return Object.assign({ status: '会計済み', staff: 'S', shimei: '指名なし', date: '2026-05-10', start: '10:00', end: '11:00', dur: 60, route: '電話',
    menu: 'まつげ', custKey: 'K', name: 'K', yoyakuTotal: 5000, kaikeiTotal: 0 }, o);
}

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
    // リングの値（読み上げ用の説明と、中央の文字）。どちらも実績 ÷ 目標（予約込みではない）
    check('お店のリング: 説明と中央の文字', await p.$eval('#hStoreRing svg', function (sv) { return sv.getAttribute('aria-label') + '|' + sv.textContent.trim(); }), '目標の達成率 10%（予約込み 73%）|10%目標');
    check('お店の目標ペース（3日目の目安 ¥116,129）＋¥9,281', /目標ペース（3日目の目安 ¥116,129）\s*＋¥9,281/.test(store), true);
    check('お店の目標ペースは「上回り」の色', await p.$eval('[data-kpi="home-store-revenue"]', function (c) {
      var row = Array.prototype.filter.call(c.querySelectorAll('.hc-row'), function (r) { return /目標ペース/.test(r.textContent); })[0];
      return row ? row.querySelector('.dlt').className : null; }), 'dlt up');
    // 次回予約率のポイント差は、並んで表示している整数の%どうしの差（81% − 65% ＝ 16）
    const storeNext = await text(p, '[data-kpi="home-store-next"]');
    check('次回予約率 81%・先月 65%・↑ 16ポイント', storeNext && /81%/.test(storeNext) && /↑ 16ポイント/.test(storeNext) && /先月 65%/.test(storeNext), true);
    const me = await text(p, '[data-kpi="home-me-revenue"]');
    check('あなた（momo）の今月 ¥76,209', me && me.indexOf('¥76,209') !== -1, true);
    check('momo の目標 ¥700,000', me && me.indexOf('¥700,000') !== -1, true);
    check('momo の担当割合 61%', me && /お店の今月の売上のうち 61% を担当/.test(me), true);
    check('あなたのリングが描かれる', await p.$$eval('#hMeRing svg', function (n) { return n.length; }), 1);
    check('momo のリング: 説明と中央の文字', await p.$eval('#hMeRing svg', function (sv) { return sv.getAttribute('aria-label') + '|' + sv.textContent.trim(); }), '目標の達成率 11%（予約込み 73%）|11%目標');
    check('momo の目標ペース（3日目の目安 ¥67,742）＋¥8,467', /目標ペース（3日目の目安 ¥67,742）\s*＋¥8,467/.test(me), true);
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
    const pc = await periodCells(p, '[data-kpi="staff-momo-rev-periods"]');
    check('momo 月ごとの数字: 売上（直近3ヶ月の月平均・先月・今月）', pc && pc['売上'].join(), '¥562,964,¥605,909,¥76,209');
    check('momo 月ごとの数字: 来店', pc && pc['来店'].join(), '93件,92件,11件');
    check('momo 月ごとの数字: 新規', pc && pc['新規'].join(), '43人,35人,3人');
    check('momo 月ごとの数字: 客単価（今月）', pc && pc['客単価'][2], '¥6,928');
    check('momo 月ごとの数字: 次回予約率（分子/分母つき）', pc && pc['次回予約率'].join(), '61%|172/280件,73%|67/92件,73%|8/11件');
    // 店販売上は直近3ヶ月だけ月平均（3ヶ月の合計 ¥13,000 を月平均の欄に出さない）
    check('momo 月ごとの数字: 店販売上（直近3ヶ月は月平均）', pc && pc['店販売上'] && pc['店販売上'].join(), '¥4,333,¥7,000,¥0');
    await p.click('#staffSeg button[data-k="__compare"]');
    await p.waitForTimeout(500);
    check('比較に切り替えると比較表が出る', await p.$$eval('.vs-table', function (n) { return n.length; }), 1);

    // お店の「月ごとの数字」（売上・予約）
    await p.evaluate(function () { location.hash = '#overview'; });
    await p.waitForTimeout(500);
    const sc = await periodCells(p, '[data-kpi="rev-periods"]');
    check('お店 月ごとの数字: 来店（直近3ヶ月の月平均・先月・今月）', sc && sc['来店'].join(), '118件,167件,16件');
    check('お店 月ごとの数字: 新規', sc && sc['新規'].join(), '66人,104人,8人');
    check('お店 月ごとの数字: 売上', sc && sc['売上'].join(), '¥713,252,¥1,056,774,¥125,410');
    check('お店 月ごとの数字: 店販売上（直近3ヶ月は月平均）', sc && sc['店販売上'] && sc['店販売上'].join(), '¥5,333,¥10,000,¥10,000');

    // 顧客一覧の「予約 M/D」は、そのお客様のいちばん早い予約の日付（月の取り違え・日付のずれを見る）
    await p.evaluate(function () { location.hash = '#rfm'; });
    await p.waitForTimeout(500);
    const chipOf = function (name) {
      return p.evaluate(function (nm) {
        var rows = Array.prototype.filter.call(document.querySelectorAll('#rfmTable tbody tr'), function (tr) { return tr.cells[0].textContent.trim() === nm; });
        return rows.length === 1 ? rows[0].cells[5].textContent.trim() : 'rows=' + rows.length;
      }, name);
    };
    check('顧客一覧: 鈴木芽依 は「予約 8/10」（基準日と違う月の予約）', await chipOf('鈴木芽依'), '予約 8/10');
    check('顧客一覧: 前田愛 は「予約 7/9」（日と月の数字が違う）', await chipOf('前田愛'), '予約 7/9');

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

  console.log('\n\x1b[1m■ お店だけ表示（この端末で「（お店だけ表示）」を選んだ）\x1b[0m');
  {
    const o = await open(browser, { me: '' });
    const p = o.page;
    check('あなたの列を出さない（名前を尋ねない）', await p.evaluate(function () { return !/あなたはどなたですか/.test(document.querySelector('#view-home').textContent) && !document.querySelector('#view-home [data-me]'); }), true);
    check('お店の列だけの配置', await p.$$eval('#view-home .home-cols--single', function (n) { return n.length; }), 1);
    check('選択欄は「お店だけ表示」', await p.$eval('#mePicker', function (sl) { return sl.value; }), '__store');
    await p.selectOption('#mePicker', 'momo');
    await p.waitForTimeout(500);
    check('名前を選ぶと momo の今月が出る', !!(await text(p, '[data-kpi="home-me-revenue"]')), true);
    check('選んだあともフォーカスは選択欄に残る', await p.evaluate(function () { return document.activeElement && document.activeElement.id; }), 'mePicker');
    await p.selectOption('#mePicker', '__store');
    await p.waitForTimeout(500);
    check('「（お店だけ表示）」に戻すと、あなたの列が消える', await p.$$eval('#view-home [data-kpi="home-me-revenue"]', function (n) { return n.length; }), 0);
    check('端末に「お店だけ」が記憶される', await p.evaluate(function () { return localStorage.getItem('kate-me'); }), '');
    check('コンソールエラーなし', o.errors.length, 0);
    if (o.errors.length) console.log('    ' + o.errors.join('\n    '));
    await o.ctx.close();
  }
  {
    // 未選択の端末: 「選んでください」が選ばれた状態で、「（お店だけ表示）」を選ぶと切り替わる
    const o = await open(browser, {});
    const p = o.page;
    check('未選択: 選択欄は「選んでください」', await p.$eval('#mePicker', function (sl) { return sl.value; }), '__unset');
    await p.selectOption('#mePicker', '__store');
    await p.waitForTimeout(500);
    check('未選択から「（お店だけ表示）」を選べる', await p.evaluate(function () { return localStorage.getItem('kate-me'); }), '');
    check('…そしてあなたの列が消える', await p.$$eval('#view-home .home-cols--single', function (n) { return n.length; }), 1);
    await o.ctx.close();
  }

  console.log('\n\x1b[1m■ スタッフ名に HTML が入っている（XSS にならない）\x1b[0m');
  {
    const EVIL = 'x"><img src=x onerror="window.__xss=1">&co';
    const rows = sampleRows().map(function (r) { if (r.staff === 'aoi') r.staff = EVIL; return r; });
    const o = await open(browser, { me: EVIL, data: recordsCsv(rows) });
    const p = o.page;
    await p.evaluate(function () { location.hash = '#staff'; });
    await p.waitForTimeout(700);
    check('スクリプトが動いていない', await p.evaluate(function () { return typeof window.__xss; }), 'undefined');
    check('スタッフ画面に <img> が入り込まない', await p.$$eval('#view-staff img, #view-home img', function (n) { return n.length; }), 0);
    check('スタッフ画面の data-kpi はすべて名前をそのまま含む', await p.evaluate(function (name) {
      var els = document.querySelectorAll('#view-staff [data-kpi^="staff-"]');
      return els.length >= 8 && Array.prototype.every.call(els, function (e) { return e.getAttribute('data-kpi').indexOf(name) !== -1; });
    }, EVIL), true);
    check('グラフの凡例は名前をそのまま表示（&amp; のような二重の変換をしない）', await p.evaluate(function (name) {
      var it = Array.prototype.map.call(document.querySelectorAll('#cOneSpend .kate-legend-item'), function (e) { return e.textContent; });
      return it.indexOf(name) !== -1;
    }, EVIL), true);
    check('コンソールエラーなし', o.errors.length, 0);
    if (o.errors.length) console.log('    ' + o.errors.join('\n    '));
    await o.ctx.close();
  }

  console.log('\n\x1b[1m■ 会計明細だけのデータ（これからの予約が無い）\x1b[0m');
  {
    const rows = sampleRows().filter(function (r) { return r.status === '会計済み'; });
    const o = await open(browser, { me: 'momo', data: recordsCsv(rows), noTargets: true });
    const p = o.page;
    const store = await text(p, '[data-kpi="home-store-revenue"]');
    check('「残りの予約 0件・¥0」と書かない', store && !/残りの予約/.test(store) && !/0件・¥0/.test(store), true);
    check('予約込みの見込みは「—」と理由', store && /予約込みの見込み\s*—/.test(store) && /会計明細には予約が含まれないため/.test(store), true);
    const nx = await text(p, '[data-kpi="home-store-next"]');
    check('今月の次回予約率は「—（再来待ち）」で、0%と出さない', nx && /—/.test(nx) && /再来待ち/.test(nx) && !/0%/.test(nx), true);
    check('次の一手は提案を出さない（会計明細だけのデータの理由）', /会計明細だけのデータには「これからの予約」が含まれないため/.test(await text(p, '[data-kpi="home-me-next-hint"]')), true);
    await p.evaluate(function () { location.hash = '#overview'; });
    await p.waitForTimeout(500);
    const sc = await periodCells(p, '[data-kpi="rev-periods"]');
    check('お店の月ごとの数字: 先月・今月の次回予約率は「再来待ち」', sc && sc['次回予約率'][1] === '—|再来待ち' && sc['次回予約率'][2] === '—|再来待ち', true);
    check('お店の月ごとの数字: 直近3ヶ月は30日経った月だけ（セルは「※」・説明は表の下）', sc && /件※$/.test(sc['次回予約率'][0]), true);
    check('お店の月ごとの数字: 表の下に「直近の月の来店を除いています」の注記', /直近の月の来店を除いています/.test(await p.evaluate(function () { var t = document.querySelector('[data-kpi="rev-periods"]'); var n = t && t.closest('.table-wrap').nextElementSibling; return n ? n.textContent : ''; })), true);
    await p.evaluate(function () { location.hash = '#rfm'; });
    await p.waitForTimeout(500);
    const rfm = await p.evaluate(function () { return document.querySelector('#view-rfm').textContent.replace(/\s+/g, ' '); });
    check('顧客: 「次の予約あり 0人」と書かない', !/次の予約あり\s*i?\s*0人/.test(rfm) && /次の予約あり\s*i?\s*—/.test(rfm), true);
    check('顧客: 呼び戻しは「予約の有無は不明」', /周期を過ぎた方（予約の有無は不明）/.test(rfm), true);
    check('顧客: 一覧の印は「周期超過」（「対象」と断定しない）', await p.$$eval('#rfmTable .chip.down', function (n) { return n.length > 0 && n.every(function (c) { return c.textContent === '周期超過'; }); }), true);
    check('コンソールエラーなし', o.errors.length, 0);
    if (o.errors.length) console.log('    ' + o.errors.join('\n    '));
    await o.ctx.close();
  }

  console.log('\n\x1b[1m■ 予約データ（今日までの期間で出力・これからの予約が無い）\x1b[0m');
  {
    // キャンセル・過去の受付待ちを含む「予約データ」だが、今日より後の行が無い。会計明細ではないので
    // 「会計明細のみ」「予約データを連携すると」とは書かず、出力期間に未来を含めるよう案内する。
    const rows = sampleRows().filter(function (r) { return r.date <= '2026-07-03'; });
    const o = await open(browser, { me: 'momo', data: recordsCsv(rows), noTargets: true });
    const p = o.page;
    const home = await p.evaluate(function () { return document.querySelector('#view-home').textContent.replace(/\s+/g, ' '); });
    check('ホーム: 「会計明細」と書かない', /会計明細/.test(home), false);
    check('ホーム: 次回予約率は「再来待ち（今後の予約がデータに無いため）」', /再来待ち（今後の予約がデータに無いため）/.test(await text(p, '[data-kpi="home-store-next"]')), true);
    const hint = await text(p, '[data-kpi="home-me-next-hint"]');
    check('次の一手: 理由は「データに今日より後の予約が入っていない」', /データに今日より後の予約が入っていないため/.test(hint), true);
    check('次の一手: 直し方は出力期間（「予約データを連携すると」と書かない）', /予約データを出力する期間に/.test(hint) && !/予約データを連携すると/.test(hint), true);
    await p.evaluate(function () { location.hash = '#overview'; });
    await p.waitForTimeout(500);
    const note = await p.evaluate(function () { var t = document.querySelector('[data-kpi="rev-periods"]'); var n = t && t.closest('.table-wrap').nextElementSibling; return n ? n.textContent : ''; });
    check('お店の月ごとの数字: 注記の理由も「今日より後の予約が入っていない」', /データに今日より後の予約が入っていないため/.test(note) && !/会計明細/.test(note), true);
    await p.click('#storeSeg button[data-k="repeat"]');
    await p.waitForTimeout(500);
    const meter = await p.evaluate(function () { var m = document.querySelector('#mNext'); return m ? m.textContent.replace(/\s+/g, ' ') : ''; });
    check('お店＞リピート: 次回予約取得率は直近の月を除いた値（「直近の月を除く」）', /（直近の月を除く）/.test(meter), true);
    check('コンソールエラーなし', o.errors.length, 0);
    if (o.errors.length) console.log('    ' + o.errors.join('\n    '));
    await o.ctx.close();
  }

  console.log('\n\x1b[1m■ 次の一手：リピート率だけ判定できた（固定化率は2回来店した方が2人）\x1b[0m');
  {
    const rows = [];
    for (let i = 1; i <= 20; i++) rows.push(rec({ custKey: 'C' + i, name: 'C' + i, date: '2026-05-' + String(10 + (i % 9)).padStart(2, '0'), kaikeiTotal: 5000 }));
    for (let i = 1; i <= 14; i++) rows.push(rec({ status: '受付待ち', custKey: 'C' + i, name: 'C' + i, date: '2026-07-20', kaikeiTotal: 0 }));
    rows.push(rec({ custKey: 'C15', name: 'C15', date: '2026-06-15', kaikeiTotal: 5000 }));
    rows.push(rec({ custKey: 'C16', name: 'C16', date: '2026-06-16', kaikeiTotal: 5000 }));
    rows.push(rec({ custKey: 'Z', name: 'Z', date: '2026-07-03', kaikeiTotal: 5000 }));
    const o = await open(browser, { me: 'S', data: recordsCsv(rows), noTargets: true });
    const p = o.page;
    const hint = await text(p, '[data-kpi="home-me-next-hint"]');
    check('「固定化率とも達成」と書かない', hint && !/固定化率とも/.test(hint), true);
    check('判定できたリピート率だけ「達成」と書く', hint && /リピート率は目安（70%）を達成しています/.test(hint), true);
    check('固定化率は「いま2人・20人以上で判定」と書く', hint && /固定化率は、2回来店したお客様が20人以上になると判定します（いま2人）/.test(hint), true);
    check('コンソールエラーなし', o.errors.length, 0);
    if (o.errors.length) console.log('    ' + o.errors.join('\n    '));
    await o.ctx.close();
  }

  console.log('\n\x1b[1m■ 目標ちょうどの実績は 100%（税抜換算・税込換算の浮動小数の誤差で 99% にしない）\x1b[0m');
  {
    // 税込 ¥8,800 × 10件 → 税抜は 8,800÷1.1 の合計 = 79,999.99999999999（画面は ¥80,000）。
    // 目標 80,000（税抜）→ 税込表示では 80,000×1.1 = 88,000.00000000001（画面は ¥88,000）。
    const rows = [];
    for (let i = 1; i <= 10; i++) rows.push(rec({ custKey: 'E' + i, name: 'E' + i, date: '2026-07-' + String(i).padStart(2, '0'), kaikeiTotal: 8800, yoyakuTotal: 8800 }));
    const o = await open(browser, { me: 'S', data: recordsCsv(rows), targets: '月,お店,S\n毎月,80000,80000' });
    const p = o.page;
    const ach = async function () {
      return p.evaluate(function () {
        var me = document.querySelector('[data-kpi="home-me-revenue"]'), ring = document.querySelector('#hMeRing');
        var row = me ? Array.prototype.filter.call(me.querySelectorAll('.hc-row'), function (r) { return /達成率/.test(r.textContent); })[0] : null;
        return { row: row ? row.querySelector('b').textContent.trim() : null, ring: ring ? ring.textContent.replace(/\s+/g, '') : null, value: me ? me.querySelector('.hc-value').textContent.trim() : null };
      });
    };
    const ex = await ach();
    // check() は === で比べるので、配列は JSON の文字列にして比べる
    check('税抜: 実績 ¥80,000・達成率 100%・リングも 100%', JSON.stringify([ex.value, ex.row, /^100%/.test(ex.ring || '')]), JSON.stringify(['¥80,000', '100%', true]));
    await p.click('#taxLabelIncl');
    await p.waitForTimeout(400);
    const inc = await ach();
    check('税込: 実績 ¥88,000・達成率 100%・リングも 100%', JSON.stringify([inc.value, inc.row, /^100%/.test(inc.ring || '')]), JSON.stringify(['¥88,000', '100%', true]));
    check('コンソールエラーなし', o.errors.length, 0);
    if (o.errors.length) console.log('    ' + o.errors.join('\n    '));
    await o.ctx.close();
  }

  await browser.close();
  server.close();
  console.log('\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m' + pass + ' pass\x1b[0m · \x1b[31m' + fail + ' fail\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('HOME RENDER: unexpected error', e); server.close(); process.exit(1); });
