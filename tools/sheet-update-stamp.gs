/**
 * データ更新日時スタンプ（KATE-KPI ダッシュボード用）
 *
 * スプレッドシートのデータが更新されるたびに（毎日 AM0:00 の DailyCSVSync 完了後を
 * 含む）、データのある各タブの見出し行の右端に「データ更新日時」列を自動で作り、
 * 実際にデータが変わった時刻を書き込みます。ダッシュボードはこの列を読み取り、
 * 「データ更新 ◯月◯日 ◯◯:◯◯ 時点」として表示します。
 *
 * DailyCSVSync そのものには一切手を入れません。更新の検知は2系統で行います:
 *  - onChange トリガー（手動編集・外部APIによる更新を即時に検知）
 *  - 10分おきの時間トリガー（Apps Script 製の同期処理による更新は onChange が
 *    発火しないため、ファイルの最終更新時刻を見て拾う保険）
 * 書き込む時刻は「チェックした時刻」ではなく、ファイルが実際に更新された時刻
 * （Drive の最終更新時刻）なので、10分おきの検知でも時刻は正確です。
 *
 * ── 設定手順（スプレッドシートごとに1回だけ・約2分）─────────────────
 *  1. 対象のスプレッドシートを開く
 *  2. メニュー「拡張機能」→「Apps Script」を開く
 *  3. 開いたエディタの中身をすべて消し、このファイルの内容を丸ごと貼り付けて
 *     保存（Ctrl+S / ⌘S）
 *  4. 上部の関数プルダウンで「setup」を選び「実行」→ 初回のみ権限の許可画面が
 *     出るので、自分のアカウントで「許可」
 *  5. 完了。以後は自動で動き続けます（何もしなくてOK）
 *
 * 予約データと会計明細が別のスプレッドシートの場合は、両方に同じ手順で
 * 設定してください。
 * ──────────────────────────────────────────────────────────────
 */

var STAMP_HEADER = 'データ更新日時';   // ダッシュボードが読み取る列名（変更しない）
var GUARD_MS = 30 * 1000;              // 自分のスタンプ書き込みを「データ更新」と誤認しないための猶予

/** 初回に1回だけ実行する：トリガーを設定し、現時点の更新時刻を書き込む */
function setup() {
  // 二重登録を避けるため、既存の同名トリガーを掃除してから作成
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onSheetChange' || fn === 'onTimeCheck') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onSheetChange')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onChange()
    .create();
  // Apps Script 製の同期は onChange を発火させないため、時間トリガーでも監視する
  ScriptApp.newTrigger('onTimeCheck').timeBased().everyMinutes(10).create();
  PropertiesService.getScriptProperties().deleteProperty('selfWriteAt');
  stampAll_();
}

/** シートの内容が変わるたび（手動編集・API更新）に自動で呼ばれる */
function onSheetChange(e) { stampAll_(); }
/** 10分おきに自動で呼ばれる（スクリプト製同期の更新を拾う保険） */
function onTimeCheck() { stampAll_(); }

function stampAll_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;   // 同時実行はスキップ（次の実行が書き込む）
  try {
    var ss = SpreadsheetApp.getActive();
    // 「チェックした時刻」ではなく、ファイルが実際に更新された時刻を採用する
    var updated = DriveApp.getFileById(ss.getId()).getLastUpdated();
    // 直近の更新が自分のスタンプ書き込みなら何もしない（無限ループ・時刻の上書き防止）
    var self = Number(PropertiesService.getScriptProperties().getProperty('selfWriteAt') || 0);
    if (updated.getTime() <= self + GUARD_MS) return;

    var wrote = false;
    ss.getSheets().forEach(function (sh) {
      try {
        if (sh.getLastRow() < 2 || sh.getLastColumn() < 1) return;   // データの無いタブは対象外

        // データの見出し行を探す（ダッシュボードと同じ判定・先頭8行以内）。
        // 見つからないタブはデータ用ではないのでスキップ。
        var lastCol = sh.getLastColumn();
        var scanRows = Math.min(8, sh.getLastRow());
        var top = sh.getRange(1, 1, scanRows, lastCol).getDisplayValues();
        var headerRow = -1;
        for (var r = 0; r < top.length; r++) {
          var cells = top[r].map(function (c) { return String(c).trim(); });
          if (cells.indexOf('ステータス') !== -1 || cells.indexOf('予約番号') !== -1 ||
              cells.indexOf('会計ID') !== -1 || cells.indexOf('会計日') !== -1) { headerRow = r + 1; break; }
        }
        if (headerRow === -1) return;

        // 見出し行から既存の「データ更新日時」列を探す（前後空白は無視して比較）
        var header = top[headerRow - 1].map(function (c) { return String(c).trim(); });
        var col = header.indexOf(STAMP_HEADER) + 1;
        if (col === 0) {
          col = lastCol + 2;   // 無ければ右端+1列空けて新設（同期の書き換えと衝突しにくい位置）
          if (col > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
          sh.getRange(headerRow, col).setValue(STAMP_HEADER);
        }
        var cell = sh.getRange(headerRow + 1, col);
        var prev = cell.getValue();
        if (prev instanceof Date && Math.abs(updated - prev) < 60000) return;   // 変化なし → 書き込まない
        cell.setValue(updated);
        cell.setNumberFormat('yyyy/mm/dd hh:mm:ss');
        wrote = true;
      } catch (err) {
        // 1タブの失敗で他のタブを巻き込まない
        console.error('stamp failed for sheet "' + sh.getName() + '": ' + err);
      }
    });
    if (wrote) PropertiesService.getScriptProperties().setProperty('selfWriteAt', String(Date.now()));
  } finally {
    lock.releaseLock();
  }
}
