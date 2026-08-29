/**
 * シートの同期を「毎日23時台」に設定する（KATE-KPI ダッシュボード用）
 *
 * データの流れ:
 *   サロンボード → 同期スクリプト（DailyCSVSync など）→ スプレッドシート → ダッシュボード
 *
 * ダッシュボードは「開くたび」と「23:00〜翌1:00の30分おき（画面を開いたままの端末）」に
 * シートを読みに行きます。したがってシート側の同期が23時台に終わっていれば、その日の
 * データが当日中に反映されます。この設定を行うのがこのファイルです。
 *
 * トリガー（実行時刻）は Google アカウントの中にあり、外部からは変更できません。
 * そのため「1回だけ実行する関数」という形で用意しています。トリガー設定画面を
 * 手で操作する必要はありません。
 *
 * ── 使い方 ────────────────────────────────────────────────
 *  1. 同期スクリプトが入っている Apps Script プロジェクトを開く
 *     ・スプレッドシートに紐づいている場合: シートを開き「拡張機能」→「Apps Script」
 *     ・単独プロジェクトの場合: https://script.google.com から開く
 *  2. 左の「ファイル」＋ボタン →「スクリプト」で新しいファイルを追加し、
 *     このファイルの内容を丸ごと貼り付けて保存（Ctrl+S / ⌘S）
 *     ※ 既存のコードは消さないでください。追加するだけです。
 *  3. 上部の関数プルダウンで showSyncSchedule を選び「実行」
 *     → 実行ログに、いま登録されているトリガーの一覧が出ます。
 *       ここに同期の関数名（DailyCSVSync など）があるか確認してください。
 *  4. 続けて setSyncTo2300 を選び「実行」
 *     → 同期のトリガーが毎日23時台に作り直されます。ログに結果が出ます。
 *
 *  自動で見つからない場合は、下の SYNC_FUNCTION に関数名を直接書いてから
 *  もう一度 setSyncTo2300 を実行してください。
 * ────────────────────────────────────────────────────────
 *
 * 注意: Google の仕様で「23時00分ちょうど」は指定できず、実行は23時台のどこか
 * （おおむね23:00〜24:00）になります。ダッシュボード側は23:00 / 23:30 / 0:00 /
 * 0:30 / 1:00 に読み直すので、23時台のどこで同期が終わっても取りこぼしません。
 */

/** 同期を実行している関数名。空なら自動で探します（見つからないときだけ書く） */
var SYNC_FUNCTION = '';

/** 実行させたい時刻（時）。Googleの仕様で分は指定できず、この時台のどこかになる */
var SYNC_HOUR = 23;

/** タイムゾーン。日本時間で23時台に動かす */
var SYNC_TIMEZONE = 'Asia/Tokyo';

/**
 * いま登録されているトリガーを一覧表示する（変更は一切しません）。
 * 「そもそも同期のトリガーがあるのか」「関数名は何か」をここで確認します。
 */
function showSyncSchedule() {
  var triggers = ScriptApp.getProjectTriggers();
  var lines = ['=== このプロジェクトのトリガー一覧（' + triggers.length + '件）==='];
  if (!triggers.length) {
    lines.push('（トリガーは1つも登録されていません）');
    lines.push('→ このプロジェクトには同期の定期実行がありません。同期は別のプロジェクト、');
    lines.push('   または Apps Script 以外の仕組み（PCのツールなど）で動いている可能性があります。');
  }
  triggers.forEach(function (t, i) {
    lines.push((i + 1) + '. 関数: ' + t.getHandlerFunction() + '  種類: ' + t.getEventType());
  });
  lines.push('');
  lines.push('=== このプロジェクトにある関数のうち、同期らしい名前のもの ===');
  var cands = syncCandidates_();
  lines.push(cands.length ? cands.join(', ') : '（見つかりませんでした）');
  lines.push('');
  lines.push('=== 判定 ===');
  var target = detectSyncFunction_();
  lines.push(target
    ? '同期の関数は「' + target + '」と判断しました。setSyncTo2300 を実行すると、これを毎日'
      + SYNC_HOUR + '時台に設定します。'
    : '同期の関数を特定できませんでした。上の一覧から関数名を選び、このファイルの'
      + ' SYNC_FUNCTION に書いてから setSyncTo2300 を実行してください。');
  var out = lines.join('\n');
  Logger.log(out);
  return out;
}

/**
 * 同期のトリガーを「毎日23時台」に作り直す。
 * 同じ関数の時間トリガーは一度削除してから作るので、何度実行しても二重登録されません。
 */
function setSyncTo2300() {
  var target = detectSyncFunction_();
  if (!target) {
    var msg = '同期の関数を特定できませんでした。先に showSyncSchedule を実行し、'
      + '同期の関数名を SYNC_FUNCTION に書いてから、もう一度実行してください。';
    Logger.log(msg);
    throw new Error(msg);
  }

  // 同じ関数の「時間主導型」トリガーだけを消す。onChange などの他のトリガーや、
  // 別の関数のトリガーには触れない（同期以外の仕組みを壊さないため）。
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === target && String(t.getEventType()) === 'CLOCK') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });

  ScriptApp.newTrigger(target)
    .timeBased()
    .atHour(SYNC_HOUR)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(SYNC_TIMEZONE)
    .create();

  var out = [
    '✓ 「' + target + '」を毎日' + SYNC_HOUR + '時台（' + SYNC_TIMEZONE + '）に設定しました。',
    '  既存の時間トリガーを ' + removed + '件 置き換えました。',
    '',
    'Google の仕様で「' + SYNC_HOUR + '時00分ちょうど」は指定できないため、実行は'
      + SYNC_HOUR + '時台のどこかになります。',
    'ダッシュボードは 23:00 / 23:30 / 0:00 / 0:30 / 1:00 に読み直すので、'
      + SYNC_HOUR + '時台のどこで同期が終わっても反映されます。',
    '',
    '左の時計アイコン「トリガー」で、設定が反映されていることを確認できます。'
  ].join('\n');
  Logger.log(out);
  return out;
}

/**
 * 同期の関数名を決める。
 * 1) SYNC_FUNCTION が書かれていればそれ
 * 2) 既存の時間トリガーの対象関数（いま定期実行されているもの＝いちばん確実）
 * 3) 名前から推測（sync / csv / import / daily / 同期 / 取込 など）
 */
function detectSyncFunction_() {
  if (SYNC_FUNCTION) return SYNC_FUNCTION;

  var clock = ScriptApp.getProjectTriggers().filter(function (t) {
    return String(t.getEventType()) === 'CLOCK';
  }).map(function (t) { return t.getHandlerFunction(); });
  // このファイル自身の関数は同期ではないので除く
  var own = { showSyncSchedule: 1, setSyncTo2300: 1, detectSyncFunction_: 1, syncCandidates_: 1 };
  // sheet-update-stamp.gs（更新日時スタンプ）も同期ではない
  own.onTimeCheck = 1; own.onSheetChange = 1; own.stampAll_ = 1; own.setup = 1;
  var fromTrigger = clock.filter(function (n) { return !own[n]; });
  if (fromTrigger.length === 1) return fromTrigger[0];

  var cands = syncCandidates_();
  if (cands.length === 1) return cands[0];
  return null;   // 複数候補・0件のときは自動で決めない（間違った関数を毎日動かさないため）
}

/** このプロジェクトにある「同期らしい名前」の関数を集める */
function syncCandidates_() {
  var own = {
    showSyncSchedule: 1, setSyncTo2300: 1, detectSyncFunction_: 1, syncCandidates_: 1,
    onTimeCheck: 1, onSheetChange: 1, stampAll_: 1, setup: 1
  };
  var names = [];
  for (var key in this) {
    if (own[key]) continue;
    try {
      if (typeof this[key] !== 'function') continue;
    } catch (e) { continue; }
    if (/sync|csv|import|daily|fetch|reload|同期|取込|取り込み/i.test(key)) names.push(key);
  }
  return names;
}
