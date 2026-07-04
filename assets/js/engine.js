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
  var HPB_ROUTE = 'HOT PEPPER Beauty';
  function isHPB(r) { return r.route === HPB_ROUTE; }   // excluded from cancel-rate math

  // ---- small helpers --------------------------------------------------------
  // Build a Date only if the components are a real, in-range calendar date within
  // a sane year band. Rejects overflow (month 13, day 32) and wild years so one bad
  // row can't blow up the month axis.
  function mkDate(y, mo, day) {
    if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || day < 1 || day > 31) return null;
    var d = new Date(y, mo - 1, day);
    return (d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === day) ? d : null;
  }
  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    var s = String(v).trim();
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return mkDate(+m[1], +m[2], +m[3]);
    if (/^\d{8}$/.test(s)) return mkDate(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }
  function maxDate(arr) { return arr.reduce(function (m, d) { return d > m ? d : m; }); }
  function minDate(arr) { return arr.reduce(function (m, d) { return d < m ? d : m; }); }
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
        start: typeof r.start === 'number' && isFinite(r.start) ? r.start : null,
        dur: typeof r.dur === 'number' && isFinite(r.dur) ? r.dur : null,
        yoyaku: num(r.yoyakuTotal), planned: num(r.payPlanned), kaikei: num(r.kaikeiTotal),
        shohan: r.shohan || null, shohanAmt: num(r.shohanAmount),
        hasRetail: !!(r.shohan && String(r.shohan).trim()) || num(r.shohanAmount) > 0,
        isVisited: r.status === VISITED,
        isWaiting: r.status === WAITING,
        isCancel: r.status in CANCELS,
        cancelType: CANCELS[r.status] || null,
        _ord: 0
      };
    }).filter(function (r) { return r.status; });

    // As-of date = latest actual visit (the dataset's "now"), overridable.
    var visitedDates = rows.filter(function (r) { return r.isVisited && r.date; }).map(function (r) { return r.date; });
    var asOf = (options.asOf && parseDate(options.asOf)) || (visitedDates.length ? maxDate(visitedDates) : new Date());

    rows.forEach(function (r) {
      r.isFuture = r.isWaiting && r.date && r.date > asOf;   // upcoming booking (見込み)
      r.isStale = r.isWaiting && r.date && r.date <= asOf;   //未処理で滞留
      r.isEffective = r.isVisited || r.isFuture;             // reservation-based valid
      r.isConfirmed = r.isVisited || r.isCancel;             // for cancel-rate denominators
    });

    // Analysis period from data (guard degenerate datasets with no parseable dates)
    var allDates = rows.filter(function (r) { return r.date; }).map(function (r) { return r.date; });
    if (!allDates.length) allDates = [asOf];
    var minD = minDate(allDates);
    var maxEff = rows.filter(function (r) { return r.isEffective && r.date; }).map(function (r) { return r.date; });
    var maxD = maxDate(maxEff.length ? maxEff : allDates);
    var months = monthsBetween(new Date(minD.getFullYear(), minD.getMonth(), 1), maxD);
    if (months.length > 240) months = months.slice(-240);   // belt-and-suspenders cap

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
        firstVisitDate: firstVisit ? firstVisit.date : null,
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

    // Tag each visited reservation with the customer's visit ordinal (1st, 2nd, …)
    visitedCusts.forEach(function (c) {
      byCust[c.key].filter(function (r) { return r.isVisited && r.date; }).sort(function (a, b) { return a.date - b.date; })
        .forEach(function (r, i) { r._ord = i + 1; });
    });

    // ---- Store: revenue & counts -------------------------------------------
    var visitedRows = rows.filter(function (r) { return r.isVisited; });
    var futureRows = rows.filter(function (r) { return r.isFuture; });
    // When the source has upcoming reservations (予約データ), a recent visit's
    // "next reservation" is already knowable. When it does NOT (会計明細 = completed
    // checkouts only), recent months are right-censored: not enough time has passed
    // for the follow-up visit to appear, so those months' next-reservation rates are
    // meaningless and get trimmed from the trend below.
    var hasFuture = futureRows.length > 0;
    var MATURITY_DAYS = 30;
    function monthImmatureBy(mo, days) {
      if (hasFuture) return false;                 // future data → no censoring
      var p = mo.split('-'); var end = new Date(+p[0], +p[1], 0);   // last day of month
      return dayDiff(asOf, end) < days;
    }
    function monthImmature(mo) { return monthImmatureBy(mo, MATURITY_DAYS); }

    // Repeat/retention metrics need a *customer*-level maturity gate, distinct from
    // the month-level one above: a customer whose first visit was only a few days
    // ago hasn't had time to come back, so counting them as "not yet repeated"
    // understates the true rate. Only matters for completed-checkout sources
    // (no future rows) — 予約データ already knows about upcoming bookings.
    var REPEAT_MATURITY_DAYS = 45;
    function custMature(c) {
      if (hasFuture) return true;
      return !!(c.firstVisitDate && dayDiff(asOf, c.firstVisitDate) >= REPEAT_MATURITY_DAYS);
    }
    var matureCusts = visitedCusts.filter(custMature);
    var matureN = matureCusts.length;

    var revenueActual = visitedRows.reduce(function (s, r) { return s + r.kaikei; }, 0);
    var revenueExpected = futureRows.reduce(function (s, r) { return s + r.yoyaku; }, 0);
    var actualVisits = visitedRows.length;
    var expectedFuture = futureRows.length;
    var effectiveReservations = actualVisits + expectedFuture;

    // ---- 店販 (retail / product sales) -------------------------------------
    // Amount metrics require a 会計時店販金額 column; buyer ratio works from the
    // product name alone. `retailStats` is reused for the whole store and per staff.
    function uniqCount(arr, keyFn) {
      var seen = {}, n = 0;
      arr.forEach(function (x) { var k = keyFn(x); if (!seen[k]) { seen[k] = 1; n++; } });
      return n;
    }
    function retailStats(vRows) {
      var buyingRows = vRows.filter(function (r) { return r.hasRetail; });
      var buyingVisits = buyingRows.length;
      var amt = buyingRows.reduce(function (s, r) { return s + r.shohanAmt; }, 0);
      var hasAmount = vRows.some(function (r) { return r.shohanAmt > 0; });
      var rev = vRows.reduce(function (s, r) { return s + r.kaikei; }, 0);
      var buyers = uniqCount(buyingRows, function (r) { return r.custKey; });      // 店販購入顧客（人）
      var visitCustomers = uniqCount(vRows, function (r) { return r.custKey; });   // 来店顧客（人）
      return {
        buyers: buyers,
        visitCustomers: visitCustomers,
        buyingVisits: buyingVisits,
        customerRatio: visitCustomers ? buyers / visitCustomers : 0,   // 店販顧客比率（人ベース）
        attachRate: vRows.length ? buyingVisits / vRows.length : 0,     // 店販付帯率（会計ベース）
        hasAmount: hasAmount,
        amount: hasAmount ? amt : null,                                  // 店販金額
        revenueRatio: hasAmount && rev ? amt / rev : null,               // 店販売上比率
        avgSpend: hasAmount && buyingVisits ? Math.round(amt / buyingVisits) : null  // 店販単価（会計ベース）
      };
    }
    var retail = retailStats(visitedRows);

    // ---- Retention funnel (reservation-based, base = mature visited customers) -
    // Base is `matureCusts`, not all visited customers: for completed-checkout
    // sources a very recent first-timer hasn't had time to repeat, so including
    // them would understate every rate below (see custMature above).
    var funnel = [1, 2, 3, 4, 5].map(function (n) {
      var people = matureCusts.filter(function (c) { return c.Fres >= n; }).length;
      return { n: n, people: people, reach: matureN ? people / matureN : 0 };
    });
    var repeatRate = matureN ? funnel[1].people / matureN : 0;
    var fixationRate = matureN ? funnel[2].people / matureN : 0;

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
    // Also keep each customer's OWN median gap (for the M27 callback list below) —
    // a customer with only one visit ever has no gap of their own, so they fall
    // back to the store-wide median.
    var gaps = [], custOwnCycle = {};
    visitedCusts.forEach(function (c) {
      var v = byCust[c.key].filter(function (r) { return r.isVisited && r.date; }).map(function (r) { return r.date; }).sort(function (a, b) { return a - b; });
      var ownGaps = [];
      for (var i = 1; i < v.length; i++) { var g = dayDiff(v[i], v[i - 1]); gaps.push(g); ownGaps.push(g); }
      custOwnCycle[c.key] = ownGaps.length ? median(ownGaps) : null;
    });
    var visitCycleMedianDays = median(gaps);

    // ---- Churn (mature visited customers with no next effective reservation) -
    var churned = matureCusts.filter(function (c) { return c.Fres < 2; });
    var cancelStopped = churned.filter(function (c) { return c.hasAnyCancel; }).length;
    var churn = { total: churned.length, cancelStopped: cancelStopped, noNextReserve: churned.length - cancelStopped, base: matureN };

    // ---- Cancellation (HOT PEPPER Beauty excluded per store policy) ----------
    // The salon can't control HPB-side cancellations, so HPB reservations are
    // excluded from every cancellation-rate numerator AND denominator.
    var confirmed = rows.filter(function (r) { return r.isConfirmed && !isHPB(r); });
    var cancelCounts = { salon: 0, customer: 0, noShow: 0 };
    rows.forEach(function (r) { if (r.cancelType && !isHPB(r)) cancelCounts[r.cancelType]++; });
    var totalCancel = cancelCounts.salon + cancelCounts.customer + cancelCounts.noShow;
    var firstNoVisit = customers.filter(function (c) { return !c.hasVisit && byCust[c.key].some(function (r) { return r.isCancel; }); }).length;
    var cancel = {
      confirmed: confirmed.length,
      totalRate: confirmed.length ? totalCancel / confirmed.length : 0,
      customer: confirmed.length ? cancelCounts.customer / confirmed.length : 0,
      salon: confirmed.length ? cancelCounts.salon / confirmed.length : 0,
      noShow: confirmed.length ? cancelCounts.noShow / confirmed.length : 0,
      customerCount: cancelCounts.customer, salonCount: cancelCounts.salon, noShowCount: cancelCounts.noShow,
      firstNoVisit: firstNoVisit,
      // POS/会計明細 sources record only completed checkouts — no cancellation or
      // upcoming-reservation rows — so a 0% rate there means "not tracked", not "zero".
      hasInfo: rows.some(function (r) { return r.isCancel || r.isWaiting; })
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
      var conf = mrows.filter(function (r) { return r.isConfirmed && !isHPB(r); });
      var canc = mrows.filter(function (r) { return r.isCancel && !isHPB(r); });
      var revActual = vis.reduce(function (s, r) { return s + r.kaikei; }, 0);
      var revExpected = fut.reduce(function (s, r) { return s + r.yoyaku; }, 0);
      var res = vis.length + fut.length;
      var nextCnt = vis.filter(function (r) { return r.date && visitGotNext(r); }).length;
      return {
        m: mo, res: res, actual: vis.length, exp: fut.length, rev: revActual + revExpected,
        revActual: revActual, revExpected: revExpected,
        spend: vis.length ? Math.round(revActual / vis.length) : 0,   // 実績客単価のみ（0来店月は0＝スパークライン安全）
        new: newByMonth[mo] || 0,
        cancel: conf.length ? canc.length / conf.length : null,
        nextRes: vis.length ? nextCnt / vis.length : null
      };
    });

    // ---- 新規/再来ミックス月次 (M19) ------------------------------------------
    // Per-VISIT ordinal (not the customer's first-*effective*-month binning used
    // by `monthly.new` above), so a customer whose very first interaction was a
    // future booking doesn't get miscounted as "new" in some other month.
    var newMix = months.map(function (mo) {
      var vis = visitedRows.filter(function (r) { return r.ym === mo; });
      var newN = vis.filter(function (r) { return r._ord === 1; }).length;
      return { m: mo, new: newN, repeat: vis.length - newN };
    });

    // ---- Cohort (first-visit month → 2nd-visit reach) -----------------------
    // A cohort month whose customers haven't yet had 45 days to return is dropped
    // (completed-checkout sources only) rather than shown as a misleadingly low bar.
    var byCohort = groupBy(visitedCusts.filter(function (c) { return c.firstVisitMonth; }), function (c) { return c.firstVisitMonth; });
    var cohort = months.map(function (mo) {
      var g = byCohort[mo] || [];
      if (!g.length || monthImmatureBy(mo, REPEAT_MATURITY_DAYS)) return null;
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
        var canc = mr.filter(function (r) { return r.isCancel && !isHPB(r) && r.custKey && custHasVisit(r.custKey); });
        var confVisitors = conf.filter(function (r) { return (r.isVisited || custHasVisit(r.custKey)) && !isHPB(r); });
        var revActual = vis.reduce(function (s, r) { return s + r.kaikei; }, 0);
        var rev = revActual + fut.reduce(function (s, r) { return s + r.yoyaku; }, 0);
        var res = vis.length + fut.length;
        var newN = customers.filter(function (c) { return c.firstVisitStaff === name && c.firstVisitMonth === mo; }).length;
        var nextCnt = vis.filter(function (r) { return r.date && visitGotNext(r); }).length;
        var vis2 = vis.filter(function (r) { return r._ord === 2; });
        var next2 = vis2.filter(function (r) { return visitGotNext(r); }).length;
        var rst = retailStats(vis);
        var immature = monthImmature(mo);          // right-censored recent month → not measurable
        return {
          m: mo, res: res, actual: vis.length, exp: fut.length, rev: rev, revActual: revActual,
          spend: vis.length ? Math.round(revActual / vis.length) : null,   // 実績客単価のみ（将来予約金額は含めない）
          new: newN,
          cancel: confVisitors.length ? canc.length / confVisitors.length : null,
          cancelCnt: canc.length, cancelDen: confVisitors.length,
          nextRes: immature || !vis.length ? null : nextCnt / vis.length,
          nextRes2: immature || !vis2.length ? null : next2 / vis2.length,   // 2回目来店の次回予約取得率
          nextCnt: nextCnt, visN: vis.length, next2Cnt: next2, vis2N: vis2.length,
          nextResImmature: immature,
          retailRatio: rst.attachRate, retailAmount: rst.amount, retailBuyers: rst.buyers,
          retailBuyingVisits: rst.buyingVisits,
          durMin: vis.reduce(function (s, r) { return s + (r.dur || 0); }, 0)
        };
      });
    }
    var custVisitSet = {};
    visitedCusts.forEach(function (c) { custVisitSet[c.key] = true; });
    function custHasVisit(k) { return !!custVisitSet[k]; }

    // ---- スタッフ稼働率 (M26・P4-4・予約データ限定) -----------------------------
    // Σ施術時間(分) ÷ 営業可能時間（9:00-20:00固定・将来設定化）。会計明細には
    // 所要時間が無いため、dur を一件も持たないデータセットでは算出しない。
    var anyDur = visitedRows.some(function (r) { return r.dur != null; });
    var OPERATING_HOURS = 11;   // 9:00-20:00
    function daysInMonth(mo) { var p = mo.split('-'); return new Date(+p[0], +p[1], 0).getDate(); }
    function utilizationMonthly(mrows) {
      return anyDur ? mrows.map(function (r) {
        var capacity = daysInMonth(r.m) * OPERATING_HOURS * 60;
        return { m: r.m, minutes: r.durMin, capacity: capacity, rate: capacity ? r.durMin / capacity : 0 };
      }) : null;
    }

    // Whether this dataset has any 店販 signal at all — gates whether the
    // corresponding personal-best/milestone fields below are numbers or null
    // (a salon that never records retail sales shouldn't show a false "0件").
    var anyRetail = visitedRows.some(function (r) { return r.hasRetail; });
    var currentYm = ym(asOf);   // the in-progress month — excluded from personal-best comparisons

    var staff = staffNames.map(function (name) {
      var mrows = staffMonthly(name);
      var active = mrows.filter(function (r) { return r.actual > 0; });
      // `acqAll` is the headline "獲得顧客" count (never right-censored); `acqMature`
      // is the maturity-gated subset used for the reach2/3/4 denominators so a wave
      // of very recent first-timers doesn't drag those rates down artificially.
      var acqAll = customers.filter(function (c) { return c.firstVisitStaff === name && c.hasVisit; });
      var acqMature = acqAll.filter(custMature);
      // null (not 0) when there's no mature base yet — a brand-new staff hasn't
      // "failed" to retain anyone, there just hasn't been time to find out.
      function reach(n) { return acqMature.length ? acqMature.filter(function (c) { return c.Fres >= n; }).length / acqMature.length : null; }
      var mature = active.filter(function (r) { return !r.nextResImmature; });
      var avg = {
        months: active.length,
        visitsPerMonth: active.length ? round(active.reduce(function (s, r) { return s + r.actual; }, 0) / active.length, 1) : 0,
        revPerMonth: active.length ? Math.round(active.reduce(function (s, r) { return s + r.rev; }, 0) / active.length) : 0,
        spend: (function () { var v = active.reduce(function (s, r) { return s + r.actual; }, 0); var rv = active.reduce(function (s, r) { return s + r.revActual; }, 0); return v ? Math.round(rv / v) : 0; })(),
        newPerMonth: active.length ? round(active.reduce(function (s, r) { return s + r.new; }, 0) / active.length, 1) : 0,
        cancel: (function () { var num = active.reduce(function (s, r) { return s + r.cancelCnt; }, 0); var den = active.reduce(function (s, r) { return s + r.cancelDen; }, 0); return den ? num / den : 0; })(),
        nextRes: (function () { var num = mature.reduce(function (s, r) { return s + r.nextCnt; }, 0); var den = mature.reduce(function (s, r) { return s + r.visN; }, 0); return den ? num / den : null; })(),
        nextRes2: (function () { var num = mature.reduce(function (s, r) { return s + r.next2Cnt; }, 0); var den = mature.reduce(function (s, r) { return s + r.vis2N; }, 0); return den ? num / den : null; })(),
        // Denominators for the min-N gate on 次の一手 (P3-4) — Σ mature-month visits,
        // not months, since a candidate needs enough *visits* behind it to be trustworthy.
        nextResN: mature.reduce(function (s, r) { return s + r.visN; }, 0),
        nextRes2N: mature.reduce(function (s, r) { return s + r.vis2N; }, 0)
      };
      var staffVis = rows.filter(function (r) { return r.staff === name && r.isVisited; });
      var retail = retailStats(staffVis);
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
      // ---- Self-growth (Phase 3): 自己ベスト・累計マイルストーン・育てた常連 --------
      // "Confirmed" months exclude the in-progress current month, so a half-finished
      // month can't either set or block a personal-best record.
      var confirmedActive = active.filter(function (r) { return r.m !== currentYm; });
      function pickBest(list, valueFn) {
        var best = null;
        list.forEach(function (r) { var v = valueFn(r); if (best === null || v > best.v) best = { v: v, m: r.m }; });
        return best;
      }
      // True only on a *strict* new record set in the most recent confirmed month
      // (a tie doesn't count — B-review A3: ties shouldn't earn the "record" pill).
      function isLatestBest(list, valueFn) {
        if (list.length < 2) return false;
        var lastV = valueFn(list[list.length - 1]);
        return list.slice(0, -1).every(function (r) { return valueFn(r) < lastV; });
      }
      var personalBest = {
        confirmedMonths: confirmedActive.length,
        visits: pickBest(confirmedActive, function (r) { return r.actual; }),
        rev: pickBest(confirmedActive, function (r) { return r.revActual; }),
        spend: pickBest(confirmedActive, function (r) { return r.spend || 0; }),
        retail: anyRetail ? pickBest(confirmedActive, function (r) { return r.retailBuyingVisits; }) : null,
        latestIsBest: {
          visits: isLatestBest(confirmedActive, function (r) { return r.actual; }),
          rev: isLatestBest(confirmedActive, function (r) { return r.revActual; }),
          spend: isLatestBest(confirmedActive, function (r) { return r.spend || 0; }),
          retail: anyRetail && isLatestBest(confirmedActive, function (r) { return r.retailBuyingVisits; })
        }
      };
      var cumulative = {
        retailVisits: anyRetail ? mrows.reduce(function (s, r) { return s + r.retailBuyingVisits; }, 0) : null
      };
      // 育てた常連: customers this staff first served who went on to become mature
      // regulars (Fres>=3), using the same 45-day maturity gate as store-level fixation.
      var regulars3 = matureCusts.filter(function (c) { return c.firstVisitStaff === name && c.Fres >= 3; }).length;

      return {
        name: name, avg: avg, acquired: acqAll.length, matureAcquired: acqMature.length,
        reach2: reach(2), reach3: reach(3), reach4: reach(4), retail: retail, monthly: mrows, composition: comp,
        personalBest: personalBest, cumulative: cumulative, regulars3: regulars3,
        utilization: utilizationMonthly(mrows)
      };
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

    // ---- Trend: 人気メニュー・クーポン依存度 (M20 準備) -------------------------
    var byMenu = groupBy(visitedRows.filter(function (r) { return r.menu; }), function (r) { return r.menu; });
    var menuTop = Object.keys(byMenu).map(function (name) {
      var g = byMenu[name];
      return { menu: name, n: g.length, amount: g.reduce(function (s, r) { return s + r.kaikei; }, 0) };
    }).sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
    var nextResMenuVisits = visitedRows.filter(function (r) { return r.menu && r.menu.indexOf('次回予約') !== -1; }).length;
    var nextResMenuRatio = visitedRows.length ? nextResMenuVisits / visitedRows.length : null;
    var couponedVisits = visitedRows.filter(function (r) { return r.coupon && String(r.coupon).trim(); }).length;
    var couponRatio = visitedRows.length ? couponedVisits / visitedRows.length : null;

    // ---- 施術/店販 月次金額分解 (M20) ------------------------------------------
    // serviceAmt = kaikeiTotal - shohanAmt (every line item is already summed into
    // kaikeiTotal, retail included, so no separate raw field is needed).
    var serviceRetailMonthly = retail.hasAmount ? months.map(function (mo) {
      var vis = visitedRows.filter(function (r) { return r.ym === mo; });
      var retailAmt = vis.reduce(function (s, r) { return s + r.shohanAmt; }, 0);
      var total = vis.reduce(function (s, r) { return s + r.kaikei; }, 0);
      return { m: mo, service: Math.round(total - retailAmt), retail: Math.round(retailAmt) };
    }) : null;

    // ---- Trend: 時間帯×曜日 ヒートマップ (P4-3) --------------------------------
    // Hour from `start` (yoyaku: reservation start HHMM; kaikei-only: checkout
    // time HHMM — see ingest.js fromKaikei). Clamped to the observed 9-20 band
    // rather than silently dropped, so no visit goes missing from the map.
    var HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    function clampHour(h) { return h < 9 ? 9 : h > 20 ? 20 : h; }
    var hourDow = [1, 2, 3, 4, 5, 6, 0].map(function (d) {
      return HOURS.map(function (h) {
        return visitedRows.filter(function (r) { return r.dow === d && r.start != null && clampHour(Math.floor(r.start / 100)) === h; }).length;
      });
    });

    // ---- RFM ----------------------------------------------------------------
    // ---- 呼び戻しリスト (M27・P4-5) --------------------------------------------
    // 最終来店からの経過日数が、本人の来店周期（無ければ店舗全体の中央値）の
    // 1.5倍を超えている顧客に「周期超過」フラグを立てる。
    var rfmCusts = visitedCusts.map(function (c) {
      var Rp = rScore(c.R), Fp = fScore(c.Fvis), Mp = mScore(c.M);
      var ownCycle = custOwnCycle[c.key] != null ? custOwnCycle[c.key] : visitCycleMedianDays;
      var cycleOverdue = c.R != null && ownCycle != null && c.R > ownCycle * 1.5;
      return {
        name: c.name, R: c.R, F: c.Fvis, M: c.M, Rp: Rp, Fp: Fp, Mp: Mp, seg: segment(Rp, Fp),
        daysSince: c.R, ownCycle: round(ownCycle, 1), cycleOverdue: cycleOverdue
      };
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
        totalRows: rows.length,
        undatedRows: rows.filter(function (r) { return !r.date; }).length,   // rows whose 来店日 couldn't be parsed
        completedOnly: !hasFuture,   // 会計明細など、これからの予約が無い（＝直近月は打ち切り）
        generatedAt: options.now || null
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
        maturity: { applied: !hasFuture, days: REPEAT_MATURITY_DAYS, matureCustomers: matureN, totalCustomers: baseN },
        funnel: funnel, churn: churn, cancel: cancel, route: route, retail: retail,
        ltv: { current: Math.round(ltv.current), predicted: Math.round(ltv.predicted), expectedVisits: round(ltv.expectedVisits, 2), observedVisits: round(ltv.observedVisits, 2) },
        monthly: monthly, cohort: cohort, visitCountBreakdown: visitCountBreakdown, newMix: newMix, serviceRetailMonthly: serviceRetailMonthly
      },
      staff: staff,
      trend: {
        dayOfWeek: dayOfWeek, monthlyCohort: monthlyCohort, coupons: coupons,
        menuTop: menuTop, nextResMenuRatio: nextResMenuRatio, couponRatio: couponRatio,
        hourDow: hourDow, hourLabels: HOURS.map(function (h) { return h + '時'; })
      },
      rfm: { total: rfmTotal, segments: segments, map: map, customers: rfmCusts },
      _segmentsMeta: SEGMENTS
    };
  }

  var api = { compute: compute, SEGMENTS: SEGMENTS, _helpers: { parseDate: parseDate, rScore: rScore, fScore: fScore, mScore: mScore, segment: segment } };
  global.KATE = global.KATE || {};
  global.KATE.engine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
