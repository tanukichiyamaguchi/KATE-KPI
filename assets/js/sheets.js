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
    var out = [];
    function push(u) { if (u && out.indexOf(u) === -1) out.push(u); }
    // 貼られたURLが、すでにそのままCSVを返す取得先かどうか。
    var isCsvEndpoint = /output=csv/i.test(url) || /[?&]format=csv/i.test(url) || /tqx=out:csv/i.test(url);

    // 「ウェブに公開」URL（/d/e/…）は本来のドキュメントIDを含まないため、
    // 公開用エンドポイントを使うほかない（この形式は再公開しないと凍結する）。
    var pub = url.match(/\/spreadsheets\/d\/e\/([^/?#]+)/i);
    if (pub) {
      push(isCsvEndpoint ? url : 'https://docs.google.com/spreadsheets/d/e/' + pub[1] + '/pub?output=csv');
      return out;
    }

    // すでにCSVの取得先なら、まず「貼られたURLをそのまま」使う。
    // タブ名指定（sheet=）・範囲指定（range=）・クエリ（tq=）は、こちらでは
    // 組み立て直せない。これらを無視して gid から作り直すと、利用者が指定した
    // のとは別のタブ（gid=0＝1枚目）を読んでしまう。
    if (isCsvEndpoint) {
      push(url);
      if (/[?&](sheet|range|tq)=/i.test(url) || !/[?&]gid=\d+/.test(url)) return out;   // 同じタブを再現できない
    }

    // 通常の編集・共有URL → 取得経路を「両方」候補にする。
    // /export はファイルのCSV書き出しそのもので常に現在の内容が返るが、別オリジン
    // からの取得が遮断される（CORS）ことがある。gviz は別オリジンから読めるが、
    // Google側で結果がキャッシュされ古い内容が返ることがある。どちらが使えるかは
    // 環境しだいなので、片方に賭けず両方取りに行き、新しい方を採用する。
    var d = docRef(url);
    if (d) {
      push('https://docs.google.com/spreadsheets/d/' + d.id + '/export?format=csv&gid=' + d.gid);
      push('https://docs.google.com/spreadsheets/d/' + d.id + '/gviz/tq?tqx=out:csv&gid=' + d.gid);
    }
    return out;
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
  // 1本の取得先からCSVを取る（成功でCSV本文、失敗で案内つきのError）
  function fetchOne(url) {
    return fetch(bust(url), { redirect: 'follow', credentials: 'omit', cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('取得に失敗しました（HTTP ' + res.status + '）。スプレッドシートの共有設定をご確認ください。');
        return res.text();
      })
      .then(function (text) {
        // 権限ページや gviz のエラーは CSV ではなく HTML／JS で返ってくる。
        if (/^\s*</.test(text) || /<!DOCTYPE/i.test(text.slice(0, 200))) {
          throw new Error('CSVを取得できませんでした。共有を「リンクを知っている全員（閲覧者）」にするか、「ファイル→共有→ウェブに公開→CSV」で公開したURLを貼ってください。');
        }
        if (/^\s*\/\*O_o\*\//.test(text) || /google\.visualization\.Query\.setResponse/.test(text.slice(0, 200))) {
          throw new Error('スプレッドシートの読み取りが拒否されました。共有を「リンクを知っている全員（閲覧者）」にしてください。');
        }
        return text;
      })
      .catch(function (err) {
        if (err instanceof TypeError) {   // ネットワーク / CORS で遮断された
          err = new Error('この取得経路はブラウザから読めませんでした（接続が遮断されました）。');
        }
        throw err;
      });
  }

  // 候補の取得先を「全部」並行して試し、取れたものをすべて返す。
  //
  // 以前は候補を順に試して最初に成功したものを採用していたが、それだと
  //   ・/export が CORS で読めない環境では常に gviz（キャッシュ有）になる
  //   ・gviz が古いスナップショットを返すと、新しい内容が取れる経路があっても届かない
  // という取りこぼしが起きる。両方取りに行き、どれを採用するかは呼び出し側が
  // 「中身がいちばん新しいもの」で決める。
  //
  // opts.onAttempt(url, kind) — 試した取得先を伝える（失敗診断用）
  function fetchAllCsv(input, opts) {
    opts = opts || {};
    var list = csvEndpoints(input);
    if (!list.length) return Promise.reject(new Error('URLを認識できませんでした。GoogleスプレッドシートのURLを貼ってください。'));
    return Promise.all(list.map(function (u) {
      var kind = endpointKind(u);
      if (opts.onAttempt) opts.onAttempt(u, kind);
      return fetchOne(u).then(
        function (text) { return { ok: true, url: u, kind: kind, text: text }; },
        function (err) { return { ok: false, url: u, kind: kind, error: err }; }
      );
    })).then(function (res) {
      return {
        ok: res.filter(function (r) { return r.ok; }),
        failed: res.filter(function (r) { return !r.ok; })
      };
    });
  }

  // 後方互換の薄いラッパ: 候補順で最初に取れたCSV本文を返す。
  // opts.onEndpoint(url, kind) — 実際に採用した取得先を伝える
  // opts.onAttempt(url, kind)  — 試した取得先を順に伝える
  function fetchCsv(input, opts) {
    opts = opts || {};
    return fetchAllCsv(input, opts).then(function (r) {
      if (!r.ok.length) {
        // 失敗理由は経路ごとに違う（片方は共有設定、片方はCORS など）。
        // 1本分だけ返すと本当の原因が隠れるため、全経路の理由を持たせる。
        var e = (r.failed[0] && r.failed[0].error) || new Error('取得に失敗しました。');
        e.routes = r.failed.map(function (f) { return { kind: f.kind, message: f.error && f.error.message }; });
        throw e;
      }
      if (opts.onEndpoint) opts.onEndpoint(r.ok[0].url, r.ok[0].kind);
      return r.ok[0].text;
    });
  }

  global.KATE = global.KATE || {};
  global.KATE.sheets = { toCsvUrl: toCsvUrl, csvEndpoints: csvEndpoints, fetchCsv: fetchCsv, fetchAllCsv: fetchAllCsv, bust: bust };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.KATE.sheets;
})(typeof window !== 'undefined' ? window : globalThis);
