/* ============================================================================
 * Atelier Éclat · App
 * Orchestration: load reservations → compute analytics → render the five views
 * with the KATE chart library. Handles routing, theme, upload/ingest, resize
 * and theme-driven chart redraws. All client-side; no data leaves the browser.
 * ==========================================================================*/
(function (global) {
  'use strict';
  var C = global.KATE.charts, F = C.fmt;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var VIEWS = ['overview', 'staff', 'trend', 'rfm', 'data'];

  var state = { data: null, analytics: null, view: 'overview', source: 'サンプルデータ', fileName: null };
  var activeCharts = [];   // redraw closures for the mounted view (resize/theme)

  // ---- formatting ----------------------------------------------------------
  function yen(n) { return '¥' + F.int(n); }
  function pct(n, d) { return (n).toFixed(d == null ? 1 : d) + '%'; }
  function monthShort(ym) { var m = ym.split('-'); return (+m[1]) + '月'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // entity-locked colors
  function cvar(n) { return C.cssVar(n); }
  var ROUTE_COLOR = { 'HOT PEPPER Beauty': '--series-1', '直接来店': '--series-2', '電話(自社)': '--series-3' };
  var STAFF_COLOR = { 'momo': '--series-1', 'aoi': '--series-2' };
  var SEG_COLOR = {
    '最優良顧客': '--series-1', '高ロイヤル顧客': '--series-4', '優良顧客': '--series-5', '安全顧客': '--series-2',
    '要注意顧客': '--series-3', '新規顧客': '--series-6', '離反間近顧客': '--series-8', '休眠顧客': '--series-7', '離脱顧客': '--series-4'
  };
  var SEG_STATUS = {
    '最優良顧客': '--status-good', '高ロイヤル顧客': '--status-good', '優良顧客': '--status-good', '安全顧客': '--status-good',
    '要注意顧客': '--status-warning', '新規顧客': '--accent', '離反間近顧客': '--status-serious', '休眠顧客': '--status-serious', '離脱顧客': '--status-critical'
  };

  // ---- card + chart mount helpers -----------------------------------------
  function card(opts) {
    // opts: {title, sub, tag, col, body(html), id}
    return '<div class="card reveal ' + (opts.col || 'col-12') + (opts.hoverable ? ' hoverable' : '') + '"' + (opts.id ? ' id="' + opts.id + '"' : '') + '>' +
      (opts.title ? '<div class="card-head"><div><div class="card-title">' + opts.title + '</div>' + (opts.sub ? '<div class="card-sub">' + opts.sub + '</div>' : '') + '</div>' + (opts.tag ? '<span class="card-tag">' + opts.tag + '</span>' : '') + '</div>' : '') +
      opts.body + '</div>';
  }
  function chartBox(id, h) { return '<div class="chart-box" id="' + id + '"' + (h ? ' style="min-height:' + h + 'px"' : '') + '></div>'; }
  // register a chart draw so resize/theme can replay it
  function draw(id, fn) { activeCharts.push(function () { var elx = document.getElementById(id); if (elx) fn(elx); }); }
  function flush(instant) {
    requestAnimationFrame(function () {
      if (instant) C.setInstant(true);
      activeCharts.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
      if (instant) requestAnimationFrame(function () { C.setInstant(false); });
    });
  }

  // ============================ OVERVIEW ===================================
  function renderOverview() {
    var A = state.analytics, s = A.store;
    var html = '';

    // Hero
    var actPct = s.revenueTotal ? s.revenueActual / s.revenueTotal * 100 : 0;
    html += '<div class="hero reveal"><div class="hero-sheen"></div><div class="hero-inner">' +
      '<div><div class="hero-eyebrow" lang="en">Reservation-based Revenue</div>' +
      '<div class="hero-value" id="heroVal">¥0</div>' +
      '<div class="hero-caption">会計済みの実績に、これからの予約（受付待ち）の見込みを合わせた<b>予約ベース売上</b>です。' + esc(s.customers) + '人の来店顧客・' + esc(A.meta.periodStart) + '〜' + esc(A.meta.periodEnd) + '。</div>' +
      '<div class="hero-split"><div class="hero-split-bar"><i class="actual" id="heroActual"></i><i class="expected" id="heroExpected"></i></div>' +
      '<div class="hero-split-legend"><span><i style="background:rgba(255,255,255,.95)"></i>会計済み <b>' + yen(s.revenueActual) + '</b></span><span><i class="expected-key"></i>受付待ち（見込み） <b>' + yen(s.revenueExpected) + '</b></span></div></div></div>' +
      '<div class="hero-metrics">' +
      heroMetric(s.effectiveReservations, '件', '有効予約数') +
      heroMetric(F.int(s.avgSpendReservation), '¥', '予約ベース客単価', true) +
      heroMetric(s.actualVisits, '件', '会計済み来店') +
      heroMetric(s.expectedFuture, '件', 'これからの予約') +
      '</div></div></div>';

    // Stat tiles
    var ltvDelta = s.ltv.predicted - s.ltv.current;
    html += statTile('🎟️', '有効予約数', F.int(s.effectiveReservations), '件', '会計済 ' + s.actualVisits + ' ／ 予定 ' + s.expectedFuture + '（滞留 ' + s.staleExcluded + ' 除外）', 'sparkRes');
    html += statTile('💴', '予約ベース客単価', F.int(s.avgSpendReservation), '¥', '実績客単価 ' + yen(s.avgSpendActual), 'sparkSpend');
    html += statTile('💠', '顧客LTV（現状）', F.int(s.ltv.current), '¥', '<span class="chip up">▲ 予測 ' + yen(s.ltv.predicted) + '</span> 期待来店 ' + s.ltv.expectedVisits + '回', null);
    html += statTile('🚫', '総キャンセル率', pct(s.cancel.totalRate * 100, 1), '%', '確定 ' + s.cancel.confirmed + '件 ／ 初回来店なし ' + s.cancel.firstNoVisit + '件', 'sparkCancel');

    // Retention meters + monthly revenue
    html += card({
      col: 'col-5', title: '定着・リピート', sub: '来店顧客 ' + s.customers + '人が母数',
      body: '<div id="mRepeat"></div><div id="mNext"></div><div id="mFix"></div>' +
        '<div class="note-inline" style="margin-top:10px">来店周期の中央値 <b>' + s.visitCycleMedianDays + '日</b>。目安ラインは業界基準値です。</div>'
    });
    html += card({
      col: 'col-7', title: '月次 予約ベース売上', sub: '会計済み（実績）＋ 受付待ち（見込み）', tag: '¥',
      body: chartBox('cRevenue', 260)
    });

    // Funnel + cohort
    html += card({
      col: 'col-5', title: 'リテンション ファネル', sub: '1回 → 5回 到達（次回予約を確保した顧客）',
      body: '<div id="cFunnel"></div>'
    });
    html += card({
      col: 'col-7', title: 'コホート 2回目到達率', sub: '初回来店した月ごとの、2回目に到達した割合', tag: '%',
      body: chartBox('cCohort', 230)
    });

    // Route + cancel + visit-count
    html += card({ col: 'col-4', title: '集客経路', sub: '有効予約に占める構成', body: chartBox('cRoute', 210) });
    html += card({ col: 'col-4', title: 'キャンセル内訳', sub: '確定予約 ' + s.cancel.confirmed + '件に対する割合', body: chartBox('cCancel', 210) });
    html += card({ col: 'col-4', title: '来店回数の構成', sub: '延べ来店を回数別に分解', body: '<div id="cVisitComp"></div>' });

    mount('overview', '<div class="grid">' + html + '</div>');

    // draw
    C.countUp($('#heroVal'), s.revenueTotal, { fmt: yen });
    setTimeout(function () { var a = $('#heroActual'), e = $('#heroExpected'); if (a) a.style.width = actPct + '%'; if (e) e.style.width = (100 - actPct) + '%'; }, 60);
    tileSpark('sparkRes', s.monthly.map(function (m) { return m.res; }));
    tileSpark('sparkSpend', s.monthly.map(function (m) { return m.spend; }));
    tileSpark('sparkCancel', s.monthly.filter(function (m) { return m.cancel != null; }).map(function (m) { return m.cancel * 100; }));

    draw('mRepeat', function (el) { C.meter(el, { label: 'リピート率（2回到達）', value: s.repeatRate / 100, display: pct(s.repeatRate), target: 0.5, sub: '目安 50%' }); });
    draw('mNext', function (el) { C.meter(el, { label: '次回予約取得率 ★', value: s.nextReserveRate / 100, display: pct(s.nextReserveRate), target: 0.55, sub: '来店時に次の予約を取った割合' }); });
    draw('mFix', function (el) { C.meter(el, { label: '固定化率（3回以上）', value: s.fixationRate / 100, display: pct(s.fixationRate), target: 0.2, sub: '目安 20%' }); });

    draw('cRevenue', function (el) {
      C.columns(el, {
        groups: s.monthly.map(function (m) { return monthShort(m.m); }), stacked: true,
        series: [
          { name: '実績（会計済み）', color: cvar('--series-1'), values: s.monthly.map(function (m) { return m.actual ? m.rev * (m.actual / (m.res || 1)) : (m.exp ? 0 : m.rev) }) },
          { name: '見込み（受付待ち）', color: cvar('--funnel-2'), values: s.monthly.map(function (m) { return m.exp ? m.rev * (m.exp / (m.res || 1)) : 0 }) }
        ],
        valueFmt: function (v) { return yen(Math.round(v)); }, yFmt: F.compact, height: 260
      });
    });
    draw('cCohort', function (el) {
      C.columns(el, {
        groups: s.cohort.map(function (c) { return monthShort(c.m); }),
        series: [{ name: '2回到達率', color: cvar('--series-1'), values: s.cohort.map(function (c) { return c.reach2 * 100; }) }],
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, yMax: 100, height: 230
      });
    });
    draw('cFunnel', function (el) {
      C.funnel(el, {
        stages: s.funnel.map(function (f, i) { return { label: f.n + '回', value: f.people, sub: pct(f.reach * 100, 0) + ' 到達' }; })
      });
    });
    draw('cRoute', function (el) {
      C.donut(el, {
        segments: s.route.map(function (r) { return { label: r.name, value: r.eff, color: cvar(ROUTE_COLOR[r.name] || '--series-6') }; }),
        centerValue: F.int(s.effectiveReservations), centerLabel: '有効予約', valueFmt: function (v) { return v + '件'; }, height: 210
      });
    });
    draw('cCancel', function (el) {
      C.donut(el, {
        segments: [
          { label: 'お客様都合', value: s.cancel.customerCount, color: cvar('--series-1') },
          { label: 'サロン都合', value: s.cancel.salonCount, color: cvar('--series-2') },
          { label: '無断', value: s.cancel.noShowCount, color: cvar('--series-3') }
        ], centerValue: pct(s.cancel.totalRate * 100, 1), centerLabel: '総キャンセル率', valueFmt: function (v) { return v + '件'; }, height: 210
      });
    });
    draw('cVisitComp', function (el) {
      C.hbars(el, {
        items: s.visitCountBreakdown.map(function (b, i) { return { label: b.label, value: b.count, sub: '客単価 ' + yen(b.spend), color: cvar(['--funnel-2', '--funnel-3', '--funnel-4', '--funnel-5'][i]) }; }),
        valueFmt: function (v) { return v + '件'; }
      });
    });
    flush();
  }
  function heroMetric(v, unit, label, isYen) {
    return '<div class="hero-metric"><b>' + (isYen ? '¥' : '') + v + (unit && !isYen ? '<span style="font-size:.55em;opacity:.7"> ' + unit + '</span>' : '') + '</b><span>' + label + '</span></div>';
  }
  function statTile(ico, label, value, unit, foot, sparkId) {
    return card({
      col: 'col-3', hoverable: true,
      body: '<div class="stat"><div class="stat-top"><span class="stat-ico">' + ico + '</span><span class="stat-label">' + label + '</span></div>' +
        '<div class="stat-value">' + (unit === '¥' ? '¥' : '') + '<span class="cu" data-to="' + (typeof value === 'string' ? value.replace(/[^\d.]/g, '') : value) + '" data-unit="' + (unit === '¥' ? 'yen' : (unit === '%' ? 'pct' : 'int')) + '">' + value + '</span>' + (unit && unit !== '¥' ? '<span class="unit">' + unit + '</span>' : '') + '</div>' +
        (sparkId ? '<div class="spark" id="' + sparkId + '"></div>' : '') +
        '<div class="stat-foot">' + foot + '</div></div>'
    });
  }
  function tileSpark(id, values) { draw(id, function (el) { C.sparkline(el, values, cvar('--series-1')); }); }

  // ============================ STAFF ======================================
  function renderStaff() {
    var A = state.analytics, months = A.store.monthly.map(function (m) { return monthShort(m.m); });
    var staff = A.staff;
    var head = '<div class="view-title">スタッフ ダッシュボード</div><div class="view-lead">累計ではなく月次と平均で評価。キャンセル率は来店客のみ（初回来店なしは除外）。</div>';
    var html = '';

    staff.forEach(function (st, i) {
      var col = cvar(STAFF_COLOR[st.name] || '--series-6');
      html += card({
        col: 'col-6', hoverable: true,
        body: '<div class="staff-head"><div class="staff-avatar" style="background:' + col + '">' + esc(st.name[0].toUpperCase()) + '</div>' +
          '<div><div class="staff-name">' + esc(st.name) + '<span>実績 ' + st.avg.months + 'ヶ月 ・ 獲得顧客 ' + st.acquired + '人</span></div></div></div>' +
          '<div class="staff-metrics">' +
          sm(F.int(st.avg.visitsPerMonth), '平均来店 / 月') + sm('¥' + F.int(st.avg.revPerMonth), '平均売上 / 月') +
          sm('¥' + F.int(st.avg.spend), '平均客単価') + sm(pct(st.avg.newPerMonth, 1).replace('%', ''), '平均新規 / 月') +
          '</div>' +
          '<div id="stMeter' + i + '" style="margin-top:14px"></div>'
      });
    });

    html += card({ col: 'col-6', title: '月次 予約数の比較', tag: '件', body: chartBox('cStaffRes', 240) });
    html += card({ col: 'col-6', title: '月次 予約ベース売上の比較', tag: '¥', body: chartBox('cStaffRev', 240) });
    html += card({ col: 'col-6', title: '客単価の推移', tag: '¥', body: chartBox('cStaffSpend', 230) });
    html += card({ col: 'col-6', title: '次回予約取得率の推移', tag: '%', body: chartBox('cStaffNext', 230) });
    html += card({ col: 'col-12', title: 'リピート育成力', sub: '初回担当者を基準にした、2〜4回目への到達率', body: chartBox('cStaffRepeat', 200) });

    mount('staff', head + '<div class="grid">' + html + '</div>');

    staff.forEach(function (st, i) {
      draw('stMeter' + i, function (el) {
        C.meter(el, { label: '次回予約取得率', value: st.avg.nextRes, display: pct(st.avg.nextRes * 100), color: cvar(STAFF_COLOR[st.name]), sub: '平均キャンセル率（来店客）' + pct(st.avg.cancel * 100) });
      });
    });
    var seriesRes = staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.res; }) }; });
    draw('cStaffRes', function (el) { C.columns(el, { groups: months, series: seriesRes, valueFmt: function (v) { return v + '件'; }, height: 240 }); });
    draw('cStaffRev', function (el) { C.columns(el, { groups: months, series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.rev; }) }; }), valueFmt: function (v) { return yen(v); }, yFmt: F.compact, height: 240 }); });
    draw('cStaffSpend', function (el) { C.lineArea(el, { xLabels: months, area: false, series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.spend; }) }; }), valueFmt: yen, yFmt: F.compact, height: 230 }); });
    draw('cStaffNext', function (el) {
      C.lineArea(el, {
        xLabels: months, area: false, yMax: 100,
        series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.nextRes == null ? 0 : m.nextRes * 100; }) }; }),
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230
      });
    });
    draw('cStaffRepeat', function (el) {
      C.columns(el, {
        groups: ['2回目到達', '3回目到達', '4回目到達'],
        series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: [st.reach2 * 100, st.reach3 * 100, st.reach4 * 100] }; }),
        valueFmt: function (v) { return v.toFixed(1) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, yMax: 100, height: 200
      });
    });
    flush();
  }
  function sm(v, label) { return '<div class="staff-metric"><b>' + v + '</b><span>' + label + '</span></div>'; }

  // ============================ TREND ======================================
  var trendMetric = 'visits';
  function renderTrend() {
    var A = state.analytics, t = A.trend;
    var head = '<div class="view-title">傾向分析</div><div class="view-lead">曜日・初回獲得月・クーポン別に、次回予約率とLTVの傾向を読み解きます。</div>';
    var html = '';

    html += card({
      col: 'col-12', title: '曜日別パフォーマンス', sub: '来店の多い曜日と、定着しやすい曜日を把握',
      body: '<div class="segmented" id="dowSeg" role="tablist">' +
        [['visits', '来店数'], ['nextRes', '次回予約率'], ['spend', '客単価'], ['ltv', 'LTV']].map(function (o, i) { return '<button role="tab" data-m="' + o[0] + '"' + (i === 0 ? ' class="active"' : '') + '>' + o[1] + '</button>'; }).join('') +
        '<span class="seg-thumb" id="dowThumb"></span></div>' + chartBox('cDow', 250)
    });
    html += card({ col: 'col-6', title: '月次コホート リピート率', sub: '初回獲得月ごとの2回目到達', tag: '%', body: chartBox('cTCohortR', 220) });
    html += card({ col: 'col-6', title: '月次コホート LTV', sub: '初回獲得月ごとの累計売上', tag: '¥', body: chartBox('cTCohortL', 220) });
    html += card({ col: 'col-12', title: '人気クーポン TOP', sub: '初回獲得クーポン別のリピート率とLTV', body: '<div id="cCoupon"></div>' });

    mount('trend', head + '<div class="grid">' + html + '</div>');

    drawDow();
    draw('cTCohortR', function (el) {
      C.lineArea(el, { xLabels: t.monthlyCohort.map(function (c) { return monthShort(c.m); }), yMax: 100, series: [{ name: 'リピート率', color: cvar('--series-1'), values: t.monthlyCohort.map(function (c) { return c.repeat * 100; }) }], valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 220 });
    });
    draw('cTCohortL', function (el) {
      C.columns(el, { groups: t.monthlyCohort.map(function (c) { return monthShort(c.m); }), series: [{ name: 'LTV', color: cvar('--series-4'), values: t.monthlyCohort.map(function (c) { return c.ltv; }) }], valueFmt: yen, yFmt: F.compact, height: 220 });
    });
    draw('cCoupon', function (el) {
      var top = t.coupons.slice(0, 8);
      C.hbars(el, { items: top.map(function (c) { return { label: shortCoupon(c.coupon), value: c.n, sub: 'リピート ' + pct(c.repeat * 100, 0) + ' ・ LTV ' + yen(c.ltv), color: cvar('--series-1') }; }), valueFmt: function (v) { return v + '人'; } });
    });
    // segmented control
    var seg = $('#dowSeg');
    seg.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; trendMetric = b.dataset.m; Array.prototype.forEach.call(seg.querySelectorAll('button'), function (x) { x.classList.toggle('active', x === b); }); positionThumb(); drawDow(); flush(); });
    positionThumb();
    flush();
  }
  function positionThumb() {
    var seg = $('#dowSeg'); if (!seg) return; var active = seg.querySelector('button.active'), thumb = $('#dowThumb');
    if (active && thumb) { thumb.style.width = active.offsetWidth + 'px'; thumb.style.transform = 'translateX(' + (active.offsetLeft - 3) + 'px)'; }
  }
  function drawDow() {
    var t = state.analytics.trend;
    var meta = { visits: { fmt: function (v) { return v + '件'; }, name: '来店数', color: '--series-1', max: null, pct: false }, nextRes: { fmt: function (v) { return v.toFixed(0) + '%'; }, name: '次回予約率', color: '--series-2', max: 100, pct: true }, spend: { fmt: yen, name: '客単価', color: '--series-3', max: null, pct: false }, ltv: { fmt: yen, name: 'LTV', color: '--series-4', max: null, pct: false } }[trendMetric];
    activeCharts = activeCharts.filter(function () { return true; });
    draw('cDow', function (el) {
      C.columns(el, {
        groups: t.dayOfWeek.map(function (d) { return d.d; }),
        series: [{ name: meta.name, color: cvar(meta.color), values: t.dayOfWeek.map(function (d) { return meta.pct ? d[trendMetric] * 100 : d[trendMetric]; }) }],
        valueFmt: meta.fmt, yFmt: meta.pct ? function (v) { return v.toFixed(0) + '%'; } : F.compact, yMax: meta.max, height: 250
      });
    });
  }
  function shortCoupon(s) { s = String(s); return s.length > 28 ? s.slice(0, 27) + '…' : s; }

  // ============================ RFM ========================================
  var rfmSort = { key: 'M', dir: -1 };
  function renderRFM() {
    var A = state.analytics, r = A.rfm;
    var html = '<div class="view-title">顧客 RFM 分析</div><div class="view-lead">最終来店(R)・来店回数(F)・累計売上(M)で顧客を9つのセグメントに分類。' + r.total + '人の来店顧客が対象。</div>';

    // segment cards
    html += '<div class="section-title">セグメント サマリー</div>';
    html += '<div class="seg-grid reveal" style="margin-top:10px">' + r.segments.map(function (sg) {
      var col = cvar(SEG_COLOR[sg.seg] || '--series-6'), st = cvar(SEG_STATUS[sg.seg] || '--accent');
      return '<div class="seg-card" style="--seg-color:' + col + '">' +
        '<div class="seg-name"><span class="seg-dot"></span>' + esc(sg.label) + '<span class="seg-status" style="background:' + st + '"></span></div>' +
        '<div class="seg-people tnum">' + sg.people + '<small> 人 ・ ' + pct(sg.ratio * 100, 1) + '</small></div>' +
        '<div class="seg-ratio"><i style="width:' + Math.max(2, sg.ratio * 100) + '%"></i></div>' +
        '<div class="seg-rfm"><span>R <b>' + (sg.people ? sg.r + '日' : '—') + '</b></span><span>F <b>' + (sg.people ? sg.f + '回' : '—') + '</b></span><span>M <b>' + (sg.people ? '¥' + F.compact(sg.m) : '—') + '</b></span></div>' +
        '<div class="seg-action">' + esc(sg.action) + '</div></div>';
    }).join('') + '</div>';

    // heatmap + distribution
    html += '<div class="grid" style="margin-top:16px">';
    html += card({ col: 'col-6', title: 'F × R セグメントマップ', sub: '縦=来店回数(F) ／ 横=最終来店(R・5が最近)。数字＝人数', body: chartBox('cHeat', 0) });
    html += card({ col: 'col-6', title: 'セグメント構成', sub: '人数の多い順', body: '<div id="cSegBars"></div>' });
    html += '</div>';

    // customer table
    html += '<div class="section-title">顧客 RFM 明細</div>';
    html += '<div class="grid">' + card({ col: 'col-12', sub: '累計売上(M)順・上位120人を表示。ヘッダーをタップで並べ替え。', title: '顧客一覧', body: '<div class="table-wrap tall"><table class="kate-table" id="rfmTable"></table></div>' }) + '</div>';

    mount('rfm', html);

    r.segments.forEach(function (sg, i) { var elx = document.querySelectorAll('.seg-ratio i')[i]; if (elx) setTimeout(function () { elx.style.width = Math.max(2, sg.ratio * 100) + '%'; }, 120 + i * 40); });
    draw('cHeat', function (el) {
      C.heatmap(el, { matrix: r.map, rowLabels: ['F5', 'F4', 'F3', 'F2', 'F1'], colLabels: ['R1', 'R2', 'R3', 'R4', 'R5'], hue: cvar('--seq-5') });
    });
    draw('cSegBars', function (el) {
      var sorted = r.segments.slice().filter(function (s) { return s.people > 0; }).sort(function (a, b) { return b.people - a.people; });
      C.hbars(el, { items: sorted.map(function (sg) { return { label: sg.label, value: sg.people, sub: pct(sg.ratio * 100, 1), color: cvar(SEG_COLOR[sg.seg]) }; }), valueFmt: function (v) { return v + '人'; } });
    });
    buildRfmTable();
    flush();
  }
  function buildRfmTable() {
    var r = state.analytics.rfm;
    var rows = r.customers.slice().sort(function (a, b) { var k = rfmSort.key; return (a[k] - b[k]) * rfmSort.dir; }).slice(0, 120);
    var cols = [['name', 'お名前'], ['R', 'R (日)'], ['F', 'F (回)'], ['M', 'M (¥)'], ['seg', 'セグメント']];
    var thead = '<thead><tr>' + cols.map(function (c) { return '<th data-k="' + c[0] + '"' + (rfmSort.key === c[0] ? ' class="sorted' + (rfmSort.dir > 0 ? ' asc' : '') + '"' : '') + '>' + c[1] + '</th>'; }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (c) {
      var col = cvar(SEG_COLOR[c.seg] || '--series-6');
      return '<tr><td>' + esc(c.name) + '</td><td>' + c.R + '</td><td>' + c.F + '</td><td>' + F.int(c.M) + '</td>' +
        '<td style="text-align:left"><span class="seg-tag"><i style="background:' + col + '"></i>' + esc(c.seg) + '</span></td></tr>';
    }).join('') + '</tbody>';
    var table = $('#rfmTable'); table.innerHTML = thead + tbody;
    Array.prototype.forEach.call(table.querySelectorAll('th'), function (th) {
      th.addEventListener('click', function () { var k = th.dataset.k; if (rfmSort.key === k) rfmSort.dir *= -1; else { rfmSort.key = k; rfmSort.dir = k === 'name' ? 1 : -1; } buildRfmTable(); });
    });
  }

  // ============================ DATA =======================================
  function renderData() {
    var A = state.analytics, m = A.meta;
    var head = '<div class="view-title">データ入力</div><div class="view-lead">「予約データ」シートの形式のファイル（CSV / Excel）を入れるだけで、すべての指標を自動で再計算します。</div>';
    var html = '';
    html += card({
      col: 'col-12',
      body: '<div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="ファイルをアップロード">' +
        '<div class="dropzone-ico">⬆️</div><h3>予約データをドロップ、またはタップして選択</h3>' +
        '<p>対応形式：<b>.xlsx</b> / <b>.csv</b>　（「予約データ」シートの見出し行を含めてください）</p>' +
        '<button class="pill accent" id="pickBtn" type="button">ファイルを選択</button>' +
        '<button class="pill" id="resetBtn" type="button" style="margin-left:8px">サンプルに戻す</button></div>'
    });
    html += card({
      col: 'col-6', title: '現在のデータ', sub: 'ブラウザ内でのみ処理されます',
      body: '<div class="datainfo">' +
        '<div><span>データソース</span><b>' + esc(state.fileName || state.source) + '</b></div>' +
        '<div><span>取込件数</span><b class="tnum">' + F.int(m.totalRows) + '件</b></div>' +
        '<div><span>有効予約</span><b class="tnum">' + F.int(A.store.effectiveReservations) + '件</b></div>' +
        '<div><span>来店顧客</span><b class="tnum">' + F.int(A.store.customers) + '人</b></div>' +
        '<div><span>対象期間</span><b>' + esc(m.periodStart) + ' 〜 ' + esc(m.periodEnd) + '</b></div>' +
        '<div><span>集計基準日</span><b>' + esc(m.asOf) + '</b></div></div>'
    });
    html += card({
      col: 'col-6', title: '認識した列', sub: '予約データの主要列を自動でマッピング',
      body: '<div class="map-chips">' + ['ステータス', '来店日', 'スタッフ名', '予約経路', 'フリガナ', '予約時合計金額', '会計時合計金額', '予約時メニュー'].map(function (h) { return '<span class="map-chip"><i></i>' + h + '</span>'; }).join('') + '</div>'
    });
    html += card({
      col: 'col-12', title: '指標の計算ロジック', sub: '元のKPIワークブックの定義に準拠',
      body: '<ul class="how">' +
        '<li><b>予約ベース売上</b> ＝ 会計済みの<code>会計時合計金額</code>（実績）＋ 基準日より後の受付待ちの<code>予約時合計金額</code>（見込み）。</li>' +
        '<li><b>有効予約</b> ＝ 会計済み ＋ これからの受付待ち予約。基準日以前の未処理（滞留）は除外。</li>' +
        '<li><b>顧客の識別</b>：<code>フリガナ</code>で名寄せ。リピート／RFMの母数は来店実績のある顧客。</li>' +
        '<li><b>リピート率</b>：来店顧客のうち2回目の予約（会計済み＋今後の予約）を確保した割合。<b>RFMのF</b>は実来店回数。</li>' +
        '<li><b>RFM</b>：R＝最終来店からの日数、F＝来店回数、M＝累計売上。9セグメントに自動分類。</li>' +
        '<li>個人情報を含むデータはすべて<b>ブラウザ内で処理</b>され、サーバーには送信されません。</li>' +
        '</ul>'
    });
    mount('data', head + '<div class="grid">' + html + '</div>');
    wireUpload();
  }

  function wireUpload() {
    var dz = $('#dropzone'), input = $('#fileInput');
    if ($('#pickBtn')) $('#pickBtn').addEventListener('click', function (e) { e.stopPropagation(); input.click(); });
    if ($('#resetBtn')) $('#resetBtn').addEventListener('click', function (e) { e.stopPropagation(); loadSample(); toast('サンプルデータに戻しました', 'ok'); });
    dz.addEventListener('click', function () { input.click(); });
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return; dz.classList.remove('drag'); }); });
    dz.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) handleFile(f); });
    input.onchange = function () { if (input.files[0]) handleFile(input.files[0]); input.value = ''; };
  }
  function handleFile(file) {
    toast('読み込み中…');
    global.KATE.ingest.parseFile(file).then(function (recs) {
      var A = global.KATE.engine.compute(recs);
      state.data = recs; state.analytics = A; state.source = 'アップロード'; state.fileName = file.name;
      updateChrome(); renderAll(); route(state.view, true);
      toast('✓ ' + F.int(recs.length) + '件を再計算しました', 'ok');
    }).catch(function (err) { console.error(err); toast('⚠ ' + (err.message || '読み込みに失敗しました'), 'err'); });
  }

  // ============================ shell ======================================
  function mount(view, html) { var v = $('#view-' + view); v.innerHTML = html; observeReveal(v); }
  function renderAll() {
    // (re)render only the active view for performance; others render on demand
    activeCharts = [];
    ({ overview: renderOverview, staff: renderStaff, trend: renderTrend, rfm: renderRFM, data: renderData }[state.view])();
    // count-up any stat tiles
    Array.prototype.forEach.call(document.querySelectorAll('#view-' + state.view + ' .cu'), function (n) {
      var to = parseFloat(n.dataset.to), unit = n.dataset.unit;
      C.countUp(n, to, { fmt: unit === 'yen' ? function (v) { return F.int(v); } : (unit === 'pct' ? function (v) { return v.toFixed(1); } : F.int) });
    });
  }

  function observeReveal(root) {
    // Reveal-on-mount with a capped stagger: guarantees visibility (no blank
    // below-fold cards) while keeping the entrance animation.
    var items = root.querySelectorAll('.reveal');
    requestAnimationFrame(function () {
      items.forEach(function (n, i) { n.style.transitionDelay = Math.min(i * 55, 320) + 'ms'; n.classList.add('in'); });
    });
  }

  function route(view, force) {
    if (!VIEWS.includes(view)) view = 'overview';
    if (view === state.view && !force) return;
    state.view = view;
    VIEWS.forEach(function (v) { $('#view-' + v).classList.toggle('active', v === view); });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { var on = t.dataset.view === view; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
    Array.prototype.forEach.call(document.querySelectorAll('.botnav button'), function (b) { b.classList.toggle('active', b.dataset.view === view); });
    moveUnderline();
    global.scrollTo({ top: 0, behavior: 'auto' });
    if (global.location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    renderAll();
  }
  function moveUnderline() {
    var active = document.querySelector('.tab.active'), u = $('#tabUnderline');
    if (active && u) { u.style.width = active.offsetWidth + 'px'; u.style.transform = 'translateX(' + active.offsetLeft + 'px)'; }
  }

  function updateChrome() {
    $('#asof').textContent = '基準日 ' + (state.analytics.meta.asOf || '');
    $('#dataBadgeText').textContent = state.fileName || state.source;
  }
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('kate-theme', t); } catch (e) {}
    var ic = $('#themeIcon');
    if (t === 'dark') ic.innerHTML = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>';
    else ic.innerHTML = '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>';
  }

  var toastTimer;
  function toast(msg, kind) {
    var t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  function loadSample() {
    var recs = global.KATE.SAMPLE_RESERVATIONS;
    state.data = recs; state.analytics = global.KATE.engine.compute(recs, { asOf: '2026-07-03' });
    state.source = 'サンプルデータ'; state.fileName = null;
    updateChrome(); renderAll();
  }

  // ---- boot ----------------------------------------------------------------
  function boot() {
    var saved; try { saved = localStorage.getItem('kate-theme'); } catch (e) {}
    setTheme(saved || (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

    loadSample();

    // nav
    Array.prototype.forEach.call(document.querySelectorAll('.tab, .botnav button'), function (b) {
      b.addEventListener('click', function () { route(b.dataset.view); });
    });
    // keyboard on tablist
    $('#tabs').addEventListener('keydown', function (e) {
      var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
      var i = tabs.indexOf(document.activeElement); if (i < 0) return;
      if (e.key === 'ArrowRight') { tabs[(i + 1) % tabs.length].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { tabs[(i - 1 + tabs.length) % tabs.length].focus(); e.preventDefault(); }
      else if (e.key === 'Home') { tabs[0].focus(); e.preventDefault(); }
      else if (e.key === 'End') { tabs[tabs.length - 1].focus(); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === ' ') { route(document.activeElement.dataset.view); }
    });
    $('#themeToggle').addEventListener('click', function () {
      setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      flush(true);  // redraw charts with new theme colors, no re-animation
    });

    // routing
    global.addEventListener('hashchange', function () { route((location.hash || '#overview').slice(1)); });
    var initial = (location.hash || '#overview').slice(1);
    route(VIEWS.includes(initial) ? initial : 'overview', true);

    // resize → debounced redraw of active view charts + underline
    var rt;
    global.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { moveUnderline(); positionThumb(); flush(true); }, 160); });
    setTimeout(moveUnderline, 60);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
