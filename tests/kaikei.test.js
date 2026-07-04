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
// Fixture B — 45日成熟トリミング (P1-2): repeatRate/fixationRate/funnel/churn
// ============================================================================
// asOf = 2026-08-01. No future/waiting rows => completedOnly=true => maturity
// gate applies. M1/M2 first-visited 92 days before asOf (mature). N1/N2
// first-visited 7/12 days before asOf (immature) — excluded from the mature
// base entirely, regardless of whether they already repeated (N2 has 2 visits
// but must still be excluded because their FIRST visit hasn't matured).
h('■ Fixture B: 45日成熟トリミング（リピート率/固定化率）');
{
  const rows = [
    rec({ custKey: 'M1', date: '2026-05-01', kaikeiTotal: 5000 }),
    rec({ custKey: 'M1', date: '2026-05-15', kaikeiTotal: 5000 }),   // M1 repeats (mature, Fres=2)
    rec({ custKey: 'M2', date: '2026-05-01', kaikeiTotal: 5000 }),   // M2 no repeat (mature, Fres=1)
    rec({ custKey: 'N1', date: '2026-07-25', kaikeiTotal: 5000 }),   // immature, 7 days before asOf
    rec({ custKey: 'N2', date: '2026-07-20', kaikeiTotal: 5000 }),
    rec({ custKey: 'N2', date: '2026-07-28', kaikeiTotal: 5000 })    // N2 "repeats" but is still immature
  ];
  const R = engine.compute(rows, { asOf: '2026-08-01' });
  check('meta.completedOnly', R.meta.completedOnly ? 1 : 0, 1);
  check('maturity.applied', R.store.maturity.applied ? 1 : 0, 1);
  check('maturity.matureCustomers (M1,M2)', R.store.maturity.matureCustomers, 2);
  check('maturity.totalCustomers (全4顧客)', R.store.maturity.totalCustomers, 4);
  // repeatRate = mature customers with Fres>=2 (M1 only) / matureN(2) = 0.5 => ×100 = 50
  check('store.repeatRate (%)', R.store.repeatRate, 50, 0.05);
  check('store.fixationRate (%)', R.store.fixationRate, 0, 0.05);
  check('funnel[0].people (1回到達: 母数そのもの)', R.store.funnel[0].people, 2);
  check('funnel[1].people (2回到達: M1のみ)', R.store.funnel[1].people, 1);
  check('churn.base (成熟母数)', R.store.churn.base, 2);
  check('churn.total (Fres<2: M2のみ)', R.store.churn.total, 1);
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
  // spend is actual-only now: 25000/2 = 12500 (not blended with future money)
  check('monthly.spend (実績のみ)', m.spend, 12500);
}

// ============================================================================
// Fixture D — スタッフ平均の pooled 化 (P1-5): mean-of-months ではなく Σ分子/Σ分母
// ============================================================================
// Staff 'X': month A (2 visits, 1 got-next => 50%), month B (8 visits, 6 got-next
// => 75%). Mean-of-months would give (0.5+0.75)/2=0.625; pooled gives (1+6)/(2+8)=0.7.
// "Got next" is manufactured by giving those customers a later visit in 2026-08
// under a different staff ('Y') so it doesn't pollute X's own monthly counts.
// A dummy future row elsewhere sets hasFuture=true so month-maturity never gates
// this fixture (isolating the pooling behaviour from the P1-2 concern).
h('■ Fixture D: スタッフ平均の pooled 次回予約取得率');
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
  // pooled: (1+6)/(2+8) = 0.7 — NOT the mean-of-months 0.625
  check('avg.nextRes は pooled (0.7、単純平均0.625ではない)', x.avg.nextRes, 0.7);
}

// ============================================================================
// Fixture E (oracle) — サンプルデータの pooled 期待値を固定（P1-5 の回帰オラクル）
// ============================================================================
// store.retail / staff.avg.{spend,nextRes,nextRes2} have no ground-truth.json
// coverage (see tests/validate.js). These values were computed by the fixed
// engine against the bundled sample data at implementation time and are pinned
// here so a future regression is caught even without an external oracle.
h('■ Fixture E: サンプルデータの pooled 値を固定（回帰オラクル）');
{
  require(path.join(__dirname, '..', 'assets', 'js', 'sample-data.js'));
  const data = globalThis.KATE.SAMPLE_RESERVATIONS;
  const R = engine.compute(data, { asOf: '2026-07-03' });
  const momo = R.staff.find(s => s.name === 'momo');
  const aoi = R.staff.find(s => s.name === 'aoi');
  check('momo avg.spend', momo.avg.spend, 6071);
  check('momo avg.nextRes', momo.avg.nextRes, 0.5783898305084746, 1e-6);
  check('momo avg.nextRes2', momo.avg.nextRes2, 0.46715328467153283, 1e-6);
  check('aoi avg.spend', aoi.avg.spend, 6876);
  check('aoi avg.nextRes', aoi.avg.nextRes, 0.575, 1e-6);
  check('aoi avg.nextRes2', aoi.avg.nextRes2, 0.5, 1e-6);
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
  check('personalBest.retail.v（6月2件が最大）', p.personalBest.retail.v, 2);
  check('latestIsBest.retail（7月1件は6月未満→false）', p.personalBest.latestIsBest.retail ? 1 : 0, 0);

  check('cumulative.retailVisits', p.cumulative.retailVisits, 14);
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
  check('cumulative.retailVisits（店販データ皆無→null）', z.cumulative.retailVisits === null ? 1 : 0, 1);
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
  check('utilization 2月 capacity（28日×11h×60分）', feb.capacity, 28 * 11 * 60);
  check('utilization 2月 rate（150/18480）', feb.rate, 150 / (28 * 11 * 60), 1e-9);
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

console.log(`\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m${pass} pass\x1b[0m · \x1b[31m${fail} fail\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);
