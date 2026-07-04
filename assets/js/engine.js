/* ============================================================================
 * KATE-KPI · Analytics Engine
 * ----------------------------------------------------------------------------
 * Pure, dependency-free reservation analytics. Consumes an array of normalized
 * reservation records (see ingest.js for the 予約データ → record mapping) and
 * returns a fully-computed analytics model that mirrors the KPI dashboards.
 *
 * Every definition below was reverse-engineered from, and validated against,
 * the source KPI workbook (店舗全体 / 各スタッフ / 傾向分析 / RFM分析). Where the
 * workbook excluded a single edge row, this engine computes directly from the
 * raw data, so a handful of derived averages may differ by well under 1%.
 *
 * Dual-mode: attaches to window.KATE.engine in the browser and exports via
 * module.exports under Node (for the validation test in tests/).
 * ==========================================================================*/
(function (global) {
  'use strict';

  var VISITED = '会計済み';        // completed / checked-out (an actual visit)
  var WAITING = '受付待ち';        // upcoming, not yet visited
  var CANCELS = { 'サロンキャンセル': 'salon', 'お客様キャンセル': 'customer', '無断キャンセル': 'noShow' };
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  // ---- small helpers --------------------------------------------------------
  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    var s = String(v).trim();
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    if (/^\d{8}$/.test(s)) return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }
  function ym(d) { return d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') : null; }
  function dayDiff(a, b) { return Math.round((a - b) / 86400000); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function round(v, p) { var f = Math.pow(10, p || 0); return Math.round(v * f) / f; }
  function groupBy(arr, keyFn) {
    var map = {};
    arr.forEach(function (x) { var k = keyFn(x); (map[k] = map[k] || []).push(x); });
    return map;
  }
  function monthsBetween(start, end) {
    var out = [], d = new Date(start.getFullYear(), start.getMonth(), 1);
    while (d <= end) { out.push(ym(d)); d.setMonth(d.getMonth() + 1); }
    return out;
  }

  // ---- RFM scoring (exact bands from the workbook) --------------------------
  function rScore(days) { return days <= 12 ? 5 : days <= 23 ? 4 : days <= 56 ? 3 : days <= 103 ? 2 : 1; }
  function fScore(visits) { return Math.min(5, Math.max(1, visits)); }
  function mScore(yen) { return yen >= 12700 ? 5 : yen >= 7970 ? 4 : yen >= 6550 ? 3 : yen >= 4200 ? 2 : 1; }

  // 9-segment classification purely from (R点, F点). Reproduces the workbook's
  // populated cells exactly; empty cells (優良/休眠) fall out naturally.
  var SEGMENTS = [
    { key: '最優良顧客', label: '最優良顧客', en: 'VIP', action: 'VIP維持・特別優遇で関係を最大化' },
    { key: '高ロイヤル顧客', label: '高ロイヤル顧客', en: 'Loyal', action: '継続来店・アップセルで単価向上' },
    { key: '優良顧客', label: '優良顧客', en: 'Promising', action: '再来を促し最優良へ引き上げ' },
    { key: '安全顧客', label: '安全顧客', en: 'Stable', action: '次回予約を徹底し定着を確実に' },
    { key: '要注意顧客', label: '要注意顧客', en: 'At risk', action: '離反前にフォロー・特典で再来促進' },
    { key: '新規顧客', label: '新規顧客', en: 'New', action: '2回目特典で早期リピート化' },
    { key: '離反間近顧客', label: '離反間近顧客', en: 'About to churn', action: 'リマインド・再来オファーで引き戻し' },
    { key: '休眠顧客', label: '休眠顧客', en: 'Dormant', action: '復帰クーポンで掘り起こし' },
    { key: '離脱顧客', label: '離脱顧客', en: 'Lost', action: '再アプローチ（優先度低）' }
  ];
  function segment(R, F) {
    if (F >= 5) return R >= 5 ? '最優良顧客' : R >= 3 ? '優良顧客' : '休眠顧客';
    if (F === 4) return R >= 3 ? '高ロイヤル顧客' : '休眠顧客';
    if (F === 3) return R >= 4 ? '安全顧客' : R >= 2 ? '要注意顧客' : '休眠顧客';
    // F <= 2
    return R >= 4 ? '新規顧客' : R >= 2 ? '離反間近顧客' : '離脱顧客';
  }

  // ---- main compute ---------------------------------------------------------
  function compute(raw, options) {
    options = options || {};
    // Normalize + enrich each record
    var rows = raw.map(function (r) {
      var d = parseDate(r.date);
      return {
        status: r.status, staff: r.staff || '—', shimei: r.shimei,
        date: d, ym: ym(d), dow: d ? d.getDay() : null,
        route: r.route || '不明', pay: r.pay,
        menuCat: r.menuCat, menu: r.menu, coupon: r.coupon, couponCat: r.couponCat,
        name: r.name || '(無名)', gender: r.gender, first: r.first,
        custKey: r.custKey || (r.name || '') + '|' + (r.phone || ''),
        yoyaku: num(r.yoyakuTotal), planned: num(r.payPlanned), kaikei: num(r.kaikeiTotal),
        isVisited: r.status === VISITED,
        isWaiting: r.status === WAITING,
        isCancel: r.status in CANCELS,
        cancelType: CANCELS[r.status] || null
      };
    }).filter(function (r) { return r.status; });

    // As-of date = latest actual visit (the dataset's "now"), overridable.
    var visitedDates = rows.filter(function (r) { return r.isVisited && r.date; }).map(function (r) { return r.date; });
    var asOf = options.asOf ? parseDate(options.asOf) : (visitedDates.length ? new Date(Math.max.apply(null, visitedDates)) : new Date());

    rows.forEach(function (r) {
      r.isFuture = r.isWaiting && r.date && r.date > asOf;   // upcoming booking (見込み)
      r.isStale = r.isWaiting && r.date && r.date <= asOf;   //未処理で滞留
      r.isEffective = r.isVisited || r.isFuture;             // reservation-based valid
      r.isConfirmed = r.isVisited || r.isCancel;             // for cancel-rate denominators
    });

    // Analysis period from data (guard degenerate datasets with no parseable dates)
    var allDates = rows.filter(function (r) { return r.date; }).map(function (r) { return r.date; });
    if (!allDates.length) allDates = [asOf];
    var minD = new Date(Math.min.apply(null, allDates));
    var maxEff = rows.filter(function (r) { return r.isEffective && r.date; }).map(function (r) { return r.date; });
    var maxD = new Date(Math.max.apply(null, maxEff.length ? maxEff : allDates));
    var months = monthsBetween(new Date(minD.getFullYear(), minD.getMonth(), 1), maxD);

    // ---- Customer aggregation ----------------------------------------------
    var byCust = groupBy(rows, function (r) { return r.custKey; });
    var customers = Object.keys(byCust).map(function (key) {
      var recs = byCust[key];
      var eff = recs.filter(function (r) { return r.isEffective && r.date; }).sort(function (a, b) { return a.date - b.date; });
      var visits = recs.filter(function (r) { return r.isVisited && r.date; }).sort(function (a, b) { return a.date - b.date; });
      var cancels = recs.filter(function (r) { return r.isCancel && r.date; });
      var M = visits.reduce(function (s, r) { return s + r.kaikei; }, 0);
      var lastVisit = visits.length ? visits[visits.length - 1].date : null;
      var firstEff = eff.length ? eff[0] : null;
      var firstVisit = visits.length ? visits[0] : null;
      var R = lastVisit ? Math.max(0, dayDiff(asOf, lastVisit)) : null;
      var name = (visits[0] || eff[0] || recs[0]).name;
      return {
        key: key, name: name,
        Fres: eff.length,            // reservation-based frequency (visits + future bookings)
        Fvis: visits.length,          // actual visits (RFM frequency)
        M: M,
        R: R,
        lastVisit: lastVisit,
        firstEffDate: firstEff ? firstEff.date : null,
        firstEffMonth: firstEff ? firstEff.ym : null,
        firstVisitMonth: firstVisit ? firstVisit.ym : null,
        firstVisitStaff: firstVisit ? firstVisit.staff : (firstEff ? firstEff.staff : null),
        firstVisitDow: firstVisit ? firstVisit.dow : null,
        firstCoupon: firstEff ? (firstEff.coupon || null) : null,
        hasAnyCancel: cancels.length > 0,
        hasVisit: visits.length > 0
      };
    });
    var visitedCusts = customers.filter(function (c) { return c.hasVisit; });
    var baseN = visitedCusts.length;

    // ---- Store: revenue & counts -------------------------------------------
    var visitedRows = rows.filter(function (r) { return r.isVisited; });
    var futureRows = rows.filter(function (r) { return r.isFuture; });
    var revenueActual = visitedRows.reduce(function (s, r) { return s + r.kaikei; }, 0);
    var revenueExpected = futureRows.reduce(function (s, r) { return s + r.yoyaku; }, 0);
    var actualVisits = visitedRows.length;
    var expectedFuture = futureRows.length;
    var effectiveReservations = actualVisits + expectedFuture;

    // ---- Retention funnel (reservation-based, base = visited customers) -----
    var funnel = [1, 2, 3, 4, 5].map(function (n) {
      var people = visitedCusts.filter(function (c) { return c.Fres >= n; }).length;
      return { n: n, people: people, reach: baseN ? people / baseN : 0 };
    });
    var repeatRate = baseN ? funnel[1].people / baseN : 0;
    var fixationRate = baseN ? funnel[2].people / baseN : 0;

    // ---- Next-reservation rate (per visit) ----------------------------------
    // A visit "secured a next reservation" if the customer has any later effective reservation.
    var nextByCust = {};
    customers.forEach(function (c) {
      var eff = byCust[c.key].filter(function (r) { return r.isEffective && r.date; }).map(function (r) { return r.date; }).sort(function (a, b) { return a - b; });
      nextByCust[c.key] = eff;
    });
    function visitGotNext(r) {
      var eff = nextByCust[r.custKey]; if (!eff) return false;
      return eff.some(function (d) { return d > r.date; });
    }
    var nextReserveCount = visitedRows.filter(function (r) { return r.date && visitGotNext(r); }).length;
    var nextReserveRate = actualVisits ? nextReserveCount / actualVisits : 0;

    // ---- Visit cycle (median gap between consecutive visits) ----------------
    var gaps = [];
    visitedCusts.forEach(function (c) {
      var v = byCust[c.key].filter(function (r) { return r.isVisited && r.date; }).map(function (r) { return r.date; }).sort(function (a, b) { return a - b; });
      for (var i = 1; i < v.length; i++) gaps.push(dayDiff(v[i], v[i - 1]));
    });
    var visitCycleMedianDays = median(gaps);

    // ---- Churn (visited customers with no next effective reservation) -------
    var churned = visitedCusts.filter(function (c) { return c.Fres < 2; });
    var cancelStopped = churned.filter(function (c) { return c.hasAnyCancel; }).length;
    var churn = { total: churned.length, cancelStopped: cancelStopped, noNextReserve: churned.length - cancelStopped, base: baseN };

    // ---- Cancellation -------------------------------------------------------
    var confirmed = rows.filter(function (r) { return r.isConfirmed; });
    var cancelCounts = { salon: 0, customer: 0, noShow: 0 };
    rows.forEach(function (r) { if (r.cancelType) cancelCounts[r.cancelType]++; });
    var totalCancel = cancelCounts.salon + cancelCounts.customer + cancelCounts.noShow;
    var firstNoVisit = customers.filter(function (c) { return !c.hasVisit && byCust[c.key].some(function (r) { return r.isCancel; }); }).length;
    var cancel = {
      confirmed: confirmed.length,
      totalRate: confirmed.length ? totalCancel / confirmed.length : 0,
      customer: confirmed.length ? cancelCounts.customer / confirmed.length : 0,
      salon: confirmed.length ? cancelCounts.salon / confirmed.length : 0,
      noShow: confirmed.length ? cancelCounts.noShow / confirmed.length : 0,
      customerCount: cancelCounts.customer, salonCount: cancelCounts.salon, noShowCount: cancelCounts.noShow,
      firstNoVisit: firstNoVisit
    };

    // ---- Route analysis -----------------------------------------------------
    var byRoute = groupBy(rows, function (r) { return r.route; });
    var route = Object.keys(byRoute).map(function (name) {
      var rr = byRoute[name];
      var eff = rr.filter(function (r) { return r.isEffective; }).length;
      var conf = rr.filter(function (r) { return r.isConfirmed; }).length;
      var canc = rr.filter(function (r) { return r.isCancel; }).length;
      return { name: name, eff: eff, cancel: conf ? canc / conf : 0, total: rr.length };
    }).sort(function (a, b) { return b.eff - a.eff; });

    // ---- LTV ----------------------------------------------------------------
    var avgSpendActual = actualVisits ? revenueActual / actualVisits : 0;
    var expectedVisits = funnel.reduce(function (s, f) { return s + f.reach; }, 0);
    var ltv = {
      current: baseN ? revenueActual / baseN : 0,
      observedVisits: baseN ? actualVisits / baseN : 0,
      expectedVisits: expectedVisits,
      predicted: avgSpendActual * expectedVisits
    };

    // ---- Monthly trend ------------------------------------------------------
    var newByMonth = {};
    customers.forEach(function (c) { if (c.firstEffMonth) newByMonth[c.firstEffMonth] = (newByMonth[c.firstEffMonth] || 0) + 1; });
    var monthly = months.map(function (mo) {
      var mrows = rows.filter(function (r) { return r.ym === mo; });
      var vis = mrows.filter(function (r) { return r.isVisited; });
      var fut = mrows.filter(function (r) { return r.isFuture; });
      var conf = mrows.filter(function (r) { return r.isConfirmed; });
      var canc = mrows.filter(function (r) { return r.isCancel; });
      var rev = vis.reduce(function (s, r) { return s + r.kaikei; }, 0) + fut.reduce(function (s, r) { return s + r.yoyaku; }, 0);
      var res = vis.length + fut.length;
      var nextCnt = vis.filter(function (r) { return r.date && visitGotNext(r); }).length;
      return {
        m: mo, res: res, actual: vis.length, exp: fut.length, rev: rev,
        spend: res ? Math.round(rev / res) : 0,
        new: newByMonth[mo] || 0,
        cancel: conf.length ? canc.length / conf.length : null,
        nextRes: vis.length ? nextCnt / vis.length : null
      };
    });

    // ---- Cohort (first-visit month → 2nd-visit reach) -----------------------
    var byCohort = groupBy(visitedCusts.filter(function (c) { return c.firstVisitMonth; }), function (c) { return c.firstVisitMonth; });
    var cohort = months.map(function (mo) {
      var g = byCohort[mo] || [];
      if (!g.length) return null;
      var reach2 = g.filter(function (c) { return c.Fres >= 2; }).length / g.length;
      return { m: mo, n: g.length, reach2: reach2 };
    }).filter(Boolean);

    // ---- Visit-count breakdown (ordinal visit → count + avg spend) ----------
    var ordBuckets = { 1: [], 2: [], 3: [], 4: [] };
    visitedCusts.forEach(function (c) {
      var v = byCust[c.key].filter(function (r) { return r.isVisited && r.date; }).sort(function (a, b) { return a.date - b.date; });
      v.forEach(function (r, i) { ordBuckets[Math.min(4, i + 1)].push(r.kaikei); });
    });
    var ordLabels = { 1: '1回目（新規）', 2: '2回目', 3: '3回目', 4: '4回目以上' };
    var visitCountBreakdown = [1, 2, 3, 4].map(function (k) {
      var b = ordBuckets[k];
      return { label: ordLabels[k], count: b.length, spend: b.length ? Math.round(b.reduce(function (s, x) { return s + x; }, 0) / b.length) : 0 };
    });

    // ---- Staff --------------------------------------------------------------
    var staffNames = Object.keys(groupBy(rows.filter(function (r) { return r.staff && r.staff !== '—'; }), function (r) { return r.staff; }));
    function staffMonthly(name) {
      return months.map(function (mo) {
        var mr = rows.filter(function (r) { return r.staff === name && r.ym === mo; });
        var vis = mr.filter(function (r) { return r.isVisited; });
        var fut = mr.filter(function (r) { return r.isFuture; });
        var conf = mr.filter(function (r) { return r.isConfirmed; });
        var canc = mr.filter(function (r) { return r.isCancel && r.custKey && custHasVisit(r.custKey); });
        var confVisitors = conf.filter(function (r) { return r.isVisited || custHasVisit(r.custKey); });
        var rev = vis.reduce(function (s, r) { return s + r.kaikei; }, 0) + fut.reduce(function (s, r) { return s + r.yoyaku; }, 0);
        var res = vis.length + fut.length;
        var newN = customers.filter(function (c) { return c.firstVisitStaff === name && c.firstVisitMonth === mo; }).length;
        var nextCnt = vis.filter(function (r) { return r.date && visitGotNext(r); }).length;
        return {
          m: mo, res: res, actual: vis.length, exp: fut.length, rev: rev,
          spend: vis.length ? Math.round(rev / res || 0) : (res ? Math.round(rev / res) : 0),
          new: newN,
          cancel: confVisitors.length ? canc.length / confVisitors.length : null,
          nextRes: vis.length ? nextCnt / vis.length : null
        };
      });
    }
    var custVisitSet = {};
    visitedCusts.forEach(function (c) { custVisitSet[c.key] = true; });
    function custHasVisit(k) { return !!custVisitSet[k]; }

    var staff = staffNames.map(function (name) {
      var mrows = staffMonthly(name);
      var active = mrows.filter(function (r) { return r.actual > 0; });
      var acq = customers.filter(function (c) { return c.firstVisitStaff === name && c.hasVisit; });
      function reach(n) { return acq.length ? acq.filter(function (c) { return c.Fres >= n; }).length / acq.length : 0; }
      var avg = {
        months: active.length,
        visitsPerMonth: active.length ? round(active.reduce(function (s, r) { return s + r.actual; }, 0) / active.length, 1) : 0,
        revPerMonth: active.length ? Math.round(active.reduce(function (s, r) { return s + r.rev; }, 0) / active.length) : 0,
        spend: (function () { var v = active.reduce(function (s, r) { return s + r.actual; }, 0); var rv = active.reduce(function (s, r) { return s + r.rev; }, 0); return v ? Math.round(rv / v) : 0; })(),
        newPerMonth: active.length ? round(active.reduce(function (s, r) { return s + r.new; }, 0) / active.length, 1) : 0,
        cancel: (function () { var c = active.filter(function (r) { return r.cancel != null; }); return c.length ? c.reduce(function (s, r) { return s + r.cancel; }, 0) / c.length : 0; })(),
        nextRes: (function () { var c = active.filter(function (r) { return r.nextRes != null; }); return c.length ? c.reduce(function (s, r) { return s + r.nextRes; }, 0) / c.length : 0; })()
      };
      // visit-count composition per month
      var comp = mrows.map(function (r, i) {
        var mo = r.m;
        var counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
        rows.filter(function (x) { return x.staff === name && x.ym === mo && x.isVisited && x.date; }).forEach(function (x) {
          var v = byCust[x.custKey].filter(function (y) { return y.isVisited && y.date; }).sort(function (a, b) { return a.date - b.date; });
          var idx = v.indexOf(x);
          counts[Math.min(4, idx + 1)]++;
        });
        return { m: mo, new: counts[1], v2: counts[2], v3: counts[3], v4: counts[4] };
      });
      return { name: name, avg: avg, acquired: acq.length, reach2: reach(2), reach3: reach(3), reach4: reach(4), monthly: mrows, composition: comp };
    });

    // ---- Trend: day-of-week -------------------------------------------------
    var byDow = {};
    for (var i = 1; i <= 6; i++) byDow[i] = [];
    byDow[0] = [];
    var dayOfWeek = [1, 2, 3, 4, 5, 6, 0].map(function (d) {
      var vis = visitedRows.filter(function (r) { return r.dow === d && r.date; });
      var nextCnt = vis.filter(function (r) { return visitGotNext(r); }).length;
      var spend = vis.length ? Math.round(vis.reduce(function (s, r) { return s + r.kaikei; }, 0) / vis.length) : 0;
      var acqOnDay = visitedCusts.filter(function (c) { return c.firstVisitDow === d; });
      var ltvDay = acqOnDay.length ? Math.round(acqOnDay.reduce(function (s, c) { return s + c.M; }, 0) / acqOnDay.length) : 0;
      return { d: WEEK[d], visits: vis.length, nextRes: vis.length ? nextCnt / vis.length : 0, spend: spend, ltv: ltvDay };
    });

    // ---- Trend: monthly cohort (repeat + LTV) -------------------------------
    var monthlyCohort = months.map(function (mo) {
      var g = byCohort[mo] || [];
      if (!g.length) return null;
      return { m: mo, n: g.length, repeat: g.filter(function (c) { return c.Fres >= 2; }).length / g.length, ltv: Math.round(g.reduce(function (s, c) { return s + c.M; }, 0) / g.length) };
    }).filter(Boolean);

    // ---- Trend: coupons -----------------------------------------------------
    var byCoupon = groupBy(visitedCusts.filter(function (c) { return c.firstCoupon; }), function (c) { return c.firstCoupon; });
    var coupons = Object.keys(byCoupon).map(function (cp) {
      var g = byCoupon[cp];
      return { coupon: cp, n: g.length, repeat: g.filter(function (c) { return c.Fres >= 2; }).length / g.length, ltv: Math.round(g.reduce(function (s, c) { return s + c.M; }, 0) / g.length) };
    }).sort(function (a, b) { return b.n - a.n; }).slice(0, 12);

    // ---- RFM ----------------------------------------------------------------
    var rfmCusts = visitedCusts.map(function (c) {
      var Rp = rScore(c.R), Fp = fScore(c.Fvis), Mp = mScore(c.M);
      return { name: c.name, R: c.R, F: c.Fvis, M: c.M, Rp: Rp, Fp: Fp, Mp: Mp, seg: segment(Rp, Fp) };
    }).sort(function (a, b) { return b.M - a.M; });

    var segTotals = {};
    SEGMENTS.forEach(function (s) { segTotals[s.key] = { people: 0, rSum: 0, fSum: 0, mSum: 0 }; });
    rfmCusts.forEach(function (c) { var t = segTotals[c.seg]; t.people++; t.rSum += c.R; t.fSum += c.F; t.mSum += c.M; });
    var rfmTotal = rfmCusts.length;
    var segments = SEGMENTS.map(function (s) {
      var t = segTotals[s.key];
      return {
        seg: s.key, label: s.label, en: s.en, action: s.action, people: t.people,
        ratio: rfmTotal ? t.people / rfmTotal : 0,
        r: t.people ? round(t.rSum / t.people, 1) : 0,
        f: t.people ? round(t.fSum / t.people, 1) : 0,
        m: t.people ? Math.round(t.mSum / t.people) : 0
      };
    });
    // F×R map: rows F5..F1, cols R1..R5
    var map = [5, 4, 3, 2, 1].map(function (F) {
      return [1, 2, 3, 4, 5].map(function (R) {
        return rfmCusts.filter(function (c) { return c.Fp === F && c.Rp === R; }).length;
      });
    });

    return {
      meta: {
        asOf: ym(asOf) === null ? null : asOf.toISOString().slice(0, 10),
        periodStart: months[0], periodEnd: months[months.length - 1],
        months: months, staffNames: staffNames,
        totalRows: rows.length, generatedAt: options.now || null
      },
      store: {
        revenueTotal: revenueActual + revenueExpected, revenueActual: revenueActual, revenueExpected: revenueExpected,
        effectiveReservations: effectiveReservations, actualVisits: actualVisits, expectedFuture: expectedFuture,
        staleExcluded: rows.filter(function (r) { return r.isStale; }).length,
        avgSpendReservation: effectiveReservations ? Math.round((revenueActual + revenueExpected) / effectiveReservations) : 0,
        avgSpendActual: Math.round(avgSpendActual),
        customers: baseN,
        repeatRate: round(repeatRate * 100, 1), fixationRate: round(fixationRate * 100, 1),
        nextReserveRate: round(nextReserveRate * 100, 1), visitCycleMedianDays: visitCycleMedianDays,
        funnel: funnel, churn: churn, cancel: cancel, route: route,
        ltv: { current: Math.round(ltv.current), predicted: Math.round(ltv.predicted), expectedVisits: round(ltv.expectedVisits, 2), observedVisits: round(ltv.observedVisits, 2) },
        monthly: monthly, cohort: cohort, visitCountBreakdown: visitCountBreakdown
      },
      staff: staff,
      trend: { dayOfWeek: dayOfWeek, monthlyCohort: monthlyCohort, coupons: coupons },
      rfm: { total: rfmTotal, segments: segments, map: map, customers: rfmCusts },
      _segmentsMeta: SEGMENTS
    };
  }

  var api = { compute: compute, SEGMENTS: SEGMENTS, _helpers: { parseDate: parseDate, rScore: rScore, fScore: fScore, mScore: mScore, segment: segment } };
  global.KATE = global.KATE || {};
  global.KATE.engine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
