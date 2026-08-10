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

  // 貼られたURLから、試すCSVエンドポイントを優先順に組み立てる。
  //
  // 重要: 通常の編集URLは /export?format=csv を第一候補にする。以前使っていた
  // /gviz/tq?tqx=out:csv は Visualization API の「クエリ」エンドポイントで、
  // Google 側が結果をキャッシュするため、シートを更新してもしばらく古い内容が
  // 返ることがある（未知のクエリパラメータでは確実に破棄できない）。
  // /export はファイルのCSV書き出しそのものなので、常に現在の内容が返る。
  // 万一 /export が使えない場合に備えて gviz を第二候補として残す。
  function docRef(url) {
    var m = url.match(/\/spreadsheets\/d\/(?!e\/)([a-zA-Z0-9\-_]+)/);
    if (!m) return null;
    return { id: m[1], gid: (url.match(/[#&?]gid=([0-9]+)/) || [])[1] || '0' };
  }
  function csvEndpoints(input) {
    var url = String(input || '').trim();
    if (!url) return [];
    // 「ウェブに公開」URL（/d/e/…）は本来のドキュメントIDを含まないため、
    // 公開用エンドポイントを使うほかない（この形式は再公開しないと凍結する）。
    var pub = url.match(/\/spreadsheets\/d\/e\/([^/?#]+)/i);
    if (pub) return [/output=csv/i.test(url) ? url : 'https://docs.google.com/spreadsheets/d/e/' + pub[1] + '/pub?output=csv'];
    var d = docRef(url);
    if (d) {
      return [
        'https://docs.google.com/spreadsheets/d/' + d.id + '/export?format=csv&gid=' + d.gid,
        'https://docs.google.com/spreadsheets/d/' + d.id + '/gviz/tq?tqx=out:csv&gid=' + d.gid
      ];
    }
    if (/output=csv/i.test(url) || /[?&]format=csv/i.test(url) || /tqx=out:csv/i.test(url)) return [url];
    return [];
  }
  // 後方互換: 第一候補を返す（設定画面の表示などで使う）
  function toCsvUrl(input) { return csvEndpoints(input)[0] || null; }

  // キャッシュ対策: ブラウザや中間キャッシュが古いCSVを返して「シートは更新
  // されているのにダッシュボードに反映されない」となるのを防ぐ。毎回異なる
  // _ts パラメータでURLを変え（Googleは未知のパラメータを無視する）、さらに
  // fetch 自体も no-store でHTTPキャッシュを完全に迂回する。
  function bust(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + '_ts=' + Date.now();
  }

  // どの経路で取れたかの短い識別子（診断表示用）
  function endpointKind(url) {
    if (/\/export\?/.test(url)) return 'export';
    if (/gviz\/tq/.test(url)) return 'gviz';
    return 'pub';
  }
  // opts.onEndpoint(url, kind) — 実際に取得できたエンドポイントを呼び出し側に伝える
  function fetchCsv(input, opts) {
    opts = opts || {};
    var list = csvEndpoints(input);
    if (!list.length) return Promise.reject(new Error('URLを認識できませんでした。GoogleスプレッドシートのURLを貼ってください。'));
    var lastErr = null;
    // 候補を順に試し、最初にCSVが取れたものを採用する（/export が使えない場合の保険）
    function attempt(i) {
      if (i >= list.length) return Promise.reject(lastErr || new Error('取得に失敗しました。'));
      return fetch(bust(list[i]), { redirect: 'follow', credentials: 'omit', cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('取得に失敗しました（HTTP ' + res.status + '）。スプレッドシートの共有設定をご確認ください。');
          return res.text();
        })
        .then(function (text) {
          // A permission page or gviz error comes back as HTML, not CSV.
          if (/^\s*</.test(text) || /<!DOCTYPE/i.test(text.slice(0, 200))) {
            throw new Error('CSVを取得できませんでした。共有を「リンクを知っている全員（閲覧者）」にするか、「ファイル→共有→ウェブに公開→CSV」で公開したURLを貼ってください。');
          }
          if (opts.onEndpoint) opts.onEndpoint(list[i], endpointKind(list[i]));
          return text;
        })
        .catch(function (err) {
          if (err instanceof TypeError) {   // network / CORS
            err = new Error('接続がブロックされました。「ファイル→共有→ウェブに公開→CSV」で公開したURLを貼ると確実に読み込めます。');
          }
          lastErr = err;
          return attempt(i + 1);
        });
    }
    return attempt(0);
  }

  global.KATE = global.KATE || {};
  global.KATE.sheets = { toCsvUrl: toCsvUrl, csvEndpoints: csvEndpoints, fetchCsv: fetchCsv, bust: bust };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.KATE.sheets;
})(typeof window !== 'undefined' ? window : globalThis);
