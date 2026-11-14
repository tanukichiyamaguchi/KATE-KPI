/* ============================================================================
 * KATE-KPI · 月の売上目標（スプレッドシートの「目標」タブ）
 * ----------------------------------------------------------------------------
 * 目標値は、連携中のスプレッドシート（予約データと同じファイル）に「目標」という
 * タブを1枚足して書いてもらう。書き換えれば全端末に反映され、公開リポジトリには
 * 何も置かない（金額が外から見えない）。
 *
 *   「目標」タブの例（1行目が見出し。金額は税抜。列の順番は自由）
 *     月       | お店     | momo   | aoi
 *     2026/11  | 1200000  | 700000 | 500000
 *     2026/12  | 1400000  | 800000 | 600000
 *     毎月     | 1000000  | 600000 | 400000   ← 該当月の行が無いときに使う（任意）
 *
 *  ・見出しに「（税込）」と書いた列は税込の金額として扱う（例「お店（税込）」）。
 *  ・金額は 1200000 / 1,200,000 / ¥1,200,000 / 120万 のどれでもよい。
 *  ・スタッフの列名はダッシュボードのスタッフ名（予約データのスタッフ名）と同じにする。
 *  ・「データ更新日時」など、ここで使わない列は無視する。
 *
 * 読み込み経路: 予約データの連携URL（/spreadsheets/d/<ID>/…）と同じファイルの
 * 「目標」タブを gviz の sheet= 指定で読む。「ウェブに公開」URL（/d/e/…）は
 * ファイルIDを含まないため別のタブを指定できない（unsupported）。
 * gviz は存在しないタブ名を指定されると1枚目（予約データ）を返すことがあるため、
 * 見出しを検査して「目標の表ではない」ものは採用しない（wrong-sheet）。
 * ==========================================================================*/
(function (global) {
  'use strict';
  var TAB_NAME = '目標';

  function norm(v) { return String(v == null ? '' : v).normalize('NFKC').replace(/^﻿/, '').trim(); }
  function compact(v) { return norm(v).replace(/\s+/g, ''); }

  // 連携URL → 同じファイルの「目標」タブを読むURL（読めない形式なら null）
  function urlFor(sheetUrl) {
    var m = String(sheetUrl || '').match(/\/spreadsheets\/d\/(?!e\/)([a-zA-Z0-9\-_]+)/);
    if (!m) return null;
    return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(TAB_NAME);
  }

  // 「月」の列の値 → 'YYYY-MM'（毎月の既定値は '*'、読めなければ null）
  function parseMonth(v) {
    var s = norm(v);
    if (!s) return null;
    if (/^(毎月|基本|標準|通常|共通|既定|default|\*)$/i.test(s)) return '*';
    var m = s.match(/^(\d{4})\s*[\/\-.年]\s*(\d{1,2})/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return m[1] + '-' + ('0' + +m[2]).slice(-2);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);           // 米国式の日付（11/1/2026）
    if (m && +m[1] >= 1 && +m[1] <= 12) return m[3] + '-' + ('0' + +m[1]).slice(-2);
    var n = Number(s);                                          // 日付のシリアル値
    if (isFinite(n) && n > 20000 && n < 80000) {
      var d = new Date(Math.round((n - 25569) * 86400000));
      return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
    }
    return null;
  }
  // 金額セル → 数値（0・空・読めない値は「目標なし」＝ null）
  function parseAmount(v) {
    var s = compact(v).replace(/[,¥￥円]/g, '');
    if (!s) return null;
    var mul = 1;
    if (/万$/.test(s)) { mul = 10000; s = s.slice(0, -1); }
    else if (/千$/.test(s)) { mul = 1000; s = s.slice(0, -1); }
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    var n = Number(s) * mul;
    return n > 0 ? Math.round(n) : null;
  }

  var MONTH_HEADERS = ['月', '年月', '対象月', '月度', '期間'];
  var STORE_RE = /^(お店|店舗|店|全体|店舗全体|お店全体|全店|合計|お店合計)$/;
  // 見出し → { key: 'store' | 'staff', name, taxIncl }（使わない列は null）
  function classify(label, staffNames) {
    var raw = compact(label);
    if (!raw || raw === 'データ更新日時') return null;
    var taxIncl = /税込/.test(raw);
    var base = raw.replace(/[（(][^）)]*[）)]/g, '')            // （税抜）などの注記
      .replace(/(税込|税抜|税別)/g, '')
      .replace(/(の)?(売上)?(目標)?(金額)?$/g, '')
      .replace(/さん$/, '');
    if (!base) return null;
    if (STORE_RE.test(base)) return { key: 'store', name: 'お店', taxIncl: taxIncl, label: norm(label) };
    var lower = base.toLowerCase();
    for (var i = 0; i < (staffNames || []).length; i++) {
      if (compact(staffNames[i]).toLowerCase() === lower) return { key: 'staff', name: staffNames[i], taxIncl: taxIncl, label: norm(label) };
    }
    return { key: 'unknown', name: base, taxIncl: taxIncl, label: norm(label) };
  }

  // 目標タブのCSV（文字列）または表（配列の配列）を解析する。
  function parse(input, staffNames) {
    var aoa = typeof input === 'string'
      ? (global.KATE && global.KATE.ingest ? global.KATE.ingest.parseCSV(input) : [])
      : (input || []);
    var hi = -1, monthCol = -1;
    for (var r = 0; r < Math.min(10, aoa.length) && hi === -1; r++) {
      var cells = (aoa[r] || []).map(compact);
      // gviz がタブ名の指定を無視して1枚目（予約データ・会計明細）を返した場合
      if (cells.indexOf('ステータス') !== -1 || cells.indexOf('会計ID') !== -1 || cells.indexOf('来店日') !== -1) {
        return { ok: false, reason: 'wrong-sheet' };
      }
      for (var c = 0; c < cells.length; c++) {
        // 「月（例 2026/11）」のような注記つきの見出しも「月」とみなす
        if (MONTH_HEADERS.indexOf(cells[c].replace(/[（(][^）)]*[）)]/g, '')) !== -1) { hi = r; monthCol = c; break; }
      }
    }
    if (hi === -1) return { ok: false, reason: 'no-header' };
    var header = aoa[hi];
    var cols = [], unknown = [];
    header.forEach(function (h, i) {
      if (i === monthCol) return;
      var k = classify(h, staffNames);
      if (!k) return;
      if (k.key === 'unknown') { unknown.push(k.label); return; }
      cols.push({ idx: i, key: k.key, name: k.name, taxIncl: k.taxIncl, label: k.label });
    });
    if (!cols.length) return { ok: false, reason: 'no-columns', unknown: unknown };
    var months = {}, defaults = null, rowsRead = 0;
    for (var i2 = hi + 1; i2 < aoa.length; i2++) {
      var line = aoa[i2] || [];
      var ym = parseMonth(line[monthCol]);
      if (!ym) continue;
      var row = { store: null, staff: {} }, any = false;
      cols.forEach(function (col) {
        var amt = parseAmount(line[col.idx]);
        if (amt == null) return;
        any = true;
        var cell = { amount: amt, taxIncl: col.taxIncl };
        if (col.key === 'store') row.store = cell; else row.staff[col.name] = cell;
      });
      if (!any) continue;
      rowsRead++;
      if (ym === '*') defaults = row; else months[ym] = row;
    }
    return {
      ok: true, months: months, defaults: defaults, rowsRead: rowsRead,
      columns: cols.map(function (c) { return { key: c.key, name: c.name, taxIncl: c.taxIncl, label: c.label }; }),
      unknown: unknown
    };
  }

  // 指定月・指定の対象（'store' またはスタッフ名）の目標を、表示中の税区分の金額で返す。
  // taxRate は表示が税抜のときの税率（例 0.1）、税込表示なら 0。
  function pick(parsed, ym, who, taxRate) {
    if (!parsed || !parsed.ok) return null;
    var row = parsed.months[ym], source = 'month';
    if (!row) { row = parsed.defaults; source = 'default'; }
    if (!row) return null;
    var cell = who === 'store' ? row.store : row.staff[who];
    if (!cell) return null;
    var rate = 0.1;   // 目標の税込・税抜の換算に使う消費税率（ダッシュボードの税抜換算と同じ10%）
    var amount;
    if (taxRate) amount = cell.taxIncl ? cell.amount / (1 + rate) : cell.amount;   // 税抜で表示中
    else amount = cell.taxIncl ? cell.amount : cell.amount * (1 + rate);          // 税込で表示中
    return { amount: amount, source: source, taxIncl: cell.taxIncl };
  }

  // 目標タブを取得する（成功で CSV 本文）。経路は sheets.js の取得処理を共用する。
  function fetchText(sheetUrl) {
    var u = urlFor(sheetUrl);
    if (!u) return Promise.reject(Object.assign(new Error('unsupported'), { reason: 'unsupported' }));
    return global.KATE.sheets.fetchCsv(u);
  }

  var api = { TAB_NAME: TAB_NAME, urlFor: urlFor, parse: parse, pick: pick, parseMonth: parseMonth, parseAmount: parseAmount, fetchText: fetchText };
  global.KATE = global.KATE || {};
  global.KATE.targets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
