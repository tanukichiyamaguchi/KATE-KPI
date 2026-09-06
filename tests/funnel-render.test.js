/**
 * リテンションファネルの描画テスト（Playwright / Chromium）。
 *
 * エンジン側の数値は kaikei.test.js（Fixture V〜V4）で固定している。ここでは
 * 画面に出る形を固定する:
 *   - 段はデータに応じて増え、上限10段目は「10回以上」と表示される
 *   - 継続率の行は段と段の「間」にだけ出る（最後の段の下には出ない）
 *   - 1人だけの深い段でも「0% 到達」ではなく「1%未満 到達」、棒は最小幅で見える
 *   - 6段目以降の色は5段階の濃淡を使い切ったあと一番濃い色で揃う
 *   - 説明（?）の太字が <b> という文字として見えない・画面内に収まる
 *   - 来店客が0人のデータでは「継続 0% · 離脱 100% 0人 ÷ 0人」ではなく「継続 —」
 *
 * Chromium が無い環境では SKIP（CI 以外での npm test を止めないため）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (e) { /* not installed */ }
const EXEC = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
if (!chromium || !fs.existsSync(EXEC)) {
  console.log('FUNNEL RENDER: \x1b[33mSKIP\x1b[0m (playwright-core / Chromium not available)');
  process.exit(0);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.csv': 'text/csv', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(function (req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m') + '  ' + name + (ok ? '' : '   got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)));
}

// サンプルデータに手を加えた状態でページを開く。sample-data.js の応答末尾に
// 差し込みコードを足す（アプリ側のコードは一切変えない）。
const SAMPLE_JS = fs.readFileSync(path.join(ROOT, 'assets/js/sample-data.js'), 'utf8');
const ADD_REGULAR = `
;(function () {
  var S = KATE.SAMPLE_RESERVATIONS;
  var t = S.filter(function (r) { return r.status === '会計済み'; })[0];
  for (var i = 0; i < 12; i++) {
    S.push(Object.assign({}, t, {
      status: '会計済み', staff: 'momo', custKey: 'zz-test-regular', name: 'テスト常連',
      date: '2026-0' + (1 + Math.floor(i / 4)) + '-' + String(1 + (i % 4) * 7).padStart(2, '0'),
      yoyakuTotal: 5000, payPlanned: 5000, kaikeiTotal: 5000, shohan: null, shohanCat: null, shohanAmount: null
    }));
  }
})();`;
const ONLY_FUTURE = `
;(function () {
  var t = KATE.SAMPLE_RESERVATIONS.filter(function (r) { return r.status === '受付待ち'; })[0];
  KATE.SAMPLE_RESERVATIONS = [
    Object.assign({}, t, { date: '2026-07-10', custKey: 'f1', name: '未来一' }),
    Object.assign({}, t, { date: '2026-07-12', custKey: 'f2', name: '未来二' })
  ];
})();`;

async function open(browser, width, height, inject) {
  const page = await browser.newPage({ viewport: { width: width, height: height } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', function (e) { errors.push(String(e.message)); });
  page.on('console', function (m) { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });
  await page.route('**/assets/js/sample-data.js*', function (route) {
    route.fulfill({ status: 200, contentType: 'text/javascript', body: SAMPLE_JS + inject });
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  return { page: page, errors: errors };
}

(async () => {
  await new Promise(function (ok) { server.listen(0, '127.0.0.1', ok); });
  const browser = await chromium.launch({ executablePath: EXEC });

  for (const vp of [[360, 640], [1280, 900]]) {
    console.log('\n\x1b[1m■ 12回来店の常連が1人いるデータ（' + vp[0] + '×' + vp[1] + '）\x1b[0m');
    const { page, errors } = await open(browser, vp[0], vp[1], ADD_REGULAR);
    const f = await page.evaluate(function () {
      var wrap = document.querySelector('#cFunnel .kate-funnel');
      var rows = Array.prototype.slice.call(wrap.querySelectorAll('.kate-funnel-row'));
      var convs = Array.prototype.slice.call(wrap.querySelectorAll('.kate-funnel-conv'));
      var bars = rows.map(function (r) { return r.querySelector('.kate-funnel-bar'); });
      var card = document.querySelector('#cFunnel').closest('.gsec') || document.querySelector('#cFunnel').parentElement.parentElement;
      return {
        labels: rows.map(function (r) { return r.querySelector('.kate-funnel-label').textContent; }),
        subs: rows.map(function (r) { return r.querySelector('.kate-funnel-val em') ? r.querySelector('.kate-funnel-val em').textContent : ''; }),
        convCount: convs.length,
        lastIsRow: wrap.lastElementChild.classList.contains('kate-funnel-row'),
        minWidthLast: getComputedStyle(bars[bars.length - 1]).minWidth,
        bgLast: getComputedStyle(bars[bars.length - 1]).backgroundColor,
        bg5: getComputedStyle(bars[4]).backgroundColor,
        bg4: getComputedStyle(bars[3]).backgroundColor,
        cardSub: (card.textContent.match(/1回 → [^）]*到達/) || [''])[0]
      };
    });
    check('段は10段', f.labels.length, 10);
    check('10段目のラベルは「10回以上」', f.labels[9], '10回以上');
    check('9段目は「9回」（以上は付かない）', f.labels[8], '9回');
    check('継続率の行は9本（段と段の間だけ）', f.convCount, 9);
    check('最後の段の下に継続率の行は無い', f.lastIsRow, true);
    check('1人だけの段は「1%未満 到達」', f.subs[9], '1%未満 到達');
    check('1人だけの段の棒に最小幅がある', f.minWidthLast, '4px');
    check('6段目以降の色は5段目と同じ（濃淡を使い切ったら一番濃い色）', f.bgLast, f.bg5);
    check('4段目と5段目の色は違う（濃淡はちゃんと変わる）', f.bg4 !== f.bg5, true);
    check('カードの説明が「1回 → 10回以上 到達」', f.cardSub, '1回 → 10回以上 到達');

    const pop = await page.evaluate(function () {
      var btn = Array.prototype.slice.call(document.querySelectorAll('.help-ico')).filter(function (b) { return /各段の到達人数/.test(b.dataset.help); })[0];
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      var p = document.querySelector('.help-pop.show');
      if (!p) return { shown: false };
      var r = p.getBoundingClientRect();
      return { shown: true, hasBold: !!p.querySelector('b'), literalTag: /<\/?b>/.test(p.textContent),
        inView: r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.left >= 0 && r.right <= window.innerWidth + 1,
        mentionsCap: /10回以上/.test(p.textContent) };
    });
    check('説明（?）が開く', pop && pop.shown, true);
    check('説明の太字が <b> として描画される', pop && pop.hasBold, true);
    check('説明に <b> という文字が見えない', pop && pop.literalTag, false);
    check('説明が画面内に収まる', pop && pop.inView, true);
    check('説明に「10回以上」の但し書きがある', pop && pop.mentionsCap, true);
    check('コンソールエラーなし', errors.length, 0);
    if (errors.length) console.log('    ' + errors.join('\n    '));
    await page.close();
  }

  console.log('\n\x1b[1m■ 来店客が0人（受付待ちだけ）のデータ\x1b[0m');
  {
    const { page, errors } = await open(browser, 390, 844, ONLY_FUTURE);
    const f = await page.evaluate(function () {
      var wrap = document.querySelector('#cFunnel .kate-funnel');
      if (!wrap) return null;
      var convs = Array.prototype.slice.call(wrap.querySelectorAll('.kate-funnel-conv'));
      return { rows: wrap.querySelectorAll('.kate-funnel-row').length, convCount: convs.length, convText: convs.map(function (c) { return c.textContent; }).join(' | ') };
    });
    check('ファネルが描画される', !!f, true);
    check('段は最低2段', f && f.rows, 2);
    check('継続率の行は1本', f && f.convCount, 1);
    check('誰もいない段の継続率は「—」', !!(f && /継続 —/.test(f.convText)), true);
    check('「0人 ÷ 0人」を出さない', !!(f && /0人 ÷ 0人/.test(f.convText)), false);
    check('コンソールエラーなし', errors.length, 0);
    if (errors.length) console.log('    ' + errors.join('\n    '));
    await page.close();
  }

  await browser.close();
  server.close();
  console.log('\n\x1b[1mSUMMARY\x1b[0m  \x1b[32m' + pass + ' pass\x1b[0m · \x1b[31m' + fail + ' fail\x1b[0m');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('FUNNEL RENDER: unexpected error', e); server.close(); process.exit(1); });
