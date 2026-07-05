/* Round-trip tests for the 合言葉 (passphrase) crypto used to publish the
 * encrypted spreadsheet URLs in this public repo (data/shared-link.json).
 * Uses the same Web Crypto code path the browser runs (Node 18+ exposes
 * globalThis.crypto). Run: node tests/crypto.test.js */
'use strict';
const path = require('path');
const kcrypto = require(path.join(__dirname, '..', 'assets', 'js', 'crypto.js'));

let pass = 0, fail = 0;
function check(label, ok, detail) {
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  if (ok) pass++; else fail++;
  console.log(`  ${tag}  ${label}${detail ? '  (' + detail + ')' : ''}`);
}
function h(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

(async () => {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    console.log('CRYPTO TEST: SKIP (Web Crypto not available in this Node)');
    process.exit(0);
  }

  h('■ 合言葉クリプト: 暗号化 → 復号の往復');
  const payload = { yoyaku: 'https://docs.google.com/spreadsheets/d/abc123/pub?output=csv', kaikei: 'https://docs.google.com/spreadsheets/d/xyz789/pub?output=csv' };
  const blob = await kcrypto.encrypt('ねこのて2026', payload);
  check('blob has v/salt/iv/ct', blob.v === 1 && !!blob.salt && !!blob.iv && !!blob.ct);
  check('ciphertext does not contain the URL', JSON.stringify(blob).indexOf('docs.google.com') === -1);
  const back = await kcrypto.decrypt('ねこのて2026', blob);
  check('decrypt returns the exact payload', JSON.stringify(back) === JSON.stringify(payload));

  h('■ 間違った合言葉は明確に失敗する');
  let wrongErr = null;
  try { await kcrypto.decrypt('wrong-pass', blob); } catch (e) { wrongErr = e; }
  check('wrong passphrase rejects', !!wrongErr, wrongErr && wrongErr.message);

  h('■ 同じ合言葉でも毎回異なる暗号文（salt/ivがランダム）');
  const blob2 = await kcrypto.encrypt('ねこのて2026', payload);
  check('two encryptions differ', blob.ct !== blob2.ct && blob.salt !== blob2.salt);
  const back2 = await kcrypto.decrypt('ねこのて2026', blob2);
  check('second blob also decrypts', JSON.stringify(back2) === JSON.stringify(payload));

  h('■ 壊れたデータの扱い');
  let malformedErr = null;
  try { await kcrypto.decrypt('ねこのて2026', { v: 1, salt: blob.salt, iv: blob.iv, ct: blob.ct.slice(0, -8) + 'AAAAAAAA' }); } catch (e) { malformedErr = e; }
  check('tampered ciphertext rejects (AES-GCM authentication)', !!malformedErr);
  let badShapeErr = null;
  try { await kcrypto.decrypt('x', { hello: 'world' }); } catch (e) { badShapeErr = e; }
  check('unknown blob shape rejects', !!badShapeErr);

  console.log(`\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m${pass} pass\x1b[0m · \x1b[31m${fail} fail\x1b[0m`);
  process.exit(fail > 0 ? 1 : 0);
})();
