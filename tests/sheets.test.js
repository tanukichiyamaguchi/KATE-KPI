/* sheets.js（Google Sheets 連携）の回帰テスト:
 *   - toCsvUrl: 編集URL / ウェブに公開URL / CSV直リンクの正規化
 *   - fetchCsv: キャッシュ迂回（毎回異なる _ts パラメータ ＋ cache:'no-store'）。
 *     「シートは更新されているのにダッシュボードに反映されない」を防ぐ要の動作。
 *   - HTML が返ってきた場合（共有設定ミス）のエラーメッセージ
 * Run: node tests/sheets.test.js（`npm test` に組み込み済み） */
'use strict';
const sheets = require('../assets/js/sheets.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? '  \x1b[32mok\x1b[0m    ' : '  \x1b[31mFAIL\x1b[0m  ') + name + (ok ? '' : ('  got=' + got + '  want=' + want)));
}

// ---- toCsvUrl / csvEndpoints ----------------------------------------------
// 編集URLは /export（常に現在の内容）を第一候補にする。gviz は Google 側で
// 結果がキャッシュされ古い内容が返ることがあるため、保険の第二候補に落とす。
check('編集URL → /export CSV を第一候補に',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/ABC-123_x/edit#gid=42'),
  'https://docs.google.com/spreadsheets/d/ABC-123_x/export?format=csv&gid=42');
check('編集URL → gviz は第二候補（保険）',
  sheets.csvEndpoints('https://docs.google.com/spreadsheets/d/ABC-123_x/edit#gid=42')[1],
  'https://docs.google.com/spreadsheets/d/ABC-123_x/gviz/tq?tqx=out:csv&gid=42');
check('編集URL（gid無し）→ gid=0',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/ABC/edit'),
  'https://docs.google.com/spreadsheets/d/ABC/export?format=csv&gid=0');
// 貼られたURLがすでにCSVの取得先なら、まずそれを「そのまま」使う。こちらで
// 組み立て直すと、タブ名指定などの、再現できない指定を捨ててしまうため。
check('貼られたCSV URLはそのまま第一候補',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&gid=7'),
  'https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&gid=7');
check('同じタブを再現できるなら /export も候補に足す',
  sheets.csvEndpoints('https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&gid=7')[1],
  'https://docs.google.com/spreadsheets/d/ABC/export?format=csv&gid=7');
// 回帰防止: タブ名・範囲・クエリ指定は、こちらでは組み立て直せない。gid から
// 作り直すと gid=0（1枚目のタブ）を読んでしまい、別のシートの内容が出る。
check('タブ名指定（sheet=）は他の候補を足さない',
  sheets.csvEndpoints('https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&sheet=Yoyaku').length, 1);
check('タブ名指定（sheet=）はそのまま使う',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&sheet=Yoyaku'),
  'https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&sheet=Yoyaku');
check('範囲指定（range=）もそのまま使う',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&headers=1&range=A1:Z'),
  'https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&headers=1&range=A1:Z');
check('公開CSV（/d/ID/pub?output=csv）もそのまま使う',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/ABC/pub?output=csv'),
  'https://docs.google.com/spreadsheets/d/ABC/pub?output=csv');
check('公開CSV（/d/e/…&gid=7）はタブ指定ごとそのまま',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=7&single=true&output=csv'),
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=7&single=true&output=csv');
check('公開URLは候補1つだけ（ドキュメントIDが無く /export を作れない）',
  sheets.csvEndpoints('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml').length, 1);
check('ウェブに公開（pubhtml）→ pub?output=csv',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml'),
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv');
check('CSV直リンクはそのまま',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv'),
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv');
check('スプレッドシート以外のURLは null', sheets.toCsvUrl('https://example.com/x.csv'), null);

// 候補は必ず「同じタブ」を指すこと。app.js は取れた候補の中から中身がいちばん
// 新しいものを採用するため、候補に別のタブが混ざると、利用者が指定したタブを
// 差し置いて別タブの内容が黙って採用されうる（取得は成功するのでエラーも出ない）。
[
  'https://docs.google.com/spreadsheets/d/ABC/edit#gid=42',
  'https://docs.google.com/spreadsheets/d/ABC/edit',
  'https://docs.google.com/spreadsheets/d/ABC/export?format=csv&gid=99',
  'https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&gid=7',
  'https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&sheet=Yoyaku',
  'https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&headers=1&range=A1:Z',
  'https://docs.google.com/spreadsheets/d/ABC/pub?output=csv',
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=7&single=true&output=csv'
].forEach(function (u) {
  var tabs = {};
  sheets.csvEndpoints(u).forEach(function (c) {
    var m = /[?&]gid=(\d+)/.exec(c), sh = /[?&]sheet=([^&]*)/.exec(c), rg = /[?&]range=([^&]*)/.exec(c);
    tabs[(m ? 'gid:' + m[1] : 'gid:-') + '|' + (sh ? 'sheet:' + sh[1] : '') + '|' + (rg ? 'range:' + rg[1] : '')] = 1;
  });
  check('候補が別のタブを混ぜない: ' + u.replace(/^https:\/\/docs\.google\.com\/spreadsheets/, ''),
    Object.keys(tabs).length, 1);
});

// ---- bust（キャッシュバスター）--------------------------------------------
check('クエリ有りURLは &_ts= を追加', /[&]_ts=\d+$/.test(sheets.bust('https://x/y?a=1')), true);
check('クエリ無しURLは ?_ts= を追加', /[?]_ts=\d+$/.test(sheets.bust('https://x/y')), true);

// ---- fetchCsv（fetch をスタブして呼び出しを検査）--------------------------
(async () => {
  let captured = null, allUrls = [];
  globalThis.fetch = function (url, opts) {
    captured = { url: url, opts: opts }; allUrls.push(url);
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve('ステータス,来店日\n会計済み,2026/08/06'); } });
  };
  const text = await sheets.fetchCsv('https://docs.google.com/spreadsheets/d/ABC/edit');
  check('CSV本文をそのまま返す', text, 'ステータス,来店日\n会計済み,2026/08/06');
  // 編集URLは /export と gviz の両方を取りに行く（どちらが使えるかは環境しだい）
  check('編集URLは2経路とも取りに行く', allUrls.length, 2);
  check('/export を取りに行く', allUrls.some(function (u) { return u.indexOf('/export?format=csv&gid=0&_ts=') !== -1; }), true);
  check('gviz も取りに行く', allUrls.some(function (u) { return u.indexOf('/gviz/tq?tqx=out:csv&gid=0&_ts=') !== -1; }), true);
  check('毎回キャッシュバスター付きで取得', /_ts=\d+/.test(captured.url), true);
  check("HTTPキャッシュを使わない（cache:'no-store'）", captured.opts.cache, 'no-store');
  check('Cookieを送らない（credentials:omit）', captured.opts.credentials, 'omit');

  // 2回呼ぶと _ts が変わる（＝キャッシュキーが毎回異なる）
  const url1 = allUrls[0];
  allUrls = [];
  await new Promise(function (r) { setTimeout(r, 5); });
  await sheets.fetchCsv('https://docs.google.com/spreadsheets/d/ABC/edit');
  check('呼び出しごとに _ts が変わる', allUrls[0] !== url1, true);

  // 共有設定ミス（HTMLが返る）→ 案内つきのエラー
  globalThis.fetch = function () {
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve('<!DOCTYPE html><html>…</html>'); } });
  };
  let msg = '';
  await sheets.fetchCsv('https://docs.google.com/spreadsheets/d/ABC/edit').catch(function (e) { msg = e.message; });
  check('HTML応答は共有設定の案内エラー', msg.indexOf('共有') !== -1, true);

  // HTTPエラー → ステータス入りのエラー
  globalThis.fetch = function () { return Promise.resolve({ ok: false, status: 403 }); };
  msg = '';
  await sheets.fetchCsv('https://docs.google.com/spreadsheets/d/ABC/edit').catch(function (e) { msg = e.message; });
  check('HTTPエラーはステータス入り', msg.indexOf('403') !== -1, true);

  // /export が失敗しても gviz にフォールバックして取得できる
  const tried = [];
  globalThis.fetch = function (url) {
    tried.push(url);
    if (url.indexOf('/export') !== -1) return Promise.resolve({ ok: false, status: 400 });
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve('ステータス\n会計済み'); } });
  };
  const fb = await sheets.fetchCsv('https://docs.google.com/spreadsheets/d/ABC/edit');
  check('/export が駄目なら gviz の内容が返る', fb, 'ステータス\n会計済み');
  check('2経路とも試す', tried.length, 2);
  check('gviz も試している', tried.some(function (u) { return u.indexOf('/gviz/tq') !== -1; }), true);

  // fetchAllCsv: 取れた経路をすべて返す（採用は呼び出し側が「新しい方」で決める）
  globalThis.fetch = function (url) {
    if (url.indexOf('/export') !== -1) return Promise.resolve({ ok: true, text: function () { return Promise.resolve('EXPORT'); } });
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve('GVIZ'); } });
  };
  const all = await sheets.fetchAllCsv('https://docs.google.com/spreadsheets/d/ABC/edit');
  check('fetchAllCsv: 成功した経路をすべて返す', all.ok.length, 2);
  check('fetchAllCsv: 経路の種別が付く', all.ok.map(function (r) { return r.kind; }).sort().join(','), 'export,gviz');
  check('fetchAllCsv: 本文が経路ごとに取れる', all.ok.map(function (r) { return r.text; }).sort().join(','), 'EXPORT,GVIZ');

  // 片方だけ落ちても、もう片方は使える（＝取りこぼさない）
  globalThis.fetch = function (url) {
    if (url.indexOf('/export') !== -1) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve('GVIZ'); } });
  };
  const half = await sheets.fetchAllCsv('https://docs.google.com/spreadsheets/d/ABC/edit');
  check('片方がCORSで落ちても、もう片方は成功として返る', half.ok.length, 1);
  check('落ちた経路は failed に入る', half.failed.length, 1);
  check('落ちた経路の種別も分かる', half.failed[0].kind, 'export');

  // gviz の権限エラーは JS（/*O_o*/…）で返る。CSVとして解釈してはいけない。
  globalThis.fetch = function () {
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve('/*O_o*/\ngoogle.visualization.Query.setResponse({"status":"error"});'); } });
  };
  let gmsg = '';
  await sheets.fetchCsv('https://docs.google.com/spreadsheets/d/ABC/edit').catch(function (e) { gmsg = e.message; });
  check('gvizのエラー応答をCSVとして扱わない', gmsg.indexOf('共有') !== -1, true);

  console.log('\x1b[1mSUMMARY\x1b[0m  \x1b[32m' + pass + ' pass\x1b[0m · \x1b[31m' + fail + ' fail\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
