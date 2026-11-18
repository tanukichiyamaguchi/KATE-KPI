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
  // 日本語の金額・件数の短縮表記。1万未満はそのまま（7,500）、1万以上は「万」、
  // 1億以上は「億」。以前は 1,000〜9,999 を「7.5k」と書いていたが、スタッフには
  // なじみが薄く、同じグラフ内で「1.1万」と「7.5k」が混在して読みにくかった。
  function fmtCompact(n) {
    var a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '億';
    if (a >= 1e4) return (n / 1e4).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + '万';
    return fmtInt(n);
  }
  function fmtPct(n, d) { return (n * 100).toFixed(d == null ? 0 : d) + '%'; }
  // 目盛り: 「切りのいい間隔」を先に決め、その倍数で上限を作る。以前は上限だけを
  // 丸めて4等分していたため、目盛りが「38万・75万・113万」のような半端な値になって
  // いた。間隔は 1・2・2.5・5 ×10^n から、目盛りの本数が 3〜5 本になるものを選ぶ。
  // 上限には一番高い棒の上に数値ラベルが入るだけの余白（約12%）を確保する。
  var STEP_BASES = [1, 2, 2.5, 5];
  function niceScale(v, fixedMax, integer) {
    if (fixedMax) {
      var fs = fixedMax <= 100 && fixedMax >= 50 ? 25 : fixedMax / 4;
      return { max: fixedMax, step: fs };
    }
    if (!(v > 0)) return { max: integer ? 4 : 1, step: integer ? 1 : 0.25 };   // also guards NaN
    var target = v * 1.12;
    var best = null;
    for (var e = Math.floor(Math.log10(target)) - 2; e <= Math.floor(Math.log10(target)) + 1 && !best; e++) {
      for (var i = 0; i < STEP_BASES.length; i++) {
        var step = STEP_BASES[i] * Math.pow(10, e);
        if (integer && (step < 1 || step !== Math.round(step))) continue;   // 件数に 0.5件 などの目盛りを作らない
        var n = Math.ceil(target / step);
        if (n >= 3 && n <= 5) { best = { max: n * step, step: step }; break; }
      }
    }
    if (!best) { var st = Math.max(integer ? 1 : 0, Math.pow(10, Math.floor(Math.log10(target)))); best = { max: Math.ceil(target / st) * st, step: st }; }
    return best;
  }
  function allIntegers(arrs) {
    return arrs.every(function (a) { return a.every(function (v) { return v == null || !isFinite(v) || Math.round(v) === v; }); });
  }
  // y軸（目盛り線と数値）を描く。0 を含むすべての目盛りに数値を付ける。
  // 金額・件数の軸は、軸の最大が10万未満なら「7,500」「10,000」と桁区切りで、10万以上なら
  // 「25万」「150万」と万で書く（同じ軸に「1万」と「7,500」が混ざらないように）。
  // autoFmt は棒の上の数値（labelFmt）の書式選び。目盛りは下の axisFmt を使う。
  function autoFmt(scale, fmt) {
    if (fmt && fmt !== fmtCompact) return fmt;
    return scale.max >= 1e5 ? fmtCompact : fmtInt;
  }
  // 目盛りの数値の書式（drawYAxis と axisPad で共通）。万・億と桁区切りの使い分けは autoFmt と
  // 同じだが、小数は目盛りの間隔（step）が必要とする桁まで書く: 125,000 は「12.5万」、
  // 1.25億・12.5億もそのまま。切りのいい値は「10万」「125万」「2500万」のまま（末尾の0は付けない）。
  // 以前は棒の上の数値と同じ fmtCompact（10万以上は整数の万に丸める）を使っていたため、
  // 125,000 の目盛りが「13万」になり、最後の間隔だけ +3万 に見えていた（fmtCompact は棒の上の
  // 数値用にそのまま）。% など呼び出し側が渡した書式（fmtCompact 以外）はそのまま使う。
  function axisFmt(scale, fmt) {
    if (fmt && fmt !== fmtCompact) return fmt;
    var big = scale.max >= 1e5;
    return function (v) {
      var a = Math.abs(v);
      var unit = big && a >= 1e8 ? 1e8 : (big && a >= 1e4 ? 1e4 : 1);
      var d = fracDigits(scale.step / unit);
      if (unit === 1) return v.toLocaleString('ja-JP', { minimumFractionDigits: 0, maximumFractionDigits: d });
      return String(+(v / unit).toFixed(d)) + (unit === 1e8 ? '億' : '万');
    };
  }
  // q を小数で正確に書くのに要る桁数（0〜3）。目盛りの間隔は 1・2・2.5・5 ×10^n なので、
  // 万・億の単位でも高々2桁で足りる（2.5万 → 1桁、2500万 を億で → 0.25億 の2桁）。
  function fracDigits(q) {
    for (var d = 0; d < 3; d++) {
      var s = q * Math.pow(10, d);
      if (Math.abs(s - Math.round(s)) <= 1e-9 * Math.max(1, Math.abs(s))) return d;
    }
    return 3;
  }
  // 棒の上の数値の書式。autoFmt と同じく、軸の最大が10万以上のグラフは fmtCompact（万・億）、
  // 未満は桁区切り。万のグラフに1万未満の棒があっても「8,000」とは書かず「0.8万」と書き、
  // 1枚のグラフの中で万と桁区切りを混ぜない（fmtCompact そのものは変えない）。
  function labelFmt(scale, fmt) {
    var f = autoFmt(scale, fmt);
    if (f !== fmtCompact) return f;
    return function (v) {
      if (Math.abs(v) >= 1e4) return fmtCompact(v);
      var d = 1;
      while (d < 4 && Math.round(Math.abs(v) / 1e4 * Math.pow(10, d)) === 0) d++;
      return String(+(v / 1e4).toFixed(d)) + '万';
    };
  }
  function drawYAxis(svg, scale, padL, w, padR, yat, yFmt) {
    yFmt = axisFmt(scale, yFmt);
    tickValues(scale).forEach(function (yv) {
      var y = yat(yv);
      svg.appendChild(svgEl('line', { x1: padL, x2: w - padR, y1: y, y2: y, stroke: yv === 0 ? ink.axis() : ink.grid(), 'stroke-width': 1 }));
      var lab = svgEl('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end', fill: ink.muted(), 'font-size': AXIS_FONT });
      lab.setAttribute('font-variant-numeric', 'tabular-nums');
      lab.textContent = yFmt(yv); svg.appendChild(lab);
    });
  }
  // y軸の数値の最大幅から左の余白を決める（「150万」「12.5万」「10,000」などで長さが変わるため）。
  // 目盛りと同じ axisFmt で測る。
  function axisPad(scale, yFmt, min) {
    yFmt = axisFmt(scale, yFmt);
    var longest = tickValues(scale).reduce(function (m, v) { return Math.max(m, String(yFmt(v)).length); }, 1);
    return Math.max(min || 30, Math.round(longest * AXIS_FONT * 0.62) + 14);
  }
  function niceMax(v) { return niceScale(v).max; }
  function tickValues(scale) {
    var out = [];
    for (var t = 0; t <= scale.max + scale.step * 1e-6; t += scale.step) out.push(Math.round(t * 1e6) / 1e6);
    return out;
  }
  var AXIS_FONT = 12, VALUE_FONT = 12;
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
      if (it.dashed) dot.classList.add('is-line');
      s.appendChild(dot); s.appendChild(document.createTextNode(it.label));
      lg.appendChild(s);
    });
    container.appendChild(lg);
    return lg;
  }

  var ink = { primary: function () { return cssVar('--text-primary', '#0b0b0b'); }, secondary: function () { return cssVar('--text-secondary', '#52514e'); }, muted: function () { return cssVar('--text-muted', '#898781'); }, grid: function () { return cssVar('--gridline', '#e1e0d9'); }, surface: function () { return cssVar('--surface-1', '#fff'); }, axis: function () { return cssVar('--axis', '#c3c2b7'); } };

  // ============================ LINE + AREA =================================
  // opts: { series:[{name,color?,values:[],dashed?}], xLabels:[], yFmt, valueFmt, height, yMax?, area? }
  // opts（追加分）:
  //   xTicks: 目盛りに数値を出す x の位置（index の配列）。省略時は8点以下なら全部・それ以上は1つおき
  //   tipLabels: ツールチップの見出し（省略時は xLabels）
  //   refLines: [{ value, label, color }] 水平の参照線（目安・目標など）
  //   series[].dashed / .faded（先月などの参考線）/ .dots（各点の丸を描くか・既定 true）/ .width
  function lineArea(container, opts) {
    var w = width(container), h = opts.height || 260;
    var series = opts.series, xs = opts.xLabels;
    var n = xs.length;
    var allVals = series.reduce(function (a, s) { return a.concat(s.values.filter(function (v) { return v != null && isFinite(v); })); }, []);
    (opts.refLines || []).forEach(function (r) { allVals.push(r.value); });
    var scale = niceScale(Math.max.apply(null, allVals.concat([0])), opts.yMax, allIntegers([allVals]));
    var maxV = scale.max;
    var padL = opts.padL || axisPad(scale, opts.yFmt, 34), padR = opts.padR || 18, padT = 18, padB = 32;
    var svg = mount(container, w, h);
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var xat = function (i) { return padL + (n <= 1 ? plotW / 2 : plotW * i / (n - 1)); };
    var yat = function (v) { return padT + plotH - (v / maxV) * plotH; };

    drawYAxis(svg, scale, padL, w, padR, yat, opts.yFmt);
    // x labels
    var xTicks = opts.xTicks || xs.map(function (_, i) { return i; }).filter(function (i) { return n <= 8 || i % 2 === 0 || i === n - 1; });
    xTicks.forEach(function (i) {
      if (i < 0 || i >= n) return;
      var anchor = n > 1 && i === 0 && opts.xTicks ? 'start' : (n > 1 && i === n - 1 && opts.xTicks ? 'end' : 'middle');
      var t = svgEl('text', { x: xat(i), y: h - 10, 'text-anchor': anchor, fill: ink.muted(), 'font-size': AXIS_FONT });
      t.textContent = xs[i]; svg.appendChild(t);
    });
    // 水平の参照線（目安・目標）。値は軸の範囲内に収める。
    (opts.refLines || []).forEach(function (rl) {
      var y = yat(Math.min(rl.value, maxV));
      svg.appendChild(svgEl('line', { x1: padL, x2: w - padR, y1: y, y2: y, stroke: rl.color || ink.secondary(), 'stroke-width': 1.5, 'stroke-dasharray': '4 4' }));
      if (rl.label) {
        var tl = svgEl('text', { x: w - padR, y: Math.max(12, y - 6), 'text-anchor': 'end', fill: rl.color || ink.secondary(), 'font-size': AXIS_FONT, 'font-weight': 600 });
        tl.textContent = rl.label; svg.appendChild(tl);
      }
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
      if (opts.area !== false && !s.dashed && !s.faded && !hasGap) {
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
      var strokeW = s.width || (s.faded ? 2 : 3);
      var path = svgEl('path', { d: d, fill: 'none', stroke: color, 'stroke-width': strokeW, 'stroke-linejoin': 'round', 'stroke-linecap': s.dashed ? 'butt' : 'round' });
      if (s.dashed) { path.setAttribute('stroke-dasharray', '6 5'); path.setAttribute('stroke-opacity', 0.7); }
      if (s.faded) path.setAttribute('stroke-opacity', 0.9);
      svg.appendChild(path);
      if (!noAnim() && !hasGap) {
        var len = path.getTotalLength ? path.getTotalLength() : plotW;
        path.style.strokeDasharray = s.dashed ? '5 5' : len; path.style.strokeDashoffset = s.dashed ? 0 : len;
        if (!s.dashed) { path.getBoundingClientRect(); path.style.transition = 'stroke-dashoffset 900ms cubic-bezier(.22,.61,.36,1) ' + (si * 90) + 'ms'; path.style.strokeDashoffset = 0; }
      }
      // dots at each real point (helps read sparse / gapped series)
      if (s.dots !== false && !s.faded && !s.dashed) shown.forEach(function (p) { svg.appendChild(svgEl('circle', { cx: p[0], cy: p[1], r: 3, fill: color })); });
      if (s.faded || s.dashed) return;   // 参考線（先月・予約込み）は終端の丸と名前を付けない
      // end marker + label
      var last = shown[shown.length - 1];
      var ring = svgEl('circle', { cx: last[0], cy: last[1], r: 5, fill: color, stroke: ink.surface(), 'stroke-width': 2 });
      svg.appendChild(ring);
      if (s.endLabel !== false) {
        // y is the text BASELINE: clamp so the glyphs never poke above the SVG
        // when the series ends at/near the axis maximum (e.g. a 100% month on
        // a yMax:100 chart put the label's top edge at a negative y).
        var ly = Math.max(last[1] - 10, 14);
        var lbl = svgEl('text', { x: last[0], y: ly, 'text-anchor': 'end', fill: ink.secondary(), 'font-size': AXIS_FONT, 'font-weight': 600, opacity: 0 });
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
      showTip('<div class="kate-tip-title">' + esc((opts.tipLabels || xs)[i]) + '</div>' + rows, ev.clientX, box.top + yat(maxV));
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
    if (series.length >= 2 && !opts.hideLegend) legend(container, series.map(function (s, si) { return { label: s.name, color: s.color || seriesColor(si), dashed: s.dashed || s.faded }; }));
  }

  // A value label floating on/above a bar (stacked total, per-bar value, or
  // cluster total) shows the bare number only — no ¥/万/億/k/%/件/人 unit
  // suffix — since the axis and the card's tag chip already establish the
  // unit; repeating it on every bar just adds clutter and, for money, forces
  // long strings to compress illegibly. Strips a leading currency symbol and
  // any trailing non-numeric suffix, keeping digits/commas/one decimal point.
  // 棒の上の数値ラベル: 先頭の「¥」と末尾の「件・人・回」だけを外し、「万・億・%」は
  // 残す。以前は単位をすべて外していたため、売上の棒に「106」とだけ出て、106円なのか
  // 106万円なのかが読み取れなかった。
  function stripUnit(text) {
    return String(text).replace(/^[¥$€]/, '').replace(/(件|人|回)$/, '');
  }
  // 棒の上の数値ラベル（グラフ1枚ぶん）をまとめて描く。items: [{ x, y, text }]（棒の中央・
  // 文字のベースライン・数値の文字列）、room: 数字1つに使える横幅（同じグラフの棒はどれも同じ
  // 幅なので全部共通）、fontSize: 基本の文字の大きさ。
  // 以前は1本ずつ「入らなければ消す」と決めていたため、桁の多い数字（＝背の高い棒）から消えて、
  // 低い棒にだけ数字が残っていた。今はグラフ1枚につき1回だけ決める:
  //   1. 一番長い数字も、横に 80% まで縮めれば room に収まる → 全部そのまま描く
  //      （room を超える数字だけ textLength で縮める・つぶして読めなくはしない）。
  //   2. 収まらない → このグラフの数値ラベルを全部同じ大きさまで小さくする（最小 10px）。
  //   3. 10px でも収まらない → このグラフの数値ラベルは全部出さない（触れば吹き出しで値が出る）。
  // 1本だけ消したり、1本だけ別の書式にしたりはしない（書式は labelFmt でグラフごとに1つ）。
  // 結果は svg の data-value-labels（full / reduced / none）と data-value-font（px）に残す。
  var VALUE_SQUEEZE = 0.8, VALUE_FONT_MIN = 10;
  function drawValueLabels(svg, items, room, fontSize) {
    if (!items.length) return null;
    var nodes = items.map(function (it) {
      var t = svgEl('text', { x: it.x, y: it.y, 'text-anchor': 'middle', fill: ink.primary(), 'font-size': fontSize, 'font-weight': 700, 'class': 'kate-vlabel' });
      t.setAttribute('font-variant-numeric', 'tabular-nums');
      t.textContent = stripUnit(it.text);
      svg.appendChild(t);
      return t;
    });
    var state = 'full';
    if (room > 0 && nodes[0].getComputedTextLength) {
      var limit = room / VALUE_SQUEEZE;
      var widest = function () { return nodes.reduce(function (m, t) { return Math.max(m, t.getComputedTextLength()); }, 0); };
      var wMax = widest();
      if (wMax > limit) {
        // 文字の幅は大きさにほぼ比例するので、まず比例で見積もり、0.5px 刻みで測り直しながら下げる
        var f = Math.min(fontSize - 0.5, Math.max(VALUE_FONT_MIN, Math.floor(fontSize * limit / wMax * 2) / 2));
        for (; f >= VALUE_FONT_MIN; f -= 0.5) {
          nodes.forEach(function (t) { t.setAttribute('font-size', f); });
          if (widest() <= limit) break;
        }
        if (f < VALUE_FONT_MIN) {
          nodes.forEach(function (t) { svg.removeChild(t); });
          svg.setAttribute('data-value-labels', 'none');
          svg.setAttribute('data-value-font', 0);
          return 'none';
        }
        state = 'reduced'; fontSize = f;
      }
      nodes.forEach(function (t) {
        if (t.getComputedTextLength() > room) { t.setAttribute('textLength', room); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
      });
    }
    svg.setAttribute('data-value-labels', state);
    svg.setAttribute('data-value-font', fontSize);
    return state;
  }

  // ============================ COLUMNS (grouped / stacked) =================
  // opts: { groups:[label], series:[{name,color?,values:[]}], stacked?, height, valueFmt, totalFmt?, yFmt }
  // 横軸の項目名（月など）が帯の幅に入らないときは、k 個おきに残して間引く（最後の項目は
  // 必ず残す）。13ヶ月以上を狭い画面で並べると「10月11月12月」のように重なっていたため。
  // 棒そのものと、触れたときの説明（月の名前つき）はそのまま。
  function thinAxisLabels(nodes, band) {
    if (nodes.length < 2) return;
    var widthOf = function (t) {
      if (t.getComputedTextLength) { var wl = t.getComputedTextLength(); if (wl > 0) return wl; }
      var fs = parseFloat(t.getAttribute('font-size')) || AXIS_FONT;
      return String(t.textContent).split('').reduce(function (a, ch) { return a + (/[\x00-\x7f]/.test(ch) ? 0.6 : 1) * fs; }, 0);
    };
    var widest = nodes.reduce(function (m, t) { return Math.max(m, widthOf(t)); }, 0);
    if (widest + 4 <= band) return;
    var k = Math.ceil((widest + 4) / band), last = nodes.length - 1;
    nodes.forEach(function (t, i) { if ((last - i) % k !== 0) t.parentNode.removeChild(t); });
  }
  function columns(container, opts) {
    var w = width(container), h = opts.height || 260;
    var groups = opts.groups, series = opts.series, ng = groups.length;
    var totals = groups.map(function (_, gi) { return series.reduce(function (a, s) { return a + Math.max(0, s.values[gi] || 0); }, 0); });
    var flat = series.reduce(function (a, s) { return a.concat(s.values.map(function (v) { return v || 0; })); }, [0]);
    var scale = niceScale(opts.stacked ? Math.max.apply(null, totals.concat([0])) : Math.max.apply(null, flat), opts.yMax, allIntegers([flat]));
    var maxV = scale.max;
    var padL = opts.padL || axisPad(scale, opts.yFmt, 34), padR = 14, padT = 26, padB = 32;
    var svg = mount(container, w, h);
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var yat = function (v) { return padT + plotH - (v / maxV) * plotH; };
    var band = plotW / ng;
    var GAP = 2;
    // 棒の太さ（どの月も同じ）。積み上げは1本、横並びは系列の数だけ並べる。
    var barW = Math.min(28, band * 0.62);
    var innerW = band * 0.72, bw = Math.min(26, innerW / series.length - GAP);
    // 棒の上の数値ラベル: 書式も、数字1つに使える横幅も、文字の大きさもグラフ1枚で1つ。
    // 積み上げ・単系列は帯の幅まで使える（数字を縮めずに読めるように）。複数系列の横並びは
    // 隣の棒の数字とぶつからないよう、棒1本ぶんの幅まで。
    var fmtLabel = labelFmt(scale, opts.totalFmt || opts.valueFmt || fmtCompact);
    var oneBar = opts.stacked || series.length === 1;
    var labelRoom = oneBar ? Math.max((opts.stacked ? barW : bw) + 8, band - 4) : bw + GAP + 2;
    var labelFont = oneBar ? VALUE_FONT : 10.5;
    var labels = [];

    drawYAxis(svg, scale, padL, w, padR, yat, opts.yFmt);

    var axisLabels = [];
    groups.forEach(function (glabel, gi) {
      var cx = padL + band * gi + band / 2;
      var t = svgEl('text', { x: cx, y: h - 10, 'text-anchor': 'middle', fill: ink.muted(), 'font-size': AXIS_FONT });
      t.textContent = glabel; svg.appendChild(t); axisLabels.push(t);
      if (opts.stacked) {
        var x = cx - barW / 2, acc = 0;
        series.forEach(function (s, si) {
          var v = Math.max(0, s.values[gi]); if (v <= 0) return;
          var y0 = yat(acc), y1 = yat(acc + v); acc += v;
          var rectH = Math.max(0, y0 - y1);
          var isTop = (function () { for (var k = si + 1; k < series.length; k++) if (series[k].values[gi] > 0) return false; return true; })();
          var rect = svgEl('rect', { x: x, y: y1, width: barW, height: 0, fill: s.color || seriesColor(si), rx: isTop ? 5 : 0 });
          if (s.opacity != null) rect.setAttribute('fill-opacity', s.opacity);
          rect.style.cursor = 'default'; svg.appendChild(rect);
          animateAttr(rect, 'height', 0, rectH, 700, gi * 40 + si * 30);
          animateAttr(rect, 'y', y0, y1, 700, gi * 40 + si * 30);
          bindBarTip(rect, svg, w, glabel, s, si, v, opts);
        });
        if (acc > 0) labels.push({ x: cx, y: yat(acc) - 7, text: fmtLabel(acc) });
      } else {
        // 数値ラベルは、すべての棒に付けるか（入らなければグラフ全体で同じだけ小さくする）、
        // このグラフでは全部付けないかのどちらか。1本ずつ消すことはしない（drawValueLabels）。
        // ごく細い棒（5px 未満）のグラフには付けない。
        var showBarLabels = bw >= 5;
        series.forEach(function (s, si) {
          var v = Math.max(0, s.values[gi]);
          var x = cx - innerW / 2 + si * (bw + GAP), y1 = yat(v), rectH = padT + plotH - y1;
          var rect = svgEl('rect', { x: x, y: padT + plotH, width: bw, height: 0, fill: s.color || seriesColor(si), rx: Math.min(5, bw / 2) });
          svg.appendChild(rect);
          animateAttr(rect, 'height', 0, rectH, 700, gi * 40 + si * 40);
          animateAttr(rect, 'y', padT + plotH, y1, 700, gi * 40 + si * 40);
          bindBarTip(rect, svg, w, glabel, s, si, v, opts);
          if (showBarLabels && v > 0) labels.push({ x: x + bw / 2, y: y1 - 6, text: fmtLabel(v) });
        });
      }
    });
    thinAxisLabels(axisLabels, band);
    drawValueLabels(svg, labels, labelRoom, labelFont);
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
    var w = width(container), h = opts.height || 260;
    var groups = opts.groups, series = opts.series, clusterSize = opts.clusterSize || 1;
    var nClusters = groups.length, nBars = nClusters * clusterSize;
    var totals = [];
    for (var bi0 = 0; bi0 < nBars; bi0++) totals.push(series.reduce(function (a, s) { return a + Math.max(0, s.values[bi0] || 0); }, 0));
    var scale = niceScale(Math.max.apply(null, totals.concat([0])), opts.yMax, allIntegers([totals]));
    var maxV = scale.max;
    var padL = opts.padL || axisPad(scale, opts.yFmt, 34), padR = 14, padT = 26, padB = 46;
    var svg = mount(container, w, h);
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var yat = function (v) { return padT + plotH - (v / maxV) * plotH; };
    var clusterBand = plotW / nClusters, innerGap = 4;

    drawYAxis(svg, scale, padL, w, padR, yat, opts.yFmt);

    var barW = Math.max(6, Math.min(22, (clusterBand * 0.72 - innerGap * (clusterSize - 1)) / clusterSize));
    // Per-bar text labels need real room to stay legible; below that, skip the
    // text and rely on the color tick (still readable at any width) plus the
    // tooltip. Prevents adjacent labels merging into unreadable text on narrow
    // (mobile) screens.
    var showSubLabels = !!opts.subLabels && (clusterBand / clusterSize) >= 24;
    // 棒ごとの合計の数値: すべての棒に付けるか（入らなければグラフ全体で同じだけ小さくする）、
    // このグラフでは全部付けないかのどちらか。1本ずつ消すことはしない（drawValueLabels）。
    // 1本あたりの幅がごく僅か（10px 未満）なグラフには付けない。
    var showTotals = (clusterBand / clusterSize) >= 10;
    var fmtLabel = labelFmt(scale, opts.totalFmt || opts.valueFmt || fmtCompact);
    var labels = [];
    function colorFor(s, si, bi) { return (typeof s.color === 'function' ? s.color(bi) : s.color) || seriesColor(si); }
    var clusterLabels = [];
    groups.forEach(function (glabel, ci) {
      var clusterCx = padL + clusterBand * ci + clusterBand / 2;
      var groupInnerW = barW * clusterSize + innerGap * (clusterSize - 1);
      var t = svgEl('text', { x: clusterCx, y: h - (showSubLabels ? 26 : 12), 'text-anchor': 'middle', fill: ink.muted(), 'font-size': AXIS_FONT, 'font-weight': 600 });
      t.textContent = glabel; svg.appendChild(t); clusterLabels.push(t);
      for (var k = 0; k < clusterSize; k++) {
        var bi = ci * clusterSize + k;
        var bx = clusterCx - groupInnerW / 2 + k * (barW + innerGap);
        if (showSubLabels) {
          var slab = svgEl('text', { x: bx + barW / 2, y: h - 10, 'text-anchor': 'middle', fill: ink.muted(), 'font-size': 10.5 });
          slab.textContent = opts.subLabels[bi]; svg.appendChild(slab);
        }
        if (opts.subColors) {
          svg.appendChild(svgEl('rect', { x: bx, y: padT + plotH + 3, width: barW, height: 2.5, rx: 1.25, fill: opts.subColors[bi] }));
        }
        var acc = 0;
        series.forEach(function (s, si) {
          var v = Math.max(0, s.values[bi] || 0); if (v <= 0) return;
          var y0 = yat(acc), y1 = yat(acc + v); acc += v;
          var rectH = Math.max(0, y0 - y1);
          var isTop = (function () { for (var kk = si + 1; kk < series.length; kk++) if ((series[kk].values[bi] || 0) > 0) return false; return true; })();
          var color = colorFor(s, si, bi);
          var rect = svgEl('rect', { x: bx, y: y1, width: barW, height: 0, fill: color, rx: isTop ? 3 : 0 });
          if (s.opacity != null) rect.setAttribute('fill-opacity', s.opacity);
          rect.style.cursor = 'default'; svg.appendChild(rect);
          animateAttr(rect, 'height', 0, rectH, 700, ci * 40 + si * 20);
          animateAttr(rect, 'y', y0, y1, 700, ci * 40 + si * 20);
          bindBarTip(rect, svg, w, glabel + (opts.subLabels ? ' ・ ' + opts.subLabels[bi] : ''), s, si, v, opts, color);
        });
        if (showTotals && acc > 0) labels.push({ x: bx + barW / 2, y: yat(acc) - 6, text: fmtLabel(acc) });
      }
    });
    thinAxisLabels(clusterLabels, clusterBand);
    drawValueLabels(svg, labels, barW + innerGap, 10.5);
    enableDragReveal(svg);
    if (!opts.hideLegend && series.length >= 2) legend(container, series.map(function (s, si) { return { label: s.name, color: (typeof s.color === 'function' ? s.color(0) : s.color) || seriesColor(si) }; }));
  }

  function bindBarTip(rect, svg, w, glabel, s, si, v, opts, color) {
    color = color || s.color || seriesColor(si);
    function show(clientX) {
      rect.style.filter = 'brightness(1.06)';
      var box = svg.getBoundingClientRect();
      showTip('<div class="kate-tip-title">' + esc(glabel) + '</div><div class="kate-tip-row"><i style="background:' + color + '"></i><span>' + esc(s.name) + '</span><b>' + (opts.valueFmt || fmtCompact)(v) + '</b></div>', clientX, box.top + rect.getBBox().y);
    }
    rect.__showTip = show;
    rect.addEventListener('mouseenter', function (ev) { show(ev.clientX); });
    rect.addEventListener('mousemove', function (ev) { var box = svg.getBoundingClientRect(); showTip(tooltip().innerHTML, ev.clientX, box.top + rect.getBBox().y); });
    rect.addEventListener('mouseleave', function () { rect.style.filter = ''; hideTip(); });
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
      if (opts.centerLabel) { var cl = svgEl('text', { x: cx, y: cy + size * 0.13, 'text-anchor': 'middle', fill: ink.muted(), 'font-size': 11 }); cl.textContent = opts.centerLabel; svg.appendChild(cl); }
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
          : '<span class="kate-arrow">↓</span> 継続 <b>' + fmtPct(cont, 0) + '</b> · 離脱 ' + fmtPct(1 - cont, 0) + frac;
        wrap.appendChild(conv);
      }
    });
    container.appendChild(wrap);
  }

  // ---- 色とコントラスト（WCAG 2）------------------------------------------
  // "#rgb" "#rrggbb" "#rrggbbaa" "rgb()" "rgba()" を [r, g, b, a] にする。それ以外の書き方
  // （色名・hsl() など）はブラウザ（canvas）に正規化させる。読めなければ null。
  function parseColor(s) {
    s = String(s == null ? '' : s).trim();
    var m = /^#([0-9a-f]+)$/i.exec(s);
    if (m) {
      var hx = m[1];
      if (hx.length === 3 || hx.length === 4) hx = hx.replace(/./g, '$&$&');
      if (hx.length !== 6 && hx.length !== 8) return null;
      return [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16), hx.length === 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1];
    }
    m = /^rgba?\(([^)]*)\)$/i.exec(s);
    if (m) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (p.length < 3) return null;
      var num = function (x, full) { return /%$/.test(x) ? parseFloat(x) / 100 * full : parseFloat(x); };
      var rgba = [num(p[0], 255), num(p[1], 255), num(p[2], 255), p.length > 3 ? num(p[3], 1) : 1];
      return rgba.every(function (x) { return isFinite(x); }) ? rgba : null;
    }
    if (s && typeof document !== 'undefined' && document.createElement) {
      try {
        var g = document.createElement('canvas').getContext('2d');
        if (g) {
          g.fillStyle = '#010203'; g.fillStyle = s; var n1 = g.fillStyle;
          g.fillStyle = '#040506'; g.fillStyle = s; var n2 = g.fillStyle;
          if (n1 === n2 && n1 !== s) return parseColor(n1);   // 読めない色だと置いた色のまま残る
        }
      } catch (e) { /* canvas の無い環境 */ }
    }
    return null;
  }
  function relLuminance(c) {
    var v = [c[0], c[1], c[2]].map(function (x) { x = Math.max(0, Math.min(255, x)) / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function contrastRatio(a, b) { var x = relLuminance(a), y = relLuminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  // 色 fg を不透明度 alpha で背景 bg に重ねた色（ブラウザの合成と同じく sRGB のまま混ぜる）
  function blendOver(fg, alpha, bg) {
    var a = Math.max(0, Math.min(1, alpha * (fg[3] == null ? 1 : fg[3])));
    return [0, 1, 2].map(function (i) { return fg[i] * a + bg[i] * (1 - a); });
  }
  // 背景 bg（[r,g,b]）の上で読みやすい文字色: ふだんの文字色 primary と、その反対側の白／黒の
  // うち、コントラスト比の高い方。白と黒のどちらかは、どんな背景に対しても 4.58:1 以上になる。
  function readableInk(bg, primary) {
    var p = parseColor(primary);
    if (!bg || !p) return primary;
    var other = relLuminance(p) > 0.18 ? '#000000' : '#ffffff';
    return contrastRatio(bg, parseColor(other)) > contrastRatio(bg, p) ? other : primary;
  }

  // ============================ HEATMAP (F×R) ==============================
  // opts: { matrix:[[]], rowLabels, colLabels, height, hueVar, cellLabel }
  function heatmap(container, opts) {
    var m = opts.matrix, rows = m.length, cols = m[0].length;
    var w = width(container), cell = Math.min(64, (w - 44) / cols), h = cell * rows + 46;
    var svg = mount(container, w, h);
    var padL = 40, padT = 22;
    var max = Math.max.apply(null, m.reduce(function (a, r) { return a.concat(r); }, [0])) || 1;
    var base = opts.hue || cssVar('--series-1', '#2a78d6');
    // マスの数字の色は、マスの実際の色（base を fill-opacity でカードの地 --surface-1 に重ねた色）
    // に対して WCAG のコントラスト比が高い方（ふだんの文字色か、その反対の白／黒）を選ぶ。
    // ライト・ダークのどちらでも、どの色相でも 4.5:1 以上になる。以前は「濃さ 0.5 を超えたら
    // ライトは白・ダークは黒」と決め打ちしていたため、ライトの中くらいの青に白い数字（約2.9:1）が
    // 乗っていた。色が読めないときだけ、ふだんの文字色のまま。
    var baseRgb = parseColor(base), surfaceRgb = parseColor(ink.surface()), inkText = ink.primary();
    opts.colLabels.forEach(function (cl, c) { var t = svgEl('text', { x: padL + c * cell + cell / 2, y: padT - 8, 'text-anchor': 'middle', fill: ink.muted(), 'font-size': cell < 30 ? 10.5 : AXIS_FONT }); t.textContent = cl; svg.appendChild(t); });
    opts.rowLabels.forEach(function (rl, r) { var t = svgEl('text', { x: padL - 8, y: padT + r * cell + cell / 2 + 4, 'text-anchor': 'end', fill: ink.muted(), 'font-size': AXIS_FONT }); t.textContent = rl; svg.appendChild(t); });
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
      (function (r, c) {
        var v = m[r][c], intensity = v / max;
        var x = padL + c * cell, y = padT + r * cell;
        var alpha = v === 0 ? 0.05 : (0.14 + intensity * 0.82);
        var rect = svgEl('rect', { x: x + 1.5, y: y + 1.5, width: cell - 3, height: cell - 3, rx: 6, fill: base, 'fill-opacity': alpha });
        svg.appendChild(rect);
        if (!noAnim()) { rect.style.opacity = 0; rect.getBoundingClientRect(); rect.style.transition = 'opacity .5s ease ' + ((r + c) * 45) + 'ms'; rect.style.opacity = 1; }
        if (v > 0) {
          var txtFill = baseRgb && surfaceRgb ? readableInk(blendOver(baseRgb, alpha, surfaceRgb), inkText) : inkText;
          var t = svgEl('text', { x: x + cell / 2, y: y + cell / 2 + 4.5, 'text-anchor': 'middle', fill: txtFill, 'font-size': cell < 30 ? 11.5 : 13, 'font-weight': 600 });
          t.textContent = v; svg.appendChild(t);
        }
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
  function axisLabel(x, y, t, anchor) { var e = svgEl('text', { x: x, y: y, 'text-anchor': anchor, fill: ink.muted(), 'font-size': AXIS_FONT }); e.textContent = t || ''; return e; }

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
    if (opts.label) { var lb = svgEl('text', { x: cx, y: cy - R * 0.05, 'text-anchor': 'middle', fill: ink.muted(), 'font-size': 11 }); lb.textContent = opts.label; svg.appendChild(lb); }
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
      helpBtn.type = 'button'; helpBtn.className = 'help-ico'; helpBtn.textContent = 'i';
      helpBtn.setAttribute('data-help', opts.help); helpBtn.setAttribute('aria-label', '説明を見る');
      labelWrap.appendChild(helpBtn);
    }
    head.appendChild(labelWrap);
    var v = el('span', 'meter-val tnum'); v.textContent = opts.display != null ? opts.display : fmtPct(opts.value, 0);
    head.appendChild(v); wrap.appendChild(head);
    var track = el('div', 'meter-track');
    var fill = el('div', 'meter-fill');
    if (opts.color) fill.style.background = opts.color;
    track.appendChild(fill);
    if (opts.target != null) { var tick = el('i', 'meter-tick'); tick.style.left = (Math.max(0, Math.min(1, opts.target)) * 100) + '%'; track.appendChild(tick); }
    wrap.appendChild(track);
    if (opts.sub) { var sub = el('div', 'note-inline'); sub.style.marginTop = '5px'; sub.textContent = opts.sub; wrap.appendChild(sub); }
    container.appendChild(wrap);
    var pct = Math.max(0, Math.min(1, opts.value)) * 100;
    if (noAnim()) { fill.style.width = pct + '%'; }
    else requestAnimationFrame(function () { setTimeout(function () { fill.style.width = pct + '%'; fill.classList.add('swept'); }, 120); });
  }

  // ============================ RING（目標の達成度）=========================
  // iPhone の「フィットネス」のリング。value＝実績÷目標、extra＝予約込み÷目標（薄い色で
  // 実績の先に重ねる）。100% を超えたら輪は満タンで止め、中央の数字で超過を示す。
  // opts:{ value, extra?, color, size?, stroke?, label? (中央の大きい文字), sub? (中央の小さい文字) }
  function ring(container, opts) {
    container.innerHTML = '';
    var size = opts.size || 104, sw = opts.stroke || 13;
    var r = (size - sw) / 2, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
    var svg = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, width: size, height: size, role: 'img' });
    svg.style.display = 'block';
    if (opts.aria) svg.setAttribute('aria-label', opts.aria);
    var color = opts.color || seriesColor(0);
    // 弧の端は丸い（round）ので、両端に太さの半分ずつ丸い端が付き、見える弧は線（dash）の長さより
    // 太さ1本分長くなる。以前は線の長さを f·C にしていたため、どの値でも弧が太さ1本分（大きさ100・
    // 太さ13で約4.8%）長く、95% 前後で輪が閉じて 100% と見分けがつかなかった。
    //  ・0 < f < 1: 線を太さ1本分短くし（f·C − 太さ）、始点を太さの半分だけ時計回りに回して、丸い端
    //    まで含めた弧がちょうど 12時〜f·360° になるようにする（f がごく小さいときは点になる）。
    //  ・f ≥ 1（目標達成）: 継ぎ目のない閉じた輪。
    // 予約込み（extra）の薄い弧も同じ関数で描く。
    function arc(frac, op) {
      var f = Math.max(0, Math.min(1, frac || 0));
      var full = f >= 1;
      var len = full ? C : Math.max(0.01, f * C - sw);
      var rot = full ? -90 : -90 + (sw / 2) / r * 180 / Math.PI;
      var c = svgEl('circle', { cx: cx, cy: cy, r: r, fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round',
        transform: 'rotate(' + rot + ' ' + cx + ' ' + cy + ')' });
      if (op != null) c.setAttribute('stroke-opacity', op);
      svg.appendChild(c);
      if (f <= 0) { c.setAttribute('stroke-width', 0); return c; }
      // 隙間を 2C にして、円の終点で次の線が始まらない（12時に点が出ない）ようにする
      var dash = len + ' ' + 2 * C;
      if (noAnim()) { if (!full) c.setAttribute('stroke-dasharray', dash); return c; }
      // 伸びるアニメーション: 長さ len の線を dashoffset len（見えない）→ 0 へ
      c.setAttribute('stroke-dasharray', dash);
      c.setAttribute('stroke-dashoffset', len);
      c.getBoundingClientRect(); c.style.transition = 'stroke-dashoffset 1s cubic-bezier(.22,.61,.36,1)';
      requestAnimationFrame(function () { c.setAttribute('stroke-dashoffset', 0); });
      // 満タンは描き終えたら線の区切りを外し、継ぎ目のない輪にする
      if (full) c.addEventListener('transitionend', function () { c.removeAttribute('stroke-dasharray'); c.removeAttribute('stroke-dashoffset'); c.style.transition = ''; });
      return c;
    }
    svg.appendChild(svgEl('circle', { cx: cx, cy: cy, r: r, fill: 'none', stroke: color, 'stroke-opacity': 0.16, 'stroke-width': sw }));
    if (opts.extra != null && opts.extra > (opts.value || 0)) arc(opts.extra, 0.38);
    arc(opts.value);
    if (opts.label != null) {
      var t = svgEl('text', { x: cx, y: cy + (opts.sub ? 2 : 6), 'text-anchor': 'middle', fill: ink.primary(), 'font-size': Math.round(size * 0.2), 'font-weight': 700 });
      t.setAttribute('font-variant-numeric', 'tabular-nums');
      t.textContent = opts.label; svg.appendChild(t);
      if (opts.sub) {
        var s2 = svgEl('text', { x: cx, y: cy + Math.round(size * 0.17), 'text-anchor': 'middle', fill: ink.muted(), 'font-size': Math.max(10, Math.round(size * 0.105)) });
        s2.textContent = opts.sub; svg.appendChild(s2);
      }
    }
    container.appendChild(svg);
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
    hbars: hbars, scatter: scatter, gauge: gauge, meter: meter, sparkline: sparkline, countUp: countUp, ring: ring,
    fmt: { int: fmtInt, yen: fmtYen, compact: fmtCompact, pct: fmtPct }, seriesColor: seriesColor, cssVar: cssVar,
    // テスト用（tests/charts.test.js）。アプリからは使わない。
    _scale: { niceScale: niceScale, tickValues: tickValues, axisFmt: axisFmt, labelFmt: labelFmt },
    _color: { parse: parseColor, contrast: contrastRatio, blend: blendOver, readableInk: readableInk },
    setInstant: function (b) { instant = !!b; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
