/* 月の売上目標（スプレッドシートの「目標」タブ）の読み込みテスト。
 * URLの組み立て・表の解析（見出しの揺れ・税込注記・毎月行・万表記・日付形式）・
 * 該当月の取り出しと税込／税抜の換算を、手で計算した期待値で検証する。
 * Run: node tests/targets.test.js */
'use strict';
const path = require('path');
require(path.join(__dirname, '..', 'assets', 'js', 'ingest.js'));   // parseCSV を KATE.ingest に載せる
const T = require(path.join(__dirname, '..', 'assets', 'js', 'targets.js'));

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '  \x1b[32mok\x1b[0m    ' : '  \x1b[31mFAIL\x1b[0m  ') + label + (ok ? '' : '  got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)));
}
function near(a, b) { return Math.abs(a - b) < 1e-6; }
function h(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
const STAFF = ['momo', 'aoi'];
const ENC = encodeURIComponent('目標');

h('■ 読み込み先のURL');
check('編集URL → 同じファイルの「目標」タブ（gviz・sheet指定）',
  T.urlFor('https://docs.google.com/spreadsheets/d/AbC-12_x/edit#gid=123'),
  'https://docs.google.com/spreadsheets/d/AbC-12_x/gviz/tq?tqx=out:csv&sheet=' + ENC);
check('CSV書き出しURLからも同じファイルを指す',
  T.urlFor('https://docs.google.com/spreadsheets/d/AbC/export?format=csv&gid=0'),
  'https://docs.google.com/spreadsheets/d/AbC/gviz/tq?tqx=out:csv&sheet=' + ENC);
check('「ウェブに公開」URLは別のタブを指定できない → null',
  T.urlFor('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv'), null);
check('スプレッドシート以外 → null', T.urlFor('https://example.com/a.csv'), null);
check('空 → null', T.urlFor(''), null);

h('■ 月の読み取り');
check('2026/11', T.parseMonth('2026/11'), '2026-11');
check('2026-1', T.parseMonth('2026-1'), '2026-01');
check('2026年11月', T.parseMonth('2026年11月'), '2026-11');
check('2026/11/01（シートが日付に変換した形）', T.parseMonth('2026/11/01'), '2026-11');
check('2026/11/1 0:00:00', T.parseMonth('2026/11/1 0:00:00'), '2026-11');
check('全角 ２０２６／１１', T.parseMonth('２０２６／１１'), '2026-11');
check('米国式 11/1/2026', T.parseMonth('11/1/2026'), '2026-11');
check('毎月 → 既定値 *', T.parseMonth('毎月'), '*');
check('13月は読まない', T.parseMonth('2026/13'), null);
check('文字だけ → null', T.parseMonth('メモ'), null);

h('■ 金額の読み取り');
check('1200000', T.parseAmount('1200000'), 1200000);
check('1,200,000', T.parseAmount('1,200,000'), 1200000);
check('¥1,200,000', T.parseAmount('¥1,200,000'), 1200000);
check('120万', T.parseAmount('120万'), 1200000);
check('1.5万', T.parseAmount('1.5万'), 15000);
check('全角 １２０万円', T.parseAmount('１２０万円'), 1200000);
check('0 は目標なし', T.parseAmount('0'), null);
check('空は目標なし', T.parseAmount(''), null);
check('文字は目標なし', T.parseAmount('未定'), null);

h('■ 表の解析（基本形）');
{
  const csv = ['月,お店,momo,aoi', '2026/11,1200000,700000,500000', '2026/12,"1,400,000",800000,600000'].join('\n');
  const p = T.parse(csv, STAFF);
  check('解析できる', p.ok, true);
  check('11月のお店', p.months['2026-11'].store, { amount: 1200000, taxIncl: false });
  check('11月の momo', p.months['2026-11'].staff.momo, { amount: 700000, taxIncl: false });
  check('12月の aoi', p.months['2026-12'].staff.aoi, { amount: 600000, taxIncl: false });
  check('既定値（毎月）は無し', p.defaults, null);
  check('2行読めた', p.rowsRead, 2);
}

h('■ 見出しの揺れ・税込の列・毎月行・使わない列');
{
  const csv = [
    '対象月,お店の売上目標（税込）,MOMO,aoiさん（税抜）,メモ,データ更新日時',
    '2026年11月,132万,700000,500000,繁忙期,2026/11/14 23:10:00',
    '毎月,110万,600000,,,'
  ].join('\n');
  const p = T.parse(csv, STAFF);
  check('解析できる', p.ok, true);
  check('「お店の売上目標（税込）」はお店・税込', p.months['2026-11'].store, { amount: 1320000, taxIncl: true });
  check('大文字の MOMO もスタッフ momo', p.months['2026-11'].staff.momo, { amount: 700000, taxIncl: false });
  check('「aoiさん（税抜）」はスタッフ aoi', p.months['2026-11'].staff.aoi, { amount: 500000, taxIncl: false });
  check('「メモ」は使わない列として記録', p.unknown, ['メモ']);
  check('毎月行のお店（税込）', p.defaults.store, { amount: 1100000, taxIncl: true });
  check('毎月行の空欄は目標なし', p.defaults.staff.aoi === undefined, true);
}

h('■ 目標の表ではないもの');
check('予約データの表（gviz が1枚目を返した）→ wrong-sheet',
  T.parse('ステータス,来店日,スタッフ名\n会計済み,2026/07/01,momo', STAFF).reason, 'wrong-sheet');
check('「月」の見出しが無い → no-header', T.parse('a,b\n1,2', STAFF).reason, 'no-header');
check('お店・スタッフの列が無い → no-columns', T.parse('月,だれか\n2026/11,100', STAFF).reason, 'no-columns');

h('■ 該当月の取り出しと税込／税抜の換算');
{
  const p = T.parse(['月,お店,お店（税込）,momo', '2026/11,1000000,,700000', '毎月,900000,,'].join('\n'), STAFF);
  const s11 = T.pick(p, '2026-11', 'store', 0.1);
  check('税抜で表示中: 税抜の目標はそのまま', near(s11.amount, 1000000), true);
  check('11月は月の行から', s11.source, 'month');
  const s11i = T.pick(p, '2026-11', 'store', 0);
  check('税込で表示中: 税抜の目標を ×1.1', near(s11i.amount, 1100000), true);
  const s12 = T.pick(p, '2026-12', 'store', 0.1);
  check('12月の行が無い → 毎月行を使う', s12.source === 'default' && near(s12.amount, 900000), true);
  check('12月の momo は毎月行にも無い → null', T.pick(p, '2026-12', 'momo', 0.1), null);
  check('知らないスタッフ → null', T.pick(p, '2026-11', 'yui', 0.1), null);
  const pi = T.parse(['月,お店（税込）', '2026/11,1100000'].join('\n'), STAFF);
  check('税込の目標を税抜表示 → ÷1.1', near(T.pick(pi, '2026-11', 'store', 0.1).amount, 1000000), true);
  check('税込の目標を税込表示 → そのまま', near(T.pick(pi, '2026-11', 'store', 0).amount, 1100000), true);
  check('解析できなかった表 → null', T.pick({ ok: false }, '2026-11', 'store', 0.1), null);
}

console.log(`\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m${pass} pass\x1b[0m · \x1b[31m${fail} fail\x1b[0m`);
process.exit(fail ? 1 : 0);
