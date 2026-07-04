/* ============================================================================
 * KATE-KPI · Ingest
 * ----------------------------------------------------------------------------
 * Turns an uploaded 予約データ sheet (CSV or XLSX) into normalized reservation
 * records the engine understands. Header matching is by Japanese column name
 * (first occurrence), so column order is flexible. Customer identity is the
 * normalized フリガナ (falling back to name+phone), matching the workbook.
 * ==========================================================================*/
(function (global) {
  'use strict';

  // Japanese 予約データ header → internal field. First matching column wins,
  // so the duplicate 開始時間/終了時間/性別/電話番号 columns resolve to the
  // reservation-side values (matching the workbook layout).
  var HEADER_MAP = {
    'ステータス': 'status',
    'スタッフ名': 'staff',
    '指名予約有無': 'shimei',
    '来店日': 'date',
    '開始時間': 'start',
    '終了時間': 'end',
    '所要時間': 'dur',
    '予約経路': 'route',
    '支払い種別': 'pay',
    '予約時メニューカテゴリ': 'menuCat',
    '予約時メニュー': 'menu',
    '予約時HotPepperBeautyクーポン': 'coupon',
    '予約時HotPepperBeautyクーポンカテゴリ': 'couponCat',
    '会計時店販カテゴリ': 'shohanCat',
    '会計時店販': 'shohan',
    '会計時店販金額': 'shohanAmount',
    '店販金額': 'shohanAmount',
    '物販金額': 'shohanAmount',
    'フリガナ': 'kana',
    'お名前': 'name',
    '電話番号': 'phone',
    '性別': 'gender',
    '予約時合計金額': 'yoyakuTotal',
    'お支払い予定金額': 'payPlanned',
    '会計時合計金額': 'kaikeiTotal',
    '予約時利用ギフト券': 'usedGift',
    '予約時利用ポイント': 'usedPoint',
    'このサロンに行くのは初めてですか？': 'first'
  };
  var REQUIRED = ['status'];
  var NUMERIC = { start: 1, end: 1, dur: 1, yoyakuTotal: 1, payPlanned: 1, kaikeiTotal: 1, usedGift: 1, usedPoint: 1, shohanAmount: 1 };

  function clean(s) { return String(s == null ? '' : s).replace(/^﻿/, '').trim(); }
  function normName(s) { return clean(s).replace(/[\s　]/g, ''); }

  function isoIf(y, mo, day) {   // return ISO only for a real in-range calendar date
    if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || day < 1 || day > 31) return null;
    var d = new Date(y, mo - 1, day);
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }
  function toISO(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return isoIf(v.getFullYear(), v.getMonth() + 1, v.getDate());
    var s = String(v).trim().normalize('NFKC');
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return isoIf(+m[1], +m[2], +m[3]);
    if (/^\d{8}$/.test(s)) return isoIf(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    // Excel serial date fallback
    var n = Number(s);
    if (isFinite(n) && n > 20000 && n < 60000) {
      var d = new Date(Math.round((n - 25569) * 86400000));
      return isoIf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }
  // NFKC folds full-width digits/¥; strip everything but digits, sign, decimal.
  function toNum(v) {
    if (v == null || v === '') return null;
    var s = String(v).normalize('NFKC').replace(/[^0-9.\-]/g, '');
    if (s === '' || s === '-' || s === '.') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  // ---- CSV parser (RFC-4180-ish: quotes, escaped quotes, embedded newlines) -
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var rows = [], row = [], field = '', i = 0, inQ = false, c;
    while (i < text.length) {
      c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return clean(x) !== ''; }); });
  }

  // ---- Array-of-arrays → records ------------------------------------------
  function fromAOA(aoa) {
    if (!aoa || !aoa.length) throw new Error('データが空です。');
    // Locate the header row (contains ステータス or 予約番号) within the first 8 rows
    var headerIdx = -1;
    for (var r = 0; r < Math.min(8, aoa.length); r++) {
      var joined = aoa[r].map(clean);
      if (joined.indexOf('ステータス') !== -1 || joined.indexOf('予約番号') !== -1) { headerIdx = r; break; }
    }
    if (headerIdx === -1) throw new Error('「ステータス」列が見つかりません。予約データシートの見出し行を確認してください。');

    var headers = aoa[headerIdx].map(clean);
    var colOf = {};
    headers.forEach(function (h, idx) {
      var f = HEADER_MAP[h];
      if (f && !(f in colOf)) colOf[f] = idx;      // first occurrence wins
    });
    var missing = REQUIRED.filter(function (f) { return !(f in colOf); });
    if (missing.length) throw new Error('必須列が不足しています: ' + missing.join(', '));

    var records = [], MAX_ROWS = 100000;
    for (var i = headerIdx + 1; i < aoa.length; i++) {
      if (records.length >= MAX_ROWS) break;        // guard against pathological uploads
      var line = aoa[i];
      var status = clean(line[colOf.status]);
      if (!status) continue;                        // skip blank rows
      var rec = {};
      Object.keys(colOf).forEach(function (f) {
        var raw = line[colOf[f]];
        if (f === 'date') rec.date = toISO(raw);
        else if (f in NUMERIC) rec[f] = toNum(raw);
        else rec[f] = raw == null ? null : clean(raw);
      });
      var kana = normName(rec.kana);
      var nm = normName(rec.name);
      rec.custKey = kana ? 'k:' + kana : (nm ? 'n:' + nm + '|' + clean(rec.phone) : 'r:' + i);
      records.push(rec);
    }
    if (!records.length) throw new Error('有効な予約行が見つかりませんでした。');
    return records;
  }

  // ---- File entry point ---------------------------------------------------
  function parseFile(file) {
    return new Promise(function (resolve, reject) {
      var name = (file.name || '').toLowerCase();
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('ファイルの読み込みに失敗しました。')); };
      if (/\.(xlsx|xls|xlsm)$/.test(name)) {
        if (!global.XLSX) return reject(new Error('Excel読み込みライブラリが読み込まれていません。'));
        reader.onload = function (e) {
          try {
            var wb = global.XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            var sheet = wb.SheetNames.indexOf('予約データ') !== -1 ? '予約データ' : pickSheet(wb);
            var aoa = global.XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: null });
            resolve(fromAOA(aoa));
          } catch (err) { reject(err); }
        };
        reader.readAsArrayBuffer(file);
      } else {
        reader.onload = function (e) {
          try { resolve(fromAOA(parseCSV(e.target.result))); } catch (err) { reject(err); }
        };
        reader.readAsText(file, 'utf-8');
      }
    });
  }
  function pickSheet(wb) {
    for (var i = 0; i < wb.SheetNames.length; i++) {
      var aoa = global.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1, raw: true, defval: null });
      for (var r = 0; r < Math.min(8, aoa.length); r++) {
        var row = (aoa[r] || []).map(clean);
        if (row.indexOf('ステータス') !== -1 || row.indexOf('予約番号') !== -1) return wb.SheetNames[i];
      }
    }
    return wb.SheetNames[0];
  }

  var api = { parseFile: parseFile, parseCSV: parseCSV, fromAOA: fromAOA, HEADER_MAP: HEADER_MAP };
  global.KATE = global.KATE || {};
  global.KATE.ingest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
