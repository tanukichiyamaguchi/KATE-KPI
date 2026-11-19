/* 独立検算（クロスチェック）: 画面に出している主要KPIを、engine.js のコードを
 * 使わずに README の定義だけから書き直した別実装で再計算し、engine.compute() の
 * 出力と1円・1件単位で突き合わせる。税抜（taxRate 0.1）と税込（0）の両方で行う。
 * 片方の実装だけを直して数字が変わった場合、ここで必ず食い違いとして検出される。
 * 項目は2種類に分けて数える（SUMMARY に内訳を出す）:
 *  ・independent（独立検算）… 期待値を生の行から別実装で再計算した項目（eq）
 *  ・consistency（整合性）  … エンジンの出力どうしが一致するかだけを見る項目（consistent）。
 *                             期待値もエンジンの出力なので、独立検算の件数には入れない
 * Run: node tests/crosscheck.test.js */
'use strict';
const path = require('path');
const REPO = path.join(__dirname, '..');
require(path.join(REPO, 'assets/js/sample-data.js'));
const engine = require(path.join(REPO, 'assets/js/engine.js'));
const RAW = globalThis.KATE.SAMPLE_RESERVATIONS;
const AS_OF = '2026-07-03';

let fails = 0, passes = 0;
const failList = [];
const kinds = { independent: 0, consistency: 0 };   // 種類ごとの項目数（合格・不合格の合計）
function record(kind, label, got, want, tol) {
  tol = tol == null ? 1e-6 : tol;
  let ok;
  if (got === null || want === null || got === undefined || want === undefined) ok = got === want || (got == null && want == null);
  else if (typeof want === 'number') ok = Math.abs(got - want) <= tol;
  else ok = JSON.stringify(got) === JSON.stringify(want);
  kinds[kind]++;
  if (ok) passes++;
  else { fails++; failList.push((kind === 'consistency' ? '[consistency] ' : '') + label + '  engine=' + JSON.stringify(got) + (kind === 'consistency' ? '  engine(other)=' : '  independent=') + JSON.stringify(want)); }
}
// 独立検算: want は生の行から別実装で再計算した値
function eq(label, got, want, tol) { record('independent', label, got, want, tol); }
// 整合性: want もエンジンの出力（同じ値を別の経路で出しているかの確認）
function consistent(label, got, want, tol) { record('consistency', label, got, want, tol); }

function run(TAX) {
  const tx = v => (v == null ? 0 : (typeof v === 'number' && isFinite(v) ? v : 0)) / (1 + TAX);
  // ---- normalize (independent) ----
  const asOf = new Date(2026, 6, 3);
  const dayMs = 86400000;
  const recs = RAW.filter(r => r.status).map((r, i) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.date || '');
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    return {
      i, status: r.status, staff: r.staff || '—', route: r.route || '不明',
      d, ym: d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : null,
      key: r.custKey, name: r.name,
      kaikei: tx(r.kaikeiTotal), yoyaku: tx(r.yoyakuTotal), shohanAmt: tx(r.shohanAmount),
      hasRetail: !!(r.shohan && String(r.shohan).trim()) || (r.shohanAmount || 0) > 0,
      start: typeof r.start === 'number' ? r.start : null, dur: typeof r.dur === 'number' ? r.dur : null,
      menu: r.menu, coupon: r.coupon
    };
  });
  const isVis = r => r.status === '会計済み';
  const isWait = r => r.status === '受付待ち';
  const isCan = r => ['サロンキャンセル', 'お客様キャンセル', '無断キャンセル'].includes(r.status);
  const isFut = r => isWait(r) && r.d && r.d > asOf;
  const isEff = r => isVis(r) || isFut(r);
  const HPB = r => r.route === 'HOT PEPPER Beauty';

  const E = engine.compute(RAW, { asOf: AS_OF, taxRate: TAX });
  const S = E.store;
  const pre = `[tax=${TAX}] `;

  // months axis: first month of any dated row .. last effective date
  const months = E.meta.months;   // checked separately below
  const dated = recs.filter(r => r.d);
  const minD = new Date(Math.min(...dated.map(r => r.d)));
  const maxEffD = new Date(Math.max(...recs.filter(r => isEff(r) && r.d).map(r => r.d)));
  const mAxis = [];
  for (let d = new Date(minD.getFullYear(), minD.getMonth(), 1); d <= maxEffD; d.setMonth(d.getMonth() + 1)) mAxis.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  eq(pre + 'months axis', months, mAxis);

  // ---- revenue/counts ----
  const vis = recs.filter(isVis), fut = recs.filter(isFut);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const revA = sum(vis, r => r.kaikei), revE = sum(fut, r => r.yoyaku);
  eq(pre + 'revenueActual', S.revenueActual, revA, 1e-6);
  eq(pre + 'revenueExpected', S.revenueExpected, revE, 1e-6);
  eq(pre + 'revenueTotal', S.revenueTotal, revA + revE, 1e-6);
  eq(pre + 'actualVisits', S.actualVisits, vis.length);
  eq(pre + 'expectedFuture', S.expectedFuture, fut.length);
  eq(pre + 'effectiveReservations', S.effectiveReservations, vis.length + fut.length);
  eq(pre + 'staleExcluded', S.staleExcluded, recs.filter(r => isWait(r) && r.d && r.d <= asOf).length);
  eq(pre + 'avgSpendActual', S.avgSpendActual, Math.round(revA / vis.length));
  eq(pre + 'avgSpendReservation', S.avgSpendReservation, Math.round((revA + revE) / (vis.length + fut.length)));

  // ---- customers ----
  const byKey = new Map();
  recs.forEach(r => { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r); });
  const cust = [];
  byKey.forEach((rs, key) => {
    const v = rs.filter(r => isVis(r) && r.d).sort((a, b) => a.d - b.d);
    const e = rs.filter(r => isEff(r) && r.d).sort((a, b) => a.d - b.d);
    cust.push({ key, rs, v, e, Fvis: v.length, Fres: e.length, M: sum(v, r => r.kaikei), last: v.length ? v[v.length - 1].d : null });
  });
  const visited = cust.filter(c => c.Fvis > 0);
  const N = visited.length;
  eq(pre + 'customers', S.customers, N);
  const rep = visited.filter(c => c.Fres >= 2).length;
  eq(pre + 'repeatRate(%)', S.repeatRate, Math.round(rep / N * 1000) / 10);
  eq(pre + 'repeatNumer', S.repeatNumer, rep);
  const f2 = visited.filter(c => c.Fvis >= 2), f3 = f2.filter(c => c.Fres >= 3);
  eq(pre + 'fixDenom', S.fixDenom, f2.length); eq(pre + 'fixNumer', S.fixNumer, f3.length);
  eq(pre + 'fixationRate(%)', S.fixationRate, Math.round(f3.length / f2.length * 1000) / 10);
  // next reservation per visit
  const gotNext = r => byKey.get(r.key).some(x => isEff(x) && x.d && x.d > r.d);
  // 来店の順番: その顧客の有効な予約（会計済み＋これからの受付待ち）を日付順に並べた何番目か（同じ日は元の行の順）。1＝新規
  const ordOf = r => byKey.get(r.key).filter(x => isEff(x) && x.d).sort((a, b) => a.d - b.d || a.i - b.i).indexOf(r) + 1;
  const nextCnt = vis.filter(r => r.d && gotNext(r)).length;
  eq(pre + 'nextReserveNumer', S.nextReserveNumer, nextCnt);
  eq(pre + 'nextReserveRate(%)', S.nextReserveRate, Math.round(nextCnt / vis.length * 1000) / 10);
  // visit cycle median（README「来店周期」: 別の日の来店どうしの間隔。同じ日の2件目の0日は数えない）
  const gaps = [];
  visited.forEach(c => { for (let i = 1; i < c.v.length; i++) { const g = Math.round((c.v[i].d - c.v[i - 1].d) / dayMs); if (g > 0) gaps.push(g); } });
  gaps.sort((a, b) => a - b);
  const med = a => a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0;
  eq(pre + 'visitCycleMedianDays', S.visitCycleMedianDays, med(gaps));

  // funnel
  const maxFres = Math.max(...visited.map(c => c.Fres));
  const stages = Math.max(2, Math.min(10, maxFres));
  eq(pre + 'funnel stages', S.funnel.length, stages);
  for (let n = 1; n <= stages; n++) {
    const p = visited.filter(c => c.Fres >= n).length, nx = visited.filter(c => c.Fres >= n + 1).length;
    const f = S.funnel[n - 1];
    eq(pre + `funnel[${n}].people`, f.people, p);
    eq(pre + `funnel[${n}].reach`, f.reach, p / N);
    if (n < stages && p) eq(pre + `funnel[${n}].cont`, f.cont, nx / p);
    else eq(pre + `funnel[${n}].cont(null)`, f.cont, null);
  }
  // LTV
  const reachSum = [1, 2, 3, 4, 5].reduce((s, n) => s + visited.filter(c => c.Fres >= n).length / N, 0);
  eq(pre + 'ltv.current', S.ltv.current, Math.round(revA / N));
  eq(pre + 'ltv.predicted', S.ltv.predicted, Math.round(revA / vis.length * reachSum));
  eq(pre + 'ltv.expectedVisits', S.ltv.expectedVisits, Math.round(reachSum * 100) / 100);

  // cancellation (non-HPB)
  const conf = recs.filter(r => (isVis(r) || isCan(r)) && !HPB(r));
  const cc = { s: 0, c: 0, n: 0 };
  recs.forEach(r => { if (HPB(r)) return; if (r.status === 'サロンキャンセル') cc.s++; if (r.status === 'お客様キャンセル') cc.c++; if (r.status === '無断キャンセル') cc.n++; });
  eq(pre + 'cancel.confirmed', S.cancel.confirmed, conf.length);
  eq(pre + 'cancel.totalRate', S.cancel.totalRate, (cc.s + cc.c + cc.n) / conf.length);

  // monthly
  mAxis.forEach((mo, i) => {
    const mr = recs.filter(r => r.ym === mo);
    const v = mr.filter(isVis), f = mr.filter(isFut);
    const m = S.monthly[i];
    const ra = sum(v, r => r.kaikei), re = sum(f, r => r.yoyaku);
    eq(pre + mo + ' revActual', m.revActual, ra, 1e-6);
    eq(pre + mo + ' revExpected', m.revExpected, re, 1e-6);
    eq(pre + mo + ' res', m.res, v.length + f.length);
    eq(pre + mo + ' spend', m.spend, (v.length + f.length) ? Math.round((ra + re) / (v.length + f.length)) : 0);
    eq(pre + mo + ' spendActual', m.spendActual, v.length ? Math.round(ra / v.length) : null);
    const nc = v.filter(r => gotNext(r)).length;
    eq(pre + mo + ' nextRes', m.nextRes, v.length ? nc / v.length : null);
    // ordinal mix (by visit order among effective reservations — ordOf)
    const vc = [0, 0, 0, 0, 0], pc = [0, 0, 0, 0, 0];
    mr.filter(r => isEff(r) && r.d).forEach(r => { const o = Math.min(4, ordOf(r)); (isVis(r) ? vc : pc)[o]++; });
    const cp = S.composition[i];
    eq(pre + mo + ' comp', [cp.new, cp.v2, cp.v3, cp.v4, cp.expNew, cp.expV2, cp.expV3, cp.expV4], [vc[1], vc[2], vc[3], vc[4], pc[1], pc[2], pc[3], pc[4]]);
    const nm = S.newMix[i];
    eq(pre + mo + ' newMix', [nm.new, nm.v2, nm.v3, nm.v4], [vc[1], vc[2], vc[3], vc[4]]);
    // revenue mix new vs existing
    let na = 0, rA = 0, ne = 0, rE = 0;
    mr.forEach(r => { if (!(isEff(r) && r.d)) return; const isNew = ordOf(r) === 1; if (isVis(r)) { if (isNew) na += r.kaikei; else rA += r.kaikei; } else { if (isNew) ne += r.yoyaku; else rE += r.yoyaku; } });
    const rm = S.revenueMix[i];
    eq(pre + mo + ' revMix', [rm.newActual, rm.repeatActual, rm.newExpected, rm.repeatExpected].map(x => Math.round(x * 1000) / 1000), [na, rA, ne, rE].map(x => Math.round(x * 1000) / 1000));
  });

  // period buckets (store)
  const curYm = '2026-07', prevYm = '2026-06';
  const last3 = mAxis.filter(m => m < curYm).slice(-3);
  function bucket(rows, list) {
    const b = rows.filter(r => list.includes(r.ym));
    if (!b.length) return { monthly: null, daily: null };
    const rev = sum(b, r => r.kaikei);
    const mset = new Set(b.map(r => r.ym)), dset = new Set(b.filter(r => r.d).map(r => +r.d));
    return { monthly: Math.round(rev / mset.size), daily: Math.round(rev / dset.size) };
  }
  [['last3', last3], ['prevMonth', [prevYm]], ['currentMonth', [curYm]]].forEach(([k, l]) => {
    const want = bucket(vis, l);
    eq(pre + 'revPeriods.' + k + '.monthly', S.revPeriods[k].monthly, want.monthly);
    eq(pre + 'revPeriods.' + k + '.daily', S.revPeriods[k].daily, want.daily);
  });

  // retail
  const buyRows = vis.filter(r => r.hasRetail);
  const buyers = new Set(buyRows.map(r => r.key)).size, visCusts = new Set(vis.map(r => r.key)).size;
  eq(pre + 'retail.customerRatio', S.retail.customerRatio, buyers / visCusts);
  const amt = sum(buyRows, r => r.shohanAmt);
  eq(pre + 'retail.amount', S.retail.amount, amt, 1e-6);
  eq(pre + 'retail.avgSpend', S.retail.avgSpend, Math.round(amt / buyRows.length));
  eq(pre + 'retail.revenueRatio', S.retail.revenueRatio, amt / revA);

  // cohort (first visit month → reach2)
  mAxis.forEach(mo => {
    const g = visited.filter(c => c.v[0].ym === mo);
    const got = E.trend.monthlyCohort.find(x => x.m === mo);
    if (g.length < 5) { eq(pre + mo + ' cohort hidden', !!got, false); return; }
    eq(pre + mo + ' cohort.repeat', got && got.repeat, g.filter(c => c.Fres >= 2).length / g.length);
    eq(pre + mo + ' cohort.ltv', got && got.ltv, Math.round(sum(g, c => c.M) / g.length));
  });

  // visit-count breakdown
  const ob = { 1: [], 2: [], 3: [], 4: [] };
  visited.forEach(c => c.v.forEach((r, i) => ob[Math.min(4, i + 1)].push(r.kaikei)));
  [1, 2, 3, 4].forEach((k, i) => {
    eq(pre + 'visitCount[' + k + '].count', S.visitCountBreakdown[i].count, ob[k].length);
    eq(pre + 'visitCount[' + k + '].spend', S.visitCountBreakdown[i].spend, ob[k].length ? Math.round(sum(ob[k], x => x) / ob[k].length) : 0);
  });

  // day-of-week
  [1, 2, 3, 4, 5, 6, 0].forEach((dw, i) => {
    const v = vis.filter(r => r.d && r.d.getDay() === dw);
    const g = E.trend.dayOfWeek[i];
    eq(pre + 'dow' + dw + '.visits', g.visits, v.length);
    eq(pre + 'dow' + dw + '.spend', g.spend, v.length ? Math.round(sum(v, r => r.kaikei) / v.length) : 0);
    eq(pre + 'dow' + dw + '.nextRes', g.nextRes, v.length ? v.filter(gotNext).length / v.length : 0);
    const acq = visited.filter(c => c.v[0].d.getDay() === dw);
    eq(pre + 'dow' + dw + '.ltv', g.ltv, acq.length ? Math.round(sum(acq, c => c.M) / acq.length) : 0);
  });

  // RFM
  const rS = d => d <= 12 ? 5 : d <= 23 ? 4 : d <= 56 ? 3 : d <= 103 ? 2 : 1;
  const fS = f => Math.min(5, Math.max(1, f));
  const seg = (R, F) => F >= 5 ? (R >= 5 ? '最優良顧客' : R >= 3 ? '優良顧客' : '休眠顧客') : F === 4 ? (R >= 3 ? '高ロイヤル顧客' : '休眠顧客') : F === 3 ? (R >= 4 ? '安全顧客' : R >= 2 ? '要注意顧客' : '休眠顧客') : (R >= 4 ? '新規顧客' : R >= 2 ? '離反間近顧客' : '離脱顧客');
  const segCount = {};
  visited.forEach(c => { const R = Math.round((asOf - c.last) / dayMs); const s = seg(rS(R), fS(c.Fvis)); segCount[s] = (segCount[s] || 0) + 1; });
  E.rfm.segments.forEach(sg => eq(pre + 'rfm ' + sg.seg, sg.people, segCount[sg.seg] || 0));

  // ---- staff ----
  const staffNames = [...new Set(recs.filter(r => r.staff && r.staff !== '—').map(r => r.staff))];
  eq(pre + 'staff names', E.staff.map(s => s.name).sort(), staffNames.slice().sort());
  E.staff.forEach(st => {
    const nm = st.name;
    const P = pre + nm + ' ';
    mAxis.forEach((mo, i) => {
      const mr = recs.filter(r => r.staff === nm && r.ym === mo);
      const v = mr.filter(isVis), f = mr.filter(isFut);
      const m = st.monthly[i];
      const ra = sum(v, r => r.kaikei), rev = ra + sum(f, r => r.yoyaku);
      eq(P + mo + ' actual', m.actual, v.length);
      eq(P + mo + ' exp', m.exp, f.length);
      eq(P + mo + ' revActual', m.revActual, ra, 1e-6);
      eq(P + mo + ' rev', m.rev, rev, 1e-6);
      eq(P + mo + ' spend', m.spend, (v.length + f.length) ? Math.round(rev / (v.length + f.length)) : null);
      eq(P + mo + ' nextRes', m.nextRes, v.length ? v.filter(gotNext).length / v.length : null);
      eq(P + mo + ' retailAmount', m.retailAmount, v.some(r => r.shohanAmt > 0) ? sum(v.filter(r => r.hasRetail), r => r.shohanAmt) : null, 1e-6);
    });
    // store monthly == Σ staff monthly (all rows have a staff in the sample?)
    // acquisition: first-visit staff
    const acq = visited.filter(c => c.v[0].staff === nm);
    eq(P + 'acquired', st.acquired, acq.length);
    const acqRecent = acq.filter(c => last3.includes(c.v[0].ym));
    eq(P + 'reachDen(last3 cohort)', st.reachDen, acqRecent.length);
    eq(P + 'reach2', st.reach2, acqRecent.length ? acqRecent.filter(c => c.Fres >= 2).length / acqRecent.length : null);
    const sf2 = acqRecent.filter(c => c.Fvis >= 2), sf3 = sf2.filter(c => c.Fres >= 3);
    eq(P + 'fixDenom', st.fixDenom, sf2.length);
    eq(P + 'fixationRate', st.fixationRate, sf2.length ? sf3.length / sf2.length : null);
    eq(P + 'regulars3', st.regulars3, acq.filter(c => c.Fvis >= 2 && c.Fres >= 3).length);   // 2回来店＋3回目のご予約
    // last-3-month buckets for this staff
    const sv = vis.filter(r => r.staff === nm);
    [['last3', last3], ['prevMonth', [prevYm]], ['currentMonth', [curYm]]].forEach(([k, l]) => {
      const want = bucket(sv, l);
      eq(P + 'revPeriods.' + k + '.monthly', st.revPeriods[k].monthly, want.monthly);
      eq(P + 'revPeriods.' + k + '.daily', st.revPeriods[k].daily, want.daily);
    });
    // avgRecent (pooled over last3 months with visits)
    const recentM = last3.filter(mo => sv.some(r => r.ym === mo));
    const recRows = recs.filter(r => r.staff === nm && recentM.includes(r.ym));
    const rv = recRows.filter(isVis), rf = recRows.filter(isFut);
    eq(P + 'avgRecent.visitsPerMonth', st.avgRecent.visitsPerMonth, recentM.length ? Math.round(rv.length / recentM.length * 10) / 10 : 0);
    eq(P + 'avgRecent.spend', st.avgRecent.spend, (rv.length + rf.length) ? Math.round((sum(rv, r => r.kaikei) + sum(rf, r => r.yoyaku)) / (rv.length + rf.length)) : 0);
    eq(P + 'avgRecent.nextRes', st.avgRecent.nextRes, rv.length ? rv.filter(gotNext).length / rv.length : null);
    const rb = rv.filter(r => r.hasRetail);
    eq(P + 'avgRecent.retailCustomerRatio', st.avgRecent.retailCustomerRatio, new Set(rv.map(r => r.key)).size ? new Set(rb.map(r => r.key)).size / new Set(rv.map(r => r.key)).size : 0);
    // all-time pooled avg (as engine "avg")
    const actM = mAxis.filter(mo => sv.some(r => r.ym === mo));
    const aRows = recs.filter(r => r.staff === nm && actM.includes(r.ym));
    const av = aRows.filter(isVis), af = aRows.filter(isFut);
    eq(P + 'avg.visitsPerMonth', st.avg.visitsPerMonth, Math.round(av.length / actM.length * 10) / 10);
    eq(P + 'avg.spend', st.avg.spend, Math.round((sum(av, r => r.kaikei) + sum(af, r => r.yoyaku)) / (av.length + af.length)));
    eq(P + 'avg.nextRes', st.avg.nextRes, av.filter(gotNext).length / av.length);
    // utilization: Σdur / (visit days × 8h) for completed months < current month
    if (st.utilization) st.utilization.forEach((u, i) => {
      const mo = mAxis[i];
      const v = vis.filter(r => r.staff === nm && r.ym === mo);
      const days = new Set(v.filter(r => r.d).map(r => +r.d)).size;
      const mins = sum(v, r => r.dur || 0);
      eq(P + mo + ' util', u.rate, (mo < curYm && days > 0) ? mins / (days * 480) : null);
    });
  });

  // ---- 今月（月初〜基準日）／先月の同じ時期／先月（ホーム画面）--------------
  // 基準日 2026-07-03 → 今月＝7/1〜7/3、先月の同じ時期＝6/1〜6/3
  function mtd(match) {
    const inRange = (r, y, m, d1, d2) => r.d && r.d.getFullYear() === y && r.d.getMonth() === m && r.d.getDate() >= d1 && r.d.getDate() <= d2;
    function stats(v) {
      const rev = sum(v, r => r.kaikei);
      return { rev, visits: v.length, spend: v.length ? Math.round(rev / v.length) : null, newVisits: v.filter(r => ordOf(r) === 1).length, nextNum: v.filter(gotNext).length };
    }
    const cur = vis.filter(r => match(r) && inRange(r, 2026, 6, 1, 3));
    const same = vis.filter(r => match(r) && inRange(r, 2026, 5, 1, 3));
    const full = vis.filter(r => match(r) && inRange(r, 2026, 5, 1, 30));
    const booked = fut.filter(r => match(r) && inRange(r, 2026, 6, 4, 31));
    return { cur: stats(cur), prevSame: stats(same), prevFull: stats(full), bookedRev: sum(booked, r => r.yoyaku), bookedCount: booked.length };
  }
  function checkMonth(label, got, want) {
    ['cur', 'prevSame', 'prevFull'].forEach(k => {
      eq(pre + label + ' month.' + k + '.rev', got[k].rev, want[k].rev, 1e-6);
      eq(pre + label + ' month.' + k + '.visits', got[k].visits, want[k].visits);
      eq(pre + label + ' month.' + k + '.spend', got[k].spend, want[k].spend);
      eq(pre + label + ' month.' + k + '.newVisits', got[k].newVisits, want[k].newVisits);
      eq(pre + label + ' month.' + k + '.nextNum', got[k].nextNum, want[k].nextNum);
    });
    eq(pre + label + ' month.booked.rev', got.booked.rev, want.bookedRev, 1e-6);
    eq(pre + label + ' month.booked.count', got.booked.count, want.bookedCount);
    eq(pre + label + ' month.withBooked', got.withBooked, want.cur.rev + want.bookedRev, 1e-6);
    eq(pre + label + ' month.daily.cur[day]', got.daily.cur[2], want.cur.rev, 1e-6);
    eq(pre + label + ' month.daily.prev[end]', got.daily.prev[got.daily.prev.length - 1], want.prevFull.rev, 1e-6);
  }
  checkMonth('store', S.month, mtd(() => true));
  E.staff.forEach(st => checkMonth(st.name, st.month, mtd(r => r.staff === st.name)));

  // ---- 期間ごとの数字（お店・スタッフの「月ごとの数字」の表）: 直近3ヶ月・先月・今月 ----
  // README「月ごとの数字（お店・スタッフ）」「売上の月平均・1日あたり」の定義だけから、生の行で再計算する。
  //  ・すべて会計済み（実績）。直近3ヶ月＝今月を含まない確定3ヶ月（4〜6月）、先月＝6月まるごと、今月＝7/1〜基準日
  //  ・「/月」は来店のあった月数で割る（件数・人数は小数1桁、金額は1円に丸める）。1日あたりは営業日
  //    （その期間に1件でも会計があった日数）で割る。客単価＝売上÷来店件数（1円に丸める）
  //  ・新規＝その顧客の1回目の来店（ordOf）、店販売上＝店販金額の合計
  //  ・次回予約率＝その後の予約（これからの受付待ちを含む）がある来店÷来店。会計明細のみのデータでは直近の月の
  //    来店を「再来待ち」で除くが、サンプルは予約データ（これからの予約あり）なので除く来店はない（分母＝来店件数）
  if (!fut.length) throw new Error('期間ごとの数字の検算は、これからの予約がある予約データを前提にしています');
  function periodsOf(match) {
    function agg(inPeriod) {
      const v = vis.filter(r => r.d && match(r) && inPeriod(r));
      const rev = sum(v, r => r.kaikei), retail = sum(v, r => r.shohanAmt);
      const months = new Set(v.map(r => r.ym)).size, bizDays = new Set(v.map(r => +r.d)).size;
      const newVisits = v.filter(r => ordOf(r) === 1).length, nextNum = v.filter(gotNext).length;
      const perMonth = x => months ? Math.round(x / months * 10) / 10 : null;   // 件数・人数の月平均（小数1桁）
      const yenPerMonth = x => months ? Math.round(x / months) : null;          // 金額の月平均（1円）
      return {
        rev, visits: v.length, months, spend: v.length ? Math.round(rev / v.length) : null,
        newVisits, nextNum, nextDen: v.length, nextRate: v.length ? nextNum / v.length : null, nextCensored: false,
        retail, bizDays,
        revPerMonth: yenPerMonth(rev), visitsPerMonth: perMonth(v.length), newPerMonth: perMonth(newVisits),
        retailPerMonth: yenPerMonth(retail), revPerDay: bizDays ? Math.round(rev / bizDays) : null
      };
    }
    return { last3: agg(r => last3.includes(r.ym)), prev: agg(r => r.ym === prevYm), cur: agg(r => r.ym === curYm && r.d <= asOf) };
  }
  const PERIOD_FIELDS = ['rev', 'visits', 'months', 'spend', 'newVisits', 'nextNum', 'nextDen', 'nextRate', 'nextCensored',
    'retail', 'bizDays', 'revPerMonth', 'visitsPerMonth', 'newPerMonth', 'retailPerMonth', 'revPerDay'];
  function checkPeriods(label, got, want) {
    got = got || {};
    eq(pre + label + ' periods.last3Months', got.last3Months, last3);
    ['last3', 'prev', 'cur'].forEach(k => PERIOD_FIELDS.forEach(f => eq(pre + label + ' periods.' + k + '.' + f, (got[k] || {})[f], want[k][f])));
  }
  eq(pre + 'meta.last3Months', E.meta.last3Months, last3);
  checkPeriods('store', S.periods, periodsOf(() => true));
  E.staff.forEach(st => checkPeriods(st.name, st.periods, periodsOf(r => r.staff === st.name)));
  // 整合性（エンジンの出力どうし）: 直近3ヶ月の数字は、売上サマリー（revPeriods）・比較表（avgRecent）の直近3ヶ月の値と一致する
  E.staff.forEach(st => {
    consistent(pre + st.name + ' periods.last3.revPerMonth == revPeriods.last3.monthly', st.periods.last3.revPerMonth, st.revPeriods.last3.monthly);
    consistent(pre + st.name + ' periods.last3.visitsPerMonth == avgRecent', st.periods.last3.visitsPerMonth, st.avgRecent.visitsPerMonth);
    consistent(pre + st.name + ' periods.last3.spend == avgRecent.spend', st.periods.last3.spend, st.avgRecent.spend);
    consistent(pre + st.name + ' periods.last3.nextRate == avgRecent.nextRes', st.periods.last3.nextRate, st.avgRecent.nextRes);
  });
  consistent(pre + 'store periods.last3.revPerMonth == revPeriods', S.periods.last3.revPerMonth, S.revPeriods.last3.monthly);
  consistent(pre + 'store periods.last3.revPerDay == revPeriods', S.periods.last3.revPerDay, S.revPeriods.last3.daily);

  // ---- 呼び戻し対象＝周期超過かつ、これからの予約なし --------------------------
  const keysWithFuture = new Set(fut.map(r => r.key));
  let wantCallback = 0, wantOverdueBooked = 0;
  visited.forEach(c => {
    const R = Math.round((asOf - c.last) / dayMs);
    const own = [];
    for (let i = 1; i < c.v.length; i++) { const g = Math.round((c.v[i].d - c.v[i - 1].d) / dayMs); if (g > 0) own.push(g); }
    own.sort((a, b) => a - b);
    const cyc = own.length ? med(own) : med(gaps);
    const overdue = R > cyc * 1.5;
    if (overdue && !keysWithFuture.has(c.key)) wantCallback++;
    if (overdue && keysWithFuture.has(c.key)) wantOverdueBooked++;
  });
  eq(pre + 'rfm.callbackCount', E.rfm.callbackCount, wantCallback);
  eq(pre + 'rfm.overdueWithBooking', E.rfm.overdueWithBooking, wantOverdueBooked);
  eq(pre + 'rfm hasUpcoming count', E.rfm.customers.filter(c => c.hasUpcoming).length, visited.filter(c => keysWithFuture.has(c.key)).length);

  // 整合性（エンジンの出力どうし）: Σ スタッフの月次 == 店舗の月次（全行に担当スタッフがいるとき）
  const noStaff = recs.filter(r => !r.staff || r.staff === '—').length;
  if (!noStaff) mAxis.forEach((mo, i) => {
    consistent(pre + mo + ' Σstaff rev == store rev', E.staff.reduce((s, st) => s + st.monthly[i].rev, 0), S.monthly[i].rev, 1e-6);
    consistent(pre + mo + ' Σstaff res == store res', E.staff.reduce((s, st) => s + st.monthly[i].res, 0), S.monthly[i].res);
  });
  return E;
}

[0, 0.1].forEach(run);

// ---- 会計明細のみ（サンプルの会計済みの行だけ）: 次回予約率の「再来待ち」 ------------
// README「次回予約取得率」: これからの予約が無いデータでは、月末から30日経っていない月の来店は
// 分子・分母の両方から除く（全部除かれた期間は率なし＝再来待ち）。お店の月次も同じ。
// 予約込みの見込みは追跡できない（tracked=false）。次の一手は提案しない（censored）。
(function completedOnly() {
  const pre = '[会計明細のみ] ', dayMs = 86400000, asOf = new Date(2026, 6, 3);
  const rows = RAW.filter(r => r.status === '会計済み');
  const E = engine.compute(rows, { asOf: AS_OF, taxRate: 0.1 });
  const recs = rows.map((r, i) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.date || '');
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    return { i, staff: r.staff || '—', key: r.custKey, d, ym: d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : null };
  }).filter(r => r.d);
  const byKey = new Map();
  recs.forEach(r => { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r); });
  const gotNext = r => byKey.get(r.key).some(x => x.d > r.d);   // 予約が無いので「その後の来店」だけ
  const immature = ym => { const p = ym.split('-').map(Number); return Math.round((asOf - new Date(p[0], p[1], 0)) / dayMs) < 30; };
  const last3 = ['2026-04', '2026-05', '2026-06'], prevYm = '2026-06', curYm = '2026-07';
  eq(pre + 'meta.completedOnly', E.meta.completedOnly, true);
  eq(pre + 'meta.hasReservationRows', E.meta.hasReservationRows, false);
  eq(pre + 'store.month.booked.tracked', E.store.month.booked.tracked, false);
  eq(pre + 'meta.last3Months', E.meta.last3Months, last3);
  function nextOf(match, inPeriod) {
    const v = recs.filter(r => match(r) && inPeriod(r)), m = v.filter(r => !immature(r.ym)), num = m.filter(gotNext).length;
    return { nextNum: num, nextDen: m.length, nextRate: m.length ? num / m.length : null, nextCensored: m.length < v.length };
  }
  function checkNext(label, P, match) {
    const want = { last3: nextOf(match, r => last3.includes(r.ym)), prev: nextOf(match, r => r.ym === prevYm), cur: nextOf(match, r => r.ym === curYm && r.d <= asOf) };
    ['last3', 'prev', 'cur'].forEach(k => ['nextNum', 'nextDen', 'nextRate', 'nextCensored'].forEach(f => eq(pre + label + ' periods.' + k + '.' + f, P[k][f], want[k][f])));
  }
  checkNext('store', E.store.periods, () => true);
  E.staff.forEach(st => checkNext(st.name, st.periods, r => r.staff === st.name));
  // ホームの「今月」と「先月」（月全体）も同じ打ち切り
  const mWant = nextOf(() => true, r => r.ym === curYm && r.d <= asOf), pWant = nextOf(() => true, r => r.ym === prevYm);
  eq(pre + 'store.month.cur.nextRate', E.store.month.cur.nextRate, mWant.nextRate);
  eq(pre + 'store.month.cur.nextCensored', E.store.month.cur.nextCensored, mWant.nextCensored);
  eq(pre + 'store.month.prevFull.nextRate', E.store.month.prevFull.nextRate, pWant.nextRate);
  // お店全体の次回予約取得率（「リピート」のメーター）と曜日別の次回予約率も、打ち切りの月の来店を除く
  {
    const m = recs.filter(r => !immature(r.ym)), n = m.filter(gotNext).length;
    eq(pre + 'store.nextReserveNumer', E.store.nextReserveNumer, n);
    eq(pre + 'store.nextReserveDenom', E.store.nextReserveDenom, m.length);
    eq(pre + 'store.nextReserveRate(%)', E.store.nextReserveRate, Math.round(n / m.length * 1000) / 10);
    eq(pre + 'store.nextReserveCensored', E.store.nextReserveCensored, m.length < recs.length);
    const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
    [1, 2, 3, 4, 5, 6, 0].forEach((d, i) => {
      const v = recs.filter(r => r.d.getDay() === d), mv = v.filter(r => !immature(r.ym)), nv = mv.filter(gotNext).length;
      const got = E.trend.dayOfWeek[i];
      eq(pre + 'dayOfWeek ' + WEEK[d] + ' 来店数（全期間・除かない）', got.visits, v.length);
      eq(pre + 'dayOfWeek ' + WEEK[d] + ' nextRes', got.nextRes, mv.length ? nv / mv.length : (v.length ? null : 0));
      eq(pre + 'dayOfWeek ' + WEEK[d] + ' nextDen', got.nextDen, mv.length);
    });
  }
  // お店の月次の次回予約率: 打ち切りの月は null
  E.store.monthly.forEach(mo => {
    const v = recs.filter(r => r.ym === mo.m);
    eq(pre + mo.m + ' store.monthly.nextRes', mo.nextRes, immature(mo.m) || !v.length ? null : v.filter(gotNext).length / v.length);
  });
  E.staff.forEach(st => {
    // 整合性: 月ごとの数字の直近3ヶ月 == 比較表（avgRecent）の値（どちらも打ち切りの月を除く）
    consistent(pre + st.name + ' periods.last3.nextRate == avgRecent.nextRes', st.periods.last3.nextRate, st.avgRecent.nextRes);
    consistent(pre + st.name + ' periods.last3.nextDen == avgRecent.nextResDen', st.periods.last3.nextDen, st.avgRecent.nextResDen);
    eq(pre + st.name + ' growthFocus（提案しない）', st.growthFocus.reason, 'censored');
  });
})();
console.log('\n\x1b[1m■ 独立検算（エンジンとは別実装で再計算して突合・税込／税抜）\x1b[0m');
failList.forEach(f => console.log('  \x1b[31mFAIL\x1b[0m  ' + f));
// 内訳: independent＝独立検算（別実装で再計算した値との突合）、consistency＝エンジンの出力どうしの整合
console.log(`\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m${passes} pass\x1b[0m · \x1b[31m${fails} fail\x1b[0m  (independent ${kinds.independent} / consistency ${kinds.consistency})`);
process.exit(fails ? 1 : 0);
