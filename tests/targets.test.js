/* 月の売上目標（スプレッドシートの「目標」タブ）の読み込みテスト。
 * URLの組み立て・表の解析（見出しの揺れ・税込注記・毎月行・万表記・日付形式）・
 * 該当月の取り出しと税込／税抜の換算を、手で計算した期待値で検証する。
 * あわせて、スタッフ名の照合（「の」で終わる名前・括弧つきの名前・前が同じ名前）、
 * 月を読めない行の報告（skipped・gviz が「毎月」を空で返す形）、お店の列の優先と
 * 同じ相手の列の食い違い（ignored・conflicts）、予約データ・会計明細の見分け
 * （ingest.js と同じ判定・ingest.js が無いときも同じ）を確かめる。
 * Run: node tests/targets.test.js */
'use strict';
const path = require('path');
// 予約データ・会計明細の見出しの判定（isYoyakuHeader / isKaikeiHeader）を KATE.ingest に載せる
const I = require(path.join(__dirname, '..', 'assets', 'js', 'ingest.js'));
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

// 見出し1つだけの表を解析し、その列の判定を短い文字で返す（'staff:あやの' / 'staff:あやの（税込）' / 'store' / 'unknown'）
function kindOf(label, staff) {
  const p = T.parse('月,' + label + '\n2026/11,100000', staff);
  if (!p.ok) return p.reason === 'no-columns' && p.unknown.length ? 'unknown' : p.reason;
  const c = p.columns[0];
  return c.key === 'store' ? 'store' : c.key + ':' + c.name + (c.taxIncl ? '（税込）' : '');
}
// 税抜表示での目標額（無ければ null）
function amountOf(p, ym, who) { const g = T.pick(p, ym, who, 0.1); return g ? g.amount : null; }

h('■ スタッフ名の照合（名前そのものは削らない）');
{
  const p = T.parse(['月,お店,あやの,ゆきの,momo', '2026/11,1200000,500000,400000,300000'].join('\n'), ['あやの', 'ゆきの', 'momo']);
  check('「の」で終わる名前（あやの・ゆきの）も列として読む', p.unknown, []);
  check('あやの の目標', amountOf(p, '2026-11', 'あやの'), 500000);
  check('ゆきの の目標', amountOf(p, '2026-11', 'ゆきの'), 400000);
  check('momo の目標', amountOf(p, '2026-11', 'momo'), 300000);
}
check('「しの目標」→ しの', kindOf('しの目標', ['しの', 'momo']), 'staff:しの');
check('「りのさん」→ りの', kindOf('りのさん', ['りの', 'momo']), 'staff:りの');
check('「あやの（税込）」→ あやの・税込', kindOf('あやの（税込）', ['あやの']), 'staff:あやの（税込）');
check('「あやの目標税込」（末尾の税込）→ あやの・税込', kindOf('あやの目標税込', ['あやの']), 'staff:あやの（税込）');
check('「あや」は「あやの」の列にしない（名前は削らない）', kindOf('あや', ['あやの']), 'unknown');
check('「momo(指名)」→ 括弧つきの名前そのまま', kindOf('momo(指名)', ['momo(指名)', 'aoi']), 'staff:momo(指名)');
check('「momo(指名)（税込)」→ momo(指名)・税込', kindOf('momo(指名)（税込)', ['momo(指名)', 'aoi']), 'staff:momo(指名)（税込）');
check('全角の括弧 ｍｏｍｏ（指名） のスタッフ名とも一致', kindOf('momo(指名)', ['ｍｏｍｏ（指名）']), 'staff:ｍｏｍｏ（指名）');
check('「momo(指名)の目標」（名前のあとの注記）→ momo（従来どおり）', kindOf('momo(指名)の目標', ['momo', 'aoi']), 'staff:momo');
check('「(担当)momo」（名前の前の注記）→ momo（従来どおり）', kindOf('(担当)momo', STAFF), 'staff:momo');
check('「税込momo」（名前の前の税込）→ momo・税込（従来どおり）', kindOf('税込momo', STAFF), 'staff:momo（税込）');
check('「(担当)あやの」は前の注記だけ除いて あやの（あや にしない）', kindOf('(担当)あやの', ['あや', 'あやの']), 'staff:あやの');
{
  const csv = ['月,あや,あやの', '2026/11,500000,800000'].join('\n');
  [['あや', 'あやの'], ['あやの', 'あや']].forEach(function (S) {
    const p = T.parse(csv, S);
    check('あや と あやの が並んでも別の列（' + S.join('→') + ' の順）', [amountOf(p, '2026-11', 'あや'), amountOf(p, '2026-11', 'あやの')], [500000, 800000]);
    check('  食い違いも使わない列も無い（' + S.join('→') + ' の順）', [p.conflicts, p.unknown], [[], []]);
  });
  check('「あやの目標」は長い名前の あやの（あや＋の目標 にしない）', kindOf('あやの目標', ['あや', 'あやの']), 'staff:あやの');
  check('「あやのさん」→ あやの', kindOf('あやのさん', ['あや', 'あやの']), 'staff:あやの');
  check('「あやさん」→ あや', kindOf('あやさん', ['あや', 'あやの']), 'staff:あや');
}
check('空のスタッフ名があっても、どの見出しにも当てはめない', T.parse('月,お店,メモ\n2026/11,1200000,x', ['', 'momo']).unknown, ['メモ']);

h('■ 月を読めない行は使わずに知らせる（skipped・行番号は見出しを1行目として数える）');
{
  // gviz は日付が多い「月」の列の少数派（文字の「毎月」）を空で返す → 月の欄が空の行として届く
  const gviz = ['"月","お店","momo","aoi"', '"2026/11/01","1200000","700000","500000"', '"2026/12/01","1400000","800000","600000"', '"","1000000","600000","400000"'].join('\n');
  const p = T.parse(gviz, STAFF);
  check('解析はできる', p.ok, true);
  check('月の欄が空で金額がある行 → blankMonth に4行目', p.skipped, { blankMonth: [4], badMonth: [] });
  check('その行は既定値（毎月）にしない', p.defaults, null);
  check('読めた行は2行', p.rowsRead, 2);
}
{
  const p = T.parse(['月,お店,momo,aoi', '7月,1200000,700000,500000', '2026/08,1300000,700000,600000'].join('\n'), STAFF);
  check('「7月」（年が無い）→ badMonth に行番号と書かれた文字', p.skipped, { blankMonth: [], badMonth: [{ row: 2, text: '7月' }] });
  check('読めた行（2026/08）は使う', [p.rowsRead, amountOf(p, '2026-08', 'store')], [1, 1300000]);
}
{
  const p = T.parse(['月,お店,momo,aoi', '2026/11,1200000,700000,500000', '2026/12,"1,400,000",800000,600000', '毎月,1000000,600000,400000'].join('\n'), STAFF);
  check('すべて読める表 → どちらも空', p.skipped, { blankMonth: [], badMonth: [] });
  check('すべて読める表 → ignored・conflicts も空', [p.ignored, p.conflicts], [[], []]);
}
{
  // 途中の空行（gviz では "","" の行）も数えるので、行番号はシートと同じ
  const p = T.parse(['"月","お店","momo"', '"2026/11/01","1200000","700000"', '"","",""', '"","1000000","600000"'].join('\n'), STAFF);
  check('途中の空行も数えた行番号（4行目）', (p.skipped || {}).blankMonth, [4]);
}
{
  const p = T.parse(['月,お店,メモ', '2026/11,1200000,', ',,来月見直し', '合計,1200000,'].join('\n'), STAFF);
  check('金額の無い行（メモだけ）と「合計」の集計行は数えない', p.skipped, { blankMonth: [], badMonth: [] });
}

h('■ お店の列が複数あるとき（ignored）');
{
  const p = T.parse(['月,お店,momo,aoi,合計', '2026/11,1500000,700000,500000,1200000'].join('\n'), STAFF);
  check('「お店」と「合計」→ お店の目標は「お店」の列', amountOf(p, '2026-11', 'store'), 1500000);
  check('「合計」は使わなかった列として記録', p.ignored, ['合計']);
  check('使った列に「合計」は入らない', p.columns.map(function (c) { return c.label; }), ['お店', 'momo', 'aoi']);
  check('確認用の列なので食い違いとしては数えない・スタッフ名と一致しない列でもない', [p.conflicts, p.unknown], [[], []]);
  const q = T.parse(['月,合計,お店,momo,aoi', '2026/11,1200000,1500000,700000,500000'].join('\n'), STAFF);
  check('「合計」が左にあっても「お店」の列を使う', amountOf(q, '2026-11', 'store'), 1500000);
  check('列の順に関係なく「合計」を記録', q.ignored, ['合計']);
  const r = T.parse(['月,合計,momo', '2026/11,1200000,700000'].join('\n'), STAFF);
  check('「合計」しか無ければ、それをお店の目標にする', amountOf(r, '2026-11', 'store'), 1200000);
  check('そのときは ignored は空', r.ignored, []);
  const s = T.parse(['月,お店合計（税込）,店舗', '2026/11,1320000,1200000'].join('\n'), STAFF);
  check('「お店合計（税込）」も、はっきりしたお店の列（店舗）があれば使わない', [s.ignored, amountOf(s, '2026-11', 'store')], [['お店合計(税込)'], 1200000]);
}

h('■ 同じ相手の列が複数あるとき（左の列を使い、食い違いは conflicts）');
{
  const p = T.parse(['月,お店,お店（税込）', '2026/11,1000000,1210000'].join('\n'), STAFF);
  check('左の列を使う（後ろの列で上書きしない）', p.months['2026-11'].store, { amount: 1000000, taxIncl: false });
  check('税抜にそろえて違う金額 → conflicts（行・相手・使った列と食い違った列）', p.conflicts, [{ row: 2, key: 'store', labels: ['お店', 'お店(税込)'] }]);
  const q = T.parse(['月,お店,お店（税込）', '2026/11,1000000,1100000'].join('\n'), STAFF);
  check('税込・税抜で書き分けただけの同じ額 → 食い違いではない', q.conflicts, []);
  const r = T.parse(['月,お店（税込）,お店', '2026/11,1100001,1000000'].join('\n'), STAFF);
  check('差が ¥1 以内 → 食い違いではない', r.conflicts, []);
  check('このときも左の列（税込）を使う', r.months['2026-11'].store, { amount: 1100001, taxIncl: true });
  const s = T.parse(['月,お店,お店（税込）', '2026/11,,1210000'].join('\n'), STAFF);
  check('左の列が空なら、次の列の金額を使う（食い違いでもない）', [s.months['2026-11'].store, s.conflicts], [{ amount: 1210000, taxIncl: true }, []]);
}
{
  const p = T.parse(['月,momo,MOMO（税込）,aoi', '2026/11,700000,880000,500000', '毎月,600000,660000,400000'].join('\n'), STAFF);
  check('同じスタッフの列も左の列を使う', p.months['2026-11'].staff.momo, { amount: 700000, taxIncl: false });
  check('同じスタッフの列の食い違い → key はスタッフ名（毎月の行は同じ額なので出さない）', p.conflicts, [{ row: 2, key: 'momo', labels: ['momo', 'MOMO(税込)'] }]);
}
{
  const p = T.parse(['月,お店,お店（税込）,店舗', '2026/11,1000000,1100000,1200000'].join('\n'), STAFF);
  check('3列のうち、使った列と食い違った列だけを記録', p.conflicts, [{ row: 2, key: 'store', labels: ['お店', '店舗'] }]);
  const q = T.parse(['月,お店,お店（税込）', '7月,1000000,1210000'].join('\n'), STAFF);
  check('使わなかった行（月を読めない）の食い違いは数えない', [q.conflicts, ((q.skipped || {}).badMonth || []).length], [[], 1]);
}

h('■ 目標の表ではないもの（予約データ・会計明細の見分けは ingest.js と同じ）');
const KAIKEI_NO_ID = '会計日,会計時間,スタッフ,区分,金額\n2026/07/01,103000,momo,施術,8000';
check('ingest.js が見出しの判定を公開している', [typeof I.isYoyakuHeader, typeof I.isKaikeiHeader], ['function', 'function']);
check('会計ID の無い会計明細（会計日＋金額）→ wrong-sheet', T.parse(KAIKEI_NO_ID, STAFF).reason, 'wrong-sheet');
check('会計ID のある会計明細 → wrong-sheet', T.parse('会計ID,会計日,金額\nA1,2026/07/01,8000', STAFF).reason, 'wrong-sheet');
check('予約番号の列がある予約データ → wrong-sheet', T.parse('予約番号,お名前,スタッフ名\nR001,ヤマダ,momo', STAFF).reason, 'wrong-sheet');
check('来店日の列も目印にする → wrong-sheet', T.parse('来店日,スタッフ名\n2026/07/01,momo', STAFF).reason, 'wrong-sheet');
check('「金額」の列があるだけの目標の表は採用する', T.parse('月,お店,金額\n2026/11,1200000,', STAFF).ok, true);
{
  const saved = I.isKaikeiHeader;
  I.isKaikeiHeader = function () { return true; };   // ingest.js 側の判定を差し替えると targets.js も従う
  try { check('ingest.js の判定をそのまま使う', T.parse('月,お店\n2026/11,1200000', STAFF).reason, 'wrong-sheet'); }
  finally { I.isKaikeiHeader = saved; }
}

h('■ ingest.js が読み込まれていなくても同じ判定・同じ解析');
{
  const saved = globalThis.KATE.ingest;
  delete globalThis.KATE.ingest;
  try {
    check('会計ID の無い会計明細 → wrong-sheet', T.parse(KAIKEI_NO_ID, STAFF).reason, 'wrong-sheet');
    check('予約データ（ステータス）→ wrong-sheet', T.parse('ステータス,来店日,スタッフ名\n会計済み,2026/07/01,momo', STAFF).reason, 'wrong-sheet');
    check('予約番号 → wrong-sheet', T.parse('予約番号,お名前\nR001,ヤマダ', STAFF).reason, 'wrong-sheet');
    const p = T.parse(['月,お店,momo', '2026/11,"1,200,000",700000'].join('\n'), STAFF);
    check('目標の表は CSV から読める', [p.ok, amountOf(p, '2026-11', 'store'), amountOf(p, '2026-11', 'momo')], [true, 1200000, 700000]);
  } finally {
    globalThis.KATE.ingest = saved;
  }
}

console.log(`\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m${pass} pass\x1b[0m · \x1b[31m${fail} fail\x1b[0m`);
process.exit(fail ? 1 : 0);
