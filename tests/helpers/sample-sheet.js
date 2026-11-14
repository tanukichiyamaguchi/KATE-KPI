/* テスト用: 同梱のサンプル予約データを、スプレッドシート（予約データ）と同じ
 * 日本語見出しの CSV に戻す。ブラウザのテストで docs.google.com への取得を差し替え、
 * 「スプレッドシート連携中」の画面（目標タブの読み込みを含む）を再現するために使う。
 * サンプルのお客様キー（custKey）をフリガナ列に入れるので、名寄せの結果はサンプルと同じになる。 */
'use strict';
const path = require('path');
require(path.join(__dirname, '..', '..', 'assets', 'js', 'sample-data.js'));
const COLS = [
  ['ステータス', 'status'], ['スタッフ名', 'staff'], ['指名予約有無', 'shimei'], ['来店日', 'date'],
  ['開始時間', 'start'], ['終了時間', 'end'], ['所要時間', 'dur'], ['予約経路', 'route'], ['支払い種別', 'pay'],
  ['予約時メニューカテゴリ', 'menuCat'], ['予約時メニュー', 'menu'],
  ['予約時HotPepperBeautyクーポン', 'coupon'], ['予約時HotPepperBeautyクーポンカテゴリ', 'couponCat'],
  ['フリガナ', 'custKey'], ['お名前', 'name'], ['性別', 'gender'],
  ['予約時合計金額', 'yoyakuTotal'], ['お支払い予定金額', 'payPlanned'], ['会計時合計金額', 'kaikeiTotal'],
  ['予約時利用ギフト券', 'usedGift'], ['予約時利用ポイント', 'usedPoint'],
  ['会計時店販カテゴリ', 'shohanCat'], ['会計時店販', 'shohan'], ['会計時店販金額', 'shohanAmount'],
  ['このサロンに行くのは初めてですか？', 'first']
];
function cell(v) {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// 任意の予約レコード（サンプルと同じ形）を、予約データの CSV にする
function recordsCsv(rows) {
  return [COLS.map(c => c[0]).join(',')].concat(rows.map(r => COLS.map(c => cell(r[c[1]])).join(','))).join('\n');
}
function sampleCsv() { return recordsCsv(globalThis.KATE.SAMPLE_RESERVATIONS); }
function sampleRows() { return globalThis.KATE.SAMPLE_RESERVATIONS.map(r => Object.assign({}, r)); }
// 「目標」タブの例（税抜）。7月＝サンプルの集計基準日（2026-07-03）の月。
function targetsCsv() {
  return ['月,お店,momo,aoi,データ更新日時', '2026/07/01,1200000,700000,500000,2026/07/03 23:10:00', '毎月,1000000,600000,400000,'].join('\n');
}
module.exports = { sampleCsv, targetsCsv, recordsCsv, sampleRows };
