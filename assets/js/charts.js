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
  function fmtCompact(n) {
    var a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '億';
    if (a >= 1e4) return (n / 1e4).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + '万';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return fmtInt(n);
  }
  function fmtPct(n, d) { return (n * 100).toFixed(d == null ? 0 : d) + '%'; }
  function niceMax(v) {
    if (!(v > 0)) return 1;   // also guards NaN
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var norm = v / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }
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
  function lineArea(container, opts) {
    var w = width(container), h = opts.height || 260;
    var padL = opts.padL || 38, padR = opts.padR || 16, padT = 16, padB = 34;
    var svg = mount(container, w, h);
    var series = opts.series, xs = opts.xLabels;
    var n = xs.length;
    var maxV = opts.yMax || niceMax(Math.max.apply(null, series.reduce(function (a, s) { return a.concat(s.values); }, [1])));
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var xat = function (i) { return padL + (n <= 1 ? plotW / 2 : plotW * i / (n - 1)); };
    var yat = function (v) { return padT + plotH - (v / maxV) * plotH; };

    // gridlines + y ticks — the top (max) and bottom (0) tick labels are
    // dropped: they were the widest numbers on the axis and, on a narrow
    // mobile viewport, ate into the plot area for little benefit (the bars/
    // lines themselves already communicate the extremes). Gridlines at every
    // tick stay, for the visual reference.
    var ticks = 4;
    for (var g = 0; g <= ticks; g++) {
      var yv = maxV * g / ticks, y = yat(yv);
      svg.appendChild(svgEl('line', { x1: padL, x2: w - padR, y1: y, y2: y, stroke: ink.grid(), 'stroke-width': 1 }));
      if (g === 0 || g === ticks) continue;
      var lab = svgEl('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end', fill: ink.muted(), 'font-size': 11 });
      lab.setAttribute('font-variant-numeric', 'tabular-nums');
      lab.textContent = (opts.yFmt || fmtCompact)(yv); svg.appendChild(lab);
    }
    // x labels
    xs.forEach(function (lx, i) {
      if (n > 8 && i % 2 !== 0 && i !== n - 1) return;
      var t = svgEl('text', { x: xat(i), y: h - 12, 'text-anchor': 'middle', fill: ink.muted(), 'font-size': 11 });
      t.textContent = lx; svg.appendChild(t);
    });

    function defined(v) { return v != null && isFinite(v); }
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
      var path = svgEl('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      if (s.dashed) path.setAttribute('stroke-dasharray', '5 5');
      svg.appendChild(path);
      if (!noAnim() && !hasGap) {
        var len = path.getTotalLength ? path.getTotalLength() : plotW;
        path.style.strokeDasharray = s.dashed ? '5 5' : len; path.style.strokeDashoffset = s.dashed ? 0 : len;
        if (!s.dashed) { path.getBoundingClientRect(); path.style.transition = 'stroke-dashoffset 900ms cubic-bezier(.22,.61,.36,1) ' + (si * 90) + 'ms'; path.style.strokeDashoffset = 0; }
      }
      // dots at each real point (helps read sparse / gapped series)
      shown.forEach(function (p) { svg.appendChild(svgEl('circle', { cx: p[0], cy: p[1], r: 2.6, fill: color })); });
      // end marker + label
      var last = shown[shown.length - 1];
      var ring = svgEl('circle', { cx: last[0], cy: last[1], r: 4.5, fill: color, stroke: ink.surface(), 'stroke-width': 2 });
      svg.appendChild(ring);
      if (s.endLabel !== false && !s.dashed) {
        var lbl = svgEl('text', { x: last[0], y: last[1] - 10, 'text-anchor': 'end', fill: ink.secondary(), 'font-size': 11, 'font-weight': 600, opacity: 0 });
        lbl.textContent = s.name; svg.appendChild(lbl); animateAttr(lbl, 'opacity', 0, 1, 400, 900);
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
    if (series.length >= 2) legend(container, series.map(function (s, si) { return { label: s.name, color: s.color || seriesColor(si), dashed: s.dashed }; }));
  }

  // Centered value label above a bar. If the natural text would be wider than
  // maxWidth, it's compressed via SVG textLength (not wrapped) so it never
  // overflows the bar it sits above — used for per-bar/per-cluster totals,
  // which get cramped on narrow mobile bars once there are 2+ series.
  function fitValueLabel(svg, x, y, text, maxWidth, fontSize) {
    var t = svgEl('text', { x: x, y: y, 'text-anchor': 'middle', fill: ink.primary(), 'font-size': fontSize, 'font-weight': 700 });
    t.setAttribute('font-variant-numeric', 'tabular-nums');
    t.textContent = text;
    svg.appendChild(t);
    if (maxWidth > 0 && t.getComputedTextLength) {
      var natural = t.getComputedTextLength();
      if (natural > maxWidth) { t.setAttribute('textLength', maxWidth); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
    }
    return t;
  }

  // ============================ COLUMNS (grouped / stacked) =================
  // opts: { groups:[label], series:[{name,color?,values:[]}], stacked?, height, valueFmt, totalFmt?, yFmt }
  function columns(container, opts) {
    var w = width(container), h = opts.height || 260;
    var padL = opts.padL || 36, padR = 14, padT = opts.stacked ? 26 : 22, padB = 34;
    var svg = mount(container, w, h);
    var groups = opts.groups, series = opts.series, ng = groups.length;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var totals = groups.map(function (_, gi) { return series.reduce(function (a, s) { return a + Math.max(0, s.values[gi]); }, 0); });
    var maxV = opts.yMax || niceMax(opts.stacked ? Math.max.apply(null, totals) : Math.max.apply(null, series.reduce(function (a, s) { return a.concat(s.values); }, [1])));
    var yat = function (v) { return padT + plotH - (v / maxV) * plotH; };
    var band = plotW / ng;
    var GAP = 2;

    // Top (max) and bottom (0) tick labels omitted — see lineArea for why.
    for (var g = 0; g <= 4; g++) {
      var yv = maxV * g / 4, y = yat(yv);
      svg.appendChild(svgEl('line', { x1: padL, x2: w - padR, y1: y, y2: y, stroke: ink.grid(), 'stroke-width': 1 }));
      if (g === 0 || g === 4) continue;
      var lab = svgEl('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end', fill: ink.muted(), 'font-size': 11 });
      lab.setAttribute('font-variant-numeric', 'tabular-nums'); lab.textContent = (opts.yFmt || fmtCompact)(yv); svg.appendChild(lab);
    }

    groups.forEach(function (glabel, gi) {
      var cx = padL + band * gi + band / 2;
      var t = svgEl('text', { x: cx, y: h - 12, 'text-anchor': 'middle', fill: ink.muted(), 'font-size': 11 });
      t.textContent = glabel; svg.appendChild(t);
      if (opts.stacked) {
        var barW = Math.min(24, band * 0.62), x = cx - barW / 2, acc = 0;
        series.forEach(function (s, si) {
          var v = Math.max(0, s.values[gi]); if (v <= 0) return;
          var y0 = yat(acc), y1 = yat(acc + v); acc += v;
          var rectH = Math.max(0, y0 - y1);
          var isTop = (function () { for (var k = si + 1; k < series.length; k++) if (series[k].values[gi] > 0) return false; return true; })();
          var rect = svgEl('rect', { x: x, y: y1, width: barW, height: 0, fill: s.color || seriesColor(si), rx: isTop ? 4 : 0 });
          rect.style.cursor = 'default'; svg.appendChild(rect);
          animateAttr(rect, 'height', 0, rectH, 700, gi * 40 + si * 30);
          animateAttr(rect, 'y', y0, y1, 700, gi * 40 + si * 30);
          bindBarTip(rect, svg, w, glabel, s, si, v, opts);
        });
        if (acc > 0) {
          fitValueLabel(svg, cx, yat(acc) - 7, (opts.totalFmt || opts.valueFmt || fmtCompact)(acc), barW + 6, 10.5);
        }
      } else {
        var innerW = band * 0.7, bw = Math.min(24, innerW / series.length - GAP);
        var showBarLabels = bw >= 12;
        series.forEach(function (s, si) {
          var v = Math.max(0, s.values[gi]);
          var x = cx - innerW / 2 + si * (bw + GAP), y1 = yat(v), rectH = padT + plotH - y1;
          var rect = svgEl('rect', { x: x, y: padT + plotH, width: bw, height: 0, fill: s.color || seriesColor(si), rx: Math.min(4, bw / 2) });
          svg.appendChild(rect);
          animateAttr(rect, 'height', 0, rectH, 700, gi * 40 + si * 40);
          animateAttr(rect, 'y', padT + plotH, y1, 700, gi * 40 + si * 40);
          bindBarTip(rect, svg, w, glabel, s, si, v, opts);
          if (showBarLabels && v > 0) {
            fitValueLabel(svg, x + bw / 2, y1 - 5, (opts.totalFmt || opts.valueFmt || fmtCompact)(v), bw, 9);
          }
        });
      }
    });
    enableDragReveal(svg);
    if (series.length >= 2) legend(container, series.map(function (s, si) { return { label: s.name, color: s.color || seriesColor(si) }; }));
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
    var padL = opts.padL || 36, padR = 14, padT = 26, padB = 44;
    var svg = mount(container, w, h);
    var groups = opts.groups, series = opts.series, clusterSize = opts.clusterSize || 1;
    var nClusters = groups.length, nBars = nClusters * clusterSize;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var totals = [];
    for (var bi0 = 0; bi0 < nBars; bi0++) totals.push(series.reduce(function (a, s) { return a + Math.max(0, s.values[bi0] || 0); }, 0));
    var maxV = opts.yMax || niceMax(Math.max.apply(null, totals.concat([1])));
    var yat = function (v) { return padT + plotH - (v / maxV) * plotH; };
    var clusterBand = plotW / nClusters, innerGap = 4;

    // Top (max) and bottom (0) tick labels omitted — see lineArea for why.
    for (var g = 0; g <= 4; g++) {
      var yv = maxV * g / 4, y = yat(yv);
      svg.appendChild(svgEl('line', { x1: padL, x2: w - padR, y1: y, y2: y, stroke: ink.grid(), 'stroke-width': 1 }));
      if (g === 0 || g === 4) continue;
      var lab = svgEl('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end', fill: ink.muted(), 'font-size': 11 });
      lab.setAttribute('font-variant-numeric', 'tabular-nums'); lab.textContent = (opts.yFmt || fmtCompact)(yv); svg.appendChild(lab);
    }

    var barW = Math.max(6, Math.min(22, (clusterBand * 0.72 - innerGap * (clusterSize - 1)) / clusterSize));
    // Per-bar text labels need real room to stay legible; below that, skip the
    // text and rely on the color tick (still readable at any width) plus the
    // tooltip. Prevents adjacent labels merging into unreadable text on narrow
    // (mobile) screens.
    var showSubLabels = !!opts.subLabels && (clusterBand / clusterSize) >= 24;
    // Per-bar totals need a bit less room than the sub-labels (short numbers,
    // not names), but still skip them below a hard floor to avoid overlap.
    var showTotals = (clusterBand / clusterSize) >= 18;
    function colorFor(s, si, bi) { return (typeof s.color === 'function' ? s.color(bi) : s.color) || seriesColor(si); }
    groups.forEach(function (glabel, ci) {
      var clusterCx = padL + clusterBand * ci + clusterBand / 2;
      var groupInnerW = barW * clusterSize + innerGap * (clusterSize - 1);
      var t = svgEl('text', { x: clusterCx, y: h - (showSubLabels ? 25 : 12), 'text-anchor': 'middle', fill: ink.muted(), 'font-size': 11, 'font-weight': 600 });
      t.textContent = glabel; svg.appendChild(t);
      for (var k = 0; k < clusterSize; k++) {
        var bi = ci * clusterSize + k;
        var bx = clusterCx - groupInnerW / 2 + k * (barW + innerGap);
        if (showSubLabels) {
          var slab = svgEl('text', { x: bx + barW / 2, y: h - 11, 'text-anchor': 'middle', fill: ink.muted(), 'font-size': 9.5 });
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
        if (showTotals && acc > 0) {
          fitValueLabel(svg, bx + barW / 2, yat(acc) - 6, (opts.totalFmt || opts.valueFmt || fmtCompact)(acc), barW + 4, 9.5);
        }
      }
    });
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
      bar.style.width = noAnim() ? (s.value / max * 100) + '%' : '0%';
      track.appendChild(bar); row.appendChild(track);
      wrap.appendChild(row);
      if (!noAnim()) requestAnimationFrame(function () { setTimeout(function () { bar.style.width = (s.value / max * 100) + '%'; }, 120 + i * 110); });
      if (i < opts.stages.length - 1) {
        var next = opts.stages[i + 1].value, drop = s.value ? 1 - next / s.value : 0;
        var conv = el('div', 'kate-funnel-conv');
        conv.innerHTML = '<span class="kate-arrow">↓</span> 継続 <b>' + fmtPct(next / (s.value || 1), 0) + '</b> · 離脱 ' + fmtPct(drop, 0);
        wrap.appendChild(conv);
      }
    });
    container.appendChild(wrap);
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
    opts.colLabels.forEach(function (cl, c) { var t = svgEl('text', { x: padL + c * cell + cell / 2, y: padT - 8, 'text-anchor': 'middle', fill: ink.muted(), 'font-size': 11 }); t.textContent = cl; svg.appendChild(t); });
    opts.rowLabels.forEach(function (rl, r) { var t = svgEl('text', { x: padL - 8, y: padT + r * cell + cell / 2 + 4, 'text-anchor': 'end', fill: ink.muted(), 'font-size': 11 }); t.textContent = rl; svg.appendChild(t); });
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
      (function (r, c) {
        var v = m[r][c], intensity = v / max;
        var x = padL + c * cell, y = padT + r * cell;
        var rect = svgEl('rect', { x: x + 1.5, y: y + 1.5, width: cell - 3, height: cell - 3, rx: 6, fill: base, 'fill-opacity': v === 0 ? 0.05 : (0.14 + intensity * 0.82) });
        svg.appendChild(rect);
        if (!noAnim()) { rect.style.opacity = 0; rect.getBoundingClientRect(); rect.style.transition = 'opacity .5s ease ' + ((r + c) * 45) + 'ms'; rect.style.opacity = 1; }
        if (v > 0) { var t = svgEl('text', { x: x + cell / 2, y: y + cell / 2 + 4, 'text-anchor': 'middle', fill: intensity > 0.55 ? '#fff' : ink.secondary(), 'font-size': 12, 'font-weight': 600 }); t.textContent = v; svg.appendChild(t); }
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
  function axisLabel(x, y, t, anchor) { var e = svgEl('text', { x: x, y: y, 'text-anchor': anchor, fill: ink.muted(), 'font-size': 11 }); e.textContent = t || ''; return e; }

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
