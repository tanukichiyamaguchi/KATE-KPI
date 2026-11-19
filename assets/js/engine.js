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
    // 税抜き変換: 元データ（HOT PEPPER Beauty 等）の金額は税込（総額表示）。
    // options.taxRate（例 0.1＝消費税10%）が指定されたら、金額をすべて税抜に
    // 換算する。金額はこの1か所（正規化時のソース）でのみ割るので、売上・客単価・
    // LTV・店販など下流の全指標が自動で税抜・一貫した丸めになる。taxRate 未指定
    // （＝0）なら無変換なので、元ワークブック（税込）と突合する validate.js は
    // これまでどおり合格する。
    var TAX_RATE = (options.taxRate != null && isFinite(options.taxRate)) ? options.taxRate : 0;
    function taxAdj(v) { return v == null ? v : (TAX_RATE ? v / (1 + TAX_RATE) : v); }
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
        yoyaku: taxAdj(num(r.yoyakuTotal)), planned: taxAdj(num(r.payPlanned)), kaikei: taxAdj(num(r.kaikeiTotal)),
        shohan: r.shohan || null, shohanAmt: taxAdj(num(r.shohanAmount)),
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

    // Tag each reservation — visited AND upcoming (受付待ち) — with the customer's
    // visit ordinal (1st, 2nd, …), so a future booking also carries which numbered
    // visit it represents. Visited rows always sort before future rows (date <= asOf
    // vs. > asOf), so this widening leaves every already-tagged visited ordinal
    // unchanged; future rows simply gain new ordinals appended after them.
    customers.forEach(function (c) {
      byCust[c.key].filter(function (r) { return r.isEffective && r.date; }).sort(function (a, b) { return a.date - b.date; })
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
    // 率としてグラフに載せる最小の母数。分母が1〜2人だと 1/1＝100%、1/2＝50% の
    // ように、たった1人の挙動が「固定化率100%」に化けて実態を誤って伝える。
    // 母数がこれ未満の月は率を出さない（null＝グラフ上は点を描かない）。
    // 人数そのもの（cohortN/fix2N など）は保持するので、内訳は失われない。
    var MIN_RATE_DENOM = 5;
    // 目安（オーナー設定の固定値）: リピート率70%・固定化率60%。画面の目安線と
    // 「次の一手」の判定の両方がこの値を使う（meta.guide として画面に渡す）。
    var GUIDE = { repeat: 0.7, fix: 0.6 };
    // 「次の一手」で提案の対象にする率の、最小の分母（人）。
    var FOCUS_MIN_DENOM = 20;
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

    // ---- Retention funnel (reservation-based: Fres counts visited + upcoming
    // effective reservations, already excluding cancellations — see Fres above
    // and Fixture M) --------------------------------------------------------
    // Base is ALL visited customers, not a maturity-gated subset: "reached N" is
    // now a pure reservation fact (has the customer got an Nth reservation,
    // counting a rebooking after a cancellation but not the cancellation itself),
    // not a time-elapsed guess — a brand-new customer with no 2nd reservation yet
    // correctly counts as "not yet reached 2", the same as any other customer.
    // 到達人数(バー)は予約ベース(Fres): 基準日より後の受付待ちの予約も「到達」に数える
    // （基準日以前の未処理＝滞留は来店しなかった扱いで数えない。asOf の定義を参照）。
    // 段の数はデータに応じて決める（オーナー要望・2026-09-05）: 1回〜「予約ベースで一番多く
    // 到達している人の回数（maxFres）」まで。ただし表示が長くなりすぎないよう FUNNEL_MAX_STAGES で打ち切り、
    // 打ち切った最後の段は「N回以上」の意味になる（各段の到達は元々「n回以上」なので、
    // 最後の段の人数はそのまま「N回以上到達」の人数）。
    //
    // 継続率は棒と同じ「予約ベース」で揃える: 次の段の到達人数 ÷ この段の到達人数。
    // 以前は継続率だけ実来店ベース（分母 Fvis>=n）にしていたため、棒が 80→34 と
    // 減っているのに「継続 97%」と出る、読めば矛盾に見える状態だった。
    // 「実際に来店しなかった（キャンセル・無断）予約は到達に数えない」は Fres の定義
    // そのもの（キャンセルは除外、キャンセル後に取り直せば数える）なので、そのまま。
    var FUNNEL_MAX_STAGES = 10;
    var maxFres = visitedCusts.reduce(function (m, c) { return Math.max(m, c.Fres || 0); }, 0);
    // 最低2段（1回・2回）は必ず作る。誰も2回目に到達していないデータでも
    // 「2回: 0人」は意味のある情報であり、リピート率（funnel[1]）の計算も
    // この段を前提にしている（1段しか無いと funnel[1] が無くて落ちる）。
    var stageCount = Math.max(2, Math.min(FUNNEL_MAX_STAGES, maxFres));
    var funnel = [];
    for (var fn = 1; fn <= stageCount; fn++) funnel.push(fn);
    funnel = funnel.map(function (n) {
      var people = visitedCusts.filter(function (c) { return c.Fres >= n; }).length;
      var next = visitedCusts.filter(function (c) { return c.Fres >= n + 1; }).length;
      var last = n === stageCount;   // 最後の段には「次の段」が無いので継続率は定義しない
      return {
        n: n, people: people, reach: baseN ? people / baseN : 0,
        // open: この段が打ち切りの最後で、実際にはもっと多く来ている人がいる（「N回以上」）
        open: n === FUNNEL_MAX_STAGES && maxFres > FUNNEL_MAX_STAGES,
        // 誰も到達していない段（people=0）は継続率を定義しない（0人÷0人を出さない）
        contDen: (last || !people) ? null : people, contNum: (last || !people) ? null : next,
        cont: (last || !people) ? null : next / people
      };
    });
    var repeatRate = baseN && funnel[1] ? funnel[1].people / baseN : 0;
    // 固定化率: 「2回目の来店を済ませた顧客のうち、3回目の予約に到達した割合」
    // （オーナー確定の定義・2026-08-13）。分母＝Fvis>=2（実際に2回来店した人）、
    // 分子＝そのうち Fres>=3（3回目の予約あり。受付待ちを含み、キャンセルは数えず、
    // キャンセル後に取り直せば数える）。
    // リピート率（分母＝来店顧客全員・分子＝Fres>=2）とは分母の基準が異なる:
    // 固定化率は「2回目まで来てくれた方が、その来店で次を取ったか」という
    // 接客の成果を測る指標なので、まだ2回目に来ていない（予約だけの）方は
    // 分母に入れない。その代償として、獲得から日が浅いコホートは「早く再来した
    // 熱心な方」だけが分母に入り率が高く出るため、月次推移では母数が育つまで
    // 表示を伏せる（repeatFixMonthly の fixImmature を参照）。
    var fix2Visit = visitedCusts.filter(function (c) { return c.Fvis >= 2; }).length;
    var fix3Reserve = visitedCusts.filter(function (c) { return c.Fvis >= 2 && c.Fres >= 3; }).length;
    var fixationRate = fix2Visit ? fix3Reserve / fix2Visit : 0;

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
    // これからの予約が無いデータ（会計明細だけ・今日までの予約データ）では、月末から30日
    // 経っていない月の来店は「次の来店がまだ来ていないだけ」で次回予約なしに数えられる
    // （右打ち切り）。月ごとの数字・ホームと同じく、その月の来店を分子・分母から除く。
    // 予約データ（これからの予約あり）では monthImmature が常に false なので値は変わらない。
    var nextMature = visitedRows.filter(function (r) { return !(r.date && monthImmature(r.ym)); });
    var nextReserveCount = nextMature.filter(function (r) { return r.date && visitGotNext(r); }).length;
    var nextReserveDen = nextMature.length;
    var nextReserveCensored = nextReserveDen < actualVisits;
    var nextReserveRate = nextReserveDen ? nextReserveCount / nextReserveDen : (nextReserveCensored ? null : 0);

    // ---- Visit cycle (median gap between consecutive visits) ----------------
    // Also keep each customer's OWN median gap (for the M27 callback list below) —
    // a customer with only one visit ever has no gap of their own, so they fall
    // back to the store-wide median.
    // 間隔は「別の日の来店」どうしで測る（0日の間隔は数えない）。同じ日に会計が2件
    // ある方（まつげとまゆげを別々に予約した場合など）は、0日の間隔が入ると自分の
    // 周期が0日になり、来店の翌日から「周期超過＝呼び戻し候補」になってしまうため。
    var gaps = [], custOwnCycle = {};
    visitedCusts.forEach(function (c) {
      var v = byCust[c.key].filter(function (r) { return r.isVisited && r.date; }).map(function (r) { return r.date; }).sort(function (a, b) { return a - b; });
      var ownGaps = [];
      for (var i = 1; i < v.length; i++) { var g = dayDiff(v[i], v[i - 1]); if (g > 0) { gaps.push(g); ownGaps.push(g); } }
      custOwnCycle[c.key] = ownGaps.length ? median(ownGaps) : null;
    });
    // 別の日に2回来店した方がまだいない（開店直後・連携したばかり）ときは、周期そのものが無い。
    // 0日として扱うと、全員が来店の翌日から「周期超過＝呼び戻し候補」になるため null にする。
    var visitCycleMedianDays = gaps.length ? median(gaps) : null;

    // ---- Churn (visited customers with no next effective reservation) -------
    var churned = visitedCusts.filter(function (c) { return c.Fres < 2; });
    var cancelStopped = churned.filter(function (c) { return c.hasAnyCancel; }).length;
    var churn = { total: churned.length, cancelStopped: cancelStopped, noNextReserve: churned.length - cancelStopped, base: baseN };

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
    // 予測LTVの「期待来店回数」は従来どおり 1〜5回 の到達率の合計に固定する。
    // ファネルの段数を増やしてもここが黙って変わらないようにするため（画面の説明文も
    // 「1回〜5回到達率の合計」と明記している）。
    var expectedVisits = funnel.slice(0, 5).reduce(function (s, f) { return s + f.reach; }, 0);
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
        spend: res ? Math.round((revActual + revExpected) / res) : 0,   // 予約ベース客単価（元ワークブック準拠・0予約月は0＝スパークライン安全）
        // 実績客単価＝会計済み売上 ÷ 来店件数（見込みを含まない）。来店0件の月は
        // 「測定不能」＝null にして、推移グラフで¥0に落とさずギャップにする。
        spendActual: vis.length ? Math.round(revActual / vis.length) : null,
        new: newByMonth[mo] || 0,
        cancel: conf.length ? canc.length / conf.length : null,
        // 会計明細のみのデータでは、月末から30日経っていない月の次回予約率は右打ち切り
        // で0%に寄るため null にする（スタッフの月次推移と同じ扱い。予約データでは無関係）。
        nextRes: monthImmature(mo) || !vis.length ? null : nextCnt / vis.length,
        nextResImmature: monthImmature(mo)
      };
    });

    // ---- 直近30日の日次売上（お店タブ・会計済み実績）---------------------------
    // asOf を最終日として過去30日ぶんの「会計済み売上（実績）」と客数（会計件数）を
    // 日別に。受付待ちの見込みは含めない＝確定した実績カレンダー。金額は r.kaikei が
    // 税抜/税込設定を織り込み済みなので、上位の税設定にそのまま追従する。
    var dailyMap = {};
    visitedRows.forEach(function (r) {
      if (!r.date) return;
      var dk = r.date.getFullYear() + '|' + r.date.getMonth() + '|' + r.date.getDate();
      var e = dailyMap[dk] || (dailyMap[dk] = { rev: 0, count: 0, retail: 0 });
      e.rev += r.kaikei; e.count += 1; e.retail += r.shohanAmt;   // shohanAmt は税抜/税込設定済み
    });
    var dailyRevenue = [];
    for (var dOff = 29; dOff >= 0; dOff--) {
      var dd = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate() - dOff);
      var e2 = dailyMap[dd.getFullYear() + '|' + dd.getMonth() + '|' + dd.getDate()];
      dailyRevenue.push({
        month: dd.getMonth() + 1, day: dd.getDate(), dow: dd.getDay(),
        rev: e2 ? e2.rev : 0, count: e2 ? e2.count : 0, retail: e2 ? e2.retail : 0,
        resCount: 0, resAmount: 0, isFuture: false, isAsOf: dOff === 0
      });
    }

    // ---- 今後1ヶ月の予約（受付待ち）------------------------------------------
    // 基準日の翌日から30日ぶんの「受付待ち予約の件数」と「予約時金額（見込み）」を
    // 日別に。上の実績カレンダーと同じ形にそろえ、UI では地続きの1つのカレンダー
    // として描画する（過去＝確定した実績／未来＝これから入っている予約）。
    var futureMap = {};
    rows.forEach(function (r) {
      if (!r.isFuture || !r.date) return;
      var fk = r.date.getFullYear() + '|' + r.date.getMonth() + '|' + r.date.getDate();
      var e = futureMap[fk] || (futureMap[fk] = { resCount: 0, resAmount: 0 });
      e.resCount += 1; e.resAmount += r.yoyaku;   // yoyaku は税抜/税込設定済み
    });
    // ---- 全期間の日次集計（年商カード用）--------------------------------------
    // 年商は「1/1〜12/31 の会計済み売上」が基本だが、任意の期間で絞り込めるように
    // 全期間ぶんを日別の粒度で持たせておく（合計は UI 側で範囲を指定して出す）。
    // ymd は 20260703 形式の数値なので、範囲比較も並べ替えもそのまま出来る。
    var allMap = {};
    var allBucket = function (dt) {
      var k = dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate();
      return allMap[k] || (allMap[k] = {
        ymd: k, y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate(),
        rev: 0, count: 0, retail: 0, resAmount: 0, resCount: 0
      });
    };
    visitedRows.forEach(function (r) {
      if (!r.date) return;
      var b = allBucket(r.date);
      b.rev += r.kaikei; b.count += 1; b.retail += r.shohanAmt;   // 会計済み＝確定した売上
    });
    rows.forEach(function (r) {
      if (!r.isFuture || !r.date) return;
      var b = allBucket(r.date);
      b.resAmount += r.yoyaku; b.resCount += 1;                   // 受付待ち＝これからの見込み
    });
    var dailyAll = Object.keys(allMap).map(function (k) { return allMap[k]; })
      .sort(function (a, b) { return a.ymd - b.ymd; });

    var upcomingReservations = [];
    for (var fOff = 1; fOff <= 30; fOff++) {
      var fd = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate() + fOff);
      var f2 = futureMap[fd.getFullYear() + '|' + fd.getMonth() + '|' + fd.getDate()];
      upcomingReservations.push({
        month: fd.getMonth() + 1, day: fd.getDate(), dow: fd.getDay(),
        rev: 0, count: 0, retail: 0,
        resCount: f2 ? f2.resCount : 0, resAmount: f2 ? f2.resAmount : 0,
        isFuture: true, isAsOf: false
      });
    }

    // ---- 新規/再来ミックス月次 (M19) ------------------------------------------
    // Per-VISIT ordinal (not the customer's first-*effective*-month binning used
    // by `monthly.new` above), so a customer whose very first interaction was a
    // future booking doesn't get miscounted as "new" in some other month.
    // v2/v3/v4 = 2回目/3回目/4回目以上の来店数 (repeat = v2+v3+v4, kept for subs).
    var newMix = months.map(function (mo) {
      var vis = visitedRows.filter(function (r) { return r.ym === mo; });
      var counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
      vis.forEach(function (r) { counts[Math.min(4, Math.max(1, r._ord || 1))]++; });
      return { m: mo, new: counts[1], v2: counts[2], v3: counts[3], v4: counts[4], repeat: counts[2] + counts[3] + counts[4] };
    });

    // ---- 新規/再来ミックス月次・予約ベース内訳（会計済み実績＋受付待ち見込み） -------
    // newMix と同じ「何回目の来店/予約か」の内訳を、店舗全体で 会計済み(実績) と
    // 受付待ち(見込み) に分けて算出する。スタッフ別 composition（下記 comp、
    // st.composition として公開）と同一ロジックで、スタッフによる絞り込みだけを
    // 外した店舗全体版。new/v2/v3/v4（会計済み）は newMix と同じ値になる。
    var composition = months.map(function (mo) {
      var vc = { 1: 0, 2: 0, 3: 0, 4: 0 }, pc = { 1: 0, 2: 0, 3: 0, 4: 0 };
      rows.filter(function (x) { return x.ym === mo && x.isEffective && x.date; }).forEach(function (x) {
        var counts = x.isVisited ? vc : pc;
        counts[Math.min(4, Math.max(1, x._ord || 1))]++;
      });
      return { m: mo, new: vc[1], v2: vc[2], v3: vc[3], v4: vc[4], expNew: pc[1], expV2: pc[2], expV3: pc[3], expV4: pc[4] };
    });

    // ---- 月次の売上を「新規／既存」に分ける（予約ベース）-----------------------
    // 内訳の定義は composition と完全に同じ（何回目の来店/予約か＝_ord が1なら新規）。
    // 金額の取り方は monthly.rev と完全に同じ（会計済み→会計金額、受付待ち→予約金額）。
    // したがって newActual+repeatActual+newExpected+repeatExpected は monthly.rev と一致する。
    var revenueMix = months.map(function (mo) {
      var na = 0, ra = 0, ne = 0, re = 0;
      rows.filter(function (r) { return r.ym === mo; }).forEach(function (r) {
        var isNew = Math.min(4, Math.max(1, r._ord || 1)) === 1;
        if (r.isVisited) { if (isNew) na += r.kaikei; else ra += r.kaikei; }
        else if (r.isFuture) { if (isNew) ne += r.yoyaku; else re += r.yoyaku; }
      });
      return { m: mo, newActual: na, repeatActual: ra, newExpected: ne, repeatExpected: re };
    });

    // ---- 期間バケット売上（実績のみ・元要望準拠） -------------------------------
    // 直近3ヶ月＝今月（基準日の月）を含まない確定3ヶ月。売上は会計済みのΣのみ。
    // monthly = Σ売上 ÷ 来店のあった月数（新任スタッフがバケット内の一部月しか
    // 働いていない場合に平均を不当に下げないため）。daily = Σ売上 ÷ 営業日
    // （その期間に1件でも会計があったユニーク日数）。データが無いバケットは null。
    var currentYm = ym(asOf);
    var prevYm = (function () { var p = currentYm.split('-'); var d = new Date(+p[0], +p[1] - 2, 1); return ym(d); })();
    var last3Months = months.filter(function (mo) { return mo < currentYm; }).slice(-3);
    function bucketOf(vRows, monthList) {
      var inBucket = vRows.filter(function (r) { return monthList.indexOf(r.ym) !== -1; });
      if (!inBucket.length) return { months: monthList, monthly: null, daily: null };
      var rev = inBucket.reduce(function (s, r) { return s + r.kaikei; }, 0);
      var activeMonths = uniqCount(inBucket, function (r) { return r.ym; });
      var bizDays = uniqCount(inBucket.filter(function (r) { return r.date; }), function (r) { return r.date.getTime(); });
      return { months: monthList, monthly: Math.round(rev / activeMonths), daily: bizDays ? Math.round(rev / bizDays) : null };
    }
    function periodStats(vRows) {
      return {
        last3: bucketOf(vRows, last3Months),
        prevMonth: bucketOf(vRows, [prevYm]),
        currentMonth: bucketOf(vRows, [currentYm])
      };
    }
    var revPeriods = periodStats(visitedRows);
    // 店販の期間バケット（月間のみ）: Σ shohanAmt を同じバケットで集計。
    function retailBucket(monthList) {
      var inBucket = visitedRows.filter(function (r) { return monthList.indexOf(r.ym) !== -1; });
      var amt = inBucket.reduce(function (s, r) { return s + r.shohanAmt; }, 0);
      var activeMonths = uniqCount(inBucket, function (r) { return r.ym; });
      return activeMonths ? Math.round(amt / activeMonths) : null;
    }
    var retailPeriods = retail.hasAmount ? {
      last3: retailBucket(last3Months), prevMonth: retailBucket([prevYm]), currentMonth: retailBucket([currentYm])
    } : null;

    // ---- 今月（月初〜基準日）と「先月の同じ時期」「先月」の比較（ホーム画面用） ----
    // 「今月はいまどうなっているか」を、先月の同じ日数ぶんと同じ物差しで比べる。
    //  ・今月       ＝ 基準日(asOf)の月の 1日〜asOf の会計済み（実績のみ）
    //  ・先月の同じ時期 ＝ 先月の 1日〜同じ日（先月の日数が足りなければ月末まで）
    //  ・先月       ＝ 先月まるごと（確定）
    //  ・予約込み   ＝ 今月の実績 ＋ 今月中の受付待ち（基準日より後）の予約金額
    // 曜日の並びは月ごとに違うため、厳密な同条件ではない（画面の説明に明記する）。
    // match(r) で行を絞ると、店舗全体にもスタッフ個人にも同じ定義で使える。
    var asOfDay = asOf.getDate();
    var curDim = daysInMonth(currentYm), prevDim = daysInMonth(prevYm);
    var prevCut = Math.min(asOfDay, prevDim);
    function sliceStats(vis) {
      var rev = 0, nextN = 0, nextD = 0, newV = 0, retailAmt = 0, days = {};
      vis.forEach(function (r) {
        rev += r.kaikei; retailAmt += r.shohanAmt;
        if (r._ord === 1) newV++;
        // 次回予約取得率: 会計明細のみ（これからの予約が見えないデータ）では、直近の
        // 来店は「次の来店がまだ来ていない」だけで0%に寄る（右打ち切り）。スタッフの
        // 月次推移（staffMonthly）・比較表（avgRecent）と同じく、月末から30日経って
        // いない月（monthImmature）の来店は分子・分母の両方から外す。予約データでは
        // monthImmature は常に false なので何も変わらない。
        if (!monthImmature(r.ym)) { nextD++; if (visitGotNext(r)) nextN++; }
        days[r.date.getTime()] = 1;   // 日付そのもので数える（複数月をまとめても同じ日を重複させない）
      });
      return {
        rev: rev, visits: vis.length,
        spend: vis.length ? Math.round(rev / vis.length) : null,     // 実績客単価（会計済み売上 ÷ 来店件数）
        newVisits: newV,                                             // 新規（その顧客の1回目の来店）
        nextNum: nextN, nextDen: nextD,
        nextRate: nextD ? nextN / nextD : null,                      // 次回予約取得率（全体の定義と同じ）
        nextCensored: nextD < vis.length,                            // 直近の月の来店を「再来待ち」で除いた（会計明細のみ）
        retail: retailAmt, bizDays: Object.keys(days).length         // 店販売上・営業日数（会計のあった日）
      };
    }
    function monthToDate(match) {
      var curVis = visitedRows.filter(function (r) { return r.date && r.ym === currentYm && match(r); });
      var prevAll = visitedRows.filter(function (r) { return r.date && r.ym === prevYm && match(r); });
      var prevSame = prevAll.filter(function (r) { return r.date.getDate() <= prevCut; });
      var fut = futureRows.filter(function (r) { return r.date && r.ym === currentYm && match(r); });
      // 日別の累計（グラフ用）。cur＝実績の累計（基準日まで・以降は null）、
      // withBooked＝実績＋受付待ちの予約の累計（月末まで）、prev＝先月の実績の累計。
      var curByDay = {}, bookByDay = {}, prevByDay = {};
      curVis.forEach(function (r) { var d = r.date.getDate(); curByDay[d] = (curByDay[d] || 0) + r.kaikei; });
      fut.forEach(function (r) { var d = r.date.getDate(); bookByDay[d] = (bookByDay[d] || 0) + r.yoyaku; });
      prevAll.forEach(function (r) { var d = r.date.getDate(); prevByDay[d] = (prevByDay[d] || 0) + r.kaikei; });
      var cumCur = [], cumBook = [], cumPrev = [], acc = 0, accB = 0, accP = 0;
      for (var d = 1; d <= curDim; d++) {
        acc += curByDay[d] || 0; accB += (curByDay[d] || 0) + (bookByDay[d] || 0);
        cumCur.push(d <= asOfDay ? acc : null);
        cumBook.push(accB);
      }
      for (var p = 1; p <= prevDim; p++) { accP += prevByDay[p] || 0; cumPrev.push(accP); }
      var bookedRev = fut.reduce(function (s, r) { return s + r.yoyaku; }, 0);
      var cur = sliceStats(curVis);
      return {
        ym: currentYm, day: asOfDay, daysInMonth: curDim,
        prevYm: prevYm, prevDay: prevCut, prevDaysInMonth: prevDim,
        cur: cur, prevSame: sliceStats(prevSame), prevFull: sliceStats(prevAll),
        // tracked: データに「これからの予約」が1件でもあるか（全体で判定）。会計明細
        // だけのデータには予約が入らないため、0件・¥0 を「残りの予約なし」と読ませない。
        // スタッフ個人が0件なのは本当に0件なので、個人単位ではなく全体で判定する。
        booked: { rev: bookedRev, count: fut.length, tracked: hasFuture },
        withBooked: cur.rev + bookedRev,   // 予約込み（実績＋今月中の受付待ち）
        daily: { cur: cumCur, withBooked: cumBook, prev: cumPrev }
      };
    }
    var storeMonth = monthToDate(function () { return true; });

    // ---- 期間ごとの数字（直近3ヶ月・先月・今月）をひとつの物差しで ----------------
    // スタッフ画面の「月ごとの数字」表で使う。以前はスタッフカードに「全期間（集計
    // 途中の今月を含む）」の平均と、比較表の「直近3ヶ月」の平均が同じラベルで並び、
    // 同じ「平均来店/月」が 40件 と 75件 のように食い違って見えていた。ここでは
    // 期間を必ず明示し、すべて会計済み（実績）だけで数える。
    //  ・last3 ＝ 今月を含まない確定3ヶ月（お店の「月ごとの数字」と同じ）。「/月」は来店のあった月数で割る
    //  ・prev  ＝ 先月（確定）
    //  ・cur   ＝ 今月の1日〜基準日（集計途中）
    function periodSummary(match) {
      function agg(monthList) {
        var vis = visitedRows.filter(function (r) { return r.date && monthList.indexOf(r.ym) !== -1 && match(r); });
        var s = sliceStats(vis);
        var mCount = uniqCount(vis, function (r) { return r.ym; });
        s.months = mCount;
        s.revPerMonth = mCount ? Math.round(s.rev / mCount) : null;
        s.visitsPerMonth = mCount ? round(s.visits / mCount, 1) : null;
        s.newPerMonth = mCount ? round(s.newVisits / mCount, 1) : null;
        s.retailPerMonth = mCount ? Math.round(s.retail / mCount) : null;
        s.revPerDay = s.bizDays ? Math.round(s.rev / s.bizDays) : null;
        return s;
      }
      return { last3Months: last3Months.slice(), last3: agg(last3Months), prev: agg([prevYm]), cur: agg([currentYm]) };
    }
    var storePeriods = periodSummary(function () { return true; });

    // ---- Cohort (first-visit month → 2nd-visit reach) -----------------------
    // A cohort month whose customers haven't yet had 45 days to return is dropped
    // (completed-checkout sources only) rather than shown as a misleadingly low bar.
    var byCohort = groupBy(visitedCusts.filter(function (c) { return c.firstVisitMonth; }), function (c) { return c.firstVisitMonth; });
    var cohort = months.map(function (mo) {
      var g = byCohort[mo] || [];
      // 母数の小さい月だけ落とす（1人＝100% を防ぐ）。集計途中の当月は予約ベースで
      // 測定できるため隠さない（partial フラグつき）。monthImmatureBy は会計明細のみ
      // （未来の予約が無いデータ）のときだけ働く45日の保険。
      if (g.length < MIN_RATE_DENOM || monthImmatureBy(mo, REPEAT_MATURITY_DAYS)) return null;
      var reach2 = g.filter(function (c) { return c.Fres >= 2; }).length / g.length;
      return { m: mo, n: g.length, reach2: reach2, partial: mo === currentYm };
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
        var visitDays = uniqCount(vis.filter(function (r) { return r.date; }), function (r) { return r.date.getTime(); });
        return {
          m: mo, res: res, actual: vis.length, exp: fut.length, rev: rev, revActual: revActual, visitDays: visitDays,
          spend: res ? Math.round(rev / res) : null,   // 予約ベース客単価＝予約ベース売上÷予約数（元ワークブック準拠）
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
    // 稼働率＝Σ施術時間(分) ÷ 稼働可能時間。稼働可能時間は「その月に実際に施術が
    // あった日数 × 8時間（1人1日8時間勤務）」（オーナー確定）。暦日固定だと休みの
    // 多いスタッフほど不当に低く出るため、実稼働日ベースにする。会計明細には所要
    // 時間が無いため dur を一件も持たないデータセットでは算出しない。
    // 進行中の当月・未来月・未成熟月は他の成熟依存指標と同様 rate=null にして
    // チャートに描かせない（3日分しかない当月が『急落』に見えるのを防ぐ）。
    var anyDur = visitedRows.some(function (r) { return r.dur != null; });
    var OPERATING_HOURS = 8;   // 1日8時間勤務想定
    function daysInMonth(mo) { var p = mo.split('-'); return new Date(+p[0], +p[1], 0).getDate(); }
    function utilizationMonthly(mrows) {
      return anyDur ? mrows.map(function (r) {
        var capacity = r.visitDays * OPERATING_HOURS * 60;   // 実稼働日 × 8h × 60分
        var measurable = r.m < currentYm && !monthImmature(r.m) && r.visitDays > 0;
        return { m: r.m, minutes: r.durMin, capacity: capacity, workDays: r.visitDays, rate: measurable ? r.durMin / capacity : null };
      }) : null;
    }

    // Whether this dataset has any 店販 signal at all — gates whether the
    // corresponding personal-best/milestone fields below are numbers or null
    // (a salon that never records retail sales shouldn't show a false "0件").
    var anyRetail = visitedRows.some(function (r) { return r.hasRetail; });
    // currentYm (the in-progress month, excluded from personal-best comparisons)
    // is defined up with the period buckets.

    // 固定化率の月次推移でコホートの熟成を待つ日数。来店周期の中央値＝お客様が次に
    // 来店するまでの実測値なので、これだけ経てば「2回来店した人」（固定化率の分母）が
    // ひと通り出そろう。店舗ごとの実データに追従させるため定数にしない（最低30日）。
    var cohortFixMatureDays = Math.max(visitCycleMedianDays || 0, 30);

    var staff = staffNames.map(function (name) {
      var mrows = staffMonthly(name);
      var active = mrows.filter(function (r) { return r.actual > 0; });
      // `acqAll` is the headline "獲得顧客" count (never right-censored); `acqMature`
      // is the 45-day-matured subset still used for the "成熟母数" stat and the
      // 次の一手 sample-size gate below (unrelated to reach()).
      var acqAll = customers.filter(function (c) { return c.firstVisitStaff === name && c.hasVisit; });
      var acqMature = acqAll.filter(custMature);
      // リピート率（2回到達）・固定化率（3回目到達）の母数：
      // 直近3ヶ月（今月を含まない確定3ヶ月）にこのスタッフが初回担当した顧客の
      // コホート。「到達」は予約ベース（Fres、キャンセル後の再予約を考慮・
      // キャンセルのみは含まない）で判定し、45日成熟待ちは行わない —
      // 新しく獲得した顧客でも、2回目の予約が入っていなければ即座に「未到達」。
      var acqRecent = acqAll.filter(function (c) { return last3Months.indexOf(c.firstVisitMonth) !== -1; });
      // null (not 0) when there's no recent-cohort base yet — a brand-new staff
      // hasn't "failed" to retain anyone, there just hasn't been anyone to test yet.
      function reach(n) { return acqRecent.length ? acqRecent.filter(function (c) { return c.Fres >= n; }).length / acqRecent.length : null; }
      // 固定化率: 「このスタッフが直近3ヶ月に初回担当し、実際に2回来店した顧客の
      // うち、3回目の予約に到達した割合」。店舗全体と同じオーナー確定の定義
      // （分母＝Fvis>=2、分子＝Fvis>=2 かつ Fres>=3）。
      // 実来店2回目がまだ0人なら null（新任は母数不足で測定不能＝正直な表示）。
      var fix2Visit = acqRecent.filter(function (c) { return c.Fvis >= 2; }).length;
      var fix3Reserve = acqRecent.filter(function (c) { return c.Fvis >= 2 && c.Fres >= 3; }).length;
      var fixationRate = fix2Visit ? fix3Reserve / fix2Visit : null;
      var mature = active.filter(function (r) { return !r.nextResImmature; });
      // プール平均（件数で重み付け／オーナー確定）: 月ごとの率を単純平均するのでなく、
      // 分子合計 ÷ 分母合計で集計する。月次単純平均だと来店の少ない月（新任の当月
      // など）が大きな月と同じ重みになり、率が実態より膨らむため。sum(numKey)/
      // sum(denKey) を返し、率の付随として分子分母の実数も返せるようにする。
      function poolSum(list, numKey, denKey, gate) {
        var num = 0, den = 0;
        list.forEach(function (r) {
          var d = r[denKey];
          if (d && (!gate || r[gate] != null)) { num += r[numKey]; den += d; }
        });
        return { num: num, den: den, rate: den ? num / den : null };
      }
      // 客単価＝予約ベース売上合計 ÷ 予約数合計、次回予約取得率＝次回確保来店合計 ÷
      // 来店合計。次回系は月次率が定義された月（!immature）だけをプールする。
      var spendAll = poolSum(active, 'rev', 'res');
      var nextAll = poolSum(active, 'nextCnt', 'visN', 'nextRes');
      var next2All = poolSum(active, 'next2Cnt', 'vis2N', 'nextRes2');
      var avg = {
        months: active.length,
        visitsPerMonth: active.length ? round(active.reduce(function (s, r) { return s + r.actual; }, 0) / active.length, 1) : 0,
        revPerMonth: active.length ? Math.round(active.reduce(function (s, r) { return s + r.rev; }, 0) / active.length) : 0,
        spend: spendAll.rate == null ? 0 : Math.round(spendAll.rate),
        spendRev: spendAll.num, spendRes: spendAll.den,   // 分子(円)・分母(予約件数)
        newPerMonth: active.length ? round(active.reduce(function (s, r) { return s + r.new; }, 0) / active.length, 1) : 0,
        nextRes: nextAll.rate,
        nextResNum: nextAll.num, nextResDen: nextAll.den,   // 分子(次回確保来店)・分母(来店)
        nextRes2: next2All.rate,
        nextRes2Num: next2All.num, nextRes2Den: next2All.den
      };
      // スタッフ比較表（vsMetrics）専用：直近3ヶ月（今月を含まない確定3ヶ月）限定の
      // プール平均。全期間平均の avg とは別に持たせる。
      var activeRecent = active.filter(function (r) { return last3Months.indexOf(r.m) !== -1; });
      var staffVis = rows.filter(function (r) { return r.staff === name && r.isVisited; });
      var staffVisRecent = staffVis.filter(function (r) { return last3Months.indexOf(r.ym) !== -1; });
      var spendRecent = poolSum(activeRecent, 'rev', 'res');
      var nextRecent = poolSum(activeRecent, 'nextCnt', 'visN', 'nextRes');
      var retailRecentStats = retailStats(staffVisRecent);
      var avgRecent = {
        visitsPerMonth: activeRecent.length ? round(activeRecent.reduce(function (s, r) { return s + r.actual; }, 0) / activeRecent.length, 1) : 0,
        spend: spendRecent.rate == null ? 0 : Math.round(spendRecent.rate),
        spendRev: spendRecent.num, spendRes: spendRecent.den,
        nextRes: nextRecent.rate,
        nextResNum: nextRecent.num, nextResDen: nextRecent.den,
        retailCustomerRatio: retailRecentStats.customerRatio,
        retailBuyers: retailRecentStats.buyers, retailVisitCustomers: retailRecentStats.visitCustomers
      };
      var retail = retailStats(staffVis);
      // 平均店販売上/月 = Σ月次店販金額 ÷ active月数 (店販金額データが無ければ null)
      retail.avgMonthlyAmount = anyRetail && active.length
        ? Math.round(active.reduce(function (s, r) { return s + (r.retailAmount || 0); }, 0) / active.length)
        : null;
      // visit-count composition per month — new/v2/v3/v4 = 会計済み、expNew/expV2/
      // expV3/expV4 = 受付待ち（見込み）。どちらも顧客単位の共通 _ord（上の
      // isEffective 全体での採番）を使うため、見込み予約も「何回目の来店予定か」
      // で内訳できる。
      var comp = mrows.map(function (r) {
        var mo = r.m;
        var vc = { 1: 0, 2: 0, 3: 0, 4: 0 }, pc = { 1: 0, 2: 0, 3: 0, 4: 0 };
        rows.filter(function (x) { return x.staff === name && x.ym === mo && x.isEffective && x.date; }).forEach(function (x) {
          var counts = x.isVisited ? vc : pc;
          counts[Math.min(4, Math.max(1, x._ord || 1))]++;
        });
        return { m: mo, new: vc[1], v2: vc[2], v3: vc[3], v4: vc[4], expNew: pc[1], expV2: pc[2], expV3: pc[3], expV4: pc[4] };
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
      // 平均単価（客単価）は1件ごとの平均なので、来店が5件未満の月は1〜2件の高額会計で
      // 「自己ベスト」になってしまう。率と同じく MIN_RATE_DENOM 件以上の月だけで比べる。
      // 「更新」は直近の確定月そのものが対象になっているときだけ（除外された月を
      // 飛ばして、もっと前の月を「直近」と扱わない）。
      var spendMonths = confirmedActive.filter(function (r) { return r.actual >= MIN_RATE_DENOM; });
      var latestConfirmed = confirmedActive[confirmedActive.length - 1];
      var personalBest = {
        confirmedMonths: confirmedActive.length,
        visits: pickBest(confirmedActive, function (r) { return r.actual; }),
        rev: pickBest(confirmedActive, function (r) { return r.revActual; }),
        spend: pickBest(spendMonths, function (r) { return r.spend || 0; }),
        retail: anyRetail ? pickBest(confirmedActive, function (r) { return r.retailAmount || 0; }) : null,   // 月間店販売上（金額）
        latestIsBest: {
          visits: isLatestBest(confirmedActive, function (r) { return r.actual; }),
          rev: isLatestBest(confirmedActive, function (r) { return r.revActual; }),
          spend: !!latestConfirmed && spendMonths[spendMonths.length - 1] === latestConfirmed && isLatestBest(spendMonths, function (r) { return r.spend || 0; }),
          retail: anyRetail && isLatestBest(confirmedActive, function (r) { return r.retailAmount || 0; })
        }
      };

      // 自分の推移（スタッフ画面）: 確定した月（今月を除く）を前半・後半に分けて比べる。
      // 客単価・次回予約率は「件数で重み付けした平均」（Σ分子 ÷ Σ分母）にし、来店5件
      // 未満の月は除く（README の「プール平均」と同じ考え方。月ごとの率を単純平均すると、
      // 来店1件の月が大きな月と同じ重みになり、平均も向きもその1件に引っぱられる）。
      // 来店/月 は月ごとの件数の平均（件数そのものなので重み付けは不要）。
      // 対象の月が2ヶ月に満たないときは null（画面は「データを集めています」）。
      function trendOf(list, numFn, denFn) {
        if (list.length < 2) return null;
        function pool(l) {
          var n = 0, d = 0;
          l.forEach(function (r) { n += numFn(r); d += denFn(r); });
          return { num: n, den: d, v: d ? n / d : null };
        }
        var all = pool(list);
        var h = Math.floor(list.length / 2);
        var ea = pool(list.slice(0, h)).v, la = pool(list.slice(list.length - h)).v;
        // 前半が0（次回予約率0%など）のときは比率にできないので、後半が上なら上向き
        var rel = ea ? (la - ea) / Math.abs(ea) : (la > 0 ? 1 : 0);
        return { avg: all.v, num: all.num, den: all.den, months: list.length, first: list[0].m, last: list[list.length - 1].m,
          early: ea, late: la, dir: rel > 0.03 ? 'up' : rel < -0.03 ? 'down' : 'flat' };
      }
      var sgSpendMonths = confirmedActive.filter(function (r) { return r.res >= MIN_RATE_DENOM; });
      var sgNextMonths = confirmedActive.filter(function (r) { return r.nextRes != null && r.visN >= MIN_RATE_DENOM; });
      var selfGrowth = {
        spend: trendOf(sgSpendMonths, function (r) { return r.rev; }, function (r) { return r.res; }),
        visits: trendOf(confirmedActive, function (r) { return r.actual; }, function () { return 1; }),
        nextRes: trendOf(sgNextMonths, function (r) { return r.nextCnt; }, function (r) { return r.visN; })
      };
      // 育てた常連: このスタッフが初回を担当し、実際に2回来店して3回目のご予約
      // （受付待ちを含む・キャンセルは数えない）まで進んだお客様の人数。固定化率の
      // 分子（Fvis>=2 かつ Fres>=3）と同じ基準。以前は Fres>=3 だけで数えていたため、
      // 1回来店して予約が2件入っているだけの方まで「常連」に数えていた。
      // キャリア累計なので、直近3ヶ月に限らず全期間で数える。
      var regulars3 = visitedCusts.filter(function (c) { return c.firstVisitStaff === name && c.Fvis >= 2 && c.Fres >= 3; }).length;

      // 月別リピート率・固定化率の推移（獲得月コホート）。その月にこのスタッフが
      // 初回担当した顧客を母数に、リピート率＝2回目予約到達(Fres>=2)の割合、
      // 固定化率＝実来店2回目(Fvis>=2)のうち3回目予約確保(Fres>=3)の割合。店舗全体の
      // リピート率/固定化率と同一定義。直近の獲得月は右打ち切りで低めに出る。
      var repeatFixMonthly = months.map(function (mo) {
        var cohort = customers.filter(function (c) { return c.firstVisitStaff === name && c.firstVisitMonth === mo; });
        var n = cohort.length;
        // リピート率＝予約ベース（分子 Fres>=2。予約一覧で即判定できるため、
        // 集計途中の当月も隠さず表示し、UI側で「※」を付ける）。
        var reach2N = cohort.filter(function (c) { return c.Fres >= 2; }).length;
        // 固定化率＝分母 Fvis>=2（実際に2回来店した人・オーナー確定）、分子＝
        // そのうち Fres>=3。この分母は獲得から時間が経たないと育たず、育つ前は
        // 「早く再来した熱心な方」だけが分母に入り 6/6＝100% のような値が出る。
        // そこで月末から「来店周期の中央値」（最低30日）が経つまで率を伏せる。
        var fix2N = cohort.filter(function (c) { return c.Fvis >= 2; }).length;
        var fix3N = cohort.filter(function (c) { return c.Fvis >= 2 && c.Fres >= 3; }).length;
        var partial = (mo === currentYm);
        var monthEnd = new Date(+mo.split('-')[0], +mo.split('-')[1], 0);
        var fixImmature = dayDiff(asOf, monthEnd) < cohortFixMatureDays;
        // 会計明細のみ（hasFuture=false）では将来予約が見えず、直近コホートの率は
        // 右打ち切りで構造的に0%へ落ちるため45日の成熟ガードで伏せる（人数は保持）。
        // 予約データでは monthImmatureBy が常に false なので影響しない。
        var immature = monthImmatureBy(mo, REPEAT_MATURITY_DAYS);
        return {
          m: mo, cohortN: n, reach2N: reach2N, fix2N: fix2N, fix3N: fix3N,
          partial: partial, fixImmature: fixImmature,
          repeat: (!immature && n >= MIN_RATE_DENOM) ? reach2N / n : null,
          fix: (!immature && !fixImmature && fix2N >= MIN_RATE_DENOM) ? fix3N / fix2N : null
        };
      });

      // 分母・分子（人数）を UI で明示するための実数。reach2/3/4 は acqRecent が母数、
      // fixation は「実来店2回目」が母数。
      var reachDen = acqRecent.length;
      var reach2Num = acqRecent.filter(function (c) { return c.Fres >= 2; }).length;
      var reach3Num = acqRecent.filter(function (c) { return c.Fres >= 3; }).length;
      var reach4Num = acqRecent.filter(function (c) { return c.Fres >= 4; }).length;

      // 次の一手（伸びしろの提案）: 目安との差がいちばん大きい指標を1つだけ選ぶ。
      // 対象は「その率の分母」が FOCUS_MIN_DENOM 人以上の指標だけ。以前は画面側で
      // 「直近3ヶ月の初回担当が20人以上か」しか見ていなかったため、固定化率の分母
      // （実際に2回来店した人）が1人しかいなくても「常連化が0%」と提案していた
      // （サンプルの aoi：0人 ÷ 1人）。分母が小さい率は1人の結果で0%や100%に振れる。
      var focusCands = [], focusPending = [];
      if (reachDen >= FOCUS_MIN_DENOM) focusCands.push({ key: 'repeat', value: reach2Num / reachDen, target: GUIDE.repeat, num: reach2Num, den: reachDen });
      else focusPending.push({ key: 'repeat', den: reachDen, need: FOCUS_MIN_DENOM });
      if (fix2Visit >= FOCUS_MIN_DENOM) focusCands.push({ key: 'fix', value: fix3Reserve / fix2Visit, target: GUIDE.fix, num: fix3Reserve, den: fix2Visit });
      else focusPending.push({ key: 'fix', den: fix2Visit, need: FOCUS_MIN_DENOM });
      var focusGap = focusCands.filter(function (c) { return c.target - c.value > 0; })
        .sort(function (a, b) { return (b.target - b.value) - (a.target - a.value); });
      // judged＝実際に判定した指標、pending＝分母が足りず判定していない指標。
      // 「目安を達成」は判定した指標についてだけ言える。リピート率だけ判定できて
      // 固定化率は分母不足（2回来店した方が20人未満）という状態はよくある（2回目は
      // 予約が先に入り、実際の来店は数週間あと）ため、そのときは 'met-partial' を返し、
      // 画面は「固定化率も達成」とは書かない。
      var judged = focusCands.map(function (c) { return c.key; });
      // 会計明細のみ（これからの予約が見えない）では、直近に初回だったお客様はまだ
      // 再来する時間がなく、リピート率・固定化率が実態より大きく低く出る（サンプルの
      // aoi は 1人 ÷ 69人＝1%）。その数字で「ここが伸びしろ」と提案すると誤った指示に
      // なるため、提案は出さない（'censored'）。
      var growthFocus = !hasFuture ? { key: null, reason: 'censored', judged: [], pending: [] }
        : !focusCands.length ? { key: null, reason: 'insufficient', judged: judged, pending: focusPending }
        : !focusGap.length ? { key: null, reason: focusPending.length ? 'met-partial' : 'met', judged: judged, pending: focusPending }
        : { key: focusGap[0].key, value: focusGap[0].value, target: focusGap[0].target, num: focusGap[0].num, den: focusGap[0].den, judged: judged, pending: focusPending };
      return {
        name: name, avg: avg, avgRecent: avgRecent, acquired: acqAll.length, matureAcquired: acqMature.length, acqRecentN: acqRecent.length,
        reach2: reach(2), reach3: reach(3), reach4: reach(4), fixationRate: fixationRate, retail: retail, monthly: mrows, composition: comp,
        // 分母分子（人）: リピート率/育成力ファネル = reachNum/reachDen、固定化率 = fixNumer/fixDenom
        reachDen: reachDen, reach2Num: reach2Num, reach3Num: reach3Num, reach4Num: reach4Num,
        fixDenom: fix2Visit, fixNumer: fix3Reserve,
        personalBest: personalBest, regulars3: regulars3, selfGrowth: selfGrowth,
        revPeriods: periodStats(staffVis),
        utilization: utilizationMonthly(mrows),
        repeatFixMonthly: repeatFixMonthly,
        growthFocus: growthFocus,
        // ホーム・スタッフ画面用: 今月（月初〜基準日）と先月の同じ時期／先月の比較、
        // 期間ごとの数字（直近3ヶ月・先月・今月）。店舗全体の store.month / store.periods と同じ定義。
        month: monthToDate(function (r) { return r.staff === name; }),
        periods: periodSummary(function (r) { return r.staff === name; })
      };
    });

    // ---- Trend: day-of-week -------------------------------------------------
    var byDow = {};
    for (var i = 1; i <= 6; i++) byDow[i] = [];
    byDow[0] = [];
    var dayOfWeek = [1, 2, 3, 4, 5, 6, 0].map(function (d) {
      var vis = visitedRows.filter(function (r) { return r.dow === d && r.date; });
      // 次回予約率だけは、打ち切りの月（上の nextMature と同じ）の来店を除いて数える
      var visN = vis.filter(function (r) { return !monthImmature(r.ym); });
      var nextCnt = visN.filter(function (r) { return visitGotNext(r); }).length;
      var spend = vis.length ? Math.round(vis.reduce(function (s, r) { return s + r.kaikei; }, 0) / vis.length) : 0;
      var acqOnDay = visitedCusts.filter(function (c) { return c.firstVisitDow === d; });
      var ltvDay = acqOnDay.length ? Math.round(acqOnDay.reduce(function (s, c) { return s + c.M; }, 0) / acqOnDay.length) : 0;
      return { d: WEEK[d], visits: vis.length, nextRes: visN.length ? nextCnt / visN.length : (vis.length ? null : 0),
        nextNum: nextCnt, nextDen: visN.length, nextCensored: visN.length < vis.length, spend: spend, ltv: ltvDay };
    });

    // ---- Trend: monthly cohort (repeat + LTV) -------------------------------
    var monthlyCohort = months.map(function (mo) {
      var g = byCohort[mo] || [];
      // 母数の小さいコホートは落とす（1人＝100% を防ぐ）。集計途中の当月は
      // 予約ベースで測定できるため隠さず、partial フラグでUI側に「※」を付けさせる。
      // ただし会計明細のみ（hasFuture=false）のデータでは将来予約が見えず、直近の
      // コホートは構造的に0%へ落ちるため、45日の成熟ガードで落とす（store.cohort と
      // 同じ扱い。予約データでは monthImmatureBy が常に false なので影響しない）。
      if (g.length < MIN_RATE_DENOM || monthImmatureBy(mo, REPEAT_MATURITY_DAYS)) return null;
      return { m: mo, n: g.length, partial: mo === currentYm, repeat: g.filter(function (c) { return c.Fres >= 2; }).length / g.length, ltv: Math.round(g.reduce(function (s, c) { return s + c.M; }, 0) / g.length) };
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
    // 呼び戻しの対象は「周期超過」かつ「これからの予約（受付待ち・基準日より後）が
    // 入っていない」お客様。以前は周期超過だけで判定していたため、すでに次の予約を
    // 入れているお客様まで呼び戻しの候補に出ていた（サンプルでは周期超過144人中1人。
    // お客様の照合は名前ではなく顧客キー custKey で行う。サンプルは同姓同名の別人が
    // 多く、名前で数えると18人と過大に出る）。
    // 周期超過そのもの（cycleOverdue）は従来どおりの意味で残し、予約の有無は
    // hasUpcoming / nextBooking として別に持たせる。
    var nextBookingByCust = {};
    futureRows.forEach(function (r) {
      var cur = nextBookingByCust[r.custKey];
      if (r.date && (!cur || r.date < cur)) nextBookingByCust[r.custKey] = r.date;
    });
    var rfmCusts = visitedCusts.map(function (c) {
      var Rp = rScore(c.R), Fp = fScore(c.Fvis), Mp = mScore(c.M);
      var ownCycle = custOwnCycle[c.key] != null ? custOwnCycle[c.key] : visitCycleMedianDays;
      var cycleOverdue = c.R != null && ownCycle != null && c.R > ownCycle * 1.5;
      var nb = nextBookingByCust[c.key] || null;
      return {
        name: c.name, R: c.R, F: c.Fvis, M: c.M, Rp: Rp, Fp: Fp, Mp: Mp, seg: segment(Rp, Fp),
        daysSince: c.R, ownCycle: ownCycle == null ? null : round(ownCycle, 1), cycleOverdue: cycleOverdue,
        hasUpcoming: !!nb,
        nextBooking: nb ? ym(nb) + '-' + String(nb.getDate()).padStart(2, '0') : null,
        callback: cycleOverdue && !nb
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
        // Format asOf from LOCAL date parts, not toISOString(): parseDate builds
        // local-midnight Dates, and toISOString converts to UTC — which rolled
        // the displayed 基準日 back a day for every user east of UTC (Japan saw
        // 7月2日 for an asOf of 2026-07-03).
        asOf: ym(asOf) === null ? null : ym(asOf) + '-' + String(asOf.getDate()).padStart(2, '0'),
        periodStart: months[0], periodEnd: months[months.length - 1],
        months: months, staffNames: staffNames,
        totalRows: rows.length,
        undatedRows: rows.filter(function (r) { return !r.date; }).length,   // rows whose 来店日 couldn't be parsed
        completedOnly: !hasFuture,   // 会計明細など、これからの予約が無い（＝直近月は打ち切り）
        // 予約の状態（受付待ち・キャンセル）の行がデータにあるか。false＝会計明細だけ
        // （予約そのものが記録されていない）。completedOnly だが true の場合は、予約データは
        // あるが今日より後の予約が入っていない（出力した期間が今日までなど）。
        hasReservationRows: cancel.hasInfo,
        taxExcluded: TAX_RATE > 0, taxRate: TAX_RATE,   // 金額を税抜換算したか（UIの「税抜」表記用）
        currentYm: currentYm, prevYm: prevYm, last3Months: last3Months.slice(),
        guide: { repeat: GUIDE.repeat, fix: GUIDE.fix }, minRateDenom: MIN_RATE_DENOM,
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
        nextReserveRate: nextReserveRate == null ? null : round(nextReserveRate * 100, 1), visitCycleMedianDays: visitCycleMedianDays,
        // 分母・分子（UI 明示用）: リピート率 = 2回予約到達 ÷ 来店客、固定化率 =
        // 実来店2回目&3回予約 ÷ 実来店2回目、次回予約取得率 = 次回確保来店 ÷ 来店。
        repeatNumer: funnel[1] ? funnel[1].people : 0, repeatDenom: baseN,
        fixNumer: fix3Reserve, fixDenom: fix2Visit,
        nextReserveNumer: nextReserveCount, nextReserveDenom: nextReserveDen, nextReserveCensored: nextReserveCensored,
        maturity: { applied: !hasFuture, days: REPEAT_MATURITY_DAYS, matureCustomers: matureN, totalCustomers: baseN },
        funnel: funnel, churn: churn, cancel: cancel, route: route, retail: retail,
        ltv: { current: Math.round(ltv.current), predicted: Math.round(ltv.predicted), expectedVisits: round(ltv.expectedVisits, 2), observedVisits: round(ltv.observedVisits, 2) },
        monthly: monthly, cohort: cohort, visitCountBreakdown: visitCountBreakdown, newMix: newMix, composition: composition, revenueMix: revenueMix, serviceRetailMonthly: serviceRetailMonthly,
        revPeriods: revPeriods, retailPeriods: retailPeriods,
        month: storeMonth, periods: storePeriods,
        dailyRevenue: dailyRevenue, upcomingReservations: upcomingReservations, dailyAll: dailyAll
      },
      staff: staff,
      trend: {
        dayOfWeek: dayOfWeek, monthlyCohort: monthlyCohort, coupons: coupons,
        menuTop: menuTop, nextResMenuRatio: nextResMenuRatio, couponRatio: couponRatio,
        hourDow: hourDow, hourLabels: HOURS.map(function (h) { return h + '時'; })
      },
      rfm: {
        total: rfmTotal, segments: segments, map: map, customers: rfmCusts,
        callbackCount: rfmCusts.filter(function (c) { return c.callback; }).length,
        overdueWithBooking: rfmCusts.filter(function (c) { return c.cycleOverdue && c.hasUpcoming; }).length
      },
      _segmentsMeta: SEGMENTS
    };
  }

  var api = { compute: compute, SEGMENTS: SEGMENTS, _helpers: { parseDate: parseDate, rScore: rScore, fScore: fScore, mScore: mScore, segment: segment } };
  global.KATE = global.KATE || {};
  global.KATE.engine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
