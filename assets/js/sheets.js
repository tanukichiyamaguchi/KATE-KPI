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
    // "Publish to web" HTML link → CSV
    var pub = url.match(/\/spreadsheets\/d\/e\/([^/]+)\/pubhtml/i);
    if (pub) return 'https://docs.google.com/spreadsheets/d/e/' + pub[1] + '/pub?output=csv';
    var pubBare = url.match(/\/spreadsheets\/d\/e\/([^/?#]+)/i);
    if (pubBare) return 'https://docs.google.com/spreadsheets/d/e/' + pubBare[1] + '/pub?output=csv';
    // Standard edit / share URL → gviz CSV (respects a #gid= if present)
    var m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/);
    if (m) {
      var gid = (url.match(/[#&?]gid=([0-9]+)/) || [])[1] || '0';
      return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv&gid=' + gid;
    }
    return null;
  }

  // キャッシュ対策: ブラウザや中間キャッシュが古いCSVを返して「シートは更新
  // されているのにダッシュボードに反映されない」となるのを防ぐ。毎回異なる
  // _ts パラメータでURLを変え（Googleは未知のパラメータを無視する）、さらに
  // fetch 自体も no-store でHTTPキャッシュを完全に迂回する。
  function bust(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + '_ts=' + Date.now();
  }

  function fetchCsv(input) {
    var csvUrl = toCsvUrl(input);
    if (!csvUrl) return Promise.reject(new Error('URLを認識できませんでした。GoogleスプレッドシートのURLを貼ってください。'));
    return fetch(bust(csvUrl), { redirect: 'follow', credentials: 'omit', cache: 'no-store' })
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
  global.KATE.sheets = { toCsvUrl: toCsvUrl, fetchCsv: fetchCsv, bust: bust };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.KATE.sheets;
})(typeof window !== 'undefined' ? window : globalThis);
