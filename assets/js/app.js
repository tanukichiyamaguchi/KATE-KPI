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
    sheetUrl: null, sheetUrlKaikei: null, sources: { yoyaku: null, kaikei: null }, mergeReport: null,
    sharedBlob: null,   // data/shared-link.json（合言葉で暗号化されたシートURL）があれば入る
    ownerLock: null,    // data/owner-lock.json（管理用の合言葉で暗号化されたロック）があれば入る
    ownerUnlocked: false, // 解除済みか（この端末で一度解除すれば ownerUnlockKey で記憶される）
    taxExcluded: true,  // 税抜表示をメインに（トグルで税込へ）。端末設定として localStorage に保存
    dataLoadedAt: null,   // この画面が実データを読み込んだ日時（連携/アップロード時に記録）
    sheetUpdatedAt: null  // シート側が記録した同期完了日時（「データ更新日時」列。applySources で導出）
  };
  (function () { try { if (localStorage.getItem('kate-tax') === 'incl') state.taxExcluded = false; } catch (e) {} })();
  var activeCharts = [];   // redraw closures for the mounted view (resize/theme)

  // ---- formatting ----------------------------------------------------------
  function yen(n) { return '¥' + F.int(n); }
  // Abbreviated yen (¥12万) for on-bar chart labels, where narrow grouped bars
  // don't have room for the full comma-separated amount shown in tooltips.
  function yenCompact(n) { return '¥' + F.compact(n); }
  function pct(n, d) { return (n).toFixed(d == null ? 1 : d) + '%'; }
  // 分母・分子を「分子 ÷ 分母 単位」で明示する共通ヘルパー（例: 66人 ÷ 141人）。
  function frac(numer, denom, unit) {
    unit = unit || '';
    if (numer == null || denom == null) return '—';
    return F.int(numer) + unit + ' ÷ ' + F.int(denom) + unit;
  }
  function monthShort(ym) { var m = ym.split('-'); return (+m[1]) + '月'; }
  // Human date formatting: raw ISO strings ("2026-07-03") read as machine output
  // to the salon staff this dashboard is for — render 年/月/日 instead.
  function ymJa(ym) { var p = String(ym).split('-'); return (+p[0]) + '年' + (+p[1]) + '月'; }
  function ymdJa(d) { var p = String(d).split('-'); return p.length >= 3 ? (+p[0]) + '年' + (+p[1]) + '月' + (+p[2]) + '日' : ymJa(d); }
  // Dateオブジェクト → 「M月D日 HH:MM」（年が違うときだけ「YYYY年」を前置）
  function ymdhmJa(dt) {
    function z(n) { return (n < 10 ? '0' : '') + n; }
    var yr = dt.getFullYear() !== new Date().getFullYear() ? dt.getFullYear() + '年' : '';
    return yr + (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + z(dt.getHours()) + ':' + z(dt.getMinutes());
  }
  // 時刻のみ（今日の「最後に確認した時刻」の併記用）
  function hmJa(dt) {
    function z(n) { return (n < 10 ? '0' : '') + n; }
    var sameDay = dt.toDateString() === new Date().toDateString();
    return (sameDay ? '' : (dt.getMonth() + 1) + '/' + dt.getDate() + ' ') + z(dt.getHours()) + ':' + z(dt.getMinutes());
  }
  // 各ビューのリード文末尾に付ける、データの鮮度表示。優先順:
  //  1. シート側の「データ更新日時」＝同期（DailyCSVSync等）が完了した正確な時刻
  //     （tools/sheet-update-stamp.gs をシートに設定すると書き込まれる）
  //  2. 無ければ、この画面がデータを読み込んだ時刻（最終読込）
  //  3. サンプル表示中は集計基準日
  function dataStamp() {
    if (state.sheetUpdatedAt) return ' <span class="lead-upd" title="スプレッドシート側で記録された、データの同期（更新）が完了した日時">データ更新 ' + ymdhmJa(state.sheetUpdatedAt) + ' 時点</span>';
    if (state.dataLoadedAt) return ' <span class="lead-upd" title="この画面がスプレッドシート／ファイルを読み込んだ日時（シート側の更新日時は未設定）">最終読込 ' + ymdhmJa(state.dataLoadedAt) + ' 時点</span>';
    var a = state.analytics && state.analytics.meta && state.analytics.meta.asOf;
    return a ? ' <span class="lead-upd">基準日 ' + ymdJa(a) + '</span>' : '';
  }
  function ymRangeJa(a, b) {
    if (!a || !b) return '';
    var pa = String(a).split('-'), pb = String(b).split('-');
    return pa[0] === pb[0] ? ymJa(a) + '〜' + (+pb[1]) + '月' : ymJa(a) + '〜' + ymJa(b);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // entity-locked colors
  function cvar(n) { return C.cssVar(n); }
  var STAFF_COLOR = { 'momo': '--series-1', 'aoi': '--series-2' };
  // Per-staff monotonic ordinal ramp (new -> 2nd -> 3rd -> 4th+), same identity
  // hue as STAFF_COLOR — lets an ordinal-tier stacked bar stay staff-colored
  // instead of collapsing every staff into one shared blue ramp.
  var STAFF_RAMP = { 'momo': ['--funnel-2', '--funnel-3', '--funnel-4', '--funnel-5'], 'aoi': ['--funnel-o2', '--funnel-o3', '--funnel-o4', '--funnel-o5'] };
  function staffTierColor(name, tier) { return cvar((STAFF_RAMP[name] || STAFF_RAMP.momo)[tier]); }
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
  // iOS padlock (filled, systemGray) — used beside the 合言葉/管理ロック fields,
  // exactly as in the approved prototype's データ screen.
  function lockSvg() { return '<svg width="18" height="18" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true" class="field-ico"><rect x="1" y="8" width="14" height="11" rx="2.5"/><path d="M4 8V6a4 4 0 0 1 8 0v2h-2V6a2 2 0 0 0-4 0v2Z"/></svg>'; }
  function injectNavIcons() { Array.prototype.forEach.call(document.querySelectorAll('.t-ico[data-ico]'), function (s) { if (!s.firstChild) s.innerHTML = svgIco(s.dataset.ico); }); }

  // ---- career milestones (Phase 3 — self-growth, never compared between staff) --
  var MILESTONES = {
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

  // ---- metric help icons (tap a small "?" for a plain-language description) --
  // A tiny circular button appended right after a label string; the popover is a
  // single shared element positioned near whichever icon is tapped. Capture-phase
  // so it can stop the click before it reaches things like the RFM table's
  // sortable <th> (which has its own click handler for sorting).
  function help(text) { return '<button type="button" class="help-ico" data-help="' + esc(text) + '" aria-label="説明を見る">?</button>'; }
  var helpPopEl = null, helpPopFor = null, helpPopOpenedAt = 0;
  function hideHelpPop() { if (helpPopEl) helpPopEl.classList.remove('show'); if (helpPopFor) helpPopFor.classList.remove('active'); helpPopFor = null; }
  function showHelpPop(btn) {
    if (!helpPopEl) { helpPopEl = document.createElement('div'); helpPopEl.className = 'help-pop'; helpPopEl.setAttribute('role', 'status'); document.body.appendChild(helpPopEl); }
    helpPopEl.textContent = btn.dataset.help;
    var r = btn.getBoundingClientRect();
    var left = Math.max(8, Math.min(window.innerWidth - 268, r.left + r.width / 2 - 130));
    helpPopEl.style.left = left + 'px';
    helpPopEl.style.top = (r.bottom + 8) + 'px';
    helpPopEl.classList.add('show');
    if (helpPopFor) helpPopFor.classList.remove('active');
    helpPopFor = btn; btn.classList.add('active');
    helpPopOpenedAt = Date.now();
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.help-ico');
    if (btn) {
      e.preventDefault(); e.stopPropagation();
      if (helpPopFor === btn) { hideHelpPop(); } else { showHelpPop(btn); }
      return;
    }
    if (!(e.target.closest && e.target.closest('.help-pop'))) hideHelpPop();
  }, true);
  // Dismiss on scroll so a fixed-position popover doesn't drift away from its
  // icon — but ignore scroll events in the instant right after opening: some
  // browsers nudge a scroll container to bring a just-focused element into
  // view (concretely seen with the RFM table's sticky <th>), which would
  // otherwise close the popover the very click that opened it.
  window.addEventListener('scroll', function () { if (Date.now() - helpPopOpenedAt > 200) hideHelpPop(); });

  // ---- card + chart mount helpers -----------------------------------------
  function card(opts) {
    // opts: {title, sub, tag, col, body(html), id}
    // iOS grouped-list idiom (approved prototype's .gsec/.gsec-h): the title,
    // sub and tag render as a 13px gray section header OUTSIDE the white card,
    // inset 16px, with sub/tag right-aligned on the same header line; the white
    // rounded cell contains only the body. The grid column class stays on the
    // OUTER wrapper so the 12-col grid keeps working, and every id/data-kpi/
    // chart mount inside the body is untouched. Cards called without a title
    // (banner, stat tiles, reset row…) stay plain white cells.
    var cls = (opts.col || 'col-12') + (opts.hoverable ? ' hoverable' : '');
    var idAttr = opts.id ? ' id="' + opts.id + '"' : '';
    if (!opts.title) return '<div class="card reveal ' + cls + '"' + idAttr + '>' + opts.body + '</div>';
    // ヘッダー行はタイトル（左）＋タグチップ（右）のみ。補足文(sub)は横幅を圧迫して
    // はみ出す原因になるため、ヘッダーの下の全幅行に置いて自然に折り返させる。
    var head = '<div class="card-head"><div class="card-title">' + opts.title + '</div>' + (opts.tag ? '<span class="card-tag">' + opts.tag + '</span>' : '') + '</div>';
    var sub = opts.sub ? '<div class="card-sub">' + opts.sub + '</div>' : '';
    return '<div class="gsec reveal ' + cls + '"' + idAttr + '>' + head + sub +
      '<div class="card">' + opts.body + '</div></div>';
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

  // 直近30日の日次売上を「月〜日曜」の連続カレンダーで表示（月で段は分けない）。
  // 曜日で列を揃え（月曜始まり）、各日は M/D 表記、土=青/日=赤で色分け、最新日
  // （基準日）はアクセント枠。金額はデスクトップ=フル, 狭幅=圧縮表記。
  var DR_WEEK = ['月', '火', '水', '木', '金', '土', '日'];
  function drMondayIdx(dow) { return (dow + 6) % 7; }   // 日曜=0 → 月曜始まりの列index（月=0…日=6）
  // 日次カレンダー狭幅用の圧縮表記：万・億で統一（k表記は使わない）。
  // 例 1000→0.1万, 7000→0.7万, 34055→3.4万, 100000→10万, 1000未満は数値のまま。
  function drCompact(n) {
    var a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(a >= 1e9 ? 0 : 1) + '億';
    if (a >= 1e3) return (n / 1e4).toFixed(a >= 1e5 ? 0 : 1) + '万';
    return F.int(n);
  }
  function dailyDayCell(d) {
    var cls = 'dr-cell' + (d.dow === 0 ? ' dr-sun' : d.dow === 6 ? ' dr-sat' : '') +
      (d.isAsOf ? ' dr-today' : '') + (d.isFuture ? ' dr-future' : '');
    var date = '<div class="dr-date">' + d.month + '/' + d.day + '</div>';
    // 未来日は「受付待ちの予約金額（見込み）」と予約件数。過去日と同じ3行構成に
    // そろえて（店販行は空で確保）、セルの縦横幅が揃うようにする。
    if (d.isFuture) {
      return '<div class="' + cls + '" title="受付待ちの予約（見込み）">' + date +
        '<div class="dr-rev"><span class="full-num">' + F.int(d.resAmount) + '</span><span class="compact-num">' + drCompact(d.resAmount) + '</span></div>' +
        '<div class="dr-retail">&nbsp;</div>' +
        '<div class="dr-cnt">' + d.resCount + '件</div>' +
        '</div>';
    }
    // 店販売上がある日だけ、()で店販売上金額を併記。無い日も同じ行を空で確保して
    // 全セルの高さを揃える（縦に伸びてバラつくのを防ぐ）。
    var retail = d.retail > 0
      ? '<span class="full-num">（' + F.int(d.retail) + '）</span><span class="compact-num">（' + drCompact(d.retail) + '）</span>'
      : '&nbsp;';
    return '<div class="' + cls + '">' + date +
      '<div class="dr-rev"><span class="full-num">' + F.int(d.rev) + '</span><span class="compact-num">' + drCompact(d.rev) + '</span></div>' +
      '<div class="dr-retail" title="うち店販売上">' + retail + '</div>' +
      '<div class="dr-cnt">' + d.count + '人</div>' +
      '</div>';
  }
  function dailyRevGrid(days) {
    var cells = DR_WEEK.map(function (w, i) {
      return '<div class="dr-wh' + (i === 5 ? ' dr-sat' : i === 6 ? ' dr-sun' : '') + '">' + w + '</div>';
    });
    var lead = drMondayIdx(days[0].dow);   // 先頭日の曜日ぶん先頭を空ける
    for (var b = 0; b < lead; b++) cells.push('<div class="dr-cell dr-empty"></div>');
    days.forEach(function (d) { cells.push(dailyDayCell(d)); });   // 連続日なので月をまたいでも途切れず流れる
    while (cells.length % 7 !== 0) cells.push('<div class="dr-cell dr-empty"></div>');   // 末尾を週単位に揃える
    return '<div class="dr-grid">' + cells.join('') + '</div>';
  }

  // ============================ OVERVIEW ===================================
  function renderOverview() {
    var A = state.analytics, s = A.store, t = A.trend;
    var head = '<div class="view-title">店舗ダッシュボード</div><div class="view-lead">' + esc(ymRangeJa(A.meta.periodStart, A.meta.periodEnd)) + ' ／ 来店顧客 ' + esc(s.customers) + '人。' + (A.meta.taxExcluded ? '<b>金額はすべて税抜表示です。</b>' : '') + dataStamp() + '</div>';
    var html = '';

    // 新しい端末への案内: 共有設定（暗号化済みシートURL）が同梱されているのに
    // まだ何も連携していない = サンプルデータを見ている状態。合言葉の入力へ誘導。
    if (state.sharedBlob && state.source === 'サンプルデータ') {
      html += card({
        col: 'col-12',
        body: '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:200px"><b>いまはサンプルデータを表示しています。</b><br>' +
          '<span class="note-inline">お店の合言葉を入力すると、この端末でも店舗の実データが表示されます（初回のみ）。</span></div>' +
          '<button class="pill accent" type="button" onclick="location.hash=\'#data\'">合言葉を入力する</button></div>'
      });
    }

    // KPI tile row (revenue KGI & effective-reservation count intentionally omitted)
    var rt = s.retail;
    var taxTag = A.meta.taxExcluded ? '（税抜）' : '';
    html += statTile('yen', '予約ベース客単価' + taxTag + help('予約ベースの売上（会計済みの実績＋受付待ちの見込み）÷ 予約件数（来店＋受付待ち）。下の「実績客単価」は見込みを含まない、会計済みのみの客単価。金額は税抜（消費税10%）。'), F.int(s.avgSpendReservation), '¥', '実績客単価 ' + yen(s.avgSpendActual), 'sparkSpend');
    html += statTile('ltv', '顧客LTV（現状）' + taxTag + help('来店顧客1人あたりの累計売上（実績のみ）。「予測」は現在の客単価が今後も続くと仮定し、1回〜5回到達率の合計（期待来店回数）を掛けて見積もった将来のLTV。金額は税抜。'), F.int(s.ltv.current), '¥', '<span class="chip up">↑ 予測 ' + yen(s.ltv.predicted) + '</span> 期待来店 ' + s.ltv.expectedVisits + '回', null);
    html += statTile('retail', '店販顧客比率' + help('来店顧客のうち、店販（物販）を購入した人の割合。会計時の店販金額または商品名の記録から算出。'), pct(rt.customerRatio * 100, 1), '%', '店販購入 ' + rt.buyers + '人 ／ 来店顧客 ' + rt.visitCustomers + '人', null, 'retail-customer-ratio');

    // 売上サマリー（実績のみ・期間バケット）
    html += card({
      col: 'col-12', title: '売上サマリー（実績）' + taxTag + help('会計済みの売上のみを対象にした、直近3ヶ月（今月を含まない確定3ヶ月）・先月・今月（集計中）の平均。平均月間売上の分母は「来店のあった月数」、平均日間売上の分母は「営業日（会計が1件以上あった日数）」。金額は税抜。'),
      body: periodTable(s.revPeriods, 'rev-periods')
    });

    // Retention meters + monthly revenue
    html += card({
      col: 'col-5', title: '定着・リピート',
      sub: '来店顧客 ' + s.customers + '人が母数',
      body: '<div class="cell-list"><div id="mRepeat" data-kpi="repeat-rate"></div><div id="mNext" data-kpi="next-reserve-rate"></div><div id="mFix" data-kpi="fixation-rate"></div></div>' +
        '<div class="note-inline" style="margin-top:10px">来店周期の中央値 <b>' + s.visitCycleMedianDays + '日</b>。</div>'
    });
    html += card({
      col: 'col-7', title: '月次 予約ベース売上' + taxTag + help('月ごとの売上を、会計済み（実績・濃色）と受付待ち（見込み・薄色）の内訳で積み上げ表示。見込みは受付待ちの予約金額（会計前）を反映したもの。金額は税抜。'), sub: '会計済み（実績）＋ 受付待ち（見込み）', tag: '¥',
      body: chartBox('cRevenue', 260)
    });

    // Funnel + cohort
    html += card({
      col: 'col-5', title: 'リテンション ファネル' + help('各バーの到達人数は予約ベース：受付待ちの予約も「到達」に数え、キャンセルのみで次の予約が無い場合は到達扱いにせず、キャンセル後に別の予約を取っていれば到達として数える。段の間の継続率／離脱率は「実際にその回数まで来店した人」を母数にする（まだ来店前＝2回目が受付待ちの顧客は、構造上まだ次の予約を取りようがないため母数から除く）。分子は予約ベースのまま次回の予約を数えるので、固定化率と同じ考え方。'),
      sub: '来店顧客 ' + s.customers + '人が母数（1回 → 5回 到達）',
      body: '<div id="cFunnel"></div>'
    });
    html += card({
      col: 'col-7', title: '月次コホート リピート率' + help('初回来店した月ごとに顧客をグループ化し、そのグループの何%が2回目来店に到達したかを表示。'), sub: '初回獲得月ごとの2回目到達', tag: '%',
      body: chartBox('cTCohortR', 230)
    });
    html += card({
      col: 'col-6', title: '月次コホート LTV' + help('初回来店した月ごとに顧客をグループ化し、そのグループの現時点までの累計売上を平均したもの。'), sub: '初回獲得月ごとの累計売上', tag: '¥',
      body: chartBox('cTCohortL', 220)
    });
    html += card({
      col: 'col-6', title: '客単価の推移' + taxTag + help('月ごとの客単価の推移。「予約ベース客単価」＝予約ベース売上（会計済みの実績＋受付待ちの見込み）÷ 予約件数（来店＋受付待ち）。「実績客単価」＝会計済み売上 ÷ 来店件数で、見込みを含まない確定値。予約・来店の無い月は線を引きません。金額は税抜。'),
      sub: '予約ベース客単価と実績客単価の月次推移', tag: '¥',
      body: chartBox('cSpendTrend', 230)
    });

    // 店販 + 新規/再来 + visit-count
    // 視認性改善: 従来は4つの数字が同サイズで並び主役が埋没していたため、
    // 「店販売上比率」（金額データが無ければ「店販顧客比率」で代用）を
    // ヒーロー数値として大きく見せ、残りはサブ統計に格下げする。
    var retailHero = rt.hasAmount
      ? { v: rt.revenueRatio != null ? pct(rt.revenueRatio * 100, 1) : '—', label: '店販売上比率', kpi: 'retail-revenue-ratio' }
      : { v: pct(rt.customerRatio * 100, 1), label: '店販顧客比率', kpi: 'retail-customer-ratio' };
    html += card({
      col: 'col-6', title: '店販（物販）実績' + help('店販売上比率＝全体売上に占める店販金額の割合。店販顧客比率＝来店顧客のうち店販を購入した人の割合。店販単価＝店販1件あたりの平均購入額。'), sub: rt.hasAmount ? '会計時店販金額をもとに算出' : '商品名から購入率のみ算出中',
      body: heroMetric(retailHero.v, null, retailHero.label, false, retailHero.kpi) +
        (rt.hasAmount ? '<div class="mini-stats" style="margin-top:14px">' +
          miniStat(yen(rt.amount), '店販金額', 'retail-amount') +
          miniStat(yen(rt.avgSpend), '店販単価', 'retail-avg-spend') +
          miniStat(pct(rt.customerRatio * 100, 1), '店販顧客比率', 'retail-customer-ratio') +
          '</div>' : '') +
        (rt.hasAmount && s.retailPeriods ? '<div style="margin-top:14px">' + retailPeriodTable(s.retailPeriods) + '</div>' : '') +
        (rt.hasAmount ? '' : '<div class="note-inline" style="margin-top:12px">金額・売上比率・単価は、スプレッドシートに <b>「会計時店販金額」</b> 列を追加すると自動表示されます。</div>')
    });
    var lastMix = s.newMix.filter(function (m) { return m.new + m.repeat > 0; }).slice(-1)[0];
    var mixNote = lastMix && (lastMix.new + lastMix.repeat) ? '直近月（' + monthShort(lastMix.m) + '）の再来比率 ' + pct(lastMix.repeat / (lastMix.new + lastMix.repeat) * 100, 0) : '月次の新規・再来来店数';
    html += card({
      col: 'col-6', title: '新規・再来' + help('月ごとの来店・予約を、その顧客にとって何回目にあたるかで内訳表示（新規／2回目／3回目／4回目以上）。会計済みの実績と受付待ちの見込みを合算した予約ベースで、回数別に1色で積み上げ。スタッフタブの「月次 予約数の比較」と同じ考え方。棒の上の数字は合計件数。'),
      sub: mixNote + '　※予約ベース（会計済み＋受付待ちの合算）', tag: '件', body: chartBox('cNewMix', 210)
    });
    html += card({ col: 'col-6', title: '来店回数の構成' + help('全期間を通じて、来店回数（1回目・2回目・3回目・4回目以上）ごとの来店件数と、その回数における平均客単価。'), sub: '回数別', body: '<div id="cVisitComp"></div>' });

    mount('overview', head + '<div class="grid">' + html + '</div>');

    // draw
    tileSpark('sparkSpend', s.monthly.map(function (m) { return m.spend; }));

    draw('mRepeat', function (el) { C.meter(el, { label: 'リピート率（2回到達）', help: '来店顧客のうち、2回目の予約（来店・今後の予約含む）に到達した人の割合。キャンセルのみで次の予約が入っていない場合は到達扱いにせず、キャンセル後に別の予約を取っていれば到達として数える。', value: s.repeatRate / 100, display: pct(s.repeatRate), target: 0.7, sub: frac(s.repeatNumer, s.repeatDenom, '人') + ' ・ 目安 70%' }); });
    draw('mNext', function (el) { C.meter(el, { label: '次回予約取得率', help: '来店（会計済み）のうち、その後に何らかの予約・来店（キャンセルは除く）があった割合。1回目〜複数回目まで、来店ごとに1件として集計。', value: s.nextReserveRate / 100, display: pct(s.nextReserveRate), sub: frac(s.nextReserveNumer, s.nextReserveDenom, '件') }); });
    draw('mFix', function (el) { C.meter(el, { label: '固定化率（3回到達）', help: '分母は「実際に2回来店した顧客」、分子は「そのうち3回目の予約を確保した人（受付待ち含む・キャンセル後の再予約も計上）」。リピート率（2回到達）は将来予約も含めた予約ベースで数えるため母集団が異なる。', value: s.fixationRate / 100, display: pct(s.fixationRate), target: 0.6, sub: frac(s.fixNumer, s.fixDenom, '人') + ' ・ 目安 60%' }); });

    draw('cRevenue', function (el) {
      // 会計済み（実績・濃色）＋受付待ち（見込み・薄色）を積み上げ表示。
      C.columns(el, {
        groups: s.monthly.map(function (m) { return monthShort(m.m); }), stacked: true,
        series: [
          { name: '実績（会計済み）', color: cvar('--series-1'), values: s.monthly.map(function (m) { return m.revActual; }) },
          { name: '見込み（受付待ち）', color: cvar('--funnel-2'), values: s.monthly.map(function (m) { return m.revExpected; }) }
        ],
        valueFmt: function (v) { return yen(Math.round(v)); }, totalFmt: F.compact, yFmt: F.compact, height: 260
      });
    });
    draw('cTCohortR', function (el) {
      C.lineArea(el, { xLabels: t.monthlyCohort.map(function (c) { return monthShort(c.m); }), yMax: 100, series: [{ name: 'リピート率', color: cvar('--series-1'), values: t.monthlyCohort.map(function (c) { return c.repeat * 100; }) }], valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230 });
    });
    draw('cTCohortL', function (el) {
      C.columns(el, { groups: t.monthlyCohort.map(function (c) { return monthShort(c.m); }), series: [{ name: 'LTV', color: cvar('--series-4'), values: t.monthlyCohort.map(function (c) { return c.ltv; }) }], valueFmt: yen, yFmt: F.compact, height: 220 });
    });
    draw('cSpendTrend', function (el) {
      // 予約ベース客単価（見込み込み）と実績客単価（会計済みのみ）の月次推移。
      // 予約・来店の無い月は null にして¥0へ落とさずギャップにする。
      C.lineArea(el, {
        xLabels: s.monthly.map(function (m) { return monthShort(m.m); }), area: false,
        series: [
          // 2本の終端月が異なり（見込みを含む予約ベースの方が先の月まで伸びる）、
          // 終端ラベルはどちらの線を指すのか紛らわしいため出さない（凡例で識別）。
          { name: '予約ベース客単価', color: cvar('--series-1'), endLabel: false, values: s.monthly.map(function (m) { return m.res ? m.spend : null; }) },
          { name: '実績客単価', color: cvar('--series-4'), endLabel: false, values: s.monthly.map(function (m) { return m.spendActual; }) }
        ],
        valueFmt: yen, yFmt: F.compact, height: 230
      });
    });
    draw('cFunnel', function (el) {
      C.funnel(el, {
        stages: s.funnel.map(function (f, i) { return { label: f.n + '回', value: f.people, sub: pct(f.reach * 100, 0) + ' 到達', cont: f.cont, contNum: f.contNum, contDen: f.contDen }; })
      });
    });
    draw('cVisitComp', function (el) {
      C.hbars(el, {
        items: s.visitCountBreakdown.map(function (b, i) { return { label: b.label, value: b.count, sub: '客単価 ' + yen(b.spend), color: cvar(['--funnel-2', '--funnel-3', '--funnel-4', '--funnel-5'][i]) }; }),
        valueFmt: function (v) { return v + '件'; }
      });
    });
    draw('cNewMix', function (el) {
      // 予約ベースの内訳（会計済みの実績＋受付待ちの見込みを合算）。回数別に1色で
      // 積み上げ（見込みを薄色で分けず、確定分と合算して表示）。
      var comp = s.newMix.map(function (m) { return s.composition.filter(function (x) { return x.m === m.m; })[0] || { expNew: 0, expV2: 0, expV3: 0, expV4: 0 }; });
      C.columns(el, {
        groups: s.newMix.map(function (m) { return monthShort(m.m); }), stacked: true,
        series: [
          { name: '新規', color: cvar('--funnel-2'), values: s.newMix.map(function (m, i) { return m.new + comp[i].expNew; }) },
          { name: '2回目', color: cvar('--funnel-3'), values: s.newMix.map(function (m, i) { return m.v2 + comp[i].expV2; }) },
          { name: '3回目', color: cvar('--funnel-4'), values: s.newMix.map(function (m, i) { return m.v3 + comp[i].expV3; }) },
          { name: '4回目以上', color: cvar('--funnel-5'), values: s.newMix.map(function (m, i) { return m.v4 + comp[i].expV4; }) }
        ],
        valueFmt: function (v) { return v + '件'; }, height: 210
      });
    });
    flush();
  }
  function heroMetric(v, unit, label, isYen, dataKpi) {
    return '<div class="hero-metric"' + (dataKpi ? ' data-kpi="' + dataKpi + '"' : '') + '><b>' + (isYen ? '¥' : '') + v + (unit && !isYen ? '<span style="font-size:.55em;opacity:.7"> ' + unit + '</span>' : '') + '</b><span>' + label + '</span></div>';
  }
  // Prototype .kpi tile: 12px gray label on top, 24px/700 value, 11px caption.
  // (`ico` stays in the signature for call-site stability but is no longer
  // rendered — the prototype's KPI tiles carry no icon chrome.)
  function statTile(ico, label, value, unit, foot, sparkId, dataKpi) {
    return card({
      col: 'col-4', hoverable: true,
      body: '<div class="stat"' + (dataKpi ? ' data-kpi="' + dataKpi + '"' : '') + '><div class="stat-top"><span class="stat-label">' + label + '</span></div>' +
        '<div class="stat-value">' + (unit === '¥' ? '¥' : '') + '<span class="cu" data-to="' + (typeof value === 'string' ? value.replace(/[^\d.]/g, '') : value) + '" data-unit="' + (unit === '¥' ? 'yen' : (unit === '%' ? 'pct' : 'int')) + '">' + value + '</span>' + (unit && unit !== '¥' ? '<span class="unit">' + unit + '</span>' : '') + '</div>' +
        (sparkId ? '<div class="spark" id="' + sparkId + '"></div>' : '') +
        '<div class="stat-foot">' + foot + '</div></div>'
    });
  }
  function tileSpark(id, values) { draw(id, function (el) { C.sparkline(el, values, cvar('--series-1')); }); }
  function miniStat(v, label, dataKpi) { return '<div class="mini-stat"' + (dataKpi ? ' data-kpi="' + dataKpi + '"' : '') + '><b>' + v + '</b><span>' + label + '</span></div>'; }

  // ---- 年商カードの期間ヘルパー ---------------------------------------------
  // 期間は 20260703 形式の数値（ymd）で扱う。数値なので範囲比較がそのまま出来て、
  // <input type="date"> の 'YYYY-MM-DD' とは下の2関数で相互変換する。
  function ymdToInput(n) { var s = String(n); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); }
  function inputToYmd(v) { var p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return p ? +p[1] * 10000 + +p[2] * 100 + +p[3] : null; }
  function ymdLabel(n) { var s = String(n); return +s.slice(0, 4) + '年' + (+s.slice(4, 6)) + '月' + (+s.slice(6, 8)) + '日'; }
  // 指定期間の日次を合計する。営業日数＝会計が1件でもあった日、月数＝会計のあった
  // 月の種類数（平均月商の分母。データの無い月で薄まらないようにするため）。
  function sumDays(days, from, to) {
    var t = { rev: 0, count: 0, retail: 0, resAmount: 0, resCount: 0, bizDays: 0, months: 0 };
    var mset = {};
    days.forEach(function (x) {
      if (x.ymd < from || x.ymd > to) return;
      t.rev += x.rev; t.count += x.count; t.retail += x.retail;
      t.resAmount += x.resAmount; t.resCount += x.resCount;
      if (x.count > 0) { t.bizDays += 1; mset[x.y * 100 + x.m] = 1; }
    });
    t.months = Object.keys(mset).length;
    return t;
  }

  // 期間バケット売上テーブル（直近3ヶ月/先月/今月 × 平均月間売上/平均日間売上）。
  // engine の revPeriods（実績のみ・営業日割り）をそのまま表示する。月の範囲や
  // 「集計中」「営業日」といった補足は、カード見出しのヘルプで説明済みなので
  // 表内には繰り返さない。
  function periodCols(rp) {
    return [
      { b: rp.last3, label: '直近3ヶ月' },
      { b: rp.prevMonth, label: '先月' },
      { b: rp.currentMonth, label: '今月' }
    ];
  }
  function periodTable(rp, dataKpiPrefix) {
    var cols = periodCols(rp);
    function row(label, pick) {
      return '<tr><td style="text-align:left">' + label + '</td>' + cols.map(function (c) {
        var v = pick(c.b);
        // Full figure by default; ~320px-wide phones swap in the abbreviated
        // form (¥116万) via CSS — a 7-digit month clips there otherwise.
        return '<td>' + (v != null ? '<span class="full-num">' + yen(v) + '</span><span class="compact-num">' + yenCompact(v) + '</span>' : '—') + '</td>';
      }).join('') + '</tr>';
    }
    return '<div class="table-wrap"><table class="kate-table period-table"' + (dataKpiPrefix ? ' data-kpi="' + dataKpiPrefix + '"' : '') + '><thead><tr><th style="text-align:left"></th>' +
      cols.map(function (c) { return '<th>' + c.label + '</th>'; }).join('') + '</tr></thead><tbody>' +
      row('平均月間売上', function (b) { return b.monthly; }) +
      row('平均日間売上', function (b) { return b.daily; }) +
      '</tbody></table></div>';
  }
  // 店販の期間バケット（retailPeriods は月単位の単純な数値／null のみ、
  // periodTable の {monthly,daily} 形状とは異なるため専用の1行テーブル）。
  function retailPeriodTable(rp) {
    var cols = periodCols(rp);
    return '<div class="table-wrap"><table class="kate-table period-table" data-kpi="retail-periods"><thead><tr><th style="text-align:left"></th>' +
      cols.map(function (c) { return '<th>' + c.label + '</th>'; }).join('') + '</tr></thead><tbody>' +
      '<tr><td style="text-align:left">店販売上/月</td>' + cols.map(function (c) {
        var v = c.b;
        return '<td>' + (v != null ? '<span class="full-num">' + yen(v) + '</span><span class="compact-num">' + yenCompact(v) + '</span>' : '—') + '</td>';
      }).join('') + '</tr></tbody></table></div>';
  }

  // ============================ STAFF ======================================
  function renderStaff() {
    var A = state.analytics, months = A.store.monthly.map(function (m) { return monthShort(m.m); });
    var staff = A.staff;
    var asOfMonth = A.meta.asOf ? A.meta.asOf.slice(0, 7) : null;
    var head = '<div class="view-title">スタッフ ダッシュボード</div><div class="view-lead">累計ではなく月次と平均で評価。' + (A.meta.taxExcluded ? '<b>金額はすべて税抜表示です。</b>' : '') + dataStamp() + '</div>';
    var html = '';

    // スタッフ比較（中立の一覧表 — 競争をあおる表現はしない）。全項目、直近3ヶ月
    // （今月を含まない確定3ヶ月）の平均で統一 — カードタイトル脇の注記に集約し、
    // 各行のラベルには「（直近3ヶ月）」等の重複表記は付けない。
    var pctOrDash = function (v, d) { return v == null || !isFinite(v) ? '—' : pct(v * 100, d); };
    var yenOrDash = function (v) { return v == null ? '—' : yen(v); };
    // 各指標に分母・分子（sub）を添えられるようにする。sub は該当セルの数値の下に
    // 小さく「分子 ÷ 分母」を表示する（比較表内で乖離の理由が一目で分かるように）。
    var vsMetrics = [
      { label: '平均来店 / 月', help: '直近3ヶ月のうち、実績のある月ごとの来店件数を単純平均したもの。', fmt: function (st) { return F.int(st.avgRecent.visitsPerMonth) + '件'; } },
      { label: '平均月間売上', help: '直近3ヶ月の、来店のあった月数で割った平均月間売上（会計済みのみ）。', fmt: function (st) { return yenOrDash(st.revPeriods.last3.monthly); } },
      { label: '平均日間売上', help: '直近3ヶ月の会計済み売上を、営業日（会計が1件以上あった日数）で割った平均。', fmt: function (st) { return yenOrDash(st.revPeriods.last3.daily); } },
      { label: '平均客単価', help: '直近3ヶ月の客単価。予約ベース売上の合計 ÷ 予約数の合計（件数で重み付けしたプール平均）。', fmt: function (st) { return yen(st.avgRecent.spend); },
        sub: function (st) { return st.avgRecent.spendRes ? yenCompact(st.avgRecent.spendRev) + ' ÷ ' + F.int(st.avgRecent.spendRes) + '件' : ''; } },
      { label: 'リピート率（2回到達）', help: 'このスタッフが直近3ヶ月に初回担当した顧客のうち、2回目の予約（来店・今後の予約含む）に到達した人の割合。キャンセルのみで次の予約が入っていない場合は到達扱いにせず、キャンセル後に別の予約を取っていれば到達として数える。', fmt: function (st) { return pctOrDash(st.reach2); },
        sub: function (st) { return st.reach2 == null ? '' : frac(st.reach2Num, st.reachDen, '人'); } },
      { label: '次回予約取得率', help: 'このスタッフが直近3ヶ月に担当した来店のうち、その後に何らかの予約・来店があった割合。次回を確保した来店の合計 ÷ 来店の合計（件数で重み付けしたプール平均）。', fmt: function (st) { return pctOrDash(st.avgRecent.nextRes); },
        sub: function (st) { return st.avgRecent.nextRes == null ? '' : frac(st.avgRecent.nextResNum, st.avgRecent.nextResDen, '件'); } },
      { label: '固定化率（3回到達）', help: '分母は「実際に2回来店した顧客」、分子は「そのうち3回目の予約を確保した人（受付待ち含む）」。リピート率（2回到達）は将来予約も含む予約ベースで数えるため母集団が異なる。', fmt: function (st) { return pctOrDash(st.fixationRate); },
        sub: function (st) { return st.fixationRate == null ? '' : frac(st.fixNumer, st.fixDenom, '人'); } },
      { label: '店販顧客比率', help: 'このスタッフが直近3ヶ月に担当した来店顧客のうち、店販を購入した人の割合。', fmt: function (st) { return pctOrDash(st.avgRecent.retailCustomerRatio, 1); },
        sub: function (st) { return st.avgRecent.retailVisitCustomers ? frac(st.avgRecent.retailBuyers, st.avgRecent.retailVisitCustomers, '人') : ''; } }
    ];
    var vs = '<div class="table-wrap"><table class="vs-table"><thead><tr><th></th>' +
      staff.map(function (st) { return '<th><i class="vs-dot" style="background:' + cvar(STAFF_COLOR[st.name]) + '"></i>' + esc(st.name) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      vsMetrics.map(function (m) {
        return '<tr><td>' + m.label + (m.help ? help(m.help) : '') + '</td>' + staff.map(function (st) {
          var sub = m.sub ? m.sub(st) : '';
          return '<td><b>' + m.fmt(st) + '</b>' + (sub ? '<span class="vs-frac">' + sub + '</span>' : '') + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
    html += card({ col: 'col-12', title: 'スタッフ比較' + help('特に注記がない限り、すべて直近3ヶ月（今月を含まない確定3ヶ月）の平均値。率は件数で重み付けしたプール平均で、各数値の下に「分子 ÷ 分母」を表示。'), sub: '数値はすべて直近3ヶ月の平均・下段は分子÷分母', body: vs });

    // Staff cards
    staff.forEach(function (st, i) {
      var col = cvar(STAFF_COLOR[st.name] || '--series-6');
      var matureNote = A.meta.completedOnly
        ? '<span data-kpi="staff-' + esc(st.name) + '-mature-n">・成熟母数 ' + st.matureAcquired + '人</span>' : '';
      var regMile = milestoneProgress(st.regulars3, MILESTONES.regulars);
      var regNote = '・育てた常連 <b data-kpi="staff-' + esc(st.name) + '-regulars3">' + F.int(st.regulars3) + '人</b>' +
        (regMile.maxed ? '（最高節目達成）' : '（次の節目 ' + F.int(regMile.next) + '人）');
      html += card({
        col: 'col-6', hoverable: true,
        body: '<div class="staff-head"><div class="staff-avatar" style="background:' + col + '">' + esc(st.name[0].toUpperCase()) + '</div>' +
          '<div><div class="staff-name">' + esc(st.name) + '<span>実績 ' + st.avg.months + 'ヶ月 ・ 獲得顧客 ' + st.acquired + '人' + matureNote + regNote + '</span></div></div></div>' +
          '<div class="staff-metrics">' +
          sm(F.int(st.avg.visitsPerMonth), '平均来店 / 月' + help('実績のある月ごとの来店件数を単純平均したもの。')) + sm(yen(st.avg.spend), '平均客単価' + help('月ごとの客単価（予約ベース売上÷予約数）を単純平均したもの。')) +
          sm(pct(st.retail.customerRatio * 100, 1), '店販顧客比率' + help('このスタッフが担当した来店顧客のうち、店販を購入した人の割合。'), 'staff-' + esc(st.name) + '-retail') +
          sm(st.retail.avgMonthlyAmount != null ? yen(st.retail.avgMonthlyAmount) : '—', '平均店販売上 / 月' + help('月ごとの店販売上合計を、実績のある月数で割った平均。'), 'staff-' + esc(st.name) + '-retail-avg') +
          '</div>' +
          '<div style="margin-top:14px" data-kpi="staff-' + esc(st.name) + '-rev-periods">' + periodTable(st.revPeriods) + '</div>' +
          '<div class="cell-list" style="margin-top:10px"><div id="stMeterRepeat' + i + '"></div>' +
          '<div id="stMeterNext' + i + '"></div>' +
          '<div id="stMeterFix' + i + '"></div></div>' +
          personalBestBlock(st) +
          sgPanel(st, asOfMonth) +
          '<div class="next-hint" data-kpi="staff-' + esc(st.name) + '-next-hint">' + esc(nextHintText(st)) + '</div>'
      });
    });

    html += card({ col: 'col-12', title: '月次 予約数の比較' + help('月ごとにスタッフの棒を並べた積み上げ棒グラフ。色相でスタッフ、濃淡で来店回数（新規／2回目／3回目／4回目以上）を表現。会計済みの実績と受付待ちの見込みを合算した予約ベース。バーの下の色帯がスタッフ名の目印、上の数字は月ごとの合計件数。'), tag: '件', body: chartBox('cStaffRes', 250) });
    html += card({ col: 'col-6', title: '月次 予約ベース売上の比較' + help('月ごとの売上（会計済みの実績＋受付待ちの見込み）をスタッフ別に比較。'), tag: '¥', body: chartBox('cStaffRev', 240) });
    html += card({ col: 'col-6', title: '客単価の推移' + help('月ごとの客単価（予約ベース売上÷予約数）の推移をスタッフ別に表示。'), tag: '¥', body: chartBox('cStaffSpend', 230) });
    var censNote = A.meta.completedOnly ? '　※直近の月は再来待ちのため集計対象外' : '';
    html += card({ col: 'col-6', title: '次回予約取得率の推移' + help('来店（会計済み）のうち、その後に何らかの予約・来店があった割合の月次推移。'), sub: '来店時に次の予約を確保できた割合' + censNote, tag: '%', body: chartBox('cStaffNext', 230) });
    html += card({ col: 'col-6', title: '月別リピート率の推移' + help('初回来店した月ごとに、このスタッフが担当した新規顧客を母数として、2回目の予約（来店・今後の予約含む）に到達した割合の推移。店舗全体のリピート率と同じ予約ベースの定義。次の2つの月は、完了した月と比べられないため表示しません：<b>集計途中の当月</b>（月の途中までの部分的なコホート）と、<b>母数が5人未満の月</b>（1人の挙動が100%や0%に化けるため）。'), sub: '獲得月コホートの2回到達率　※集計途中の当月・母数5人未満の月は非表示', tag: '%', body: chartBox('cStaffRepeatRate', 230) });
    html += card({ col: 'col-6', title: '月別固定化率の推移' + help('初回来店した月ごとに、実際に2回来店した顧客を母数として、3回目の予約を確保した割合の推移。店舗全体の固定化率と同じ定義。次の2つの月は表示しません：<b>集計途中の当月</b>（例：基準日が7月3日なら7月の獲得は3日ぶんだけで、たまたま全員が次回予約を取っていれば100%になってしまう）と、<b>母数（2回来店した人）が5人未満の月</b>。'), sub: '獲得月コホートの3回到達率（2回来店が母数）　※集計途中の当月・母数5人未満の月は非表示', tag: '%', body: chartBox('cStaffFixRate', 230) });
    if (A.store.retail.hasAmount) {
      html += card({ col: 'col-6', title: '店販売上の推移' + help('月ごとの店販売上金額の推移をスタッフ別に表示。'), tag: '¥', body: chartBox('cStaffRetail', 230) });
    }
    if (staff.some(function (st) { return st.utilization; })) {
      html += card({ col: 'col-6', title: '月次 施術時間と稼働率' + help('稼働率＝施術時間の合計 ÷ 稼働可能時間（実際に施術のあった日数 × 1日8時間）。進行中の当月・未来月は表示しない。予約データに所要時間の記録がある場合のみ算出可能。'), sub: '実稼働日 × 8時間を分母に算出', tag: '%', body: chartBox('cStaffUtil', 230) });
    }

    mount('staff', head + '<div class="grid">' + html + '</div>');

    staff.forEach(function (st, i) {
      draw('stMeterRepeat' + i, function (el) {
        C.meter(el, { label: 'リピート率（2回到達）', help: 'このスタッフが直近3ヶ月に初回担当した顧客のうち、2回目の予約（来店・今後の予約含む）に到達した人の割合。キャンセルのみで次の予約が入っていない場合は到達扱いにせず、キャンセル後に別の予約を取っていれば到達として数える。', value: st.reach2 || 0, display: st.reach2 == null ? '—' : pct(st.reach2 * 100), color: cvar(STAFF_COLOR[st.name]), target: 0.7, sub: (st.reach2 == null ? '対象顧客なし' : frac(st.reach2Num, st.reachDen, '人')) + ' ・ 目安 70%' });
      });
      draw('stMeterNext' + i, function (el) {
        C.meter(el, { label: '次回予約取得率', help: '来店（会計済み）のうち、その後に何らかの予約・来店（キャンセルは除く）があった割合。全期間のプール平均（次回を確保した来店の合計 ÷ 来店の合計）。', value: st.avg.nextRes || 0, display: st.avg.nextRes == null ? '—' : pct(st.avg.nextRes * 100), color: cvar(STAFF_COLOR[st.name]), sub: (st.avg.nextRes == null ? '来店なし' : frac(st.avg.nextResNum, st.avg.nextResDen, '件') + '（全期間）') });
      });
      draw('stMeterFix' + i, function (el) {
        C.meter(el, { label: '固定化率（3回到達）', help: '分母は「このスタッフが直近3ヶ月に初回担当し、実際に2回来店した顧客」、分子は「そのうち3回目の予約を確保した人（受付待ち含む）」。実来店2回目がまだいなければ「—」（新任は母数不足で測定不能）。', value: st.fixationRate || 0, display: st.fixationRate == null ? '—' : pct(st.fixationRate * 100), color: cvar(STAFF_COLOR[st.name]), target: 0.6, sub: (st.fixationRate == null ? '実来店2回目がまだいません' : frac(st.fixNumer, st.fixDenom, '人')) + ' ・ 目安 60%' });
      });
    });
    // 月次予約数の比較: 月ごとのクラスターにスタッフ別の積み上げ棒をまとめて表示
    // （新規/2回目/3回目/4回目以上、会計済み＝濃色・受付待ち＝同色を薄くして重畳）。
    // 月×スタッフを横並びのフラット軸にすると隣の月まで距離が均等になり
    // 「どの2本が同じ月か」が読み取りにくいため、月を1クラスターにまとめ、
    // ラベルも月1回＋スタッフ名のみに簡略化する。
    var activeMonths = A.store.monthly.filter(function (m) {
      return staff.some(function (st) { var sm = st.monthly.filter(function (x) { return x.m === m.m; })[0]; return sm && sm.res; });
    });
    var resGroups = activeMonths.map(function (m) { return monthShort(m.m); });
    var resData = { new: [], v2: [], v3: [], v4: [], expNew: [], expV2: [], expV3: [], expV4: [] };
    var resSubLabels = [], resSubColors = [];
    activeMonths.forEach(function (m) {
      staff.forEach(function (st) {
        var cp = st.composition.filter(function (x) { return x.m === m.m; })[0] || { new: 0, v2: 0, v3: 0, v4: 0, expNew: 0, expV2: 0, expV3: 0, expV4: 0 };
        resData.new.push(cp.new); resData.v2.push(cp.v2); resData.v3.push(cp.v3); resData.v4.push(cp.v4);
        resData.expNew.push(cp.expNew); resData.expV2.push(cp.expV2); resData.expV3.push(cp.expV3); resData.expV4.push(cp.expV4);
        resSubLabels.push(st.name); resSubColors.push(cvar(STAFF_COLOR[st.name]));
      });
    });
    draw('cStaffRes', function (el) {
      function tierColor(tier) { return function (bi) { return staffTierColor(resSubLabels[bi], tier); }; }
      // 受付待ちの見込みを薄色で分けず、確定分（会計済み）と合算して回数別に1色で積み上げ。
      function sum(a, b) { return a.map(function (v, i) { return v + b[i]; }); }
      C.columnClusters(el, {
        groups: resGroups, clusterSize: staff.length, subLabels: resSubLabels, subColors: resSubColors,
        series: [
          { name: '新規', color: tierColor(0), values: sum(resData.new, resData.expNew) },
          { name: '2回目', color: tierColor(1), values: sum(resData.v2, resData.expV2) },
          { name: '3回目', color: tierColor(2), values: sum(resData.v3, resData.expV3) },
          { name: '4回目以上', color: tierColor(3), values: sum(resData.v4, resData.expV4) }
        ],
        valueFmt: function (v) { return v + '件'; }, hideLegend: true, height: 250
      });
    });
    draw('cStaffRev', function (el) { C.columns(el, { groups: months, series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.rev; }) }; }), valueFmt: function (v) { return yen(v); }, totalFmt: yenCompact, yFmt: F.compact, height: 240 }); });
    draw('cStaffSpend', function (el) { C.lineArea(el, { xLabels: months, area: false, series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.spend; }) }; }), valueFmt: yen, yFmt: F.compact, height: 230 }); });
    draw('cStaffNext', function (el) {
      C.lineArea(el, {
        xLabels: months, area: false, yMax: 100,
        series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.nextRes == null ? null : m.nextRes * 100; }) }; }),
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230
      });
    });
    draw('cStaffRepeatRate', function (el) {
      C.lineArea(el, {
        xLabels: months, area: false, yMax: 100,
        series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.repeatFixMonthly.map(function (m) { return m.repeat == null ? null : m.repeat * 100; }) }; }),
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230
      });
    });
    draw('cStaffFixRate', function (el) {
      C.lineArea(el, {
        xLabels: months, area: false, yMax: 100,
        series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.repeatFixMonthly.map(function (m) { return m.fix == null ? null : m.fix * 100; }) }; }),
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230
      });
    });
    if (A.store.retail.hasAmount) {
      draw('cStaffRetail', function (el) {
        C.columns(el, {
          groups: months,
          series: staff.map(function (st) { return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.monthly.map(function (m) { return m.retailAmount || 0; }) }; }),
          valueFmt: function (v) { return yen(Math.round(v)); }, totalFmt: yenCompact, yFmt: F.compact, height: 230
        });
      });
    }
    if (staff.some(function (st) { return st.utilization; })) {
      // 稼働率は確定した完了月のみ数値化される（当月・未来月・未成熟月は rate=null）。
      // 進行中の月まで描くと3日分の当月が「急落」に見えるため、rate=null の月は棒を
      // 出さない。全スタッフとも null の末尾月（未来月）は軸からも落とす。
      var utilStaff = staff.filter(function (st) { return st.utilization; });
      var utilLast = -1;
      utilStaff.forEach(function (st) {
        st.utilization.forEach(function (u, mi) { if (u.rate != null && mi > utilLast) utilLast = mi; });
      });
      var utilMonths = A.store.monthly.slice(0, utilLast + 1).map(function (m) { return monthShort(m.m); });
      draw('cStaffUtil', function (el) {
        C.columns(el, {
          groups: utilMonths, yMax: 100,
          series: utilStaff.map(function (st) {
            return { name: st.name, color: cvar(STAFF_COLOR[st.name]), values: st.utilization.slice(0, utilLast + 1).map(function (u) { return u.rate == null ? null : u.rate * 100; }) };
          }),
          valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230
        });
      });
    }
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
  function sgRow(label, st, pick, fmt, asOfMonth, helpText) {
    var g = selfGrowth(st, pick, asOfMonth);
    var labelHtml = label + (helpText ? help(helpText) : '');
    if (!g) return '<div class="sg-row"><span>' + labelHtml + '</span><b class="sg-na">データ蓄積中</b></div>';
    var arrow = g.dir === 'up' ? '↑ 上向き' : g.dir === 'down' ? '↓ 下向き' : '→ 横ばい';
    return '<div class="sg-row"><span>' + labelHtml + '</span><b>自己平均 ' + fmt(g.avg) + '</b><em class="sg-' + g.dir + '">' + arrow + '</em></div>';
  }
  function sgPanel(st, asOfMonth) {
    return '<div class="self-growth"><div class="sg-title">自分の推移（自己平均比）</div>' +
      sgRow('客単価', st, function (m) { return m.spend; }, function (v) { return yen(Math.round(v)); }, asOfMonth, '確定済み月を前半・後半に分け、それぞれの平均を比較。「自己平均」は全確定月の平均値、矢印は前半→後半の変化方向（±3%未満は横ばい）。') +
      sgRow('来店 / 月', st, function (m) { return m.actual; }, function (v) { return F.int(v) + '件'; }, asOfMonth, '確定済み月を前半・後半に分け、それぞれの平均を比較。') +
      sgRow('次回予約取得率', st, function (m) { return m.nextRes == null ? null : m.nextRes * 100; }, function (v) { return v.toFixed(0) + '%'; }, asOfMonth, '確定済み月を前半・後半に分け、それぞれの平均を比較。他スタッフとの比較ではなく、あくまで本人の過去との比較。') +
      '</div>';
  }

  // 自己ベスト（月間の最高記録・自分の過去比のみ／他スタッフとは比較しない）
  function personalBestBlock(st) {
    var pb = st.personalBest;
    if (pb.confirmedMonths < 2) {
      return '<div class="self-growth"><div class="sg-title">自己ベスト</div>' +
        '<div class="empty-note">記録を集めています。確定した月次データが2ヶ月分たまると表示されます。</div></div>';
    }
    function cell(label, best, isLatest, fmt, dataKpi, helpText) {
      if (!best) return '';
      return '<div class="staff-metric"' + (dataKpi ? ' data-kpi="' + dataKpi + '"' : '') + '>' +
        '<b>' + fmt(best.v) + '</b><span>' + label + '（' + monthShort(best.m) + '）' + (isLatest ? '<span class="pb-tag">自己ベスト更新</span>' : '') + (helpText ? help(helpText) : '') + '</span></div>';
    }
    var pbHelp = '確定済み月（当月は除く）の中での最高記録。直近の確定月がそれ以前の全月を上回った場合のみ「自己ベスト更新」と表示（同値は対象外）。他スタッフとの比較はしない。';
    var cells = cell('月間来店', pb.visits, pb.latestIsBest.visits, function (v) { return F.int(v) + '件'; }, null, pbHelp) +
      cell('月間売上', pb.rev, pb.latestIsBest.rev, function (v) { return yen(v); }, null, pbHelp) +
      cell('月間平均単価', pb.spend, pb.latestIsBest.spend, function (v) { return yen(v); }, null, pbHelp) +
      cell('月間店販売上', pb.retail, pb.latestIsBest.retail, function (v) { return yen(v); }, null, pbHelp);
    return '<div class="self-growth"><div class="sg-title">自己ベスト</div><div class="staff-metrics" style="margin-top:10px">' + cells + '</div></div>';
  }

  // 次の一手：目安との差が最も大きい「成熟済み」の指標を1件だけ提案。競争ではなく
  // 本人の伸びしろに焦点を当てるため、他スタッフとの比較は一切行わない。母数が
  // 小さい（20未満）候補は不安定なので提案対象から除外する。
  function nextHintText(st) {
    var candidates = [];
    if (st.acqRecentN >= 20 && st.reach2 != null) candidates.push({ label: 'リピート（2回目のご来店）', value: st.reach2 * 100, target: 70 });
    if (st.acqRecentN >= 20 && st.fixationRate != null) candidates.push({ label: '常連化（3回目のご来店）', value: st.fixationRate * 100, target: 60 });
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
    var head = '<div class="view-title">傾向分析</div><div class="view-lead">曜日・初回獲得月別に、次回予約率とLTVの傾向を読み解きます。' + (A.meta.taxExcluded ? '<b>金額はすべて税抜表示です。</b>' : '') + dataStamp() + '</div>';
    var html = '';

    html += card({
      col: 'col-12', title: '曜日別パフォーマンス' + help('曜日ごとに来店数・次回予約率・客単価・LTVを集計。次回予約率はその曜日の来店のうち次の予約・来店があった割合。LTVはその曜日に初回来店した顧客の累計売上平均。'), sub: '来店の多い曜日と、定着しやすい曜日を把握',
      body: '<div class="segmented" id="dowSeg" role="group" aria-label="曜日別に表示する指標">' +
        [['visits', '来店数'], ['nextRes', '次回予約率'], ['spend', '客単価'], ['ltv', 'LTV']].map(function (o, i) { return '<button type="button" data-m="' + o[0] + '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '"' + (i === 0 ? ' class="active"' : '') + '>' + o[1] + '</button>'; }).join('') +
        '<span class="seg-thumb" id="dowThumb"></span></div>' + chartBox('cDow', 250)
    });
    if (A.store.serviceRetailMonthly) {
      html += card({ col: 'col-12', title: '施術・店販の月次分解' + help('会計時合計金額から店販金額を差し引いたものを施術売上とみなし、月次で店販と積み上げ表示。'), sub: '会計金額の内訳', tag: '¥', body: chartBox('cServiceRetail', 210) });
    }
    html += card({
      col: 'col-12', title: '時間帯 × 曜日 ヒートマップ' + help('来店時刻（予約データがあれば来店開始時間、無ければ会計時刻）を9〜20時の範囲に集計した来店件数。'), sub: '来店の多い時間帯を把握' + (A.meta.completedOnly ? '（会計時刻ベース）' : ''),
      body: chartBox('cHourDow', 0)
    });

    mount('trend', head + '<div class="grid">' + html + '</div>');

    drawDow();
    if (A.store.serviceRetailMonthly) {
      draw('cServiceRetail', function (el) {
        var srm = A.store.serviceRetailMonthly;
        C.columns(el, {
          groups: srm.map(function (m) { return monthShort(m.m); }), stacked: true,
          series: [
            { name: '施術', color: cvar('--series-1'), values: srm.map(function (m) { return m.service; }) },
            { name: '店販', color: cvar('--series-5'), values: srm.map(function (m) { return m.retail; }) }
          ],
          valueFmt: function (v) { return yen(Math.round(v)); }, totalFmt: F.compact, yFmt: F.compact, height: 210
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

  // ============================ RFM ========================================
  var rfmSort = { key: 'M', dir: -1 };
  var rfmCallbackOnly = false;
  function renderRFM() {
    var A = state.analytics, r = A.rfm;
    var html = '<div class="view-title">顧客 RFM 分析</div><div class="view-lead">最終来店(R)・来店回数(F)・累計売上(M)で顧客を9つのセグメントに分類。' + r.total + '人の来店顧客が対象。' + (A.meta.taxExcluded ? '<b>金額はすべて税抜表示です。</b>' : '') + dataStamp() + '</div>';

    // segment cards
    html += '<div class="section-title">セグメント サマリー' + help('R（最終来店からの経過日数）・F（来店回数）・M（累計売上）の3指標をもとに、顧客を9つのセグメントに分類。各指標は5段階のスコア（5が最も良い）に変換し、その組み合わせでセグメントを決定。') + '</div>';
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
    html += card({ col: 'col-6', title: 'F × R セグメントマップ' + help('縦軸＝来店回数(F)のスコア、横軸＝最終来店(R)のスコア（5が最近）。各マスの数字はそのF×Rの組み合わせに該当する人数。'), sub: '縦=来店回数(F) ／ 横=最終来店(R・5が最近)。数字＝人数', body: chartBox('cHeat', 0) });
    html += card({ col: 'col-6', title: 'セグメント構成' + help('9セグメントを人数の多い順に並べたもの。'), sub: '人数の多い順', body: '<div id="cSegBars"></div>' });
    html += '</div>';

    // customer table
    var overdueCount = r.customers.filter(function (c) { return c.cycleOverdue; }).length;
    html += '<div class="section-title">顧客 RFM 明細</div>';
    html += '<div class="grid">' + card({
      col: 'col-12', sub: '累計売上(M)順・上位120人を表示。ヘッダーをタップで並べ替え。',
      title: '顧客一覧',
      body: '<div style="display:flex;justify-content:flex-end;margin-bottom:10px">' +
        '<button type="button" class="pill' + (rfmCallbackOnly ? ' accent' : '') + '" id="rfmCallbackToggle" aria-pressed="' + rfmCallbackOnly + '">呼び戻し対象のみ表示（' + overdueCount + '人）</button>' +
        '</div><div class="table-wrap tall"><table class="kate-table" id="rfmTable"></table></div>'
    }) + '</div>';

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
    var toggleBtn = $('#rfmCallbackToggle');
    toggleBtn.addEventListener('click', function () {
      rfmCallbackOnly = !rfmCallbackOnly;
      toggleBtn.classList.toggle('accent', rfmCallbackOnly);
      toggleBtn.setAttribute('aria-pressed', rfmCallbackOnly);
      buildRfmTable();
    });
    flush();
  }
  function buildRfmTable() {
    var r = state.analytics.rfm;
    var pool = rfmCallbackOnly ? r.customers.filter(function (c) { return c.cycleOverdue; }) : r.customers;
    var rows = pool.slice().sort(function (a, b) { var k = rfmSort.key; return (a[k] - b[k]) * rfmSort.dir; }).slice(0, 120);
    // 見出しの単位（(日)(回)(¥)）は .th-unit として分離し、モバイルでは非表示。
    // 狭い数値列に「R (日) ?」を丸ごと入れると1文字ずつ縦に折り返れるため —
    // 単位と意味は「?」ヘルプとページ先頭のリード文で説明済み。
    var cols = [
      { k: 'name', label: 'お名前' },
      { k: 'R', label: 'R', unit: '(日)', help: '最終来店からの経過日数（Recency・単位は日）。小さいほど最近来店している。' },
      { k: 'F', label: 'F', unit: '(回)', help: '来店回数（Frequency・単位は回）。' },
      { k: 'M', label: 'M', unit: '(¥)', help: '累計売上（Monetary・単位は円）。' },
      { k: 'seg', label: 'セグメント', help: 'R・F・Mそれぞれ5段階のスコアの組み合わせから決まる9分類。' },
      // 周期超過: 折り返すとしても「周期／超過」の語の切れ目だけ（<wbr>）。
      // th は word-break: keep-all なので1文字ずつの縦積みにはならない。
      { k: 'cycleOverdue', label: '周期超過', html: '周期<wbr>超過', help: '最終来店からの経過日数が、本人の来店周期（2回以上来店がある顧客のみ算出可・無ければ店舗全体の中央値で代用）の1.5倍を超えている状態。' }
    ];
    var thead = '<thead><tr>' + cols.map(function (c) {
      return '<th data-k="' + c.k + '" tabindex="0" role="button" aria-label="' + c.label + (c.unit ? ' ' + c.unit : '') + 'で並べ替え"' +
        (rfmSort.key === c.k ? ' aria-sort="' + (rfmSort.dir > 0 ? 'ascending' : 'descending') + '" class="sorted' + (rfmSort.dir > 0 ? ' asc' : '') + '"' : '') + '>' +
        (c.html || c.label) + (c.unit ? ' <span class="th-unit">' + c.unit + '</span>' : '') + (c.help ? help(c.help) : '') + '</th>';
    }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (c) {
      var col = cvar(SEG_COLOR[c.seg] || '--series-6');
      var overdueCell = c.cycleOverdue
        ? '<span class="chip down">周期超過</span>'
        : '<span class="note-inline">目安 ' + c.ownCycle + '日</span>';
      return '<tr><td>' + esc(c.name) + '</td><td>' + c.R + '</td><td>' + c.F + '</td><td><span class="full-num">' + F.int(c.M) + '</span><span class="compact-num">' + F.compact(c.M) + '</span></td>' +
        '<td style="text-align:left"><span class="seg-tag"><i style="background:' + col + '"></i>' + esc(c.seg) + '</span></td>' +
        '<td style="text-align:left">' + overdueCell + '</td></tr>';
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
  // 年商カードの表示期間（ymd）。null のあいだは基準日の年の 1/1〜12/31 を使う。
  var annualFrom = null, annualTo = null;

  function renderData() {
    var A = state.analytics, m = A.meta;
    // 管理ロック中は、このページの管理操作（連携URLの表示・変更・取り込み等）を
    // すべて隠す。スタッフの初回セットアップ（店の合言葉カード）だけは残す。
    var ownerLocked = !!(state.ownerLock && !state.ownerUnlocked);
    var head = '<div class="view-title">データ入力</div><div class="view-lead">' + (ownerLocked
      ? 'ダッシュボードの閲覧（概要・スタッフなどの各タブ）に設定は不要です。このページの管理操作はロックされています。'
      : 'Googleスプレッドシート連携、またはファイル（CSV / Excel）を入れるだけで全指標を自動再計算します。<b>「予約データ」</b>（ステータス列つき）と、<b>「会計明細」</b>（会計日・金額・店販つき）の両形式に対応。<b>両方を読み込むと自動で結合</b>し、店販売上や次回予約取得率などの指標を同じ画面で確認できます（文字コードは Shift-JIS / UTF-8 を自動判別）。') + '</div>';
    var html = '';
    // 合言葉 (shared passphrase) — decrypt the repo-hosted encrypted sheet URLs
    // so a brand-new device links up without anyone typing the raw URL.
    if (state.sharedBlob && !(state.sheetUrl || state.sheetUrlKaikei)) {
      html += card({
        col: 'col-12', title: '合言葉で店舗データを表示' + help('お店のスプレッドシートのURLを暗号化したものがこのアプリに同梱されています。合言葉を入力すると、この端末で復元されて自動連携が始まります（合言葉の入力は端末ごとに最初の1回だけ）。'),
        sub: 'この端末で初めて使うときは、お店の合言葉を入力してください（1回だけ）',
        body: '<div class="field">' + lockSvg() +
          '<input type="password" id="sharedPassInput" autocomplete="off" placeholder="合言葉">' +
          '</div>' +
          '<button class="btn-ios" id="sharedPassBtn" type="button" style="margin-top:14px">読み込む</button>'
      });
    }
    if (ownerLocked) {
      html += card({
        col: 'col-12', title: '管理者メニュー' + help('年商・予約状況、スプレッドシート連携の設定（URLの表示を含む）・ファイル取り込み・データのクリアなどの管理操作は、管理用の合言葉でロックされています。一度解除すると、この端末では次回から入力不要です（解除した記録のみを端末に保存し、合言葉そのものは保存しません）。解除後の画面から、いつでもこの端末を再ロックできます。'),
        sub: '連携設定などの管理操作は、管理用の合言葉（店の合言葉とは別）でロックされています。入力は<b>この端末で最初の1回だけ</b>です',
        body: '<div class="field">' + lockSvg() +
          '<input type="password" id="ownerPassInput" autocomplete="off" placeholder="管理用の合言葉">' +
          '</div>' +
          '<button class="btn-ios" id="ownerPassBtn" type="button" style="margin-top:14px">ロック解除</button>'
      });
      mount('data', head + '<div class="grid">' + html + '</div>');
      wireUpload();
      return;
    }
    // 年商・予約状況 — ここから下は管理ロック解除済みのみ表示される領域なので、
    // 売上の日別内訳と今後の予約はオーナー（管理用の合言葉を入力した人）限定になる。
    var taxTagD = m.taxExcluded ? '（税抜）' : '';
    var slotJa = { yoyaku: '予約データ', kaikei: '会計明細' };

    // ---- 年商（既定は 1/1〜12/31・任意の期間に絞り込み可）---------------------
    var annDays = A.store.dailyAll || [];
    var annAllFrom = annDays.length ? annDays[0].ymd : 0;
    var annAllTo = annDays.length ? annDays[annDays.length - 1].ymd : 0;
    var annYears = [];
    annDays.forEach(function (x) { if (annYears.indexOf(x.y) < 0) annYears.push(x.y); });
    annYears.sort(function (a, b) { return a - b; });
    // 初期表示は「基準日の年の 1/1〜12/31」。一度動かしたらタブを行き来しても保つ。
    if (annualFrom == null || annualTo == null) {
      var asOfYear = m.asOf ? +m.asOf.slice(0, 4) : new Date().getFullYear();
      annualFrom = asOfYear * 10000 + 101; annualTo = asOfYear * 10000 + 1231;
    }
    function annualStats() {
      var t = sumDays(annDays, annualFrom, annualTo);
      return heroMetric(F.int(t.rev), null, '会計済み売上（実績）', true, 'annual-revenue') +
        (t.resAmount > 0
          ? '<div class="note-inline" style="margin-top:8px">＋ 受付待ちの見込み ' + yen(t.resAmount) + '（' + t.resCount + '件）　→　合計見込み <b>' + yen(t.rev + t.resAmount) + '</b></div>'
          : '') +
        '<div class="mini-stats" style="margin-top:14px">' +
        miniStat(yen(t.rev - t.retail), '施術売上') +
        miniStat(yen(t.retail), '店販売上') +
        miniStat(F.int(t.count) + '件', '会計件数') +
        miniStat(t.count ? yen(Math.round(t.rev / t.count)) : '—', '客単価') +
        miniStat(t.bizDays + '日', '営業日数') +
        // 分母は概要の「売上サマリー」と同じ（月＝会計のあった月数／日＝会計のあった日数）。
        miniStat(t.months ? yen(Math.round(t.rev / t.months)) : '—', '平均月間売上') +
        miniStat(t.bizDays ? yen(Math.round(t.rev / t.bizDays)) : '—', '平均日間売上') +
        '</div>';
    }
    html += card({
      col: 'col-12', title: '年商' + taxTagD + help('選んだ期間の「会計済み売上（実績）」の合計。既定は基準日の年の1月1日〜12月31日で、年のボタンや開始・終了日で任意の期間に絞り込めます。受付待ちの予約がある期間では、その見込み額と合計見込みも下に併記します。施術売上＝売上－店販売上。営業日数＝会計が1件以上あった日数。平均月間売上＝売上÷会計のあった月数、平均日間売上＝売上÷営業日数（どちらも概要の「売上サマリー」と同じ分母なので、休業日や未来の月で薄まりません）。金額は税抜。'),
      sub: '既定は1月1日〜12月31日。期間は下のボタン・日付で絞り込めます',
      body: '<div id="annualCard">' +
        '<div class="note-inline" id="annualPeriod" style="margin-bottom:10px"></div>' +
        '<div id="annualOut"></div>' +
        '<div class="ann-range">' +
        annYears.map(function (y) { return '<button type="button" class="pill" data-y="' + y + '">' + y + '年</button>'; }).join('') +
        '<button type="button" class="pill" data-y="all">全期間</button>' +
        '</div>' +
        '<div class="ann-range">' +
        '<label>開始 <input type="date" id="annFrom"></label>' +
        '<span aria-hidden="true">〜</span>' +
        '<label>終了 <input type="date" id="annTo"></label>' +
        '</div>' +
        '</div>'
    });
    html += card({
      col: 'col-12', title: '予約状況（日別）' + taxTagD + help('集計基準日までの過去30日は「会計済みの売上（実績）と客数」、基準日の翌日からの30日は「受付待ちの予約金額（見込み）と予約件数」を、地続きの1つのカレンダーで表示。店販売上がある日は売上の下に（ ）で店販売上金額を併記。未来の日は枠線で区別しています。土曜は青、日曜は赤、最新日（基準日）はアクセント枠。金額は税抜。'),
      sub: '過去30日の実績（人）＋ 今後1ヶ月の予約（件）　※（ ）内は店販売上',
      body: dailyRevGrid(A.store.dailyRevenue.concat(A.store.upcomingReservations))
    });
    // Google Sheets link — one row per slot
    html += card({
      col: 'col-12', title: 'スプレッドシート連携' + help('URLを貼ると、開くたびに最新のシート内容を読み込みます。さらに連携中は、画面を開いたままの端末でも毎日23時〜翌1時のあいだ30分おき（23:00 / 23:30 / 0:00 / 0:30 / 1:00）に自動で再読み込みします。「今すぐ更新」でいつでも手動で最新を取得できます。'), sub: 'URLを貼るだけで自動反映（両方貼ると自動結合）・毎日23時〜翌1時は30分おきに自動更新',
      body: (state.sheetUrl || state.sheetUrlKaikei
        ? '<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button type="button" class="pill accent" id="sheetRefreshNow">今すぐ更新</button></div>'
        : '') + ['yoyaku', 'kaikei'].map(function (slot) {
        var sm = slotMeta(slot), linked = !!sm.sheetUrl;
        return '<div style="padding:' + (slot === 'kaikei' ? '14px 0 0' : '0 0 14px') + (slot === 'yoyaku' ? ';border-bottom:1px solid var(--hairline)' : '') + '">' +
          '<div class="note-inline" style="margin-bottom:6px;font-weight:600;color:var(--ink-primary)">' + sm.label + '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<input type="url" id="' + sm.urlId + '" class="sheet-input" inputmode="url" placeholder="https://docs.google.com/spreadsheets/d/…" value="' + esc(sm.sheetUrl || '') + '">' +
          '<button class="pill accent" id="' + sm.linkId + '" type="button">' + (linked ? '今すぐ更新' : '連携して読み込む') + '</button>' +
          (linked ? '<button class="pill" id="' + sm.unlinkId + '" type="button">解除</button>' : '') +
          '</div>' +
          (linked ? '<div class="status-line" style="margin-top:8px;color:var(--status-good)"><i style="background:var(--status-good)"></i>連携中。ページを開くたびに最新の内容を読み込みます。</div>' : '') +
          // 「ウェブに公開」URLは、自動再公開が止まるとGoogle側で内容が凍結され、
          // 何度読み込んでも古いまま になる。URL種別から判別できるので明示する。
          (linked && isPublishedUrl(sm.sheetUrl)
            ? '<div class="status-line" style="margin-top:6px;color:var(--status-warning)"><i style="background:var(--status-warning)"></i>' +
              '<b>「ウェブに公開」URL</b>です。公開設定の「自動的に再公開する」が外れていると、シートを更新してもこのURLの内容は<b>公開時点で凍結</b>され、更新が届きません。' +
              '更新が止まっている場合は、<code>ファイル → 共有 → ウェブに公開</code>で再公開するか、通常の<b>編集URL</b>（<code>/spreadsheets/d/…/edit</code>）に貼り替えてください（編集URLは常に最新を読みます）。</div>'
            : '') +
          '</div>';
      }).join('') +
        '<details style="margin-top:12px"><summary style="cursor:pointer;font-size:12.5px;color:var(--ink-secondary);font-weight:600">連携のしかた・注意点</summary>' +
        '<div class="how" style="margin-top:8px"><ul>' +
        '<li>スプレッドシートの1行目を、対応する見出し（「予約データ」または「会計明細」）と同じ<b>日本語の見出し</b>にしてください（下のテンプレートが使えます）。</li>' +
        '<li><b>確実な方法：</b>スプレッドシートで <code>ファイル → 共有 → ウェブに公開 → 「カンマ区切り形式(.csv)」</code> を選び、表示されたURLをここに貼り付け。</li>' +
        '<li>または、共有を<code>「リンクを知っている全員（閲覧者）」</code>にして、通常の編集URLを貼り付け。</li>' +
        '<li><b>⚠ プライバシー：</b>ウェブに公開・共有したスプレッドシートは、URLを知る人が閲覧できる状態になります。氏名・電話番号などを含む場合はご注意ください。非公開で扱いたい場合は下のファイルアップロードをお使いください。</li>' +
        '<li>テンプレート：<code>data/template.csv</code>（このリポジトリ）をスプレッドシートに<code>ファイル → インポート</code>すると、見出し付きで始められます。</li>' +
        '<li><b>同期完了時刻の表示：</b>毎日の自動同期が「いつ完了したか」を正確に表示したい場合は、スプレッドシートに <code>tools/sheet-update-stamp.gs</code>（このリポジトリ）を一度だけ設定してください。シートが更新されるたびに「データ更新日時」列が自動で書き込まれ、ダッシュボードに「データ更新 ◯月◯日 ◯◯:◯◯ 時点」と表示されます（未設定の間は、この画面が読み込んだ時刻を「最終読込」として表示します）。</li>' +
        '</ul></div></details>' +
        ((state.sheetUrl || state.sheetUrlKaikei) ?
          '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12.5px;color:var(--ink-secondary);font-weight:600">全端末に共有（合言葉の設定）</summary>' +
          '<div class="how" style="margin-top:8px"><ul>' +
          '<li>合言葉を決めて下に入力すると、連携中のスプレッドシートURLを暗号化した<b>共有用の暗号文</b>が作られます。</li>' +
          '<li>暗号文を開発担当に渡してアプリに組み込むと、以後どの端末でも<b>合言葉を1回入力するだけ</b>で店舗データが表示されます。</li>' +
          '<li>暗号文だけではURLは復元できないため、そのまま渡して問題ありません。<b>合言葉は店名などの推測されやすい言葉を避け</b>、スタッフだけに共有してください。</li>' +
          '</ul></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">' +
          '<input type="text" id="sharedGenInput" class="sheet-input" autocomplete="off" placeholder="新しい合言葉（8文字以上を推奨）">' +
          '<button class="pill accent" id="sharedGenBtn" type="button">暗号文を作る</button>' +
          '</div>' +
          '<textarea id="sharedGenOut" readonly style="display:none;width:100%;margin-top:8px;min-height:96px;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);color:var(--ink-primary)"></textarea>' +
          '<button class="pill" id="sharedGenCopy" type="button" style="display:none;margin-top:6px">暗号文をコピー</button>' +
          '</details>' : '')
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
    // 管理ロックの設定（オーナー用）: 有効化すると、このページの管理操作が
    // 管理用の合言葉なしでは見られなくなる（連携URLの露出防止）。
    html += card({
      col: 'col-12', title: '管理ロック（オーナー用）' + help('管理用の合言葉を設定すると、このデータ入力ページの管理操作（連携URLの表示・変更・ファイル取り込み・クリア）が、合言葉を入れるまで隠されます。ダッシュボードの閲覧には影響しません。店の合言葉とは別のものにしてください。'),
      sub: state.ownerLock
        ? '設定済み。新しい合言葉で暗号文を作り直して差し替えると、古い合言葉は無効になります'
        : '未設定。設定すると、このページの管理操作（連携URLの表示を含む）が合言葉なしでは見られなくなります',
      body: '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<input type="text" id="ownerGenInput" class="sheet-input" autocomplete="off" placeholder="管理用の合言葉（店の合言葉とは別に・8文字以上を推奨）">' +
        '<button class="pill accent" id="ownerGenBtn" type="button">ロック用の暗号文を作る</button>' +
        '</div>' +
        '<textarea id="ownerGenOut" readonly style="display:none;width:100%;margin-top:8px;min-height:96px;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);color:var(--ink-primary)"></textarea>' +
        '<button class="pill" id="ownerGenCopy" type="button" style="display:none;margin-top:6px">暗号文をコピー</button>' +
        '<div class="note-inline" style="margin-top:8px">作成した暗号文を開発担当に渡してアプリに組み込むと有効になります。</div>' +
        // 解除は端末に記憶される。共用端末を人に渡すときなどに、その場で戻せるようにする。
        (state.ownerLock ? '<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--hairline)">' +
          '<div class="note-inline" style="margin-bottom:8px">この端末は解除済みです（次回も合言葉なしで開けます）。共用端末を他の人に渡すときは、再ロックしてください。</div>' +
          '<button class="pill" id="ownerRelockBtn" type="button">この端末を再ロックする</button>' +
          '</div>' : '')
    });
    // 取得内容の診断 — 「更新しても変わらない」ときに、原因がダッシュボードなのか
    // 取得元（シート／公開URL）なのかを、推測ではなく取得した事実そのもので示す。
    // 特に「データに含まれる最新の日付」は、シートがどこまでのデータを持っているかを
    // 集計を通さずに表すため、同期が止まっていればここに直接現れる。
    var diagRows = ['yoyaku', 'kaikei'].map(function (sl) {
      var s3 = state.sources[sl];
      if (!s3 || !s3.diag) return '';
      var d3 = s3.diag, today = new Date();
      var todayNum = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
      // 「最新の日付」が2日以上前なら、取得できている中身自体が古い＝シート側の問題
      var behind = d3.latest !== null && (todayNum - d3.latest) >= 2;
      return '<tr><td>' + esc(slotJa[sl]) + '</td>' +
        '<td class="tnum">' + F.int(d3.rows) + '件</td>' +
        '<td class="tnum"' + (behind ? ' style="color:var(--status-warning);font-weight:700"' : '') + '>' +
          (d3.latest !== null ? esc(ymdNumJa(d3.latest)) : '—') + '</td>' +
        '<td>' + (s3.updatedAt ? esc(ymdhmJa(s3.updatedAt)) : '—') + '</td>' +
        '<td>' + esc(ymdhmJa(d3.fetchedAt)) + '</td>' +
        // 取得経路。export＝常に最新／gviz・pub＝Google側で古い内容が返ることがある
        '<td' + (d3.kind === 'export' ? '' : ' style="color:var(--status-warning);font-weight:700"') + '>' +
          (d3.kind === 'export' ? '常に最新' : d3.kind === 'gviz' ? 'キャッシュ有' : '公開スナップ') + '</td></tr>';
    }).join('');
    if (diagRows) {
      html += card({
        col: 'col-12', title: '取得したデータの中身（診断）' + help('「更新しても数字が変わらない」ときに、原因がこのダッシュボードなのか、取得元のシートなのかを切り分けるための表です。<b>データ内の最新日</b>は、いま実際に取得できたCSVに含まれる一番新しい来店日／会計日です。ここが今日・昨日になっていなければ、シート側にまだ新しいデータが入っていない（＝同期が止まっている）ことを意味します。<b>シートの更新日時</b>はシート側が記録した同期完了時刻、<b>取得時刻</b>はこの画面が読みに行った時刻です。<b>取得経路</b>は、通常の編集URLなら「常に最新」（ファイルのCSV書き出しを直接読む経路）になります。「キャッシュ有」「公開スナップ」の場合はGoogle側で古い内容が返ることがあるため、編集URL（<code>/spreadsheets/d/…/edit</code>）に貼り替えてください。'),
        sub: '「更新しても変わらない」ときは、ここで取得元とダッシュボードのどちらの問題か切り分けられます',
        body: '<div class="table-wrap"><table class="kate-table">' +
          '<thead><tr><th>シート</th><th>取得件数</th><th>データ内の最新日</th><th>シートの更新日時</th><th>取得時刻</th><th>取得経路</th></tr></thead>' +
          '<tbody>' + diagRows + '</tbody></table></div>' +
          '<div class="note-inline" style="margin-top:10px">' +
          '「取得時刻」は更新のたびに必ず新しくなります。それでも<b>「データ内の最新日」が進まない場合、原因はシート側</b>です（このダッシュボードは取得できた内容をそのまま表示しています）。' +
          '</div>'
      });
    }
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
    // シート別の更新時刻（2ソース統合時のみ内訳を表示）と、同期停止の検知。
    // 表示中の「データ更新」は古い方のシートの時刻なので、どちらのシートが
    // 止まっているかをここで特定できるようにする。26時間＝毎晩の同期
    // （DailyCSVSync）が1回飛んだことを検知できる最小のしきい値。
    var srcRows = '', staleWarns = '';
    var bothLinked = state.sources.yoyaku && state.sources.kaikei;
    ['yoyaku', 'kaikei'].forEach(function (slot2) {
      var s2 = state.sources[slot2];
      if (!s2) return;
      if (bothLinked) {
        srcRows += '<div><span>' + slotJa[slot2] + 'の更新</span><b>' +
          (s2.updatedAt ? esc(ymdhmJa(s2.updatedAt)) : '—（データ更新日時 未設定）') + '</b></div>';
      }
      if (s2.via === 'スプレッドシート連携' && s2.updatedAt && (Date.now() - Number(s2.updatedAt) > 26 * 3600 * 1000)) {
        var ageH = Math.floor((Date.now() - Number(s2.updatedAt)) / 3600000);
        staleWarns += '<div class="status-line" style="margin-top:12px;color:var(--status-warning)"><i style="background:var(--status-warning)"></i>' +
          '<b>' + slotJa[slot2] + '</b>のシートが' + (ageH >= 48 ? Math.floor(ageH / 24) + '日' : ageH + '時間') + '更新されていません（最終更新 ' + esc(ymdhmJa(s2.updatedAt)) + '）。' +
          'シート側の同期（DailyCSVSync）が失敗していないか、スプレッドシートの「拡張機能 → Apps Script → 実行数」でエラーをご確認ください。</div>';
      }
    });
    html += card({
      col: 'col-6', title: '現在のデータ', sub: 'ブラウザ内でのみ処理されます',
      body: '<div class="datainfo">' +
        '<div><span>データソース</span><b>' + esc(state.fileName || state.source) + '</b></div>' +
        '<div><span>取込件数</span><b class="tnum">' + F.int(m.totalRows) + '件</b></div>' +
        '<div><span>有効予約</span><b class="tnum">' + F.int(A.store.effectiveReservations) + '件</b></div>' +
        '<div><span>来店顧客</span><b class="tnum">' + F.int(A.store.customers) + '人</b></div>' +
        '<div><span>対象期間</span><b>' + esc(ymRangeJa(m.periodStart, m.periodEnd)) + '</b></div>' +
        '<div><span>集計基準日</span><b>' + esc(ymdJa(m.asOf)) + '</b></div>' +
        (state.sheetUpdatedAt ? '<div><span>データ更新</span><b>' + esc(ymdhmJa(state.sheetUpdatedAt)) + '</b></div>' : '') +
        srcRows +
        (state.dataLoadedAt ? '<div><span>最終読込</span><b>' + esc(ymdhmJa(state.dataLoadedAt)) + '</b></div>' : '') + '</div>' +
        staleWarns +
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
        '<li><b>リピート率・ファネル</b>：来店顧客のうち2回目以降の予約（会計済み＋今後の予約）を確保した割合。予約ベースの判定のため、キャンセルのみで次の予約が入っていない場合は「未到達」、キャンセル後に別の予約を取っていれば「到達」として数える（経過日数による母数除外は行わない）。<b>RFMのF</b>は実来店回数。</li>' +
        '<li><b>固定化率</b>：リピート率とは分母が異なり、2回目の予約に到達した顧客のうち、3回目の予約も取った割合（条件付き継続率）。</li>' +
        '<li><b>スタッフ比較</b>：表内の数値はすべて直近3ヶ月（今月を含まない確定3ヶ月）平均。リピート率・固定化率は、そのスタッフが直近3ヶ月に初回担当した顧客のコホートが対象。</li>' +
        '<li><b>店販顧客比率</b> ＝ 店販（物販）を購入した<b>人数</b> ÷ 来店した<b>人数</b>。<b>店販単価</b>は「店販金額 ÷ 店販のあった会計数」（1人が複数回購入する場合があるため会計単位）。</li>' +
        '<li><b>LTV（予測）</b>：実績客単価 × 期待来店回数（5回到達までの期待値）。</li>' +
        '<li><b>RFM</b>：R＝最終来店からの日数、F＝来店回数、M＝累計売上。9セグメントに自動分類（区分の閾値は元KPIワークブックの固定値）。</li>' +
        '<li>個人情報を含むデータはすべて<b>ブラウザ内で処理</b>され、サーバーには送信されません。</li>' +
        '</ul>'
    });
    mount('data', head + '<div class="grid">' + html + '</div>');
    wireUpload();

    // 年商カード: 期間ボタン／日付を変えたら数字だけ差し替える（全体は再描画しない）。
    var annBox = $('#annualCard');
    if (annBox) {
      var annOut = $('#annualOut'), annFromI = $('#annFrom'), annToI = $('#annTo'), annLabel = $('#annualPeriod');
      var annRefresh = function () {
        annOut.innerHTML = annualStats();
        annFromI.value = ymdToInput(annualFrom); annToI.value = ymdToInput(annualTo);
        annLabel.textContent = ymdLabel(annualFrom) + ' 〜 ' + ymdLabel(annualTo) + ' の売上';
        Array.prototype.forEach.call(annBox.querySelectorAll('.pill[data-y]'), function (b) {
          var on = b.dataset.y === 'all'
            ? (annualFrom === annAllFrom && annualTo === annAllTo)
            : (annualFrom === +b.dataset.y * 10000 + 101 && annualTo === +b.dataset.y * 10000 + 1231);
          b.classList.toggle('accent', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      };
      annBox.addEventListener('click', function (e) {
        var b = e.target.closest('.pill[data-y]'); if (!b) return;
        if (b.dataset.y === 'all') { annualFrom = annAllFrom; annualTo = annAllTo; }
        else { annualFrom = +b.dataset.y * 10000 + 101; annualTo = +b.dataset.y * 10000 + 1231; }
        annRefresh();
      });
      var annOnDate = function () {
        var f = inputToYmd(annFromI.value), t = inputToYmd(annToI.value);
        if (f == null || t == null) return;
        if (f > t) { var sw = f; f = t; t = sw; }   // 開始・終了を逆に入れても壊れないよう入れ替える
        annualFrom = f; annualTo = t; annRefresh();
      };
      annFromI.addEventListener('change', annOnDate);
      annToI.addEventListener('change', annOnDate);
      annRefresh();
    }
  }

  function wireUpload() {
    wireSlot('yoyaku'); wireSlot('kaikei');
    var resetBtn = $('#resetBtn');
    if (resetBtn) resetBtn.addEventListener('click', function (e) { e.stopPropagation(); resetAll(); toast('サンプルデータに戻しました', 'ok'); });
    var refreshBtn = $('#sheetRefreshNow');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { reloadLinkedSheets({}); });   // {} = 非silent（トーストで結果を見せる）
    wireSharedPass();
    wireOwnerLock();
  }
  // 合言葉: decrypt-and-link on new devices, and the owner-side ciphertext
  // generator (its output is committed to the repo as data/shared-link.json —
  // safe there because it's AES-GCM ciphertext, useless without the passphrase).
  function wireSharedPass() {
    var passInput = $('#sharedPassInput'), passBtn = $('#sharedPassBtn');
    if (passBtn && passInput) {
      var unlock = function () {
        var pass = passInput.value || '';
        if (!pass) { toast('合言葉を入力してください', 'err'); return; }
        passBtn.disabled = true;
        global.KATE.crypto.decrypt(pass, state.sharedBlob).then(function (obj) {
          passBtn.disabled = false;
          var linked = false;
          if (obj && obj.yoyaku) { linked = true; state.sheetUrl = obj.yoyaku; try { localStorage.setItem('kate-sheet-url', obj.yoyaku); } catch (e) {} linkSheet(obj.yoyaku, 'yoyaku', { silent: true }); }
          if (obj && obj.kaikei) { linked = true; state.sheetUrlKaikei = obj.kaikei; try { localStorage.setItem('kate-sheet-url-kaikei', obj.kaikei); } catch (e) {} linkSheet(obj.kaikei, 'kaikei', { silent: true }); }
          toast(linked ? '✓ 店舗データの読み込みを開始しました。この端末では次回から自動で表示されます' : '共有データにURLが含まれていません', linked ? 'ok' : 'err');
        }, function (err) {
          passBtn.disabled = false;
          toast('⚠ ' + (err.message || '読み込みに失敗しました'), 'err');
        });
      };
      passBtn.addEventListener('click', unlock);
      passInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); unlock(); } });
    }
    var genInput = $('#sharedGenInput'), genBtn = $('#sharedGenBtn'), genOut = $('#sharedGenOut'), genCopy = $('#sharedGenCopy');
    if (genBtn && genInput) {
      genBtn.addEventListener('click', function () {
        var pass = (genInput.value || '').trim();
        if (pass.length < 4) { toast('合言葉は4文字以上にしてください（8文字以上を推奨）', 'err'); return; }
        var payload = {};
        if (state.sheetUrl) payload.yoyaku = state.sheetUrl;
        if (state.sheetUrlKaikei) payload.kaikei = state.sheetUrlKaikei;
        global.KATE.crypto.encrypt(pass, payload).then(function (blob) {
          genOut.value = JSON.stringify(blob);
          genOut.style.display = 'block'; genCopy.style.display = 'inline-flex';
          toast('✓ 暗号文を作成しました。コピーして開発担当に渡してください', 'ok');
        }).catch(function (err) { toast('⚠ ' + (err.message || '暗号化に失敗しました'), 'err'); });
      });
    }
    wireCopy(genCopy, genOut);
  }
  function wireCopy(btn, srcTextarea) {
    if (!btn || !srcTextarea) return;
    btn.addEventListener('click', function () {
      srcTextarea.select();
      var done = function () { toast('✓ コピーしました', 'ok'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(srcTextarea.value).then(done, function () { document.execCommand('copy'); done(); });
      else { document.execCommand('copy'); done(); }
    });
  }
  // 管理ロック: 解除（ロック中のみ表示）と、ロック用暗号文の生成（解除中のみ表示）。
  // 解除状態はメモリ上のみ — localStorage に旗を残さないので、端末を渡しても
  // リロードすれば必ず再ロックされる。
  function wireOwnerLock() {
    var passInput = $('#ownerPassInput'), passBtn = $('#ownerPassBtn');
    if (passBtn && passInput) {
      var unlock = function () {
        var pass = passInput.value || '';
        if (!pass) { toast('管理用の合言葉を入力してください', 'err'); return; }
        passBtn.disabled = true;
        global.KATE.crypto.decrypt(pass, state.ownerLock).then(function () {
          state.ownerUnlocked = true;
          rememberOwnerUnlock();
          renderAll();
          toast('✓ ロックを解除しました（この端末では次回から入力不要です）', 'ok');
        }, function (err) {
          passBtn.disabled = false;
          toast('⚠ ' + (err.message || '解除に失敗しました'), 'err');
        });
      };
      passBtn.addEventListener('click', unlock);
      passInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); unlock(); } });
    }
    var relockBtn = $('#ownerRelockBtn');
    if (relockBtn) relockBtn.addEventListener('click', function () {
      state.ownerUnlocked = false;
      try { localStorage.removeItem('kate-owner-unlocked'); } catch (e) {}
      renderAll();
      toast('この端末を再ロックしました。次回は合言葉の入力が必要です', 'ok');
    });
    var genInput = $('#ownerGenInput'), genBtn = $('#ownerGenBtn'), genOut = $('#ownerGenOut'), genCopy = $('#ownerGenCopy');
    if (genBtn && genInput) {
      genBtn.addEventListener('click', function () {
        var pass = (genInput.value || '').trim();
        if (pass.length < 4) { toast('合言葉は4文字以上にしてください（8文字以上を推奨）', 'err'); return; }
        global.KATE.crypto.encrypt(pass, { role: 'owner' }).then(function (blob) {
          genOut.value = JSON.stringify(blob);
          genOut.style.display = 'block'; genCopy.style.display = 'inline-flex';
          toast('✓ ロック用の暗号文を作成しました。コピーして開発担当に渡してください', 'ok');
        }).catch(function (err) { toast('⚠ ' + (err.message || '作成に失敗しました'), 'err'); });
      });
    }
    wireCopy(genCopy, genOut);
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
    // 金額は税抜表示がメイン（元データ＝HOT PEPPER Beauty 等は税込／消費税10%）。
    // ヘッダーの「税抜／税込」トグル（state.taxExcluded）で切り替え可能。税抜換算は
    // エンジンの金額ソース1か所で行うため、売上・客単価・LTV・店販など全指標が一貫。
    var recs, source, fileName, used = [], mergeReport = null, computeOpts = { taxRate: state.taxExcluded ? 0.1 : 0 };
    if (y && k) {
      var merged = global.KATE.ingest.mergeSources(y.records, k.records);
      mergeReport = merged.report;
      if (merged.report.matched > 0) { recs = merged.records; source = '統合データ（予約＋会計）'; fileName = null; used = [y, k]; }
      else { recs = y.records; source = y.via; fileName = y.fileName; used = [y]; }   // 0件結合 → 統合を中止し予約データ単独
    } else if (y) { recs = y.records; source = y.via; fileName = y.fileName; used = [y]; }
    else if (k) { recs = k.records; source = k.via; fileName = k.fileName; used = [k]; }
    else { recs = global.KATE.SAMPLE_RESERVATIONS; source = 'サンプルデータ'; fileName = null; computeOpts.asOf = '2026-07-03'; state.dataLoadedAt = null; }   // 実データ解除後に古い読込時刻を残さない
    var A = global.KATE.engine.compute(recs, computeOpts);
    // シート側が書き込んだ「データ更新日時」（同期完了時刻）。使用中の全ソースに
    // スタンプがある場合のみ採用し、古い方を表示（＝すべてのデータが揃っている時点）。
    // 片方でもスタンプが無ければ鮮度を保証できないため「最終読込」へフォールバック。
    var allStamped = used.length > 0 && used.every(function (s) { return s.updatedAt; });
    state.sheetUpdatedAt = allStamped
      ? new Date(Math.min.apply(null, used.map(function (s) { return Number(s.updatedAt); })))
      : null;
    state.data = recs; state.analytics = A; state.source = source; state.fileName = fileName; state.mergeReport = mergeReport;
    updateChrome(); renderAll(); route(state.view, true);
    return A;
  }
  // 「ウェブに公開」型のURLか（/spreadsheets/d/e/… または output=csv）。この型は
  // 自動再公開が止まるとGoogle側で内容が凍結されるため、UIで注意を出す。
  function isPublishedUrl(u) { return /\/spreadsheets\/d\/e\//i.test(u || '') || /output=csv/i.test(u || ''); }
  // 取得したCSVの同一性判定用の軽量ハッシュ（FNV-1a 32bit）。「更新を押したのに
  // 何も変わらない」が、取得失敗なのか内容が同じなのかを区別して伝えるために使う。
  function strHash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return String(h) + ':' + s.length;
  }
  // 取得したデータに含まれる最も新しい日付（来店日／会計日）。シートが実際に
  // どこまでのデータを持っているかを、集計を通さず生の取得内容から示す。
  function latestRecordDate(recs) {
    var best = null;
    for (var i = 0; i < recs.length; i++) {
      var d = String(recs[i].date || '').trim();
      if (!d) continue;
      var mm = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(d);
      if (!mm) continue;
      var n = +mm[1] * 10000 + +mm[2] * 100 + +mm[3];
      if (best === null || n > best) best = n;
    }
    return best;   // 20260809 形式の数値 / データが無ければ null
  }
  function ymdNumJa(n) { var s = String(n); return +s.slice(0, 4) + '年' + (+s.slice(4, 6)) + '月' + (+s.slice(6, 8)) + '日'; }
  function linkSheet(url, slot, opts) {
    opts = opts || {};
    if (!url) return;
    if (!opts.silent) toast('スプレッドシートを読み込み中…');
    var usedKind = null;   // どの経路で取れたか（export=常に最新 / gviz=キャッシュあり / pub=公開スナップショット）
    global.KATE.sheets.fetchCsv(url, { onEndpoint: function (u, kind) { usedKind = kind; } }).then(function (text) {
      var parsed = global.KATE.ingest.fromAOA(global.KATE.ingest.parseCSV(text));
      var format = parsed.format, recs = parsed.records;
      var prevSrc = state.sources[format];
      var hash = strHash(text);
      var unchanged = !!(prevSrc && prevSrc.hash && prevSrc.hash === hash);
      state.sources[format] = {
        records: recs, fileName: null, via: 'スプレッドシート連携', updatedAt: parsed.sheetUpdatedAt || null, hash: hash,
        // 診断用: 実際に取得できた中身そのもの。「更新しても変わらない」ときに、
        // 原因がダッシュボードなのか取得元なのかを推測ではなく事実で切り分ける。
        diag: { rows: recs.length, bytes: text.length, latest: latestRecordDate(recs), fetchedAt: new Date(), url: url, kind: usedKind }
      };
      if (format === 'kaikei') state.sheetUrlKaikei = url; else state.sheetUrl = url;
      try { localStorage.setItem(format === 'kaikei' ? 'kate-sheet-url-kaikei' : 'kate-sheet-url', url); } catch (e) {}
      state.dataLoadedAt = new Date();   // データを取得した日時を記録
      var A = applySources();
      var reroute = format !== slot ? '（' + slotMeta(format).label + 'の形式を検出したため、そちらに読み込みました）' : '';
      var warn = A.meta.undatedRows ? '（うち' + F.int(A.meta.undatedRows) + '件は日付を読み取れず除外）' : '';
      if (!opts.silent) {
        // 取得は成功したのに中身が前回と1文字も違わない場合、画面は当然変わらない。
        // 「更新したのに変わらない」の原因がダッシュボードではなくシート側にある
        // ことをその場で伝える（黙って成功トーストを出すと誤解を招く）。
        if (unchanged) {
          toast('シートの内容は前回から変わっていません（' + slotMeta(format).label +
            (parsed.sheetUpdatedAt ? '・シートの更新 ' + ymdhmJa(parsed.sheetUpdatedAt) : '') +
            '）。シート側の同期をご確認ください', 'err');
        } else {
          toast('✓ スプレッドシートから ' + F.int(recs.length) + '件を読み込みました' + reroute + warn, warn ? 'err' : 'ok');
        }
      }
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
      state.sources[format] = { records: recs, fileName: file.name, via: 'アップロード', updatedAt: parsed.sheetUpdatedAt || null };
      state.dataLoadedAt = new Date();   // データを読み込んだ日時を記録
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

  // ---- 管理ロックの解除をこの端末で記憶する --------------------------------
  // 合言葉そのものは保存しない（保存すると端末から読み出せてしまい、他店舗・
  // 他端末で使い回される）。代わりに「どのロック設定を解除したか」の指紋
  // （暗号文の一部）だけを持つ。オーナーが合言葉を作り直して差し替えると
  // 指紋が変わるため、古い解除は自動的に無効になる。
  function ownerUnlockKey(blob) { return blob && blob.ct ? String(blob.ct).slice(0, 32) : null; }
  function rememberOwnerUnlock() {
    var k = ownerUnlockKey(state.ownerLock);
    if (k) { try { localStorage.setItem('kate-owner-unlocked', k); } catch (e) {} }
  }
  function restoreOwnerUnlock() {
    var k = ownerUnlockKey(state.ownerLock);
    if (!k) return false;
    var saved = null;
    try { saved = localStorage.getItem('kate-owner-unlocked'); } catch (e) {}
    if (saved && saved === k) { state.ownerUnlocked = true; return true; }
    if (saved) { try { localStorage.removeItem('kate-owner-unlocked'); } catch (e) {} }   // 合言葉が差し替わった
    return false;
  }

  // ====================== 夜間の自動再読み込み ==============================
  // スプレッドシート連携中は、毎日23時〜25時（翌1時）のあいだ30分おき
  // （23:00 / 23:30 / 0:00 / 0:30 / 1:00・端末の現地時刻）に自動でシートを
  // 再読み込みする。シート側の夜間同期（DailyCSVSync）がこの時間帯のどこで
  // 完了しても、30分以内にダッシュボードへ反映される。開いた瞬間に最新を
  // 取得する従来動作はそのままなので、閉じていた端末は次に開いたときに
  // 最新が入る。30分おきに読むため、1回の失敗（WiFi瞬断など）も次の回が拾う。
  // 非表示タブはブラウザがタイマーを止めるため、画面復帰時にも「直近の
  // 予定時刻より前の読み込みのままか」を確認して取りこぼしを拾う。
  var RELOAD_TIMES = [[0, 0], [0, 30], [1, 0], [23, 0], [23, 30]];   // 1日の中の発火時刻（時刻順）
  function nextReloadAt(now) {
    for (var addDay = 0; addDay <= 1; addDay++) {
      for (var i = 0; i < RELOAD_TIMES.length; i++) {
        var t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + addDay, RELOAD_TIMES[i][0], RELOAD_TIMES[i][1], 5, 0);
        if (t > now) return t;
      }
    }
  }
  // 直近で過ぎた予定時刻。これより古い読み込みは夜間同期を取りこぼしている可能性がある。
  function lastReloadBoundary(now) {
    for (var subDay = 0; subDay <= 1; subDay++) {
      for (var i = RELOAD_TIMES.length - 1; i >= 0; i--) {
        var t = new Date(now.getFullYear(), now.getMonth(), now.getDate() - subDay, RELOAD_TIMES[i][0], RELOAD_TIMES[i][1], 0, 0);
        if (t <= now) return t;
      }
    }
  }
  function reloadLinkedSheets(opts) {
    var did = false;
    if (state.sheetUrl) { linkSheet(state.sheetUrl, 'yoyaku', opts || { silent: true }); did = true; }
    if (state.sheetUrlKaikei) { linkSheet(state.sheetUrlKaikei, 'kaikei', opts || { silent: true }); did = true; }
    return did;
  }
  function scheduleNightlyReload() {
    var next = nextReloadAt(new Date());
    setTimeout(function () { reloadLinkedSheets(); scheduleNightlyReload(); }, next - new Date());
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (!state.sheetUrl && !state.sheetUrlKaikei) return;
    if (!state.dataLoadedAt || state.dataLoadedAt < lastReloadBoundary(new Date())) reloadLinkedSheets();
  });
  global.KATE = global.KATE || {};
  global.KATE.autoReload = { times: RELOAD_TIMES, next: nextReloadAt, boundary: lastReloadBoundary };   // テスト・デバッグ用

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
    // ヘッダーの日付表示（dataStamp と同じ優先順）:
    // シートの同期完了時刻 → この画面の読込時刻 → 基準日（サンプル時のみ）
    // 「データ更新」＝シート側が記録した同期完了時刻（複数シート連携時は古い方）。
    // これは更新ボタンを押しても、シートが同期されない限り動かない。押したこと自体が
    // 伝わらず「壊れている」ように見えるため、最後に確認した時刻を必ず併記する。
    $('#asof').textContent = state.sheetUpdatedAt
      ? 'データ更新 ' + ymdhmJa(state.sheetUpdatedAt) + (state.dataLoadedAt ? '（確認 ' + hmJa(state.dataLoadedAt) + '）' : '')
      : state.dataLoadedAt ? '最終読込 ' + ymdhmJa(state.dataLoadedAt)
      : (state.analytics.meta.asOf ? '基準日 ' + ymdJa(state.analytics.meta.asOf) : '');
    // サンプルデータ表示中はバッジ自体を非表示（実データ連携時のみ出所を表示）。
    // 出所ラベルは短く（「統合データ（予約＋会計）」→「統合データ」）、右に取得日時を併記。
    var badge = $('#dataBadge');
    if (badge) {
      var isSample = state.source === 'サンプルデータ' && !state.fileName;
      badge.style.display = isSample ? 'none' : '';
      // 出所ラベルは短く（「統合データ（予約＋会計）」→「統合データ」）
      if (!isSample) $('#dataBadgeText').textContent = state.fileName || String(state.source).replace(/（.*）$/, '');
    }
    var tx = $('#taxToggle');
    if (tx) {   // 税抜（既定）ならスイッチOFF、税込ならON。両側ラベルで選択中を強調
      tx.checked = !state.taxExcluded;
      var le = $('#taxLabelExcl'), li = $('#taxLabelIncl');
      if (le) le.classList.toggle('on', state.taxExcluded);
      if (li) li.classList.toggle('on', !state.taxExcluded);
    }
  }
  // テーマはOSの設定（prefers-color-scheme）に追従する（手動トグルは廃止）
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
  }

  var toastTimer;
  function toast(msg, kind) {
    var t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  // ---- boot ----------------------------------------------------------------
  function boot() {
    // Capture the deep-link hash FIRST: applySources() below routes to the
    // default view, which rewrites location.hash before the initial-route
    // code further down would otherwise get to read it.
    var initialHash = (location.hash || '#overview').slice(1);

    var mq = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)');
    setTheme(mq && mq.matches ? 'dark' : 'light');
    // OSのライト/ダーク切り替えにリアルタイム追従（チャート色も再描画）
    if (mq && mq.addEventListener) mq.addEventListener('change', function (e) { setTheme(e.matches ? 'dark' : 'light'); flush(true); });

    injectNavIcons();
    applySources();   // no sources loaded yet → falls back to the bundled sample data

    // Auto-reconnect previously linked spreadsheets (always pull the latest)
    var savedYoyaku = null, savedKaikei = null;
    try { savedYoyaku = localStorage.getItem('kate-sheet-url'); savedKaikei = localStorage.getItem('kate-sheet-url-kaikei'); } catch (e) {}
    if (savedYoyaku) { state.sheetUrl = savedYoyaku; linkSheet(savedYoyaku, 'yoyaku', { silent: true }); }
    if (savedKaikei) { state.sheetUrlKaikei = savedKaikei; linkSheet(savedKaikei, 'kaikei', { silent: true }); }
    scheduleNightlyReload();   // 連携中なら23時〜翌1時のあいだ30分おきに自動で再読み込み

    // 合言葉: if the repo ships an encrypted shared-link blob, load it. On a
    // device with nothing linked yet, re-render so the 合言葉 card and the
    // overview banner appear (the fetch usually resolves after first paint).
    fetch('data/shared-link.json', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (blob) {
      if (!blob || blob.v !== 1) return;
      state.sharedBlob = blob;
      if (!state.sheetUrl && !state.sheetUrlKaikei) renderAll();
    }).catch(function () { /* file absent (404) or offline — feature stays dormant */ });

    // 管理ロック: data/owner-lock.json が有効なら、データ入力ページの管理操作を
    // 管理用の合言葉で保護する（閲覧タブには影響しない）。
    fetch('data/owner-lock.json', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (blob) {
      if (!blob || blob.v !== 1) return;
      state.ownerLock = blob;
      restoreOwnerUnlock();   // この端末で解除済みなら、合言葉の再入力を求めない
      if (state.view === 'data') renderAll();
    }).catch(function () { /* absent or offline — tab stays unlocked as before */ });

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
    var taxBtn = $('#taxToggle');
    function setTax(excluded) {
      if (state.taxExcluded === excluded) return;
      state.taxExcluded = excluded;   // true=税抜（既定）／false=税込
      try { localStorage.setItem('kate-tax', excluded ? 'excl' : 'incl'); } catch (e) {}
      applySources();  // 税抜/税込を切り替えて全指標を再計算・再描画
    }
    if (taxBtn) taxBtn.addEventListener('change', function () { setTax(!taxBtn.checked); });
    // 両側ラベルをクリックしてもその表示に切り替えられる
    var le = $('#taxLabelExcl'), li = $('#taxLabelIncl');
    if (le) le.addEventListener('click', function () { setTax(true); });
    if (li) li.addEventListener('click', function () { setTax(false); });

    // routing
    global.addEventListener('hashchange', function () { route((location.hash || '#overview').slice(1)); });
    route(VIEWS.includes(initialHash) ? initialHash : 'overview', true);

    // resize → debounced redraw of active view charts + underline
    var rt;
    global.addEventListener('resize', function () { clearTimeout(rt); var tp = document.querySelector('.kate-tip'); if (tp) tp.style.opacity = 0; rt = setTimeout(function () { moveUnderline(); positionThumb(); flush(true); }, 160); });
    setTimeout(moveUnderline, 60);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
