/* ============================================================================
 * KATE-KPI · Charts
 * ----------------------------------------------------------------------------
 * A small, dependency-free SVG chart library, hand-built to the data-viz house
 * rules: thin marks, 4px rounded data-ends, 2px lines, ≥8px markers with a
 * surface ring, ~10% area washes, hairline recessive grid, a hover/tooltip
 * layer on every plot, legends for ≥2 series, and text in ink tokens (never the
 * series color). All colors come from CSS custom properties so light/dark and
 * the brand palette live in one place. Charts render at measured pixel size and
 * re-render on resize (driven by app.js), so text stays crisp.
 * ==========================================================================*/
(function (global) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  // 文字の大きさは2種類だけ: 軸・目盛り（AXIS_FS）と、棒の上の値（LABEL_FS）。
  // 11px 未満は使わない（スマホで読めない）。
  var AXIS_FS = 12, LABEL_FS = 11.5;
  var prefReduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var instant = false;                          // set during resize/theme redraws
  function noAnim() { return prefReduce || instant; }
  Object.defineProperty(global, '__kateReduce', { get: function () { return noAnim(); }, configurable: true });

  // ---- tiny DOM/format helpers --------------------------------------------
  function svgEl(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  // Escape untrusted strings (series/route/segment names from uploaded data) before
  // they enter tooltip innerHTML. Prevents XSS via a crafted スタッフ名/予約経路/クーポン.
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback || '';
  }
  function seriesColor(i) { return cssVar('--series-' + (((i) % 8) + 1), '#2a78d6'); }
  function fmtInt(n) { return Math.round(n).toLocaleString('ja-JP'); }
  function fmtYen(n) { return '¥' + fmtInt(n); }
  function fmtCompact(n) {
    var a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '億';
    if (a >= 1e4) return (n / 1e4).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + '万';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return fmtInt(n);
  }
  function fmtPct(n, d) { return (n * 100).toFixed(d == null ? 0 : d) + '%'; }
  // Y-axis max: rounds up to a clean gridline value, with just enough headroom
  // above the tallest bar/point for its value label to clear the plot's top
  // edge. The old step table (1/2/2.5/5/10) rounded coarsely — a value like
  // 1.16M jumped all the way to 2M, leaving ~40% of the chart as dead space
  // above the tallest bar. A finer table keeps the same "clean number" property
  // with far less waste.
  var NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  function niceMax(v) {
    if (!(v > 0)) return 1;   // also guards NaN
    var target = v * 1.14;
    var mag = Math.pow(10, Math.floor(Math.log10(target)));
    var norm = target / mag;
    var step = 10;
    for (var i = 0; i < NICE_STEPS.length; i++) { if (norm <= NICE_STEPS[i]) { step = NICE_STEPS[i]; break; } }
    return step * mag;
  }
  // 目盛りは「切りのいい刻み」から決める: 刻み = {1,2,2.5,5}×10^k のうち、
  // 最大値×1.14 を 3〜5 分割できるもの。軸の最大はその刻みの倍数に切り上げる。
  // 以前は最大値だけを丸めて 4 等分していたため、37.5万 / 75万 / 112.5万 のような
  // 半端な目盛りになっていた。
  function niceTicks(v, yMax) {
    if (yMax) {
      var n = 4, out = [];
      for (var i = 0; i <= n; i++) out.push(yMax * i / n);
      return { max: yMax, step: yMax / n, ticks: out };
    }
    if (!(v > 0)) v = 1;
    var target = v * 1.08;   // 値ラベルの分だけ（padT が別にある）
    // 刻みの候補を小さい方から試し、目盛りが 5 本以内に収まる最初のものを採る。
    // （最大値だけ丸める方式だと 106万 → 150万 のように上 3 割が空くことがある）
    var mag = Math.pow(10, Math.floor(Math.log10(target)) - 1);
    var STEPS = [1, 2, 2.5, 5, 10, 20, 25, 50, 100];
    var step = STEPS[STEPS.length - 1] * mag;
    for (var k = 0; k < STEPS.length; k++) { if (Math.ceil(target / (STEPS[k] * mag) - 1e-9) <= 5) { step = STEPS[k] * mag; break; } }
    var max = Math.ceil(target / step - 1e-9) * step;
    var ticks = [];
    for (var t = 0; t <= max + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
    return { max: max, step: step, ticks: ticks };
  }
  // 軸の目盛り文字（数字は等幅）
  function tickText(x, y, anchor, txt) {
    var lab = svgEl('text', { x: x, y: y, 'text-anchor': anchor, fill: ink.secondary(), 'font-size': AXIS_FS, 'font-weight': 500 });
    lab.setAttribute('font-variant-numeric', 'tabular-nums');
    lab.textContent = txt; return lab;
  }
  // 横罫（内側は薄い罫、ゼロ線は少し濃いベースライン）
  function hLine(svg, x1, x2, y, isBase) {
    var yy = Math.round(y) + 0.5;
    svg.appendChild(svgEl('line', { x1: x1, x2: x2, y1: yy, y2: yy, stroke: isBase ? ink.axis() : ink.grid(), 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
  }
  var clipSeq = 0;
  // 棒を「上だけ角丸・下は直角」にするためのクリップ。角丸の rect を下に rx ぶん
  // 伸ばして描き、この矩形で切る（アニメーション中も静的なクリップで足りる）
  function topRoundClip(svg, x, y, w, h) {
    var id = 'kcp' + (++clipSeq);
    var defs = svgEl('defs'); var cp = svgEl('clipPath', { id: id });
    cp.appendChild(svgEl('rect', { x: x - 1, y: y, width: w + 2, height: Math.max(0, h) }));
    defs.appendChild(cp); svg.appendChild(defs);
    return 'url(#' + id + ')';
  }
  // スマホ幅ではチャートを少し低くする（縦スクロールの長さを抑える）
  function chartH(w, h) { return w < 420 ? Math.round(h * 0.84) : h; }
  function ease(t) { return 1 - Math.pow(1 - t, 3); } // easeOutCubic
  function animateAttr(node, attr, from, to, dur, delay, fmt) {
    if (noAnim()) { node.setAttribute(attr, fmt ? fmt(to) : to); return; }
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start - (delay || 0)) / dur);
      if (t < 0) { requestAnimationFrame(step); return; }
      var v = from + (to - from) * ease(t);
      node.setAttribute(attr, fmt ? fmt(v) : v);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ---- shared tooltip ------------------------------------------------------
  var tip;
  function tooltip() {
    if (!tip) { tip = el('div', 'kate-tip'); tip.setAttribute('role', 'status'); document.body.appendChild(tip); }
    return tip;
  }
  function showTip(html, x, y) {
    var t = tooltip(); t.innerHTML = html; t.style.opacity = '1'; t.style.transform = 'translateY(0)';
    var r = t.getBoundingClientRect();
    var left = x - r.width / 2, top = y - r.height - 14;
    left = Math.max(8, Math.min(left, global.innerWidth - r.width - 8));
    if (top < 8) top = y + 18;
    t.style.left = left + 'px'; t.style.top = top + 'px';
  }
  function hideTip() { if (tip) { tip.style.opacity = '0'; tip.style.transform = 'translateY(4px)'; } }

  function mount(container, w, h) {
    container.innerHTML = '';
    var svg = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, width: '100%', height: h, preserveAspectRatio: 'xMidYMid meet', role: 'img' });
    svg.style.display = 'block'; svg.style.overflow = 'visible';
    container.appendChild(svg);
    return svg;
  }
  function width(container, fallback) { var w = container.clientWidth; return w > 40 ? w : (fallback || 320); }
  function legend(container, items) {
    var lg = el('div', 'kate-legend');
    items.forEach(function (it) {
      var s = el('span', 'kate-legend-item');
      var dot = el('i', 'kate-legend-dot'); dot.style.background = it.color;
      if (it.dashed || it.line) dot.classList.add('is-line');
      if (it.dashed) dot.classList.add('is-dashed');
      if (it.colors) { dot.classList.add('is-ramp'); dot.style.background = 'linear-gradient(90deg,' + it.colors.map(function (c, i, a) { var p0 = (i / a.length * 100).toFixed(1) + '%', p1 = ((i + 1) / a.length * 100).toFixed(1) + '%'; return c + ' ' + p0 + ',' + c + ' ' + p1; }).join(',') + ')'; }
      s.appendChild(dot); s.appendChild(document.createTextNode(it.label));
      lg.appendChild(s);
    });
    container.appendChild(lg);
    return lg;
  }

  // hex 色を alpha でカード面に重ねた結果の相対輝度から、白か墨かを選ぶ
  function inkOnFill(hex, alpha) {
    function rgb(c) { var m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim()); return m ? [0, 2, 4].map(function (i) { return parseInt(m[1].slice(i, i + 2), 16); }) : null; }
    var f = rgb(hex), b = rgb(ink.surface()) || [255, 255, 255];
    if (!f) return '#fff';
    var mix = f.map(function (v, i) { return v * alpha + b[i] * (1 - alpha); });
    var lin = mix.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    var L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return L > 0.35 ? '#0b0f1a' : '#fff';
  }
  var ink = { primary: function () { return cssVar('--text-primary', '#0b0b0b'); }, secondary: function () { return cssVar('--text-secondary', '#52514e'); }, muted: function () { return cssVar('--text-muted', '#898781'); }, grid: function () { return cssVar('--gridline', '#e1e0d9'); }, surface: function () { return cssVar('--surface-1', '#fff'); }, axis: function () { return cssVar('--axis', '#c3c2b7'); } };

  // ============================ LINE + AREA =================================
  // opts: { series:[{name,color?,values:[],dashed?}], xLabels:[], yFmt, valueFmt, height, yMax?, area? }
  function lineArea(container, opts) {
    var w = width(container), h = chartH(w, opts.height || 260);
    var padL = opts.padL || 38, padR = opts.padR || 16, padT = 16, padB = 34;
    var svg = mount(container, w, h);
    var series = opts.series, xs = opts.xLabels;
    var n = xs.length;
    var tk = niceTicks(Math.max.apply(null, series.reduce(function (a, s) { return a.concat(s.values.filter(function (v) { return v != null && isFinite(v); })); }, [0])), opts.yMax);
    var maxV = tk.max;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var xat = function (i) { return padL + (n <= 1 ? plotW / 2 : plotW * i / (n - 1)); };
    var yat = function (v) { return padT + plotH - (v / maxV) * plotH; };

    // 罫線と目盛り: 刻みは切りのいい値、0 以外はすべてラベル付き。0 はベースラインで示す
    tk.ticks.forEach(function (yv, g) {
      var y = yat(yv);
      hLine(svg, padL, w - padR, y, g === 0);
      if (g === 0) return;
      svg.appendChild(tickText(padL - 8, y + 4, 'end', (opts.yFmt || fmtCompact)(yv)));
    });
    // x labels
    xs.forEach(function (lx, i) {
      if (n > 8 && i % 2 !== 0 && i !== n - 1) return;
      var t = svgEl('text', { x: xat(i), y: h - 12, 'text-anchor': 'middle', fill: ink.secondary(), 'font-size': AXIS_FS, 'font-weight': 500 });
      t.textContent = lx; svg.appendChild(t);
    });

    function defined(v) { return v != null && isFinite(v); }
    var endLabelBoxes = [];   // 描画済みの終端ラベル矩形（重なり検出用・下記参照）
    series.forEach(function (s, si) {
      var color = s.color || seriesColor(si);
      if (!s.values || !s.values.length) return;   // skip empty series
      // null / non-finite values become gaps (missing data), not points at zero
      var pts = s.values.map(function (v, i) { return defined(v) ? [xat(i), yat(v)] : null; });
      var shown = pts.filter(Boolean);
      if (!shown.length) return;                    // nothing to plot for this series
      var hasGap = pts.some(function (p) { return !p; });
      if (opts.area !== false && !s.dashed && !hasGap) {
        var gid = 'grad' + si + '-' + Math.floor(xat(0));
        var defs = svgEl('defs');
        var lg2 = svgEl('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
        lg2.appendChild(svgEl('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.18 }));
        lg2.appendChild(svgEl('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0.01 }));
        defs.appendChild(lg2); svg.appendChild(defs);
        var ad = 'M' + shown.map(function (p) { return p[0] + ',' + p[1]; }).join('L') + 'L' + shown[shown.length - 1][0] + ',' + yat(0) + 'L' + shown[0][0] + ',' + yat(0) + 'Z';
        var area = svgEl('path', { d: ad, fill: 'url(#' + gid + ')', opacity: 0 });
        svg.appendChild(area); animateAttr(area, 'opacity', 0, 1, 600, 300 + si * 80);
      }
      // build the line, lifting the pen across gaps
      var d = '', pen = false;
      pts.forEach(function (p) { if (!p) { pen = false; return; } d += (pen ? 'L' : 'M') + p[0] + ',' + p[1]; pen = true; });
      var path = svgEl('path', { d: d, fill: 'none', stroke: color, 'stroke-width': series.length > 1 ? 2.2 : 2.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      if (s.dashed) path.setAttribute('stroke-dasharray', '5 5');
      svg.appendChild(path);
      if (!noAnim() && !hasGap) {
        var len = path.getTotalLength ? path.getTotalLength() : plotW;
        path.style.strokeDasharray = s.dashed ? '5 5' : len; path.style.strokeDashoffset = s.dashed ? 0 : len;
        if (!s.dashed) { path.getBoundingClientRect(); path.style.transition = 'stroke-dashoffset 900ms cubic-bezier(.22,.61,.36,1) ' + (si * 90) + 'ms'; path.style.strokeDashoffset = 0; }
      }
      // dots at each real point (helps read sparse / gapped series)
      // 各点は「面のリング付き」の点にして、線が重なっても点が見分けられるようにする
      shown.forEach(function (p) { svg.appendChild(svgEl('circle', { cx: p[0], cy: p[1], r: 3.2, fill: color, stroke: ink.surface(), 'stroke-width': 1.5 })); });
      // end marker + label
      var last = shown[shown.length - 1];
      var ring = svgEl('circle', { cx: last[0], cy: last[1], r: 5, fill: color, stroke: ink.surface(), 'stroke-width': 2 });
      svg.appendChild(ring);
      if (s.endLabel !== false && !s.dashed) {
        // y is the text BASELINE: clamp so the glyphs never poke above the SVG
        // when the series ends at/near the axis maximum (e.g. a 100% month on
        // a yMax:100 chart put the label's top edge at a negative y).
        var ly = Math.max(last[1] - 10, 12);
        var lbl = svgEl('text', { x: last[0], y: ly, 'text-anchor': 'end', fill: ink.primary(), 'font-size': 12, 'font-weight': 700, opacity: 0 });
        lbl.textContent = s.name; svg.appendChild(lbl);
        // 系列の終端が近い（別の月で終わる／値が接近する）と、終端ラベル同士が
        // 重なって判読不能になる。重なる場合はラベルを出さない（凡例で名前は追える）。
        var lw = lbl.getComputedTextLength ? lbl.getComputedTextLength() : String(s.name).length * 12;
        var box = { x1: last[0] - lw, x2: last[0], y1: ly - 12, y2: ly + 3 };
        var hits = endLabelBoxes.some(function (b) { return box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1; });
        if (hits) svg.removeChild(lbl);
        else { endLabelBoxes.push(box); animateAttr(lbl, 'opacity', 0, 1, 400, 900); }
      }
    });

    // crosshair + hover
    var focus = svgEl('line', { x1: 0, x2: 0, y1: padT, y2: padT + plotH, stroke: ink.axis(), 'stroke-width': 1, opacity: 0 });
    svg.appendChild(focus);
    var dots = series.map(function (s, si) { var c = svgEl('circle', { r: 4, fill: s.color || seriesColor(si), stroke: ink.surface(), 'stroke-width': 2, opacity: 0 }); svg.appendChild(c); return c; });
    var hit = svgEl('rect', { x: padL, y: padT, width: Math.max(1, plotW), height: plotH, fill: 'transparent' });
    svg.appendChild(hit);
    function onMove(ev) {
      var box = svg.getBoundingClientRect();
      var mx = (ev.clientX - box.left) / box.width * w;
      var i = Math.max(0, Math.min(n - 1, Math.round((mx - padL) / (plotW / Math.max(1, n - 1)))));
      focus.setAttribute('x1', xat(i)); focus.setAttribute('x2', xat(i)); focus.setAttribute('opacity', 1);
      var rows = series.map(function (s, si) {
        var v = s.values[i];
        if (!defined(v)) { dots[si].setAttribute('opacity', 0); return '<div class="kate-tip-row"><i style="background:' + (s.color || seriesColor(si)) + '"></i><span>' + esc(s.name) + '</span><b>—</b></div>'; }
        dots[si].setAttribute('cx', xat(i)); dots[si].setAttribute('cy', yat(v)); dots[si].setAttribute('opacity', 1);
        return '<div class="kate-tip-row"><i style="background:' + (s.color || seriesColor(si)) + '"></i><span>' + esc(s.name) + '</span><b>' + (opts.valueFmt || fmtCompact)(v) + '</b></div>';
      }).join('');
      showTip('<div class="kate-tip-title">' + esc(xs[i]) + '</div>' + rows, ev.clientX, box.top + yat(maxV));
    }
    function clearFocus() { focus.setAttribute('opacity', 0); dots.forEach(function (d) { d.setAttribute('opacity', 0); }); hideTip(); }
    hit.addEventListener('mousemove', onMove);
    // The whole hit rect is the scrub surface (unlike discrete bars, there's no
    // "gap" to leave scroll alone in) — block vertical page scroll for the
    // duration of any touch that starts here, same reasoning as enableDragReveal.
    hit.addEventListener('touchstart', function (e) { if (e.touches[0]) { e.preventDefault(); onMove(e.touches[0]); } }, { passive: false });
    hit.addEventListener('touchmove', function (e) { if (e.touches[0]) { e.preventDefault(); onMove(e.touches[0]); } }, { passive: false });
    hit.addEventListener('mouseleave', clearFocus);
    hit.addEventListener('touchend', clearFocus);
    hit.addEventListener('touchcancel', clearFocus);
    if (series.length >= 2) legend(container, series.map(function (s, si) { return { label: s.name, color: s.color || seriesColor(si), dashed: s.dashed, line: true }; }));
  }

  // A value label floating on/above a bar (stacked total, per-bar value, or
  // cluster total) shows the bare number only — no ¥/万/億/k/%/件/人 unit
  // suffix — since the axis and the card's tag chip already establish the
  // unit; repeating it on every bar just adds clutter and, for money, forces
  // long strings to compress illegibly. Strips a leading currency symbol and
  // any trailing non-numeric suffix, keeping digits/commas/one decimal point.
  function stripUnit(text) {
    var s = String(text).replace(/^[¥$€]/, '');
    var m = /^([+\-]?[\d,]*\.?\d+)/.exec(s);
    return m ? m[1] : s;
  }
  // Centered value label above a bar. If the natural text would be wider than
  // maxWidth, it's compressed via SVG textLength (not wrapped) so it never
  // overflows the bar it sits above — used for per-bar/per-cluster totals,
  // which get cramped on narrow mobile bars once there are 2+ series.
  // 値ラベルは1種類の大きさ（LABEL_FS・太字・本文色）。棒幅に収まらないときは
  // 字を横に潰さず（潰すと読めない）、ラベルを出さない。数値はツールチップと
  // 表で必ず追える。少しだけ超える場合（+40%まで）は隣と重ならないので許容する。
  function fitValueLabel(svg, x, y, text, maxWidth, fontSize) {
    var t = svgEl('text', { x: x, y: y, 'text-anchor': 'middle', fill: ink.primary(), 'font-size': fontSize || LABEL_FS, 'font-weight': 700 });
    t.setAttribute('font-variant-numeric', 'tabular-nums');
    t.textContent = stripUnit(text);
    svg.appendChild(t);
    if (maxWidth > 0 && t.getComputedTextLength) {
      var natural = t.getComputedTextLength();
      if (natural > maxWidth * 1.4) { svg.removeChild(t); return null; }
    }
    return t;
  }

  // ============================ COLUMNS (grouped / stacked) =================
  // opts: { groups:[label], series:[{name,color?,values:[]}], stacked?, height, valueFmt, totalFmt?, yFmt }
  function columns(container, opts) {
    var w = width(container), h = chartH(w, opts.height || 260);
    var padL = opts.padL || 36, padR = 14, padT = opts.stacked ? 26 : 22, padB = 34;
    var svg = mount(container, w, h);
    var groups = opts.groups, series = opts.series, ng = groups.length;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var totals = groups.map(function (_, gi) { return series.reduce(function (a, s) { return a + Math.max(0, s.values[gi]); }, 0); });
    var tk = niceTicks(opts.stacked ? Math.max.apply(null, totals.concat([0])) : Math.max.apply(null, series.reduce(function (a, s) { return a.concat(s.values); }, [0])), opts.yMax);
    var maxV = tk.max;
    var yat = function (v) { return padT + plotH - (v / maxV) * plotH; };
    var band = plotW / ng;
    var GAP = 2;

    tk.ticks.forEach(function (yv, g) {
      var y = yat(yv);
      hLine(svg, padL, w - padR, y, g === 0);
      if (g === 0) return;
      svg.appendChild(tickText(padL - 8, y + 4, 'end', (opts.yFmt || fmtCompact)(yv)));
    });

    groups.forEach(function (glabel, gi) {
      var cx = padL + band * gi + band / 2;
      var t = svgEl('text', { x: cx, y: h - 12, 'text-anchor': 'middle', fill: ink.secondary(), 'font-size': AXIS_FS, 'font-weight': 500 });
      t.textContent = glabel; svg.appendChild(t);
      var groupBars = [];   // この列の棒（幅いっぱいの当たり判定から最寄りの棒へ転送する）
      if (opts.stacked) {
        var barW = Math.min(30, band * 0.62), x = cx - barW / 2, acc = 0;
        var stackRows = stackTipRows(series, gi, opts);
        series.forEach(function (s, si) {
          var v = Math.max(0, s.values[gi]); if (v <= 0) return;
          var y0 = yat(acc), y1 = yat(acc + v); acc += v;
          var isTop = (function () { for (var k = si + 1; k < series.length; k++) if (series[k].values[gi] > 0) return false; return true; })();
          var isBottom = (function () { for (var k = 0; k < si; k++) if (series[k].values[gi] > 0) return false; return true; })();
          // 積み上げの境目に 2px の面色の隙間を空ける（上の段の下端を 2px 削る）
          var yBot = isBottom ? y0 : y0 - 2;
          var rectH = Math.max(0, yBot - y1);
          var rx = isTop ? Math.min(4, barW / 3) : 0;
          var rect = svgEl('rect', { x: x, y: y1, width: barW, height: 0, fill: s.color || seriesColor(si), rx: rx });
          if (rx) rect.setAttribute('clip-path', topRoundClip(svg, x, y1, barW, rectH));
          if (s.opacity != null) rect.setAttribute('fill-opacity', s.opacity);
          rect.style.cursor = 'default'; svg.appendChild(rect);
          animateAttr(rect, 'height', 0, rectH + rx, 700, gi * 40 + si * 30);
          animateAttr(rect, 'y', yBot, y1, 700, gi * 40 + si * 30);
          bindBarTip(rect, svg, w, glabel, s, si, v, opts, undefined, stackRows, padT);
          groupBars.push(rect);
        });
        if (acc > 0) {
          fitValueLabel(svg, cx, yat(acc) - 7, (opts.totalFmt || opts.valueFmt || fmtCompact)(acc), band - 4, LABEL_FS);
        }
      } else {
        var innerW = band * 0.72, bw = Math.min(30, innerW / series.length - GAP);
        var showBarLabels = bw >= 5;
        series.forEach(function (s, si) {
          var v = Math.max(0, s.values[gi]);
          var x = cx - innerW / 2 + si * (bw + GAP), y1 = yat(v), rectH = padT + plotH - y1;
          var rx = Math.min(4, bw / 3);
          var rect = svgEl('rect', { x: x, y: padT + plotH, width: bw, height: 0, fill: s.color || seriesColor(si), rx: rx });
          // 下端はベースラインで直角に切る（カプセル形にしない）
          rect.setAttribute('clip-path', topRoundClip(svg, x, padT, bw, plotH));
          svg.appendChild(rect);
          animateAttr(rect, 'height', 0, rectH + rx, 700, gi * 40 + si * 40);
          animateAttr(rect, 'y', padT + plotH, y1, 700, gi * 40 + si * 40);
          bindBarTip(rect, svg, w, glabel, s, si, v, opts, undefined, null, padT);
          groupBars.push(rect);
          if (showBarLabels && v > 0) {
            // 1系列なら列の幅いっぱい、複数系列なら隣の棒と重ならない幅まで
            fitValueLabel(svg, x + bw / 2, y1 - 6, (opts.totalFmt || opts.valueFmt || fmtCompact)(v), series.length === 1 ? band - 4 : bw + GAP + 2, LABEL_FS);
          }
        });
      }
      hitBand(svg, padL + band * gi, padT, band, plotH, groupBars);
    });
    enableDragReveal(svg);
    // 見込み(opacity付き)の重畳シリーズは、実績シリーズと同色で凡例上は見分けが
    // つかず単なる重複行になるため、凡例には含めない（薄色である旨は help() 側で
    // 説明する）。
    var legendSeries = opts.hideLegend ? [] : series.filter(function (s) { return s.opacity == null; });
    if (legendSeries.length >= 2) legend(container, legendSeries.map(function (s, si) { return { label: s.name, color: s.color || seriesColor(si) }; }));
  }
  // ==================== CLUSTERED STACKED COLUMNS ==========================
  // Like columns({stacked:true}) but bars are grouped into visual clusters
  // (e.g. one cluster per month, one stacked bar per staff inside it): a
  // bigger gap separates clusters than separates bars within one, and each
  // cluster gets a single shared label instead of one label per bar. Keeps
  // related bars visually adjacent instead of spreading everything evenly
  // across the whole width (which reads as unrelated, disconnected columns).
  // opts: { groups, clusterSize, subLabels?, subColors?,
  //         series:[{name,color,opacity?,values}] (flat, cluster-major then
  //         sub-index-minor, length = groups.length*clusterSize),
  //         yMax?, valueFmt?, yFmt?, height? }
  function columnClusters(container, opts) {
    var w = width(container), h = chartH(w, opts.height || 260);
    var padL = opts.padL || 36, padR = 14, padT = 26, padB = 44;
    var svg = mount(container, w, h);
    var groups = opts.groups, series = opts.series, clusterSize = opts.clusterSize || 1;
    var nClusters = groups.length, nBars = nClusters * clusterSize;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var totals = [];
    for (var bi0 = 0; bi0 < nBars; bi0++) totals.push(series.reduce(function (a, s) { return a + Math.max(0, s.values[bi0] || 0); }, 0));
    var tk = niceTicks(Math.max.apply(null, totals.concat([0])), opts.yMax);
    var maxV = tk.max;
    var yat = function (v) { return padT + plotH - (v / maxV) * plotH; };
    var clusterBand = plotW / nClusters, innerGap = 4;

    tk.ticks.forEach(function (yv, g) {
      var y = yat(yv);
      hLine(svg, padL, w - padR, y, g === 0);
      if (g === 0) return;
      svg.appendChild(tickText(padL - 8, y + 4, 'end', (opts.yFmt || fmtCompact)(yv)));
    });

    var barW = Math.max(6, Math.min(26, (clusterBand * 0.74 - innerGap * (clusterSize - 1)) / clusterSize));
    // Per-bar text labels need real room to stay legible; below that, skip the
    // text and rely on the color tick (still readable at any width) plus the
    // tooltip. Prevents adjacent labels merging into unreadable text on narrow
    // (mobile) screens.
    var showSubLabels = !!opts.subLabels && (clusterBand / clusterSize) >= 18;
    // Per-bar totals: 全ての棒に数値を表示する（fitValueLabel が棒幅に収まるよう
    // 圧縮するため、狭い棒でもはみ出さない）。ごく僅かな幅のみ描画を省く。
    var showTotals = (clusterBand / clusterSize) >= 10;
    function colorFor(s, si, bi) { return (typeof s.color === 'function' ? s.color(bi) : s.color) || seriesColor(si); }
    groups.forEach(function (glabel, ci) {
      var clusterCx = padL + clusterBand * ci + clusterBand / 2;
      var groupInnerW = barW * clusterSize + innerGap * (clusterSize - 1);
      var t = svgEl('text', { x: clusterCx, y: h - (showSubLabels ? 25 : 12), 'text-anchor': 'middle', fill: ink.secondary(), 'font-size': AXIS_FS, 'font-weight': 600 });
      t.textContent = glabel; svg.appendChild(t);
      for (var k = 0; k < clusterSize; k++) {
        var bi = ci * clusterSize + k;
        var bx = clusterCx - groupInnerW / 2 + k * (barW + innerGap);
        if (showSubLabels) {
          var slab = svgEl('text', { x: bx + barW / 2, y: h - 11, 'text-anchor': 'middle', fill: ink.secondary(), 'font-size': 10.5, 'font-weight': 500 });
          slab.textContent = opts.subLabels[bi]; svg.appendChild(slab);
        }
        if (opts.subColors) {
          svg.appendChild(svgEl('rect', { x: bx, y: padT + plotH + 4, width: barW, height: 3, rx: 1.5, fill: opts.subColors[bi] }));
        }
        var acc = 0, bars = [];
        var rowsHtml = stackTipRows(series, bi, opts, function (s, si) { return colorFor(s, si, bi); });
        series.forEach(function (s, si) {
          var v = Math.max(0, s.values[bi] || 0); if (v <= 0) return;
          var y0 = yat(acc), y1 = yat(acc + v); acc += v;
          var isTop = (function () { for (var kk = si + 1; kk < series.length; kk++) if ((series[kk].values[bi] || 0) > 0) return false; return true; })();
          var isBottom = (function () { for (var kk = 0; kk < si; kk++) if ((series[kk].values[bi] || 0) > 0) return false; return true; })();
          var yBot = isBottom ? y0 : y0 - 2, rectH = Math.max(0, yBot - y1);
          var color = colorFor(s, si, bi);
          var rx = isTop ? Math.min(3, barW / 3) : 0;
          var rect = svgEl('rect', { x: bx, y: y1, width: barW, height: 0, fill: color, rx: rx });
          if (rx) rect.setAttribute('clip-path', topRoundClip(svg, bx, y1, barW, rectH));
          if (s.opacity != null) rect.setAttribute('fill-opacity', s.opacity);
          rect.style.cursor = 'default'; svg.appendChild(rect);
          animateAttr(rect, 'height', 0, rectH + rx, 700, ci * 40 + si * 20);
          animateAttr(rect, 'y', yBot, y1, 700, ci * 40 + si * 20);
          bindBarTip(rect, svg, w, glabel + (opts.subLabels ? ' ・ ' + opts.subLabels[bi] : ''), s, si, v, opts, color, rowsHtml, padT);
          bars.push(rect);
        });
        hitBand(svg, bx - innerGap / 2, padT, barW + innerGap, plotH, bars);
        if (showTotals && acc > 0) {
          fitValueLabel(svg, bx + barW / 2, yat(acc) - 6, (opts.totalFmt || opts.valueFmt || fmtCompact)(acc), barW + innerGap + 2, LABEL_FS);
        }
      }
    });
    enableDragReveal(svg);
    if (opts.legendItems && opts.legendItems.length) legend(container, opts.legendItems);
    else if (!opts.hideLegend && series.length >= 2) legend(container, series.map(function (s, si) { return { label: s.name, color: (typeof s.color === 'function' ? s.color(0) : s.color) || seriesColor(si) }; }));
  }

  // 積み上げ棒のツールチップ行: その列のすべての段＋合計（1段だけなら合計は出さない）
  function stackTipRows(series, gi, opts, colorAt) {
    var rows = [], total = 0, cnt = 0;
    series.forEach(function (s, si) {
      var v = Math.max(0, (s.values[gi] || 0)); if (v <= 0) return;
      total += v; cnt++;
      var c = colorAt ? colorAt(s, si) : (s.color || seriesColor(si));
      rows.push('<div class="kate-tip-row"><i style="background:' + c + '"></i><span>' + esc(s.name) + '</span><b>' + (opts.valueFmt || fmtCompact)(v) + '</b></div>');
    });
    if (cnt >= 2) rows.push('<div class="kate-tip-row kate-tip-total"><i></i><span>合計</span><b>' + (opts.totalFmt || opts.valueFmt || fmtCompact)(total) + '</b></div>');
    return rows.join('');
  }
  function bindBarTip(rect, svg, w, glabel, s, si, v, opts, color, rowsHtml, padT) {
    color = color || s.color || seriesColor(si);
    var html = '<div class="kate-tip-title">' + esc(glabel) + '</div>' +
      (rowsHtml || '<div class="kate-tip-row"><i style="background:' + color + '"></i><span>' + esc(s.name) + '</span><b>' + (opts.valueFmt || fmtCompact)(v) + '</b></div>');
    function anchorY() { var box = svg.getBoundingClientRect(); return padT != null ? box.top + padT - 6 : box.top + rect.getBBox().y; }
    function show(clientX) {
      rect.style.filter = 'brightness(1.08)';
      // 棒の上の値ラベルを隠さないよう、プロットの上端に出す
      showTip(html, clientX, anchorY());
    }
    rect.__showTip = show;
    rect.__clearHi = function () { rect.style.filter = ''; };
    rect.addEventListener('mouseenter', function (ev) { show(ev.clientX); });
    rect.addEventListener('mousemove', function (ev) { showTip(tooltip().innerHTML, ev.clientX, anchorY()); });
    rect.addEventListener('mouseleave', function () { rect.style.filter = ''; hideTip(); });
  }
  // 列の幅いっぱいの透明な当たり判定。細い棒（スマホで 8〜12px）でも、その列の
  // どこを触っても最寄りの棒のツールチップが出る。elementFromPoint で解決する
  // タッチのなぞり（enableDragReveal）にも同じ __showTip で乗る。
  function hitBand(svg, x, y, w, h, bars) {
    if (!bars || !bars.length) return;
    var band = svgEl('rect', { x: x, y: y, width: Math.max(1, w), height: Math.max(1, h), fill: 'transparent' });
    var cur = null;
    function nearest(clientX) {
      var best = null, bd = Infinity;
      bars.forEach(function (b) {
        var bb = b.getBoundingClientRect(), cx = (bb.left + bb.right) / 2;
        var d = Math.abs(clientX - cx);
        if (d < bd) { bd = d; best = b; }
      });
      return best;
    }
    function show(clientX) {
      var b = nearest(clientX);
      if (b !== cur && cur && cur.__clearHi) cur.__clearHi();
      cur = b;
      if (b && b.__showTip) b.__showTip(clientX);
    }
    band.__showTip = show;
    band.__clearHi = function () { if (cur && cur.__clearHi) cur.__clearHi(); cur = null; };
    band.addEventListener('mouseenter', function (ev) { show(ev.clientX); });
    band.addEventListener('mousemove', function (ev) { show(ev.clientX); });
    band.addEventListener('mouseleave', function () { band.__clearHi(); hideTip(); });
    svg.appendChild(band);
  }
  // Touch devices don't fire mouseenter/mouseleave while a single continuous
  // touch drags across neighboring elements (the touch target stays pinned to
  // wherever the gesture started), so sliding a finger across a stacked bar's
  // segments — or a donut's wedges, a heatmap's cells, a scatter's points —
  // would otherwise only ever reveal whichever one the touch started on. Bind
  // at the SVG level instead and resolve the element under the finger on every
  // move. Works for any shape (rect/path/circle) that has a `__showTip`
  // callback attached; an optional `__clearHi` lets an element restore its own
  // highlight style on the way out (falls back to clearing `style.filter`,
  // the convention used by bar highlighting).
  function enableDragReveal(svg) {
    var last = null;
    var active = false; // true once a gesture starts on an actual bar/segment/point
    function resolve(x, y) {
      var e = document.elementFromPoint(x, y);
      return (e && e.__showTip) ? e : null;
    }
    function clear(e) { if (!e) return; if (e.__clearHi) e.__clearHi(); else e.style.filter = ''; }
    function handle(x, y) {
      var e = resolve(x, y);
      if (e === last) { if (e) e.__showTip(x); return; }
      clear(last);
      last = e;
      if (e) e.__showTip(x); else hideTip();
    }
    function end() { clear(last); last = null; active = false; hideTip(); }
    // Only hijack the page's vertical scroll once the finger actually lands on a
    // bar/segment/point — that's the signal the user meant to interact with the
    // chart, not scroll past it. Once a gesture "belongs" to the chart it keeps
    // blocking scroll for its duration, even while briefly crossing a gap between
    // bars, so the page doesn't lurch mid-drag.
    svg.addEventListener('touchstart', function (ev) {
      var t = ev.touches[0]; if (!t) return;
      active = !!resolve(t.clientX, t.clientY);
      if (active) ev.preventDefault();
      handle(t.clientX, t.clientY);
    }, { passive: false });
    svg.addEventListener('touchmove', function (ev) {
      var t = ev.touches[0]; if (!t) return;
      if (active) ev.preventDefault();
      handle(t.clientX, t.clientY);
    }, { passive: false });
    svg.addEventListener('touchend', end);
    svg.addEventListener('touchcancel', end);
  }

  // ============================ DONUT ======================================
  // opts: { segments:[{label,value,color?}], height, centerLabel, centerValue, valueFmt }
  function donut(container, opts) {
    var h = opts.height || 220, w = width(container, h);
    var size = Math.min(w, h), cx = w / 2, cy = h / 2, R = size / 2 - 6, r = R * 0.62;
    var svg = mount(container, w, h);
    var segs = opts.segments.filter(function (s) { return s.value > 0; });
    var total = segs.reduce(function (a, s) { return a + s.value; }, 0) || 1;
    var a0 = -Math.PI / 2, GAP = 0.02;
    segs.forEach(function (s, i) {
      var frac = s.value / total, a1 = a0 + frac * Math.PI * 2;
      var path = svgEl('path', { d: arc(cx, cy, R, r, a0 + GAP, a1 - GAP), fill: s.color || seriesColor(i) });
      path.style.transformOrigin = cx + 'px ' + cy + 'px';
      svg.appendChild(path);
      if (!noAnim()) { path.style.opacity = 0; path.style.transform = 'scale(.85)'; path.getBoundingClientRect(); path.style.transition = 'opacity .5s ease ' + (i * 70) + 'ms, transform .5s cubic-bezier(.34,1.56,.64,1) ' + (i * 70) + 'ms'; path.style.opacity = 1; path.style.transform = 'scale(1)'; }
      function show(clientX) { path.style.filter = 'brightness(1.07)'; var box = svg.getBoundingClientRect(); showTip('<div class="kate-tip-row"><i style="background:' + (s.color || seriesColor(i)) + '"></i><span>' + esc(s.label) + '</span><b>' + (opts.valueFmt || fmtInt)(s.value) + ' · ' + fmtPct(frac, 1) + '</b></div>', clientX, box.top + cy - R); }
      path.__showTip = show;
      path.addEventListener('mouseenter', function (ev) { show(ev.clientX); });
      path.addEventListener('mouseleave', function () { path.style.filter = ''; hideTip(); });
      a0 = a1;
    });
    if (opts.centerValue != null) {
      var cv = svgEl('text', { x: cx, y: cy + 2, 'text-anchor': 'middle', fill: ink.primary(), 'font-size': Math.round(size * 0.16), 'font-weight': 700 });
      cv.textContent = opts.centerValue; svg.appendChild(cv);
      if (opts.centerLabel) { var cl = svgEl('text', { x: cx, y: cy + size * 0.13, 'text-anchor': 'middle', fill: ink.secondary(), 'font-size': AXIS_FS, 'font-weight': 500 }); cl.textContent = opts.centerLabel; svg.appendChild(cl); }
    }
    enableDragReveal(svg);
    legend(container, segs.map(function (s, i) { return { label: s.label + ' · ' + fmtPct(s.value / total, 0), color: s.color || seriesColor(i) }; }));
  }
  function arc(cx, cy, R, r, a0, a1) {
    var large = (a1 - a0) > Math.PI ? 1 : 0;
    var x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0), x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
    var xi1 = cx + r * Math.cos(a1), yi1 = cy + r * Math.sin(a1), xi0 = cx + r * Math.cos(a0), yi0 = cy + r * Math.sin(a0);
    return 'M' + x0 + ',' + y0 + 'A' + R + ',' + R + ' 0 ' + large + ' 1 ' + x1 + ',' + y1 + 'L' + xi1 + ',' + yi1 + 'A' + r + ',' + r + ' 0 ' + large + ' 0 ' + xi0 + ',' + yi0 + 'Z';
  }

  // ============================ FUNNEL =====================================
  // opts: { stages:[{label,value,sub?}], height, valueFmt }
  function funnel(container, opts) {
    container.innerHTML = '';
    var wrap = el('div', 'kate-funnel');
    var max = Math.max.apply(null, opts.stages.map(function (s) { return s.value; })) || 1;
    var ramp = ['--funnel-1', '--funnel-2', '--funnel-3', '--funnel-4', '--funnel-5'];
    opts.stages.forEach(function (s, i) {
      var row = el('div', 'kate-funnel-row');
      var head = el('div', 'kate-funnel-head');
      head.appendChild(el('span', 'kate-funnel-label', s.label));
      var val = el('span', 'kate-funnel-val'); val.innerHTML = '<b>' + (opts.valueFmt || fmtInt)(s.value) + '</b>' + (s.sub ? ' <em>' + s.sub + '</em>' : '');
      head.appendChild(val); row.appendChild(head);
      var track = el('div', 'kate-funnel-track');
      var bar = el('div', 'kate-funnel-bar');
      bar.style.background = cssVar(ramp[Math.min(i, 4)], seriesColor(0));
      bar.style.setProperty('--w', (s.value / max * 100) + '%');
      // 1人だけの段でも棒が消えないよう最小幅を持たせる（0人は幅0のまま）
      if (s.value > 0) bar.style.minWidth = '4px';
      bar.style.width = noAnim() ? (s.value / max * 100) + '%' : '0%';
      track.appendChild(bar); row.appendChild(track);
      wrap.appendChild(row);
      if (!noAnim()) requestAnimationFrame(function () { setTimeout(function () { bar.style.width = (s.value / max * 100) + '%'; }, 120 + i * 110); });
      if (i < opts.stages.length - 1) {
        // 継続率は stage.cont（engine 側で「次段の到達 ÷ この段の到達」＝棒と同じ
        // 予約ベース）を優先。無ければバー比にフォールバック。分母・分子があれば併記する。
        // 段が6つ以上でも色は5段階の濃淡を使い切ったあと一番濃い色で揃える（clamp）。
        var cont = (s.cont != null) ? s.cont
          : (s.value ? opts.stages[i + 1].value / s.value : null);
        var conv = el('div', 'kate-funnel-conv');
        var frac = (s.contNum != null && s.contDen != null)
          ? ' <em class="kate-funnel-frac">' + fmtInt(s.contNum) + '人 ÷ ' + fmtInt(s.contDen) + '人</em>' : '';
        // この段に誰もいなければ継続率は定義できない（「0% · 離脱 100%」と出さない）
        conv.innerHTML = cont == null
          ? '<span class="kate-arrow">↓</span> 継続 <b>—</b> <em class="kate-funnel-frac">（この段に到達した方がいません）</em>'
          : '<span class="kate-arrow">↓</span> 継続 <b>' + fmtPct(cont, 0) + '</b><span class="kate-funnel-churn"> · 離脱 ' + fmtPct(1 - cont, 0) + '</span>' + frac;
        wrap.appendChild(conv);
      }
    });
    container.appendChild(wrap);
  }

  // ============================ HEATMAP (F×R) ==============================
  // opts: { matrix:[[]], rowLabels, colLabels, height, hueVar, cellLabel }
  function heatmap(container, opts) {
    var m = opts.matrix, rows = m.length, cols = m[0].length;
    var w = width(container), cell = Math.min(84, (w - 44) / cols), h = cell * rows + 46;
    var svg = mount(container, w, h);
    var padL = 40, padT = 22;
    // 狭いセルでは列ラベルが重なるので、数字だけにして 1 つおきに出す
    var tightCols = cell < 30;
    var colLabelAt = function (c) {
      var cl = String(opts.colLabels[c]);
      if (!tightCols) return cl;
      if (c % 2 === 1) return '';
      var m = /^(\d+)/.exec(cl); return m ? m[1] : cl;
    };
    var max = Math.max.apply(null, m.reduce(function (a, r) { return a.concat(r); }, [0])) || 1;
    var base = opts.hue || cssVar('--series-1', '#2a78d6');
    opts.colLabels.forEach(function (cl, c) { var lbl = colLabelAt(c); if (!lbl) return; var t = svgEl('text', { x: padL + c * cell + cell / 2, y: padT - 8, 'text-anchor': 'middle', fill: ink.secondary(), 'font-size': AXIS_FS, 'font-weight': 500 }); t.textContent = lbl; svg.appendChild(t); });
    opts.rowLabels.forEach(function (rl, r) { var t = svgEl('text', { x: padL - 8, y: padT + r * cell + cell / 2 + 4, 'text-anchor': 'end', fill: ink.secondary(), 'font-size': AXIS_FS, 'font-weight': 500 }); t.textContent = rl; svg.appendChild(t); });
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
      (function (r, c) {
        var v = m[r][c], intensity = v / max;
        var x = padL + c * cell, y = padT + r * cell;
        var rect = svgEl('rect', { x: x + 1.5, y: y + 1.5, width: cell - 3, height: cell - 3, rx: 6, fill: base, 'fill-opacity': v === 0 ? 0.05 : (0.14 + intensity * 0.82) });
        svg.appendChild(rect);
        if (!noAnim()) { rect.style.opacity = 0; rect.getBoundingClientRect(); rect.style.transition = 'opacity .5s ease ' + ((r + c) * 45) + 'ms'; rect.style.opacity = 1; }
        // セルの文字色は「塗りを面に重ねた結果の明るさ」で決める（濃さの割合で決めると、
        // ダークでは薄い青の上に白が乗って読めなかった）
        if (v > 0) { var t = svgEl('text', { x: x + cell / 2, y: y + cell / 2 + 4, 'text-anchor': 'middle', fill: inkOnFill(base, v === 0 ? 0.05 : (0.14 + intensity * 0.82)), 'font-size': tightCols ? 11 : 12.5, 'font-weight': 700 }); t.textContent = v; svg.appendChild(t); }
        function show(clientX) { rect.setAttribute('stroke', base); rect.setAttribute('stroke-width', 2); var box = svg.getBoundingClientRect(); showTip('<div class="kate-tip-row"><span>' + esc(opts.rowLabels[r]) + ' × ' + esc(opts.colLabels[c]) + '</span><b>' + v + esc(opts.unit || '人') + '</b></div>', clientX, box.top + y); }
        rect.__showTip = show;
        rect.__clearHi = function () { rect.removeAttribute('stroke'); };
        rect.addEventListener('mouseenter', function (ev) { show(ev.clientX); });
        rect.addEventListener('mouseleave', function () { rect.__clearHi(); hideTip(); });
      })(r, c);
    }
    enableDragReveal(svg);
  }

  // ============================ HORIZONTAL BARS ============================
  // opts: { items:[{label,value,sub?,color?}], height, valueFmt, max?, accentBest? }
  function hbars(container, opts) {
    container.innerHTML = '';
    var wrap = el('div', 'kate-hbars');
    var max = opts.max || Math.max.apply(null, opts.items.map(function (i) { return i.value; })) || 1;
    var best = Math.max.apply(null, opts.items.map(function (i) { return i.value; }));
    opts.items.forEach(function (it, i) {
      var row = el('div', 'kate-hbar');
      var head = el('div', 'kate-hbar-head');
      head.appendChild(el('span', 'kate-hbar-label', it.label));
      var v = el('span', 'kate-hbar-val'); v.innerHTML = '<b>' + (opts.valueFmt || fmtInt)(it.value) + '</b>' + (it.sub ? ' <em>' + it.sub + '</em>' : '');
      head.appendChild(v); row.appendChild(head);
      var track = el('div', 'kate-hbar-track');
      var bar = el('div', 'kate-hbar-bar');
      bar.style.background = it.color || (opts.accentBest && it.value === best ? seriesColor(0) : cssVar('--series-1', '#2a78d6'));
      bar.style.width = noAnim() ? (it.value / max * 100) + '%' : '0%';
      track.appendChild(bar); row.appendChild(track); wrap.appendChild(row);
      if (!noAnim()) requestAnimationFrame(function () { setTimeout(function () { bar.style.width = (it.value / max * 100) + '%'; }, 80 + i * 60); });
    });
    container.appendChild(wrap);
  }

  // ============================ SCATTER (RFM) =============================
  // opts:{ points:[{x,y,r,color,label,seg}], xMax,yMax, xLabel,yLabel, height }
  function scatter(container, opts) {
    var w = width(container), h = opts.height || 300;
    var padL = 40, padR = 16, padT = 16, padB = 34;
    var svg = mount(container, w, h);
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var xat = function (v) { return padL + v / opts.xMax * plotW; };
    var yat = function (v) { return padT + plotH - v / opts.yMax * plotH; };
    for (var g = 0; g <= 5; g++) { var x = padL + plotW * g / 5; svg.appendChild(svgEl('line', { x1: x, x2: x, y1: padT, y2: padT + plotH, stroke: ink.grid(), 'stroke-width': 1 })); }
    for (var g2 = 0; g2 <= 5; g2++) { var y = padT + plotH * g2 / 5; svg.appendChild(svgEl('line', { x1: padL, x2: w - padR, y1: y, y2: y, stroke: ink.grid(), 'stroke-width': 1 })); }
    svg.appendChild(axisLabel(w / 2, h - 4, opts.xLabel, 'middle'));
    var yl = axisLabel(12, padT + plotH / 2, opts.yLabel, 'middle'); yl.setAttribute('transform', 'rotate(-90 12 ' + (padT + plotH / 2) + ')'); svg.appendChild(yl);
    opts.points.forEach(function (p, i) {
      var c = svgEl('circle', { cx: xat(p.x), cy: yat(p.y), r: 0, fill: p.color, 'fill-opacity': 0.72, stroke: ink.surface(), 'stroke-width': 1.5 });
      svg.appendChild(c); animateAttr(c, 'r', 0, p.r || 5, 500, i * 4);
      function show(clientX) { c.setAttribute('fill-opacity', 1); var box = svg.getBoundingClientRect(); showTip('<div class="kate-tip-title">' + esc(p.label || '') + '</div><div class="kate-tip-row"><i style="background:' + p.color + '"></i><span>' + esc(p.seg || '') + '</span></div>', clientX, box.top + yat(p.y)); }
      c.__showTip = show;
      c.__clearHi = function () { c.setAttribute('fill-opacity', 0.72); };
      c.addEventListener('mouseenter', function (ev) { show(ev.clientX); });
      c.addEventListener('mouseleave', function () { c.__clearHi(); hideTip(); });
    });
    enableDragReveal(svg);
  }
  function axisLabel(x, y, t, anchor) { var e = svgEl('text', { x: x, y: y, 'text-anchor': anchor, fill: ink.secondary(), 'font-size': AXIS_FS, 'font-weight': 500 }); e.textContent = t || ''; return e; }

  // ============================ GAUGE / RADIAL METER =====================
  // opts:{ value (0..1), label, sub, height, color }
  function gauge(container, opts) {
    var h = opts.height || 150, w = width(container, 180);
    var cx = w / 2, cy = h - 12, R = Math.min(w / 2 - 8, h - 24);
    var svg = mount(container, w, h);
    var a0 = Math.PI, a1 = 0;
    svg.appendChild(svgEl('path', { d: arcStroke(cx, cy, R, a0, a1), fill: 'none', stroke: cssVar('--track', '#e1e0d9'), 'stroke-width': 12, 'stroke-linecap': 'round' }));
    var col = opts.color || seriesColor(0);
    var frac = Math.max(0, Math.min(1, opts.value));
    var arcP = svgEl('path', { d: arcStroke(cx, cy, R, a0, a0 + (a1 - a0) * frac), fill: 'none', stroke: col, 'stroke-width': 12, 'stroke-linecap': 'round' });
    svg.appendChild(arcP);
    if (!noAnim()) { var L = arcP.getTotalLength(); arcP.style.strokeDasharray = L; arcP.style.strokeDashoffset = L; arcP.getBoundingClientRect(); arcP.style.transition = 'stroke-dashoffset 1s cubic-bezier(.22,.61,.36,1)'; arcP.style.strokeDashoffset = 0; }
    var val = svgEl('text', { x: cx, y: cy - R * 0.32, 'text-anchor': 'middle', fill: ink.primary(), 'font-size': Math.round(R * 0.42), 'font-weight': 700 });
    val.textContent = opts.display != null ? opts.display : fmtPct(frac, 0); svg.appendChild(val);
    if (opts.label) { var lb = svgEl('text', { x: cx, y: cy - R * 0.05, 'text-anchor': 'middle', fill: ink.secondary(), 'font-size': AXIS_FS, 'font-weight': 500 }); lb.textContent = opts.label; svg.appendChild(lb); }
  }
  function arcStroke(cx, cy, R, a0, a1) { var x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0), x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1); var large = Math.abs(a1 - a0) > Math.PI ? 1 : 0; var sweep = a1 > a0 ? 1 : 0; return 'M' + x0 + ',' + y0 + 'A' + R + ',' + R + ' 0 ' + large + ' ' + sweep + ' ' + x1 + ',' + y1; }

  // ============================ SPARKLINE ================================
  function sparkline(container, values, color) {
    values = (values || []).filter(function (v) { return v != null && isFinite(v); });
    if (!values.length) { container.innerHTML = ''; return; }
    var w = width(container, 120), h = container.clientHeight || 34;
    var svg = mount(container, w, h);
    var max = Math.max.apply(null, values), min = Math.min.apply(null, values), rng = max - min || 1;
    var n = values.length;
    var pts = values.map(function (v, i) { return [n === 1 ? w / 2 : w * i / (n - 1), h - 3 - (v - min) / rng * (h - 6)]; });
    var d = 'M' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join('L');
    svg.appendChild(svgEl('path', { d: d, fill: 'none', stroke: color || cssVar('--series-1'), 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    var last = pts[pts.length - 1];
    svg.appendChild(svgEl('circle', { cx: last[0], cy: last[1], r: 3, fill: color || cssVar('--series-1'), stroke: ink.surface(), 'stroke-width': 1.5 }));
  }

  // ============================ GLOSS METER (linear) =====================
  // opts:{ value(0..1), label, display?, target?, color?, sub? }
  function meter(container, opts) {
    container.innerHTML = '';
    var wrap = el('div', 'meter');
    var head = el('div', 'meter-head');
    var labelWrap = el('span', 'meter-label-wrap');
    labelWrap.appendChild(el('span', 'meter-label', opts.label));
    if (opts.help) {
      var helpBtn = document.createElement('button');
      helpBtn.type = 'button'; helpBtn.className = 'help-ico'; helpBtn.textContent = '?';
      helpBtn.setAttribute('data-help', opts.help); helpBtn.setAttribute('aria-label', '説明を見る');
      labelWrap.appendChild(helpBtn);
    }
    head.appendChild(labelWrap);
    var v = el('span', 'meter-val tnum'); v.textContent = opts.display != null ? opts.display : fmtPct(opts.value, 0);
    head.appendChild(v); wrap.appendChild(head);
    var track = el('div', 'meter-track');
    var fill = el('div', 'meter-fill');
    if (opts.color) fill.style.background = opts.color;
    else if (opts.target != null) {
      // 目安に対する達成度で色を変える（sub に目安の数字があるので色だけの符号にはならない）:
      // 達成＝緑、あと 10pt 以内＝アクセント、それ以上離れている＝橙
      var gap = opts.target - opts.value;
      fill.style.background = gap <= 0 ? cssVar('--status-good') : gap <= 0.15 ? cssVar('--accent') : cssVar('--warn');
    }
    track.appendChild(fill);
    if (opts.target != null) { var tick = el('i', 'meter-tick'); tick.style.left = (Math.max(0, Math.min(1, opts.target)) * 100) + '%'; track.appendChild(tick); }
    wrap.appendChild(track);
    if (opts.sub) { var sub = el('div', 'note-inline'); sub.style.marginTop = '5px'; sub.textContent = opts.sub; wrap.appendChild(sub); }
    container.appendChild(wrap);
    var pct = Math.max(0, Math.min(1, opts.value)) * 100;
    if (noAnim()) { fill.style.width = pct + '%'; }
    else requestAnimationFrame(function () { setTimeout(function () { fill.style.width = pct + '%'; fill.classList.add('swept'); }, 120); });
  }

  // ---- count-up (for stat tiles) ------------------------------------------
  function countUp(node, to, opts) {
    opts = opts || {};
    var fmt = opts.fmt || fmtInt, dur = opts.dur || 1100;
    if (noAnim()) { node.textContent = fmt(to); return; }
    var start = null, from = opts.from || 0;
    function step(ts) { if (start === null) start = ts; var t = Math.min(1, (ts - start) / dur); node.textContent = fmt(from + (to - from) * ease(t)); if (t < 1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }

  global.KATE = global.KATE || {};
  global.KATE.charts = {
    lineArea: lineArea, columns: columns, columnClusters: columnClusters, donut: donut, funnel: funnel, heatmap: heatmap,
    hbars: hbars, scatter: scatter, gauge: gauge, meter: meter, sparkline: sparkline, countUp: countUp,
    fmt: { int: fmtInt, yen: fmtYen, compact: fmtCompact, pct: fmtPct }, seriesColor: seriesColor, cssVar: cssVar,
    setInstant: function (b) { instant = !!b; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
