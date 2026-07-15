/* Regression tests for ingest.mergeSources() — joining 予約データ + 会計明細.
 * Fixtures are small, hand-built ingest-shaped records (the same shape fromAOA/
 * fromKaikei produce) with hand-verified expected outcomes. Run: node tests/merge.test.js */
'use strict';
const path = require('path');
const ingest = require(path.join(__dirname, '..', 'assets', 'js', 'ingest.js'));

let pass = 0, fail = 0;
function check(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  var tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  if (ok) pass++; else fail++;
  console.log(`  ${tag}  ${label.padEnd(46)} got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`);
}
function h(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

function yrec(o) {
  return Object.assign({
    status: '会計済み', date: null, staff: null, route: '直接来店', start: null,
    kana: null, name: null, phone: null, gender: null, shimei: null, first: null,
    yoyakuTotal: null, payPlanned: null, kaikeiTotal: null,
    shohan: null, shohanCat: null, shohanAmount: null, custKey: null
  }, o);
}
function krec(o) {
  return Object.assign({
    status: '会計済み', date: null, staff: null, route: null, _time: null,
    kana: null, name: null, phone: null, gender: null, shimei: null, first: null,
    yoyakuTotal: null, payPlanned: null, kaikeiTotal: null,
    shohan: null, shohanCat: null, shohanAmount: null, custKey: null
  }, o);
}

// ============================================================================
// Fixture 1 — 基本の突合と付与
// ============================================================================
h('■ Fixture 1: 基本の突合とフィールド付与');
{
  const yoyaku = [
    yrec({ kana: 'タナカハナコ', name: '田中花子', date: '2026-06-01', start: 1000, kaikeiTotal: 10000, custKey: 'k:タナカハナコ' })
  ];
  const kaikei = [
    krec({ kana: 'タナカハナコ', name: '田中花子', date: '2026-06-01', _time: 100500, kaikeiTotal: 10000, shohan: 'item', shohanAmount: 3000, shimei: '指名あり' })
  ];
  const m = ingest.mergeSources(yoyaku, kaikei);
  check('report.matched', m.report.matched, 1);
  check('report.matchRate', m.report.matchRate, 1);
  check('records.length (1件に統合)', m.records.length, 1);
  check('shohan 付与', m.records[0].shohan, 'item');
  check('shohanAmount 付与', m.records[0].shohanAmount, 3000);
  check('shimei 付与', m.records[0].shimei, '指名あり');
  check('kaikeiTotal は予約データ側を維持', m.records[0].kaikeiTotal, 10000);
  check('report.amountMismatch.count', m.report.amountMismatch.count, 0);
  check('report.unmatchedKaikei', m.report.unmatchedKaikei, 0);
  check('report.unmatchedYoyaku', m.report.unmatchedYoyaku, 0);
}

// ============================================================================
// Fixture 2 — 同一人・同日複数回：時刻順の位置対応
// ============================================================================
h('■ Fixture 2: 同一人・同日複数会計（時刻順ペアリング）');
{
  const yoyaku = [
    yrec({ kana: 'スズキメイ', name: '鈴木芽衣', date: '2026-06-05', start: 1400, kaikeiTotal: 5000 }),  // 2nd visit (later start)
    yrec({ kana: 'スズキメイ', name: '鈴木芽衣', date: '2026-06-05', start: 900, kaikeiTotal: 4000 })    // 1st visit (earlier start)
  ];
  const kaikei = [
    krec({ kana: 'スズキメイ', name: '鈴木芽衣', date: '2026-06-05', _time: 140500, shohan: 'PM-item' }),
    krec({ kana: 'スズキメイ', name: '鈴木芽衣', date: '2026-06-05', _time: 90500, shohan: 'AM-item' })
  ];
  const m = ingest.mergeSources(yoyaku, kaikei);
  check('matched', m.report.matched, 2);
  var morning = m.records.find(function (r) { return r.start === 900; });
  var afternoon = m.records.find(function (r) { return r.start === 1400; });
  check('午前来店 (start=900) には AM-item が対応', morning.shohan, 'AM-item');
  check('午後来店 (start=1400) には PM-item が対応', afternoon.shohan, 'PM-item');
}

// ============================================================================
// Fixture 3 — 表記ゆれ・別人 → 未突合
// ============================================================================
h('■ Fixture 3: フリガナ不一致は突合しない（曖昧マッチ禁止）');
{
  const yoyaku = [ yrec({ kana: 'ヤマダハナコ', date: '2026-06-10', kaikeiTotal: 8000 }) ];
  const kaikei = [ krec({ kana: 'ヤマダ ハナコ', date: '2026-06-10', shohan: 'x' }) ];   // half-width space mid-string
  const m = ingest.mergeSources(yoyaku, kaikei);
  check('スペース違いは normName で吸収され突合する', m.report.matched, 1);
}
{
  const yoyaku = [ yrec({ kana: 'ヤマダハナコ', date: '2026-06-10', kaikeiTotal: 8000 }) ];
  const kaikei = [ krec({ kana: 'サトウアイ', date: '2026-06-10', shohan: 'x' }) ];
  const m = ingest.mergeSources(yoyaku, kaikei);
  check('別人（別フリガナ）は突合しない', m.report.matched, 0);
  check('未突合会計として1件追加される', m.report.unmatchedKaikei, 1);
  check('records は元1件+未突合1件=2件', m.records.length, 2);
}

// ============================================================================
// Fixture 4 — ±1日の重複疑いは追加しない（二重計上防止）
// ============================================================================
h('■ Fixture 4: ±1日以内の同一人は重複疑いとして除外');
{
  const yoyaku = [ yrec({ kana: 'イトウマナ', date: '2026-06-15', kaikeiTotal: 6000 }) ];
  // Same person, kaikei dated the next day (checkout logged a day late) — no exact-date match,
  // but within 1 day of a real yoyaku visit => treated as the same visit, not a new one.
  const kaikei = [ krec({ kana: 'イトウマナ', date: '2026-06-16', kaikeiTotal: 6000 }) ];
  const m = ingest.mergeSources(yoyaku, kaikei);
  check('exact-date matched は0件', m.report.matched, 0);
  check('suspectedDup として1件検出', m.report.suspectedDup, 1);
  check('unmatchedKaikei には追加されない', m.report.unmatchedKaikei, 0);
  check('records には二重計上されない（元1件のみ）', m.records.length, 1);
}
{
  const yoyaku = [ yrec({ kana: 'イトウマナ', date: '2026-06-15', kaikeiTotal: 6000 }) ];
  // 3 days away — outside the ±1-day window => genuinely a separate, unmatched visit.
  const kaikei = [ krec({ kana: 'イトウマナ', date: '2026-06-18', kaikeiTotal: 6000 }) ];
  const m = ingest.mergeSources(yoyaku, kaikei);
  check('3日離れは重複扱いしない', m.report.suspectedDup, 0);
  check('独立の未突合会計として追加', m.report.unmatchedKaikei, 1);
  check('records は2件', m.records.length, 2);
}

// ============================================================================
// Fixture 5 — 金額不一致の集計
// ============================================================================
h('■ Fixture 5: 金額不一致の集計（突合は成立する）');
{
  const yoyaku = [ yrec({ kana: 'コンドウリサ', date: '2026-06-20', kaikeiTotal: 10000 }) ];
  const kaikei = [ krec({ kana: 'コンドウリサ', date: '2026-06-20', kaikeiTotal: 9500 }) ];
  const m = ingest.mergeSources(yoyaku, kaikei);
  check('突合は成立', m.report.matched, 1);
  check('amountMismatch.count', m.report.amountMismatch.count, 1);
  check('amountMismatch.totalDiff', m.report.amountMismatch.totalDiff, 500);
  check('売上は予約データ側 (10000) を維持', m.records[0].kaikeiTotal, 10000);
}

// ============================================================================
// Fixture 6 — custKey の再キー（カナ⇄氏名の橋渡し）
// ============================================================================
h('■ Fixture 6: custKey 再キー（片方だけカナがある場合の橋渡し）');
{
  // 予約データ側はカナあり、別の日の会計明細行は名前だけでカナ無し。
  // 一致したペアからカナ⇄氏名の対応表を作り、名前のみの行も同じ人として再キーする。
  const yoyaku = [
    yrec({ kana: 'ワタナベユキ', name: '渡辺由紀', date: '2026-06-01', kaikeiTotal: 7000 })
  ];
  const kaikeiMatch = krec({ kana: 'ワタナベユキ', name: '渡辺由紀', date: '2026-06-01', shohan: 'p1' });
  const kaikeiNameOnly = krec({ kana: null, name: '渡辺由紀', date: '2026-07-01', kaikeiTotal: 4000 });  // different day, unmatched, no kana
  const m = ingest.mergeSources(yoyaku, [kaikeiMatch, kaikeiNameOnly]);
  var nameOnlyOut = m.records.find(function (r) { return r.date === '2026-07-01'; });
  check('名前のみの未突合行がカナで再キーされる', nameOnlyOut.custKey, 'k:ワタナベユキ');
}

// ============================================================================
// Fixture 7 — 入力配列を変更しない（非破壊）
// ============================================================================
h('■ Fixture 7: 入力配列は変更されない（非破壊）');
{
  const yoyaku = [ yrec({ kana: 'オカザキマサコ', date: '2026-06-01', kaikeiTotal: 5000, shohan: null }) ];
  const kaikei = [ krec({ kana: 'オカザキマサコ', date: '2026-06-01', shohan: 'item' }) ];
  ingest.mergeSources(yoyaku, kaikei);
  check('元の yoyaku レコードの shohan は null のまま', yoyaku[0].shohan, null);
  check('元の kaikei レコードの custKey は未設定のまま', kaikei[0].custKey, null);
}

// ============================================================================
// Fixture 8 — fromAOA の「データ更新日時」スタンプ抽出（tools/sheet-update-stamp.gs）
// ============================================================================
h('■ Fixture 8: 「データ更新日時」列（シート側の同期完了時刻）の抽出');
{
  // 予約データ形式・CSV文字列のスタンプ（Sheetsの表示形式そのまま。時は1桁もある）
  const p1 = ingest.fromAOA([
    ['ステータス', '来店日', 'スタッフ名', 'お名前', '', 'データ更新日時'],
    ['会計済み', '2026/07/01', 'momo', '山田花子', '', '2026/07/16 0:02:13'],
    ['会計済み', '2026/07/02', 'aoi', '佐藤良子', '', '']
  ]);
  check('yoyaku: レコード数は不変（余分列は無視）', p1.records.length, 2);
  check('yoyaku: スタンプが Date として取れる', p1.sheetUpdatedAt instanceof Date, true);
  check('yoyaku: スタンプの値（2026-07-16 00:02:13）',
    p1.sheetUpdatedAt && [p1.sheetUpdatedAt.getFullYear(), p1.sheetUpdatedAt.getMonth() + 1, p1.sheetUpdatedAt.getDate(), p1.sheetUpdatedAt.getHours(), p1.sheetUpdatedAt.getMinutes()],
    [2026, 7, 16, 0, 2]);

  // スタンプ列なし → null（従来どおり）
  const p2 = ingest.fromAOA([
    ['ステータス', '来店日', 'お名前'],
    ['会計済み', '2026/07/01', '山田花子']
  ]);
  check('yoyaku: スタンプ列なし → null', p2.sheetUpdatedAt, null);

  // Excelシリアル値（xlsx raw:true 経由）: 2026-07-16 00:02:13 ≒ 46219.001539...
  const serial = 46219 + (2 * 60 + 13) / 86400;
  const p3 = ingest.fromAOA([
    ['ステータス', '来店日', 'お名前', 'データ更新日時'],
    ['会計済み', '2026/07/01', '山田花子', serial]
  ]);
  check('yoyaku: Excelシリアル値も Date に変換', p3.sheetUpdatedAt instanceof Date, true);
  check('yoyaku: シリアル値の日付部分', p3.sheetUpdatedAt && [p3.sheetUpdatedAt.getFullYear(), p3.sheetUpdatedAt.getMonth() + 1, p3.sheetUpdatedAt.getDate()], [2026, 7, 16]);

  // 会計明細形式でも同様に抽出される
  const p4 = ingest.fromAOA([
    ['会計ID', '会計日', 'メニュー・店販・割引・サービス・オプション', '金額', 'データ更新日時'],
    ['A1', '2026/07/01', 'まつげエクステ', '8000', '2026/07/16 0:03:00'],
    ['A2', '2026/07/02', 'まつげエクステ', '9000', '']
  ]);
  check('kaikei: format 判定は不変', p4.format, 'kaikei');
  check('kaikei: スタンプが取れる', p4.sheetUpdatedAt instanceof Date, true);
  check('kaikei: スタンプの分まで一致', p4.sheetUpdatedAt && [p4.sheetUpdatedAt.getHours(), p4.sheetUpdatedAt.getMinutes()], [0, 3]);

  // 壊れた値 → null（エラーにしない）
  const p5 = ingest.fromAOA([
    ['ステータス', '来店日', 'お名前', 'データ更新日時'],
    ['会計済み', '2026/07/01', '山田花子', '更新失敗']
  ]);
  check('yoyaku: 解釈できない値 → null（エラーにしない）', p5.sheetUpdatedAt, null);

  // 見出しの上にタイトル行があるレイアウト（スタンプはタイトル行の右端）でも読める
  const p6 = ingest.fromAOA([
    ['予約一覧（2026年）', '', '', '', 'データ更新日時'],
    ['ステータス', '来店日', 'お名前', '', '2026/07/16 0:02:13'],
    ['会計済み', '2026/07/01', '山田花子', '', '']
  ]);
  check('タイトル行レイアウト: レコードは正しく読める', p6.records.length, 1);
  check('タイトル行レイアウト: スタンプも読める', p6.sheetUpdatedAt && [p6.sheetUpdatedAt.getDate(), p6.sheetUpdatedAt.getHours(), p6.sheetUpdatedAt.getMinutes()], [16, 0, 2]);

  // 見出し行の前後空白（手作業の列）も clean() 比較で拾える
  const p7 = ingest.fromAOA([
    ['ステータス', '来店日', 'お名前', ' データ更新日時 '],
    ['会計済み', '2026/07/01', '山田花子', '2026/07/16 5:00:00']
  ]);
  check('見出しの前後空白があってもスタンプを読める', p7.sheetUpdatedAt && p7.sheetUpdatedAt.getHours(), 5);
}

console.log(`\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m${pass} pass\x1b[0m · \x1b[31m${fail} fail\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);
