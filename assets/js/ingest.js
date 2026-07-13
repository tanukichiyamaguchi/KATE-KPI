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
    '店販カテゴリ': 'shohanCat',
    '物販カテゴリ': 'shohanCat',
    '会計時店販': 'shohan',
    '店販': 'shohan',
    '店販商品': 'shohan',
    '店販商品名': 'shohan',
    '物販': 'shohan',
    '物販商品': 'shohan',
    '会計時店販金額': 'shohanAmount',
    '店販金額': 'shohanAmount',
    '店販売上': 'shohanAmount',
    '店販売上金額': 'shohanAmount',
    '店販合計': 'shohanAmount',
    '店販価格': 'shohanAmount',
    '物販金額': 'shohanAmount',
    '物販売上': 'shohanAmount',
    '物販合計': 'shohanAmount',
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
  // Two supported layouts: 予約データ (one row / reservation, has ステータス) and
  // 会計明細 (one row / accounting line-item, has 会計日+金額). The latter is
  // grouped by 会計ID into visit records so the same engine can drive it.
  function isYoyakuHeader(h) { return h.indexOf('ステータス') !== -1 || h.indexOf('予約番号') !== -1; }
  function isKaikeiHeader(h) { return h.indexOf('会計ID') !== -1 || (h.indexOf('会計日') !== -1 && h.indexOf('金額') !== -1); }

  function fromAOA(aoa) {
    if (!aoa || !aoa.length) throw new Error('データが空です。');
    // Locate the header row within the first 8 rows (予約データ or 会計明細)
    var headerIdx = -1, kaikei = false;
    for (var r = 0; r < Math.min(8, aoa.length); r++) {
      var joined = aoa[r].map(clean);
      if (isYoyakuHeader(joined)) { headerIdx = r; break; }
      if (isKaikeiHeader(joined)) { headerIdx = r; kaikei = true; break; }
    }
    if (headerIdx === -1) throw new Error('見出し行が見つかりません。「予約データ」（ステータス列）または「会計明細」（会計日・金額列）を含むCSV/Excelをご利用ください。');

    var headers = aoa[headerIdx].map(clean);
    if (kaikei) return { records: fromKaikei(aoa, headerIdx, headers), format: 'kaikei' };
    var colOf = {};
    headers.forEach(function (h, idx) {
      var f = HEADER_MAP[h];
      if (f && !(f in colOf)) colOf[f] = idx;      // first occurrence wins
    });
    var missing = REQUIRED.filter(function (f) { return !(f in colOf); });
    if (missing.length) throw new Error('必須列が不足しています: ' + missing.join(', ') + '。URLが「ステータス」列のあるタブ（予約データ）を指しているかご確認ください（別のタブや古い公開設定のURLでもこのエラーになります）');

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
    return { records: records, format: 'yoyaku' };
  }

  // ---- 会計明細 (POS line-items) → visit records --------------------------
  // Each 会計ID is one paid visit. We sum 金額 across its line items for the
  // checkout total, and the 区分=店販 lines give the retail (店販) name & amount.
  var KAIKEI_ITEM_COL = 'メニュー・店販・割引・サービス・オプション';
  function fromKaikei(aoa, headerIdx, headers) {
    var col = {};
    headers.forEach(function (h, i) { if (!(h in col)) col[h] = i; });   // first occurrence wins
    function cell(row, name) { var i = col[name]; return i == null ? '' : clean(row[i]); }

    // group line items by 会計ID (fallback: 会計日+time+row so a blank ID still groups alone)
    var groups = {}, order = [], MAX_ROWS = 100000;
    for (var i = headerIdx + 1; i < aoa.length; i++) {
      var line = aoa[i]; if (!line) continue;
      var tx = cell(line, '会計ID');
      var dateRaw = cell(line, '会計日');
      if (!tx && !dateRaw) continue;                         // skip blank rows
      var key = tx || (dateRaw + '|' + cell(line, '会計時間') + '|' + i);
      if (!groups[key]) { if (order.length >= MAX_ROWS) break; groups[key] = []; order.push(key); }
      groups[key].push(line);
    }

    function firstNonEmpty(lines, name) {
      for (var j = 0; j < lines.length; j++) { var v = cell(lines[j], name); if (v) return v; }
      return '';
    }
    var records = [];
    for (var g = 0; g < order.length; g++) {
      var lines = groups[order[g]];
      var total = 0, shohanAmt = 0, shohanNames = [], shohanCats = [];
      lines.forEach(function (ln) {
        total += toNum(cell(ln, '金額')) || 0;
        if (cell(ln, '区分') === '店販') {
          shohanAmt += toNum(cell(ln, '金額')) || 0;
          var it = cell(ln, KAIKEI_ITEM_COL); if (it) shohanNames.push(it);
          var ct = cell(ln, 'カテゴリ'); if (ct) shohanCats.push(ct);
        }
      });
      var kana = firstNonEmpty(lines, 'お客様名（フリガナ）');
      var name = firstNonEmpty(lines, 'お客様名');
      var custNo = firstNonEmpty(lines, 'お客様番号');
      var shinki = firstNonEmpty(lines, '新規再来');
      var rec = {
        status: '会計済み',
        date: toISO(cell(lines[0], '会計日')),
        staff: firstNonEmpty(lines, 'スタッフ') || null,
        route: firstNonEmpty(lines, '予約経路') || null,
        shimei: firstNonEmpty(lines, '指名') || null,
        gender: firstNonEmpty(lines, '性別') || null,
        kana: kana || null, name: name || null, phone: null,
        kaikeiTotal: total, yoyakuTotal: total, payPlanned: total,
        shohan: shohanNames.length ? shohanNames.join(' / ') : null,
        shohanCat: shohanCats.length ? shohanCats.join(' / ') : null,
        shohanAmount: shohanAmt || null,
        first: shinki === '新規' ? 'はい' : (shinki === '再来' ? 'いいえ' : null),
        menu: null, menuCat: null, coupon: null, couponCat: null, pay: null,
        // 会計時間 is HHMMSS (e.g. 173645 = 17:36:45) — /100 drops the seconds to
        // give HHMM (1736), matching 予約データ's 開始時間 convention so engine.js
        // can extract the hour the same way (Math.floor(start/100)) for either source.
        start: (function () { var t = toNum(cell(lines[0], '会計時間')); return t ? Math.floor(t / 100) : null; })(),
        end: null, dur: null, usedGift: null, usedPoint: null,
        _time: toNum(cell(lines[0], '会計時間'))   // checkout time-of-day; merge-pairing only, not read by the engine
      };
      var kn = normName(kana), nm = normName(name), cn = clean(custNo);
      rec.custKey = cn ? 'c:' + cn : (kn ? 'k:' + kn : (nm ? 'n:' + nm : 'r:' + g));
      records.push(rec);
    }
    if (!records.length) throw new Error('有効な会計明細が見つかりませんでした。');
    return records;
  }

  // ---- Phase 2: merge 予約データ + 会計明細 --------------------------------
  // Deterministic join on normalized フリガナ (falling back to 氏名) + 来店日／
  // 会計日 — no fuzzy matching. Revenue stays authoritative from the 予約データ
  // side (会計時合計金額); the 会計明細 side only contributes what 予約データ
  // lacks (店販明細・指名・性別・初回フラグ). Neither input array is mutated —
  // every record that reaches the output is a fresh shallow copy.
  function shallowCopy(o) {
    var c = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k];
    return c;
  }
  function personKey(kana, name) {
    var k = normName(kana); if (k) return k;
    var n = normName(name); return n || null;
  }
  function maskKana(s) {
    s = clean(s);
    return s ? s.charAt(0) + '●●' : '';
  }
  function mergeSources(yoyakuRecords, kaikeiRecords) {
    // Group 会計明細 rows by person+date, sorted by 会計時間 within the day.
    var kaikeiByKey = {};
    kaikeiRecords.forEach(function (r) {
      if (!r.date) return;
      var p = personKey(r.kana, r.name); if (!p) return;
      var key = p + '|' + r.date;
      (kaikeiByKey[key] = kaikeiByKey[key] || []).push(r);
    });
    Object.keys(kaikeiByKey).forEach(function (key) {
      kaikeiByKey[key].sort(function (a, b) { return (a._time || 0) - (b._time || 0); });
    });

    // Group 予約データ 会計済み rows by the same key, sorted by 開始時間, keeping
    // each row's original index so we can rebuild the output in original order.
    // Also index each person's visited dates for the ±1-day duplicate check below.
    var yoyakuGroups = {}, personVisitDates = {};
    yoyakuRecords.forEach(function (r, idx) {
      if (r.status !== '会計済み' || !r.date) return;
      var p = personKey(r.kana, r.name); if (!p) return;
      var key = p + '|' + r.date;
      (yoyakuGroups[key] = yoyakuGroups[key] || []).push({ idx: idx, rec: r });
      (personVisitDates[p] = personVisitDates[p] || []).push(r.date);
    });
    Object.keys(yoyakuGroups).forEach(function (key) {
      yoyakuGroups[key].sort(function (a, b) { return (a.rec.start || 0) - (b.rec.start || 0); });
    });

    // ---- Pass 1: positional pairing within each (person, date) key ---------
    var enriched = {};   // yoyaku original-index -> enriched copy
    var kaikeiConsumed = {};   // key -> how many kaikei rows at that key got paired
    var matched = 0, amountMismatchCount = 0, amountMismatchTotal = 0, samples = [];
    Object.keys(yoyakuGroups).forEach(function (key) {
      var yList = yoyakuGroups[key], kList = kaikeiByKey[key] || [];
      var n = Math.min(yList.length, kList.length);
      kaikeiConsumed[key] = n;
      for (var i = 0; i < n; i++) {
        var y = yList[i].rec, k = kList[i];
        var copy = shallowCopy(y);
        if (k.shohan && !copy.shohan) copy.shohan = k.shohan;
        if (k.shohanCat && !copy.shohanCat) copy.shohanCat = k.shohanCat;
        if (k.shohanAmount != null && copy.shohanAmount == null) copy.shohanAmount = k.shohanAmount;
        if (!copy.shimei && k.shimei) copy.shimei = k.shimei;
        if (!copy.gender && k.gender) copy.gender = k.gender;
        if (!copy.first && k.first) copy.first = k.first;
        enriched[yList[i].idx] = copy;
        matched++;
        if (y.kaikeiTotal != null && k.kaikeiTotal != null && Math.abs(y.kaikeiTotal - k.kaikeiTotal) > 0.5) {
          amountMismatchCount++; amountMismatchTotal += Math.abs(y.kaikeiTotal - k.kaikeiTotal);
        }
        if (samples.length < 10) samples.push({ date: y.date, kana: maskKana(y.kana || y.name), type: '結合' });
      }
    });
    var outYoyaku = yoyakuRecords.map(function (r, idx) { return enriched[idx] || shallowCopy(r); });
    var unmatchedYoyakuCount = 0;
    yoyakuRecords.forEach(function (r, idx) { if (r.status === '会計済み' && !enriched[idx]) unmatchedYoyakuCount++; });

    // ---- Pass 2: leftover 会計明細 rows → independent 会計済み records, unless --
    // a same-person 予約データ 会計済み exists within ±1 day (likely the same
    // visit recorded twice — dropped rather than double-counted).
    var extraKaikei = [], unmatchedKaikeiCount = 0, suspectedDup = 0;
    Object.keys(kaikeiByKey).forEach(function (key) {
      var kList = kaikeiByKey[key], consumed = kaikeiConsumed[key] || 0;
      for (var i = consumed; i < kList.length; i++) {
        var k = kList[i];
        var p = personKey(k.kana, k.name);
        var dates = p ? personVisitDates[p] : null;
        var dup = false;
        if (dates) {
          for (var j = 0; j < dates.length; j++) {
            if (Math.abs((new Date(dates[j]) - new Date(k.date)) / 86400000) <= 1) { dup = true; break; }
          }
        }
        if (dup) { suspectedDup++; }
        else {
          unmatchedKaikeiCount++; extraKaikei.push(shallowCopy(k));
          if (samples.length < 10) samples.push({ date: k.date, kana: maskKana(k.kana || k.name), type: '未突合(会計)' });
        }
      }
    });

    var records = outYoyaku.concat(extraKaikei);

    // ---- Re-key custKey using kana↔name reconciliation from matched pairs ---
    // (a customer with kana on one source and only 氏名 on the other would
    // otherwise split into two "different" customers downstream in the engine).
    var kanaByName = {};
    Object.keys(enriched).forEach(function (idx) {
      var r = enriched[idx];
      var nm = normName(r.name), kn = normName(r.kana);
      if (nm && kn) kanaByName[nm] = kn;
    });
    records.forEach(function (r) {
      var kn = normName(r.kana);
      if (!kn) { var nm = normName(r.name); if (nm && kanaByName[nm]) kn = kanaByName[nm]; }
      if (kn) r.custKey = 'k:' + kn;
      else if (normName(r.name)) r.custKey = 'n:' + normName(r.name) + '|' + (r.phone || '');
    });

    var kaikeiTotal = kaikeiRecords.length;
    return {
      records: records,
      report: {
        kaikeiTotal: kaikeiTotal, matched: matched, matchRate: kaikeiTotal ? matched / kaikeiTotal : 0,
        unmatchedKaikei: unmatchedKaikeiCount, unmatchedYoyaku: unmatchedYoyakuCount,
        amountMismatch: { count: amountMismatchCount, totalDiff: Math.round(amountMismatchTotal) },
        suspectedDup: suspectedDup, samples: samples
      }
    };
  }

  // Decode an uploaded file's bytes. HotPepper/POS exports are usually Shift-JIS;
  // Google-published CSVs are UTF-8. Try UTF-8, fall back to Shift-JIS on garble.
  function decodeBuffer(buf) {
    var bytes = new Uint8Array(buf);
    if (typeof TextDecoder === 'undefined') return String.fromCharCode.apply(null, bytes);
    var utf8 = new TextDecoder('utf-8').decode(bytes);
    if (utf8.indexOf('�') !== -1) {                     // invalid UTF-8 → likely Shift-JIS
      try { return new TextDecoder('shift_jis').decode(bytes); } catch (e) { /* fall through */ }
    }
    return utf8;
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
          try { resolve(fromAOA(parseCSV(decodeBuffer(e.target.result)))); } catch (err) { reject(err); }
        };
        reader.readAsArrayBuffer(file);
      }
    });
  }
  function pickSheet(wb) {
    for (var i = 0; i < wb.SheetNames.length; i++) {
      var aoa = global.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1, raw: true, defval: null });
      for (var r = 0; r < Math.min(8, aoa.length); r++) {
        var row = (aoa[r] || []).map(clean);
        if (isYoyakuHeader(row) || isKaikeiHeader(row)) return wb.SheetNames[i];
      }
    }
    return wb.SheetNames[0];
  }

  var api = { parseFile: parseFile, parseCSV: parseCSV, fromAOA: fromAOA, fromKaikei: fromKaikei, mergeSources: mergeSources, decodeBuffer: decodeBuffer, HEADER_MAP: HEADER_MAP };
  global.KATE = global.KATE || {};
  global.KATE.ingest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
