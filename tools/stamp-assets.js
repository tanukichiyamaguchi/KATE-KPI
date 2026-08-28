#!/usr/bin/env node
/* index.html の資産URL（assets/js/*.js, assets/css/*.css）に package.json の
 * バージョンを ?v= として付け直す。
 *
 * なぜ必要か: GitHub Pages は資産をキャッシュさせるため、修正をデプロイしても
 * 利用者の端末が古い app.js を使い続けることがある。そうなると「直したはずの
 * 不具合がまだ直っていない」という状態になり、原因の切り分けが極めて難しい。
 * バージョンを付けておけば、デプロイのたびにURLが変わり必ず新しい方が読まれる。
 *
 * リリース手順: package.json の version を上げる → node tools/stamp-assets.js
 * （tests/validate.js が、ずれていれば失敗させる） */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const ver = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const file = path.join(root, 'index.html');
const before = fs.readFileSync(file, 'utf8');
const after = before.replace(/((?:src|href)="assets\/(?:js|css)\/[^"?]+)(\?v=[^"]*)?"/g, '$1?v=' + ver + '"');
fs.writeFileSync(file, after);
const n = (after.match(/\?v=/g) || []).length;
console.log((before === after ? 'unchanged' : 'updated') + ': ' + n + ' assets stamped v=' + ver);
