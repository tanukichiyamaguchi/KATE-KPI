# Atelier Éclat — アトリエ・エクラ

### Single Source of Truth — Build-Ready Design Brief for the KATE Salon Dashboard

This document is final and non-negotiable. Every conflict between the winning direction and the grafted ideas has been resolved below; where a graft fought the premium editorial core, the core wins and the reason is stated. Build to this exactly.

---

## 0. What this locks (read first)

**Concept:** a Tokyo beauty-magazine spread that happens to be a dashboard. Champagne paper, deep-plum ink, gemstone data marks, and exactly **one rose-gold foil moment per view**. Restraint plus a single metallic gesture — correct-by-construction on the hard dataviz rules, not by taste.

**The two hard laws that govern everything:**

1. **Two-layer color contract.** A controlled **champagne → rose-gold gradient (`--foil-grad`) owns CHROME and emotion ONLY** — the hero wash, the mobile active-tab pill, the meter sheen highlight, the theme-toggle glyph. It is **forbidden from ever encoding a data value**, so it is exempt from CVD constraints and can never lie. **All data work is done by the gemstone categorical / amethyst ordinal / amethyst sequential systems** with entity-locked slots. **Plum (`--accent`) — not rose-gold — does every legible interactive job** (active-tab underline, focus ring, links, meter fill length, selection) so the metal never has to pass a text-contrast test.
2. **One axis per chart, always.** The only place two measures meet is a shared tooltip or the table view — never a second y-scale. Every dual-axis temptation is pre-resolved to small multiples (see §7).

**Resolved grafts (decisions log):**

- ✅ **Gloss meter** for every rate KPI — but the **fill that encodes the value is plum**; the gradient appears only as a one-time sheen sweep and a single rose-gold sparkle on target-beat. (Keeps the two-layer contract intact.)
- ✅ **Spring-sliding tab indicator** — desktop = 2px **plum** underline; mobile = a 3px **rose-gold-gradient pill above the icon** (decorative, doesn't carry text), with icon+label flipping to plum 600 to carry state legibly.
- ✅ **Monospace unit micro-layer** (`¥ % 件 日`) at muted ink, one step down — adopted everywhere except the hero.
- ✅ **JP falls to native Hiragino/Noto**; self-host only the Latin editorial faces + Inter. This fixes Éclat's font-payload weakness.
- ✅ **Shared chart-chrome grammar object**, first-class `表` table view, strict two-elevation rule, frosted-glass overlays, igniting dashed drop-zone, low-amplitude hero mesh drift — all adopted.
- ❌ **Maru-gothic for the numeric layer — REJECTED.** It fights the Fraunces editorial voice and re-adds font payload the AMETRINE graft just removed. Hero figures stay **Fraunces**; stat-tile values and all aligned figures stay **Inter tabular-nums**. Two display registers, no third.

---

## 1. Brand mood + name feel

- **Product name:** **Atelier Éclat（アトリエ・エクラ）**. *Éclat* = French for radiance / sparkle — the jewel-and-rose-gold vocabulary of luxury beauty, made literal. The salon mark **KATE** sits in the header; Éclat is the dashboard's own identity.
- **Voice:** editorial and calm-luxurious, not loud. Serif display + Playfair italic kicker + clean JP sans body + real 48–96px whitespace = "designed by a top-1% hand, not a Bootstrap panel."
- **Materials (only three):** champagne paper (warm ivory plane) · deep aubergine-plum ink · a single rose-gold foil accent used **once per view**, only behind the KGI hero.
- **Delight register:** elegant-calm with engineered spikes of ワクワク — the count-up hero, the gloss meters' overshoot + sparkle, the foil sheen wipe, the petal funnel cascade. Excitement is injected surgically so the premium never drops.

---

## 2. Design tokens — paste-ready CSS custom properties

Default `:root` is light. Dark is a **hand-stepped** aubergine set (never an auto-invert), applied by `[data-theme="dark"]`; the manual toggle stamps `data-theme` on `<html>`. Optionally seed from `prefers-color-scheme` on first load via `:root:not([data-theme])`.

```css
:root {
  color-scheme: light;

  /* ── Surfaces (champagne plane) ── */
  --page-bg:          #F6EFE4;
  --surface-1:        #FDFBF7;   /* editorial plate */
  --surface-2:        #F1E7D9;   /* recessed chart well */
  --surface-elevated: #FFFFFF;   /* hero / overlays */
  --champagne:        #E9D8BE;

  /* ── Ink — TEXT NEVER USES A SERIES COLOR ── */
  --ink-primary:   #241522;      /* AA on all surfaces */
  --ink-secondary: #5A4A54;
  --ink-muted:     #8A7C84;

  /* ── Accent = PLUM — carries ALL legible interactive state ── */
  --accent:      #6D3E9E;
  --accent-soft: #EDE1F1;

  /* ── Rose-gold — CHROME ONLY, never encodes data ── */
  --rose-gold:     #B26E4B;
  --rose-gold-ink: #8A5A47;      /* the only metallic allowed near small text (hero 万 unit) */
  --foil-grad: linear-gradient(100deg,#E9D8BE 0%,#E4C39B 38%,#B26E4B 72%,#C98A63 100%);

  /* ── Lines ── */
  --border:   rgba(36,21,34,0.10);
  --gridline: #EBE0D2;           /* recessive hairline */
  --baseline: #D9CBB8;

  /* ── Categorical series — GEMSTONES, fixed slot order, NEVER cycled ── */
  --series-1: #6D3E9E;  /* amethyst  → momo · actual revenue · HotPepper · 客都合 */
  --series-2: #1C8F6B;  /* emerald   → aoi  · 直接来店 · 店都合 */
  --series-3: #C88A1E;  /* topaz     → 電話 · 無断 */
  --series-4: #A62E48;  /* garnet */
  --series-5: #2B62B4;  /* sapphire */
  --series-6: #D67A96;  /* rose-quartz */

  /* ── Funnel ordinal ramp (amethyst; stage1 light → stage5 deep = deeper loyalty) ── */
  --funnel-1: #C9A2D8;
  --funnel-2: #AC7EC6;
  --funnel-3: #9160B0;
  --funnel-4: #764795;
  --funnel-5: #5E3A82;

  /* ── Sequential single-hue (heatmap · cohorts · coupons · DoW · visit-composition) ── */
  --seq-0: #F0E6F4;   /* ≈0, allowed to recede */
  --seq-1: #DEC7E6;
  --seq-2: #C6A0D6;
  --seq-3: #A876C0;
  --seq-4: #8450A6;
  --seq-5: #5E3A82;   /* max */

  /* ── Diverging (reserved; only if a signed polarity ever appears) ── */
  --diverge-pos:     #2B62B4;    /* sapphire */
  --diverge-neutral: #E7DECF;
  --diverge-neg:     #A62E48;    /* garnet */

  /* ── Status — RESERVED for cancel severity + RFM health; ALWAYS icon+label ── */
  --status-good:     #0B7A46;
  --status-warning:  #B58124;
  --status-serious:  #C05A2E;
  --status-critical: #B4371F;

  /* ── Elevation (only two levels + hero exception) ── */
  --shadow-hero:    0 1px 2px rgba(36,21,34,0.06), 0 12px 32px rgba(36,21,34,0.06);
  --shadow-overlay: 0 12px 32px -8px rgba(36,21,34,0.24);
}

[data-theme="dark"] {
  color-scheme: dark;

  --page-bg:          #150F18;
  --surface-1:        #1F1822;
  --surface-2:        #29202E;
  --surface-elevated: #2E2334;
  --champagne:        #E4B88C;

  --ink-primary:   #F4EAEE;
  --ink-secondary: #C3B2BC;
  --ink-muted:     #8F8088;

  --accent:      #C9A2D8;
  --accent-soft: #2C2136;

  --rose-gold:     #E4B88C;
  --rose-gold-ink: #E4B88C;
  --foil-grad: linear-gradient(100deg,#3A2F42 0%,#7A5A46 45%,#E4B88C 78%,#C99A72 100%);

  --border:   rgba(244,234,238,0.12);
  --gridline: #2C2430;
  --baseline: #3A2F42;

  --series-1: #9270C8;
  --series-2: #2FA079;
  --series-3: #BC8B2E;
  --series-4: #CB5570;
  --series-5: #5385D6;
  --series-6: #CC6E90;

  --funnel-1: #EAD7F0;
  --funnel-2: #CBA6DC;
  --funnel-3: #AC7AC6;
  --funnel-4: #8A57A9;
  --funnel-5: #6B4590;

  --seq-0: #2A2036;
  --seq-1: #3D2B4E;
  --seq-2: #573A6B;
  --seq-3: #74508F;
  --seq-4: #9270C8;
  --seq-5: #B79AE0;

  --diverge-pos:     #5385D6;
  --diverge-neutral: #3A2F42;
  --diverge-neg:     #CB5570;

  --status-good:     #4FB980;
  --status-warning:  #E0B05A;
  --status-serious:  #E08A5A;
  --status-critical: #EE7A6A;

  --shadow-hero:    inset 0 1px 0 rgba(255,255,255,0.04), 0 16px 40px rgba(0,0,0,0.5);
  --shadow-overlay: 0 12px 32px -6px rgba(0,0,0,0.55);
}
```

**Palette validation (already run, must re-run `scripts/validate_palette.js` before ship):** worst-adjacent CVD ΔE **42.2 light / 30.6 dark** (target 12); chroma-floor and lightness-band clean both themes; both amethyst ordinal ramps clear the surface floor; every ink + status token passes **WCAG AA** (≥4.5:1 body, ≥3:1 muted/status/non-text UI). Light-mode topaz/sapphire on champagne can sit sub-3:1 as fills — **the relief rule is mandatory there:** those charts always ship selective direct labels + table view + 45° texture backup.

**Fixed entity assignments (locked once, never re-assigned app-wide):**
`momo = series-1 amethyst` · `aoi = series-2 emerald` · `HotPepper = series-1 · 直接来店 = series-2 · 電話 = series-3` · `客都合 = series-1 · 店都合 = series-2 · 無断 = series-3` · `会計済み actual = series-1 SOLID · 受付待ち expected = series-1 45° HATCH` (one hue, texture = the projection/certainty channel).

---

## 3. Typography

**Self-host as subset woff2 (GitHub-Pages / offline-safe): three Latin faces only.** Japanese falls to the OS gothic — perfect on the owner's iPhone, zero JP payload.

```css
:root {
  --font-display: "Fraunces","Hiragino Mincho ProN","Yu Mincho",Georgia,serif;      /* opsz~72, wght 340 */
  --font-kicker:  "Playfair Display",Georgia,serif;                                  /* italic, Latin flourish only */
  --font-sans:    "Inter",system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP",sans-serif;
  --font-num:     var(--font-sans);                                                  /* used with font-variant-numeric: tabular-nums */
  --font-mono:    ui-monospace,"SF Mono","JetBrains Mono","Roboto Mono",monospace;   /* unit suffixes, axis ticks */
}
```

**Register discipline (only TWO display registers):**
- **Fraunces serif is RESERVED** — view titles, the KGI hero figure, and **one pull-quote per view**. Nothing functional.
- **Everything else is Inter / native JP sans.** Values, labels, legends, tables, axes.
- **Playfair italic** — Latin kickers/eyebrows only, `+0.14em` tracking.

**Type scale (px):** `11 · 12 · 13 · 15(base) · 16 · 18 · 22 · 28 · 32 · 44 · 64` (≈1.2–1.25 modular). Line-height 1.6 body, **1.8 JP body**, 1.15 numerals/headings.

| Role | Size / font |
|---|---|
| Hero KGI figure | 64 Fraunces opsz72 (mobile 44), tabular-nums |
| View title (H1) | 32 Fraunces |
| Section (H2) | 22 Fraunces |
| Card title (H3) | 16 sans, `+0.02em` |
| Stat-tile value | 28 Inter tabular-nums |
| Kicker/eyebrow | 12 Playfair italic, `+0.14em`, uppercase-Latin |
| Body | 15 sans |
| Caption / axis | 12–13 muted |
| Legend / tick | 11 |

**Numeral & unit rules:**
- `font-variant-numeric: tabular-nums` on **every vertically-aligned figure** (¥ columns, R/F/M table, axis ticks, meter bubbles) so count-ups never reflow.
- Stat-tile & hero values use Inter figures; the **count-up is width-locked to tabular** during flight, settling to final.
- **Currency:** `¥1,234,567` grouped; the **万 unit sits at `0.6em` in `--rose-gold-ink` in the hero ONLY**. Everywhere else, unit suffixes (`¥ % 件 日`) render one step down in `--font-mono` at `--ink-muted` — the instrument-panel micro-layer.
- JP kana get `+0.02em` tracking and 1.8 line-height. `lang="ja"` on `<html>`; per-token `lang` for stray Latin (KATE, HOT PEPPER, LTV).

---

## 4. Spacing / radius / elevation / card system

**Spacing scale (8pt base, 4 half-step):** `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96`. Section rhythm 48–96; intra-card 16–24. **Whitespace IS the luxury** — editorial side margins 64–96px at ≥900px.

**Radius:** `8` chips/inputs · `14` cards · `22` hero panel · `999` avatars/pills/toggles/meter tracks.

**Cards = "editorial plates":** `--surface-1` fill on the champagne plane, defined by a **1px `--border` hairline, radius 14, NOT a heavy shadow.** Padding 16–24.

**Elevation — strictly two levels + one hero exception (no shadow soup):**
- **L1 — cards:** hairline border, **no drop shadow in light**; in dark, lift via `--surface-2` + `inset 0 1px 0 rgba(255,255,255,0.04)` top-highlight.
- **L2 — overlays** (tooltip, mobile bottom nav, upload sheet, popovers): `backdrop-filter: blur(20px)` over surface at ~0.85 alpha + `--shadow-overlay`.
- **Hero exception (the one soft shadow in the app):** `--shadow-hero` + a 1px rose-gold top-rule with a one-time left→right sheen wipe on load.

**Wide content** (RFM table, 5×5 heatmap, cohort matrix) lives in `overflow-x:auto` containers with a soft champagne fade-mask on the right edge and a **sticky first column**. **The page body never scrolls sideways.** Charts go full-bleed to the card edge on mobile.

---

## 5. Layout & navigation

**Mobile-first, base = phone.** Breakpoints (min-width): **0–479** single column, 16px gutters · **480** stat tiles 2-up, funnel labels inline · **768 (pivot)** bottom-nav → sticky **top tabs**, cards → 2-col grid, staff momo/aoi side-by-side · **1024** content max-width 1120–1200px centered, 12-col grid, hero full-width, charts pair side-by-side, RFM heatmap + table together · **1440** roomier gutters only. Use CSS Grid `auto-fit`/`minmax` so tile rows reflow fluidly.

**Router:** URL hash routes the 5 views (`#overview / #staff / #trend / #rfm / #data`); a `hashchange` listener swaps client-side (Back/Forward + deep links work, no server). Default `#overview`. **Exactly one view mounted at a time** to keep SVG DOM light on phones.

**Desktop (≥768):** slim brand header (KATE mark · `as of 2026-07-03` date chip · theme toggle 🌙/☀ · `サンプルデータ表示中` badge) scrolls away; a **sticky tablist** (`position:sticky; top:0; z-index:50`) with `role="tablist"`, `role="tab"` + `aria-selected` + `aria-controls`, panels `role="tabpanel"`. Active tab = **2px plum underline that slides 240ms** between tabs + ink-strong label. Arrow keys move focus, Home/End to ends, Enter/Space activate, roving tabindex.

**Mobile (<768):** compact 48px sticky top bar; a **fixed frosted-glass bottom nav** (`position:fixed; bottom:0; padding-bottom:env(safe-area-inset-bottom)`, `backdrop-blur(20px)`), 5 equal flex items — `概要 📊 · スタッフ 👥 · 傾向 📈 · 顧客 💎 · データ ⬆`, stacked 20px icon + 11px label, ≥56px tall. Active item = **rose-gold-gradient pill (3px) above the icon that spring-slides**, icon+label flip to plum 600, `aria-current="page"`. `<nav aria-label="主要ナビゲーション">`, each icon carries the full JP name as `aria-label`.

**z-index:** tooltip > bottom-nav / data action-bar > sticky header > content. Add `scroll-padding-top` so anchors clear the sticky header.

---

## 6. Per-view section order (mobile-first, top → bottom)

### 概要 Overview
1. **Hero KGI card — 予約ベース売上** `¥4,550,365`. Giant Fraunces count-up; beneath it the single **会計の帯** split composition bar (会計済み solid amethyst + 受付待ち amethyst 45° hatch, 2px surface gap), direct-labeling only the two subtotals; caption 『会計済み＋これからの予約を合わせた見込み売上』; the one rose-gold foil rule + champagne→rose-gold wash (drifting mesh).
2. **Stat-tile row (5, most-important-first):** 有効予約 701件 · 平均単価 ¥6,491 · リピート率 59.8% · 次回予約率 57.9% · LTV ¥9,541→¥11,880(予測). 2-up phone → 5-up desktop.
3. **月次売上トレンド** (Feb–Aug, actual line + expected hatch area, one ¥ axis).
4. **リテンションファネル** 358→214→66→25→12 — the emotional store-health hook, kept high.
5. **集客経路分析** (route volume + cancel-rate as paired small multiples).
6. **キャンセル内訳** (single stacked hairline bar + 28.7% total + 初回来店なし67件 note).
7. **コホート2回目到達** (reach2 by acquisition month).
8. **来店回数構成** (composition bar + separate spend mini).

### スタッフ Staff
1. **対決サマリー** — momo (amethyst) vs aoi (emerald) mirrored cards; vs-badge per metric.
2. **月次予約数の比較** (paired columns, count).
3. **月次売上の比較** (paired columns, ¥).
4. **単価 & 次回予約率** (paired spend columns + paired gloss meters — never a shared axis).
5. **リピート育成力** — two mini funnels (momo reach2/3/4 · aoi reach2 with **在籍2ヶ月** annotation so 0s aren't misread).

### 傾向 Trend
1. **曜日別パフォーマンス** — segmented control (来店数 / 次回予約率 / 単価 / LTV) drives ONE one-axis bar chart; weekend columns subtly emphasized.
2. **月次コホート リピート & LTV** — paired small multiples (reach2 line % + LTV column ¥).
3. **人気クーポン TOP** — ranked horizontal bars, top ~7 + その他.

### 顧客 RFM
1. **セグメント概要** — 9 segments in value-tier order: chip + 人数 + 構成比 + 推奨アクション + status dot.
2. **F×R セグメントヒートマップ** — 5×5, sequential amethyst + in-cell counts + texture backup; tap a cell filters the table.
3. **セグメント詳細カード** — per-segment avg R/F/M + action (stacked/swipeable).
4. **顧客RFMテーブル** — sortable, sticky first column, own horizontal scroll.

### データ Data
1. **アップロード ドロップゾーン** (dashed, ignites on drag-over).
2. **読み込みプレビュー** (file name, row count, first-5-rows).
3. **列マッピング確認** (matched chips; unmatched required flagged amber).
4. **検証結果パネル** (collapsible errors/warnings + row refs).
5. **適用サマリー** (『701件の有効予約を再計算します』 + recompute button).
6. **サンプルに戻す** (confirm-gated reset). The 適用/リセット action bar is sticky above the bottom nav.

---

## 7. Chart chrome grammar + catalog

### 7a. Shared chart-chrome grammar (one object, reused by every hand-built SVG chart)

- **ONE axis per chart.** Recessive **1px solid hairline grid** (`--gridline`); baseline `--baseline`.
- **Marks:** bars **≤24px** with **4px rounded data-end** (square at baseline); lines **2px** round-cap; markers **≥8px** with a 2px surface ring; area / expected fills **~10% wash or 45° hatch**; **2px surface gap** between every touching/stacked mark.
- **Color:** data marks use gemstone categorical / amethyst ordinal / amethyst sequential only — **never the rose-gold gradient, never a status color as "series N."** **Text always wears ink tokens**, never a series hue; identity rides a swatch/dot beside the label.
- **Legend:** present for **every ≥2-series chart**, omitted for single-series (title names the series). **Selective direct labels only** — endpoints + extremes on time series/cohorts; bounded grids (funnel 5 / heatmap 25 / composition 4) may label every mark because the value *is* the mark. Never a number on every point.
- **Interaction:** hover/tap tooltip by default (crosshair on lines, per-mark on bars/cells/funnel); **`表` table-view toggle on EVERY chart**, styled as a first-class view; SVG `role="img"` + descriptive `aria-label`; texture backup channel toggled by a11y/forced-colors.
- **Expected/projected everywhere** = same hue + hand-drawn 45° `<pattern>` hatch (doubles as the CVD/print channel).

### 7b. Catalog (metric → form → encoding → mobile)

**概要 Overview**

| Metric | Form | Encoding (1 axis) | Mobile |
|---|---|---|---|
| KGI 予約ベース売上 ¥4,550,365 (会計済 ¥3,415,585 + 受付待ち ¥1,134,780) | Hero figure + one 100% composition bar | Fraunces count-up; bar = 会計済 solid `series-1` + 受付待ち `series-1` 45° hatch, 2px gap; legend(2); label the two subtotals only | Hero →¥455万 one line; bar full-width; legend wraps |
| 実効予約数 701 | Stat tile | Value 701; sub 会計済551/予定150; footnote 除外56; no mark | 2-col KPI grid |
| 客単価 ¥6,491 | Stat tile + 12-pt sparkline | ¥ axis implicit; muted line, `series-1` endpoint dot, endpoint labeled | tile ~72px sparkline |
| リピート率 59.8% + 定着率 18.4% | Two gloss meters | Fill = plum `series-1`; track `--accent-soft`; target tick; value bubble tabular | full-width, stacked |
| 次回予約率 57.9% | Gloss meter | as above, 0–100% | full-width |
| LTV ¥9,541→¥11,880 | Stat tile + signed delta | +¥2,339 in `--status-good` (up=good) + arrow glyph + word; sub 期待1.92回 | delta under value |
| リテンションファネル 358→214→66→25→12 | 花びら funnel (5 petals) | `--funnel-1..5` ordinal; 10% plum connective area; label people + reach% (100/59.8/18.4/7.0/3.4); **no legend** | vertical stack, labels at petal end |
| 月次売上推移 (Feb–Aug) | Line (actual) + hatch area (expected), one ¥ axis | actual = 2px `series-1` line + ≥8px markers; expected = `series-1` 45° 10% area; legend(2); label latest + peak only. **Never overlay count.** | 7 pts fit; 2–3-letter months |
| 月次予約件数・新規 | Column small-multiple | total `series-1` + 新規 same-hue hatch sub-segment; legend(2); label peak 166 only | stacks below trend |
| キャンセル内訳 28.7% | Horizontal 100% stacked bar + rate stat | 客都合 `series-1` / 店都合 `series-2` / 無断 `series-3`, 2px gaps; legend(3); 無断 sliver → legend+tooltip only | full-width; legend wraps |
| 流入経路分析 | **Two paired horizontal-bar minis**, shared route order | A: volume, sequential amethyst; B: cancel-rate 0–100%, 電話 68% → `--status-critical` + icon+label (not a series). **No dual axis.** | two 3-row minis stack |
| コホート2回目到達 | Single-series column, 0–100% | `series-1`; **no legend**; n in tooltip only; label latest + max | 6 cols fit |
| 来店回数構成 | Horizontal 100% stacked bar + separate spend mini | ordinal amethyst ramp (more visits = darker), 2px gaps; label two big segments; spend ¥ is its own mini, **not overlaid** | both stack vertically |

**スタッフ Staff** — momo = `series-1`, aoi = `series-2` on **every** chart.

| Metric | Form | Encoding | Mobile |
|---|---|---|---|
| 月平均予約数 (78.7 vs 39.5) | Paired columns (count) | fixed entity colors; legend(2); label both caps; tooltip shows active months (momo6/aoi2) | two bars |
| 月平均売上 (¥557,667 vs ¥445,926) | Paired columns (¥) | own axis; compact ¥ labels | stacks next |
| 客単価 (¥6,270 vs ¥6,886) | Paired columns (¥) | own axis | stacks next |
| 次回予約率 (60.2% vs 77.7%) | Paired gloss meters | fill = each entity hue; track lighter step | stack |
| リピート到達 | Two mini funnels | each entity hue as ordinal ramp; reach% per stage; **aoi reach3/4=0 annotate 在籍2ヶ月** | stack |

**傾向 Trend**

| Metric | Form | Encoding | Mobile |
|---|---|---|---|
| 曜日別 (visits + next-res% + spend + LTV) | Segmented-control-driven single column (one axis per unit) | `series-1`; weekend emphasis; label each frame's extreme; **never 4 axes** | 7 cols; single-char labels |
| 月次コホート リピート率 | Single-series line 0–100% | `series-1`, 2px, ≥8px endpoint marker, endpoint labeled; n in tooltip | full-width |
| 月次コホート LTV | Column small-multiple (¥) | own axis; label max only | stacks under line |
| 人気クーポン TOP | Ranked horizontal bars | sequential amethyst by magnitude; value at tip; top ~7 + その他; **not per-coupon hues** | wraps long JP names |

**顧客 RFM**

| Metric | Form | Encoding | Mobile |
|---|---|---|---|
| 9セグメント 人数・構成比 | Ranked horizontal bars + status dot | **single sequential amethyst** by people (NOT 9 hues); ratio% secondary label; health = status dot+label per row; 0-people segments render as visible 0名 rows | 9 rows scroll-free |
| セグメント R/F/M + アクション | Table + inline micro-bars | tabular-nums; same-hue micro-bar per numeric cell; action = secondary ink | own horizontal scroll, sticky name col |
| F×R ヒートマップ 5×5 | Heatmap | sequential `--seq-0..5` (light≈0 recedes → dark=57); 2px gaps; in-cell count (ink/white by luminance); ordered 45° texture backup | stays square; whole cell tappable |
| 顧客RFM明細 | Table | tabular-nums; segment status dot; sortable/filterable — the view's ultimate fallback | sticky first col, virtualized |

**データ Data**

| Metric | Form | Encoding |
|---|---|---|
| 取込サマリ | Stat-tile row + status banner | 取込件数 / 有効 / 除外56 / 対象期間; banner good/warning icon+label; no marks |

---

## 8. Motion & microinteraction spec

**Two easing tokens only** — `--ease-standard: cubic-bezier(0.22,0.61,0.36,1)` (everything) and `--ease-emphasized: cubic-bezier(0.34,1.56,0.64,1)` (marker/chip/meter/tab-pill overshoot pops). Everything below is gated by `prefers-reduced-motion: reduce` → opacity-only or instant, count-ups snap to final, sheen/sparkle/drift/mesh off, tooltips still work.

| Event | Spec |
|---|---|
| Card entrance | fade + rise 12px, **420ms** `--ease-standard`, **60ms stagger**; IntersectionObserver replays below-fold cards once each |
| Hero count-up | 0→¥4,550,365, **1100ms** ease-out, tabular width-locked so it never reflows; ¥/万 suffix fades in after; split bar wipes L→R in sync |
| Rose-gold foil rule | single **700ms** L→R sheen sweep on load — the one metallic flourish |
| Hero mesh wash | low-amplitude drift, **24s** infinite ease-in-out |
| Bars | grow from baseline (`transform-origin:bottom`), **520ms**, 40ms stagger; 4px rounded end appears after settle |
| Lines | stroke-dashoffset **900ms**, then 10% area fades up; markers pop scale 0.6→1 `--ease-emphasized` |
| Funnel petals | wipe top→bottom 90ms apart; reach% counts up alongside |
| Gloss meter | fill width **700ms** `--ease-emphasized` (small overshoot) → 700ms sheen sweep once; **rose-gold sparkle burst once** when target tick is beaten |
| Tab switch | content cross-fade **180ms**; desktop plum underline / mobile gradient pill slides **240ms** `--ease-emphasized`; icon press-scale 1→1.12→1 |
| View transition | outgoing opacity 1→0 **120ms**; incoming translateY 8px→0 + opacity 0→1 **240ms** `--ease-standard`; scroll resets to top; direction-aware on mobile |
| Tooltip | fade + scale 0.98→1, **120ms**; tapped mark lifts to full opacity, siblings dim ~55% |
| Heatmap | cells fade in on a diagonal wave; hover lifts 2px + plum ring; tap raises cell + smooth-scrolls filtered table into view |
| Segmented switcher | thumb slides **200ms**; bars tween height, y-axis ticks crossfade to new unit |
| Stat tiles / delta chips | hover lift 2px + border brightens to accent@30%; delta arrow nudges |
| Theme toggle | token crossfade **260ms** (not an invert flash); glyph rotates 180° |
| Data upload | dropzone dashed→solid accent + inner glow on drag-over; slim indeterminate sweep on parse; success = green check draw-on + views replay entrance to signal recompute |
| Micro-feedback | every tappable control `:active` scale 0.97 + 150ms opacity flash |

---

## 9. Accessibility checklist (ship-blocking)

- **Table fallback:** every SVG chart has a paired, toggleable `<table>` (`caption` + `<th scope>`, identical numbers) behind a `表で見る` toggle; SVG `role="img"` + summary `aria-label`. RFM detail + segment tables double as their view's fallback.
- **Color never the only channel:** categorical palette validated CVD-safe (deuter/protan/tritan) and entity-locked, never cycled; **texture backup** (45°/135° hatch, ordered on value scales) on the actual/expected split and the heatmap; heatmap cells carry the number on-cell; status is **always icon+label**, never color-alone.
- **Contrast:** all text uses ink tokens, AA in both hand-picked themes (≥4.5:1 body, ≥3:1 muted/large/UI); non-text UI (bars, indicators, focus rings) ≥3:1. Dark is a curated, independently-verified set. Sub-3:1 light fills (topaz/sapphire) rely on the relief rule.
- **Keyboard:** full operability; tablist arrow/Home/End/Enter/Space + roving tabindex; visible **2px focus ring** never removed, high-contrast both themes; Escape closes tooltips/menus; focus moves to the new tabpanel heading on view switch; modals trap focus; no keyboard trap in switchers/sorts.
- **Screen reader / semantics:** landmarks (`<header>`, `<nav aria-label>`, `<main>`, tabpanels `aria-labelledby`); KGI hero `aria-live="polite"` so recompute announces the new 予約ベース売上; toasts + validation via polite live regions; icon-only controls have JP `aria-label`; skeleton/shimmer `aria-hidden`; `lang="ja"` + per-token `lang` for Latin.
- **Touch & motion:** hit targets ≥44×44px (invisible padding on thin bars/tabs; bottom-nav ≥56px); tap-driven tooltips (no hover dependency); `prefers-reduced-motion` fully honored with zero loss of function; no looping auto-motion; `prefers-contrast`/`forced-colors` respected (borders + focus survive).
- **Reflow:** text to 200% zoom and down to 320px with **no horizontal body scroll** — wide tables/charts own their own scroll container with a sticky first column. Inline SVG with `viewBox` + fixed aspect-ratio wrapper (reserve height, no CLS); a `ResizeObserver` re-runs the label-density pass so phones show fewer labels than desktop.
- **Data-view integrity:** all errors non-destructive — the applied dataset stays live until a new one successfully applies; zero-valid-rows → friendly empty state + サンプルに戻す, current view untouched; reload without re-upload falls back to sample, never a blank screen.

---

*End of source of truth. Anything not specified here defers to §7a chart-chrome grammar and §0's two hard laws. Run `scripts/validate_palette.js` and an AA contrast pass on both themes before every release.*