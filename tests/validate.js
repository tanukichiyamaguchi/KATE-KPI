/* Validation: run the engine on the sample data and compare to the workbook's
 * published numbers (data/ground-truth.json). Run: node tests/validate.js
 * Small deltas are expected where the workbook excluded a single edge row. */
'use strict';
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'assets', 'js', 'sample-data.js'));
const engine = require(path.join(__dirname, '..', 'assets', 'js', 'engine.js'));
const gt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'ground-truth.json'), 'utf8'));

const data = globalThis.KATE.SAMPLE_RESERVATIONS;
const R = engine.compute(data, { asOf: '2026-07-03' });

let pass = 0, warn = 0, fail = 0;
function check(label, got, want, tol) {
  tol = tol == null ? 0 : tol;
  const okAbs = Math.abs(got - want) <= tol;
  const rel = want ? Math.abs(got - want) / Math.abs(want) : (got === want ? 0 : 1);
  const ok = okAbs || rel <= 0.02;              // within tol OR 2%
  const close = !ok && rel <= 0.05;             // within 5% => WARN
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : close ? '\x1b[33mWARN\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  if (ok) pass++; else if (close) warn++; else fail++;
  console.log(`  ${tag}  ${label.padEnd(42)} got=${fmt(got)}  want=${fmt(want)}`);
}
function info(label, got, want) {
  console.log(`  \x1b[36mINFO\x1b[0m  ${label.padEnd(42)} got=${fmt(got)}  want=${fmt(want)}`);
}
function fmt(v) { return typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3)) : v; }
function h(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

const s = R.store, g = gt.store;
h('■ 店舗全体 KGI');
check('予約ベース売上', s.revenueTotal, g.revenueTotal);
check('  実績（会計済み）', s.revenueActual, g.revenueActual);
check('  見込み（受付待ち）', s.revenueExpected, g.revenueExpected);
check('有効予約数', s.effectiveReservations, g.effectiveReservations, 2);
check('実績来店', s.actualVisits, g.actualVisits, 2);
check('見込み予約', s.expectedFuture, g.expectedFuture, 1);
check('予約ベース客単価', s.avgSpendReservation, g.avgSpendReservation, 30);
check('実績客単価', s.avgSpendActual, g.avgSpendActual, 30);
check('母数(来店顧客)', s.customers, 358, 2);

h('■ リピート・定着');
check('リピート率(2回到達)%', s.repeatRate, g.repeatRate, 1);
// 固定化率は「全顧客に対する3回到達率」から「2回到達した顧客のうち3回目も
// 予約した割合」という条件付き継続率に定義変更（ユーザー確認済み）。ワーク
// ブックの旧定義値とは別の意味の数値になったため、ground-truthとの突合は
// 行わない。info行として新定義の値を参考表示する。
info('  固定化率(3回以上・条件付き継続率／旧定義との比較不可)', s.fixationRate, g.fixationRate);
check('次回予約取得率%', s.nextReserveRate, g.nextReserveRate, 3);
check('来店周期(中央値・日)', s.visitCycleMedianDays, g.visitCycleMedianDays, 3);
g.funnel.forEach((f, i) => check(`到達 ${f.n}回 人数`, s.funnel[i].people, f.people, 1));

h('■ 離脱・キャンセル');
check('離脱顧客', s.churn.total, g.churn.total, 2);
check('  キャンセルで停止', s.churn.cancelStopped, g.churn.cancelStopped, 8);
check('  次回予約なし', s.churn.noNextReserve, g.churn.noNextReserve, 8);
// Cancellation now EXCLUDES HOT PEPPER Beauty per store policy → intentionally
// differs from the workbook GT (which counted all routes). Assert the post-policy
// figures for regression safety; show the old GT for reference.
check('確定予約(非HPB)', s.cancel.confirmed, 304, 2);
check('総キャンセル率(非HPB)', s.cancel.totalRate, 0.385, 0.02);
info('  旧・全経路込み 総キャンセル率(参考)', s.cancel.totalRate, g.cancel.totalRate);
info('  お客様/サロン/無断 (非HPB)', s.cancel.customer + s.cancel.salon + s.cancel.noShow, 0.385);
info('初回来店なし (footnote·定義差)', s.cancel.firstNoVisit, g.cancel.firstNoVisit);

h('■ LTV');
check('現状LTV', s.ltv.current, g.ltv.current, 100);
check('観測平均来店回数', s.ltv.observedVisits, g.ltv.observedVisits, 0.05);

h('■ 月次推移（予約数）');
g.monthly.forEach((m, i) => check(`${m.m} 予約数`, s.monthly[i].res, m.res, 2));
h('■ 月次推移（売上）');
g.monthly.forEach((m, i) => check(`${m.m} 予約ベース売上`, s.monthly[i].rev, m.rev, 2000));

h('■ コホート 2回到達率');
g.cohort.forEach((c, i) => { const mine = s.cohort.find(x => x.m === c.m); if (mine) check(`${c.m} 2回到達率`, mine.reach2, c.reach2, 0.03); });
// 集計基準日を含む月（2026-07）も予約ベースで測定できるため含める（オーナー要望）。
// partial フラグでUI側が「※集計途中」と表示する。母数5人未満の月のみ除外。
const cur = s.cohort.find(x => x.m === '2026-07');
check('集計途中の当月(2026-07)もコホートに含める', cur ? 1 : 0, 1);
check('当月には partial フラグが立つ', cur && cur.partial ? 1 : 0, 1);
check('完了月に partial フラグは立たない', s.cohort.some(x => x.m !== '2026-07' && x.partial) ? 1 : 0, 0);

h('■ 来店回数別');
g.visitCountBreakdown.forEach((b, i) => check(b.label + ' 件数', s.visitCountBreakdown[i].count, b.count, 2));

h('■ 各スタッフ');
// reach2 (2回到達率) is intentionally NOT cross-checked against the workbook here:
// the workbook's published value uses the old 45-day-maturity, all-time definition,
// while the engine now computes a reservation-based (cancel-aware), last-3-months-
// cohort rate by user request — the two are no longer the same metric. See
// tests/kaikei.test.js Fixture B for the hand-verified new-methodology coverage.
gt.staff.repeat.forEach(sr => {
  const mine = R.staff.find(x => x.name === sr.name);
  if (mine) { check(`${sr.name} 獲得顧客`, mine.acquired, sr.acquired, 3); }
});

h('■ 曜日別');
gt.trend.dayOfWeek.forEach(d => {
  const mine = R.trend.dayOfWeek.find(x => x.d === d.d);
  if (mine) check(`${d.d}曜 来店数`, mine.visits, d.visits, 2);
});

h('■ RFM セグメント人数');
gt.rfm.segments.forEach(seg => {
  const mine = R.rfm.segments.find(x => x.seg === seg.seg);
  if (mine) check(seg.seg, mine.people, seg.people, 1);
});

h('■ 配信キャッシュ');
// index.html の資産URLに付けたバージョンが package.json とずれると、利用者の
// 端末が古い app.js を使い続け、直したはずの不具合が「まだ直っていない」ように
// 見える。ずれを必ず検知する（リリース時にスタンプを更新し忘れないため）。
{
  const fs2 = require('fs'), path2 = require('path');
  const root = path2.join(__dirname, '..');
  const ver = JSON.parse(fs2.readFileSync(path2.join(root, 'package.json'), 'utf8')).version;
  const html = fs2.readFileSync(path2.join(root, 'index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(assets\/(?:js|css)\/[^"]+)"/g)].map(m => m[1]);
  const stamped = assets.filter(a => a.indexOf('?v=' + ver) !== -1);
  check('資産URLにバージョンを付けている', assets.length > 0, true, 0);
  check('全ての資産URLが package.json と同じバージョン', stamped.length, assets.length, 0);
}

console.log(`\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m${pass} pass\x1b[0m · \x1b[33m${warn} warn\x1b[0m · \x1b[31m${fail} fail\x1b[0m`);
console.log(`RFM segment total people = ${R.rfm.total} (expect 358)`);
process.exit(fail > 0 ? 1 : 0);
