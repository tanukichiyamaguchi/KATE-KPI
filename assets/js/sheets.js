/* ============================================================================
 * KATE-KPI · Google Sheets link
 * ----------------------------------------------------------------------------
 * Turn any Google Spreadsheet URL (edit link, share link, or "publish to web"
 * CSV link) into a fetchable CSV endpoint, and fetch it. No backend, no auth —
 * works from a static GitHub Pages site as long as the sheet is readable
 * (shared "anyone with the link" or published to the web).
 * ==========================================================================*/
(function (global) {
  'use strict';

  // Normalize a pasted URL to a CSV endpoint the browser can fetch.
  function toCsvUrl(input) {
    var url = String(input || '').trim();
    if (!url) return null;
    // Already a CSV endpoint (published CSV, export?format=csv, or gviz csv)
    if (/output=csv/i.test(url) || /[?&]format=csv/i.test(url) || /tqx=out:csv/i.test(url)) return url;
    // "Publish to web" HTML link → CSV。元URLにタブ指定（gid）があれば必ず維持する:
    // gid を落とすと Google は「公開時に選ばれた既定タブ」を返すため、ステータス列の
    // 無い別タブのCSVが届いて「必須列が不足」エラーになる（実事故）。
    var pub = url.match(/\/spreadsheets\/d\/e\/([^/]+)\/pubhtml/i) || url.match(/\/spreadsheets\/d\/e\/([^/?#]+)/i);
    if (pub) {
      var pgid = (url.match(/[#&?]gid=([0-9]+)/) || [])[1];
      return 'https://docs.google.com/spreadsheets/d/e/' + pub[1] + '/pub?output=csv' +
        (pgid != null ? '&single=true&gid=' + pgid : '');
    }
    // Standard edit / share URL → gviz CSV (respects a #gid= if present)
    var m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/);
    if (m) {
      var gid = (url.match(/[#&?]gid=([0-9]+)/) || [])[1] || '0';
      return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv&gid=' + gid;
    }
    return null;
  }

  function fetchCsv(input) {
    var csvUrl = toCsvUrl(input);
    if (!csvUrl) return Promise.reject(new Error('URLを認識できませんでした。GoogleスプレッドシートのURLを貼ってください。'));
    return fetch(csvUrl, { redirect: 'follow', credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) throw new Error('取得に失敗しました（HTTP ' + res.status + '）。スプレッドシートの共有設定をご確認ください。');
        return res.text();
      })
      .then(function (text) {
        // A permission page or gviz error comes back as HTML, not CSV.
        if (/^\s*</.test(text) || /<!DOCTYPE/i.test(text.slice(0, 200))) {
          throw new Error('CSVを取得できませんでした。共有を「リンクを知っている全員（閲覧者）」にするか、「ファイル→共有→ウェブに公開→CSV」で公開したURLを貼ってください。');
        }
        return text;
      })
      .catch(function (err) {
        if (err instanceof TypeError) {   // network / CORS
          throw new Error('接続がブロックされました。「ファイル→共有→ウェブに公開→CSV」で公開したURLを貼ると確実に読み込めます。');
        }
        throw err;
      });
  }

  global.KATE = global.KATE || {};
  global.KATE.sheets = { toCsvUrl: toCsvUrl, fetchCsv: fetchCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.KATE.sheets;
})(typeof window !== 'undefined' ? window : globalThis);
