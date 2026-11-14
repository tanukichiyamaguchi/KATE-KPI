/* グラフ部品（assets/js/charts.js）のテスト。ブラウザは使わず、最小限の偽の DOM で動かす。
 *  1. y軸の目盛り: データの最大 1〜1e10（89,300〜111,600 は1円刻み）のすべてで、目盛りの文字が
 *     目盛りの値に正確に戻る（125,000 は「13万」ではなく「12.5万」、1.25億・12.5億も）。「k」は使わない。
 *     drawYAxis（描く文字）と axisPad（左の余白）が同じ書式を使う。棒の上の数値の fmtCompact は変えない。
 *  2. 棒の上の数値: グラフ1枚につき「全部出す（全部同じ大きさ・縮めるのは 80% まで）」か
 *     「全部出さない」のどちらか。背の高い棒の数字だけ消える、ということが無い。
 *     幅を広げると文字は小さくならない。1枚のグラフで「万」と「7,500」を混ぜない。
 *  3. 目標リング: 丸い端まで含めた弧がちょうど 12時〜f·360°（0<f<1）。100% 以上は閉じた輪。
 *     予約込みの薄い弧も同じ。アニメーションは見えない状態から始まり、同じ形で終わる。
 *  4. ヒートマップ: 数字の色は、マスの実際の色（色を不透明度で背景に重ねた色）に対して
 *     4.5:1 以上（styles.css のライト・ダーク、どの色相・どの背景でも）。
 * 文字の幅は「数字 0.62em・カンマ/小数点 0.3em・万/億 1em」の決まった値で測る（ブラウザの
 * フォントに依らない）。実際の画面での確認は ui-audit.js と手元の計測で行う。
 * Run: node tests/charts.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  \x1b[32mok\x1b[0m    ' : '  \x1b[31mFAIL\x1b[0m  ') + label + (ok || detail == null ? '' : '  ' + detail));
}
function eq(label, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); check(label, ok, 'got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)); }
function h(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// ---------------------------------------------------------------------------
// テーマの色（styles.css の :root と :root[data-theme="dark"] から読む）
// ---------------------------------------------------------------------------
function readThemes() {
  const css = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'styles.css'), 'utf8');
  function block(sel) {
    const i = css.indexOf(sel + ' {'); if (i < 0) return '';
    const open = css.indexOf('{', i), close = css.indexOf('}', open);
    return css.slice(open + 1, close);
  }
  function decls(txt) { const o = {}; const re = /(--[\w-]+)\s*:\s*([^;]+);/g; let m; while ((m = re.exec(txt))) o[m[1]] = m[2].trim(); return o; }
  function resolve(map) {
    const out = {};
    function val(v, depth) { return depth > 8 ? v : v.replace(/var\((--[\w-]+)\)/g, function (_, n) { return val(map[n] || '', depth + 1); }); }
    Object.keys(map).forEach(function (k) { out[k] = val(map[k], 0); });
    return out;
  }
  const light = decls(block(':root')), dark = Object.assign({}, light, decls(block(':root[data-theme="dark"]')));
  const themes = { light: resolve(light), dark: resolve(dark) };
  const need = ['--seq-5', '--surface-1', '--text-primary'];
  const ok = ['light', 'dark'].every(function (t) { return need.every(function (k) { return /^#|^rgb/.test(themes[t][k] || ''); }); });
  if (ok) return themes;
  console.log('  （styles.css から色を読めなかったため、既定の色で検査します）');
  return {
    light: { '--seq-5': '#0a56b5', '--surface-1': '#ffffff', '--text-primary': '#000000', '--text-muted': '#6c6c70', '--series-1': '#007aff' },
    dark: { '--seq-5': '#8cc2ff', '--surface-1': '#1c1c1e', '--text-primary': '#ffffff', '--text-muted': '#ebebf5', '--series-1': '#0a84ff' }
  };
}
const THEMES = readThemes();
let tokens = THEMES.light;

// ---------------------------------------------------------------------------
// 最小限の偽の DOM
// ---------------------------------------------------------------------------
const ADV = { ',': 0.3, '.': 0.3, '万': 1, '億': 1, '%': 0.85, '-': 0.4 };
function textWidth(s, fontSize) { let w = 0; for (const ch of String(s)) w += (ADV[ch] != null ? ADV[ch] : 0.62); return w * fontSize; }
class Node {
  constructor(tag) {
    this.tagName = tag; this.attrs = {}; this.children = []; this.parentNode = null; this.style = {}; this.listeners = {}; this._text = ''; this.className = '';
    const self = this;   // HTML は className、SVG は class 属性
    this.classList = { add: function (c) { self.className = (self.className + ' ' + c).trim(); }, contains: function (c) { return (self.className + ' ' + (self.getAttribute('class') || '')).split(/\s+/).indexOf(c) >= 0; } };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i < 0) throw new Error('removeChild: not a child'); this.children.splice(i, 1); c.parentNode = null; return c; }
  set innerHTML(v) { this.children.forEach(function (c) { c.parentNode = null; }); this.children = []; this._text = ''; }
  get textContent() { return this._text + this.children.map(function (c) { return c.textContent; }).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  dispatch(t) { (this.listeners[t] || []).slice().forEach(function (f) { f({ type: t }); }); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}
class SvgText extends Node {
  getComputedTextLength() { return textWidth(this.textContent, parseFloat(this.getAttribute('font-size'))); }
}
let rafQueue = [];
global.document = {
  documentElement: new Node('html'),
  body: new Node('body'),
  createElementNS: function (ns, tag) { return tag === 'text' ? new SvgText(tag) : new Node(tag); },
  createElement: function (tag) { return new Node(tag); },
  createTextNode: function (t) { const n = new Node('#text'); n._text = String(t); return n; },
  elementFromPoint: function () { return null; }
};
global.getComputedStyle = function () { return { getPropertyValue: function (n) { return tokens[n] || ''; } }; };
global.requestAnimationFrame = function (f) { rafQueue.push(f); return rafQueue.length; };
function runRaf() { const q = rafQueue; rafQueue = []; q.forEach(function (f) { f(16); }); }

require(path.join(ROOT, 'assets', 'js', 'charts.js'));
const C = globalThis.KATE.charts;
C.setInstant(true);   // アニメーション無しで描く（リングのアニメーションの検査だけ切り替える）

function walk(n, fn) { fn(n); n.children.forEach(function (c) { walk(c, fn); }); }
function find(n, pred) { const out = []; walk(n, function (x) { if (pred(x)) out.push(x); }); return out; }
function box(width) { const b = new Node('div'); b.clientWidth = width; return b; }

// WCAG 2 のコントラスト比（charts.js とは別に書く）
function hexRgb(s) {
  s = String(s).trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) { let x = m[1]; if (x.length === 3) x = x.replace(/./g, '$&$&'); return [0, 2, 4].map(function (i) { return parseInt(x.slice(i, i + 2), 16); }); }
  m = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (m) return m[1].split(/[\s,\/]+/).filter(Boolean).slice(0, 3).map(Number);
  throw new Error('unknown colour ' + s);
}
function lum(c) { const v = c.map(function (x) { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

// ===========================================================================
h('■ y軸の目盛り（データの最大 1〜1e10 を密に走査）');
// 目盛りの文字を数に戻す（小数は文字のまま桁をずらして、丸め誤差なしで戻す）
function parseTick(s) {
  const m = /^([\d,]+)(?:\.(\d+))?(万|億)?$/.exec(s);
  if (!m) return NaN;
  if (m[1].indexOf(',') >= 0 && !/^\d{1,3}(,\d{3})+$/.test(m[1])) return NaN;   // 桁区切りの位置
  const frac = m[2] || '', exp = m[3] === '億' ? 8 : (m[3] === '万' ? 4 : 0);
  const digits = BigInt(m[1].replace(/,/g, '') + frac), shift = exp - frac.length;
  return shift >= 0 ? Number(digits * (10n ** BigInt(shift))) : Number(digits) / Math.pow(10, -shift);
}
{
  const maxima = [];
  for (let v = 1; v <= 1e10; v *= 1.001) maxima.push(v);                    // 小数を含むデータ
  for (let v = 1; v <= 1e10; v = Math.ceil(v * 1.001)) maxima.push(v);      // 整数（円・件）のデータ
  for (let v = 89300; v <= 111600; v++) maxima.push(v);                     // 軸の最大が 125,000 になる帯（1円刻み）
  [1e4, 99999, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 89286, 111607, 892857, 1116071, 89285714, 111607142, 892857142, 1116071428].forEach(function (v) { maxima.push(v); });
  // 目盛りの文字は軸（niceScale の結果）と書式だけで決まるので、同じ軸は1回だけ調べる
  // （1つずつ全部書くと toLocaleString が遅く 10 秒近くかかる）。
  const seen = {};
  let ticks = 0, bad = [], scalesChecked = 0;
  maxima.forEach(function (v) {
    const ints = Number.isInteger(v) ? [true, false] : [false];
    ints.forEach(function (integer) {
      const s = C._scale.niceScale(v, null, integer);
      [undefined, C.fmt.compact].forEach(function (fmt, fi) {
        const key = JSON.stringify(s) + '|' + fi;
        if (seen[key]) return; seen[key] = 1; scalesChecked++;
        const f = C._scale.axisFmt(s, fmt);
        const big = s.max >= 1e5;
        C._scale.tickValues(s).forEach(function (t) {
          ticks++;
          const lab = f(t);
          let why = null;
          if (/k/i.test(lab)) why = '「k」を使っている';
          else if (parseTick(lab) !== t) why = '値に戻らない（' + parseTick(lab) + '）';
          else if (/\.\d*0(万|億)?$/.test(lab)) why = '末尾に余分な0';
          else if (big && t !== 0 && !/(万|億)$/.test(lab)) why = '10万以上の軸に桁区切りが混ざる';
          else if (!big && /(万|億)/.test(lab)) why = '10万未満の軸に万が混ざる';
          if (why && bad.length < 8) bad.push('max=' + v + ' tick=' + t + ' → "' + lab + '" ' + why);
        });
      });
    });
  });
  check('データの最大 ' + maxima.length.toLocaleString() + ' 通り（軸 ' + scalesChecked + ' 種類・目盛り ' + ticks.toLocaleString() + ' 個）: すべての目盛りの文字が値に正確に戻る・「k」なし・書式は軸ごとに1つ',
    bad.length === 0, bad.join(' / '));
}
{
  const lab = function (v) { const s = C._scale.niceScale(v, null, true); return C._scale.tickValues(s).map(C._scale.axisFmt(s, C.fmt.compact)); };
  eq('最大 93,000 → 0〜12.5万（以前は最後が「13万」）', lab(93000), ['0', '2.5万', '5万', '7.5万', '10万', '12.5万']);
  eq('最大 111,600 → 同じく 12.5万', lab(111600), ['0', '2.5万', '5万', '7.5万', '10万', '12.5万']);
  eq('最大 1億 → 1.25億（以前は「1.3億」）', lab(1e8), ['0', '2500万', '5000万', '7500万', '1億', '1.25億']);
  eq('最大 10億 → 12.5億（以前は「13億」）', lab(1e9), ['0', '2.5億', '5億', '7.5億', '10億', '12.5億']);
  eq('切りのいい値はそのまま（125万・100万）', lab(1.1e6), ['0', '25万', '50万', '75万', '100万', '125万']);
  eq('10万未満の軸は桁区切り（7,500 の軸）', lab(7500), ['0', '2,000', '4,000', '6,000', '8,000', '10,000']);
  const s = C._scale.niceScale(1.1, null, false);
  eq('小数のデータ（最大 1.1）は 0.25 刻みを丸めない', C._scale.tickValues(s).map(C._scale.axisFmt(s)), ['0', '0.25', '0.5', '0.75', '1', '1.25']);
  const pctFmt = function (v) { return v.toFixed(0) + '%'; };
  check('% など呼び出し側の書式はそのまま使う', C._scale.axisFmt({ max: 100, step: 25 }, pctFmt) === pctFmt);
  eq('棒の上の数値の fmtCompact は変えない（10万以上は整数の万）', [125000, 1058000, 93000, 7500, 1.25e8].map(C.fmt.compact), ['13万', '106万', '9.3万', '7,500', '1.3億']);
}
{
  // 実際に描いた軸: 目盛りの文字（drawYAxis）と左の余白（axisPad）が同じ書式
  function axisLabels(svg) { return find(svg, function (n) { return n.tagName === 'text' && n.getAttribute('text-anchor') === 'end' && n.getAttribute('font-variant-numeric') === 'tabular-nums'; }); }
  const b = box(400);
  C.columns(b, { groups: ['3月', '4月'], series: [{ name: '店販', values: [93000, 6000] }], valueFmt: function (v) { return '¥' + v; }, totalFmt: C.fmt.compact, yFmt: C.fmt.compact, height: 220 });
  const labs = axisLabels(b.children[0]);
  eq('棒グラフの軸に描かれた文字', labs.map(function (n) { return n.textContent; }), ['0', '2.5万', '5万', '7.5万', '10万', '12.5万']);
  const padL = Math.max(34, Math.round(Math.max.apply(null, labs.map(function (n) { return n.textContent.length; })) * 12 * 0.62) + 14);
  check('左の余白は描いた文字（12.5万）の長さで決まる（axisPad と drawYAxis が同じ書式）', labs.every(function (n) { return +n.getAttribute('x') === padL - 8; }), 'x=' + labs.map(function (n) { return n.getAttribute('x'); }).join(','));
  const b2 = box(400);
  C.lineArea(b2, { xLabels: ['1日', '2日'], series: [{ name: '累計', values: [50000, 110000] }], yFmt: C.fmt.compact, valueFmt: String, height: 170 });
  eq('折れ線グラフの軸も同じ', axisLabels(b2.children[0]).map(function (n) { return n.textContent; }), ['0', '2.5万', '5万', '7.5万', '10万', '12.5万']);
}

// ===========================================================================
h('■ 棒の上の数値（グラフ1枚につき「全部」か「なし」）');
const yen = function (v) { return '¥' + Math.round(v).toLocaleString('ja-JP'); };
function eligible(kind, opts) {
  if (kind === 'clusters') {
    const n = opts.groups.length * opts.clusterSize; let c = 0;
    for (let i = 0; i < n; i++) if (opts.series.reduce(function (a, s) { return a + Math.max(0, s.values[i] || 0); }, 0) > 0) c++;
    return c;
  }
  let c = 0;
  opts.groups.forEach(function (_, gi) {
    if (opts.stacked) { if (opts.series.reduce(function (a, s) { return a + Math.max(0, s.values[gi] || 0); }, 0) > 0) c++; }
    else opts.series.forEach(function (s) { if (Math.max(0, s.values[gi] || 0) > 0) c++; });
  });
  return c;
}
function renderLabels(kind, width, opts) {
  const b = box(width);
  (kind === 'clusters' ? C.columnClusters : C.columns)(b, opts);
  const svg = b.children[0];
  const labs = find(svg, function (n) { return n.tagName === 'text' && n.classList.contains('kate-vlabel'); }).map(function (n) {
    const font = parseFloat(n.getAttribute('font-size'));
    return { text: n.textContent, font: font, natural: textWidth(n.textContent, font), squeezedTo: n.getAttribute('textLength') == null ? null : parseFloat(n.getAttribute('textLength')) };
  });
  return { svg: svg, labs: labs, state: svg.getAttribute('data-value-labels'), font: labs.length ? labs[0].font : 0 };
}
// どの幅でも成り立つこと。破ったら理由を返す。
function invariantProblem(kind, opts, r) {
  const n = eligible(kind, opts);
  if (r.labs.length !== 0 && r.labs.length !== n) return '一部の棒だけに数字（' + r.labs.length + '/' + n + '）';
  if (r.labs.some(function (l) { return l.font !== r.labs[0].font; })) return '文字の大きさがそろっていない';
  if (r.labs.length && (r.font < 10 || r.font > 12)) return '文字の大きさが範囲外（' + r.font + 'px）';
  if (r.labs.some(function (l) { return l.squeezedTo != null && l.squeezedTo < l.natural * 0.8 - 1e-9; })) return '80% を超えて縮めている';
  const man = r.labs.some(function (l) { return /万|億/.test(l.text); }), comma = r.labs.some(function (l) { return /^\d{1,3}(,\d{3})+$/.test(l.text); });
  if (man && comma) return '万と桁区切りが混ざる（' + r.labs.map(function (l) { return l.text; }).join(' ') + '）';
  if (r.labs.length && r.state !== 'full' && r.state !== 'reduced') return 'data-value-labels が ' + r.state;
  if (!r.labs.length && n && r.state !== 'none' && r.state !== null) return 'data-value-labels が ' + r.state;
  if (r.state === 'reduced' && !(r.labs[0].font < (kind !== 'clusters' && (opts.stacked || opts.series.length === 1) ? 12 : 10.5))) return 'reduced なのに小さくなっていない';
  return null;
}
// レビューで見つかった4つの場面（スマホ〜PCの実際の幅）と、同じデータを 220〜1400px で走査
const MONTHS7 = ['2月', '3月', '4月', '5月', '6月', '7月', '8月'];
const scenarios = [
  { name: '(a) スタッフ比較・店販（2人の横並び・30,000 と 6,000）', kind: 'columns', width: 600,
    opts: { groups: MONTHS7, series: [{ name: 'aoi', values: [0, 0, 0, 0, 3000, 10000, 0] }, { name: 'momo', values: [0, 30000, 6000, 0, 7000, 0, 0] }], valueFmt: yen, totalFmt: C.fmt.compact, yFmt: C.fmt.compact } },
  { name: '(b) momo の店販（1本・30,000 が一番高い）', kind: 'columns', width: 326,
    opts: { groups: MONTHS7, series: [{ name: '店販売上', values: [0, 30000, 6000, 0, 7000, 0, 0] }], valueFmt: yen, totalFmt: C.fmt.compact, yFmt: C.fmt.compact } },
  { name: '(c) 月ごとの売上（積み上げ・12ヶ月・106万など）', kind: 'columns', width: 326,
    opts: { groups: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'], stacked: true,
      series: [{ name: '実績', values: [92, 101, 82, 115, 64, 30, 54, 49, 60, 106, 70, 0].map(function (x) { return x * 1e4; }) },
        { name: '予約', values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 28].map(function (x) { return x * 1e4; }) }],
      valueFmt: yen, totalFmt: C.fmt.compact, yFmt: C.fmt.compact } },
  { name: '(d) スタッフ別の予約数（3人のかたまり・8〜46件）', kind: 'clusters', width: 326,
    opts: { groups: MONTHS7, clusterSize: 3, subLabels: [], series: [
      { name: '新規', color: '#000', values: [8, 12, 0, 20, 21, 5, 18, 22, 3, 25, 23, 6, 24, 22, 4, 21, 20, 8, 9, 10, 2] },
      { name: '2回目以上', color: '#000', values: [32, 32, 8, 20, 21, 3, 26, 23, 5, 18, 22, 2, 17, 21, 4, 20, 22, 0, 3, 2, 0] }],
      valueFmt: function (v) { return v + '件'; }, hideLegend: true } },
  { name: '(e) 月ごとの LTV（1本・9,254〜10,710）', kind: 'columns', width: 300,
    opts: { groups: ['2月', '3月', '4月', '5月', '6月', '7月'], series: [{ name: 'LTV', values: [9254, 9398, 10710, 10040, 6117, 8509] }], valueFmt: yen, totalFmt: C.fmt.compact, yFmt: C.fmt.compact } }
];
const statesSeen = {};
scenarios.forEach(function (sc) {
  const r = renderLabels(sc.kind, sc.width, sc.opts);
  const p = invariantProblem(sc.kind, sc.opts, r);
  check(sc.name + ' @' + sc.width + 'px: ' + (r.labs.length ? r.labs.length + '本すべてに ' + r.font + 'px（' + r.state + '）' : '数字なし（' + r.state + '）'), !p, p);
  let prevFont = -1, problem = null, states = [];
  for (let w = 220; w <= 1400 && !problem; w += 10) {
    const rr = renderLabels(sc.kind, w, sc.opts);
    problem = invariantProblem(sc.kind, sc.opts, rr);
    if (!problem && rr.font < prevFont) problem = '幅 ' + w + 'px で文字が小さくなった（' + prevFont + ' → ' + rr.font + 'px）';
    if (problem) problem = '@' + w + 'px: ' + problem;
    prevFont = rr.font;
    if (states.indexOf(rr.state) < 0) states.push(rr.state);
    statesSeen[rr.state] = 1;
  }
  check('  同じデータを 220〜1400px で: 一部だけ・大きさ違い・80%超の圧縮なし、幅を広げても文字は小さくならない（' + states.join(' → ') + '）', !problem, problem);
});
check('走査の中で「そのまま（full）」「小さくする（reduced）」「出さない（none）」のすべてが起きる', statesSeen.full && statesSeen.reduced && statesSeen.none, JSON.stringify(Object.keys(statesSeen)));
{
  const r = renderLabels('columns', 1200, { groups: ['a', 'b', 'c'], series: [{ name: 'x', values: [450000, 8000, 300] }], valueFmt: yen, totalFmt: C.fmt.compact, yFmt: C.fmt.compact });
  eq('万のグラフでは1万未満の棒も万で書く（「8,000」と混ぜない）', r.labs.map(function (l) { return l.text; }), ['45万', '0.8万', '0.03万']);
  const r2 = renderLabels('columns', 1200, { groups: ['a', 'b', 'c'], series: [{ name: 'x', values: [30000, 6000, 7000] }], valueFmt: yen, totalFmt: C.fmt.compact, yFmt: C.fmt.compact });
  eq('10万未満のグラフは桁区切りのまま', r2.labs.map(function (l) { return l.text; }), ['30,000', '6,000', '7,000']);
  const r3 = renderLabels('columns', 1200, { groups: ['a', 'b'], series: [{ name: 'x', values: [12, 5] }], valueFmt: function (v) { return v + '件'; } });
  eq('件数は単位を外して数字だけ', r3.labs.map(function (l) { return l.text; }), ['12', '5']);
}

// ===========================================================================
h('■ 目標リング（丸い端まで含めた弧の長さ）');
function ringArcs(opts) {
  const b = box(0);
  C.ring(b, opts);
  const circles = find(b, function (n) { return n.tagName === 'circle'; });
  return { track: circles[0], arcs: circles.slice(1) };
}
// 弧の見えている範囲（12時から時計回りの角度）。丸い端は太さの半分だけ線の外へ出る。
function visibleSpan(c, size, sw) {
  const r = (size - sw) / 2, deg = 180 / Math.PI;
  const rot = parseFloat(/rotate\(([-\d.e]+)/.exec(c.getAttribute('transform'))[1]);
  const da = c.getAttribute('stroke-dasharray');
  if (da == null) return { closed: true };
  const len = parseFloat(da.split(/[ ,]+/)[0]), off = parseFloat(c.getAttribute('stroke-dashoffset') || '0');
  const start = rot + 90 - (sw / 2) / r * deg;
  const end = rot + 90 + (len - off + sw / 2) / r * deg;
  return { closed: false, start: start, end: end, len: len };
}
[{ size: 100, stroke: 13 }, { size: 104, stroke: 10 }].forEach(function (g) {
  const bad = [];
  [0.06, 0.1, 0.25, 0.5, 0.75, 0.9, 0.93, 0.95, 0.96, 0.97, 0.98, 0.99, 0.995, 0.999].forEach(function (f) {
    const sp = visibleSpan(ringArcs({ value: f, size: g.size, stroke: g.stroke, color: '#34c759' }).arcs[0], g.size, g.stroke);
    if (sp.closed || Math.abs(sp.start) > 1e-9 || Math.abs(sp.end - f * 360) > 1e-9) bad.push(f + ': ' + JSON.stringify(sp));
  });
  check('大きさ' + g.size + '・太さ' + g.stroke + ': 6%〜99.9% の弧は丸い端まで含めてちょうど 12時〜f·360°（95〜99.9% でも輪は閉じない）', bad.length === 0, bad.join(' / '));
});
{
  const a1 = ringArcs({ value: 1, size: 100, color: '#34c759' }).arcs[0], a2 = ringArcs({ value: 1.2, size: 100, color: '#34c759' }).arcs[0];
  check('100% と 120% は継ぎ目のない閉じた輪（線の区切りなし）', a1.getAttribute('stroke-dasharray') == null && a2.getAttribute('stroke-dasharray') == null && a1.getAttribute('stroke-width') === '13');
  const tiny = visibleSpan(ringArcs({ value: 0.01, size: 100, color: '#34c759' }).arcs[0], 100, 13);
  check('ごく小さい値（1%）は 12時から始まる点（長さ0の線＋丸い端）', !tiny.closed && Math.abs(tiny.start) < 1e-9 && tiny.len <= 0.01 + 1e-12, JSON.stringify(tiny));
  const zero = ringArcs({ value: 0, size: 100, color: '#34c759' }).arcs[0];
  check('0% は弧を描かない', zero.getAttribute('stroke-width') === '0');
  const ex = ringArcs({ value: 0.5, extra: 0.97, size: 100, color: '#34c759' });
  const faded = ex.arcs.filter(function (c) { return c.getAttribute('stroke-opacity') === '0.38'; })[0];
  const sp = visibleSpan(faded, 100, 13), spv = visibleSpan(ex.arcs[1], 100, 13);
  check('予約込み 97% の薄い弧も 12時〜349.2° で閉じない（実績 50% は 180°）', Math.abs(sp.start) < 1e-9 && Math.abs(sp.end - 349.2) < 1e-9 && Math.abs(spv.end - 180) < 1e-9, JSON.stringify([sp, spv]));
  const exFull = ringArcs({ value: 0.5, extra: 1.05, size: 100, color: '#34c759' });
  check('予約込みが 100% 以上なら薄い弧は閉じた輪', exFull.arcs[0].getAttribute('stroke-dasharray') == null);
}
{
  C.setInstant(false);
  rafQueue = [];
  const a = ringArcs({ value: 0.97, size: 100, color: '#34c759' }).arcs[0];
  const len = parseFloat(a.getAttribute('stroke-dasharray'));
  const hidden = parseFloat(a.getAttribute('stroke-dashoffset')) === len;
  runRaf();
  const sp = visibleSpan(a, 100, 13);
  check('アニメーション: 見えない状態（dashoffset＝線の長さ）から始まり、97% の形（349.2°）で終わる', hidden && a.style.transition && Math.abs(sp.end - 349.2) < 1e-9, JSON.stringify(sp));
  rafQueue = [];
  const full = ringArcs({ value: 1.1, size: 100, color: '#34c759' }).arcs[0];
  const startOff = parseFloat(full.getAttribute('stroke-dashoffset'));
  runRaf();
  const endOff = full.getAttribute('stroke-dashoffset');
  full.dispatch('transitionend');
  check('アニメーション: 満タンは一周伸びたあと線の区切りを外して閉じた輪になる', startOff > 270 && endOff === '0' && full.getAttribute('stroke-dasharray') == null, 'start=' + startOff + ' end=' + endOff);
  C.setInstant(true);
}

// ===========================================================================
h('■ ヒートマップの数字の色（WCAG 4.5:1 以上）');
function heatCells(theme, hue, matrix) {
  tokens = theme;
  const b = box(390);
  C.heatmap(b, { matrix: matrix, rowLabels: matrix.map(function (_, i) { return 'r' + i; }), colLabels: matrix[0].map(function (_, i) { return 'c' + i; }), hue: hue, unit: '件' });
  const svg = b.children[0], kids = svg.children, out = [];
  for (let i = 0; i < kids.length; i++) {
    const t = kids[i];
    if (t.tagName !== 'text' || !/^\d+$/.test(t.textContent)) continue;
    let r = null; for (let j = i - 1; j >= 0; j--) if (kids[j].tagName === 'rect') { r = kids[j]; break; }
    const a = parseFloat(r.getAttribute('fill-opacity')), base = hexRgb(r.getAttribute('fill')), surf = hexRgb(theme['--surface-1']);
    const cellRgb = [0, 1, 2].map(function (k) { return base[k] * a + surf[k] * (1 - a); });
    out.push({ v: +t.textContent, fill: t.getAttribute('fill'), ratio: ratio(hexRgb(t.getAttribute('fill')), cellRgb) });
  }
  return out;
}
// 濃さ 1/84〜84/84 のすべてのマス
const ALL = []; for (let r = 0; r < 7; r++) { const row = []; for (let c = 0; c < 12; c++) row.push(r * 12 + c + 1); ALL.push(row); }
['light', 'dark'].forEach(function (name) {
  const th = THEMES[name];
  const cells = heatCells(th, th['--seq-5'], ALL);
  const worst = cells.reduce(function (m, c) { return c.ratio < m.ratio ? c : m; }, { ratio: 99 });
  check(name + '（styles.css の --seq-5 ' + th['--seq-5'] + ' / 地 ' + th['--surface-1'] + '）: 84段階すべての濃さで数字が 4.5:1 以上（最小 ' + worst.ratio.toFixed(2) + '）', cells.length === 84 && worst.ratio >= 4.5, JSON.stringify(worst));
  const light1 = cells.filter(function (c) { return c.v === 1; })[0];
  check(name + ': 薄いマスはふだんの文字色（--text-primary）', light1.fill === th['--text-primary'], light1.fill);
});
{
  const hues = ['#0a56b5', '#8cc2ff', '#007aff', '#ff2d55', '#34c759', '#ff9500', '#af52de', '#ffcc00', '#777777', '#000000', '#ffffff', '#30b0c7', 'rgb(162, 132, 94)'];
  const surfaces = [THEMES.light, THEMES.dark, Object.assign({}, THEMES.light, { '--surface-1': '#f2f2f7' }), Object.assign({}, THEMES.dark, { '--surface-1': '#000000' })];
  let worst = 99, where = '', n = 0;
  surfaces.forEach(function (th) {
    hues.forEach(function (hue) {
      heatCells(th, hue, ALL).forEach(function (c) { n++; if (c.ratio < worst) { worst = c.ratio; where = hue + ' on ' + th['--surface-1'] + ' v=' + c.v + ' text=' + c.fill; } });
    });
  });
  check('どの色相・どの地でも（' + hues.length + '色 × ' + surfaces.length + '地 × 84マス = ' + n + '）数字が 4.5:1 以上（最小 ' + worst.toFixed(2) + '）', worst >= 4.5, where);
  tokens = THEMES.light;
}
{
  const P = C._color;
  eq('色の読み取り（#rgb・#rrggbb・rgb()・rgba()）', [P.parse('#0a56b5'), P.parse('#fff'), P.parse('rgb(10, 86, 181)'), P.parse('rgba(255, 0, 0, 0.5)')],
    [[10, 86, 181, 1], [255, 255, 255, 1], [10, 86, 181, 1], [255, 0, 0, 0.5]]);
  check('読めない色は null（ふだんの文字色のまま描く）', P.parse('var(--x)') === null && P.parse('') === null);
  check('白と黒のコントラスト比は 21:1', Math.abs(P.contrast([255, 255, 255], [0, 0, 0]) - 21) < 1e-9);
}

console.log('\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m' + pass + ' pass\x1b[0m · \x1b[31m' + fail + ' fail\x1b[0m');
process.exit(fail ? 1 : 0);
