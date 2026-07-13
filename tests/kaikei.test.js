/* Regression tests for the Phase-1 calculation fixes (会計明細 / retail-ratio /
 * maturity-trimming / pooled staff averages) and the Phase-3 self-growth fields
 * (personal best / cumulative milestones / 育てた常連). Fixtures are small and
 * hand-verified in the comments below — each expected value is computed by hand,
 * not derived from the implementation. Run: node tests/kaikei.test.js */
'use strict';
const path = require('path');
const engine = require(path.join(__dirname, '..', 'assets', 'js', 'engine.js'));

let pass = 0, fail = 0;
function check(label, got, want, tol) {
  tol = tol == null ? 1e-9 : tol;
  const ok = Math.abs(got - want) <= tol;
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  if (ok) pass++; else fail++;
  console.log(`  ${tag}  ${label.padEnd(46)} got=${fmt(got)}  want=${fmt(want)}`);
}
function fmt(v) { return typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : v; }
function h(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// Minimal normalized-record builder (same shape engine.compute expects — the
// field names ingest.js maps onto, not raw Japanese headers).
function rec(o) {
  return Object.assign({
    status: '会計済み', staff: null, route: '直接来店', custKey: null,
    name: null, gender: null, first: null, shimei: null,
    yoyakuTotal: null, payPlanned: null, kaikeiTotal: null,
    shohan: null, shohanCat: null, shohanAmount: null
  }, o);
}

// ============================================================================
// Fixture A — 店販顧客比率 (M13) は人ベース、attachRate/avgSpend は会計ベース (P1-1)
// ============================================================================
// C1: 2 visits, one with retail (¥3,000). C2: 1 visit with retail (¥5,000).
// C3, C4: 1 visit each, no retail. Total 5 rows, 4 unique customers, 2 rows
// with retail (C1's 2nd visit, C2's only visit) belonging to 2 unique buyers.
h('■ Fixture A: 店販顧客比率（人ベース）');
{
  const rows = [
    rec({ custKey: 'C1', date: '2026-05-01', kaikeiTotal: 10000 }),
    rec({ custKey: 'C1', date: '2026-05-15', kaikeiTotal: 12000, shohan: 'item', shohanAmount: 3000 }),
    rec({ custKey: 'C2', date: '2026-05-03', kaikeiTotal: 9000, shohan: 'item2', shohanAmount: 5000 }),
    rec({ custKey: 'C3', date: '2026-05-04', kaikeiTotal: 8000 }),
    rec({ custKey: 'C4', date: '2026-05-05', kaikeiTotal: 7000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-08-01' });
  const rt = R.store.retail;
  // buyers=2 people (C1,C2) / visitCustomers=4 people (C1..C4) => 0.5
  check('customerRatio (2人/4人)', rt.customerRatio, 0.5);
  // buyingVisits=2 rows / 5 total rows => 0.4
  check('attachRate (2件/5件)', rt.attachRate, 0.4);
  check('buyers (人)', rt.buyers, 2);
  check('visitCustomers (人)', rt.visitCustomers, 4);
  check('buyingVisits (件)', rt.buyingVisits, 2);
  check('amount', rt.amount, 8000);
  // avgSpend divisor is buyingVisits (会計単位), not buyers (人数): 8000/2=4000
  check('avgSpend (会計単位: 8000/2件)', rt.avgSpend, 4000);
  // revenueRatio = 8000 / (10000+12000+9000+8000+7000=46000)
  check('revenueRatio', rt.revenueRatio, 8000 / 46000);
}

// ============================================================================
// Fixture B — リピート率/固定化率/funnel/churn は予約ベース（45日成熟待ちなし）
// ============================================================================
// asOf = 2026-08-01。「到達」は45日の経過を待たず、予約ベース（Fres、キャンセル
// 後の再予約を考慮・キャンセルのみは含まない）で即座に判定する。N1/N2は直近
// （asOfの数日前）の来店だが、成熟待ちなしで通常通りカウントされる。P1/P2は
// キャンセルの扱いを検証：P1はキャンセル後に再予約なし→未到達、P2はキャンセル
// 後に別日で来店→2回到達（Fixture Mのnextの検証と同じルールがfunnelでも
// 効いていることを確認）。
h('■ Fixture B: リピート率・固定化率は予約ベース（45日成熟待ちなし）');
{
  const rows = [
    rec({ custKey: 'M1', date: '2026-05-01', kaikeiTotal: 5000 }),
    rec({ custKey: 'M1', date: '2026-05-15', kaikeiTotal: 5000 }),   // M1: Fres=2 → 2回到達
    rec({ custKey: 'M2', date: '2026-05-01', kaikeiTotal: 5000 }),   // M2: Fres=1 → 未到達
    rec({ custKey: 'N1', date: '2026-07-25', kaikeiTotal: 5000 }),   // N1: 直近来店・Fres=1 → 未到達
    rec({ custKey: 'N2', date: '2026-07-20', kaikeiTotal: 5000 }),
    rec({ custKey: 'N2', date: '2026-07-28', kaikeiTotal: 5000 }),   // N2: 直近来店だがFres=2 → 2回到達（成熟待ちなし）
    rec({ custKey: 'P1', date: '2026-06-01', kaikeiTotal: 5000 }),
    rec({ custKey: 'P1', status: 'お客様キャンセル', date: '2026-06-15' }),   // P1: キャンセルのみ・再予約なし → 未到達
    rec({ custKey: 'P2', date: '2026-06-01', kaikeiTotal: 5000 }),
    rec({ custKey: 'P2', status: 'お客様キャンセル', date: '2026-06-15' }),
    rec({ custKey: 'P2', date: '2026-07-05', kaikeiTotal: 5000 })            // P2: キャンセル後、別日で来店 → 2回到達
  ];
  const R = engine.compute(rows, { asOf: '2026-08-01' });
  check('store.customers（来店顧客6人）', R.store.customers, 6);
  // repeatRate = 2回到達（M1,N2,P2の3人）/ 来店顧客6人 = 0.5 => ×100 = 50
  check('store.repeatRate（M1,N2,P2の3人/6人）', R.store.repeatRate, 50, 0.05);
  check('store.fixationRate（3回到達は誰もいない）', R.store.fixationRate, 0, 0.05);
  check('funnel[0].people（1回到達=全6人）', R.store.funnel[0].people, 6);
  check('funnel[1].people（2回到達=M1,N2,P2の3人）', R.store.funnel[1].people, 3);
  check('churn.base（来店顧客6人）', R.store.churn.base, 6);
  check('churn.total（Fres<2=M2,N1,P1の3人）', R.store.churn.total, 3);
}

// ============================================================================
// Fixture C — revActual/revExpected の正確分解 + rev の維持 (P1-3)
// ============================================================================
// Same month ('2026-07'): 2 visited rows (revActual) + 2 future rows (revExpected).
h('■ Fixture C: revActual/revExpected の分解');
{
  const rows = [
    rec({ custKey: 'V1', date: '2026-07-01', kaikeiTotal: 10000 }),
    rec({ custKey: 'V2', date: '2026-07-02', kaikeiTotal: 15000 }),
    rec({ custKey: 'W1', status: '受付待ち', date: '2026-07-10', yoyakuTotal: 8000 }),
    rec({ custKey: 'W2', status: '受付待ち', date: '2026-07-15', yoyakuTotal: 12000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-07-04' });
  const m = R.store.monthly.find(x => x.m === '2026-07');
  check('monthly.revActual', m.revActual, 25000);
  check('monthly.revExpected', m.revExpected, 20000);
  check('monthly.rev (維持: revActual+revExpected)', m.rev, 45000);
  check('monthly.actual', m.actual, 2);
  check('monthly.exp', m.exp, 2);
  // spend is 予約ベース (元ワークブック準拠): 予約ベース売上 45000 ÷ 予約数 4 = 11250
  check('monthly.spend (予約ベース客単価)', m.spend, 11250);
}

// ============================================================================
// Fixture D — スタッフ平均は pooled（件数で重み付け／オーナー確定・mean-of-months ではない）
// ============================================================================
// Staff 'X': month A (2 visits, 1 got-next => 50%), month B (8 visits, 6 got-next
// => 75%). Pooled (visit-weighted) gives (1+6)/(2+8)=0.7; mean-of-months would
// give (0.5+0.75)/2=0.625. 件数の少ない月を過大評価しないため pooled 0.7 が期待値。
// "Got next" is manufactured by giving those customers a later visit in 2026-08
// under a different staff ('Y') so it doesn't pollute X's own monthly counts.
// A dummy future row elsewhere sets hasFuture=true so month-maturity never gates
// this fixture (isolating the averaging behaviour from the P1-2 concern).
h('■ Fixture D: スタッフ平均は pooled（件数で重み付け）次回予約取得率');
{
  const rows = [
    rec({ staff: 'X', custKey: 'XA1', date: '2026-05-01', kaikeiTotal: 6000 }),
    rec({ staff: 'X', custKey: 'XA2', date: '2026-05-05', kaikeiTotal: 6000 }),
    rec({ staff: 'Y', custKey: 'XA1', date: '2026-08-01', kaikeiTotal: 6000 }),   // XA1's "next"

    rec({ staff: 'X', custKey: 'XB1', date: '2026-06-01', kaikeiTotal: 6000 }),
    rec({ staff: 'X', custKey: 'XB2', date: '2026-06-02', kaikeiTotal: 6000 }),
    rec({ staff: 'X', custKey: 'XB3', date: '2026-06-03', kaikeiTotal: 6000 }),
    rec({ staff: 'X', custKey: 'XB4', date: '2026-06-04', kaikeiTotal: 6000 }),
    rec({ staff: 'X', custKey: 'XB5', date: '2026-06-05', kaikeiTotal: 6000 }),
    rec({ staff: 'X', custKey: 'XB6', date: '2026-06-06', kaikeiTotal: 6000 }),
    rec({ staff: 'X', custKey: 'XB7', date: '2026-06-07', kaikeiTotal: 6000 }),   // no next
    rec({ staff: 'X', custKey: 'XB8', date: '2026-06-08', kaikeiTotal: 6000 }),   // no next
    rec({ staff: 'Y', custKey: 'XB1', date: '2026-08-02', kaikeiTotal: 6000 }),
    rec({ staff: 'Y', custKey: 'XB2', date: '2026-08-03', kaikeiTotal: 6000 }),
    rec({ staff: 'Y', custKey: 'XB3', date: '2026-08-04', kaikeiTotal: 6000 }),
    rec({ staff: 'Y', custKey: 'XB4', date: '2026-08-05', kaikeiTotal: 6000 }),
    rec({ staff: 'Y', custKey: 'XB5', date: '2026-08-06', kaikeiTotal: 6000 }),
    rec({ staff: 'Y', custKey: 'XB6', date: '2026-08-07', kaikeiTotal: 6000 }),

    // Dummy future row (unrelated customer) so hasFuture=true store-wide.
    rec({ staff: 'Z', custKey: 'ZZ', status: '受付待ち', date: '2026-09-01', yoyakuTotal: 6000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-08-10' });
  check('meta.completedOnly (future行あり => false)', R.meta.completedOnly ? 1 : 0, 0);
  const x = R.staff.find(s => s.name === 'X');
  const monthA = x.monthly.find(m => m.m === '2026-05');
  const monthB = x.monthly.find(m => m.m === '2026-06');
  check('monthA.nextRes (1/2)', monthA.nextRes, 0.5);
  check('monthB.nextRes (6/8)', monthB.nextRes, 0.75);
  // pooled (件数で重み付け): (1+6)/(2+8) = 0.7 — NOT the mean-of-months 0.625
  check('avg.nextRes は pooled (0.7、単純平均0.625ではない)', x.avg.nextRes, 0.7);
  check('avg.nextResNum (次回確保 1+6=7)', x.avg.nextResNum, 7);
  check('avg.nextResDen (来店 2+8=10)', x.avg.nextResDen, 10);
}

// ============================================================================
// Fixture E (oracle) — サンプルデータの pooled 平均値を固定（回帰オラクル）
// ============================================================================
// staff.avg.{spend,nextRes,nextRes2} は pooled（件数で重み付け・オーナー確定）に
// 変更。プール平均は Σ分子/Σ分母で、来店の少ない月に引きずられない。将来の回帰を
// 外部オラクル無しでも捕まえるため、独立再計算で確認した値をここに固定する。
h('■ Fixture E: サンプルデータの pooled 平均値を固定（回帰オラクル）');
{
  require(path.join(__dirname, '..', 'assets', 'js', 'sample-data.js'));
  const data = globalThis.KATE.SAMPLE_RESERVATIONS;
  const R = engine.compute(data, { asOf: '2026-07-03' });
  const momo = R.staff.find(s => s.name === 'momo');
  const aoi = R.staff.find(s => s.name === 'aoi');
  // pooled: 客単価=Σ予約ベース売上÷Σ予約数、次回=Σ次回確保来店÷Σ来店
  check('momo avg.spend (pooled ¥6266)', momo.avg.spend, 6266);
  check('momo avg.nextRes (pooled 273/472)', momo.avg.nextRes, 273 / 472, 1e-9);
  check('momo avg.nextResNum', momo.avg.nextResNum, 273);
  check('momo avg.nextResDen', momo.avg.nextResDen, 472);
  check('momo avg.nextRes2 (pooled)', momo.avg.nextRes2, 0.46715328467153283, 1e-6);
  check('aoi avg.spend (pooled ¥6808)', aoi.avg.spend, 6808);
  check('aoi avg.nextRes (pooled 46/80=0.575・単純平均0.773ではない)', aoi.avg.nextRes, 0.575, 1e-9);
  check('aoi avg.nextRes2 (pooled)', aoi.avg.nextRes2, 0.5, 1e-6);
  check('store.retail.customerRatio (人ベース)', R.store.retail.customerRatio, 11 / 359, 1e-6);
  check('store.retail.attachRate (会計ベース)', R.store.retail.attachRate, 11 / 552, 1e-6);
}

// ============================================================================
// Fixture F — Phase 3: 自己ベスト(M24)・累計マイルストーン(M25)・育てた常連
// ============================================================================
// Staff 'P', asOf = 2026-08-15. August is the in-progress "current" month and
// must be excluded from personal-best comparisons — its rows below carry
// deliberately extreme values on every metric so a leak would fail loudly.
// REG1-3 are P's first-visit customers who return 3+ times each (mature by
// asOf) => regulars3=3. F1-F14 are one-off filler visits that pad monthly
// totals but never reach Fres>=3, so they can't be mistaken for regulars.
// June/July tie on visits (5=5) to test "tie => no pill"; revenue strictly
// increases May<June<July to test "strict => pill". Monthly spend (=rev/visits)
// happens to tie May/June at 6000 then jump to 8400 in July, exercising the
// same tie→strict pattern for the personalBest.spend field.
h('■ Fixture F: 自己ベスト・累計マイルストーン・育てた常連');
{
  const rows = [
    // May 2026: 3 visits (REG1-3 only) — spend 18000/3=6000
    rec({ staff: 'P', custKey: 'REG1', date: '2026-05-01', kaikeiTotal: 6000 }),
    rec({ staff: 'P', custKey: 'REG2', date: '2026-05-02', kaikeiTotal: 6000, shohan: 'item', shohanAmount: 1000 }),
    rec({ staff: 'P', custKey: 'REG3', date: '2026-05-03', kaikeiTotal: 6000 }),
    // June 2026: 5 visits (REG1-3 + 2 fillers) — historical best on visits; spend
    // 30000/5=6000 ties May
    rec({ staff: 'P', custKey: 'REG1', date: '2026-06-01', kaikeiTotal: 6000 }),
    rec({ staff: 'P', custKey: 'REG2', date: '2026-06-02', kaikeiTotal: 6000 }),
    rec({ staff: 'P', custKey: 'REG3', date: '2026-06-03', kaikeiTotal: 6000 }),
    rec({ staff: 'P', custKey: 'F1', date: '2026-06-04', kaikeiTotal: 6000, shohan: 'item', shohanAmount: 2000 }),
    rec({ staff: 'P', custKey: 'F2', date: '2026-06-05', kaikeiTotal: 6000, shohan: 'item', shohanAmount: 1500 }),
    // July 2026: 5 visits (REG1-3 + 2 fillers) — ties June on visits, but
    // revenue (42000) and spend (8400) strictly exceed June (30000 / 6000)
    rec({ staff: 'P', custKey: 'REG1', date: '2026-07-01', kaikeiTotal: 6000 }),
    rec({ staff: 'P', custKey: 'REG2', date: '2026-07-02', kaikeiTotal: 6000 }),
    rec({ staff: 'P', custKey: 'REG3', date: '2026-07-03', kaikeiTotal: 6000 }),
    rec({ staff: 'P', custKey: 'F3', date: '2026-07-04', kaikeiTotal: 12000, shohan: 'item', shohanAmount: 1200 }),
    rec({ staff: 'P', custKey: 'F4', date: '2026-07-05', kaikeiTotal: 12000 }),
    // August 2026 (= asOf month, MUST be excluded from personalBest): 10 visits,
    // every metric maxed out to prove the exclusion actually holds.
    rec({ staff: 'P', custKey: 'F5', date: '2026-08-01', kaikeiTotal: 50000, shohan: 'item', shohanAmount: 9000 }),
    rec({ staff: 'P', custKey: 'F6', date: '2026-08-02', kaikeiTotal: 50000, shohan: 'item', shohanAmount: 9000 }),
    rec({ staff: 'P', custKey: 'F7', date: '2026-08-03', kaikeiTotal: 50000, shohan: 'item', shohanAmount: 9000 }),
    rec({ staff: 'P', custKey: 'F8', date: '2026-08-04', kaikeiTotal: 50000, shohan: 'item', shohanAmount: 9000 }),
    rec({ staff: 'P', custKey: 'F9', date: '2026-08-05', kaikeiTotal: 50000, shohan: 'item', shohanAmount: 9000 }),
    rec({ staff: 'P', custKey: 'F10', date: '2026-08-06', kaikeiTotal: 50000, shohan: 'item', shohanAmount: 9000 }),
    rec({ staff: 'P', custKey: 'F11', date: '2026-08-07', kaikeiTotal: 50000, shohan: 'item', shohanAmount: 9000 }),
    rec({ staff: 'P', custKey: 'F12', date: '2026-08-08', kaikeiTotal: 50000, shohan: 'item', shohanAmount: 9000 }),
    rec({ staff: 'P', custKey: 'F13', date: '2026-08-09', kaikeiTotal: 50000, shohan: 'item', shohanAmount: 9000 }),
    rec({ staff: 'P', custKey: 'F14', date: '2026-08-10', kaikeiTotal: 50000, shohan: 'item', shohanAmount: 9000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-08-15' });
  const p = R.staff.find(s => s.name === 'P');
  const may = p.monthly.find(m => m.m === '2026-05');
  const jun = p.monthly.find(m => m.m === '2026-06');
  const jul = p.monthly.find(m => m.m === '2026-07');

  check('May retailBuyingVisits', may.retailBuyingVisits, 1);
  check('June retailBuyingVisits', jun.retailBuyingVisits, 2);
  check('July retailBuyingVisits', jul.retailBuyingVisits, 1);

  check('personalBest.confirmedMonths（5,6,7月のみ・8月除外）', p.personalBest.confirmedMonths, 3);
  check('personalBest.visits.v（6月5件が最大）', p.personalBest.visits.v, 5);
  check('personalBest.visits.m', p.personalBest.visits.m === '2026-06' ? 1 : 0, 1);
  check('latestIsBest.visits（7月は6月とタイ→false）', p.personalBest.latestIsBest.visits ? 1 : 0, 0);
  check('personalBest.rev.v（7月42000が最大）', p.personalBest.rev.v, 42000);
  check('personalBest.rev.m', p.personalBest.rev.m === '2026-07' ? 1 : 0, 1);
  check('latestIsBest.rev（7月は単独最大→true）', p.personalBest.latestIsBest.rev ? 1 : 0, 1);
  check('personalBest.spend.v（7月8400が最大）', p.personalBest.spend.v, 8400);
  check('personalBest.spend.m', p.personalBest.spend.m === '2026-07' ? 1 : 0, 1);
  check('latestIsBest.spend（7月は5,6月とタイせず単独最大→true）', p.personalBest.latestIsBest.spend ? 1 : 0, 1);
  // retail is amount-based (月間店販売上): May 1000, June 2000+1500=3500, July 1200
  check('personalBest.retail.v（6月3500円が最大）', p.personalBest.retail.v, 3500);
  check('personalBest.retail.m', p.personalBest.retail.m === '2026-06' ? 1 : 0, 1);
  check('latestIsBest.retail（7月1200は6月未満→false）', p.personalBest.latestIsBest.retail ? 1 : 0, 0);

  // 平均店販売上/月 = (1000+3500+1200+90000) / active4ヶ月 = 23925
  check('retail.avgMonthlyAmount', p.retail.avgMonthlyAmount, Math.round((1000 + 3500 + 1200 + 90000) / 4));
  check('regulars3（REG1-3のみ・fillerは単回来店で対象外）', p.regulars3, 3);
}

// ============================================================================
// Fixture G — シグナル皆無時の null 化 と 確定月0件時のゲート
// ============================================================================
// Staff 'Z': 2 visits, both in the same month as asOf (so 0 confirmed months),
// and no 店販データ anywhere in this compute() call (anyRetail is a
// dataset-wide flag, so a separate call isolates it from Fixture F).
h('■ Fixture G: シグナル皆無 / 確定月0件のnull化');
{
  const rows = [
    rec({ staff: 'Z', custKey: 'ZC1', date: '2026-05-05', kaikeiTotal: 5000 }),
    rec({ staff: 'Z', custKey: 'ZC2', date: '2026-05-10', kaikeiTotal: 7000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-05-20' });
  const z = R.staff.find(s => s.name === 'Z');
  check('confirmedMonths（唯一の活動月=当月→0）', z.personalBest.confirmedMonths, 0);
  check('personalBest.visits（確定月0→null）', z.personalBest.visits === null ? 1 : 0, 1);
  check('personalBest.spend（確定月0→null）', z.personalBest.spend === null ? 1 : 0, 1);
  check('personalBest.retail（店販データ皆無→null）', z.personalBest.retail === null ? 1 : 0, 1);
  check('retail.avgMonthlyAmount（店販データ皆無→null）', z.retail.avgMonthlyAmount === null ? 1 : 0, 1);
  check('regulars3（単回来店のみ→0）', z.regulars3, 0);
}

// ============================================================================
// Fixture H — Phase 4 D1: 新規/再来ミックス・人気メニュー・クーポン依存度・
// 施術/店販の月次分解・時間帯ヒートマップのクランプ
// ============================================================================
h('■ Fixture H: 新規/再来ミックス・メニュー/クーポン品質・時間帯ヒートマップ');
{
  var ROWS = [1, 2, 3, 4, 5, 6, 0];   // engine の dayOfWeek/hourDow 行順（月→日）と同じ
  function rowIndexFor(dateStr) { return ROWS.indexOf(new Date(dateStr + 'T00:00:00').getDay()); }
  const rows = [
    rec({ custKey: 'A', date: '2026-05-01', kaikeiTotal: 6000, start: 1005 }),   // A 1st visit, 10:05 (no clamp)
    rec({ custKey: 'A', date: '2026-06-01', kaikeiTotal: 6000, start: 830 }),    // A 2nd visit (repeat), 8:30 -> clamp 9
    rec({ custKey: 'B', date: '2026-06-02', kaikeiTotal: 6000, start: 2130 }),   // B 1st visit (new), 21:30 -> clamp 20
    rec({ custKey: 'C', date: '2026-06-03', kaikeiTotal: 8000, shohanAmount: 2000, menu: 'MENU-X', coupon: 'C1' }),
    rec({ custKey: 'D', date: '2026-06-04', kaikeiTotal: 5000, menu: 'MENU-X' }),
    rec({ custKey: 'E', date: '2026-06-05', kaikeiTotal: 5000, menu: 'MENU-Y' })
  ];
  const R = engine.compute(rows, { asOf: '2026-08-01' });

  const may = R.store.newMix.find(m => m.m === '2026-05');
  const jun = R.store.newMix.find(m => m.m === '2026-06');
  check('newMix 5月 new（Aの初回のみ）', may.new, 1);
  check('newMix 5月 repeat', may.repeat, 0);
  check('newMix 6月 new（B,C,D,Eの初回=4）', jun.new, 4);
  check('newMix 6月 repeat（Aの2回目のみ）', jun.repeat, 1);

  const menuX = R.trend.menuTop.find(m => m.menu === 'MENU-X');
  check('menuTop MENU-X 件数（C,D）', menuX.n, 2);
  check('menuTop MENU-X 金額（8000+5000）', menuX.amount, 13000);

  check('couponRatio（Cのみクーポン付き ÷ 全6来店）', R.trend.couponRatio, 1 / 6, 1e-9);

  const junSR = R.store.serviceRetailMonthly.find(m => m.m === '2026-06');
  check('serviceRetailMonthly 6月 retail（Cの2000のみ）', junSR.retail, 2000);
  check('serviceRetailMonthly 6月 service（30000-2000）', junSR.service, 28000);

  const HOURS = R.trend.hourLabels.map(function (s) { return parseInt(s, 10); });
  const idx9 = HOURS.indexOf(9), idx20 = HOURS.indexOf(20), idx10 = HOURS.indexOf(10);
  const rowMay1 = rowIndexFor('2026-05-01'), rowJun1 = rowIndexFor('2026-06-01'), rowJun2 = rowIndexFor('2026-06-02');
  check('hourDow: 10:05はそのまま10時', R.trend.hourDow[rowMay1][idx10], 1);
  check('hourDow: 8:30は9時にクランプ', R.trend.hourDow[rowJun1][idx9], 1);
  check('hourDow: 21:30は20時にクランプ', R.trend.hourDow[rowJun2][idx20], 1);
  const totalHourDow = R.trend.hourDow.reduce(function (s, row) { return s + row.reduce(function (a, b) { return a + b; }, 0); }, 0);
  check('hourDow 合計 = startを持つ来店数（A×2+B=3件）', totalHourDow, 3);
}

// ============================================================================
// Fixture I — Phase 4 D2: 呼び戻しリスト（周期超過）とスタッフ稼働率
// ============================================================================
// asOf = day200 (BASE=2026-01-01 からのオフセットで表現). P1/P2 は店舗全体の
// 来店周期の中央値(40日)を作るためだけの土台。Q/R は自分自身の周期(30日・
// 閾値45日)で判定、S/T は来店1回のみのため店舗中央値(40日・閾値60日)へ
// フォールバックする — 4通りすべての分岐を1件ずつ確認する。
h('■ Fixture I: 呼び戻しリスト（周期超過）とスタッフ稼働率');
{
  function addDays(base, n) {
    var d = new Date(base + 'T00:00:00'); d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const BASE = '2026-01-01';
  const rows = [
    rec({ custKey: 'P1', name: 'P1', date: addDays(BASE, 0), kaikeiTotal: 5000 }),
    rec({ custKey: 'P1', name: 'P1', date: addDays(BASE, 40), kaikeiTotal: 5000 }),
    rec({ custKey: 'P1', name: 'P1', date: addDays(BASE, 80), kaikeiTotal: 5000 }),
    rec({ custKey: 'P2', name: 'P2', date: addDays(BASE, 0), kaikeiTotal: 5000 }),
    rec({ custKey: 'P2', name: 'P2', date: addDays(BASE, 60), kaikeiTotal: 5000 }),
    rec({ custKey: 'P2', name: 'P2', date: addDays(BASE, 120), kaikeiTotal: 5000 }),
    rec({ custKey: 'Q', name: 'Q', date: addDays(BASE, 130), kaikeiTotal: 5000 }),
    rec({ custKey: 'Q', name: 'Q', date: addDays(BASE, 160), kaikeiTotal: 5000 }),   // 周期30日・経過40日(<45)→非対象
    rec({ custKey: 'R', name: 'R', date: addDays(BASE, 120), kaikeiTotal: 5000 }),
    rec({ custKey: 'R', name: 'R', date: addDays(BASE, 150), kaikeiTotal: 5000 }),   // 周期30日・経過50日(>45)→対象
    rec({ custKey: 'S', name: 'S', date: addDays(BASE, 130), kaikeiTotal: 5000 }),   // 1回のみ・経過70日(>60)→対象
    rec({ custKey: 'T', name: 'T', date: addDays(BASE, 150), kaikeiTotal: 5000 }),   // 1回のみ・経過50日(<60)→非対象
    rec({ staff: 'U', custKey: 'U1', name: 'U1', date: '2026-02-05', kaikeiTotal: 6000, start: 1000, dur: 60 }),
    rec({ staff: 'U', custKey: 'U2', name: 'U2', date: '2026-02-10', kaikeiTotal: 6000, start: 1400, dur: 90 })
  ];
  const R2 = engine.compute(rows, { asOf: addDays(BASE, 200) });
  check('store.visitCycleMedianDays（[30,30,40,40,60,60]の中央値）', R2.store.visitCycleMedianDays, 40);

  function c(key) { return R2.rfm.customers.find(function (x) { return x.name === key; }); }
  check('Q: 自分の周期30日・経過40日→非対象', c('Q').cycleOverdue ? 1 : 0, 0);
  check('Q.ownCycle（自分の周期）', c('Q').ownCycle, 30);
  check('R: 自分の周期30日・経過50日→対象', c('R').cycleOverdue ? 1 : 0, 1);
  check('S: 来店1回・店舗中央値へフォールバック・経過70日→対象', c('S').cycleOverdue ? 1 : 0, 1);
  check('S.ownCycle（店舗中央値40日にフォールバック）', c('S').ownCycle, 40);
  check('T: 来店1回・フォールバック・経過50日→非対象', c('T').cycleOverdue ? 1 : 0, 0);

  const u = R2.staff.find(function (s) { return s.name === 'U'; });
  const feb = u.utilization.find(function (m) { return m.m === '2026-02'; });
  check('utilization 2月 minutes（60+90）', feb.minutes, 150);
  // 稼働可能時間＝実稼働日（施術のあった日数）×8h×60分。U は2/5・2/10の2日稼働。
  check('utilization 2月 workDays（実稼働2日）', feb.workDays, 2);
  check('utilization 2月 capacity（2日×8h×60分＝960）', feb.capacity, 2 * 8 * 60);
  check('utilization 2月 rate（150/960）', feb.rate, 150 / (2 * 8 * 60), 1e-9);
}

// ============================================================================
// Fixture J — dur が一件も無いデータセットでは utilization を算出しない
// ============================================================================
h('■ Fixture J: durデータ皆無時は utilization = null');
{
  const rows = [
    rec({ staff: 'V', custKey: 'V1', date: '2026-03-01', kaikeiTotal: 5000 }),
    rec({ staff: 'V', custKey: 'V2', date: '2026-03-02', kaikeiTotal: 5000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-03-10' });
  const v = R.staff.find(function (s) { return s.name === 'V'; });
  check('utilization（durデータ皆無→null）', v.utilization === null ? 1 : 0, 1);
}

// ============================================================================
// Fixture K — 期間バケット売上 (revPeriods/retailPeriods) と newMix の内訳
// ============================================================================
// asOf = 2026-07-10（今月=7月）。直近3ヶ月 = 4,5,6月（今月を含まない確定3ヶ月）。
// 3月は範囲外（バケットに入らないことの検証用）。スタッフ'W'は5月に来店ゼロ
// →「来店のあった月数」で割る仕様の検証（4,6月のみ ÷2）。
h('■ Fixture K: 期間バケット売上と newMix 内訳');
{
  const rows = [
    // 3月 (範囲外): W 100,000
    rec({ staff: 'W', custKey: 'K1', name: 'K1', date: '2026-03-05', kaikeiTotal: 100000 }),
    // 4月: W 2来店・同日 (営業日1日) 計12,000 / 店販 500
    rec({ staff: 'W', custKey: 'K2', name: 'K2', date: '2026-04-10', kaikeiTotal: 5000, shohan: 'item', shohanAmount: 500 }),
    rec({ staff: 'W', custKey: 'K3', name: 'K3', date: '2026-04-10', kaikeiTotal: 7000 }),
    // 5月: 別スタッフ'V'のみ 8,000 (Wは来店ゼロ月)
    rec({ staff: 'V', custKey: 'K4', name: 'K4', date: '2026-05-15', kaikeiTotal: 8000 }),
    // 6月: W 2来店・別日 (営業日2日) 計9,000 / K1の2回目・K2の2回目
    rec({ staff: 'W', custKey: 'K1', name: 'K1', date: '2026-06-01', kaikeiTotal: 4000 }),
    rec({ staff: 'W', custKey: 'K2', name: 'K2', date: '2026-06-20', kaikeiTotal: 5000, shohan: 'item', shohanAmount: 1000 }),
    // 7月 (今月): W 1来店 3,000 / K1の3回目
    rec({ staff: 'W', custKey: 'K1', name: 'K1', date: '2026-07-05', kaikeiTotal: 3000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-07-10' });
  const rp = R.store.revPeriods;

  check('last3 の範囲は 4,5,6月（3月・7月は含まない）', JSON.stringify(rp.last3.months) === JSON.stringify(['2026-04', '2026-05', '2026-06']) ? 1 : 0, 1);
  // store last3: (12000+8000+9000)/3ヶ月 = 9667
  check('store last3.monthly（29000/3）', rp.last3.monthly, Math.round(29000 / 3));
  // store last3 営業日: 4/10, 5/15, 6/1, 6/20 = 4日 → 29000/4 = 7250
  check('store last3.daily（営業日4日）', rp.last3.daily, 7250);
  check('store prevMonth.monthly（6月 9000）', rp.prevMonth.monthly, 9000);
  check('store prevMonth.daily（9000/2日）', rp.prevMonth.daily, 4500);
  check('store currentMonth.monthly（7月 3000・集計中）', rp.currentMonth.monthly, 3000);
  check('store currentMonth.daily（3000/1日）', rp.currentMonth.daily, 3000);

  const w = R.staff.find(s => s.name === 'W');
  // W last3: 4月12000 + 6月9000 = 21000、来店のあった月は2ヶ月 → 10500
  check('staff W last3.monthly（21000/活動2ヶ月）', w.revPeriods.last3.monthly, 10500);
  // W last3 営業日: 4/10, 6/1, 6/20 = 3日 → 21000/3 = 7000
  check('staff W last3.daily（営業日3日）', w.revPeriods.last3.daily, 7000);

  const v = R.staff.find(s => s.name === 'V');
  // V の今月(7月)は来店ゼロ → null
  check('staff V currentMonth.monthly（来店ゼロ→null）', v.revPeriods.currentMonth.monthly === null ? 1 : 0, 1);

  // retailPeriods: last3 = (500+1000)/3活動月 = 500
  check('retailPeriods.last3（1500/3活動月）', R.store.retailPeriods.last3, 500);
  check('retailPeriods.currentMonth（7月店販なし→0/1月=0）', R.store.retailPeriods.currentMonth, 0);

  // newMix 内訳: 6月 = K1の2回目 + K2の2回目 → v2=2; 7月 = K1の3回目 → v3=1
  const jun = R.store.newMix.find(m => m.m === '2026-06');
  const jul = R.store.newMix.find(m => m.m === '2026-07');
  check('newMix 6月 v2（K1,K2の2回目）', jun.v2, 2);
  check('newMix 6月 new', jun.new, 0);
  check('newMix 7月 v3（K1の3回目）', jul.v3, 1);
  check('newMix repeat = v2+v3+v4', jun.repeat, jun.v2 + jun.v3 + jun.v4);
}

// ============================================================================
// Fixture L — 受付待ち（見込み）も来店回数（_ord）で内訳できる
// ============================================================================
// asOf = 2026-07-10（今月=7月）。P1(スタッフS1): 6月に1回目(会計済み)、7月に
// 2回目の予約(受付待ち・見込み)。P2(スタッフS1): 過去の来店なし、7月に初回の
// 予約のみ(受付待ち) → 見込みでも1回目として数えられることの検証。P3(スタッフ
// S2、別スタッフ): 5月に1回目(会計済み)、7月に2回目の予約(受付待ち) →
// スタッフ別の内訳がS1/S2で混ざらないことの検証。
h('■ Fixture L: 受付待ちの来店回数内訳（composition の expNew/expV2）');
{
  const rows = [
    rec({ staff: 'S1', custKey: 'P1', name: 'P1', date: '2026-06-01', kaikeiTotal: 6000 }),
    rec({ staff: 'S1', custKey: 'P1', name: 'P1', status: '受付待ち', date: '2026-07-20', yoyakuTotal: 6000 }),
    rec({ staff: 'S1', custKey: 'P2', name: 'P2', status: '受付待ち', date: '2026-07-25', yoyakuTotal: 5000 }),
    rec({ staff: 'S2', custKey: 'P3', name: 'P3', date: '2026-05-01', kaikeiTotal: 7000 }),
    rec({ staff: 'S2', custKey: 'P3', name: 'P3', status: '受付待ち', date: '2026-07-28', yoyakuTotal: 7000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-07-10' });
  const s1 = R.staff.find(s => s.name === 'S1');
  const s2 = R.staff.find(s => s.name === 'S2');
  const s1Jun = s1.composition.find(c => c.m === '2026-06');
  const s1Jul = s1.composition.find(c => c.m === '2026-07');
  const s2May = s2.composition.find(c => c.m === '2026-05');
  const s2Jul = s2.composition.find(c => c.m === '2026-07');

  check('S1 6月 new（P1の1回目・会計済み）', s1Jun.new, 1);
  check('S1 7月 expV2（P1の2回目・見込み）', s1Jul.expV2, 1);
  check('S1 7月 expNew（P2は過去来店なし→見込みでも1回目）', s1Jul.expNew, 1);
  check('S1 7月 new（会計済みの新規は0）', s1Jul.new, 0);
  check('S2 5月 new（P3の1回目・会計済み）', s2May.new, 1);
  // S1の7月 expV2 は P1のみ(=1)。S2のP3も同じ月に expV2=1 を持つため、混ざって
  // いれば2になってしまう — スタッフ別に正しく分離されていることの検証。
  check('S2 7月 expV2（P3の2回目・見込み）', s2Jul.expV2, 1);
  check('S1 7月 expV2 は S2(P3) と混ざらず1のまま', s1Jul.expV2, 1);
}

// ============================================================================
// Fixture M — 次回予約取得率: キャンセルされた予約は「別日の予約」がなければ
// 次回予約とみなさない。別日に予約（来店）があれば、途中でキャンセルが
// あっても次回予約は成立する (visitGotNext は isEffective=キャンセル以外の
// 直近来店より後の予約有無で判定するため、この仕様を満たす)。
// ============================================================================
h('■ Fixture M: キャンセル後の再予約の有無で次回予約取得を判定');
{
  const rows = [
    // A: 1/1来店 → 1/15の予約がキャンセル、他に予約なし → 次回予約取得=false
    rec({ custKey: 'A', date: '2026-01-01', kaikeiTotal: 5000 }),
    rec({ custKey: 'A', status: 'お客様キャンセル', date: '2026-01-15' }),
    // B: 2/1来店 → 2/15の予約がキャンセル、しかし3/5に別予約（来店）あり → 次回予約取得=true
    rec({ custKey: 'B', date: '2026-02-01', kaikeiTotal: 5000 }),
    rec({ custKey: 'B', status: 'お客様キャンセル', date: '2026-02-15' }),
    rec({ custKey: 'B', date: '2026-03-05', kaikeiTotal: 6000 }),
    // C(スタッフT): 4/1初回・4/10の2回目来店 → 4/25の予約がキャンセル、他に予約なし
    // → 2回目次回予約取得率=0
    rec({ staff: 'T', custKey: 'C', date: '2026-04-01', kaikeiTotal: 5000 }),
    rec({ staff: 'T', custKey: 'C', date: '2026-04-10', kaikeiTotal: 5000 }),
    rec({ staff: 'T', custKey: 'C', status: 'お客様キャンセル', date: '2026-04-25' }),
    // D(スタッフT): 5/1初回・5/10の2回目来店 → 5/25の予約がキャンセル、しかし
    // 6/5に別予約（来店）あり → 2回目次回予約取得率=1
    rec({ staff: 'T', custKey: 'D', date: '2026-05-01', kaikeiTotal: 5000 }),
    rec({ staff: 'T', custKey: 'D', date: '2026-05-10', kaikeiTotal: 5000 }),
    rec({ staff: 'T', custKey: 'D', status: 'お客様キャンセル', date: '2026-05-25' }),
    rec({ staff: 'T', custKey: 'D', date: '2026-06-05', kaikeiTotal: 6000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-07-10' });
  const jan = R.store.monthly.find(m => m.m === '2026-01');
  const feb = R.store.monthly.find(m => m.m === '2026-02');
  check('1月 nextRes（Aはキャンセルのみ・再予約なし→0）', jan.nextRes, 0);
  check('2月 nextRes（Bはキャンセル後に別日来店あり→1）', feb.nextRes, 1);

  const t = R.staff.find(s => s.name === 'T');
  const apr = t.monthly.find(m => m.m === '2026-04');
  const may = t.monthly.find(m => m.m === '2026-05');
  check('4月 nextRes2（Cはキャンセルのみ・再予約なし→0）', apr.nextRes2, 0);
  check('5月 nextRes2（Dはキャンセル後に別日来店あり→1）', may.nextRes2, 1);
}

// ============================================================================
// Fixture N — 固定化率は「2回到達した顧客のうち3回目も予約した」条件付き継続率
// ============================================================================
// P, S2: Fres=3（2回到達かつ3回到達）。Q: Fres=2（2回到達のみ）。R: Fres=1（未到達）。
// 全顧客4人のうち2回到達=P,Q,S2の3人、3回到達=P,S2の2人。
// 固定化率 = 3回到達2人 ÷ 2回到達3人 = 66.7%（誤って全顧客4人で割ると50%になり、
// 区別できる値を意図的に選んでいる）。スタッフ側も同じ考え方（acqRecent内の
// 2回到達者を分母にする）で 2/3 = 0.667 になることを確認。
h('■ Fixture N: 固定化率は2回到達者に対する3回目到達の条件付き継続率');
{
  const rows = [
    rec({ staff: 'S', custKey: 'P', date: '2026-05-01', kaikeiTotal: 5000 }),
    rec({ staff: 'S', custKey: 'P', date: '2026-05-10', kaikeiTotal: 5000 }),
    rec({ staff: 'S', custKey: 'P', date: '2026-06-01', kaikeiTotal: 5000 }),   // P: Fres=3
    rec({ staff: 'S', custKey: 'Q', date: '2026-06-01', kaikeiTotal: 5000 }),
    rec({ staff: 'S', custKey: 'Q', date: '2026-06-15', kaikeiTotal: 5000 }),   // Q: Fres=2
    rec({ staff: 'S', custKey: 'R', date: '2026-07-01', kaikeiTotal: 5000 }),   // R: Fres=1
    rec({ staff: 'S', custKey: 'S2', date: '2026-05-05', kaikeiTotal: 5000 }),
    rec({ staff: 'S', custKey: 'S2', date: '2026-05-20', kaikeiTotal: 5000 }),
    rec({ staff: 'S', custKey: 'S2', date: '2026-06-10', kaikeiTotal: 5000 })   // S2: Fres=3
  ];
  const R = engine.compute(rows, { asOf: '2026-08-01' });
  check('store.customers（4人）', R.store.customers, 4);
  check('store.funnel[1].people（2回到達=P,Q,S2の3人）', R.store.funnel[1].people, 3);
  check('store.funnel[2].people（3回到達=P,S2の2人）', R.store.funnel[2].people, 2);
  check('store.fixationRate（2/3=66.7%、4人分の2/4=50%ではない）', R.store.fixationRate, 66.7, 0.05);

  const s = R.staff.find(x => x.name === 'S');
  check('staff.reach2（3/4=0.75、全acqRecent基準のまま）', s.reach2, 0.75, 1e-6);
  check('staff.reach3（2/4=0.5、全acqRecent基準のまま）', s.reach3, 0.5, 1e-6);
  check('staff.fixationRate（2/3=0.667、2回到達者基準）', s.fixationRate, 2 / 3, 1e-6);
}

// ============================================================================
// Fixture O — 基準日(meta.asOf)はタイムゾーンに依存しない
// ============================================================================
// parseDate はローカル深夜0時の Date を作るため、toISOString()（UTC変換）で
// 文字列化すると UTC より東の地域では前日にずれる（日本では 2026-07-03 指定が
// 「基準日 7月2日」と表示されていた実バグ）。テスト実行マシンのタイムゾーンに
// 関係なく検出できるよう、TZ=Asia/Tokyo の子プロセスでエンジンを実行して検証。
h('■ Fixture O: meta.asOf は日本時間でも指定日のまま（UTC変換で前日にずれない）');
{
  const { execFileSync } = require('child_process');
  const script = `
    const path = require('path');
    const engine = require(path.join(${JSON.stringify(__dirname)}, '..', 'assets', 'js', 'engine.js'));
    const rows = [{ status: '会計済み', staff: 's', route: '直接来店', custKey: 'A', name: null, gender: null,
      first: null, shimei: null, yoyakuTotal: null, payPlanned: null, kaikeiTotal: 5000,
      shohan: null, shohanCat: null, shohanAmount: null, date: '2026-06-01' }];
    process.stdout.write(engine.compute(rows, { asOf: '2026-07-03' }).meta.asOf);
  `;
  const got = execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ: 'Asia/Tokyo' }) }).toString();
  check('TZ=Asia/Tokyo でも meta.asOf は 2026-07-03', got === '2026-07-03' ? 1 : 0, 1, 0);
  if (got !== '2026-07-03') console.log(`         got=${JSON.stringify(got)}`);
}

// ============================================================================
// Fixture T — 固定化率の分母は「実来店2回目（Fvis>=2）」、分子は「そのうち3回目
// 予約あり（Fres>=3）」（オーナー確定の定義）。予約ベースの分母とは区別する。
// ============================================================================
// C1: 実来店2回＋3回目の受付待ち → Fvis=2, Fres=3 → 分母○ 分子○
// C2: 実来店2回のみ → Fvis=2, Fres=2 → 分母○ 分子×
// C3: 実来店1回＋2回目3回目の受付待ち → Fvis=1, Fres=3 → 分母×(まだ2回来ていない)
// 固定化率 = 分子1(C1) ÷ 分母2(C1,C2) = 0.5。もし旧・予約ベース(Fres>=2分母,
// Fres>=3分子)なら 2/3=0.667 になるため、両定義を確実に区別できる。
h('■ Fixture T: 固定化率の分母＝実来店2回目・分子＝そのうち3回目予約あり');
{
  const rows = [
    rec({ custKey: 'C1', date: '2026-05-01', kaikeiTotal: 5000 }),
    rec({ custKey: 'C1', date: '2026-05-20', kaikeiTotal: 5000 }),
    rec({ custKey: 'C1', status: '受付待ち', date: '2026-07-20', yoyakuTotal: 5000 }),
    rec({ custKey: 'C2', date: '2026-05-02', kaikeiTotal: 5000 }),
    rec({ custKey: 'C2', date: '2026-05-22', kaikeiTotal: 5000 }),
    rec({ custKey: 'C3', date: '2026-05-03', kaikeiTotal: 5000 }),
    rec({ custKey: 'C3', status: '受付待ち', date: '2026-07-21', yoyakuTotal: 5000 }),
    rec({ custKey: 'C3', status: '受付待ち', date: '2026-08-21', yoyakuTotal: 5000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-07-03' });
  check('固定化率 分母（実来店2回目 C1,C2）', R.store.fixDenom, 2);
  check('固定化率 分子（実来店2回目＆3回目予約 C1）', R.store.fixNumer, 1);
  check('固定化率 = 1/2 = 50.0%', R.store.fixationRate, 50.0, 0.05);
  // 参考: 旧・予約ベース分母(Fres>=2)なら3人・分子(Fres>=3)なら2人＝66.7%だった
  check('リピート率 分子（予約ベース Fres>=2 は C1,C2,C3 の3人）', R.store.repeatNumer, 3);
}

// ============================================================================
// Fixture U — 固定化率の分子: 3回目をキャンセルし別日の再予約が無い顧客は省く
// （オーナー確認事項）。キャンセル後に別日の再予約があれば「3回目の予約有り」と数える。
// ============================================================================
// X: 実来店2回 → 3回目を予約したが「お客様キャンセル」→ 別日の再予約なし
//    → Fvis=2（分母○）だが Fres=2（キャンセルは実効予約に数えない）→ 分子×
// Y: 実来店2回 → 3回目キャンセル → その後 別日に受付待ちで再予約
//    → Fvis=2（分母○）かつ Fres=3（再予約が実効予約）→ 分子○
h('■ Fixture U: 固定化率の分子はキャンセルのみ(再予約なし)を省く');
{
  const rows = [
    rec({ custKey: 'X', date: '2026-05-01', kaikeiTotal: 6000 }),
    rec({ custKey: 'X', date: '2026-05-20', kaikeiTotal: 6000 }),
    rec({ custKey: 'X', status: 'お客様キャンセル', date: '2026-06-10' }),
    rec({ custKey: 'Y', date: '2026-05-02', kaikeiTotal: 6000 }),
    rec({ custKey: 'Y', date: '2026-05-21', kaikeiTotal: 6000 }),
    rec({ custKey: 'Y', status: 'お客様キャンセル', date: '2026-06-11' }),
    rec({ custKey: 'Y', status: '受付待ち', date: '2026-08-01', yoyakuTotal: 6000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-07-03' });
  check('固定化率 分母（実来店2回目 X,Y）', R.store.fixDenom, 2);
  check('固定化率 分子（3回目の予約が現存する Y のみ・X は除外）', R.store.fixNumer, 1);
  check('固定化率 = 1/2 = 50.0%', R.store.fixationRate, 50.0, 0.05);
}

// ============================================================================
// Fixture V — ファネルの継続率/離脱率の母数は実来店(Fvis>=n)で補正、到達バーは予約
// ベース(Fres>=n)のまま。まだ来店前(2回目が受付待ち)の顧客が離脱率を押し上げない。
// ============================================================================
// A: 実来店3回 → Fvis=3, Fres=3
// B: 実来店2回＋3回目受付待ち → Fvis=2, Fres=3
// C: 実来店2回のみ → Fvis=2, Fres=2
// D: 実来店1回＋2回目受付待ち(来店前) → Fvis=1, Fres=2
// n=2段: 到達people(Fres>=2)=4人(A,B,C,D), 継続母数(Fvis>=2)=3人(A,B,C 来店前のDを除外),
//   継続分子(Fvis>=2&Fres>=3)=2人(A,B) → 継続66.7%。旧バー比なら 2/4=50% だったので
//   来店前のDを母数から外したことで離脱率が下がる（＝予約ベースの過大離脱を補正）。
h('■ Fixture V: ファネル継続率は実来店で母数補正・到達は予約ベース');
{
  const rows = [
    rec({ custKey: 'A', date: '2026-05-01', kaikeiTotal: 6000 }),
    rec({ custKey: 'A', date: '2026-05-10', kaikeiTotal: 6000 }),
    rec({ custKey: 'A', date: '2026-05-20', kaikeiTotal: 6000 }),
    rec({ custKey: 'B', date: '2026-05-02', kaikeiTotal: 6000 }),
    rec({ custKey: 'B', date: '2026-05-12', kaikeiTotal: 6000 }),
    rec({ custKey: 'B', status: '受付待ち', date: '2026-08-02', yoyakuTotal: 6000 }),
    rec({ custKey: 'C', date: '2026-05-03', kaikeiTotal: 6000 }),
    rec({ custKey: 'C', date: '2026-05-13', kaikeiTotal: 6000 }),
    rec({ custKey: 'D', date: '2026-05-04', kaikeiTotal: 6000 }),
    rec({ custKey: 'D', status: '受付待ち', date: '2026-08-04', yoyakuTotal: 6000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-07-03' });
  const n2 = R.store.funnel[1];   // 2回段
  check('2回 到達人数（予約ベース Fres>=2: A,B,C,D）', n2.people, 4);
  check('2→3 継続母数（実来店 Fvis>=2: A,B,C・来店前Dは除外）', n2.contDen, 3);
  check('2→3 継続分子（Fvis>=2 かつ Fres>=3: A,B）', n2.contNum, 2);
  check('2→3 継続率 = 2/3 ≒ 66.7%（旧バー比2/4=50%ではない）', n2.cont, 2 / 3, 1e-9);
}

// ============================================================================
// Fixture W — 店舗全体の予約ベース内訳(store.composition): 実績(new/v2/v3/v4)は
// newMix と一致し、見込み(expNew/expV2/expV3/expV4)は受付待ちの予約を加算する。
// スタッフ別 composition と同じロジックの店舗全体版（概要タブ「新規・再来」用）。
// ============================================================================
// C1: 5月に初回来店(new) → 6月に2回目来店(v2、実績)
// C2: 5月に初回来店(new) → 7月に2回目の予約が受付待ち(expV2、見込み)
// C3: 6月に初回来店(new)
h('■ Fixture W: 店舗全体の予約ベース内訳(composition)');
{
  const rows = [
    rec({ custKey: 'C1', date: '2026-05-01', kaikeiTotal: 6000 }),
    rec({ custKey: 'C1', date: '2026-06-01', kaikeiTotal: 6000 }),
    rec({ custKey: 'C2', date: '2026-05-02', kaikeiTotal: 6000 }),
    rec({ custKey: 'C2', status: '受付待ち', date: '2026-07-10', yoyakuTotal: 6000 }),
    rec({ custKey: 'C3', date: '2026-06-03', kaikeiTotal: 6000 })
  ];
  const R = engine.compute(rows, { asOf: '2026-07-03' });
  const may = R.store.composition.find(function (c) { return c.m === '2026-05'; });
  const jun = R.store.composition.find(function (c) { return c.m === '2026-06'; });
  const jul = R.store.composition.find(function (c) { return c.m === '2026-07'; });
  check('5月 new（実績: C1,C2）', may.new, 2);
  check('5月 v2〜v4・見込みは全て0', may.v2 + may.v3 + may.v4 + may.expNew + may.expV2 + may.expV3 + may.expV4, 0);
  check('6月 new（実績: C3）', jun.new, 1);
  check('6月 v2（実績: C1の2回目来店）', jun.v2, 1);
  check('7月 expV2（見込み: C2の2回目・受付待ち予約）', jul.expV2, 1);
  check('7月 new〜v4（実績）は全て0', jul.new + jul.v2 + jul.v3 + jul.v4, 0);
  var mismatch = R.store.composition.filter(function (c, i) {
    var n = R.store.newMix[i];
    return c.new !== n.new || c.v2 !== n.v2 || c.v3 !== n.v3 || c.v4 !== n.v4;
  });
  check('composition の実績値(new/v2/v3/v4)は全月 newMix と一致', mismatch.length, 0);
}

// ============================================================================
// Fixture Y — 取り込み診断(meta.statusBreakdown / unknownStatusRows)
// ============================================================================
// ステータスは既知5種の完全一致で判定され、それ以外は全指標から除外される。
// どの値が何件・認識可否つきで meta に出ることを固定（「シートは正しいのに
// 数値がおかしい」事故をデータタブで自己診断できるようにするための情報）。
// D/E は実際のエクスポート形式変更で起こり得る未知ラベルの例。
h('■ Fixture Y: 取り込み診断（ステータス内訳と未認識件数）');
{
  const rows = [
    rec({ custKey: 'A', date: '2026-05-01', kaikeiTotal: 6000 }),
    rec({ custKey: 'A', date: '2026-05-20', kaikeiTotal: 6000 }),
    rec({ custKey: 'B', status: '受付待ち', date: '2026-08-01', yoyakuTotal: 6000 }),  // 未来 → 見込み
    rec({ custKey: 'C', status: '受付待ち', date: '2026-04-01', yoyakuTotal: 6000 }),  // 基準日以前 → 滞留除外
    rec({ custKey: 'D', status: '受付済み', date: '2026-08-02', yoyakuTotal: 6000 }),  // 未知ラベル
    rec({ custKey: 'E', status: '来店待ち', date: '2026-08-03', yoyakuTotal: 6000 }),  // 未知ラベル
    rec({ custKey: 'E', status: '来店待ち', date: '2026-08-04', yoyakuTotal: 6000 }),
    rec({ custKey: 'F', status: 'お客様キャンセル', date: '2026-05-05' })
  ];
  const R = engine.compute(rows, { asOf: '2026-07-03' });
  const sb = R.meta.statusBreakdown;
  const by = {}; sb.forEach(function (b) { by[b.status] = b; });
  check('会計済み 2件・認識済み', by['会計済み'].count * (by['会計済み'].recognized ? 1 : 0), 2);
  check('受付待ち 2件・認識済み', by['受付待ち'].count * (by['受付待ち'].recognized ? 1 : 0), 2);
  check('来店待ち 2件・未認識', by['来店待ち'].count * (by['来店待ち'].recognized ? 0 : 1), 2);
  check('受付済み 1件・未認識', by['受付済み'].count * (by['受付済み'].recognized ? 0 : 1), 1);
  check('unknownStatusRows = 3（受付済み1+来店待ち2）', R.meta.unknownStatusRows, 3);
  check('未知ステータスは有効予約に入らない（見込みはBの1件のみ）', R.store.expectedFuture, 1);
  check('基準日以前の受付待ちは滞留として除外', R.store.staleExcluded, 1);
  check('件数降順ソート（先頭は2件の区分）', sb[0].count, 2);
}

console.log(`\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m${pass} pass\x1b[0m · \x1b[31m${fail} fail\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);
