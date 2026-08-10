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
check('貼られたgviz URLも /export に格上げ',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/ABC/gviz/tq?tqx=out:csv&gid=7'),
  'https://docs.google.com/spreadsheets/d/ABC/export?format=csv&gid=7');
check('公開URLは候補1つだけ（ドキュメントIDが無く /export を作れない）',
  sheets.csvEndpoints('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml').length, 1);
check('ウェブに公開（pubhtml）→ pub?output=csv',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml'),
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv');
check('CSV直リンクはそのまま',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv'),
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv');
check('スプレッドシート以外のURLは null', sheets.toCsvUrl('https://example.com/x.csv'), null);

// ---- bust（キャッシュバスター）--------------------------------------------
check('クエリ有りURLは &_ts= を追加', /[&]_ts=\d+$/.test(sheets.bust('https://x/y?a=1')), true);
check('クエリ無しURLは ?_ts= を追加', /[?]_ts=\d+$/.test(sheets.bust('https://x/y')), true);

// ---- fetchCsv（fetch をスタブして呼び出しを検査）--------------------------
(async () => {
  let captured = null;
  globalThis.fetch = function (url, opts) {
    captured = { url: url, opts: opts };
    return Promise.resolve({ ok: true, text: function () { return Promise.resolve('ステータス,来店日\n会計済み,2026/08/06'); } });
  };
  const text = await sheets.fetchCsv('https://docs.google.com/spreadsheets/d/ABC/edit');
  check('CSV本文をそのまま返す', text, 'ステータス,来店日\n会計済み,2026/08/06');
  check('/export エンドポイントを叩く（gvizではない）', captured.url.indexOf('https://docs.google.com/spreadsheets/d/ABC/export?format=csv&gid=0&_ts=') === 0, true);
  check('毎回キャッシュバスター付きで取得', /_ts=\d+/.test(captured.url), true);
  check("HTTPキャッシュを使わない（cache:'no-store'）", captured.opts.cache, 'no-store');
  check('Cookieを送らない（credentials:omit）', captured.opts.credentials, 'omit');

  // 2回呼ぶと _ts が変わる（＝キャッシュキーが毎回異なる）
  const url1 = captured.url;
  await new Promise(function (r) { setTimeout(r, 5); });
  await sheets.fetchCsv('https://docs.google.com/spreadsheets/d/ABC/edit');
  check('呼び出しごとに _ts が変わる', captured.url !== url1, true);

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
  check('/export が駄目なら gviz にフォールバックする', fb, 'ステータス\n会計済み');
  check('フォールバック時は2回試す', tried.length, 2);
  check('フォールバック先は gviz', tried[1].indexOf('/gviz/tq') !== -1, true);

  console.log('\x1b[1mSUMMARY\x1b[0m  \x1b[32m' + pass + ' pass\x1b[0m · \x1b[31m' + fail + ' fail\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
