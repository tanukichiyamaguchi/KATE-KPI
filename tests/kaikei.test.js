/* Regression tests for the Phase-1 calculation fixes (会計明細 / retail-ratio /
 * maturity-trimming / pooled staff averages). Fixtures are small and hand-verified
 * in the comments below — each expected value is computed by hand, not derived
 * from the implementation. Run: node tests/kaikei.test.js */
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

console.log(`\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m${pass} pass\x1b[0m · \x1b[31m${fail} fail\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);
