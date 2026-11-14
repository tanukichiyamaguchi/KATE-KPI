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
 *  ・「月」の列（いちばん簡単なのは「目標」タブ全体）は、入力する前に
 *    ［表示形式 → 数字 → 書式なしテキスト］にしておく（または '2026/11 のように先頭に
 *    ' を付けて入力する）。そのままだとシートが 2026/11 を日付に変え、同じ列の
 *    「毎月」（文字）と種類が混ざる。gviz（Google の QUERY と同じ仕組み）は1つの列を
 *    多い方の種類で読み、少ない方のセルを空で返すため、「毎月」の行（同数のときは
 *    日付の行のことも）が「月の欄が空の行」として届いてしまう。すでに日付になって
 *    いる欄は、書式を変えたあとで打ち直す。
 *  ・金額は数字だけで書く（1200000）。1,200,000 / ¥1,200,000 / 120万 も読めるが、
 *    120万 のような文字と数字を1つの列に混ぜない（同じ理由で少ない方が空で届く）。
 *  ・見出しに「（税込）」と書いた列は税込の金額として扱う（例「お店（税込）」）。
 *  ・スタッフの列名はダッシュボードのスタッフ名（予約データのスタッフ名）と同じにする。
 *    名前のあとに「さん」「の」「売上」「目標」「金額」（この順）や括弧書きの注記を付けて
 *    もよい（「あやのさん」「しの目標」「aoi（税抜）」）。名前そのものは削らずに照合する
 *    ので、「あやの」「momo(指名)」のような名前もそのまま書けばよい。
 *  ・「お店」と「合計」（「お店合計」）の列が両方あれば「お店」を使い、「合計」は確認用の
 *    列とみなして使わない（ignored で知らせる）。「合計」しか無ければそれをお店の目標にする。
 *  ・同じ相手（お店・同じスタッフ）の列が複数あるときは左の列を使い、後ろの列で
 *    上書きしない。税区分をそろえて ¥1 より大きく違う行は conflicts で知らせる。
 *  ・「データ更新日時」など、ここで使わない列は無視する。
 *  ・金額はあるのに月を読めない行（月の欄が空・「7月」のように年が無い）は使わずに、
 *    skipped でその行番号を知らせる。「合計」「平均」などの集計行は知らせない。
 *
 * 読み込み経路: 予約データの連携URL（/spreadsheets/d/<ID>/…）と同じファイルの
 * 「目標」タブを gviz の sheet= 指定で読む。「ウェブに公開」URL（/d/e/…）は
 * ファイルIDを含まないため別のタブを指定できない（unsupported）。
 * gviz は存在しないタブ名を指定されると1枚目（予約データ・会計明細）を返すことがある
 * ため、見出しが予約データ・会計明細のもの（ingest.js と同じ判定＋来店日）なら
 * 「目標の表ではない」として採用しない（wrong-sheet）。
 *
 * parse() の結果（ok: true のとき。従来の months / defaults / rowsRead / columns /
 * unknown に加えて）。row は見出しの行を1行目として数えたシートの行番号。見出し（label）は
 * columns・unknown と同じく全角・半角をそろえた形（「お店（税込）」→「お店(税込)」）
 *   ignored   : ['合計']                「お店」の列があるので使わなかった「合計」系の列
 *   conflicts : [{ row: 2, key: 'store', labels: ['お店', 'お店(税込)'] }]
 *               同じ相手の列どうしで金額が食い違った行（key は 'store' かスタッフ名、
 *               labels は使った列の見出し・食い違った列の見出しの順）
 *   skipped   : { blankMonth: [5], badMonth: [{ row: 3, text: '7月' }] }
 *               金額はあるのに、月の欄が空（blankMonth）・月として読めない（badMonth）ため
 *               使わなかった行
 * ==========================================================================*/
(function (global) {
  'use strict';
  var TAB_NAME = '目標';
  var TAX_RATE = 0.1;   // 目標の税込・税抜の換算に使う消費税率（ダッシュボードの税抜換算と同じ10%）

  function norm(v) { return String(v == null ? '' : v).normalize('NFKC').replace(/^﻿/, '').trim(); }
  function compact(v) { return norm(v).replace(/\s+/g, ''); }

  // 連携URL → 同じファイルの「目標」タブを読むURL（読めない形式なら null）
  function urlFor(sheetUrl) {
    var m = String(sheetUrl || '').match(/\/spreadsheets\/d\/(?!e\/)([a-zA-Z0-9\-_]+)/);
    if (!m) return null;
    return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(TAB_NAME);
  }

  // CSV本文 → 行の配列（引用符・"" のエスケープ・セル内の改行に対応。ingest.parseCSV と
  // 同じ読み方）。ただし空の行も捨てない。途中に空行（gviz では "","" の行）があっても、
  // skipped・conflicts で知らせる行番号がシートの行番号とずれないようにするため。
  function readCsv(text) {
    text = String(text).replace(/^﻿/, '');
    var rows = [], row = [], field = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c !== '"') field += c;
        else if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function isBlankRow(cells) { return !cells.some(function (x) { return x !== ''; }); }

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
  // お店の目標の列。「合計」「お店合計」はスタッフの目標を足した確認用の列として置かれる
  // ことが多いので、「お店」などはっきりした列があるときは使わない（ignored）。
  var STORE_RE = /^(お店|店舗|店|全体|店舗全体|お店全体|全店)$/;
  var STORE_SUM_RE = /^(合計|お店合計)$/;
  var NOTE_RE = /[（(][^）)]*[）)]/g;                          // （税抜）（指名）などの括弧書き
  var TAX_NOTE_RE = /[（(](税込み?|税抜き?|税別)[）)]/g;         // 税の注記だけの括弧書き
  var TAX_WORD_RE = /(税込み?|税抜き?|税別)/g;
  var TAX_TAIL_RE = /(税込み?|税抜き?|税別)$/;
  var LEAD_NOTE_RE = /^([（(][^）)]*[）)]|税込み?|税抜き?|税別)+/;   // 名前の前に付いた注記（「(担当)momo」「税込momo」）
  var STAFF_SUFFIX_RE = /^(さん)?(の)?(売上)?(目標)?(金額)?$/;  // スタッフ名のあとに付けてよい語（この順）
  var SUMMARY_ROW_RE = /^(合計|小計|総計|計|平均|累計)$/;       // 月の欄がこれの行は集計行（月の行ではない）

  // スタッフ名 → 照合用のキー（全角半角・空白・大文字小文字をそろえる）。名前は削らない。
  // 長い名前から先に試すので、「あやの」の列が「あや」（＋「の」）に取られない。
  function staffKeys(staffNames) {
    var out = [];
    (staffNames || []).forEach(function (n) {
      var k = compact(n).toLowerCase();
      if (k) out.push({ key: k, name: n });
    });
    return out.sort(function (a, b) { return b.key.length - a.key.length; });
  }
  // 見出し（compact・小文字にしたもの）→ スタッフ名（当てはまらなければ null）
  //  (a) 見出しがスタッフ名と同じ
  //  (b) 税の注記（（税込）（税抜）（税別）と末尾の 税込・税抜・税別）だけ除くと同じ
  //  (c) スタッフ名で始まり、続きが「さん」「の」「売上」「目標」「金額」（この順・どれも
  //      省略可）と括弧書きの注記だけ
  //  どれにも当てはまらず、名前の前に注記が付いているときは、その注記だけ除いてもう一度試す
  function matchStaff(lower, staff) {
    var noTax = lower.replace(TAX_NOTE_RE, '').replace(TAX_TAIL_RE, '');
    var i;
    for (i = 0; i < staff.length; i++) if (staff[i].key === lower) return staff[i].name;
    for (i = 0; i < staff.length; i++) if (staff[i].key === noTax) return staff[i].name;
    for (i = 0; i < staff.length; i++) {
      var k = staff[i].key;
      if (noTax.slice(0, k.length) !== k) continue;
      var rest = noTax.slice(k.length).replace(NOTE_RE, '').replace(TAX_WORD_RE, '');
      if (STAFF_SUFFIX_RE.test(rest)) return staff[i].name;
    }
    var noLead = noTax.replace(LEAD_NOTE_RE, '');
    return noLead && noLead !== noTax ? matchStaff(noLead, staff) : null;
  }
  // 見出し → { key: 'store' | 'staff' | 'unknown', name, taxIncl, label, sum }（使わない列は null）
  // staff は staffKeys() の結果。sum は「合計」「お店合計」の列（お店の列が別にあれば使わない）。
  function classify(label, staff) {
    var raw = compact(label);
    if (!raw || raw === 'データ更新日時') return null;
    var taxIncl = /税込/.test(raw);
    var who = matchStaff(raw.toLowerCase(), staff);
    if (who != null) return { key: 'staff', name: who, taxIncl: taxIncl, label: norm(label) };
    // スタッフ名に当てはまらない見出しは、注記と「の売上目標」などを除いて、お店の列か判定する
    var base = raw.replace(NOTE_RE, '')                       // （税抜）などの注記
      .replace(TAX_WORD_RE, '')
      .replace(/(の)?(売上)?(目標)?(金額)?$/g, '')
      .replace(/さん$/, '');
    if (!base) return null;
    if (STORE_RE.test(base)) return { key: 'store', name: 'お店', taxIncl: taxIncl, label: norm(label) };
    if (STORE_SUM_RE.test(base)) return { key: 'store', name: 'お店', taxIncl: taxIncl, label: norm(label), sum: true };
    return { key: 'unknown', name: base, taxIncl: taxIncl, label: norm(label) };
  }

  // 見出しの行が予約データ・会計明細のものか（gviz が「目標」の代わりに1枚目を返したとき）。
  // ingest.js と同じ判定（ステータス・予約番号／会計ID・会計日＋金額）に、来店日も目印に加える。
  // ingest.js が読み込まれていないとき（単体で使うとき）は、同じ条件をここで見る。
  function isDataSheetHeader(cells) {
    var ing = global.KATE && global.KATE.ingest;
    var has = function (name) { return cells.indexOf(name) !== -1; };
    var yoyaku = ing && typeof ing.isYoyakuHeader === 'function' ? ing.isYoyakuHeader(cells) : (has('ステータス') || has('予約番号'));
    var kaikei = ing && typeof ing.isKaikeiHeader === 'function' ? ing.isKaikeiHeader(cells) : (has('会計ID') || (has('会計日') && has('金額')));
    return !!(yoyaku || kaikei || has('来店日'));
  }

  function exTax(cell) { return cell.taxIncl ? cell.amount / (1 + TAX_RATE) : cell.amount; }
  // 1行ぶんの金額を列から集める。同じ相手（お店・同じスタッフ）の列が複数あるときは左の列の
  // 金額を使い、後ろの列で上書きしない。税区分をそろえて ¥1 より大きく違う列は clashes に
  // 記録する（labels は使った列の見出し、食い違った列の見出しの順）。
  function readRow(line, cols) {
    var row = { store: null, staff: {} }, any = false, firstLabel = {}, clashOf = {}, clashes = [];
    cols.forEach(function (col) {
      var amt = parseAmount(line[col.idx]);
      if (amt == null) return;
      any = true;
      var cell = { amount: amt, taxIncl: col.taxIncl };
      var store = col.key === 'store', id = store ? 'store' : 'staff:' + col.name;
      var kept = store ? row.store : (Object.prototype.hasOwnProperty.call(row.staff, col.name) ? row.staff[col.name] : null);
      if (!kept) {
        if (store) row.store = cell; else row.staff[col.name] = cell;
        firstLabel[id] = col.label;
        return;
      }
      if (Math.abs(exTax(kept) - exTax(cell)) <= 1) return;     // 税込・税抜で書き分けただけの同じ額
      if (!clashOf[id]) clashes.push(clashOf[id] = { key: store ? 'store' : col.name, labels: [firstLabel[id]] });
      clashOf[id].labels.push(col.label);
    });
    return { row: row, any: any, clashes: clashes };
  }

  // 目標タブのCSV（文字列）または表（配列の配列）を解析する。
  function parse(input, staffNames) {
    var aoa = typeof input === 'string' ? readCsv(input) : (input || []);
    var hi = -1, monthCol = -1;
    for (var r = 0, seen = 0; r < aoa.length && seen < 10 && hi === -1; r++) {   // 空行を除いた先頭10行から見出しを探す
      var cells = (aoa[r] || []).map(compact);
      if (isBlankRow(cells)) continue;
      seen++;
      // gviz がタブ名の指定を無視して1枚目（予約データ・会計明細）を返した場合
      if (isDataSheetHeader(cells)) return { ok: false, reason: 'wrong-sheet' };
      for (var c = 0; c < cells.length; c++) {
        // 「月（例 2026/11）」のような注記つきの見出しも「月」とみなす
        if (MONTH_HEADERS.indexOf(cells[c].replace(NOTE_RE, '')) !== -1) { hi = r; monthCol = c; break; }
      }
    }
    if (hi === -1) return { ok: false, reason: 'no-header' };
    var staff = staffKeys(staffNames);
    var cols = [], unknown = [], ignored = [];
    aoa[hi].forEach(function (h, i) {
      if (i === monthCol) return;
      var k = classify(h, staff);
      if (!k) return;
      if (k.key === 'unknown') { unknown.push(k.label); return; }
      cols.push({ idx: i, key: k.key, name: k.name, taxIncl: k.taxIncl, label: k.label, sum: !!k.sum });
    });
    // 「お店」などはっきりしたお店の列があれば、「合計」「お店合計」の列は使わない
    if (cols.some(function (col) { return col.key === 'store' && !col.sum; })) {
      cols = cols.filter(function (col) { if (col.sum) { ignored.push(col.label); return false; } return true; });
    }
    if (!cols.length) return { ok: false, reason: 'no-columns', unknown: unknown };
    var months = {}, defaults = null, rowsRead = 0, conflicts = [], skipped = { blankMonth: [], badMonth: [] };
    for (var i2 = hi + 1; i2 < aoa.length; i2++) {
      var line = aoa[i2] || [];
      var sheetRow = i2 - hi + 1;                     // 見出しの行を1行目として数えたシートの行番号
      var got = readRow(line, cols);
      if (!got.any) continue;                         // 金額が1つも無い行（空行・メモだけの行）は数えない
      var ym = parseMonth(line[monthCol]);
      if (!ym) {                                      // 金額はあるのに月を読めない行は、使わずに知らせる
        var text = norm(line[monthCol]);
        if (!text) skipped.blankMonth.push(sheetRow);
        else if (!SUMMARY_ROW_RE.test(compact(text).replace(NOTE_RE, ''))) skipped.badMonth.push({ row: sheetRow, text: text });
        continue;
      }
      got.clashes.forEach(function (cl) { conflicts.push({ row: sheetRow, key: cl.key, labels: cl.labels }); });
      rowsRead++;
      if (ym === '*') defaults = got.row; else months[ym] = got.row;
    }
    return {
      ok: true, months: months, defaults: defaults, rowsRead: rowsRead,
      columns: cols.map(function (col) { return { key: col.key, name: col.name, taxIncl: col.taxIncl, label: col.label }; }),
      unknown: unknown, ignored: ignored, conflicts: conflicts, skipped: skipped
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
    var amount;
    if (taxRate) amount = cell.taxIncl ? cell.amount / (1 + TAX_RATE) : cell.amount;   // 税抜で表示中
    else amount = cell.taxIncl ? cell.amount : cell.amount * (1 + TAX_RATE);          // 税込で表示中
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
