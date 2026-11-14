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
  // タブ: ホーム（お店の今月＋あなたの今月）／お店（旧「概要」＋「傾向」）／スタッフ／顧客／データ。
  // 「お店」の id は互換のため overview のまま（#overview のリンクが生き続ける）。
  // 旧「傾向」(#trend) は「お店」タブの「曜日・時間」に統合した。
  var VIEWS = ['home', 'overview', 'staff', 'rfm', 'data'];

  // sources.{yoyaku,kaikei} are `{ records, fileName, via }|null` — the two
  // upload/sheet slots that feed applySources(). `source`/`fileName` below are
  // the *displayed* label, derived from whichever slot(s) are loaded.
  var state = {
    data: null, analytics: null, view: 'home', source: 'サンプルデータ', fileName: null,
    me: null,             // この端末の「あなた」（スタッフ名）。'' はお店だけ表示、null は未選択
    targets: { status: 'idle' },   // スプレッドシート「目標」タブの読み込み状態（targets.js）
    storeSeg: 'sales',    // 「お店」タブの表示中の区分（sales / repeat / time）
    staffSel: null,       // 「スタッフ」タブで表示中のスタッフ名（'__compare' は比較）
    sheetUrl: null, sheetUrlKaikei: null, sources: { yoyaku: null, kaikei: null }, mergeReport: null,
    sharedBlob: null,   // data/shared-link.json（合言葉で暗号化されたシートURL）があれば入る
    ownerLock: null,    // data/owner-lock.json（管理用の合言葉で暗号化されたロック）があれば入る
    ownerUnlocked: false, // 解除済みか（この端末で一度解除すれば ownerUnlockKey で記憶される）
    taxExcluded: true,  // 税抜表示をメインに（トグルで税込へ）。端末設定として localStorage に保存
    dataLoadedAt: null,   // この画面が実データを読み込んだ日時（連携/アップロード時に記録）
    autoReloadLast: null, // 夜間の自動更新が実際に発火した日時（ページを開いていた時のみ）
    autoReloadNext: null, // 次回の発火予定日時
    contentChangedAt: {}, // スロット別「取得内容が最後に変わった時刻」（端末に保存・再読込をまたぐ）
    sheetErrors: {},      // スロット別の読み込み失敗 { yoyaku|kaikei: {message, at, stage, kinds} }。
                          // 起動時の自動読み込みは silent なので、失敗しても従来は画面に
                          // 何も出ず、サンプルデータのまま「反映されない」ように見えていた。
    sheetUpdatedAt: null  // シート側が記録した同期完了日時（「データ更新日時」列。applySources で導出）
  };
  (function () { try { if (localStorage.getItem('kate-tax') === 'incl') state.taxExcluded = false; } catch (e) {} })();
  (function () { try { var v = localStorage.getItem('kate-me'); if (v !== null) state.me = v; } catch (e) {} })();
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
  // 日付表示は「最終読込」＝この画面がスプレッドシートを読みに行って成功した時刻の1つだけ。
  //
  // 以前はシート側の「データ更新日時」列の値も併記していたが、この列を書いているのは
  // スプレッドシートの別スクリプトで、**データが正常に更新されていてもこの列だけ
  // 止まることがある**（実際に32時間止まり、誤警告と混乱の原因になった）。
  // 併記すると「シートが更新されていない」と読めてしまうため、ヘッダーからは外し、
  // データタブの診断（そこには由来の説明もある）に残す。
  function dataStamp() {
    if (state.dataLoadedAt) return ' <span class="lead-upd" title="この画面がスプレッドシート／ファイルを読み込んだ日時">最終読込 ' + ymdhmJa(state.dataLoadedAt) + ' 時点' +
'</span>';
    if (state.sheetUpdatedAt) return ' <span class="lead-upd" title="スプレッドシート側のスクリプトが「データ更新日時」列に記録した時刻（この列だけ止まることがあります）">データ更新 ' + ymdhmJa(state.sheetUpdatedAt) + ' 時点</span>';
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
  // 上の2人以外のスタッフ（新しく入った方など）には、データのスタッフ順に別々の色を
  // 割り当てる（以前は全員が同じ --series-6 になり、比較のグラフで見分けられなかった）。
  // 緑（--series-3）は「固定化率」の線（--cat-repeat）と並ぶため最後に回し、灰色
  // （--series-7）は「お店全体」「先月」に使うので割り当てない。
  var STAFF_EXTRA = ['--series-4', '--series-6', '--series-5', '--series-9', '--series-8', '--series-3'];
  function staffToken(name) {
    if (STAFF_COLOR[name]) return STAFF_COLOR[name];
    var names = (state.analytics && state.analytics.meta && state.analytics.meta.staffNames) || [];
    var others = names.filter(function (n) { return !STAFF_COLOR[n]; });
    var i = others.indexOf(name);
    return i === -1 ? '--series-6' : STAFF_EXTRA[i % STAFF_EXTRA.length];
  }
  // Per-staff monotonic ordinal ramp (new -> 2nd -> 3rd -> 4th+), same identity
  // hue as STAFF_COLOR — lets an ordinal-tier stacked bar stay staff-colored
  // instead of collapsing every staff into one shared blue ramp.
  var STAFF_RAMP = { 'momo': ['--funnel-2', '--funnel-3', '--funnel-4', '--funnel-5'], 'aoi': ['--funnel-o2', '--funnel-o3', '--funnel-o4', '--funnel-o5'] };
  // 2色を混ぜる（#rgb / #rrggbb のみ。読めなければ a をそのまま返す）
  function mixHex(a, b, t) {
    function rgb(h) {
      h = String(h || '').trim().replace('#', '');
      if (h.length === 3) h = h.replace(/./g, function (c) { return c + c; });
      return /^[0-9a-f]{6}$/i.test(h) ? [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16); }) : null;
    }
    var x = rgb(a), y = rgb(b);
    if (!x || !y) return a;
    return '#' + x.map(function (v, i) { return ('0' + Math.round(v * t + y[i] * (1 - t)).toString(16)).slice(-2); }).join('');
  }
  function staffTierColor(name, tier) {
    if (STAFF_RAMP[name]) return cvar(STAFF_RAMP[name][tier]);
    // 専用の濃淡が無いスタッフは、本人の色をカードの地の色に混ぜて4段の濃淡を作る
    // （ライトでは淡く、ダークでは暗く。濃いほど回数の多いお客様）。
    return mixHex(cvar(staffToken(name)), cvar('--surface-1'), [0.38, 0.58, 0.8, 1][tier]);
  }
  // 9グループそれぞれに別の色（以前は高ロイヤルと離脱が同じ紫で見分けられなかった）
  var SEG_COLOR = {
    '最優良顧客': '--series-1', '高ロイヤル顧客': '--series-4', '優良顧客': '--series-6', '安全顧客': '--series-3',
    '要注意顧客': '--series-2', '新規顧客': '--series-9', '離反間近顧客': '--series-5', '休眠顧客': '--series-8', '離脱顧客': '--series-7'
  };
  var SEG_STATUS = {
    '最優良顧客': '--status-good', '高ロイヤル顧客': '--status-good', '優良顧客': '--status-good', '安全顧客': '--status-good',
    '要注意顧客': '--status-warning', '新規顧客': '--accent', '離反間近顧客': '--status-serious', '休眠顧客': '--status-serious', '離脱顧客': '--status-critical'
  };

  // ---- line icons (SF-Symbols-like, stroke = currentColor) ----------------
  var ICONS = {
    home: '<path d="M3.5 10.6 12 3.8l8.5 6.8"/><path d="M5.8 9v9.7c0 .9.7 1.6 1.6 1.6h3.1v-5.6h3v5.6h3.1c.9 0 1.6-.7 1.6-1.6V9"/>',
    store: '<path d="M4 9.2 5.6 4h12.8L20 9.2"/><path d="M4 9.2c0 1.5 1.2 2.6 2.7 2.6s2.6-1.1 2.6-2.6c0 1.5 1.2 2.6 2.7 2.6s2.7-1.1 2.7-2.6c0 1.5 1.1 2.6 2.6 2.6S20 10.7 20 9.2"/><path d="M5.5 11.6V20h13v-8.4"/><path d="M10 20v-4.6h4V20"/>',
    overview: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
    staff: '<circle cx="9" cy="8.2" r="3.3"/><path d="M3 19.5c0-3.4 2.7-5.6 6-5.6s6 2.2 6 5.6"/><circle cx="17" cy="9" r="2.6"/><path d="M16.2 14c2.7.2 4.8 2 4.8 5"/>',
    person: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.7 3.1-6.2 7-6.2s7 2.5 7 6.2"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    rfm: '<path d="M12 20.3s-7.6-4.6-7.6-10.1A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.6 2.6c0 5.5-7.6 10.1-7.6 10.1z"/>',
    data: '<path d="M4 6.5c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5-3.6 2.5-8 2.5-8-1.1-8-2.5z"/><path d="M4 6.5v5.5c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V6.5"/><path d="M4 12v5.5C4 18.9 7.6 20 12 20s8-1.1 8-2.5V12"/>',
    reservations: '<rect x="3.2" y="4.8" width="17.6" height="15.5" rx="2.2"/><path d="M3.2 9.4h17.6M8 3v3.4M16 3v3.4"/>',
    yen: '<path d="M8 6.5l4 5 4-5"/><path d="M12 11.5V18"/><path d="M9 13.7h6M9 16h6"/>',
    tag: '<path d="M3.8 12.6V4.9c0-.6.5-1.1 1.1-1.1h7.7l7.6 7.6c.5.5.5 1.2 0 1.6l-7.2 7.2c-.5.5-1.2.5-1.6 0z"/><circle cx="8.4" cy="8.4" r="1.4"/>',
    repeat: '<path d="M17 3.5 20 6.5 17 9.5"/><path d="M20 6.5H8.5A4.5 4.5 0 0 0 4 11v.5"/><path d="M7 20.5 4 17.5 7 14.5"/><path d="M4 17.5h11.5A4.5 4.5 0 0 0 20 13v-.5"/>',
    newcust: '<circle cx="10" cy="8" r="3.6"/><path d="M3.5 20c0-3.6 2.9-6 6.5-6 1.4 0 2.6.3 3.6.9"/><path d="M18 14v6M15 17h6"/>',
    goal: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    star: '<path d="M12 3.6l2.5 5.3 5.7.7-4.2 3.9 1.1 5.7L12 16.4l-5.1 2.8 1.1-5.7-4.2-3.9 5.7-.7z"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
    clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.5V12l3 2"/>',
    ltv: '<path d="M12 3l3.6 4.6L12 21 8.4 7.6 12 3z"/><path d="M8.4 7.6h7.2"/>',
    cancel: '<circle cx="12" cy="12" r="8.6"/><path d="M9 9l6 6M15 9l-6 6"/>',
    retail: '<path d="M6 8.5h12l-1 11.2a1.6 1.6 0 0 1-1.6 1.5H8.6A1.6 1.6 0 0 1 7 19.7L6 8.5z"/><path d="M9 8.5v-1a3 3 0 0 1 6 0v1"/>',
    phone: '<path d="M6.6 3.8h2.6l1.4 4-1.9 1.4a11 11 0 0 0 6.1 6.1l1.4-1.9 4 1.4v2.6c0 .9-.7 1.6-1.6 1.6A15.6 15.6 0 0 1 5 5.4c0-.9.7-1.6 1.6-1.6z"/>',
    upload: '<path d="M12 16V5"/><path d="M7.5 9.5 12 5l4.5 4.5"/><path d="M5 15v3.2A2.8 2.8 0 0 0 7.8 21h8.4a2.8 2.8 0 0 0 2.8-2.8V15"/>'
  };
  function svgIco(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>'; }
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
  function help(text) { return '<button type="button" class="help-ico" data-help="' + esc(text) + '" aria-label="説明を見る">i</button>'; }
  // 説明文の中では <b> <br> <code> だけを飾りとして使える。それ以外はすべて
  // 文字として表示する（説明文は作者が書いた定数だが、念のため許可制にしておく）。
  function helpHtml(text) { return esc(text).replace(/&lt;(\/?)(b|code|br)&gt;/g, '<$1$2>'); }
  var helpPopEl = null, helpPopFor = null, helpPopOpenedAt = 0;
  function hideHelpPop() { if (helpPopEl) helpPopEl.classList.remove('show'); if (helpPopFor) helpPopFor.classList.remove('active'); helpPopFor = null; }
  function showHelpPop(btn) {
    if (!helpPopEl) { helpPopEl = document.createElement('div'); helpPopEl.className = 'help-pop'; helpPopEl.setAttribute('role', 'status'); document.body.appendChild(helpPopEl); }
    helpPopEl.innerHTML = helpHtml(btn.dataset.help);
    var r = btn.getBoundingClientRect();
    var left = Math.max(8, Math.min(window.innerWidth - 268, r.left + r.width / 2 - 130));
    helpPopEl.style.left = left + 'px';
    // 画面の中に収める: 基本は ? の下。下に入りきらなければ ? の上、上にも入らなければ
    // 画面内に押し込む（長い説明文がスマホで下にはみ出し、スクロールすると閉じてしまって
    // 末尾が読めない問題の対策）。それでも収まらない長さは max-height で中をスクロール。
    var gap = 8, vh = window.innerHeight;
    helpPopEl.style.maxHeight = (vh - gap * 2) + 'px';
    var h = helpPopEl.offsetHeight;
    var top = r.bottom + gap;
    if (top + h > vh - gap) top = (r.top - gap - h >= gap) ? r.top - gap - h : Math.max(gap, vh - gap - h);
    helpPopEl.style.top = top + 'px';
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
    // opts: {title, sub, tag, col, body(html), id, icon, color}
    // iOS「ヘルスケア」のカード: 見出し（17px・太字）をカードの「中」に置き、
    // その下に補足（sub）、本文の順に並べる。以前は見出しを 13px の灰色でカードの
    // 外に出していたため、どのグラフが何なのかが読み取りにくかった。
    // 外側の .gsec はグリッドの列幅（col-*）を受け持つ（テストもこれで要素を探す）。
    var cls = (opts.col || 'col-12') + (opts.hoverable ? ' hoverable' : '');
    var idAttr = opts.id ? ' id="' + opts.id + '"' : '';
    if (!opts.title) return '<div class="card reveal ' + cls + '"' + idAttr + '>' + opts.body + '</div>';
    var ico = opts.icon ? '<span class="ct-ico" style="background:' + (opts.color || 'var(--accent)') + '">' + svgIco(opts.icon) + '</span>' : '';
    var head = '<div class="card-head"><div class="card-title">' + ico + opts.title + '</div>' + (opts.tag ? '<span class="card-tag">' + opts.tag + '</span>' : '') + '</div>';
    var sub = opts.sub ? '<div class="card-sub">' + opts.sub + '</div>' : '<div style="height:6px"></div>';
    return '<div class="gsec reveal ' + cls + '"' + idAttr + '><div class="card">' + head + sub + opts.body + '</div></div>';
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

  // ===================== ホーム／お店／スタッフで共通の小物 =====================
  var MIN_DEN = 5;   // 率を表示する最小の分母（engine の MIN_RATE_DENOM と同じ。1人で0%・100%に振れるのを防ぐ）
  function taxLead() { return state.analytics.meta.taxExcluded ? '<b>金額は税抜です。</b>' : '<b>金額は税込です。</b>'; }
  function monthJa(ym) { return (+String(ym).split('-')[1]) + '月'; }
  function mdJa(ym, d) { return (+String(ym).split('-')[1]) + '/' + d; }
  function staffColor(name) { return cvar(staffToken(name)); }
  // HTML に書くスタッフ色は CSS 変数の参照（テーマを切り替えると自動で追従し、見出しの
  // 文字色 --hc-ink も inkStyle が 'var(--series-N-ink)' として添える）。グラフ（SVG）には
  // 実際の色が要るので staffColor() を使う。
  function staffVar(name) { return 'var(' + staffToken(name) + ')'; }
  // --hc-color（アイコン・リングの色）に添える --hc-ink（見出しの文字色）。
  // 'var(--cat-visits)' → 'var(--cat-visits-ink)'。解決済みの色（スタッフ色）には
  // 呼び出し側が ink を渡す。どちらも無ければ出さない（CSS 側の既定の文字色になる）。
  function inkStyle(color, ink) {
    if (!ink) { var mt = /^var\((--[\w-]+)\)$/.exec(String(color || '')); if (mt) ink = 'var(' + mt[1] + '-ink)'; }
    return ink ? ';--hc-ink:' + ink : '';
  }
  function yenHtml(v) { return '<span class="yen">¥</span>' + F.int(v); }
  // 増減（↑ 緑・↓ オレンジ・→ 灰）。kind: 'yen' | 'count'
  // 差は「画面に出している丸めた値どうし」の差にする（生の値の差を丸めると、並んで
  // 表示している2つの数字の差と1ずれることがある）。
  function delta(cur, prev, kind, unit) {
    if (cur == null || prev == null || !isFinite(cur) || !isFinite(prev)) return '';
    var d = Math.round(cur) - Math.round(prev);
    var cls = d === 0 ? 'flat' : d > 0 ? 'up' : 'down';
    var txt = cls === 'flat' ? '同じ' : (kind === 'yen' ? yen(Math.abs(d)) : F.int(Math.abs(d)) + (unit || ''));
    return '<span class="dlt ' + cls + '">' + (cls === 'up' ? '↑' : cls === 'down' ? '↓' : '→') + ' ' + txt + '</span>';
  }
  // 率の増減（ポイント差）。表示している整数の%どうしの差（例: 81% と 65% → 16ポイント）。
  // 以前は丸める前の率の差（16.58）を丸めて「17ポイント」と出し、並んだ数字と合わなかった。
  function pctInt(r) { return Math.round(r * 100); }   // pct(r*100, 0) と同じ丸め（率は0以上）
  function deltaPt(cur, prev) {
    if (cur == null || prev == null) return '';
    var d = pctInt(cur) - pctInt(prev);
    var cls = d === 0 ? 'flat' : d > 0 ? 'up' : 'down';
    return '<span class="dlt ' + cls + '">' + (cls === 'up' ? '↑' : cls === 'down' ? '↓' : '→') + ' ' + (cls === 'flat' ? '同じ' : Math.abs(d) + 'ポイント') + '</span>';
  }
  // 目標の達成率（%表示）。100%に届いていないのに四捨五入で「100%」と出さない。
  function achPct(frac) { var v = Math.round(frac * 100); return frac < 1 ? Math.min(v, 99) : v; }
  function secH(title, sub, link) {
    return '<div class="sec-h"><h2>' + title + '</h2>' + (link || (sub ? '<span class="sec-sub">' + sub + '</span>' : '')) + '</div>';
  }
  function hcRow(label, value) { return '<div class="hc-row"><span>' + label + '</span><b>' + value + '</b></div>'; }
  function tile(o) {   // { icon, color, ink, label, value(html), sub, delta, help, cls, kpi }
    // data-kpi にはスタッフ名（スプレッドシート由来）が入るため必ずエスケープする
    return '<div class="tile" style="--hc-color:' + o.color + inkStyle(o.color, o.ink) + '"' + (o.kpi ? ' data-kpi="' + esc(o.kpi) + '"' : '') + '>' +
      '<div class="tile-h">' + svgIco(o.icon) + '<span>' + o.label + '</span>' + (o.help ? help(o.help) : '') + '</div>' +
      '<div class="tile-v' + (o.cls ? ' ' + o.cls : '') + '">' + o.value + '</div>' +
      (o.sub ? '<div class="tile-s">' + o.sub + '</div>' : '') +
      (o.delta ? '<div class="tile-d">' + o.delta + '</div>' : '') + '</div>';
  }
  // 目標（スプレッドシートの「目標」タブ）。表示中の税区分の金額で返す。
  function targetFor(ym, who) {
    var t = state.targets;
    // 連携が外れた後に遅れて届いた「目標」を、サンプルデータの上に出さない
    if (!state.sheetUrl && !state.sheetUrlKaikei) return null;
    if (!t || t.status !== 'ok' || !t.parsed || !global.KATE.targets) return null;
    return global.KATE.targets.pick(t.parsed, ym, who, state.taxExcluded ? 0.1 : 0);
  }
  // iOS のセグメントコントロール（タブ内の切り替え）。scroll=true は項目が多いとき
  // （スタッフ選択）に、ページ全体ではなくこの行の中だけを横にスクロールさせる。
  function segControl(id, items, active, label, scroll) {
    return '<div class="subnav' + (scroll ? ' seg-scroll' : '') + '"><div class="segmented full" id="' + id + '" role="group" aria-label="' + esc(label || '表示の切り替え') + '">' +
      items.map(function (o) { var on = o[0] === active; return '<button type="button" data-k="' + esc(o[0]) + '" aria-pressed="' + on + '"' + (on ? ' class="active"' : '') + '>' + esc(o[1]) + '</button>'; }).join('') +
      '<span class="seg-thumb"></span></div></div>';
  }
  function placeThumb(seg) {
    if (!seg) return;
    var a = seg.querySelector('button.active'), th = seg.querySelector('.seg-thumb');
    if (a && th) { th.style.width = a.offsetWidth + 'px'; th.style.transform = 'translateX(' + a.offsetLeft + 'px)'; }
  }
  function placeAllThumbs() { Array.prototype.forEach.call(document.querySelectorAll('.segmented'), placeThumb); }
  // data-k が k のボタン（スタッフ名はシート由来なので、CSS セレクタを組み立てずに比べる）
  function segButton(id, k) {
    var seg = document.getElementById(id);
    return seg ? Array.prototype.filter.call(seg.querySelectorAll('button[data-k]'), function (x) { return x.dataset.k === k; })[0] || null : null;
  }
  function wireSeg(id, onPick) {
    var seg = document.getElementById(id); if (!seg) return;
    placeThumb(seg);
    // 横にスクロールする行では、選んでいる項目（右端の「比較」など）を見える位置へ
    var scroller = seg.parentNode && seg.parentNode.classList.contains('seg-scroll') ? seg.parentNode : null;
    var act = seg.querySelector('button.active');
    if (scroller && act && scroller.scrollWidth > scroller.clientWidth) {
      scroller.scrollLeft = Math.max(0, act.offsetLeft - (scroller.clientWidth - act.offsetWidth) / 2);
    }
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-k]'); if (!b || b.classList.contains('active')) return;
      var k = b.dataset.k, hadFocus = seg.contains(document.activeElement);
      onPick(k);
      // 選ぶと画面ごと描き直すため、押したボタンが消えてフォーカスが <body> に落ちる。
      // キーボード・読み上げで操作中だった場合は、描き直した同じボタンへ戻す。
      if (hadFocus) { var nb = segButton(id, k); if (nb) nb.focus({ preventScroll: true }); }
    });
  }

  // ---- 今月の売上カード（お店・スタッフ共通）---------------------------------
  // m は engine の month（store.month / staff.month）。who は 'store' かスタッフ名。
  // 予約込みの見込みを出せるか（データに「これからの予約」があるか）。出せないときの理由。
  function bookedTracked(m) { return !m.booked || m.booked.tracked !== false; }
  function noBookingReason() {
    return state.analytics.meta.hasReservationRows
      ? 'データに今日より後の予約が入っていないため、予約込みの見込みは出せません（予約データを出力する期間に、これからの日付を含めてください）。'
      : '会計明細には予約が含まれないため、予約込みの見込みは出せません（予約データを連携すると表示されます）。';
  }
  function monthCard(m, o) {
    var cur = m.cur, ps = m.prevSame, pf = m.prevFull, hasPrev = pf.visits > 0;
    var tgt = targetFor(m.ym, o.who), tracked = bookedTracked(m);
    var ring = tgt ? '<div class="hc-ring" id="' + o.id + 'Ring"></div>' : '';
    var lines = hasPrev
      ? '<div class="hc-line">先月の同じ時期より ' + delta(cur.rev, ps.rev, 'yen') + '</div>' +
        '<div class="hc-line muted">先月 ' + mdJa(m.prevYm, 1) + '〜' + mdJa(m.prevYm, m.prevDay) + '：' + yen(ps.rev) + '</div>'
      : '<div class="hc-line muted">先月のデータがありません</div>';
    if (o.share != null) lines += '<div class="hc-line">お店の今月の売上のうち <b>' + pct(o.share * 100, 0) + '</b> を担当</div>';
    // 会計明細だけ（予約が記録されていない）なら「残りの予約 0件・¥0」とは書かない
    var rows = tracked
      ? hcRow('予約込みの見込み', yen(m.withBooked)) + hcRow(monthJa(m.ym) + 'の残りの予約', F.int(m.booked.count) + '件・' + yen(m.booked.rev))
      : hcRow('予約込みの見込み', '—') + '<div class="hc-line muted">' + noBookingReason() + '</div>';
    if (tgt) {
      // 目安・差は、画面に出している丸めた金額どうしで計算する（並んだ数字と1円ずれないように）
      var pace = Math.round(tgt.amount * m.day / m.daysInMonth), gap = Math.round(cur.rev) - pace;
      rows += hcRow('今月の目標' + (tgt.source === 'default' ? '（毎月の目標）' : ''), yen(tgt.amount)) +
        (tracked
          ? hcRow('達成率（実績 ／ 予約込み）', achPct(cur.rev / tgt.amount) + '% ／ ' + achPct(m.withBooked / tgt.amount) + '%')
          : hcRow('達成率（実績）', achPct(cur.rev / tgt.amount) + '%')) +
        hcRow('目標ペース（' + m.day + '日目の目安 ' + yen(pace) + '）', '<span class="dlt ' + (gap >= 0 ? 'up' : 'down') + '">' + (gap >= 0 ? '＋' : '−') + yen(Math.abs(gap)) + '</span>');
    }
    if (hasPrev) rows += hcRow('先月（' + monthJa(m.prevYm) + '）の売上', yen(pf.rev));
    return '<div class="hc" style="--hc-color:' + o.color + inkStyle(o.color, o.ink) + '" data-kpi="' + esc(o.kpi) + '">' +
      '<div class="hc-h"><span class="hc-ico">' + svgIco(o.icon) + '</span><span class="hc-t">' + o.title + '</span>' +
      help(o.helpText + (tracked ? '' : '（' + noBookingReason() + '）')) + '</div>' +
      '<div class="hc-main"><div class="hc-nums"><div class="hc-value">' + yenHtml(cur.rev) + '</div>' + lines + '</div>' + ring + '</div>' +
      '<div class="hc-chart chart-box" id="' + o.id + 'Cum"></div>' +
      '<div class="hc-foot">' + rows + '</div></div>';
  }
  function drawMonthCard(m, o) {
    var tgt = targetFor(m.ym, o.who), tracked = bookedTracked(m);
    if (tgt) draw(o.id + 'Ring', function (el) {
      var ach = m.cur.rev / tgt.amount, withB = m.withBooked / tgt.amount;
      C.ring(el, { value: ach, extra: tracked ? withB : null, color: o.ringColor || cvar('--cat-goal'), size: 100,
        label: achPct(ach) + '%', sub: '目標', aria: '目標の達成率 ' + achPct(ach) + '%' + (tracked ? '（予約込み ' + achPct(withB) + '%）' : '') });
    });
    draw(o.id + 'Cum', function (el) {
      var dim = Math.max(m.daysInMonth, m.prevDaysInMonth);
      var days = []; for (var d = 1; d <= dim; d++) days.push(d + '日');
      var pad = function (arr) { var a = arr.slice(0, dim); while (a.length < dim) a.push(null); return a; };
      var booked = m.daily.withBooked.map(function (v, i) { return i + 1 >= m.day ? v : null; });
      var series = [];
      if (tracked) series.push({ name: '予約込み', color: o.color, values: pad(booked), dashed: true, width: 2.5 });
      series.push({ name: '今月（実績）', color: o.color, values: pad(m.daily.cur), dots: false, endLabel: false, width: 4 });
      if (m.prevFull.visits > 0) series.push({ name: '先月', color: cvar('--series-7'), values: pad(m.daily.prev), faded: true });
      if (tgt) series.push({ name: '目標ペース', color: cvar('--cat-goal'), dashed: true,
        values: days.map(function (_, i) { return i < m.daysInMonth ? tgt.amount * (i + 1) / m.daysInMonth : null; }) });
      C.lineArea(el, {
        xLabels: days, tipLabels: days.map(function (_, i) { return (i + 1) + '日目までの累計'; }),
        xTicks: [0, 9, 19, dim - 1], series: series, area: false, valueFmt: yen, yFmt: F.compact, height: 170
      });
    });
  }
  // 今月の小さいカード4枚（来店・客単価・新規・次回予約率）
  function monthTiles(m, kpiPrefix) {
    var cur = m.cur, ps = m.prevSame, pf = m.prevFull, hasPrev = pf.visits > 0;
    function cmp(dl, ref) { return hasPrev ? dl + ' <span class="muted">' + ref + '</span>' : '<span class="muted">先月のデータなし</span>'; }
    var nextShown = cur.nextDen >= MIN_DEN, cens = state.analytics.meta.completedOnly;
    // 比べる先月も、5件未満なら率を出さない（1〜4件の 0%・100% と比べて大きな差を出さない）
    var nextDelta = !nextShown ? ''
      : pf.nextDen >= MIN_DEN ? cmp(deltaPt(cur.nextRate, pf.nextRate), '先月 ' + pct(pf.nextRate * 100, 0))
      : pf.nextDen ? '<span class="muted">先月 —（' + F.int(pf.nextNum) + '/' + F.int(pf.nextDen) + '件・5件未満）</span>'
      : pf.nextCensored ? '<span class="muted">先月 —（再来待ち）</span>'
      : (hasPrev ? '' : cmp('', ''));
    return '<div class="tiles">' +
      tile({ icon: 'reservations', color: 'var(--cat-visits)', label: '来店', kpi: kpiPrefix + '-visits',
        value: F.int(cur.visits) + '<span class="u">件</span>',
        delta: cmp(delta(cur.visits, ps.visits, 'count', '件'), '先月同時期 ' + F.int(ps.visits) + '件') }) +
      tile({ icon: 'tag', color: 'var(--cat-spend)', label: '客単価', kpi: kpiPrefix + '-spend',
        help: '今月の会計済み売上 ÷ 来店件数（実績のみ）。',
        value: cur.spend != null ? yenHtml(cur.spend) : '—',
        delta: cur.spend != null && ps.spend != null ? cmp(delta(cur.spend, ps.spend, 'yen'), '先月同時期 ' + yen(ps.spend)) : (hasPrev ? '' : cmp('', '')) }) +
      tile({ icon: 'newcust', color: 'var(--cat-new)', label: '新規', kpi: kpiPrefix + '-new',
        help: 'そのお客様にとって1回目の来店（会計済み）の件数。',
        value: F.int(cur.newVisits) + '<span class="u">人</span>',
        delta: cmp(delta(cur.newVisits, ps.newVisits, 'count', '人'), '先月同時期 ' + F.int(ps.newVisits) + '人') }) +
      tile({ icon: 'repeat', color: 'var(--cat-repeat)', label: '次回予約率', kpi: kpiPrefix + '-next',
        help: (cens
          ? '来店のうち、その後の予約・来店が入っている割合。会計明細だけのデータには「これからの予約」が含まれないため、月末から30日経っていない月（今月を含む）の来店は、まだ次の来店が来ていないだけで0%に寄ってしまいます。そのため、その月の率は出さず「再来待ち」と表示します。'
          : '今月の来店のうち、その後の予約（今後の受付待ちを含む・キャンセルは除く）が入っている割合。月の途中は件数が少なく大きく振れるため、5件未満のあいだは率を出しません。比べる先月は月全体の値で、先月も5件未満なら比べません（先月の来店は、その後に予約を入れる時間が今月より長くあったぶん高めに出やすい点にご注意ください）。'),
        value: nextShown ? pct(cur.nextRate * 100, 0) : '—',
        sub: cur.nextDen ? F.int(cur.nextNum) + '件 ÷ ' + F.int(cur.nextDen) + '件' + (nextShown ? '' : '（5件未満）')
          : cur.nextCensored ? '再来待ち（会計明細のみのため）' : '来店なし',
        delta: nextDelta }) +
      '</div>';
  }

  // ============================ HOME =======================================
  // 開いて最初の画面。「お店の今月」と「あなたの今月」を同じ物差しで並べる。
  function currentMe() {
    var names = state.analytics.meta.staffNames;
    return state.me && names.indexOf(state.me) !== -1 ? state.me : null;
  }
  function setMe(name) {
    state.me = name;
    try { localStorage.setItem('kate-me', name); } catch (e) {}
    if (name) state.staffSel = name;
    renderAll();
  }
  // 「あなた」の選択。未選択（null・もういない名前）のときは「選んでください」を
  // 選択済みの見出しとして出す。以前は未選択でも「（お店だけ表示）」が選ばれた状態に
  // なっていて、それを選んでも change が起きず「お店だけ表示」にできなかった。
  function mePicker(names, me) {
    var storeOnly = !me && state.me === '';
    return '<label class="me-pick"><span class="me-dot" style="background:' + (me ? staffColor(me) : 'var(--ink-faint)') + '"></span>' +
      '<span>' + (me ? esc(me) : (storeOnly ? 'お店だけ表示' : '選んでください')) + '</span>' +
      '<select id="mePicker" aria-label="あなたの名前を選ぶ">' +
      (!me && !storeOnly ? '<option value="__unset" disabled selected hidden>選んでください</option>' : '') +
      '<option value="__store"' + (storeOnly ? ' selected' : '') + '>（お店だけ表示）</option>' +
      names.map(function (n) { return '<option value="' + esc(n) + '"' + (n === me ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') +
      '</select></label>';
  }
  function growthText(st) {
    var g = st.growthFocus || {}, G = state.analytics.meta.guide || { repeat: 0.7, fix: 0.6 };
    // 両方の率を判定したときだけ「一番の」と比べる言い方をする
    var tail = (g.judged || []).length >= 2 ? 'ここが一番の伸びしろです。' : 'ここが伸びしろです。';
    var L = { repeat: 'リピート率', fix: '固定化率' };
    function pendText(p) {
      return p.key === 'fix'
        ? '固定化率は、2回来店したお客様が' + F.int(p.need) + '人以上になると判定します（いま' + F.int(p.den) + '人）'
        : 'リピート率は、直近3ヶ月に初回担当したお客様が' + F.int(p.need) + '人以上になると判定します（いま' + F.int(p.den) + '人）';
    }
    if (g.key === 'repeat') return '<b>次の一手</b>：リピート（2回目のご予約）が <b>' + pct(g.value * 100, 0) + '</b>（目安 ' + pct(g.target * 100, 0) + '）。直近3ヶ月に初回担当した ' + F.int(g.den) + '人のうち ' + F.int(g.num) + '人。' + tail;
    if (g.key === 'fix') return '<b>次の一手</b>：常連化（2回来店した方の3回目のご予約）が <b>' + pct(g.value * 100, 0) + '</b>（目安 ' + pct(g.target * 100, 0) + '）。' + F.int(g.den) + '人のうち ' + F.int(g.num) + '人。' + tail;
    if (g.reason === 'met') return '<b>次の一手</b>：リピート率・固定化率とも目安を達成しています。この水準の維持が次の目標です。';
    // 判定できた率だけ「達成」と言う。判定していない率については達成とは書かない。
    if (g.reason === 'met-partial') {
      var jd = g.judged || [];
      return '<b>次の一手</b>：' + jd.map(function (k) { return L[k]; }).join('・') + 'は目安（' + jd.map(function (k) { return pct(G[k] * 100, 0); }).join('・') + '）を達成しています。' +
        (g.pending || []).map(pendText).join('。') + '。';
    }
    if (g.reason === 'censored') return '<b>次の一手</b>：会計明細だけのデータでは、最近のお客様がこの先ご予約を入れたかが見えず、リピート率・固定化率が実際より低く出るため、伸びしろの提案は出していません（予約データを連携すると表示されます）。';
    return '<b>次の一手</b>：お客様の人数がそろうと、伸びしろの提案が表示されます。' + (g.pending && g.pending.length ? g.pending.map(pendText).join('。') + '。' : '（判定には、その率の対象が20人以上必要です）');
  }
  function bestHighlight(st) {
    var pb = st.personalBest, out = [];
    if (!pb || pb.confirmedMonths < 2) return '';
    var lab = { visits: ['月間来店', function (v) { return F.int(v) + '件'; }], rev: ['月間売上', yen], spend: ['月間の平均単価', yen], retail: ['月間の店販売上', yen] };
    Object.keys(lab).forEach(function (k) {
      if (pb.latestIsBest && pb.latestIsBest[k] && pb[k]) out.push('「' + lab[k][0] + '」' + lab[k][1](pb[k].v));
    });
    if (!out.length) return '';
    var mo = pb.rev ? monthJa(pb.rev.m) : '';
    var last = st.monthly.filter(function (x) { return x.actual > 0 && x.m < state.analytics.meta.currentYm; }).slice(-1)[0];
    return '<div class="next-hint hint-good">' + svgInline('star') + ' <b>' + (last ? monthJa(last.m) : mo) + 'は自己ベストを更新しました</b>：' + out.join('・') + '</div>';
  }
  function svgInline(name) { return '<span style="display:inline-block;width:18px;height:18px;vertical-align:-3px;color:var(--good-ink)">' + svgIco(name) + '</span>'; }

  function renderHome() {
    var A = state.analytics, s = A.store, m = s.month;
    var names = A.meta.staffNames, me = currentMe();
    var head = '<div class="view-title">ホーム</div>' +
      '<div class="view-lead">' + esc(monthJa(m.ym)) + '1日〜' + m.day + '日の数字です（' + esc(monthJa(m.ym)) + 'は' + m.daysInMonth + '日まで）。' + taxLead() + dataStamp() + '</div>' +
      '<div class="me-bar"><span class="me-label">あなた</span>' + mePicker(names, me) + '</div>';

    var storeCol = secH('お店の今月', esc(mdJa(m.ym, 1) + '〜' + mdJa(m.ym, m.day))) +
      '<div class="stack">' +
      monthCard(m, { id: 'hStore', who: 'store', title: 'お店の売上（実績）', icon: 'store', color: 'var(--cat-store)', kpi: 'home-store-revenue',
        helpText: '今月1日〜集計基準日までの会計済み売上（実績）。「先月の同じ時期」は先月の1日〜同じ日までの実績です（曜日の並びは月で違うため目安です）。「予約込み」は実績に、今月これから来店予定の受付待ちの予約金額を足したもの。グラフは日ごとの累計で、実線が今月の実績、点線が予約込み、灰色が先月です。目標はスプレッドシートの「目標」タブから読み込みます。' }) +
      monthTiles(m, 'home-store') + '</div>';

    var meCol = null;
    if (me) {
      var st = A.staff.filter(function (x) { return x.name === me; })[0];
      var sm = st.month;
      var share = m.cur.rev > 0 ? sm.cur.rev / m.cur.rev : null;
      var regMile = milestoneProgress(st.regulars3, MILESTONES.regulars);
      meCol = secH('あなた（' + esc(me) + '）の今月', esc(mdJa(m.ym, 1) + '〜' + mdJa(m.ym, m.day))) +
        '<div class="stack">' +
        monthCard(sm, { id: 'hMe', who: me, title: esc(me) + ' の売上（実績）', icon: 'person', color: staffVar(me), share: share, kpi: 'home-me-revenue',
          helpText: 'あなたが担当した今月1日〜集計基準日までの会計済み売上（実績）。比べ方はお店のカードと同じです。「担当」はお店の今月の売上（実績）に占める割合。目標はスプレッドシートの「目標」タブのあなたの列から読み込みます。' }) +
        monthTiles(sm, 'home-me') +
        '<div class="hc" style="--hc-color:var(--cat-repeat)' + inkStyle('var(--cat-repeat)') + '"><div class="hc-h"><span class="hc-ico">' + svgIco('bulb') + '</span><span class="hc-t">あなたのポイント</span></div>' +
        bestHighlight(st) +
        '<div class="next-hint" data-kpi="home-me-next-hint">' + growthText(st) + '</div>' +
        '<div class="hc-foot">' +
        hcRow('育てた常連' + help(REGULARS_HELP), F.int(st.regulars3) + '人' + (regMile.maxed ? '' : '（次は' + F.int(regMile.next) + '人）')) +
        hcRow('直近3ヶ月の初回担当', F.int(st.reachDen) + '人') +
        '</div>' +
        '<div style="margin-top:12px"><button type="button" class="pill wrap" id="homeToStaff">' + esc(me) + ' の詳しい数字を見る ›</button></div>' +
        '</div></div>';
    } else if (state.me !== '') {
      // 未選択（または、いなくなった名前が記憶されていた）ときだけ名前を尋ねる。
      // 「お店だけ表示」を選んだ端末（state.me === ''）では、あなたの列そのものを出さない。
      meCol = secH('あなたの今月') +
        '<div class="hc" style="--hc-color:var(--accent)' + inkStyle('var(--accent)') + '"><div class="hc-h"><span class="hc-ico">' + svgIco('person') + '</span><span class="hc-t">あなたはどなたですか？</span></div>' +
        '<div class="hc-line">名前を選ぶと、ここに<b>あなたの今月の数字</b>（売上・来店・次回予約率・目標の達成度など）が出ます。この端末で1回選べば次回からは自動で表示されます。お店の数字だけを見る端末は、上の「あなた」で「（お店だけ表示）」を選んでください。</div>' +
        '<div class="pick-staff">' + names.map(function (n) { return '<button type="button" class="pill wrap" data-me="' + esc(n) + '"><span class="me-dot" style="background:' + staffColor(n) + '"></span>' + esc(n) + '</button>'; }).join('') + '</div>' +
        '</div>';
    }

    mount('home', head + (meCol
      ? '<div class="home-cols"><div>' + storeCol + '</div><div>' + meCol + '</div></div>'
      : '<div class="home-cols home-cols--single"><div>' + storeCol + '</div></div>'));

    drawMonthCard(m, { id: 'hStore', who: 'store', color: cvar('--cat-store') });
    if (me) {
      var st2 = A.staff.filter(function (x) { return x.name === me; })[0];
      drawMonthCard(st2.month, { id: 'hMe', who: me, color: staffColor(me), ringColor: staffColor(me) });
      var toStaff = $('#homeToStaff');
      if (toStaff) toStaff.addEventListener('click', function () { state.staffSel = me; route('staff'); });
    }
    // 選ぶと画面ごと描き直すため、フォーカスを描き直した「あなた」の選択欄へ戻す
    // （キーボード・読み上げで操作していた人が、ページの先頭に飛ばされないように）。
    function pickMe(v) {
      setMe(v === '__store' ? '' : v);
      var np = $('#mePicker'); if (np) np.focus({ preventScroll: true });
    }
    var picker = $('#mePicker');
    if (picker) picker.addEventListener('change', function () { if (picker.value !== '__unset') pickMe(picker.value); });
    Array.prototype.forEach.call(document.querySelectorAll('#view-home [data-me]'), function (b) {
      b.addEventListener('click', function () { pickMe(b.dataset.me); });
    });
    flush();
  }
  var REGULARS_HELP = 'あなたが初回を担当したお客様のうち、実際に2回来店して、3回目のご予約（これからの予約を含む・キャンセルは数えない）まで進んだ方の人数。固定化率の「3回目到達」と同じ基準で、全期間の累計です。';

  // 会計明細のみのデータで、次回予約率の直近の月を除いていることの説明（予約データでは空）
  function nextCensHelp() {
    return state.analytics.meta.completedOnly
      ? '会計明細だけのデータには「これからの予約」が含まれないため、月末から30日経っていない月の来店は、次の来店がまだ来ていないだけで0%に寄ります。その月の来店は次回予約率から除き、すべて除かれた期間は「再来待ち」と表示します。'
      : '';
  }
  // ---- 期間の表（直近3ヶ月・先月・今月）: お店・スタッフ共通 -----------------
  function ptYen(v) { return v == null ? '—' : '<span class="full-num">' + yen(v) + '</span><span class="compact-num">' + yenCompact(v) + '</span>'; }
  function periodTableFull(P, meta, opts) {
    opts = opts || {};
    var day = meta.asOf ? +meta.asOf.slice(8, 10) : null;
    var cols = [
      { k: 'last3', label: '直近3ヶ月', sub: '月平均' },
      { k: 'prev', label: '先月', sub: monthJa(meta.prevYm) },
      { k: 'cur', label: '今月', sub: monthJa(meta.currentYm) + (day ? day + '日まで' : '') }
    ];
    var rows = [
      { label: '売上', v: function (b, k) { return k === 'last3' ? b.revPerMonth : b.rev; }, f: ptYen },
      { label: '1日あたり', v: function (b) { return b.revPerDay; }, f: ptYen },
      { label: '来店', v: function (b, k) { return k === 'last3' ? b.visitsPerMonth : b.visits; }, f: function (v) { return F.int(v) + '件'; } },
      { label: '客単価', v: function (b) { return b.spend; }, f: ptYen },
      { label: '新規', v: function (b, k) { return k === 'last3' ? b.newPerMonth : b.newVisits; }, f: function (v) { return F.int(v) + '人'; } },
      { label: '次回予約率', v: function (b) { return b.nextDen >= MIN_DEN ? b.nextRate : null; }, f: function (v) { return pct(v * 100, 0); },
        // 会計明細のみのデータでは、月末から30日経っていない月の来店を「再来待ち」として除く
        sub: function (b) {
          if (b.nextDen) return F.int(b.nextNum) + '/' + F.int(b.nextDen) + '件' + (b.nextCensored ? '・直近の月を除く' : '');
          return b.nextCensored ? '再来待ち' : '';
        } }
    ];
    if (opts.retail) rows.push({ label: '店販売上', v: function (b, k) { return k === 'last3' ? b.retailPerMonth : b.retail; }, f: ptYen });
    return '<div class="table-wrap"><table class="ptable"' + (opts.kpi ? ' data-kpi="' + esc(opts.kpi) + '"' : '') + '><thead><tr><th></th>' +
      cols.map(function (c) { return '<th>' + c.label + '<small>' + esc(c.sub) + '</small></th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + r.label + '</td>' + cols.map(function (c) {
          var b = P[c.k];
          if (!b || !b.visits) return '<td>—</td>';
          var v = r.v(b, c.k);
          return '<td' + (c.k === 'cur' ? ' class="cur"' : '') + '>' + (v == null ? '—' : r.f(v)) + (r.sub && r.sub(b) ? '<small>' + r.sub(b) + '</small>' : '') + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ============================ お店（旧「概要」＋「傾向」） ==================
  var STORE_SEGS = [['sales', '売上・予約'], ['repeat', 'リピート'], ['time', '曜日・時間']];
  function renderOverview() {
    var A = state.analytics, s = A.store, t = A.trend;
    var seg = STORE_SEGS.some(function (x) { return x[0] === state.storeSeg; }) ? state.storeSeg : 'sales';
    var head = '<div class="view-title">お店</div><div class="view-lead">' + esc(ymRangeJa(A.meta.periodStart, A.meta.periodEnd)) + 'のデータ（来店されたお客様 ' + esc(F.int(s.customers)) + '人）。' + taxLead() + dataStamp() + '</div>' +
      segControl('storeSeg', STORE_SEGS, seg, 'お店の表示');
    var html = '';
    var moneyTag = A.meta.taxExcluded ? '税抜' : '税込';   // 金額のグラフの右上に出す税区分

    if (seg === 'sales') {
      // 基本の数字（全期間）
      html += '<div class="col-12"><div class="tiles t4">' +
        tile({ icon: 'person', color: 'var(--cat-store)', label: 'お客様', kpi: 'store-customers', cls: 'stat-value',
          value: F.int(s.customers) + '<span class="u">人</span>', sub: '全期間に来店された方' }) +
        tile({ icon: 'tag', color: 'var(--cat-spend)', label: '客単価', kpi: 'store-avg-spend', cls: 'stat-value',
          help: '全期間の会計済み売上 ÷ 来店件数。受付待ちの予約は含めません。', value: yenHtml(s.avgSpendActual), sub: '全期間・会計済み（実績）' }) +
        tile({ icon: 'ltv', color: 'var(--cat-sales)', label: '顧客LTV', kpi: 'store-ltv', cls: 'stat-value',
          help: '来店されたお客様1人あたりの累計売上（実績）。「予測」は今の客単価が続くと仮定し、1回〜5回到達率の合計（期待来店回数）を掛けた見込み。',
          value: yenHtml(s.ltv.current), sub: '予測 ' + yen(s.ltv.predicted) + '（期待来店 ' + s.ltv.expectedVisits + '回）' }) +
        tile({ icon: 'clock', color: 'var(--cat-new)', label: '来店周期', kpi: 'store-cycle',
          help: '同じお客様の来店と来店の間隔（日数）の中央値。', value: F.int(s.visitCycleMedianDays) + '<span class="u">日</span>', sub: '来店の間隔の中央値' }) +
        '</div></div>';
      html += card({
        col: 'col-12', title: '月ごとの数字' , icon: 'yen', color: 'var(--cat-sales)',
        sub: '会計済み（実績）だけで比べています。直近3ヶ月＝今月を含まない確定3ヶ月の月平均（来店のあった月数で割る）。今月は集計途中です。' + help('「売上」の直近3ヶ月は月平均、先月・今月はその月の合計です。「1日あたりの売上」は売上 ÷ 営業日（会計が1件以上あった日）。「次回予約率」は来店のうち、その後の予約（受付待ちを含む・キャンセルは除く）が入っている割合で、5件未満の期間は率を出しません。' + nextCensHelp()),
        body: periodTableFull(s.periods, A.meta, { retail: s.retail.hasAmount, kpi: 'rev-periods' })
      });
      html += card({
        col: 'col-12', title: '月ごとの売上（実績＋予約）' , icon: 'yen', color: 'var(--cat-sales)', tag: moneyTag,
        sub: '濃い色＝会計済み（実績）、薄い色＝受付待ちの予約（見込み）' + help('月ごとの売上を、会計済み（実績・濃い色）と受付待ちの予約金額（見込み・薄い色）の積み上げで表示。棒の上の数字は合計（画面の幅に入りきらないときは、すべての棒の数字を小さくするか、まとめて省きます。棒に触れると金額が出ます）。'),
        body: chartBox('cRevenue', 260)
      });
      html += card({
        col: 'col-6', title: '売上の新規・既存' , icon: 'newcust', color: 'var(--cat-new)', tag: moneyTag,
        sub: '初回（新規）と2回目以降（既存）の内訳' + help('上の「月ごとの売上」を、そのお客様にとって初回（新規）か2回目以降（既存）かで分けたもの。実績と予約を合わせた予約ベースで、合計は上のグラフと一致します。'),
        body: chartBox('cRevMix', 240)
      });
      var lastConf = s.newMix.filter(function (x) { return x.m < A.meta.currentYm && x.new + x.repeat > 0; }).slice(-1)[0];
      html += card({
        col: 'col-6', title: '予約数（何回目か）', icon: 'reservations', color: 'var(--cat-visits)', tag: '件',
        sub: (lastConf ? monthJa(lastConf.m) + 'の再来比率 ' + pct(lastConf.repeat / (lastConf.new + lastConf.repeat) * 100, 0) + '（確定した月）。' : '') + '実績＋予約' +
          help('月ごとの来店・予約を、そのお客様にとって何回目か（新規／2回目／3回目／4回目以上）で積み上げ。会計済みの実績と受付待ちの予約を合わせた予約ベース。スタッフ別の棒を足し合わせた合計と一致します。再来比率は、集計途中の今月ではなく直近の確定した月の実績で出しています。'),
        body: chartBox('cNewMix', 240)
      });
      html += card({
        col: 'col-12', title: '客単価の推移' , icon: 'tag', color: 'var(--cat-spend)', tag: moneyTag,
        sub: '予約ベース（実績＋予約）と実績のみの2本' + help('予約ベース客単価＝（会計済み売上＋受付待ちの予約金額）÷（来店＋受付待ちの件数）。実績客単価＝会計済み売上 ÷ 来店件数。来店・予約の無い月は線を引きません。'),
        body: chartBox('cSpendTrend', 230)
      });
      var rt = s.retail;
      html += card({
        col: 'col-6', title: '店販（物販）' , icon: 'retail', color: 'var(--cat-retail)',
        sub: (rt.hasAmount ? '会計時店販金額から算出' : '商品名から購入率のみ算出') + help('店販売上比率＝売上に占める店販金額の割合。店販顧客比率＝来店されたお客様のうち店販を購入した人の割合（人ベース）。店販単価＝店販金額 ÷ 店販のあった会計数。'),
        body: '<div class="tiles">' +
          (rt.hasAmount ? tile({ icon: 'retail', color: 'var(--cat-retail)', label: '店販売上比率', kpi: 'retail-revenue-ratio', value: rt.revenueRatio != null ? pct(rt.revenueRatio * 100, 1) : '—' }) : '') +
          tile({ icon: 'person', color: 'var(--cat-retail)', label: '店販顧客比率', kpi: 'retail-customer-ratio', value: pct(rt.customerRatio * 100, 1), sub: F.int(rt.buyers) + '人 ÷ ' + F.int(rt.visitCustomers) + '人' }) +
          (rt.hasAmount ? tile({ icon: 'yen', color: 'var(--cat-retail)', label: '店販金額', kpi: 'retail-amount', value: yenHtml(rt.amount), sub: '全期間' }) +
            tile({ icon: 'tag', color: 'var(--cat-retail)', label: '店販単価', kpi: 'retail-avg-spend', value: yenHtml(rt.avgSpend), sub: F.int(rt.buyingVisits) + '件の会計' }) : '') +
          '</div>' +
          (rt.hasAmount ? '' : '<div class="note-inline" style="margin-top:12px">金額・売上比率・単価は、スプレッドシートに <b>「会計時店販金額」</b> 列を追加すると自動表示されます。</div>')
      });
      if (s.serviceRetailMonthly) {
        html += card({ col: 'col-6', title: '施術・店販の内訳' , icon: 'yen', color: 'var(--cat-retail)', tag: moneyTag, sub: '会計金額を施術と店販に分けた月次' + help('会計時合計金額から店販金額を差し引いたものを施術売上とみなし、月次で店販と積み上げ表示。'), body: chartBox('cServiceRetail', 230) });
      }
    } else if (seg === 'repeat') {
      var fLast = s.funnel[s.funnel.length - 1] || { n: 1 };
      html += card({
        col: 'col-5', title: '定着・リピート', icon: 'repeat', color: 'var(--cat-repeat)',
        sub: '来店されたお客様 ' + F.int(s.customers) + '人が母数。来店周期の中央値 <b>' + s.visitCycleMedianDays + '日</b>',
        body: '<div class="cell-list"><div id="mRepeat" data-kpi="repeat-rate"></div><div id="mNext" data-kpi="next-reserve-rate"></div><div id="mFix" data-kpi="fixation-rate"></div></div>'
      });
      html += card({
        col: 'col-7', title: 'リテンション ファネル', icon: 'repeat', color: 'var(--cat-repeat)',
        sub: '来店されたお客様 ' + s.customers + '人が母数（1回 → ' + fLast.n + '回' + (fLast.open ? '以上' : '') + ' 到達）' + help('各段の到達人数は<b>予約ベース</b>：集計基準日より後の受付待ちの予約も「到達」に数えます。ただし<b>実際に来店しなかった予約（キャンセル・無断キャンセル、基準日を過ぎても未処理のもの）は到達に数えません</b>。キャンセル後に別の予約を取り直していれば、その予約で到達とみなします。段の間の<b>継続率＝次の段の到達人数 ÷ その段の到達人数</b>で、棒の減り方そのものです。段の数はデータに応じて増え、予約ベースで一番多く到達している方の回数まで表示します（' + FUNNEL_CAP + '回を超える場合は「' + FUNNEL_CAP + '回以上」にまとめます）。なお定着カードの「固定化率」は分母が「実際に2回来店した人」なので、ここの2回→3回の継続率とは一致しません。'),
        body: '<div id="cFunnel"></div>'
      });
      html += card({
        col: 'col-6', title: '月ごとのリピート率（初回月別）', icon: 'repeat', color: 'var(--cat-repeat)', tag: '%',
        sub: '初回来店した月ごとの2回目到達　※印は集計途中の今月' + help('初回来店した月ごとにお客様をグループにし、そのうち何%が2回目の予約に到達したか。' + (A.meta.completedOnly ? '会計明細のみのデータでは将来の予約が見えないため、獲得から45日経っていない直近の月は表示しません。' : '予約ベースなので集計途中の今月（※印）も測定でき、月末までに多少上下します。') + '母数5人未満の月は表示しません。'),
        body: chartBox('cTCohortR', 230)
      });
      html += card({
        col: 'col-6', title: '月ごとのLTV（初回月別）' , icon: 'ltv', color: 'var(--cat-sales)', tag: moneyTag,
        sub: '初回来店した月ごとの1人あたり累計売上　※印は集計途中の今月' + help('初回来店した月ごとにお客様をグループにし、そのグループの現時点までの累計売上を平均したもの。新しい月ほど来店回数が少ないため低く出て、時間とともに積み上がります。'),
        body: chartBox('cTCohortL', 230)
      });
      html += card({ col: 'col-12', title: '来店回数の構成', icon: 'reservations', color: 'var(--cat-visits)', sub: '全期間の来店を、何回目の来店かで分けた件数と客単価' + help('全期間を通じて、来店回数（1回目・2回目・3回目・4回目以上）ごとの来店件数と、その回数における平均客単価。'), body: '<div id="cVisitComp"></div>' });
    } else {
      html += card({
        col: 'col-12', title: '曜日別', icon: 'reservations', color: 'var(--cat-visits)',
        sub: '来店の多い曜日と、次回予約・客単価・LTV の曜日差' + help('曜日ごとに来店数・次回予約率・客単価・LTVを集計。次回予約率はその曜日の来店のうち次の予約・来店があった割合。LTVはその曜日に初回来店したお客様の累計売上の平均。'),
        body: '<div class="segmented" id="dowSeg" role="group" aria-label="曜日別に表示する指標" style="margin-bottom:6px">' +
          [['visits', '来店数'], ['nextRes', '次回予約率'], ['spend', '客単価'], ['ltv', 'LTV']].map(function (o) { return '<button type="button" data-m="' + o[0] + '" aria-pressed="' + (o[0] === trendMetric ? 'true' : 'false') + '"' + (o[0] === trendMetric ? ' class="active"' : '') + '>' + o[1] + '</button>'; }).join('') +
          '<span class="seg-thumb" id="dowThumb"></span></div>' + chartBox('cDow', 250)
      });
      html += card({
        col: 'col-12', title: '時間帯 × 曜日', icon: 'clock', color: 'var(--cat-new)',
        sub: '来店の多い時間帯（数字は来店件数）' + (A.meta.completedOnly ? '（会計時刻ベース）' : '') + help('来店時刻（予約データがあれば来店開始時間、無ければ会計時刻）を9〜20時の範囲に集計した来店件数。'),
        body: chartBox('cHourDow', 0)
      });
    }

    mount('overview', head + '<div class="grid">' + html + '</div>');
    wireSeg('storeSeg', function (k) { state.storeSeg = k; renderAll(); });

    if (seg === 'sales') {
      draw('cRevenue', function (el) {
        C.columns(el, {
          groups: s.monthly.map(function (x) { return monthShort(x.m); }), stacked: true,
          series: [
            { name: '実績（会計済み）', color: cvar('--series-1'), values: s.monthly.map(function (x) { return x.revActual; }) },
            { name: '予約（受付待ち）', color: cvar('--funnel-2'), values: s.monthly.map(function (x) { return x.revExpected; }) }
          ],
          valueFmt: function (v) { return yen(Math.round(v)); }, totalFmt: F.compact, yFmt: F.compact, height: 260
        });
      });
      draw('cRevMix', function (el) {
        var rm = s.revenueMix || [];
        C.columns(el, {
          groups: rm.map(function (x) { return monthShort(x.m); }), stacked: true,
          series: [
            { name: '新規', color: cvar('--series-6'), values: rm.map(function (x) { return x.newActual + x.newExpected; }) },
            { name: '既存', color: cvar('--funnel-4'), values: rm.map(function (x) { return x.repeatActual + x.repeatExpected; }) }
          ],
          valueFmt: function (v) { return yen(v); }, totalFmt: F.compact, yFmt: F.compact, height: 240
        });
      });
      draw('cNewMix', function (el) {
        var comp = s.newMix.map(function (x) { return s.composition.filter(function (y) { return y.m === x.m; })[0] || { expNew: 0, expV2: 0, expV3: 0, expV4: 0 }; });
        C.columns(el, {
          groups: s.newMix.map(function (x) { return monthShort(x.m); }), stacked: true,
          series: [
            { name: '新規', color: cvar('--funnel-2'), values: s.newMix.map(function (x, i) { return x.new + comp[i].expNew; }) },
            { name: '2回目', color: cvar('--funnel-3'), values: s.newMix.map(function (x, i) { return x.v2 + comp[i].expV2; }) },
            { name: '3回目', color: cvar('--funnel-4'), values: s.newMix.map(function (x, i) { return x.v3 + comp[i].expV3; }) },
            { name: '4回目以上', color: cvar('--funnel-5'), values: s.newMix.map(function (x, i) { return x.v4 + comp[i].expV4; }) }
          ],
          valueFmt: function (v) { return v + '件'; }, height: 240
        });
      });
      draw('cSpendTrend', function (el) {
        C.lineArea(el, {
          xLabels: s.monthly.map(function (x) { return monthShort(x.m); }), area: false,
          series: [
            { name: '予約ベース客単価', color: cvar('--series-1'), endLabel: false, values: s.monthly.map(function (x) { return x.res ? x.spend : null; }) },
            { name: '実績客単価', color: cvar('--series-4'), endLabel: false, values: s.monthly.map(function (x) { return x.spendActual; }) }
          ],
          valueFmt: yen, yFmt: F.compact, height: 230
        });
      });
      if (s.serviceRetailMonthly) {
        draw('cServiceRetail', function (el) {
          var srm = s.serviceRetailMonthly;
          C.columns(el, {
            groups: srm.map(function (x) { return monthShort(x.m); }), stacked: true,
            series: [
              { name: '施術', color: cvar('--series-1'), values: srm.map(function (x) { return x.service; }) },
              { name: '店販', color: cvar('--series-5'), values: srm.map(function (x) { return x.retail; }) }
            ],
            valueFmt: function (v) { return yen(Math.round(v)); }, totalFmt: F.compact, yFmt: F.compact, height: 230
          });
        });
      }
    } else if (seg === 'repeat') {
      var G = A.meta.guide || { repeat: 0.7, fix: 0.6 };
      draw('mRepeat', function (el) { C.meter(el, { label: 'リピート率（2回目到達）', help: '来店されたお客様のうち、2回目の予約（来店・今後の予約を含む）に到達した人の割合。キャンセルのみで次の予約が入っていない場合は到達扱いにせず、キャンセル後に別の予約を取っていれば到達として数えます。', value: s.repeatRate / 100, display: pct(s.repeatRate), target: G.repeat, sub: frac(s.repeatNumer, s.repeatDenom, '人') + ' ・ 目安 ' + pct(G.repeat * 100, 0) }); });
      draw('mNext', function (el) { C.meter(el, { label: '次回予約取得率', help: '来店（会計済み）のうち、その後に何らかの予約・来店（キャンセルは除く）があった割合。来店ごとに1件として集計。', value: s.nextReserveRate / 100, display: pct(s.nextReserveRate), sub: frac(s.nextReserveNumer, s.nextReserveDenom, '件') }); });
      draw('mFix', function (el) { C.meter(el, { label: '固定化率（3回目到達）', help: '分母は「実際に2回来店したお客様」、分子は「そのうち3回目の予約に到達したお客様」（受付待ちを含み、キャンセルは数えず、キャンセル後に取り直せば数える）。「2回目まで来てくれた方が、その来店で次を取れたか」という接客の成果を測る指標で、リピート率とは分母の基準が異なります。', value: s.fixationRate / 100, display: pct(s.fixationRate), target: G.fix, sub: frac(s.fixNumer, s.fixDenom, '人') + ' ・ 目安 ' + pct(G.fix * 100, 0) }); });
      draw('cFunnel', function (el) {
        C.funnel(el, {
          stages: s.funnel.map(function (f) {
            var reachTxt = (f.reach > 0 && f.reach < 0.005) ? '1%未満' : pct(f.reach * 100, 0);
            return { label: f.n + '回' + (f.open ? '以上' : ''), value: f.people, sub: reachTxt + ' 到達', cont: f.cont, contNum: f.contNum, contDen: f.contDen };
          })
        });
      });
      var cohortLabel = function (c) { return monthShort(c.m) + (c.partial ? '※' : ''); };
      draw('cTCohortR', function (el) {
        C.lineArea(el, { xLabels: t.monthlyCohort.map(cohortLabel), yMax: 100, series: [{ name: 'リピート率', color: cvar('--cat-repeat'), endLabel: false, values: t.monthlyCohort.map(function (c) { return c.repeat * 100; }) }],
          refLines: [{ value: G.repeat * 100, label: '目安 ' + pct(G.repeat * 100, 0), color: cvar('--ink-muted') }],
          valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230 });
      });
      draw('cTCohortL', function (el) {
        C.columns(el, { groups: t.monthlyCohort.map(cohortLabel), series: [{ name: 'LTV', color: cvar('--series-4'), values: t.monthlyCohort.map(function (c) { return c.ltv; }) }], valueFmt: yen, totalFmt: F.compact, yFmt: F.compact, height: 230 });
      });
      draw('cVisitComp', function (el) {
        C.hbars(el, {
          items: s.visitCountBreakdown.map(function (b, i) { return { label: b.label, value: b.count, sub: '客単価 ' + yen(b.spend), color: cvar(['--funnel-2', '--funnel-3', '--funnel-4', '--funnel-5'][i]) }; }),
          valueFmt: function (v) { return F.int(v) + '件'; }
        });
      });
    } else {
      draw('cHourDow', function (el) {
        C.heatmap(el, { matrix: t.hourDow, rowLabels: ['月', '火', '水', '木', '金', '土', '日'], colLabels: t.hourLabels, hue: cvar('--seq-5'), unit: '件' });
      });
      var dseg = $('#dowSeg');
      dseg.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        trendMetric = b.dataset.m;
        Array.prototype.forEach.call(dseg.querySelectorAll('button'), function (x) { var on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
        placeThumb(dseg); drawDow(); flush();
      });
      placeThumb(dseg);
      drawDow();
    }
    flush();
  }

  function heroMetric(v, unit, label, isYen, dataKpi) {
    return '<div class="hero-metric"' + (dataKpi ? ' data-kpi="' + dataKpi + '"' : '') + '><b>' + (isYen ? '¥' : '') + v + (unit && !isYen ? '<span style="font-size:.55em;opacity:.7"> ' + unit + '</span>' : '') + '</b><span>' + label + '</span></div>';
  }
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

  // ============================ STAFF ======================================
  // 上部のセグメントでスタッフを選ぶ（この端末の「あなた」が既定）。「比較」では
  // 全員を同じ物差し（直近3ヶ月）で並べる。以前は1枚のカードに「全期間（集計途中の
  // 今月を含む）」と「直近3ヶ月」の数字が同じラベルで混在し、同じ「平均来店/月」が
  // 40件と75件のように食い違って見えていた。ここでは期間を必ず見出しに書く。
  function renderStaff() {
    var A = state.analytics, names = A.meta.staffNames;
    var sel = state.staffSel;
    if (sel !== '__compare' && names.indexOf(sel) === -1) sel = currentMe() || '__compare';
    state.staffSel = sel;
    var segItems = names.map(function (n) { return [n, n]; }).concat([['__compare', '比較']]);
    var head = '<div class="view-title">スタッフ</div><div class="view-lead">' +
      (sel === '__compare' ? 'スタッフの数字を同じ物差し（直近3ヶ月）で並べています。' : esc(sel) + ' の数字です。期間はそれぞれの見出しに書いてあります。') +
      taxLead() + dataStamp() + '</div>' + segControl('staffSeg', segItems, sel, '表示するスタッフ', true);
    if (sel === '__compare') renderStaffCompare(A, head);
    else renderStaffOne(A, head, A.staff.filter(function (x) { return x.name === sel; })[0]);
    wireSeg('staffSeg', function (k) { state.staffSel = k; renderAll(); });
  }

  function staffMeter(id, st, kind, G) {
    draw(id, function (el) {
      var isRep = kind === 'repeat';
      var num = isRep ? st.reach2Num : st.fixNumer, den = isRep ? st.reachDen : st.fixDenom;
      var shown = den >= MIN_DEN;
      var val = den ? num / den : 0;
      C.meter(el, {
        label: isRep ? 'リピート率（2回目到達）' : '固定化率（3回目到達）',
        help: isRep
          ? 'このスタッフが直近3ヶ月（今月を含まない）に初回担当したお客様のうち、2回目の予約（来店・今後の予約を含む）に到達した人の割合。キャンセルのみで次の予約が無い場合は到達に数えず、取り直していれば数えます。対象が5人未満のあいだは率を出しません。'
          : '分母は「このスタッフが直近3ヶ月に初回担当し、実際に2回来店したお客様」、分子は「そのうち3回目の予約に到達したお客様」（受付待ちを含み、キャンセルは数えず、取り直せば数える）。対象が5人未満のあいだは率を出しません（1人の結果で0%や100%になるため）。',
        value: shown ? val : 0, display: shown ? pct(val * 100) : '—', color: staffColor(st.name),
        target: isRep ? G.repeat : G.fix,
        sub: (den ? frac(num, den, '人') : (isRep ? '対象のお客様がまだいません' : '2回来店したお客様がまだいません')) + (den && !shown ? '（5人未満のため率は出しません）' : '') + ' ・ 目安 ' + pct((isRep ? G.repeat : G.fix) * 100, 0)
      });
    });
  }

  function renderStaffOne(A, head, st) {
    var name = st.name, color = staffColor(name), s = A.store, m = st.month;
    var G = A.meta.guide || { repeat: 0.7, fix: 0.6 };
    var months = A.store.monthly.map(function (x) { return monthShort(x.m); });
    var moneyTag = A.meta.taxExcluded ? '税抜' : '税込';   // 金額のグラフの右上に出す税区分
    var regMile = milestoneProgress(st.regulars3, MILESTONES.regulars);
    var share = s.month.cur.rev > 0 ? m.cur.rev / s.month.cur.rev : null;
    var html = '';
    html += '<div class="col-12"><div class="hc"><div class="staff-head"><div class="staff-avatar" style="background:' + color + '">' + esc(name[0].toUpperCase()) + '</div>' +
      '<div class="staff-name">' + esc(name) + '<span>担当した月 <b>' + st.avg.months + 'ヶ月</b> ・ 初回担当 <b>' + F.int(st.acquired) + '人</b> ・ ' +
      '育てた常連' + help(REGULARS_HELP) + ' <b data-kpi="staff-' + esc(name) + '-regulars3">' + F.int(st.regulars3) + '人</b>' + (regMile.maxed ? '' : '（次の節目 ' + F.int(regMile.next) + '人）') +
      (A.meta.completedOnly ? ' ・ 成熟母数 ' + st.matureAcquired + '人' : '') + '</span></div></div></div></div>';
    html += '<div class="col-12">' + secH('今月', esc(mdJa(m.ym, 1) + '〜' + mdJa(m.ym, m.day))) + '<div class="home-cols"><div class="stack">' +
      monthCard(m, { id: 'sMe', who: name, title: esc(name) + ' の売上（実績）', icon: 'person', color: staffVar(name), share: share, kpi: 'staff-' + name + '-month',
        helpText: 'このスタッフが担当した今月1日〜集計基準日までの会計済み売上（実績）。「先月の同じ時期」は先月の1日〜同じ日まで。「予約込み」は今月これから来店予定の受付待ちの予約金額を足したもの。' }) +
      '</div><div class="stack">' + monthTiles(m, 'staff-' + name) +
      '<div class="next-hint" data-kpi="staff-' + esc(name) + '-next-hint">' + growthText(st) + '</div>' + bestHighlight(st) + '</div></div></div>';
    html += card({
      col: 'col-12', title: '月ごとの数字' , icon: 'yen', color: color,
      sub: '会計済み（実績）だけで比べています。直近3ヶ月＝今月を含まない確定3ヶ月の月平均（担当のあった月数で割る）。今月は集計途中です。' + help('「売上」の直近3ヶ月は月平均、先月・今月はその月の合計。「1日あたりの売上」は売上 ÷ 担当した営業日（会計が1件以上あった日）。「客単価」は会計済み売上 ÷ 来店件数。「次回予約率」は来店のうち、その後の予約（受付待ちを含む・キャンセルは除く）が入っている割合で、5件未満の期間は率を出しません。' + nextCensHelp()),
      body: periodTableFull(st.periods, A.meta, { retail: A.store.retail.hasAmount, kpi: 'staff-' + name + '-rev-periods' })
    });
    var lm = A.meta.last3Months || [];
    html += card({
      col: 'col-6', title: '定着（リピート・常連化）', icon: 'repeat', color: 'var(--cat-repeat)',
      sub: '直近3ヶ月' + (lm.length ? '（' + monthJa(lm[0]) + '〜' + monthJa(lm[lm.length - 1]) + '）' : '') + 'に初回担当したお客様が対象' +
        (A.meta.completedOnly ? '。会計明細だけのデータでは「これからの予約」が見えないため、最近のお客様の分だけ実際より低く出ます' : ''),
      body: '<div class="cell-list"><div id="stMeterRepeat"></div><div id="stMeterFix"></div></div>'
    });
    html += card({ col: 'col-6', title: '自己ベスト・自分の推移', icon: 'star', color: 'var(--cat-repeat)', sub: '他のスタッフとは比べず、自分の過去と比べます', body: personalBestBlock(st) + sgPanel(st) });
    html += card({ col: 'col-6', title: '月ごとの予約数（何回目か）', icon: 'reservations', color: color, tag: '件', sub: '実績＋予約。濃いほど回数の多いお客様' + help('月ごとの来店・予約を、そのお客様にとって何回目か（新規／2回目／3回目／4回目以上）で積み上げ。会計済みの実績と受付待ちの予約を合わせた予約ベース。'), body: chartBox('cOneRes', 240) });
    html += card({ col: 'col-6', title: '月ごとの売上（実績＋予約）' , icon: 'yen', color: color, tag: moneyTag, sub: '濃い色＝実績、薄い色＝受付待ちの予約', body: chartBox('cOneRev', 240) });
    html += card({ col: 'col-6', title: '客単価の推移', icon: 'tag', color: 'var(--cat-spend)', tag: moneyTag, sub: esc(name) + '（色）とお店全体（灰色）' + help('月ごとの客単価（予約ベース＝（実績＋予約）÷ 件数）。灰色の線はお店全体の同じ指標で、比べる目安として表示しています。'), body: chartBox('cOneSpend', 230) });
    html += card({ col: 'col-6', title: '次回予約率の推移', icon: 'repeat', color: 'var(--cat-repeat)', tag: '%', sub: esc(name) + '（色）とお店全体（灰色）。来店5件未満の月は表示しません' + (A.meta.completedOnly ? '　※直近の月は再来待ちのため表示しません' : '') + help('来店（会計済み）のうち、その後に何らかの予約・来店があった割合の月次推移。' + (A.meta.completedOnly ? '会計明細だけのデータでは、月末から30日経っていない月は再来待ちのため表示しません。' : '集計途中の今月も含みます。') + '灰色の線はお店全体。'), body: chartBox('cOneNext', 230) });
    html += card({ col: 'col-12', title: '月ごとのリピート率・固定化率（初回月別）', icon: 'repeat', color: 'var(--cat-repeat)', tag: '%',
      sub: '初回担当した月ごとのお客様が、2回目・3回目に到達した割合　※印は集計途中の今月' + help('初回来店した月ごとに、このスタッフが担当した新規のお客様を母数として、リピート率＝2回目の予約に到達した割合、固定化率＝実際に2回来店した方のうち3回目の予約に到達した割合。母数5人未満の月と、固定化率の母数が育つ前の直近の月（月末から来店周期の中央値・最低30日）は表示しません。'),
      body: chartBox('cOneCohort', 230) });
    if (A.store.retail.hasAmount) html += card({ col: 'col-6', title: '店販売上の推移' , icon: 'retail', color: 'var(--cat-retail)', tag: moneyTag, body: chartBox('cOneRetail', 220) });
    if (st.utilization) html += card({ col: 'col-6', title: '施術時間の稼働率', icon: 'clock', color: 'var(--cat-new)', tag: '%', sub: '施術時間 ÷（施術のあった日数 × 8時間）。確定した月のみ' + help('稼働率＝施術時間の合計 ÷ 稼働可能時間（実際に施術のあった日数 × 1日8時間）。進行中の今月・未来の月は表示しません。予約データに所要時間の記録がある場合のみ算出します。'), body: chartBox('cOneUtil', 220) });

    mount('staff', head + '<div class="grid">' + html + '</div>');
    drawMonthCard(m, { id: 'sMe', who: name, color: color, ringColor: color });
    staffMeter('stMeterRepeat', st, 'repeat', G);
    staffMeter('stMeterFix', st, 'fix', G);
    draw('cOneRes', function (el) {
      var cp = st.composition;
      C.columns(el, {
        groups: months, stacked: true, hideLegend: false,
        series: [
          { name: '新規', color: staffTierColor(name, 0), values: cp.map(function (x) { return x.new + x.expNew; }) },
          { name: '2回目', color: staffTierColor(name, 1), values: cp.map(function (x) { return x.v2 + x.expV2; }) },
          { name: '3回目', color: staffTierColor(name, 2), values: cp.map(function (x) { return x.v3 + x.expV3; }) },
          { name: '4回目以上', color: staffTierColor(name, 3), values: cp.map(function (x) { return x.v4 + x.expV4; }) }
        ],
        valueFmt: function (v) { return v + '件'; }, height: 240
      });
    });
    draw('cOneRev', function (el) {
      C.columns(el, {
        groups: months, stacked: true,
        series: [
          { name: '実績（会計済み）', color: color, values: st.monthly.map(function (x) { return x.revActual; }) },
          { name: '予約（受付待ち）', color: staffTierColor(name, 0), values: st.monthly.map(function (x) { return x.rev - x.revActual; }) }
        ],
        valueFmt: function (v) { return yen(Math.round(v)); }, totalFmt: F.compact, yFmt: F.compact, height: 240
      });
    });
    draw('cOneSpend', function (el) {
      C.lineArea(el, { xLabels: months, area: false, valueFmt: yen, yFmt: F.compact, height: 230, series: [
        { name: name, color: color, endLabel: false, values: st.monthly.map(function (x) { return x.res ? x.spend : null; }) },
        { name: 'お店全体', color: cvar('--series-7'), faded: true, values: A.store.monthly.map(function (x) { return x.res ? x.spend : null; }) }
      ] });
    });
    draw('cOneNext', function (el) {
      C.lineArea(el, { xLabels: months, area: false, yMax: 100, valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230, series: [
        { name: name, color: color, endLabel: false, values: st.monthly.map(function (x) { return x.nextRes == null || x.visN < MIN_DEN ? null : x.nextRes * 100; }) },
        { name: 'お店全体', color: cvar('--series-7'), faded: true, values: A.store.monthly.map(function (x) { return x.nextRes == null || x.actual < MIN_DEN ? null : x.nextRes * 100; }) }
      ] });
    });
    draw('cOneCohort', function (el) {
      var rf = st.repeatFixMonthly;
      C.lineArea(el, { xLabels: rf.map(function (x) { return monthShort(x.m) + (x.partial ? '※' : ''); }), area: false, yMax: 100,
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230,
        refLines: [{ value: G.repeat * 100, label: '目安 ' + pct(G.repeat * 100, 0), color: cvar('--ink-muted') }],
        series: [
          { name: 'リピート率', color: color, endLabel: false, values: rf.map(function (x) { return x.repeat == null ? null : x.repeat * 100; }) },
          { name: '固定化率', color: cvar('--cat-repeat'), endLabel: false, values: rf.map(function (x) { return x.fix == null ? null : x.fix * 100; }) }
        ] });
    });
    if (A.store.retail.hasAmount) draw('cOneRetail', function (el) {
      C.columns(el, { groups: months, series: [{ name: '店販売上', color: cvar('--cat-retail'), values: st.monthly.map(function (x) { return x.retailAmount || 0; }) }], valueFmt: function (v) { return yen(Math.round(v)); }, totalFmt: F.compact, yFmt: F.compact, height: 220 });
    });
    if (st.utilization) draw('cOneUtil', function (el) {
      var u = st.utilization, last = -1;
      u.forEach(function (x, i) { if (x.rate != null) last = i; });
      C.columns(el, { groups: months.slice(0, last + 1), yMax: 100, series: [{ name: '稼働率', color: color, values: u.slice(0, last + 1).map(function (x) { return x.rate == null ? null : x.rate * 100; }) }],
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 220 });
    });
    flush();
  }

  function renderStaffCompare(A, head) {
    var staff = A.staff, months = A.store.monthly.map(function (m) { return monthShort(m.m); });
    var moneyTag = A.meta.taxExcluded ? '税抜' : '税込';
    var html = '';
    var pctOrDash = function (v, d) { return v == null || !isFinite(v) ? '—' : pct(v * 100, d); };
    var yenOrDash = function (v) { return v == null ? '—' : yen(v); };
    var vsMetrics = [
      { label: '来店 / 月', help: '直近3ヶ月のうち、担当のあった月ごとの来店件数の平均。', fmt: function (st) { return st.periods.last3.visits ? F.int(st.periods.last3.visitsPerMonth) + '件' : '—'; } },
      { label: '売上 / 月', help: '直近3ヶ月の会計済み売上を、担当のあった月数で割った月平均。', fmt: function (st) { return yenOrDash(st.revPeriods.last3.monthly); } },
      { label: '1日あたり売上', help: '直近3ヶ月の会計済み売上 ÷ 営業日（会計が1件以上あった日数）。', fmt: function (st) { return yenOrDash(st.revPeriods.last3.daily); } },
      { label: '客単価', help: '直近3ヶ月の会計済み売上の合計 ÷ 来店件数の合計（件数で重み付けした平均）。', fmt: function (st) { return st.periods.last3.spend == null ? '—' : yen(st.periods.last3.spend); },
        sub: function (st) { return st.periods.last3.visits ? yenCompact(st.periods.last3.rev) + ' ÷ ' + F.int(st.periods.last3.visits) + '件' : ''; } },
      { label: 'リピート率（2回目到達）', help: 'このスタッフが直近3ヶ月に初回担当したお客様のうち、2回目の予約（来店・今後の予約を含む）に到達した人の割合。対象5人未満は率を出しません。',
        fmt: function (st) { return st.reachDen >= MIN_DEN ? pctOrDash(st.reach2) : '—'; },
        sub: function (st) { return st.reachDen ? frac(st.reach2Num, st.reachDen, '人') : ''; } },
      { label: '次回予約率', help: '直近3ヶ月に担当した来店のうち、その後の予約・来店があった割合（件数で重み付け）。対象5件未満は率を出しません。' + nextCensHelp(),
        fmt: function (st) { return st.periods.last3.nextDen >= MIN_DEN ? pctOrDash(st.periods.last3.nextRate) : '—'; },
        sub: function (st) { var b = st.periods.last3; return b.nextDen ? frac(b.nextNum, b.nextDen, '件') + (b.nextCensored ? '（直近の月を除く）' : '') : (b.nextCensored ? '再来待ち' : ''); } },
      { label: '固定化率（3回目到達）', help: '分母は「直近3ヶ月に初回担当し、実際に2回来店したお客様」、分子は「そのうち3回目の予約に到達したお客様」。対象5人未満は率を出しません。',
        fmt: function (st) { return st.fixDenom >= MIN_DEN ? pctOrDash(st.fixationRate) : '—'; },
        sub: function (st) { return st.fixDenom ? frac(st.fixNumer, st.fixDenom, '人') : ''; } },
      { label: '店販顧客比率', help: '直近3ヶ月に担当した来店のお客様のうち、店販を購入した人の割合。対象5人未満は率を出しません。', fmt: function (st) { return st.avgRecent.retailVisitCustomers >= MIN_DEN ? pctOrDash(st.avgRecent.retailCustomerRatio, 1) : '—'; },
        sub: function (st) { return st.avgRecent.retailVisitCustomers ? frac(st.avgRecent.retailBuyers, st.avgRecent.retailVisitCustomers, '人') : ''; } }
    ];
    // 4人以上だと1画面に収めると数字が潰れるため、表を横にスクロールさせ、左の項目名の列は固定する
    var vs = '<div class="table-wrap"><table class="vs-table' + (staff.length > 3 ? ' many' : '') + '"><thead><tr><th></th>' +
      staff.map(function (st) { return '<th><i class="vs-dot" style="background:' + staffColor(st.name) + '"></i>' + esc(st.name) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      vsMetrics.map(function (mt) {
        return '<tr><td>' + mt.label + (mt.help ? help(mt.help) : '') + '</td>' + staff.map(function (st) {
          var sub = mt.sub ? mt.sub(st) : '';
          return '<td><b>' + mt.fmt(st) + '</b>' + (sub ? '<span class="vs-frac">' + sub + '</span>' : '') + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
    var lm = A.meta.last3Months || [];
    html += card({ col: 'col-12', title: 'スタッフ比較（直近3ヶ月）', icon: 'staff', color: 'var(--cat-store)',
      sub: (lm.length ? monthJa(lm[0]) + '〜' + monthJa(lm[lm.length - 1]) + '（今月を含まない確定した月）の数字。' : '') + '下段は「分子 ÷ 分母」' + help('すべて直近3ヶ月（今月を含まない確定3ヶ月）の数字です。率は件数で重み付けした平均で、対象が5人（件）未満の率は1人の結果で大きく振れるため「—」にしています。'),
      body: vs });

    html += card({ col: 'col-12', title: '月ごとの予約数（何回目か）', icon: 'reservations', color: 'var(--cat-visits)', tag: '件', sub: '色＝スタッフ、濃さ＝来店回数（新規→4回目以上）。実績＋予約', body: chartBox('cStaffRes', 250) });
    html += card({ col: 'col-6', title: '月ごとの売上（実績＋予約）', icon: 'yen', color: 'var(--cat-sales)', tag: moneyTag, body: chartBox('cStaffRev', 240) });
    html += card({ col: 'col-6', title: '客単価の推移', icon: 'tag', color: 'var(--cat-spend)', tag: moneyTag, body: chartBox('cStaffSpend', 230) });
    html += card({ col: 'col-6', title: '次回予約率の推移', icon: 'repeat', color: 'var(--cat-repeat)', tag: '%', sub: '来店5件未満の月は表示しません' + (A.meta.completedOnly ? '　※直近の月は再来待ちのため表示しません' : ''), body: chartBox('cStaffNext', 230) });
    html += card({ col: 'col-6', title: '月ごとのリピート率（初回月別）', icon: 'repeat', color: 'var(--cat-repeat)', tag: '%', sub: '※印は集計途中の今月・母数5人未満の月は非表示', body: chartBox('cStaffRepeatRate', 230) });
    if (A.store.retail.hasAmount) html += card({ col: 'col-6', title: '店販売上の推移', icon: 'retail', color: 'var(--cat-retail)', tag: moneyTag, body: chartBox('cStaffRetail', 230) });
    if (staff.some(function (st) { return st.utilization; })) html += card({ col: 'col-6', title: '施術時間の稼働率', icon: 'clock', color: 'var(--cat-new)', tag: '%', sub: '確定した月のみ', body: chartBox('cStaffUtil', 230) });

    mount('staff', head + '<div class="grid">' + html + '</div>');

    var activeMonths = A.store.monthly.filter(function (m) {
      return staff.some(function (st) { var x = st.monthly.filter(function (y) { return y.m === m.m; })[0]; return x && x.res; });
    });
    var resGroups = activeMonths.map(function (m) { return monthShort(m.m); });
    var resData = { new: [], v2: [], v3: [], v4: [] }, resSubLabels = [], resSubColors = [];
    activeMonths.forEach(function (m) {
      staff.forEach(function (st) {
        var cp = st.composition.filter(function (x) { return x.m === m.m; })[0] || { new: 0, v2: 0, v3: 0, v4: 0, expNew: 0, expV2: 0, expV3: 0, expV4: 0 };
        resData.new.push(cp.new + cp.expNew); resData.v2.push(cp.v2 + cp.expV2); resData.v3.push(cp.v3 + cp.expV3); resData.v4.push(cp.v4 + cp.expV4);
        resSubLabels.push(st.name); resSubColors.push(staffColor(st.name));
      });
    });
    draw('cStaffRes', function (el) {
      function tierColor(tier) { return function (bi) { return staffTierColor(resSubLabels[bi], tier); }; }
      C.columnClusters(el, {
        groups: resGroups, clusterSize: staff.length, subLabels: resSubLabels, subColors: resSubColors,
        series: [
          { name: '新規', color: tierColor(0), values: resData.new },
          { name: '2回目', color: tierColor(1), values: resData.v2 },
          { name: '3回目', color: tierColor(2), values: resData.v3 },
          { name: '4回目以上', color: tierColor(3), values: resData.v4 }
        ],
        valueFmt: function (v) { return v + '件'; }, hideLegend: true, height: 250
      });
    });
    draw('cStaffRev', function (el) { C.columns(el, { groups: months, series: staff.map(function (st) { return { name: st.name, color: staffColor(st.name), values: st.monthly.map(function (m) { return m.rev; }) }; }), valueFmt: function (v) { return yen(v); }, totalFmt: F.compact, yFmt: F.compact, height: 240 }); });
    draw('cStaffSpend', function (el) { C.lineArea(el, { xLabels: months, area: false, series: staff.map(function (st) { return { name: st.name, color: staffColor(st.name), values: st.monthly.map(function (m) { return m.spend; }) }; }), valueFmt: yen, yFmt: F.compact, height: 230 }); });
    draw('cStaffNext', function (el) {
      C.lineArea(el, { xLabels: months, area: false, yMax: 100,
        series: staff.map(function (st) { return { name: st.name, color: staffColor(st.name), values: st.monthly.map(function (m) { return m.nextRes == null || m.visN < MIN_DEN ? null : m.nextRes * 100; }) }; }),
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230 });
    });
    var cohortXLabels = staff.length ? staff[0].repeatFixMonthly.map(function (m) { return monthShort(m.m) + (m.partial ? '※' : ''); }) : months;
    draw('cStaffRepeatRate', function (el) {
      C.lineArea(el, { xLabels: cohortXLabels, area: false, yMax: 100,
        series: staff.map(function (st) { return { name: st.name, color: staffColor(st.name), values: st.repeatFixMonthly.map(function (m) { return m.repeat == null ? null : m.repeat * 100; }) }; }),
        valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230 });
    });
    if (A.store.retail.hasAmount) draw('cStaffRetail', function (el) {
      C.columns(el, { groups: months, series: staff.map(function (st) { return { name: st.name, color: staffColor(st.name), values: st.monthly.map(function (m) { return m.retailAmount || 0; }) }; }), valueFmt: function (v) { return yen(Math.round(v)); }, totalFmt: F.compact, yFmt: F.compact, height: 230 });
    });
    if (staff.some(function (st) { return st.utilization; })) {
      var utilStaff = staff.filter(function (st) { return st.utilization; }), utilLast = -1;
      utilStaff.forEach(function (st) { st.utilization.forEach(function (u, mi) { if (u.rate != null && mi > utilLast) utilLast = mi; }); });
      var utilMonths = A.store.monthly.slice(0, utilLast + 1).map(function (m) { return monthShort(m.m); });
      draw('cStaffUtil', function (el) {
        C.columns(el, { groups: utilMonths, yMax: 100,
          series: utilStaff.map(function (st) { return { name: st.name, color: staffColor(st.name), values: st.utilization.slice(0, utilLast + 1).map(function (u) { return u.rate == null ? null : u.rate * 100; }) }; }),
          valueFmt: function (v) { return v.toFixed(0) + '%'; }, yFmt: function (v) { return v.toFixed(0) + '%'; }, height: 230 });
      });
    }
    flush();
  }

  // 自分の推移: 確定した月（今月を除く）を前半・後半に分けて比べる（他スタッフとは比べない）。
  // 計算は engine（staff.selfGrowth）。客単価・次回予約率は件数で重み付けした平均で、
  // 来店5件未満の月は除く。以前は月ごとの値を単純平均していたため、来店1件の月が
  // 大きな月と同じ重みになり、同じ画面の「月ごとの数字」（件数で重み付け）と食い違った。
  function sgRow(label, g, fmt, foot, helpText) {
    var labelHtml = label + (helpText ? help(helpText) : '');
    if (!g) return '<div class="sg-row"><span>' + labelHtml + '</span><b class="sg-na">データを集めています</b></div>';
    var arrow = g.dir === 'up' ? '↑ 上向き' : g.dir === 'down' ? '↓ 下向き' : '→ 横ばい';
    return '<div class="sg-row"><span>' + labelHtml + '<small class="sg-foot">' + monthJa(g.first) + '〜' + monthJa(g.last) + '・' + F.int(g.months) + 'ヶ月' + (foot ? '・' + foot(g) : '') + '</small></span>' +
      '<b>平均 ' + fmt(g.avg) + '</b><em class="sg-' + g.dir + '">' + arrow + '</em></div>';
  }
  function sgPanel(st) {
    var sg = st.selfGrowth || {};
    var base = '確定した月（今月を除く）を前半と後半に分け、それぞれの平均を比べた向き（±3%未満は横ばい）。月数が奇数のときは真ん中の月を比べません。他のスタッフとの比較ではなく、本人の過去との比較です。';
    return '<div class="self-growth"><div class="sg-title">自分の推移</div>' +
      sgRow('客単価', sg.spend, function (v) { return yen(Math.round(v)); }, function (g) { return F.int(g.den) + '件'; },
        base + '「平均」は対象の月の会計済み売上の合計 ÷ 来店件数の合計（件数で重み付け）。来店5件未満の月は、1〜2件の会計で大きく振れるため除きます。') +
      sgRow('来店 / 月', sg.visits, function (v) { return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') + '件'; }, null,
        base + '「平均」は確定した月ごとの来店件数の平均。') +
      sgRow('次回予約率', sg.nextRes, function (v) { return pct(v * 100, 0); }, function (g) { return F.int(g.num) + '/' + F.int(g.den) + '件'; },
        base + '「平均」は対象の月の「次の予約があった来店」の合計 ÷ 来店件数の合計（件数で重み付け）。来店5件未満の月と、会計明細のみで再来待ちの月は除きます。') +
      '</div>';
  }
  // 自己ベスト（確定した月の最高記録。自分の過去と比べるだけで他スタッフとは比べない）
  function personalBestBlock(st) {
    var pb = st.personalBest;
    if (pb.confirmedMonths < 2) {
      return '<div class="sg-title">自己ベスト</div><div class="empty-note">記録を集めています。確定した月が2ヶ月分たまると表示されます。</div>';
    }
    function cell(label, best, isLatest, fmt) {
      if (!best) return '';
      return '<div class="staff-metric"><b>' + fmt(best.v) + '</b><span>' + label + '（' + monthShort(best.m) + '）' + (isLatest ? '<span class="pb-tag">更新</span>' : '') + '</span></div>';
    }
    var pbHelp = '確定した月（今月は除く）の中での最高記録。「月間の平均単価」（会計済み売上 ÷ 来店件数）は、1〜2件の高額な会計で記録にならないよう、来店5件以上の月だけで比べます。直近の確定した月がそれ以前のすべての月を上回ったときだけ「更新」と表示します（同じ値は対象外）。';
    return '<div class="sg-title">自己ベスト' + help(pbHelp) + '</div><div class="staff-metrics">' +
      cell('月間来店', pb.visits, pb.latestIsBest.visits, function (v) { return F.int(v) + '件'; }) +
      cell('月間売上', pb.rev, pb.latestIsBest.rev, yen) +
      cell('月間の平均単価', pb.spend, pb.latestIsBest.spend, yen) +
      cell('月間の店販売上', pb.retail, pb.latestIsBest.retail, yen) + '</div>';
  }

  // ===================== 曜日別（「お店」タブ ＞ 曜日・時間） ===================
  var trendMetric = 'visits';
  function drawDow() {
    var t = state.analytics.trend;
    var meta = { visits: { fmt: function (v) { return v + '件'; }, name: '来店数', color: '--cat-visits', max: null, pct: false }, nextRes: { fmt: function (v) { return v.toFixed(0) + '%'; }, name: '次回予約率', color: '--cat-repeat', max: 100, pct: true }, spend: { fmt: yen, name: '客単価', color: '--cat-spend', max: null, pct: false }, ltv: { fmt: yen, name: 'LTV', color: '--cat-sales', max: null, pct: false } }[trendMetric];
    draw('cDow', function (el) {
      C.columns(el, {
        groups: t.dayOfWeek.map(function (d) { return d.d; }),
        series: [{ name: meta.name, color: cvar(meta.color), values: t.dayOfWeek.map(function (d) { return meta.pct ? d[trendMetric] * 100 : d[trendMetric]; }) }],
        valueFmt: meta.fmt, yFmt: meta.pct ? function (v) { return v.toFixed(0) + '%'; } : F.compact, yMax: meta.max, height: 250
      });
    });
  }

  // ============================ 顧客（RFM） =================================
  var rfmSort = { key: 'M', dir: -1 };
  var rfmCallbackOnly = false;
  function renderRFM() {
    var A = state.analytics, r = A.rfm;
    var upcoming = r.customers.filter(function (c) { return c.hasUpcoming; }).length;
    // 会計明細だけ（これからの予約がデータに無い）なら、予約の有無は「無い」ではなく「分からない」
    var noBook = A.meta.completedOnly;
    var noBookWhy = A.meta.hasReservationRows ? 'データに今日より後の予約が入っていません' : '会計明細には予約が含まれません';
    var html = '<div class="view-title">顧客</div><div class="view-lead">来店されたお客様 ' + F.int(r.total) + '人を、最終来店(R)・来店回数(F)・累計売上(M)で9つのグループに分けています。' + taxLead() + dataStamp() + '</div>';
    html += '<div class="tiles t4">' +
      tile({ icon: 'person', color: 'var(--cat-store)', label: 'お客様', value: F.int(r.total) + '<span class="u">人</span>', sub: '全期間に来店された方' }) +
      (noBook
        ? tile({ icon: 'reservations', color: 'var(--cat-visits)', label: '次の予約あり', value: '—', sub: noBookWhy,
            help: 'これからの来店予定（受付待ち・集計基準日より後）の予約が入っているお客様の人数。' + noBookWhy + 'ため、数えられません。' })
        : tile({ icon: 'reservations', color: 'var(--cat-visits)', label: '次の予約あり', value: F.int(upcoming) + '<span class="u">人</span>', sub: r.total ? '来店されたお客様の ' + pct(upcoming / r.total * 100, 0) : '' ,
            help: 'これからの来店予定（受付待ち・集計基準日より後）の予約が入っているお客様。' })) +
      tile({ icon: 'phone', color: 'var(--cat-sales)', label: '呼び戻し候補', value: F.int(r.callbackCount) + '<span class="u">人</span>', sub: noBook ? '周期を過ぎた方（予約の有無は不明）' : '周期を過ぎて、次の予約なし',
        help: '最終来店からの日数が、そのお客様の来店周期（来店2回以上の方は本人の間隔の中央値、1回の方はお店全体の中央値。同じ日の2件目は間隔に数えません）の1.5倍を超えていて、<b>これからの予約が入っていない</b>お客様。すでに次の予約が入っている方は、周期を過ぎていても候補に入れません。' +
          (noBook ? '<br>いまのデータは' + noBookWhy + '。そのため、すでに次の予約を入れている方を見分けられず、周期を過ぎた方をすべて候補にしています。' : '') }) +
      tile({ icon: 'clock', color: 'var(--cat-new)', label: '来店周期', value: F.int(A.store.visitCycleMedianDays) + '<span class="u">日</span>', sub: '来店の間隔の中央値' }) +
      '</div>';

    html += secH('9つのグループ' + help('R（最終来店からの日数）・F（来店回数）をそれぞれ5段階の点数にして、その組み合わせでグループを決めます（区分の境目は元のKPIワークブックの固定値）。行をタップすると、平均の R・F・M が開きます。'), '価値の高い順');
    html += '<div class="ios-list reveal">' + r.segments.map(function (sg) {
      var col = cvar(SEG_COLOR[sg.seg] || '--series-6'), st = cvar(SEG_STATUS[sg.seg] || '--accent');
      return '<details style="--seg-color:' + col + '"><summary>' +
        '<span class="seg-dot"></span>' +
        '<span class="r-main"><span class="r-title">' + esc(sg.label) + '<span class="seg-status" style="background:' + st + '"></span></span>' +
        '<span class="r-sub">' + esc(sg.action) + '</span>' +
        '<span class="seg-ratio"><i data-w="' + (sg.people ? Math.max(1.5, sg.ratio * 100) : 0) + '"></i></span></span>' +
        '<span class="r-val"><b>' + F.int(sg.people) + '人</b><small>' + pct(sg.ratio * 100, 1) + '</small></span><span class="chev"></span></summary>' +
        '<div class="r-detail"><div class="seg-rfm">' + (sg.people
          ? '<span>平均 R <b>' + sg.r + '日</b></span><span>F <b>' + sg.f + '回</b></span><span>M <b>' + yen(sg.m) + '</b></span>'
          : '<span>このグループのお客様はいません</span>') + '</div></div></details>';
    }).join('') + '</div>';

    var overdue = r.customers.filter(function (c) { return c.callback; }).slice(0, 6);
    html += '<div class="grid" style="margin-top:16px">';
    html += card({ col: 'col-6', title: 'F × R マップ', icon: 'rfm', color: 'var(--cat-sales)', sub: '縦＝来店回数（F5が多い）、横＝最終来店（R5が最近）。数字は人数' + help('縦軸＝来店回数(F)の点数、横軸＝最終来店(R)の点数（5が最近）。各マスの数字は、その組み合わせに当てはまるお客様の人数。'), body: chartBox('cHeat', 0) });
    html += card({ col: 'col-6', title: '呼び戻し候補（累計売上の高い順）', icon: 'phone', color: 'var(--cat-sales)',
      sub: noBook
        ? '周期を過ぎたお客様（' + noBookWhy + 'ため、次の予約の有無は確認できません）'
        : '周期を過ぎていて、次の予約が入っていないお客様' + (r.overdueWithBooking ? '（周期を過ぎていても予約がある ' + F.int(r.overdueWithBooking) + '人は除いています）' : ''),
      body: overdue.length
        ? '<div class="cell-list">' + overdue.map(function (c) {
            return '<div class="hc-row"><span>' + esc(c.name) + ' <span class="note-inline">（' + F.int(c.R) + '日前・' + F.int(c.F) + '回）</span></span><b>' + yen(c.M) + '</b></div>';
          }).join('') + '</div><div style="margin-top:12px"><button type="button" class="pill wrap" id="rfmShowCallback">一覧で候補をすべて見る（' + F.int(r.callbackCount) + '人）</button></div>'
        : '<div class="empty-note">呼び戻しの候補はいません。</div>' });
    html += '</div>';

    html += secH('お客様の一覧');
    html += '<div class="grid">' + card({
      col: 'col-12', title: '顧客一覧', icon: 'person', color: 'var(--cat-store)', sub: '見出しをタップで並べ替え',
      body: '<div class="rfm-tools"><span class="note-inline" id="rfmTableNote" aria-live="polite"></span>' +
        '<button type="button" class="pill wrap' + (rfmCallbackOnly ? ' accent' : '') + '" id="rfmCallbackToggle" aria-pressed="' + rfmCallbackOnly + '">' + (noBook ? '周期を過ぎた方だけ表示' : '呼び戻し候補だけ表示') + '（' + F.int(r.callbackCount) + '人）</button>' +
        '</div><div class="table-wrap tall"><table class="kate-table" id="rfmTable"></table></div>'
    }) + '</div>';

    mount('rfm', html);

    // 「動きを減らす」設定（prefers-reduced-motion）のときは、伸びるアニメーションなしで最終の幅に
    Array.prototype.forEach.call(document.querySelectorAll('#view-rfm .seg-ratio i'), function (elx, i) {
      if (global.__kateReduce) { elx.style.width = elx.dataset.w + '%'; return; }
      setTimeout(function () { elx.style.width = elx.dataset.w + '%'; }, 120 + i * 40);
    });
    draw('cHeat', function (el) {
      C.heatmap(el, { matrix: r.map, rowLabels: ['F5', 'F4', 'F3', 'F2', 'F1'], colLabels: ['R1', 'R2', 'R3', 'R4', 'R5'], hue: cvar('--seq-5') });
    });
    buildRfmTable();
    var toggleBtn = $('#rfmCallbackToggle');
    function setCallbackOnly(on) {
      rfmCallbackOnly = on;
      toggleBtn.classList.toggle('accent', on);
      toggleBtn.setAttribute('aria-pressed', on);
      buildRfmTable();
    }
    toggleBtn.addEventListener('click', function () { setCallbackOnly(!rfmCallbackOnly); });
    var showCb = $('#rfmShowCallback');
    if (showCb) showCb.addEventListener('click', function () {
      setCallbackOnly(true);
      var tc = $('#rfmTable').closest('.card') || $('#rfmTable');
      tc.scrollIntoView({ behavior: global.__kateReduce ? 'auto' : 'smooth', block: 'start' });
    });
    flush();
  }
  function buildRfmTable() {
    var r = state.analytics.rfm, noBook = state.analytics.meta.completedOnly;
    var pool = rfmCallbackOnly ? r.customers.filter(function (c) { return c.callback; }) : r.customers;
    // 一覧全体は上位120人まで（数百人を並べても探しにくいため）。呼び戻し候補だけを
    // 表示しているときは、連絡する相手の一覧なので上限を設けず全員を出す
    // （以前は「候補をすべて見る（143人）」で120人しか出ていなかった）。
    var cap = rfmCallbackOnly ? pool.length : 120;
    var rows = pool.slice().sort(function (a, b) { var k = rfmSort.key; return ((a[k] > b[k]) - (a[k] < b[k])) * rfmSort.dir; }).slice(0, cap);
    var note = $('#rfmTableNote');
    if (note) note.textContent = (rfmCallbackOnly ? (noBook ? '周期を過ぎた方' : '呼び戻し候補') + ' ' : '') +
      (rows.length < pool.length ? '全' + F.int(pool.length) + '人のうち ' + F.int(rows.length) + '人を表示' : '全' + F.int(pool.length) + '人を表示');
    // 見出しの単位（(日)(回)(¥)）は .th-unit として分け、スマホでは隠す（狭い列で1文字ずつ縦に並ぶのを防ぐ）
    var cols = [
      { k: 'name', label: 'お名前' },
      { k: 'R', label: 'R', unit: '(日)', help: '最終来店からの経過日数（Recency）。小さいほど最近来店している。' },
      { k: 'F', label: 'F', unit: '(回)', help: '来店回数（Frequency）。' },
      { k: 'M', label: 'M', unit: '(¥)', help: '累計売上（Monetary）。' },
      { k: 'seg', label: 'グループ', help: 'R・F の点数の組み合わせから決まる9つのグループ。' },
      { k: 'callback', label: '呼び戻し', help: noBook
          ? '「周期超過」＝最終来店からの日数が、そのお客様の来店周期の1.5倍を超えている方。会計明細だけのデータでは次の予約の有無が見えないため、予約が入っている方も含みます。それ以外は本人の来店周期の目安を表示。'
          : '「対象」＝最終来店からの日数が、そのお客様の来店周期の1.5倍を超えていて、これからの予約が無い方。「予約」＝次の予約が入っている方（日付つき）。それ以外は本人の来店周期の目安を表示。' }
    ];
    var thead = '<thead><tr>' + cols.map(function (c) {
      return '<th data-k="' + c.k + '" tabindex="0" role="button" aria-label="' + c.label + (c.unit ? ' ' + c.unit : '') + 'で並べ替え"' +
        (rfmSort.key === c.k ? ' aria-sort="' + (rfmSort.dir > 0 ? 'ascending' : 'descending') + '" class="sorted' + (rfmSort.dir > 0 ? ' asc' : '') + '"' : '') + '>' +
        c.label + (c.unit ? ' <span class="th-unit">' + c.unit + '</span>' : '') + (c.help ? help(c.help) : '') + '</th>';
    }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (c) {
      var col = cvar(SEG_COLOR[c.seg] || '--series-6');
      var cb = c.callback ? '<span class="chip down">' + (noBook ? '周期超過' : '対象') + '</span>'
        : c.hasUpcoming ? '<span class="chip info">予約 ' + esc(mdJa(c.nextBooking.slice(0, 7), +c.nextBooking.slice(8, 10))) + '</span>'
        : '<span class="note-inline">目安 ' + c.ownCycle + '日</span>';
      return '<tr><td>' + esc(c.name) + '</td><td>' + c.R + '</td><td>' + c.F + '</td><td><span class="full-num">' + F.int(c.M) + '</span><span class="compact-num">' + F.compact(c.M) + '</span></td>' +
        '<td style="text-align:left"><span class="seg-tag"><i style="background:' + col + '"></i>' + esc(c.seg) + '</span></td>' +
        '<td style="text-align:left">' + cb + '</td></tr>';
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
  var slotJa = { yoyaku: '予約データ', kaikei: '会計明細' };
  var FUNNEL_CAP = 10;   // ファネルの段数の上限（engine の FUNNEL_MAX_STAGES と揃える）
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
      ? 'ダッシュボードの閲覧（ホーム・お店・スタッフなどの各タブ）に設定は不要です。このページの管理操作はロックされています。'
      : 'Googleスプレッドシート連携、またはファイル（CSV / Excel）を入れるだけで全指標を自動再計算します。<b>「予約データ」</b>（ステータス列つき）と、<b>「会計明細」</b>（会計日・金額・店販つき）の両形式に対応。<b>両方を読み込むと自動で結合</b>し、店販売上や次回予約取得率などの指標を同じ画面で確認できます（文字コードは Shift-JIS / UTF-8 を自動判別）。') + '</div>';
    var html = '';
    // 合言葉 (shared passphrase) — decrypt the repo-hosted encrypted sheet URLs
    // so a brand-new device links up without anyone typing the raw URL.
    // 連携URLが保存されていても、それが壊れている／読めない場合は復旧手段が要る。
    // 以前は「何も連携していない端末」にしか出していなかったため、壊れた連携を
    // 抱えた端末では合言葉カードが消え、URL入力欄は管理ロックの内側にあるため、
    // スタッフ端末からは二度と直せなかった。
    var linkBroken = Object.keys(state.sheetErrors || {}).length > 0;
    if (state.sharedBlob && (!(state.sheetUrl || state.sheetUrlKaikei) || linkBroken)) {
      html += card({
        col: 'col-12', title: '合言葉で店舗データを表示' + help('お店のスプレッドシートのURLを暗号化したものがこのアプリに同梱されています。合言葉を入力すると、この端末で復元されて自動連携が始まります（合言葉の入力は端末ごとに最初の1回だけ）。'),
        sub: linkBroken
          ? '<b>この端末の連携がうまくいっていません。</b>合言葉を入れ直すと、正しい連携URLが復元されます'
          : 'この端末で初めて使うときは、お店の合言葉を入力してください（1回だけ）',
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
        // 分母は「お店」タブの「月ごとの数字」と同じ（月＝会計のあった月数／日＝会計のあった日数）。
        miniStat(t.months ? yen(Math.round(t.rev / t.months)) : '—', '平均月間売上') +
        miniStat(t.bizDays ? yen(Math.round(t.rev / t.bizDays)) : '—', '平均日間売上') +
        '</div>';
    }
    html += card({
      col: 'col-12', title: '年商' + taxTagD + help('選んだ期間の「会計済み売上（実績）」の合計。既定は基準日の年の1月1日〜12月31日で、年のボタンや開始・終了日で任意の期間に絞り込めます。受付待ちの予約がある期間では、その見込み額と合計見込みも下に併記します。施術売上＝売上－店販売上。営業日数＝会計が1件以上あった日数。平均月間売上＝売上÷会計のあった月数、平均日間売上＝売上÷営業日数（どちらも「お店」タブ（売上・予約）の「月ごとの数字」と同じ分母なので、休業日や未来の月で薄まりません）。金額は税抜。'),
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
      col: 'col-12', title: 'スプレッドシート連携' + help('URLを貼ると、開くたびに最新のシート内容を読み込みます。さらに<b>この画面を開いたままの端末</b>では、<b>30分おき</b>に自動で再読み込みします（時間帯を問いません）。シート側の同期が何時に終わってもダッシュボードからは決められないため、時間帯を決め打ちせず常に見ています。<br><br><b>重要</b>：このダッシュボードはサーバーを持たない仕組みのため、その時間帯に<b>誰もページを開いていなければ自動更新は行われません</b>（次に開いたときに最新を読み込みます）。毎晩必ず更新したい場合は、店頭の端末でこの画面を開いたままにしてください。実際に自動更新が動いたかは、下の「取得したデータの中身（診断）」で確認できます。'), sub: 'URLを貼るだけで自動反映（両方貼ると自動結合）・<b>この画面を開いている端末</b>のみ30分おきに自動更新',
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
    // 月の売上目標（スプレッドシートの「目標」タブ）— 状態と書き方
    html += card({
      col: 'col-12', title: '月の売上目標', icon: 'goal', color: 'var(--cat-goal)',
      sub: 'スプレッドシートの「目標」タブから読み込みます。<br>' + targetsStatusHtml() + help('目標は、連携中の予約データと<b>同じスプレッドシート</b>の「目標」タブから読み込みます。書き換えると、各端末が次に読み込んだとき（開いたとき・30分おきの自動更新）に反映されます。公開リポジトリには何も置かないため、目標額は外から見えません。金額は<b>税抜</b>で書いてください（税込で書く列は見出しに「（税込）」と付けます）。該当する月の行が無いときは「毎月」の行を使います。'),
      body: targetsHowToHtml(A.meta.staffNames)
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
      var err = state.sheetErrors[sl];
      // 読み込めなかったスロットも行として出す（黙って消さない）。ただし失敗行で
      // 置き換えてはいけない — いま画面に出ている数字がどのデータなのかという
      // 記録まで消えてしまい、「取得は失敗したが表示は前回の内容」の切り分けが
      // できなくなる。失敗行は既存のデータ行の「上に足す」。
      var errRow = err
        ? '<tr><td>' + esc(slotJa[sl]) + '</td>' +
          '<td colspan="4" class="wrap" style="text-align:left;color:var(--status-warning)">読み込み失敗（' + esc(ymdhmJa(err.at)) + '）：' + esc(err.message) + '</td>' +
          '<td style="color:var(--status-warning);font-weight:700">失敗</td></tr>'
        : '';
      if (!s3 || !s3.diag) return errRow;
      var d3 = s3.diag, today = new Date();
      var todayNum = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
      // 「最新の日付」が2日以上前なら、取得できている中身自体が古い＝シート側の問題
      var behind = d3.latest !== null && (todayNum - d3.latest) >= 2;
      return errRow + '<tr><td>' + esc(slotJa[sl]) + '</td>' +
        '<td class="tnum">' + F.int(d3.rows) + '件</td>' +
        '<td class="tnum"' + (behind ? ' style="color:var(--status-warning);font-weight:700"' : '') + '>' +
          (d3.latest !== null ? esc(ymdNumJa(d3.latest)) : '—') + '</td>' +
        '<td>' + (s3.updatedAt ? esc(ymdhmJa(s3.updatedAt)) : '—') + '</td>' +
        '<td>' + esc(ymdhmJa(d3.fetchedAt)) + '</td>' +
        // 取得経路。export＝常に最新／gviz・pub＝Google側で古い内容が返ることがある
        '<td' + (d3.kind === 'export' ? '' : ' style="color:var(--status-warning);font-weight:700"') + '>' +
          (d3.kind === 'export' ? '常に最新' : d3.kind === 'gviz' ? 'キャッシュ有' : '公開スナップ') + '</td></tr>' +
        // 取得経路ごとの結果。片方の経路だけが古い内容を返している場合、
        // ここに並べて出ることで「どちらが古いのか」が一目で分かる。
        ((d3.routes && d3.routes.length > 1)
          ? '<tr><td></td><td colspan="5" class="wrap" style="text-align:left;font-size:13px;color:var(--ink-muted)">経路ごとの取得結果： ' +
            d3.routes.map(function (rt) {
              return esc(KIND_JA[rt.kind] || rt.kind) + '＝' +
                (rt.error ? '読めず' : rt.latest ? esc(ymdNumJa(rt.latest)) : rt.rows !== null ? F.int(rt.rows) + '件' : '—') +
                (rt.used ? '（採用）' : '');
            }).join(' ／ ') + '</td></tr>'
          : '');
    }).join('');
    if (diagRows) {
      html += card({
        col: 'col-12', title: '取得したデータの中身（診断）' + help('「更新しても数字が変わらない」ときに、原因がこのダッシュボードなのか、取得元のシートなのかを切り分けるための表です。<b>データ内の最新日</b>は、いま実際に取得できたCSVに含まれる一番新しい来店日／会計日です。ここが今日・昨日になっていなければ、シート側にまだ新しいデータが入っていない（＝同期が止まっている）ことを意味します。<b>シートの更新日時</b>はシート側が記録した同期完了時刻、<b>取得時刻</b>はこの画面が読みに行った時刻です。<b>取得経路</b>は、通常の編集URLなら「常に最新」（ファイルのCSV書き出しを直接読む経路）になります。「キャッシュ有」「公開スナップ」の場合はGoogle側で古い内容が返ることがあるため、編集URL（<code>/spreadsheets/d/…/edit</code>）に貼り替えてください。'),
        sub: '「更新しても変わらない」ときは、ここで取得元とダッシュボードのどちらの問題か切り分けられます',
        body: '<div class="table-wrap"><table class="kate-table diag-table">' +
          '<thead><tr><th>シート</th><th>取得件数</th><th>データ内の最新日</th><th>シートの更新日時</th><th>取得時刻</th><th>取得経路</th></tr></thead>' +
          '<tbody>' + diagRows + '</tbody></table></div>' +
          '<div class="note-inline" style="margin-top:10px">' +
          '「取得時刻」は更新のたびに必ず新しくなります。それでも<b>「データ内の最新日」が進まない場合、原因はシート側</b>です（このダッシュボードは取得できた内容をそのまま表示しています）。' +
          '</div>' +
          // 夜間の自動更新が「実際に動いたか」。動いていなければ、その時間帯に
          // この画面を開いた端末が1台も無かったということ（下の注記を参照）。
          '<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--hairline)">' +
          '<div class="datainfo">' +
          '<div><span>自動更新の間隔</span><b>30分おき（終日）</b></div>' +
          '<div><span>前回の自動更新</span><b' + (state.autoReloadLast ? '' : ' style="color:var(--status-warning)"') + '>' +
            (state.autoReloadLast ? esc(ymdhmJa(state.autoReloadLast)) : 'まだ一度も動いていません') + '</b></div>' +
          (state.autoReloadNext ? '<div><span>次回の予定</span><b>' + esc(ymdhmJa(state.autoReloadNext)) + '</b></div>' : '') +
          '</div>' +
          '<div class="status-line" style="margin-top:10px;color:var(--status-warning)"><i style="background:var(--status-warning)"></i>' +
          '<b>自動更新は、この画面を開いたままの端末でのみ動きます。</b>このダッシュボードはサーバーを持たない仕組みのため、' +
          '誰もページを開いていなければ自動更新は行われません（次に開いたときに最新を読み込みます）。' +
          '毎晩必ず更新したい場合は、店頭の端末でこの画面を開いたままにしておいてください。</div>' +
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
        (state.sheetUpdatedAt ? '<div><span>データ更新日時（シート側の記録）' + help('スプレッドシートの「データ更新日時」列の値です。この列を書いているのはスプレッドシート側の別スクリプト（<code>tools/sheet-update-stamp.gs</code>）なので、<b>データが正常に更新されていても、この列だけ止まることがあります</b>。データの鮮度の判断には使っていません（判断は「取得した内容が最後に変わった時刻」で行っています）。') + '</span><b>' + esc(ymdhmJa(state.sheetUpdatedAt)) + '</b></div>' : '') +
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
        '<li><b>固定化率</b>：実際に2回来店した顧客のうち、3回目の予約に到達した割合（受付待ちを含み、キャンセルは数えず取り直せば数える）。リピート率は予約ベース（2回目の予約に到達した割合）で、分母の基準が異なる。</li>' +
        '<li><b>スタッフ比較</b>：表内の数値はすべて直近3ヶ月（今月を含まない確定3ヶ月）平均。リピート率・固定化率は、そのスタッフが直近3ヶ月に初回担当した顧客のコホートが対象。分母が5人（件）未満の率は「—」。</li>' +
        '<li><b>今月と先月の同じ時期（ホーム）</b>：今月＝集計基準日の月の1日〜基準日の会計済み（実績）。先月の同じ時期＝先月の1日〜同じ日。予約込み＝実績＋今月中の受付待ち（基準日より後）の予約金額。</li>' +
        '<li><b>月ごとの数字</b>：会計済み（実績）のみ。直近3ヶ月＝確定3ヶ月の月平均（来店のあった月数で割る）、先月＝その月の合計、今月＝1日〜基準日の合計。会計明細だけのデータでは、月末から30日経っていない月の来店を次回予約率から除きます（再来待ち）。</li>' +
        '<li><b>月の売上目標</b>：スプレッドシートの「目標」タブ（税抜）。達成率＝実績 ÷ 目標（100%に届くまでは最大99%と表示）、目標ペース＝目標 ×（基準日の日 ÷ その月の日数）。</li>' +
        '<li><b>来店周期</b>：同じお客様の、別の日の来店どうしの間隔の中央値（同じ日の2件目は間隔に数えない）。</li>' +
        '<li><b>呼び戻し候補</b>：最終来店からの日数が本人の来店周期（1回だけの方はお店全体の中央値）の1.5倍を超え、<b>これからの予約が入っていない</b>お客様（会計明細だけのデータでは予約の有無が見えないため、周期を過ぎた方すべて）。</li>' +
        '<li><b>次の一手</b>：リピート率（目安70%）・固定化率（目安60%）のうち、その率の分母が20人以上のものから、目安との差がいちばん大きい1つ。判定できた率がすべて目安以上なら「達成」と表示（分母が足りず判定していない率については達成とは書かない）。会計明細だけのデータでは提案を出さない。</li>' +
        '<li><b>育てた常連</b>：初回を担当したお客様のうち、実際に2回来店して3回目のご予約（受付待ちを含む）まで進んだ方の人数（全期間の累計）。</li>' +
        '<li><b>自分の推移・自己ベスト</b>：確定した月（今月を除く）で比べる。客単価・次回予約率は件数で重み付けした平均で、来店5件未満の月は除く。</li>' +
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

  // ---- 月の売上目標（targets.js）: 状態表示と書き方 -------------------------
  function targetsStatusHtml() {
    var t = state.targets || {}, link = state.sheetUrl || state.sheetUrlKaikei;
    var ok = function (msg) { return '<span class="status-line" style="color:var(--status-good)"><i style="background:var(--status-good)"></i>' + msg + '</span>'; };
    var warn = function (msg) { return '<span class="status-line" style="color:var(--status-warning)"><i style="background:var(--status-warning)"></i>' + msg + '</span>'; };
    if (!link) return 'スプレッドシートを連携すると、同じファイルの「目標」タブを読み込みます。';
    if (t.status === 'idle') {
      // 目標は、データ本体（予約データ。無ければ会計明細）を読み込めた後に読む。本体が
      // 読めていないあいだは「読み込み中」ではないので、そう書かない。
      var srcSlot = state.sheetUrl ? 'yoyaku' : 'kaikei';
      if (state.sheetErrors && state.sheetErrors[srcSlot]) return warn(slotMeta(srcSlot).label + 'を読み込めなかったため、「目標」タブもまだ読み込んでいません（上の警告をご確認ください。' + slotMeta(srcSlot).label + 'を読み込めると、続けて自動で読み込みます）。');
      return '「目標」タブを読み込み中…';
    }
    if (t.status === 'loading') return '「目標」タブを読み込み中…';
    if (t.status === 'unsupported') return warn('連携URLが「ウェブに公開」形式のため、「目標」タブを指定して読めません。通常の編集URL（<code>/spreadsheets/d/…/edit</code>）で連携すると読めるようになります。');
    // 同じファイルの予約データは読めているので、共有設定ではなく一時的な通信の問題のことが多い
    if (t.status === 'error') return warn('「目標」タブを読み込めませんでした：' + esc(t.message || '') + '。一時的な通信の問題のことがあります。次の自動更新か「今すぐ更新」で、もう一度読み込みます。');
    if (t.status === 'missing') {
      var why = {
        'wrong-sheet': '「目標」という名前のタブが見つかりません',
        // gviz は、指定した名前のタブが無いと1枚目のタブを返すことがあるため、どちらの場合もありうる
        'no-header': '「目標」タブが見つからないか、1行目に「月」の見出しがありません',
        'no-columns': '「お店」またはスタッフ名の列がありません'
      }[t.reason] || '表を読み取れませんでした';
      return warn(why + '（下の手順で作ると、目標の達成度がホームに出ます）。' + (t.unknown && t.unknown.length ? '読めなかった列：' + esc(t.unknown.join('・')) : ''));
    }
    if (t.status === 'ok') {
      var P = t.parsed, notes = [];
      var ym = state.analytics.meta.currentYm, names = state.analytics.meta.staffNames;
      var parts = [['お店', 'store']].concat(names.map(function (n) { return [n, n]; })).map(function (p) {
        var g = targetFor(ym, p[1]); return esc(p[0]) + ' ' + (g ? yen(g.amount) : '—');
      });
      var sk = P.skipped || {}, blank = sk.blankMonth || [], bad = sk.badMonth || [];
      // 月の欄が空で届いた行: 日付と「毎月」を同じ列に混ぜると、Google の読み取り（gviz）は
      // 列の型を多い方に決め、少ない方の値を空にして返す（Google の QUERY の仕様）。
      if (blank.length) notes.push(warn('「月」の欄が空として届いた行があります（' + esc(blank.map(function (r) { return r + '行目'; }).join('・')) + '）。日付と「毎月」を同じ列に混ぜると、Googleの読み取りでは少ない方の書き方が空になります。「目標」タブ全体を選び、［表示形式］→［数字］→［書式なしテキスト］にしてから、月を入力し直してください。'));
      if (bad.length) notes.push(warn('月を読めない行があります（' + esc(bad.map(function (b) { return b.row + '行目「' + b.text + '」'; }).join('・')) + '）。「2026/07」のように年から書いてください。'));
      if (P.conflicts && P.conflicts.length) notes.push(warn('同じ相手の目標の列が2つあり、金額が違います（' + esc(P.conflicts.map(function (c) { return c.row + '行目：' + c.labels.join('・'); }).join('／')) + '）。左側の列の金額を使っています。'));
      if (P.ignored && P.ignored.length) notes.push('「お店」の列があるため、「' + esc(P.ignored.join('」「')) + '」の列はお店の目標として使っていません。');
      if (P.unknown && P.unknown.length) notes.push(warn('スタッフ名と一致しない列は無視しました：' + esc(P.unknown.join('・'))));
      if (t.lastError) notes.push(warn('最新の「目標」タブを読み込めなかったため（' + esc(t.lastError) + '）、' + esc(ymdhmJa(t.fetchedAt)) + 'に読み込んだ目標を表示しています。次の自動更新でもう一度読み込みます。'));
      // 目標の行が1つも読めなかったときは「読み込み済み」の緑にしない
      var head = P.rowsRead
        ? ok('読み込み済み（' + esc(ymdhmJa(t.fetchedAt)) + '）。' + esc(monthJa(ym)) + 'の目標：' + parts.join('・') + (state.taxExcluded ? '（税抜）' : '（税込）'))
        : warn('「目標」タブはありましたが、目標の行を読み取れませんでした（' + esc(ymdhmJa(t.fetchedAt)) + '）。');
      return head + notes.map(function (n) { return '<br>' + n; }).join('');
    }
    return '';
  }
  function targetsHowToHtml(names) {
    var cols = ['月', 'お店'].concat(names);
    var ym = state.analytics.meta.currentYm.replace('-', '/');
    var ex = [ym, '1200000'].concat(names.map(function () { return '600000'; }));
    var tsv = function (a) { return a.join('\t'); };
    var copyBtn = function (text, label) { return '<button type="button" class="pill" data-copy="' + esc(text) + '">' + label + '</button>'; };
    return '<ol class="how" style="margin:0;padding-left:1.3em">' +
      '<li>予約データのスプレッドシートに<b>タブを1枚追加</b>し、名前を「<b>目標</b>」にします。<div class="copy-box"><code>目標</code>' + copyBtn('目標', 'タブ名をコピー') + '</div></li>' +
      '<li>そのタブの<b>左上の角（A列の左・1行目の上）をクリックしてタブ全体を選び</b>、メニューの［<b>表示形式</b>］→［<b>数字</b>］→［<b>書式なしテキスト</b>］にします。月が日付に変わると、「毎月」の行がGoogleの読み取りで空になってしまうためです。</li>' +
      '<li><b>A1セルを選んで</b>、見出しを貼り付けます（列に分かれて入ります）。<div class="copy-box"><code>' + esc(cols.join('　｜　')) + '</code>' + copyBtn(tsv(cols), '見出しをコピー') + '</div></li>' +
      '<li>2行目から、月ごとの目標を<b>税抜</b>・<b>半角数字</b>で書きます（例をコピーして金額だけ直せます）。<div class="copy-box"><code>' + esc(ex.join('　｜　')) + '</code>' + copyBtn(tsv(ex), '例の行をコピー') + '</div></li>' +
      '<li>毎月同じ目標でよい場合は、月の欄に「<b>毎月</b>」と書いた行を1行だけ置けば、その月の行が無い月に使われます。</li>' +
      '<li>スタッフの列名は、ダッシュボードのスタッフ名（' + esc(names.join('・')) + '）と同じにしてください。</li>' +
      '</ol>';
  }
  function wireCopyButtons(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('[data-copy]'), function (b) {
      b.addEventListener('click', function () {
        var text = b.dataset.copy, done = function () { toast('✓ コピーしました', 'ok'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
        else { fallbackCopy(text); done(); }
      });
    });
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
  // 目標タブを読み込む（予約データの連携URLから同じファイルを指す）。失敗しても他の表示は止めない。
  // targetsSeq: 読み込みを始めるたび・目標を消すたびに進める。届いた応答は、自分が
  // いちばん新しい読み込みで、かつ連携先が変わっていないときだけ使う（連携の解除や
  // 「サンプルに戻す」の直後に古い応答が届いて、目標がサンプルの上に出るのを防ぐ）。
  var targetsSeq = 0;
  function targetsLink() { return state.sheetUrl || state.sheetUrlKaikei; }
  function clearTargets() { targetsSeq++; state.targets = { status: 'idle' }; }
  function loadTargets() {
    var link = targetsLink();
    var T = global.KATE.targets;
    if (!link || !T) { clearTargets(); return; }
    if (!T.urlFor(link)) { targetsSeq++; state.targets = { status: 'unsupported', link: link }; preserveInputs(renderAll); return; }
    var seq = ++targetsSeq;
    // 同じファイルの目標を読み直すあいだは、前回の目標を出したままにする（ちらつかせない）
    if (state.targets.status !== 'ok' || state.targets.link !== link) state.targets = { status: 'loading', link: link };
    function stale() { return seq !== targetsSeq || link !== targetsLink(); }
    T.fetchText(link).then(function (text) {
      if (stale()) return;
      var parsed = T.parse(text, state.analytics.meta.staffNames);
      state.targets = parsed.ok
        ? { status: 'ok', parsed: parsed, fetchedAt: new Date(), link: link }
        : { status: 'missing', reason: parsed.reason, unknown: parsed.unknown || [], fetchedAt: new Date(), link: link };
      preserveInputs(renderAll);
    }).catch(function (err) {
      if (stale()) return;
      var msg = (err && err.message) || '取得に失敗しました';
      // 読み込めていた目標は、1回の失敗（通信の瞬断など）で消さない。データ本体と同じく
      // 前回読み込んだ内容を出し続け、失敗したことだけを添える（次の成功で消える）。
      if (state.targets.status === 'ok' && state.targets.parsed && state.targets.link === link) {
        state.targets.lastError = msg; state.targets.lastErrorAt = new Date();
      } else {
        state.targets = { status: 'error', message: msg, fetchedAt: new Date(), link: link };
      }
      preserveInputs(renderAll);
    });
  }

  function wireUpload() {
    wireCopyButtons($('#view-data'));
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
  function applySources(opts) {
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
    // 夜間の自動更新が「成功」したときも再描画が走る。利用者の操作と無関係な
    // タイミングなので、入力途中の値（合言葉・貼り付け中のURL）を巻き添えにしない。
    var run = function () { updateChrome(); renderAll(); route(state.view, true); };
    if (opts && opts.preserveInput) preserveInputs(run); else run();
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
    var usedKind = null;   // どの経路の内容を採用したか（export / gviz / pub）
    var triedKinds = [], fetched = false, routeErrors = [];
    // 記録するのはURLではなく経路の種別だけ。URLにはシートのIDが含まれ、
    // 失敗バナーはスタッフも見る全ビューに出るため、そのまま出すと管理ロックが
    // 隠している連携先が漏れる。
    global.KATE.sheets.fetchAllCsv(url, {
      onAttempt: function (u, kind) { if (kind && triedKinds.indexOf(kind) === -1) triedKinds.push(kind); }
    }).then(function (res) {
      if (res.ok.length) fetched = true;   // 取得は成功。ここから先は「中身の解釈」
      // 取れた経路をすべて解釈し、**いちばん新しい内容**を採用する。
      // /export が CORS で読めない環境でも gviz の内容が届き、逆に gviz が古い
      // スナップショットを返しても /export の新しい内容が勝つ。どちらか一方に
      // 賭けないことで、「シートは更新されているのに反映されない」を塞ぐ。
      var cands = res.ok.map(function (r, i) {
        try {
          var p = global.KATE.ingest.fromAOA(global.KATE.ingest.parseCSV(r.text));
          return {
            r: r, parsed: p, idx: i,
            stamp: p.sheetUpdatedAt ? +p.sheetUpdatedAt : 0,
            latest: latestRecordDate(p.records) || 0,
            rows: p.records.length
          };
        } catch (e) { return { r: r, idx: i, error: e }; }
      });
      // 経路ごとの失敗理由を全部残す。1本分だけ出すと、たとえば「/export は共有設定、
      // gviz は接続遮断」のうち片方しか見えず、原因の切り分けを誤らせる。
      routeErrors = res.failed.map(function (f) {
        return { kind: f.kind, message: (f.error && f.error.message) || '取得に失敗しました' };
      }).concat(cands.filter(function (c) { return c.error; }).map(function (c) {
        return { kind: c.r.kind, message: c.error.message || '中身を読み取れませんでした' };
      }));
      var good = cands.filter(function (c) { return c.parsed; });
      if (!good.length) {
        var first = cands[0] || res.failed[0];
        throw (first && (first.error || (first.r && first.r.error))) || new Error('取得に失敗しました。');
      }
      // 新しさの順: シート側の同期スタンプ → データ内の最新日 → 件数 → 候補順。
      // 最後の候補順は同点時の保険。既存行の金額修正のように、スタンプ・最新日・行数が
      // どれも変わらない更新では全経路が同点になりうる。そのとき /export（常に現在の
      // 内容）が gviz（Google側キャッシュ）に負けないよう、明示的に順序で決める。
      good.sort(function (a, b) {
        return (b.stamp - a.stamp) || (b.latest - a.latest) || (b.rows - a.rows) || (a.idx - b.idx);
      });
      var win = good[0], text = win.r.text, parsed = win.parsed;
      usedKind = win.r.kind;
      var format = parsed.format, recs = parsed.records;
      // 検出した形式が要求スロットと違う場合、従来は無条件にその形式のスロットへ
      // 書き込み、localStorage の連携URLも上書きしていた。タブ指定が効かず両方の
      // URLが同じタブを読んでしまう状況では、これで**もう一方の連携URLが端末から
      // 永久に消える**（2つのキーが同じURLになる）。上書きは絶対にしない。
      var heldUrl = format === 'kaikei' ? state.sheetUrlKaikei : state.sheetUrl;
      if (format !== slot && heldUrl && heldUrl !== url) {
        throw new Error('このURLは' + slotMeta(format).label + 'の内容を返しました（' +
          slotMeta(slot).label + 'として連携しようとしています）。連携先のタブ（gid）をご確認ください。' +
          slotMeta(format).label + '側の連携はそのまま保っています。');
      }
      var prevSrc = state.sources[format];
      var hash = strHash(text);
      var unchanged = !!(prevSrc && prevSrc.hash && prevSrc.hash === hash);
      // 「内容が最後に変わった時刻」を記録する。鮮度の判断はこちらを主役にする。
      // シート側の「データ更新日時」列は、スプレッドシートのApps Scriptが最大10分
      // 遅れて書き込む値なので、実際にはデータが新しくてもこの列だけ古いことがある
      // （実際にそれで「1日以上更新されていません」と誤って警告した）。
      //
      // 重要: 「初めて観測した内容」を変化とみなしてはいけない。そうすると、何日も
      // 止まっているシートを初めて開いた端末で「たったいま変わった」ことになり、
      // 本物の停止を見逃す。前回のハッシュを端末に残し、**違っていたときだけ**
      // 変化とみなす。前回のハッシュを知らない端末では、シート側スタンプで代用する。
      var prevHash = null;
      try { prevHash = localStorage.getItem('kate-hash-' + format); } catch (e) {}
      if (prevHash && prevHash !== hash) {
        state.contentChangedAt[format] = Date.now();
        try { localStorage.setItem('kate-changed-' + format, String(state.contentChangedAt[format])); } catch (e) {}
      }
      try { localStorage.setItem('kate-hash-' + format, hash); } catch (e) {}
      var prevFetchedAt = prevSrc && prevSrc.diag ? prevSrc.diag.fetchedAt : null;
      state.sources[format] = {
        records: recs, fileName: null, via: 'スプレッドシート連携', updatedAt: parsed.sheetUpdatedAt || null, hash: hash,
        // 診断用: 実際に取得できた中身そのもの。「更新しても変わらない」ときに、
        // 原因がダッシュボードなのか取得元なのかを推測ではなく事実で切り分ける。
        // routes には経路ごとの結果を残す（どの経路が古いのかがそのまま見える）。
        diag: {
          rows: recs.length, bytes: text.length, latest: latestRecordDate(recs), fetchedAt: new Date(),
          url: url, kind: usedKind,
          routes: cands.map(function (c) {
            return { kind: c.r.kind, rows: c.parsed ? c.parsed.records.length : null, latest: c.parsed ? c.latest : null, used: c === win };
          }).concat(res.failed.map(function (f) {
            return { kind: f.kind, rows: null, latest: null, used: false, error: f.error && f.error.message };
          }))
        }
      };
      if (format === 'kaikei') state.sheetUrlKaikei = url; else state.sheetUrl = url;
      try { localStorage.setItem(format === 'kaikei' ? 'kate-sheet-url-kaikei' : 'kate-sheet-url', url); } catch (e) {}
      state.dataLoadedAt = new Date();   // データを取得した日時を記録
      delete state.sheetErrors[format]; delete state.sheetErrors[slot];   // 復旧したので失敗表示を消す
      var A = applySources({ preserveInput: true });
      // 月の売上目標は、予約データと同じファイルの「目標」タブから読む（予約データが
      // 無く会計明細だけ連携している場合はそちらのファイル）。データと同じ間隔で読み直す。
      if (format === 'yoyaku' || !state.sheetUrl) loadTargets();
      var reroute = format !== slot ? '（' + slotMeta(format).label + 'の形式を検出したため、そちらに読み込みました）' : '';
      var warn = A.meta.undatedRows ? '（うち' + F.int(A.meta.undatedRows) + '件は日付を読み取れず除外）' : '';
      if (!opts.silent) {
        // 取得は成功したのに中身が前回と1文字も違わない場合、画面は当然変わらない。
        // 「更新したのに変わらない」の原因がダッシュボードではなくシート側にある
        // ことをその場で伝える（黙って成功トーストを出すと誤解を招く）。
        if (unchanged) {
          // 直前の取得と同じ内容なのは、その間にシートが書き換わっていなければ当然。
          // 以前はこれを無条件に赤で「シート側の同期をご確認ください」と出していたため、
          // 「開いた直後に更新を押した」だけで障害のように見えていた。
          // 本当に問題なのは「長期間ずっと同じ」場合だけなので、そこだけ警告色にする。
          var since = state.contentChangedAt[format];
          var staleLong = since && (Date.now() - since > SYNC_STALE_MS);
          toast(staleLong
            ? '⚠ ' + slotMeta(format).label + 'の内容は ' + ymdhmJa(new Date(since)) + ' から変わっていません。シート側の同期をご確認ください'
            : slotMeta(format).label + 'の内容は' + (prevFetchedAt ? ymdhmJa(prevFetchedAt) + 'の取得' : '前回') + 'から変わっていません（取得は成功しています）',
            staleLong ? 'err' : 'ok');
        } else {
          toast('✓ スプレッドシートから ' + F.int(recs.length) + '件を読み込みました' + reroute + warn, warn ? 'err' : 'ok');
        }
      }
    }).catch(function (err) {
      console.warn('sheet load failed', err);
      // silent（起動時の自動読み込み）でも記録して画面に出す。黙って失敗すると
      // サンプルデータのまま表示され、実データだと誤認されるため。
      // stage: fetch=どの経路でも取得できなかった（共有設定・回線）／
      //        parse=取得はできたが中身を表として読めなかった（見出し行など）。
      state.sheetErrors[slot] = {
        message: err.message || '読み込みに失敗しました',
        at: new Date(), stage: fetched ? 'parse' : 'fetch', kinds: triedKinds.slice(),
        routes: routeErrors.length ? routeErrors : (err.routes || [])
      };
      if (!opts.silent) toast('⚠ ' + (err.message || '読み込みに失敗しました'), 'err');
      // 夜間の自動更新など、ユーザーの操作と無関係なタイミングでも起きる。
      // 入力途中の値（貼り付けたURL・入力中の合言葉）を巻き添えにしない。
      preserveInputs(renderAll);
    });
  }
  function unlinkSheet(slot) {
    if (slot === 'kaikei') { state.sheetUrlKaikei = null; try { localStorage.removeItem('kate-sheet-url-kaikei'); } catch (e) {} }
    else { state.sheetUrl = null; try { localStorage.removeItem('kate-sheet-url'); } catch (e) {} }
    state.sources[slot] = null;
    // 連携を解除した以上、そのシートの失敗表示は用済み。残すと「共有設定を
    // 直してください」という消せない警告が、もう存在しない連携について出続ける。
    delete state.sheetErrors[slot];
    applySources();
    // 目標を読むファイルが変わった（または無くなった）ときだけ、目標を消して読み直す
    if (!targetsLink()) clearTargets();
    else if (!state.targets || state.targets.link !== targetsLink()) loadTargets();
    route('data', true); toast(slotMeta(slot).label + 'の連携を解除しました', 'ok');
  }
  function handleFile(file, slot) {
    toast('読み込み中…');
    global.KATE.ingest.parseFile(file).then(function (parsed) {
      var format = parsed.format, recs = parsed.records;
      state.sources[format] = { records: recs, fileName: file.name, via: 'アップロード', updatedAt: parsed.sheetUpdatedAt || null };
      state.dataLoadedAt = new Date();   // データを読み込んだ日時を記録
      delete state.sheetErrors[format]; delete state.sheetErrors[slot];   // 手動で入れ直したので失敗表示を消す
      var A = applySources();
      var reroute = format !== slot ? '（' + slotMeta(format).label + 'の形式を検出したため、そちらに読み込みました）' : '';
      var warn = A.meta.undatedRows ? '（うち' + F.int(A.meta.undatedRows) + '件は日付を読み取れず除外）' : '';
      toast('✓ ' + F.int(recs.length) + '件を再計算しました' + reroute + warn, warn ? 'err' : 'ok');
    }).catch(function (err) { console.error(err); toast('⚠ ' + (err.message || '読み込みに失敗しました'), 'err'); });
  }
  function resetAll() {
    state.sources = { yoyaku: null, kaikei: null };
    state.sheetUrl = null; state.sheetUrlKaikei = null;
    state.sheetErrors = {};   // 連携ごとクリアするので、失敗表示も残さない
    clearTargets();           // 読み込み中の「目標」の応答が後から届いても使わない
    try { localStorage.removeItem('kate-sheet-url'); localStorage.removeItem('kate-sheet-url-kaikei'); } catch (e) {}
    applySources();
  }

  // 連携中のシートが読み込めていないときの警告バナー。ビューの中ではなく
  // #sheetAlert（<main> 直下）に描くので、タブを切り替えても消えず、ビューの
  // 再描画で入力途中の値を巻き添えにすることもない。
  // 起動時の自動読み込みは silent なので、失敗すると従来は何も出ないまま
  // サンプルデータが表示され、実データだと誤認される恐れがあった。
  //
  // 取得先のURLはここに出さない。このバナーはスタッフも見る全ビューに出るため、
  // URLを載せると管理ロックが隠しているシートのIDがそのまま漏れる。原因の
  // 切り分けに要るのは経路の種別だけなので、それだけを日本語で示す。
  var KIND_JA = { export: 'CSV書き出し', gviz: 'クエリ', pub: 'ウェブ公開' };
  function sheetErrorBanner() {
    var slots = Object.keys(state.sheetErrors || {});
    if (!slots.length) return '';
    var onSample = state.source === 'サンプルデータ';
    var stages = {}, allHeld = true;
    var rows = slots.map(function (sl) {
      var e = state.sheetErrors[sl];
      var name = (slotMeta(sl) || {}).label || sl;
      stages[e.stage || 'fetch'] = true;
      var held = !!state.sources[sl];   // 前回読み込んだ内容がまだ残っているか
      if (!held) allHeld = false;
      var kinds = (e.kinds || []).map(function (k) { return KIND_JA[k] || k; });
      // 経路ごとに失敗理由が違うことがある（片方は共有設定・片方は接続遮断）。
      // 1本分だけ出すと本当の原因が隠れるため、取れた分はすべて並べる。
      var per = (e.routes || []).length
        ? '<br><span class="note-inline">' + e.routes.map(function (r) {
            return esc(KIND_JA[r.kind] || r.kind) + '：' + esc(r.message);
          }).join('<br>') + '</span>'
        : '';
      return '<li><b>' + esc(name) + '</b>：' + esc(e.message) + per +
        '<br><span class="note-inline">' + esc(ymdhmJa(e.at)) + '時点' +
        (kinds.length && !per ? '／試した取得経路：' + esc(kinds.join(' → ')) : '') +
        '／' + (held ? 'このシートは<b>前回読み込んだ内容のまま</b>です' : 'このシートの内容は<b>入っていません</b>') +
        '</span></li>';
    }).join('');
    // 見出しは「いま画面に出ている数字が何なのか」を正確に言う。サンプルなのか、
    // 前回の内容なのか、片方だけ欠けているのかで意味がまったく違う。
    var headline = onSample
      ? '（いまの表示は<u>サンプルデータ</u>です。お店の数字ではありません）'
      : allHeld
        ? '（表示中の数字は前回読み込んだ内容です）'
        : '（表示中の数字に、このシートの内容は入っていません）';
    // 原因の段階によって、打つ手はまったく違う。取得できたのに読めなかった場合に
    // 「共有設定を確認」と案内するのは誤り。
    var advice = stages.conflict
      ? '「データ」タブで<b>合言葉を入力し直す</b>と、正しい連携URLが復元されます。' +
        '（合言葉には正しい2本のURLが入っています。この端末に保存されていた方が壊れていました。）'
      : stages.fetch
        ? 'スプレッドシートの共有を「リンクを知っている全員（閲覧者）」にするか、' +
          '<code>ファイル → 共有 → ウェブに公開 → CSV</code> のURLを「データ」タブに貼り直すと解消することがあります。' +
          'ネットワーク側でGoogleへの接続が遮断されている場合もあります。'
        : 'シート自体は取得できましたが、中身を表として読み取れませんでした。' +
          '1行目の見出しが変わっていないか、連携しているタブ（gid）が正しいかを「データ」タブでご確認ください。';
    return '<div class="grid" style="margin-top:14px"><div class="col-12"><div class="gsec alert-card">' +
      '<div class="alert-t">⚠ スプレッドシートを読み込めませんでした' + headline + '</div>' +
      '<ul>' + rows + '</ul>' +
      '<div class="note-inline">' + advice + '</div>' +
      // 復旧の入口をこのバナー自身に置く。連携が壊れている端末では、データタブの
      // URL入力欄は管理ロックの内側にあり、スタッフからは辿り着けないため。
      (state.sharedBlob ? '<div style="margin-top:12px"><button class="pill accent" type="button" onclick="location.hash=\'#data\'">合言葉を入力して連携をやり直す</button></div>' : '') +
      '</div></div></div>';
  }
  // 会計明細は取得できているのに、予約データと1件も結合できなかった場合。
  // このとき会計明細は丸ごと捨てられ、予約データ単独で集計される（＝売上・店販の
  // 数字が変わる）。取得は成功しているので失敗バナーは出ず、突合レポートは
  // 管理ロックの内側にあるため、従来は誰も気づけなかった。
  function mergeAlertBanner() {
    var mr = state.mergeReport;
    if (!mr || mr.matched !== 0) return '';
    return '<div class="grid" style="margin-top:14px"><div class="col-12"><div class="gsec alert-card">' +
      '<div class="alert-t">⚠ 会計明細が予約データと1件も結合できませんでした（会計明細は集計に入っていません）</div>' +
      '<div class="note-inline">両方のシートは読み込めていますが、フリガナの表記または対象期間が一致しないため結合できず、' +
      '<b>予約データ単独で集計しています</b>。売上・客単価・店販の数字は会計実績ではなく予約金額ベースになります。' +
      '「データ」タブの突合レポートで、どの行が一致していないかを確認できます。</div>' +
      '</div></div></div>';
  }
  // 連携が1つも無く、サンプルデータを見ている状態。端末の保存領域が消えると
  // （Safari の自動削除・プライベートブラウズなど）ここに落ちるが、失敗ではないので
  // 失敗バナーは出ず、従来は概要タブの案内カードしか無かった。どのタブから開いても
  // 「これはお店の数字ではない」と分かるようにする。
  function notLinkedBanner() {
    if (!state.sharedBlob) return '';
    if (state.sheetUrl || state.sheetUrlKaikei) return '';
    if (state.source !== 'サンプルデータ') return '';
    return '<div class="grid" style="margin-top:14px"><div class="col-12"><div class="gsec alert-card">' +
      '<div class="alert-t">⚠ この端末は店舗データに接続していません（いまの表示は<u>サンプルデータ</u>です）</div>' +
      '<div class="note-inline">お店の数字ではありません。合言葉を入力すると、この端末でも実データが表示されます（入力は端末ごとに1回だけ）。</div>' +
      '<div style="margin-top:12px"><button class="pill accent" type="button" onclick="location.hash=\'#data\'">合言葉を入力する</button></div>' +
      '</div></div></div>';
  }
  // 夜間の同期がシート側で動かなかったことを、こちらから知らせる。
  //
  // ダッシュボードは取得できた内容をそのまま出すので、シートが更新されていなければ
  // 「昨日と同じ数字」が黙って出続ける。取得は成功しているため失敗バナーも出ない。
  // 判定は「直近に過ぎた23:00より前の内容しか入っていないか」。23時台のどこで
  // 同期が終わるかはGoogle任せなので、90分の猶予を置いてから警告する。
  // 判定は「まる1日ぶん抜けたか」で行う。何時に同期するかは運用で変わりうる
  // （実測では深夜2時台に走っていた）ため、特定の時刻を前提にすると、その時刻を
  // 過ぎてから実際の同期までの間、毎晩かならず誤警告が出てしまう。
  // 26時間＝毎日1回の同期が1回飛んだことを、誤警告なしに検知できる最小のしきい値。
  var SYNC_STALE_MS = 26 * 3600 * 1000;
  // 鮮度は「取得内容が最後に変わった時刻」だけで判断する。
  //
  // シート側の「データ更新日時」列は使わない。この列を書いているのはスプレッドシートの
  // 別スクリプト（tools/sheet-update-stamp.gs）で、**それだけが止まることがある**。
  // 実際に、データは正常に更新されているのにこの列が32時間止まり、「1日以上更新されて
  // いません」と誤警告した。データの鮮度とスタンプの鮮度は別物である。
  //
  // 判定材料は自分で観測した事実だけにする: 前回取得した内容のハッシュを端末に残し、
  // それが26時間以上変わらなければ警告する。まだ一度も変化を観測していない端末
  // （初めて開いた端末）では判断材料が無いので**警告しない**。翌日以降その端末が
  // 開けば、前回のハッシュと比較できるので本物の停止は必ず検知できる。
  function staleSyncSlots(now) {
    return ['yoyaku', 'kaikei'].filter(function (sl) {
      var s2 = state.sources[sl];
      if (!s2 || s2.via !== 'スプレッドシート連携') return false;
      var changed = state.contentChangedAt[sl];
      return !!changed && (now - changed) > SYNC_STALE_MS;
    });
  }
  function staleSyncBanner() {
    var now = new Date(), slots = staleSyncSlots(now);
    if (!slots.length) return '';
    // 切り分けに要る事実（取得経路・データ内の最新日・取得件数）をここに出す。
    // これらは個人情報ではないので、管理ロックの内側に置く理由が無い。実際、
    // 経路が分からないために「Google側で凍結する公開スナップURLで連携している」のか
    // 「編集URLなのに古い内容が返っている」のかを画面から判別できなかった。
    // URLそのものは絶対に出さない（シートIDが漏れる）。
    var anyPub = false;
    var rows = slots.map(function (sl) {
      var s2 = state.sources[sl], d2 = s2.diag || {};
      var changedAt = state.contentChangedAt[sl];
      var ageH = Math.floor((now - changedAt) / 3600000);
      if (d2.kind === 'pub') anyPub = true;
      var facts = [];
      if (d2.kind) facts.push('取得経路 ' + (KIND_JA[d2.kind] || d2.kind) +
        (d2.kind === 'export' ? '（常に最新）' : d2.kind === 'gviz' ? '（キャッシュ有）' : '（公開スナップ・凍結あり）'));
      if (d2.latest) facts.push('データ内の最新日 ' + ymdNumJa(d2.latest));
      if (typeof d2.rows === 'number') facts.push('取得 ' + F.int(d2.rows) + '件');
      return '<li><b>' + esc(slotJa[sl]) + '</b>：内容が最後に変わったのは ' + esc(ymdhmJa(new Date(changedAt))) +
        '（' + (ageH >= 48 ? Math.floor(ageH / 24) + '日前' : ageH + '時間前') + '）' +
        (facts.length ? '<br><span class="note-inline">' + esc(facts.join('　／　')) + '</span>' : '') +
        '</li>';
    }).join('');
    return '<div class="grid" style="margin-top:14px"><div class="col-12"><div class="gsec alert-card">' +
      '<div class="alert-t">⚠ シートの内容が1日以上変わっていません（表示中の数字はその時点のものです）</div>' +
      '<ul>' + rows + '</ul>' +
      (anyPub
        // 「ウェブに公開」URLは、公開設定の自動再公開が外れるとGoogle側で内容が
        // 公開時点に凍結する。何度読み込んでも同じ古い内容が返るため、
        // シート側が更新されていても永久に反映されない。しかもこの形式のURLは
        // ドキュメントIDを含まないため、別経路へのフォールバックが作れない。
        ? '<div class="note-inline" style="color:var(--status-critical)"><b>連携が「ウェブに公開」URLです。</b>' +
          'この形式は、公開設定の「自動的に再公開する」が外れていると<b>Google側で内容が公開時点に凍結</b>し、' +
          'シートを更新しても永久に届きません（何度更新を押しても同じ内容が返ります）。' +
          '「データ」タブで<b>通常の編集URL</b>（<code>/spreadsheets/d/…/edit</code>）に貼り替えてください。' +
          '編集URLなら常に最新を読む経路が使えます。</div>'
        : '<div class="note-inline">ダッシュボードは取得できた内容をそのまま表示しています。' +
          '止まっているのは<b>スプレッドシート側の同期</b>です。スプレッドシートの' +
          '<code>拡張機能 → Apps Script → 実行数</code>で、同期のエラーと実行時刻をご確認ください。' +
          '同期の実行時刻を毎日23時台に設定し直すスクリプトを <code>tools/sync-at-2300.gs</code> に用意しています。</div>') +
      '</div></div></div>';
  }
  function renderSheetAlert() {
    var host = $('#sheetAlert');
    if (host) host.innerHTML = sheetErrorBanner() + mergeAlertBanner() + staleSyncBanner() + notLinkedBanner();
  }

  // 再描画はビューのHTMLを丸ごと作り直すため、入力途中の値（貼り付けたURL・
  // 入力中の合言葉）が消える。夜間の自動更新の失敗など、ユーザーの操作と無関係な
  // タイミングで再描画が起きても入力を失わないよう、id を持つ入力欄の値と
  // カーソル位置を保存して復元する。
  function preserveInputs(fn) {
    var root = $('#view-' + state.view), snap = [];
    if (root) {
      Array.prototype.forEach.call(root.querySelectorAll('input[id], textarea[id]'), function (n) {
        if (n.type === 'file' || !n.value) return;
        var st = null, en = null;
        try { st = n.selectionStart; en = n.selectionEnd; } catch (e) {}
        snap.push({ id: n.id, value: n.value, focused: document.activeElement === n, start: st, end: en });
      });
    }
    fn();
    snap.forEach(function (sn) {
      var n = document.getElementById(sn.id);
      if (!n) return;
      n.value = sn.value;
      if (sn.focused) { try { n.focus(); if (sn.start !== null) n.setSelectionRange(sn.start, sn.end); } catch (e) {} }
    });
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
  // スプレッドシート連携中は、終日30分おき
  // （終日30分おき・端末の現地時刻）に自動でシートを
  // 再読み込みする。シート側の夜間同期（DailyCSVSync）がこの時間帯のどこで
  // 完了しても、30分以内にダッシュボードへ反映される。開いた瞬間に最新を
  // 取得する従来動作はそのままなので、閉じていた端末は次に開いたときに
  // 最新が入る。30分おきに読むため、1回の失敗（WiFi瞬断など）も次の回が拾う。
  // 非表示タブはブラウザがタイマーを止めるため、画面復帰時にも「直近の
  // 予定時刻より前の読み込みのままか」を確認して取りこぼしを拾う。
  // 1日の中の発火時刻（時刻順）＝終日30分おき。
  //
  // 以前は「夜間だけ」の窓（23:00〜翌1:00）にしていたが、これには2つの穴があった。
  //  ・窓の外（1:00〜23:00 の22時間）は、タイマーも発火せず、画面に戻ったときの
  //    取りこぼし判定（直近の予定時刻より前の読み込みか）も成立しないため、
  //    開きっぱなしの端末が**丸一日シートを一度も読まない**。実際に、シート側の
  //    同期が深夜2時台に走っていたため、その内容は翌日23時まで反映されなかった。
  //  ・窓の中で失敗すると、1:00の回の失敗は次が翌23:00＝22時間後になる。
  // シート側の同期が何時に走るかはダッシュボードから決められない以上、時間帯を
  // 決め打ちしないのが正しい。30分おきに見ておけば、いつ同期されても30分以内に
  // 反映され、失敗しても30分後が拾い、スリープでタイマーがずれても次の境界が
  // 最大30分先にあるので自己修復する。取得はCSV2本の軽い fetch なので負荷も小さい。
  var RELOAD_TIMES = (function () {
    var t = [];
    for (var h = 0; h < 24; h++) { t.push([h, 0]); t.push([h, 30]); }
    return t;
  })();
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
  // 更新の駆動は「1分おきに実時刻を見に行く見張り」にする。
  //
  // 以前は次の予定時刻までの長い setTimeout を1本張っていたが、これには
  // 実運用で効いてくる弱点があった:
  //  ・ブラウザのタイマーは単調時計に載っており、OSのスリープ中は進まない。
  //    ノートPCを閉じていた時間ぶん、実時刻では何時間も遅れて発火する。
  //  ・非表示タブのタイマーは間引かれ、タブが凍結されると発火自体が落ちる。
  //  ・画面をずっと表示したままの端末では visibilitychange も発火しないため、
  //    タイマーが落ちると復帰する手段が無くなる。
  // 1分おきに「直近に過ぎた予定時刻より前の読み込みのままか」を実時刻で確かめる
  // 方式なら、スリープから戻った直後・凍結が解けた直後にその場で取り戻せる。
  // 失敗しても同じ境界を何度も叩かないよう、1つの境界につき1回だけ試す。
  var WATCHDOG_MS = 60 * 1000;
  var lastAttemptBoundary = 0;
  function scheduleNightlyReload() {
    state.autoReloadNext = nextReloadAt(new Date());
    setInterval(function () {
      var now = new Date();
      state.autoReloadNext = nextReloadAt(now);
      if (!state.sheetUrl && !state.sheetUrlKaikei) return;
      var b = +lastReloadBoundary(now);
      if (lastAttemptBoundary === b) return;                       // この境界は試し済み
      if (state.dataLoadedAt && +state.dataLoadedAt >= b) return;  // すでに読めている
      lastAttemptBoundary = b;
      // 実際に発火したことを記録（端末に残すので、翌日開いたときに前回実績が分かる）
      state.autoReloadLast = now;
      try { localStorage.setItem('kate-auto-last', String(+now)); } catch (e) {}
      // ここで例外が漏れても見張りは setInterval なので止まらない
      try { reloadLinkedSheets(); } catch (e) { console.warn('auto reload failed', e); }
    }, WATCHDOG_MS);
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
    ({ home: renderHome, overview: renderOverview, staff: renderStaff, rfm: renderRFM, data: renderData }[state.view])();
    renderSheetAlert();   // ビューの外にある警告バナー（全タブ共通）も合わせて更新
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
    // 旧「傾向」タブ（#trend）は「お店」タブの「曜日・時間」に統合した。古いリンクもそこへ案内する。
    if (view === 'trend') { state.storeSeg = 'time'; view = 'overview'; force = true; }
    if (!VIEWS.includes(view)) view = 'home';
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
    // ヘッダーの日付表示: この画面の読込時刻 → （実データ未取得なら）シート側の記録 → 基準日。
    // 「最終読込」だけを主役にしているのは、シート側の「データ更新日時」列が
    // 別スクリプト由来で単独で止まりうるため（併記すると誤解を招く。上の dataStamp 参照）。
    $('#asof').textContent = state.dataLoadedAt
      ? '最終読込 ' + ymdhmJa(state.dataLoadedAt)
      : state.sheetUpdatedAt ? 'データ更新 ' + ymdhmJa(state.sheetUpdatedAt)
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
    // 税抜／税込のセグメント（ラジオボタンの組）。選択中を aria-checked で示し、
    // Tab で止まるのは選択中の1つだけにする（ラジオの決まりごと。矢印キーで切り替える）。
    var le = $('#taxLabelExcl'), li = $('#taxLabelIncl');
    if (le) { le.setAttribute('aria-checked', state.taxExcluded ? 'true' : 'false'); le.tabIndex = state.taxExcluded ? 0 : -1; }
    if (li) { li.setAttribute('aria-checked', state.taxExcluded ? 'false' : 'true'); li.tabIndex = state.taxExcluded ? -1 : 0; }
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
    var initialHash = (location.hash || '#home').slice(1);

    var mq = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)');
    setTheme(mq && mq.matches ? 'dark' : 'light');
    // OSのライト/ダーク切り替えにリアルタイム追従（チャート色も再描画）
    // 画面の色の一部（スタッフの色・グラフの線）は描くときに実際の色へ置き換えているため、
    // 切り替えたらビューごと描き直す（グラフを描き直すだけでは、見出しの色などが前のテーマのまま残る）。
    if (mq && mq.addEventListener) mq.addEventListener('change', function (e) { setTheme(e.matches ? 'dark' : 'light'); preserveInputs(renderAll); });

    injectNavIcons();
    applySources();   // no sources loaded yet → falls back to the bundled sample data

    // Auto-reconnect previously linked spreadsheets (always pull the latest)
    var savedYoyaku = null, savedKaikei = null;
    try { savedYoyaku = localStorage.getItem('kate-sheet-url'); savedKaikei = localStorage.getItem('kate-sheet-url-kaikei'); } catch (e) {}
    // 予約データと会計明細に**同じURL**が保存されているのは、過去の不具合で片方が
    // 上書きされた状態（1つのタブが両方であることはあり得ない）。どちらが正しいかは
    // 端末側からは判断できないので、壊れている方（会計明細）の連携だけ外して知らせる。
    // 正しい2本は合言葉（data/shared-link.json）に入っているので、そこから復元できる。
    var dupLink = !!(savedYoyaku && savedKaikei && savedYoyaku === savedKaikei);
    if (dupLink) {
      try { localStorage.removeItem('kate-sheet-url-kaikei'); } catch (e) {}
      savedKaikei = null;
      state.sheetErrors.kaikei = {
        message: '会計明細の連携URLが予約データと同じものになっています（この端末に保存された連携URLが壊れています）。',
        at: new Date(), stage: 'conflict', kinds: [], routes: []
      };
    }
    if (savedYoyaku) { state.sheetUrl = savedYoyaku; linkSheet(savedYoyaku, 'yoyaku', { silent: true }); }
    if (savedKaikei) { state.sheetUrlKaikei = savedKaikei; linkSheet(savedKaikei, 'kaikei', { silent: true }); }
    try {
      var la = localStorage.getItem('kate-auto-last');
      if (la) state.autoReloadLast = new Date(+la);
    } catch (e) {}
    // 「内容が最後に変わった時刻」を端末から復元する（再読込をまたいで鮮度を判断するため）
    ['yoyaku', 'kaikei'].forEach(function (sl) {
      try {
        var v = localStorage.getItem('kate-changed-' + sl);
        if (v && isFinite(+v)) state.contentChangedAt[sl] = +v;
      } catch (e) {}
    });
    scheduleNightlyReload();   // 連携中なら30分おきに自動で再読み込み

    // 合言葉: if the repo ships an encrypted shared-link blob, load it. On a
    // device with nothing linked yet, re-render so the 合言葉 card and the
    // overview banner appear (the fetch usually resolves after first paint).
    fetch('data/shared-link.json', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (blob) {
      if (!blob || blob.v !== 1) return;
      state.sharedBlob = blob;
      // 以前は「何も連携していない端末」でしか再描画していなかったため、連携が
      // 壊れている端末では復旧の案内が初回描画に出なかった。常に描き直す。
      preserveInputs(renderAll);
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
    function setTax(excluded) {
      if (state.taxExcluded === excluded) return;
      state.taxExcluded = excluded;   // true=税抜（既定）／false=税込
      try { localStorage.setItem('kate-tax', excluded ? 'excl' : 'incl'); } catch (e) {}
      applySources();  // 税抜/税込を切り替えて全指標を再計算・再描画
    }
    // 両側ラベルをクリックしてもその表示に切り替えられる
    var le = $('#taxLabelExcl'), li = $('#taxLabelIncl');
    if (le) le.addEventListener('click', function () { setTax(true); });
    if (li) li.addEventListener('click', function () { setTax(false); });
    // 矢印キーでもう一方へ（選択肢は2つなので、どの矢印でも切り替わる）。フォーカスも一緒に移す。
    var taxSeg = $('.taxseg');
    if (taxSeg && le && li) taxSeg.addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) === -1) return;
      e.preventDefault();
      var toExcl = document.activeElement === li;
      setTax(toExcl);
      (toExcl ? le : li).focus();
    });

    // routing
    global.addEventListener('hashchange', function () { route((location.hash || '#home').slice(1)); });
    route(VIEWS.includes(initialHash) || initialHash === 'trend' ? initialHash : 'home', true);

    // resize → debounced redraw of active view charts + underline
    var rt;
    global.addEventListener('resize', function () { clearTimeout(rt); var tp = document.querySelector('.kate-tip'); if (tp) tp.style.opacity = 0; rt = setTimeout(function () { moveUnderline(); placeAllThumbs(); flush(true); }, 160); });
    setTimeout(moveUnderline, 60);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
