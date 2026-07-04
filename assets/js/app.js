/* ============================================================================
 * KATEstageLASH 蒲田西口店 · App
 * Orchestration: load reservations → compute analytics → render the five views
 * with the KATE chart library. Handles routing, theme, upload/ingest, resize
 * and theme-driven chart redraws. All client-side; no data leaves the browser.
 * ==========================================================================*/
(function (global) {
  'use strict';
  var C = global.KATE.charts, F = C.fmt;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var VIEWS = ['overview', 'staff', 'trend', 'rfm', 'data'];

  // sources.{yoyaku,kaikei} are `{ records, fileName, via }|null` — the two
  // upload/sheet slots that feed applySources(). `source`/`fileName` below are
  // the *displayed* label, derived from whichever slot(s) are loaded.
  var state = {
    data: null, analytics: null, view: 'overview', source: 'サンプルデータ', fileName: null,
    sheetUrl: null, sheetUrlKaikei: null, sources: { yoyaku: null, kaikei: null }, mergeReport: null
  };
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

  // ---- line icons (SF-Symbols-like, stroke = currentColor) ----------------
  var ICONS = {
    overview: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
    staff: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.7 3.1-6.2 7-6.2s7 2.5 7 6.2"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    rfm: '<circle cx="9" cy="8.5" r="3"/><path d="M3.4 19c0-3 2.5-5.2 5.6-5.2S14.6 16 14.6 19"/><path d="M16.2 5.8a3 3 0 0 1 .2 5.9"/><path d="M17.8 13.4c2.4.4 3.9 2.1 3.9 4.6"/>',
    data: '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M4.5 15v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3"/>',
    reservations: '<rect x="3.2" y="4.8" width="17.6" height="15.5" rx="2.2"/><path d="M3.2 9.4h17.6M8 3v3.4M16 3v3.4"/>',
    yen: '<path d="M8 6.5l4 5 4-5"/><path d="M12 11.5V18"/><path d="M9 13.7h6M9 16h6"/>',
    ltv: '<path d="M12 3l3.6 4.6L12 21 8.4 7.6 12 3z"/><path d="M8.4 7.6h7.2"/>',
    cancel: '<circle cx="12" cy="12" r="8.6"/><path d="M9 9l6 6M15 9l-6 6"/>',
    retail: '<path d="M6 8.5h12l-1 11.2a1.6 1.6 0 0 1-1.6 1.5H8.6A1.6 1.6 0 0 1 7 19.7L6 8.5z"/><path d="M9 8.5v-1a3 3 0 0 1 6 0v1"/>',
    upload: '<path d="M12 16V5"/><path d="M7.5 9.5 12 5l4.5 4.5"/><path d="M5 15v3.2A2.8 2.8 0 0 0 7.8 21h8.4a2.8 2.8 0 0 0 2.8-2.8V15"/>'
  };
  function svgIco(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>'; }
  function injectNavIcons() { Array.prototype.forEach.call(document.querySelectorAll('.t-ico[data-ico]'), function (s) { if (!s.firstChild) s.innerHTML = svgIco(s.dataset.ico); }); }

  // ---- career milestones (Phase 3 — self-growth, never compared between staff) --
  var MILESTONES = {
    visits: [50, 100, 250, 500, 1000, 2000],
    shimei: [5, 10, 25, 50, 100],
    retail: [3, 5, 10, 25, 50],
    regulars: [5, 10, 25, 50, 100]
  };
  function milestoneProgress(value, thresholds) {
    for (var i = 0; i < thresholds.length; i++) {
      if (value < thresholds[i]) {
        var prev = i ? thresholds[i - 1] : 0;
        return { next: thresholds[i], frac: (value - prev) / (thresholds[i] - prev), maxed: false };
      }
    }
    return { next: thresholds[thresholds.length - 1], frac: 1, maxed: true };
  }

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
    var head = '<div class="view-title">店舗ダッシュボード</div><div class="view-lead">' + esc(A.meta.periodStart) + '〜' + esc(A.meta.periodEnd) + ' ／ 来店顧客 ' + esc(s.customers) + '人・基準日 ' + esc(A.meta.asOf) + '。</div>';
    var html = '';

    // KPI tile row (revenue KGI & effective-reservation count intentionally omitted)
    var rt = s.retail;
    html += statTile('yen', '予約ベース客単価', F.int(s.avgSpendReservation), '¥', '実績客単価 ' + yen(s.avgSpendActual), 'sparkSpend');
    html += statTile('ltv', '顧客LTV（現状）', F.int(s.ltv.current), '¥', '<span class="chip up">↑ 予測 ' + yen(s.ltv.predicted) + '</span> 期待来店 ' + s.ltv.expectedVisits + '回', null);
    if (s.cancel.hasInfo) {
      html += statTile('cancel', '総キャンセル率', pct(s.cancel.totalRate * 100, 1), '%', 'HOT PEPPER Beauty を除く ／ 確定 ' + s.cancel.confirmed + '件', 'sparkCancel');
    } else {
      html += statTile('cancel', '総キャンセル率', '—', '', 'この データにはキャンセル情報が含まれていません（会計実績のみ）', null);
    }
    html += statTile('retail', '店販顧客比率', pct(rt.customerRatio * 100, 1), '%', '店販購入 ' + rt.buyers + '人 ／ 来店顧客 ' + rt.visitCustomers + '人', null, 'retail-customer-ratio');

    // Retention meters + monthly revenue
    var matNote = s.maturity.applied
      ? 'リピート率・固定化率は、初回来店から45日以上の顧客 <b data-kpi="maturity-n">' + s.maturity.matureCustomers + '</b>人が母数（直近の新規のお客様は集計対象外）。次回予約取得率は来店全体が対象です。'
      : null;
    html += card({
      col: 'col-5', title: '定着・リピート',
      sub: s.maturity.applied ? 'リピート率・固定化率は成熟顧客 ' + s.maturity.matureCustomers + '人が母数' : '来店顧客 ' + s.customers + '人が母数',
      body: '<div id="mRepeat" data-kpi="repeat-rate"></div><div id="mNext" data-kpi="next-reserve-rate"></div><div id="mFix" data-kpi="fixation-rate"></div>' +
        '<div class="note-inline" style="margin-top:10px">来店周期の中央値 <b>' + s.visitCycleMedianDays + '日</b>。目安ラインは業界基準値です。</div>' +
        (matNote ? '<div class="note-inline" style="margin-top:5px">' + matNote + '</div>' : '')
    });
    html += card({
      col: 'col-7', title: '月次 予約ベース売上', sub: '会計済み（実績）＋ 受付待ち（見込み）', tag: '¥',
      body: chartBox('cRevenue', 260)
    });

    // Funnel + cohort
    html += card({
      col: 'col-5', title: 'リテンション ファネル',
      sub: s.maturity.applied
        ? '初回来店から45日以上の顧客 ' + s.maturity.matureCustomers + '人が母数（次回予約を確保した顧客）'
        : '1回 → 5回 到達（次回予約を確保した顧客）',
      body: '<div id="cFunnel"></div>'
    });
    html += card({
      col: 'col-7', title: 'コホート 2回目到達率', sub: '初回来店した月ごとの、2回目に到達した割合' + (s.maturity.applied ? '（直近の未成熟な月は除外）' : ''), tag: '%',
      body: chartBox('cCohort', 230)
    });

    // 店販 + 新規/再来 + route + visit-count
    html += card({
      col: 'col-6', title: '店販（物販）実績', sub: rt.hasAmount ? '会計時店販金額をもとに算出' : '商品名から購入率のみ算出中',
      body: '<div class="mini-stats" style="margin-bottom:6px">' +
        miniStat(pct(rt.customerRatio * 100, 1), '店販顧客比率', 'retail-customer-ratio') +
        miniStat(rt.amount != null ? yen(rt.amount) : '—', '店販金額', 'retail-amount') +
        miniStat(rt.revenueRatio != null ? pct(rt.revenueRatio * 100, 1) : '—', '店販売上比率', 'retail-revenue-ratio') +
        miniStat(rt.avgSpend != null ? yen(rt.avgSpend) : '—', '店販単価', 'retail-avg-spend') +
        '</div>' + (rt.hasAmount ? '' : '<div class="note-inline" style="margin-top:12px">金額・売上比率・単価は、スプレッドシートに <b>「会計時店販金額」</b> 列を追加すると自動表示されます。</div>')
    });
    var lastMix = s.newMix.filter(function (m) { return m.new + m.repeat > 0; }).slice(-1)[0];
    var mixNote = lastMix && (lastMix.new + lastMix.repeat) ? '直近月（' + monthShort(lastMix.m) + '）の再来比率 ' + pct(lastMix.repeat / (lastMix.new + lastMix.repeat) * 100, 0) : '月次の新規・再来来店数';
    html += card({ col: 'col-6', title: '新規・再来', sub: mixNote, tag: '件', body: chartBox('cNewMix', 210) });
    html += card({ col: 'col-6', title: '集客経路', sub: '有効予約に占める構成', body: chartBox('cRoute', 210) });
    html += card({ col: 'col-6', title: '来店回数の構成', sub: '回数別', body: '<div id="cVisitComp"></div>' });

    mount('overview', head + '<div class="grid">' + html + '</div>');

    // draw
    tileSpark('sparkSpend', s.monthly.map(function (m) { return m.spend; }));
    tileSpark('sparkCancel', s.monthly.filter(function (m) { return m.cancel != null; }).map(function (m) { return m.cancel * 100; }));

    draw('mRepeat', function (el) { C.meter(el, { label: 'リピート率（2回到達）', value: s.repeatRate / 100, display: pct(s.repeatRate), target: 0.7, sub: '目安 70%' }); });
    draw('mNext', function (el) { C.meter(el, { label: '次回予約取得率', value: s.nextReserveRate / 100, display: pct(s.nextReserveRate), target: 0.6, sub: '目安 60%（来店時に次の予約を取った割合）' }); });
    draw('mFix', function (el) { C.meter(el, { label: '固定化率（3回以上）', value: s.fixationRate / 100, display: pct(s.fixationRate), target: 0.3, sub: '目安 30%' }); });

    draw('cRevenue', function (el) {
      C.columns(el, {
        groups: s.monthly.map(function (m) { return monthShort(m.m); }), stacked: true,
        series: [
          { name: '実績（会計済み）', color: cvar('--series-1'), values: s.monthly.map(function (m) { return m.revActual; }) },
          { name: '見込み（受付待ち）', color: cvar('--funnel-2'), values: s.monthly.map(function (m) { return m.revExpected; }) }
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
    draw('cVisitComp', function (el) {
      C.hbars(el, {
        items: s.visitCountBreakdown.map(function (b, i) { return { label: b.label, value: b.count, sub: '客単価 ' + yen(b.spend), color: cvar(['--funnel-2', '--funnel-3', '--funnel-4', '--funnel-5'][i]) }; }),
        valueFmt: function (v) { return v + '件'; }
      });
    });
    draw('cNewMix', function (el) {
      C.columns(el, {
        groups: s.newMix.map(function (m) { return monthShort(m.m); }), stacked: true,
        series: [
          { name: '新規', color: cvar('--series-1'), values: s.newMix.map(function (m) { return m.new; }) },
          { name: '再来', color: cvar('--series-2'), values: s.newMix.map(function (m) { return m.repeat; }) }
        ],
        valueFmt: function (v) { return v + '件'; }, height: 210
      });
    });
    flush();
  }
  function heroMetric(v, unit, label, isYen) {
    return '<div class="hero-metric"><b>' + (isYen ? '¥' : '') + v + (unit && !isYen ? '<span style="font-size:.55em;opacity:.7"> ' + unit + '</span>' : '') + '</b><span>' + label + '</span></div>';
  }
  function statTile(ico, label, value, unit, foot, sparkId, dataKpi) {
    return card({
      col: 'col-3', hoverable: true,
      body: '<div class="stat"' + (dataKpi ? ' data-kpi="' + dataKpi + '"' : '') + '><div class="stat-top"><span class="stat-ico">' + svgIco(ico) + '</span><span class="stat-label">' + label + '</span></div>' +
        '<div class="stat-value">' + (unit === '¥' ? '¥' : '') + '<span class="cu" data-to="' + (typeof value === 'string' ? value.replace(/[^\d.]/g, '') : value) + '" data-unit="' + (unit === '¥' ? 'yen' : (unit === '%' ? 'pct' : 'int')) + '">' + value + '</span>' + (unit && unit !== '¥' ? '<span class="unit">' + unit + '</span>' : '') + '</div>' +
        (sparkId ? '<div class="spark" id="' + sparkId + '"></div>' : '') +
        '<div class="stat-foot">' + foot + '</div></div>'
    });
  }
  function tileSpark(id, values) { draw(id, function (el) { C.sparkline(el, values, cvar('--series-1')); }); }
  function miniStat(v, label, dataKpi) { return '<div class="mini-stat"' + (dataKpi ? ' data-kpi="' + dataKpi + '"' : '') + '><b>' + v + '</b><span>' + label + '</span></div>'; }

  // ============================ STAFF ======================================
  function renderStaff() {
    var A = state.analytics, months = A.store.monthly.map(function (m) { return monthShort(m.m); });
    var staff = A.staff;
    var asOfMonth = A.meta.asOf ? A.meta.asOf.slice(0, 7) : null;
    var head = '<div class="view-title">スタッフ ダッシュボード</div><div class="view-lead">累計ではなく月次と平均で評価。キャンセル率は来店客のみ（初回来店なしは除外）。</div>';
    var html = '';

    // スタッフ比較（中立の一覧表 — 競争をあおる表現はしない）
    var pctOrDash = function (v, d) { return v == null || !isFinite(v) ? '—' : pct(v * 100, d); };
    var vsMetrics = [
      { label: '平均来店 / 月', fmt: function (st) { return F.int(st.avg.visitsPerMonth) + '件'; } },
      { label: '平均売上 / 月', fmt: function (st) { return yen(st.avg.revPerMonth); } },
      { label: '平均客単価', fmt: function (st) { return yen(st.avg.spend); } },
      { label: '次回予約取得率', fmt: function (st) { return pctOrDash(st.avg.nextRes); } },
      { label: '2回目 次回予約取得率', fmt: function (st) { return pctOrDash(st.avg.nextRes2); } },
      { label: 'リピート率（2回到達）', fmt: function (st) { return pctOrDash(st.reach2); } },
      { label: '店販顧客比率', fmt: function (st) { return pctOrDash(st.retail.customerRatio, 1); } }
    ];
    var vs = '<div class="table-wrap"><table class="vs-table"><thead><tr><th></th>' +
      staff.map(function (st) { return '<th><i class="vs-dot" style="background:' + cvar(STAFF_COLOR[st.name]) + '"></i>' + esc(st.name) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      vsMetrics.map(function (m) {
        return '<tr><td>' + m.label + '</td>' + staff.map(function (st) {
          return '<td><b>' + m.fmt(st) + '</b></td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
    html += card({ col: 'col-12', title: 'スタッフ比較', sub: '主要指標を並べて表示しています（優劣ではなく現状把握のための一覧です）。', body: vs });

    // Staff cards
    staff.forEach(function (st, i) {
      var col = cvar(STAFF_COLOR[st.name] || '--series-6');
      var matureNote = A.meta.completedOnly
        ? '<span data-kpi="staff-' + esc(st.name) + '-mature-n">・成熟母数 ' + st.matureAcquired + '人</span>' : '';
      var regMile = milestoneProgress(st.regulars3, MILESTONES.regulars);
      var regNote = '・育てた常連 <b data-kpi="staff-' + esc(st.name) + '-regulars3">' + F.int(st.regulars3) + '人</b>' +
        (regMile.maxed ? '（最高節目達成）' : '（次の節目 ' + F.int(regMile.next) + '人）');
      var mile2Kind = st.cumulative.shimei != null ? 'shimei' : (st.cumulative.retailVisits != null ? 'retail' : null);
      html += card({
        col: 'col-6', hoverable: true,
        body: '<div class="staff-head"><div class="staff-avatar" style="background:' + col + '">' + esc(st.name[0].toUpperCase()) + '</div>' +
          '<div><div class="staff-name">' + esc(st.name) + '<span>実績 ' + st.avg.months + 'ヶ月 ・ 獲得顧客 ' + st.acquired + '人' + matureNote + regNote + '</span></div></div></div>' +
          '<div class="staff-metrics">' +
          sm(F.int(st.avg.visitsPerMonth), '平均来店 / 月') + sm(yen(st.avg.revPerMonth), '平均売上 / 月') +
          sm(yen(st.avg.spend), '平均客単価') + sm(pct(st.retail.customerRatio * 100, 1), '店販顧客比率', 'staff-' + esc(st.name) + '-retail') +
          '</div>' +
          '<div id="stMeter' + i + '" style="margin-top:16px"></div>' +
          '<div id="stMeter2_' + i + '"></div>' +
          '<div id="stMile1_' + i + '" style="margin-top:10px"></div>' +
          (mile2Kind ? '<div id="stMile2_' + i + '"></div>' : '') +
          personalBestBlock(st) +
          sgPanel(st, asOfMonth) +
          '<div class="next-hint" data-kpi="staff-' + esc(st.name) + '-next-hint">' + esc(nextHintText(st)) + '</div>'
      });
    });

    html += card({ col: 'col-6', title: '月次 予約数の比較', tag: '件', body: chartBox('cStaffRes', 240) });
    html += card({ col: 'col-6', title: '月次 予約ベース売上の比較', tag: '¥', body: chartBox('cStaffRev', 240) });
    html += card({ col: 'col-6', title: '客単価の推移', tag: '¥', body: chartBox('cStaffSpend', 230) });
    var censNote = A.meta.completedOnly ? '　※直近の月は再来待ちのため集計対象外' : '';
    html += card({ col: 'col-6', title: '次回予約取得率の推移', sub: '来店時に次の予約を確保できた割合' + censNote, tag: '%', body: chartBox('cStaffNext', 230) });
    html += card({ col: 'col-6', title: '2回目 次回予約取得率の推移', sub: '2回目来店時に、次の予約を確保できた割合' + censNote, tag: '%', body: chartBox('cStaffNext2', 230) });
    html += card({ col: 'col-6', title: 'リピート育成力', sub: '初回担当者を基準にした 2〜4回目への到達率', body: chartBox('cStaffRepeat', 230) });

    mount('staff', head + '<div class="grid">' + html + '</div>');

    staff.forEach(function (st, i) {
      draw('stMeter' + i, function (el) {
        C.meter(el, { label: '次回予約取得率', value: st.avg.nextRes || 0, display: st.avg.nextRes == null ? '—' : pct(st.avg.nextRes * 100), color: cvar(STAFF_COLOR[st.name]), target: 0.6, sub: '目安 60%' });
      });
      draw('stMeter2_' + i, function (el) {
        C.meter(el, { label: '2回目 次回予約取得率', value: st.avg.nextRes2 || 0, display: st.avg.nextRes2 == null ? '—' : pct(st.avg.nextRes2 * 100), color: cvar(STAFF_COLOR[st.name]), target: 0.6, sub: '目安 60%（2回目来店の再予約）' });
      });
      draw('stMile1_' + i, function (el) {
        var mp = milestoneProgress(st.cumulative.visits, MILESTONES.visits);
        C.meter(el, {
          label: '累計担当来店', value: mp.frac, display: F.int(st.cumulative.visits) + '件', color: cvar(STAFF_COLOR[st.name]),
          sub: mp.maxed ? '最高節目達成' : '次の節目 ' + F.int(mp.next) + '件まで あと ' + F.int(mp.next - st.cumulative.visits) + '件'
        });
      });
      var mile2Kind = st.cumulative.shimei != null ? 'shimei' : (st.cumulative.retailVisits != null ? 'retail' : null);
      if (mile2Kind) {
        draw('stMile2_' + i, function (el) {
          var val = mile2Kind === 'shimei' ? st.cumulative.shimei : st.cumulative.retailVisits;
          var label = mile2Kind === 'shimei' ? '累計指名' : '累計店販成約';
          var mp = milestoneProgress(val, MILESTONES[mile2Kind]);
          C.meter(el, {
            label: label, value: mp.frac, display: F.int(val) + '件', color: cvar(STAFF_COLOR[st.name]),
            sub: mp.maxed ? '最高節目達成' : '次の節目 ' + F.int(mp.next) + '件まで あと ' + F.int(mp.next - val) + '件'
          });
        });
      }
    });
    var seriesRes = staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.res; }) }; });
    draw('cStaffRes', function (el) { C.columns(el, { groups: months, series: seriesRes, valueFmt: function (v) { return v + '件'; }, height: 240 }); });
    draw('cStaffRev', function (el) { C.columns(el, { groups: months, series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.rev; }) }; }), valueFmt: function (v) { return yen(v); }, yFmt: F.compact, height: 240 }); });
    draw('cStaffSpend', function (el) { C.lineArea(el, { xLabels: months, area: false, series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.spend; }) }; }), valueFmt: yen, yFmt: F.compact, height: 230 }); });
    draw('cStaffNext', function (el) {
      C.lineArea(el, {
        xLabels: months, area: false, yMax: 100,
        series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.nextRes == null ? null : m.nextRes * 100; }) }; }),
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230
      });
    });
    draw('cStaffNext2', function (el) {
      C.lineArea(el, {
        xLabels: months, area: false, yMax: 100,
        series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.nextRes2 == null ? null : m.nextRes2 * 100; }) }; }),
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230
      });
    });
    draw('cStaffRepeat', function (el) {
      C.columns(el, {
        groups: ['2回目到達', '3回目到達', '4回目到達'],
        series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: [st.reach2, st.reach3, st.reach4].map(function (v) { return v == null ? 0 : v * 100; }) }; }),
        valueFmt: function (v) { return v.toFixed(1) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, yMax: 100, height: 230
      });
    });
    flush();
  }
  function sm(v, label, dataKpi) { return '<div class="staff-metric"' + (dataKpi ? ' data-kpi="' + dataKpi + '"' : '') + '><b>' + v + '</b><span>' + label + '</span></div>'; }

  // Growth vs the staff member's OWN history (not vs the other staff). Compares the
  // average of their earlier active months to their recent active months.
  function selfGrowth(st, pick, asOfMonth) {
    // Only fully-settled months: exclude the as-of month (partial export) and any future ones,
    // so a half-finished current month doesn't bias counts downward.
    var v = st.monthly.filter(function (m) { return m.actual > 0 && (!asOfMonth || m.m < asOfMonth); })
      .map(pick).filter(function (x) { return x != null && isFinite(x); });
    if (v.length < 2) return null;
    var avg = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
    var h = Math.max(1, Math.floor(v.length / 2));
    var early = v.slice(0, h), late = v.slice(v.length - h);
    var ea = early.reduce(function (a, b) { return a + b; }, 0) / early.length;
    var la = late.reduce(function (a, b) { return a + b; }, 0) / late.length;
    var rel = ea ? (la - ea) / Math.abs(ea) : 0;
    return { avg: avg, late: la, dir: rel > 0.03 ? 'up' : rel < -0.03 ? 'down' : 'flat' };
  }
  function sgRow(label, st, pick, fmt, asOfMonth) {
    var g = selfGrowth(st, pick, asOfMonth);
    if (!g) return '<div class="sg-row"><span>' + label + '</span><b class="sg-na">データ蓄積中</b></div>';
    var arrow = g.dir === 'up' ? '↑ 上向き' : g.dir === 'down' ? '↓ 下向き' : '→ 横ばい';
    return '<div class="sg-row"><span>' + label + '</span><b>自己平均 ' + fmt(g.avg) + '</b><em class="sg-' + g.dir + '">' + arrow + '</em></div>';
  }
  function sgPanel(st, asOfMonth) {
    return '<div class="self-growth"><div class="sg-title">自分の推移（自己平均比）</div>' +
      sgRow('客単価', st, function (m) { return m.spend; }, function (v) { return yen(Math.round(v)); }, asOfMonth) +
      sgRow('来店 / 月', st, function (m) { return m.actual; }, function (v) { return F.int(v) + '件'; }, asOfMonth) +
      sgRow('次回予約取得率', st, function (m) { return m.nextRes == null ? null : m.nextRes * 100; }, function (v) { return v.toFixed(0) + '%'; }, asOfMonth) +
      '</div>';
  }

  // 自己ベスト（月間の最高記録・自分の過去比のみ／他スタッフとは比較しない）
  function personalBestBlock(st) {
    var pb = st.personalBest;
    if (pb.confirmedMonths < 2) {
      return '<div class="self-growth"><div class="sg-title">自己ベスト</div>' +
        '<div class="empty-note">記録を集めています。確定した月次データが2ヶ月分たまると表示されます。</div></div>';
    }
    function cell(label, best, isLatest, fmt, dataKpi) {
      if (!best) return '';
      return '<div class="staff-metric"' + (dataKpi ? ' data-kpi="' + dataKpi + '"' : '') + '>' +
        '<b>' + fmt(best.v) + '</b><span>' + label + '（' + monthShort(best.m) + '）' + (isLatest ? '<span class="pb-tag">自己ベスト更新</span>' : '') + '</span></div>';
    }
    var cells = cell('月間来店', pb.visits, pb.latestIsBest.visits, function (v) { return F.int(v) + '件'; }) +
      cell('月間売上', pb.rev, pb.latestIsBest.rev, function (v) { return yen(v); }) +
      cell('月間指名', pb.shimei, pb.latestIsBest.shimei, function (v) { return F.int(v) + '件'; }) +
      cell('月間店販成約', pb.retail, pb.latestIsBest.retail, function (v) { return F.int(v) + '件'; });
    return '<div class="self-growth"><div class="sg-title">自己ベスト</div><div class="staff-metrics" style="margin-top:10px">' + cells + '</div></div>';
  }

  // 次の一手：目安との差が最も大きい「成熟済み」の指標を1件だけ提案。競争ではなく
  // 本人の伸びしろに焦点を当てるため、他スタッフとの比較は一切行わない。母数が
  // 小さい（20未満）候補は不安定なので提案対象から除外する。
  function nextHintText(st) {
    var candidates = [];
    if (st.matureAcquired >= 20 && st.reach2 != null) candidates.push({ label: 'リピート（2回目のご来店）', value: st.reach2 * 100, target: 70 });
    if (st.avg.nextResN >= 20 && st.avg.nextRes != null) candidates.push({ label: '次回予約の獲得', value: st.avg.nextRes * 100, target: 60 });
    if (st.avg.nextRes2N >= 20 && st.avg.nextRes2 != null) candidates.push({ label: '2回目のお客様の再予約', value: st.avg.nextRes2 * 100, target: 60 });
    if (st.matureAcquired >= 20 && st.reach3 != null) candidates.push({ label: '常連化（3回以上のご来店）', value: st.reach3 * 100, target: 30 });
    if (!candidates.length) return 'データが揃うと、具体的な提案が表示されます。';
    candidates.forEach(function (c) { c.gap = c.target - c.value; });
    var positive = candidates.filter(function (c) { return c.gap > 0; }).sort(function (a, b) { return b.gap - a.gap; });
    if (!positive.length) return 'すべての目安を達成しています。この水準の維持が次の目標です。';
    var top = positive[0];
    return '次の一手：' + top.label + 'が ' + Math.round(top.value) + '%（目安 ' + top.target + '%）。ここが一番の伸びしろです。';
  }

  // ============================ TREND ======================================
  var trendMetric = 'visits';
  function renderTrend() {
    var A = state.analytics, t = A.trend;
    var head = '<div class="view-title">傾向分析</div><div class="view-lead">曜日・初回獲得月・クーポン別に、次回予約率とLTVの傾向を読み解きます。</div>';
    var html = '';

    html += card({
      col: 'col-12', title: '曜日別パフォーマンス', sub: '来店の多い曜日と、定着しやすい曜日を把握',
      body: '<div class="segmented" id="dowSeg" role="group" aria-label="曜日別に表示する指標">' +
        [['visits', '来店数'], ['nextRes', '次回予約率'], ['spend', '客単価'], ['ltv', 'LTV']].map(function (o, i) { return '<button type="button" data-m="' + o[0] + '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '"' + (i === 0 ? ' class="active"' : '') + '>' + o[1] + '</button>'; }).join('') +
        '<span class="seg-thumb" id="dowThumb"></span></div>' + chartBox('cDow', 250)
    });
    html += card({ col: 'col-6', title: '月次コホート リピート率', sub: '初回獲得月ごとの2回目到達', tag: '%', body: chartBox('cTCohortR', 220) });
    html += card({ col: 'col-6', title: '月次コホート LTV', sub: '初回獲得月ごとの累計売上', tag: '¥', body: chartBox('cTCohortL', 220) });
    html += card({ col: 'col-12', title: '人気クーポン TOP', sub: '初回獲得クーポン別のリピート率とLTV', body: '<div id="cCoupon"></div>' });
    if (t.menuTop.length) {
      var menuSub = t.nextResMenuRatio != null ? '来店のうち次回予約割メニューの比率 ' + pct(t.nextResMenuRatio * 100, 1) : '件数の多い順';
      html += card({ col: 'col-12', title: '人気メニュー TOP', sub: menuSub, body: '<div id="cMenu"></div>' });
    }
    if (t.couponRatio != null) {
      html += card({ col: 'col-6', title: 'クーポン依存度', sub: '来店のうちクーポンを利用した割合', body: '<div id="mCoupon"></div>' });
    }
    if (A.store.serviceRetailMonthly) {
      html += card({ col: 'col-6', title: '施術・店販の月次分解', sub: '会計金額の内訳', tag: '¥', body: chartBox('cServiceRetail', 210) });
    }
    html += card({
      col: 'col-12', title: '時間帯 × 曜日 ヒートマップ', sub: '来店の多い時間帯を把握' + (A.meta.completedOnly ? '（会計時刻ベース）' : ''),
      body: chartBox('cHourDow', 0)
    });

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
    if (t.menuTop.length) {
      draw('cMenu', function (el) {
        C.hbars(el, { items: t.menuTop.map(function (m) { return { label: shortCoupon(m.menu), value: m.n, sub: yen(m.amount), color: cvar('--series-2') }; }), valueFmt: function (v) { return v + '件'; } });
      });
    }
    if (t.couponRatio != null) {
      draw('mCoupon', function (el) {
        C.meter(el, { label: 'クーポン利用来店', value: t.couponRatio, display: pct(t.couponRatio * 100, 1), color: cvar('--series-3') });
      });
    }
    if (A.store.serviceRetailMonthly) {
      draw('cServiceRetail', function (el) {
        var srm = A.store.serviceRetailMonthly;
        C.columns(el, {
          groups: srm.map(function (m) { return monthShort(m.m); }), stacked: true,
          series: [
            { name: '施術', color: cvar('--series-1'), values: srm.map(function (m) { return m.service; }) },
            { name: '店販', color: cvar('--series-5'), values: srm.map(function (m) { return m.retail; }) }
          ],
          valueFmt: function (v) { return yen(Math.round(v)); }, yFmt: F.compact, height: 210
        });
      });
    }
    draw('cHourDow', function (el) {
      C.heatmap(el, { matrix: t.hourDow, rowLabels: ['月', '火', '水', '木', '金', '土', '日'], colLabels: t.hourLabels, hue: cvar('--seq-5'), unit: '件' });
    });
    // segmented control
    var seg = $('#dowSeg');
    seg.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; trendMetric = b.dataset.m; Array.prototype.forEach.call(seg.querySelectorAll('button'), function (x) { var on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); }); positionThumb(); drawDow(); flush(); });
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
    var thead = '<thead><tr>' + cols.map(function (c) { return '<th data-k="' + c[0] + '" tabindex="0" role="button" aria-label="' + c[1] + 'で並べ替え"' + (rfmSort.key === c[0] ? ' aria-sort="' + (rfmSort.dir > 0 ? 'ascending' : 'descending') + '" class="sorted' + (rfmSort.dir > 0 ? ' asc' : '') + '"' : '') + '>' + c[1] + '</th>'; }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (c) {
      var col = cvar(SEG_COLOR[c.seg] || '--series-6');
      return '<tr><td>' + esc(c.name) + '</td><td>' + c.R + '</td><td>' + c.F + '</td><td>' + F.int(c.M) + '</td>' +
        '<td style="text-align:left"><span class="seg-tag"><i style="background:' + col + '"></i>' + esc(c.seg) + '</span></td></tr>';
    }).join('') + '</tbody>';
    var table = $('#rfmTable'); table.innerHTML = thead + tbody;
    Array.prototype.forEach.call(table.querySelectorAll('th'), function (th) {
      function sort() { var k = th.dataset.k; if (rfmSort.key === k) rfmSort.dir *= -1; else { rfmSort.key = k; rfmSort.dir = k === 'name' ? 1 : -1; } buildRfmTable(); var nth = document.querySelector('#rfmTable th[data-k="' + k + '"]'); if (nth) nth.focus(); }
      th.addEventListener('click', sort);
      th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
    });
  }

  // ============================ DATA =======================================
  // Each slot ('yoyaku'|'kaikei') independently holds { records, fileName, via }|null
  // in state.sources; applySources() combines whatever is loaded. Both slots
  // filled → merged via ingest.mergeSources(); either alone → used as-is;
  // neither → the bundled sample data.
  function slotMeta(slot) {
    return slot === 'kaikei'
      ? { label: '会計明細', urlId: 'sheetUrlKaikei', linkId: 'sheetLinkBtnKaikei', unlinkId: 'sheetUnlinkBtnKaikei', dropId: 'dropKaikei', fileId: 'fileKaikei', pickId: 'pickKaikei', sheetUrl: state.sheetUrlKaikei }
      : { label: '予約データ', urlId: 'sheetUrlYoyaku', linkId: 'sheetLinkBtnYoyaku', unlinkId: 'sheetUnlinkBtnYoyaku', dropId: 'dropYoyaku', fileId: 'fileYoyaku', pickId: 'pickYoyaku', sheetUrl: state.sheetUrl };
  }
  function slotStatusLine(slot) {
    var s = state.sources[slot];
    if (!s) return '<div class="status-line"><i style="background:var(--ink-muted)"></i>未読み込み</div>';
    return '<div class="status-line" style="color:var(--status-good)"><i style="background:var(--status-good)"></i>読み込み済み・' + F.int(s.records.length) + '件' + (s.fileName ? '・' + esc(s.fileName) : '（' + esc(s.via) + '）') + '</div>';
  }
  function renderData() {
    var A = state.analytics, m = A.meta;
    var head = '<div class="view-title">データ入力</div><div class="view-lead">Googleスプレッドシート連携、またはファイル（CSV / Excel）を入れるだけで全指標を自動再計算します。<b>「予約データ」</b>（ステータス列つき）と、<b>「会計明細」</b>（会計日・金額・店販つき）の両形式に対応。<b>両方を読み込むと自動で結合</b>し、キャンセル率と店販売上を同じ画面で確認できます（文字コードは Shift-JIS / UTF-8 を自動判別）。</div>';
    var html = '';
    // Google Sheets link — one row per slot
    html += card({
      col: 'col-12', title: 'スプレッドシート連携', sub: 'Googleスプレッドシートに入れておけば、URLを貼るだけで自動で反映されます（両方貼ると自動結合）',
      body: ['yoyaku', 'kaikei'].map(function (slot) {
        var sm = slotMeta(slot), linked = !!sm.sheetUrl;
        return '<div style="padding:' + (slot === 'kaikei' ? '14px 0 0' : '0 0 14px') + (slot === 'yoyaku' ? ';border-bottom:1px solid var(--hairline)' : '') + '">' +
          '<div class="note-inline" style="margin-bottom:6px;font-weight:600;color:var(--ink-primary)">' + sm.label + '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<input type="url" id="' + sm.urlId + '" class="sheet-input" inputmode="url" placeholder="https://docs.google.com/spreadsheets/d/…" value="' + esc(sm.sheetUrl || '') + '">' +
          '<button class="pill accent" id="' + sm.linkId + '" type="button">' + (linked ? '今すぐ更新' : '連携して読み込む') + '</button>' +
          (linked ? '<button class="pill" id="' + sm.unlinkId + '" type="button">解除</button>' : '') +
          '</div>' +
          (linked ? '<div class="status-line" style="margin-top:8px;color:var(--status-good)"><i style="background:var(--status-good)"></i>連携中。ページを開くたびに最新の内容を読み込みます。</div>' : '') +
          '</div>';
      }).join('') +
        '<details style="margin-top:12px"><summary style="cursor:pointer;font-size:12.5px;color:var(--ink-secondary);font-weight:600">連携のしかた・注意点</summary>' +
        '<div class="how" style="margin-top:8px"><ul>' +
        '<li>スプレッドシートの1行目を、対応する見出し（「予約データ」または「会計明細」）と同じ<b>日本語の見出し</b>にしてください（下のテンプレートが使えます）。</li>' +
        '<li><b>確実な方法：</b>スプレッドシートで <code>ファイル → 共有 → ウェブに公開 → 「カンマ区切り形式(.csv)」</code> を選び、表示されたURLをここに貼り付け。</li>' +
        '<li>または、共有を<code>「リンクを知っている全員（閲覧者）」</code>にして、通常の編集URLを貼り付け。</li>' +
        '<li><b>⚠ プライバシー：</b>ウェブに公開・共有したスプレッドシートは、URLを知る人が閲覧できる状態になります。氏名・電話番号などを含む場合はご注意ください。非公開で扱いたい場合は下のファイルアップロードをお使いください。</li>' +
        '<li>テンプレート：<code>data/template.csv</code>（このリポジトリ）をスプレッドシートに<code>ファイル → インポート</code>すると、見出し付きで始められます。</li>' +
        '</ul></div></details>'
    });
    // File upload — one dropzone per slot
    ['yoyaku', 'kaikei'].forEach(function (slot) {
      var sm = slotMeta(slot);
      html += card({
        col: 'col-6', title: sm.label + 'を読み込む', sub: '非公開のデータはこちら（ブラウザ内でのみ処理）',
        body: '<div class="dropzone" id="' + sm.dropId + '" tabindex="0" role="button" aria-label="' + sm.label + 'をアップロード">' +
          '<div class="dropzone-ico">' + svgIco('upload') + '</div><h3>' + sm.label + 'をドロップ、またはタップして選択</h3>' +
          '<p>対応形式：<b>.xlsx</b> / <b>.csv</b>（Shift-JIS対応）</p>' +
          '<button class="pill accent" id="' + sm.pickId + '" type="button">ファイルを選択</button></div>' +
          '<div style="margin-top:10px">' + slotStatusLine(slot) + '</div>'
      });
    });
    html += card({ col: 'col-12', body: '<button class="pill" id="resetBtn" type="button">全データをクリアしてサンプルに戻す</button>' });
    // Merge report — only when both slots are loaded
    if (state.mergeReport) {
      var mr = state.mergeReport;
      if (mr.matched === 0) {
        html += card({
          col: 'col-12', title: '突合レポート（予約データ ⇄ 会計明細）',
          body: '<div class="status-line" style="color:var(--status-critical)"><i style="background:var(--status-critical)"></i>結合0件 — フリガナ表記または対象期間が一致していない可能性があります。会計明細は結合されず、予約データ単独で表示しています。</div>'
        });
      } else {
        html += card({
          col: 'col-12', title: '突合レポート（予約データ ⇄ 会計明細）',
          sub: '会計明細 ' + F.int(mr.kaikeiTotal) + '件中 ' + F.int(mr.matched) + '件を予約データと結合（結合率 ' + pct(mr.matchRate * 100, 1) + '）',
          body: '<div class="mini-stats" style="margin-bottom:10px">' +
            miniStat(F.int(mr.unmatchedKaikei) + '件', '未突合（会計明細）') +
            miniStat(F.int(mr.unmatchedYoyaku) + '件', '未突合（予約データ）') +
            miniStat(F.int(mr.amountMismatch.count) + '件', '金額不一致（差額 ' + yen(mr.amountMismatch.totalDiff) + '）') +
            miniStat(F.int(mr.suspectedDup) + '件', '重複疑い（除外済み）') +
            '</div>' +
            (mr.samples.length ? '<div class="table-wrap"><table class="kate-table"><thead><tr><th>日付</th><th>フリガナ</th><th>種別</th></tr></thead><tbody>' +
              mr.samples.map(function (s) { return '<tr><td>' + esc(s.date) + '</td><td>' + esc(s.kana) + '</td><td>' + esc(s.type) + '</td></tr>'; }).join('') +
              '</tbody></table></div>' : '')
        });
      }
    }
    html += card({
      col: 'col-6', title: '現在のデータ', sub: 'ブラウザ内でのみ処理されます',
      body: '<div class="datainfo">' +
        '<div><span>データソース</span><b>' + esc(state.fileName || state.source) + '</b></div>' +
        '<div><span>取込件数</span><b class="tnum">' + F.int(m.totalRows) + '件</b></div>' +
        '<div><span>有効予約</span><b class="tnum">' + F.int(A.store.effectiveReservations) + '件</b></div>' +
        '<div><span>来店顧客</span><b class="tnum">' + F.int(A.store.customers) + '人</b></div>' +
        '<div><span>対象期間</span><b>' + esc(m.periodStart) + ' 〜 ' + esc(m.periodEnd) + '</b></div>' +
        '<div><span>集計基準日</span><b>' + esc(m.asOf) + '</b></div></div>' +
        (m.undatedRows ? '<div class="status-line" style="margin-top:12px;color:var(--status-warning)"><i style="background:var(--status-warning)"></i>' + F.int(m.undatedRows) + '件は来店日を読み取れず、日付ベースの集計から除外しました。</div>' : '')
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
        '<li><b>成熟ルール（会計明細のみ）</b>：これからの予約情報が無いデータ（会計明細）では、初回来店からまだ45日経っていない直近のお客様を、リピート率・固定化率・ファネル等の母数から一時的に除外します。時間が経てば自然と母数に加わります（十分な期間が経っていない段階では「まだ再来していない」だけの可能性が高いため）。</li>' +
        '<li><b>店販顧客比率</b> ＝ 店販（物販）を購入した<b>人数</b> ÷ 来店した<b>人数</b>。<b>店販単価</b>は「店販金額 ÷ 店販のあった会計数」（1人が複数回購入する場合があるため会計単位）。</li>' +
        '<li><b>LTV（予測）</b>：実績客単価 × 期待来店回数（5回到達までの期待値）。</li>' +
        '<li><b>RFM</b>：R＝最終来店からの日数、F＝来店回数、M＝累計売上。9セグメントに自動分類（区分の閾値は元KPIワークブックの固定値）。</li>' +
        '<li>個人情報を含むデータはすべて<b>ブラウザ内で処理</b>され、サーバーには送信されません。</li>' +
        '</ul>'
    });
    mount('data', head + '<div class="grid">' + html + '</div>');
    wireUpload();
  }

  function wireUpload() {
    wireSlot('yoyaku'); wireSlot('kaikei');
    var resetBtn = $('#resetBtn');
    if (resetBtn) resetBtn.addEventListener('click', function (e) { e.stopPropagation(); resetAll(); toast('サンプルデータに戻しました', 'ok'); });
  }
  function wireSlot(slot) {
    var sm = slotMeta(slot);
    var sheetInput = $('#' + sm.urlId), linkBtn = $('#' + sm.linkId), unlinkBtn = $('#' + sm.unlinkId);
    if (linkBtn) linkBtn.addEventListener('click', function () { var u = (sheetInput.value || '').trim(); if (u) linkSheet(u, slot); else toast('スプレッドシートのURLを入力してください', 'err'); });
    if (sheetInput) sheetInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (linkBtn) linkBtn.click(); } });
    if (unlinkBtn) unlinkBtn.addEventListener('click', function () { unlinkSheet(slot); });
    var dz = $('#' + sm.dropId), input = $('#' + sm.fileId), pickBtn = $('#' + sm.pickId);
    if (!dz || !input) return;
    if (pickBtn) pickBtn.addEventListener('click', function (e) { e.stopPropagation(); input.click(); });
    dz.addEventListener('click', function () { input.click(); });
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return; dz.classList.remove('drag'); }); });
    dz.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) handleFile(f, slot); });
    input.onchange = function () { if (input.files[0]) handleFile(input.files[0], slot); input.value = ''; };
  }
  // Every data-commit path funnels through here: whichever slot(s) are filled
  // in state.sources drive the recompute (merged when both, single-source
  // otherwise, bundled sample data when neither).
  function applySources() {
    var y = state.sources.yoyaku, k = state.sources.kaikei;
    var recs, source, fileName, mergeReport = null, computeOpts = {};
    if (y && k) {
      var merged = global.KATE.ingest.mergeSources(y.records, k.records);
      mergeReport = merged.report;
      if (merged.report.matched > 0) { recs = merged.records; source = '統合データ（予約＋会計）'; fileName = null; }
      else { recs = y.records; source = y.via; fileName = y.fileName; }   // 0件結合 → 統合を中止し予約データ単独
    } else if (y) { recs = y.records; source = y.via; fileName = y.fileName; }
    else if (k) { recs = k.records; source = k.via; fileName = k.fileName; }
    else { recs = global.KATE.SAMPLE_RESERVATIONS; source = 'サンプルデータ'; fileName = null; computeOpts = { asOf: '2026-07-03' }; }
    var A = global.KATE.engine.compute(recs, computeOpts);
    state.data = recs; state.analytics = A; state.source = source; state.fileName = fileName; state.mergeReport = mergeReport;
    updateChrome(); renderAll(); route(state.view, true);
    return A;
  }
  function linkSheet(url, slot, opts) {
    opts = opts || {};
    if (!url) return;
    if (!opts.silent) toast('スプレッドシートを読み込み中…');
    global.KATE.sheets.fetchCsv(url).then(function (text) {
      var parsed = global.KATE.ingest.fromAOA(global.KATE.ingest.parseCSV(text));
      var format = parsed.format, recs = parsed.records;
      state.sources[format] = { records: recs, fileName: null, via: 'スプレッドシート連携' };
      if (format === 'kaikei') state.sheetUrlKaikei = url; else state.sheetUrl = url;
      try { localStorage.setItem(format === 'kaikei' ? 'kate-sheet-url-kaikei' : 'kate-sheet-url', url); } catch (e) {}
      var A = applySources();
      var reroute = format !== slot ? '（' + slotMeta(format).label + 'の形式を検出したため、そちらに読み込みました）' : '';
      var warn = A.meta.undatedRows ? '（うち' + F.int(A.meta.undatedRows) + '件は日付を読み取れず除外）' : '';
      if (!opts.silent) toast('✓ スプレッドシートから ' + F.int(recs.length) + '件を読み込みました' + reroute + warn, warn ? 'err' : 'ok');
    }).catch(function (err) {
      console.warn('sheet load failed', err);
      if (!opts.silent) toast('⚠ ' + (err.message || '読み込みに失敗しました'), 'err');
    });
  }
  function unlinkSheet(slot) {
    if (slot === 'kaikei') { state.sheetUrlKaikei = null; try { localStorage.removeItem('kate-sheet-url-kaikei'); } catch (e) {} }
    else { state.sheetUrl = null; try { localStorage.removeItem('kate-sheet-url'); } catch (e) {} }
    state.sources[slot] = null;
    applySources(); route('data', true); toast(slotMeta(slot).label + 'の連携を解除しました', 'ok');
  }
  function handleFile(file, slot) {
    toast('読み込み中…');
    global.KATE.ingest.parseFile(file).then(function (parsed) {
      var format = parsed.format, recs = parsed.records;
      state.sources[format] = { records: recs, fileName: file.name, via: 'アップロード' };
      var A = applySources();
      var reroute = format !== slot ? '（' + slotMeta(format).label + 'の形式を検出したため、そちらに読み込みました）' : '';
      var warn = A.meta.undatedRows ? '（うち' + F.int(A.meta.undatedRows) + '件は日付を読み取れず除外）' : '';
      toast('✓ ' + F.int(recs.length) + '件を再計算しました' + reroute + warn, warn ? 'err' : 'ok');
    }).catch(function (err) { console.error(err); toast('⚠ ' + (err.message || '読み込みに失敗しました'), 'err'); });
  }
  function resetAll() {
    state.sources = { yoyaku: null, kaikei: null };
    state.sheetUrl = null; state.sheetUrlKaikei = null;
    try { localStorage.removeItem('kate-sheet-url'); localStorage.removeItem('kate-sheet-url-kaikei'); } catch (e) {}
    applySources();
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
      if (!isFinite(to)) return;   // non-numeric placeholder (e.g. '—') → leave as-is
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
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { var on = t.dataset.view === view; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); t.setAttribute('tabindex', on ? '0' : '-1'); });
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

  // ---- boot ----------------------------------------------------------------
  function boot() {
    var saved; try { saved = localStorage.getItem('kate-theme'); } catch (e) {}
    setTheme(saved || (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

    injectNavIcons();
    applySources();   // no sources loaded yet → falls back to the bundled sample data

    // Auto-reconnect previously linked spreadsheets (always pull the latest)
    var savedYoyaku = null, savedKaikei = null;
    try { savedYoyaku = localStorage.getItem('kate-sheet-url'); savedKaikei = localStorage.getItem('kate-sheet-url-kaikei'); } catch (e) {}
    if (savedYoyaku) { state.sheetUrl = savedYoyaku; linkSheet(savedYoyaku, 'yoyaku', { silent: true }); }
    if (savedKaikei) { state.sheetUrlKaikei = savedKaikei; linkSheet(savedKaikei, 'kaikei', { silent: true }); }

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
    global.addEventListener('resize', function () { clearTimeout(rt); var tp = document.querySelector('.kate-tip'); if (tp) tp.style.opacity = 0; rt = setTimeout(function () { moveUnderline(); positionThumb(); flush(true); }, 160); });
    setTimeout(moveUnderline, 60);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
