/* URL normalization tests for the Google Sheets link (assets/js/sheets.js).
 * The gid-preservation cases guard a real incident: a "publish to web" URL
 * whose gid was dropped served the wrong tab's CSV (no ステータス column),
 * silently breaking every reservation-based metric. */
'use strict';
const path = require('path');
const sheets = require(path.join(__dirname, '..', 'assets', 'js', 'sheets.js'));

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label.padEnd(52)} got=${got}`);
  ok ? pass++ : fail++;
}
function h(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

h('■ toCsvUrl: 公開URL（pubhtml）はタブ指定（gid）を維持する');
check('pubhtml + gid → pub?output=csv&single&gid',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml?gid=123&single=true'),
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv&single=true&gid=123');
check('pubhtml gidなし → pub?output=csv（従来どおり）',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml'),
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv');

h('■ toCsvUrl: 公開URL（pub 直貼り）も gid を維持する');
check('pub + gid（output=csv無し）→ gid維持',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=55&single=true'),
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv&single=true&gid=55');
check('公開CSV（output=csv付き）はそのまま返す（gidも保持）',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=7&single=true&output=csv'),
  'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=7&single=true&output=csv');

h('■ toCsvUrl: 編集URL → gviz CSV（gid反映）');
check('edit?gid=997 → gviz&gid=997',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/1AbC_-9/edit?gid=997#gid=997'),
  'https://docs.google.com/spreadsheets/d/1AbC_-9/gviz/tq?tqx=out:csv&gid=997');
check('edit gidなし → gid=0',
  sheets.toCsvUrl('https://docs.google.com/spreadsheets/d/1AbC_-9/edit'),
  'https://docs.google.com/spreadsheets/d/1AbC_-9/gviz/tq?tqx=out:csv&gid=0');

h('■ toCsvUrl: 不正な入力');
check('スプレッドシート以外のURL → null', sheets.toCsvUrl('https://example.com/x'), null);
check('空文字 → null', sheets.toCsvUrl(''), null);

console.log(`\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m${pass} pass\x1b[0m · \x1b[31m${fail} fail\x1b[0m`);
process.exit(fail > 0 ? 1 : 0);
