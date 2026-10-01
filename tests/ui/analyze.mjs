/*
 * 図面解析タブの画面の試験（playwright）。図面は試験の中で作る白紙の PDF（3 ページ）。
 * Gemini には送らない: 差し替え口 self.__hiroiGeminiStub に、作り物の応答（tests/fixtures/analysis_response.json）を返させる。
 * 先に: python3 -m http.server 8792 --bind 127.0.0.1（置き場の根で）
 * 走らせる: node tests/ui/analyze.mjs   （playwright は PLAYWRIGHT_DIR で場所を指せる）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.HIROI_BASE || 'http://127.0.0.1:8792';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SHOTS = path.resolve(HERE, '../../shots');
fs.mkdirSync(SHOTS, { recursive: true });
const RES = JSON.parse(fs.readFileSync(path.resolve(HERE, '../fixtures/analysis_response.json'), 'utf8'));

function headlessShell() {
  const root = path.join(os.homedir(), '.cache/ms-playwright');
  if (!fs.existsSync(root)) return undefined;
  const dir = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
  return dir ? path.join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell') : undefined;
}
function blankPdf(n) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(3 + i + ' 0 R');
  objs.push('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>');
  for (let i = 0; i < n; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] >>');
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += i + 1 + ' 0 obj\n' + o + '\nendobj\n'; });
  const x = out.length;
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + x + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

let failed = 0;
const ok = (c, what, detail) => {
  if (!c) failed++;
  console.log((c ? '  ok   ' : '  FAIL ') + what + (detail !== undefined ? '  ← ' + JSON.stringify(detail) : ''));
};
const browser = await chromium.launch({ executablePath: headlessShell() });
const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
const st = () => page.evaluate(() => { const s = self.__min.store.state; return { ann: s.annotations.length, send: s.pages.filter((p) => p.send).map((p) => p.index), pick: s.pages.filter((p) => p.pick === true).map((p) => p.index), cats: s.palette.categories.length, labels: s.palette.labels.length, exp: s.palette.expected.length, sys: s.palette.systems.length, notes: s.analysis.notes.length, runs: s.analysis.runs.length }; });
const toS = (x, y) => page.evaluate(([x, y]) => { const v = self.__min.anScreen().state.view; const r = document.querySelector('.an-stage').getBoundingClientRect(); return { x: r.left + v.tx + x * v.scale, y: r.top + v.ty + y * v.scale }; }, [x, y]);
const drag = async (x0, y0, x1, y1) => { const a = await toS(x0, y0); const b = await toS(x1, y1); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.mouse.move(b.x, b.y); await page.mouse.up(); };

await page.goto(BASE + '/app/index.html');
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('hiroi-tool'); });
await page.reload();
await page.waitForTimeout(600);

// 1. PDF を開くと、図面解析のタブから始まる
await page.setInputFiles('#file-pdf', { name: 'blank.pdf', mimeType: 'application/pdf', buffer: blankPdf(3) });
await page.waitForFunction(() => self.__min.app.pdf && self.__min.store.state.pages.length === 3, null, { timeout: 30000 });
await page.waitForTimeout(500);
ok((await page.evaluate(() => self.__min.app.screen)) === 'analyze', 'PDF を開くと図面解析のタブ');
ok((await page.locator('.an-left .an-item').count()) === 3, 'ページの一覧に 3 枚');
ok(await page.locator('#apptabs button').first().textContent() === '図面解析', 'タブの先頭が図面解析');

// 2. 送るページを番号で
const spec = page.locator('.an-left .an-lrow input[type=text]');
await spec.fill('1-3');
await spec.press('Enter');
await page.waitForTimeout(200);
ok(JSON.stringify((await st()).send) === '[1,2,3]', '「1-3」で 3 枚を送る', (await st()).send);
// 1 枚だけ外す（一覧の札）
await page.locator('.an-left .an-item').nth(1).locator('.pill.send').click();
ok(JSON.stringify((await st()).send) === '[1,3]', '一覧の「送る」で 2 枚目を外す', (await st()).send);
await page.locator('.an-left .an-item').nth(1).locator('.pill.send').click();

// 3. 注釈を囲む（キー 3 = 機器表）・選ぶ・題と覚え書き・動かす・消す・元に戻す
await page.evaluate(() => self.__min.anScreen().setPage('pg-002'));
await page.waitForTimeout(300);
await page.locator('.an-stage').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('3');
await drag(100, 100, 300, 200);
await page.waitForTimeout(200);
let a = await page.evaluate(() => self.__min.store.state.annotations[0]);
ok(a && a.kind === 'schedule' && a.page === 'pg-002' && Math.abs(a.bbox[0] - 100) < 1 && Math.abs(a.bbox[2] - 200) < 1, '機器表の筆で囲む', a && a.bbox);
ok((await page.locator('.an-rtabs button.on').textContent()).startsWith('注釈'), '囲むと右は注釈の欄');
await page.locator('.an-rbody input[type=text]').first().fill('器具表');
await page.locator('.an-rbody input[type=text]').first().press('Tab');
await page.locator('.an-rbody textarea').first().fill('2 階だけ');
await page.locator('.an-rbody textarea').first().press('Tab');
await page.waitForTimeout(100);
a = await page.evaluate(() => self.__min.store.state.annotations[0]);
ok(a.title === '器具表' && a.note === '2 階だけ', '題と覚え書き', [a.title, a.note]);
await page.keyboard.press('Escape'); // 選ぶに戻る
await drag(200, 150, 240, 170); // 中を引いて動かす
a = await page.evaluate(() => self.__min.store.state.annotations[0]);
ok(Math.abs(a.bbox[0] - 140) < 1.5 && Math.abs(a.bbox[1] - 120) < 1.5, '選んで引くと動く', a.bbox);
// 角で大きさ
await drag(340, 220, 400, 260);
a = await page.evaluate(() => self.__min.store.state.annotations[0]);
ok(Math.abs(a.bbox[2] - 260) < 2 && Math.abs(a.bbox[3] - 140) < 2, '角を引くと大きさが変わる', a.bbox);
// 題欄を全ページで
await page.keyboard.press('9');
await drag(600, 540, 830, 585);
let s = await st();
ok(s.ann === 2, '題欄を囲む', s.ann);
let plan = await page.evaluate(() => { const p = self.__min.anScreen()._.planNow(); return { pages: p.pages, tags: p.crops.map((c) => c.tag), images: p.images }; });
ok(JSON.stringify(plan.tags) === JSON.stringify(['A1', 'A2@p1', 'A2@p2', 'A2@p3']), '題欄は送る全ページに広がる（札 A2@p1…）', plan.tags);
// 消す → 元に戻す
await page.keyboard.press('Delete');
ok((await st()).ann === 1, 'Delete で消す');
await page.keyboard.press('Control+z');
ok((await st()).ann === 2, 'Ctrl+Z で戻る');
await shot('an_01_annot');

// 4. 解析（作り物の応答）
await page.evaluate((j) => { self.__hiroiGeminiStub = async (body) => { self.__stubBody = body; return { json: j, usage: { promptTokenCount: 100, candidatesTokenCount: 200 }, finish: 'STOP' }; }; }, RES);
await page.click('.an-bar button.primary');
await page.waitForSelector('#modal-root .mback');
ok((await page.locator('#modal-root .mbody').textContent()).includes('p.1-3'), '送る前に、送るものを見せる');
await page.click('#modal-root .mfoot button.primary');
await page.waitForFunction(() => !self.__min.anScreen().state.run && self.__min.anScreen().state.last, null, { timeout: 30000 });
const body = await page.evaluate(() => { const b = self.__stubBody; return { sys: !!b.systemInstruction, schema: !!b.generationConfig.responseSchema, kinds: b.contents[0].parts.map((p) => (p.text ? 't' : p.inlineData ? p.inlineData.mimeType : '?')) }; });
ok(body.sys && body.schema, '頼みに決まりと応答の形が付く');
ok(body.kinds.filter((k) => k === 'application/pdf').length === 1 && body.kinds.filter((k) => k === 'image/png').length === plan.images, 'PDF 1 つと切り抜き ' + plan.images + ' 枚を送る', body.kinds.join(''));
const pdfLen = await page.evaluate(() => self.__stubBody.contents[0].parts.find((p) => p.inlineData && p.inlineData.mimeType === 'application/pdf').inlineData.data.length);
ok(pdfLen > 500, '切り出した PDF が入っている', pdfLen);
s = await st();
ok(s.cats === 12 && s.exp === 2 && s.sys === 2 && s.notes === 2 && s.runs === 1, '結果がパレットと覚え書きに入る', s);
ok(JSON.stringify(s.pick) === '[2,3]', '拾うの印は解析の言うとおり', s.pick);
const p1 = await page.evaluate(() => { const p = self.__min.store.page('pg-001'); return { title: p.title, kinds: p.kinds, by: p.tagBy.title }; });
ok(p1.title === '特記仕様書（E-01）' && p1.by === 'llm', 'ページの題（工事名を外し、図面番号を添える）', p1);
await shot('an_02_done');

// 5. 人が直す: ページの題・拾わない・覚え書き
await page.evaluate(() => self.__min.anScreen().setPage('pg-003'));
await page.click('.an-rtabs button:has-text("ページ")');
await page.locator('.an-rbody .fld input[type=text]').first().fill('幹線 系統図（人）');
await page.locator('.an-rbody .fld input[type=text]').first().press('Tab');
await page.click('.an-rbody .tri button:has-text("拾わない")');
const p3 = await page.evaluate(() => { const p = self.__min.store.page('pg-003'); return { title: p.title, by: p.tagBy.title, pick: p.pick, pickBy: p.pickBy }; });
ok(p3.title === '幹線 系統図（人）' && p3.by === 'human' && p3.pick === false && p3.pickBy === 'human', 'ページの欄を人が直す', p3);
await page.click('.an-rtabs button:has-text("覚え書き")');
const ta = page.locator('.an-note textarea').first();
await ta.fill('呼び線を忘れない');
await ta.press('Tab');
ok((await page.evaluate(() => self.__min.store.state.analysis.notes[0])).text === '呼び線を忘れない', '覚え書きを直す');

// 6. 拾いタブは「拾う」のページだけ
await page.click('#apptabs button[data-screen=pick]');
await page.waitForTimeout(300);
ok((await page.locator('#pages .item').count()) === 1, '拾いタブには「拾う」のページだけ（p.2）', await page.locator('#pages .item').count());
ok((await page.locator('#pagecount').textContent()).includes('1 / 3'), '枚数の表示「1 / 3 枚」');

// 7. 集計の照合・パレットの系統と見込み
await page.click('#apptabs button[data-screen=sum]');
await page.click('.subtabs button:has-text("照合")');
ok((await page.locator('.sumbody table tr').count()) === 3, '照合: パレットの見込み 2 行', await page.locator('.sumbody table tr').count());
await page.click('#apptabs button[data-screen=palette]');
await page.click('.pnav .pk:has-text("系統")');
ok((await page.locator('.ptbl.sys tr').count()) === 3, 'パレット: 系統 2 行');
await page.locator('.ptbl.sys tr').nth(1).locator('input').nth(2).fill('L-2A');
await page.locator('.ptbl.sys tr').nth(1).locator('input').nth(2).press('Tab');
ok((await page.evaluate(() => self.__min.store.state.palette.systems[0])).to === 'L-2A', '系統の終点を直す');
await page.click('.pnav .pk:has-text("見込み")');
await page.locator('.pcenter input[type=number]').first().fill('10');
await page.locator('.pcenter input[type=number]').first().press('Tab');
ok((await page.evaluate(() => self.__min.store.state.palette.expected[0])).count === 10, '見込みの個数を直す');
await shot('an_03_palette');

// 8. 元に戻す: 解析の結果はまとめて戻る
await page.click('#apptabs button[data-screen=analyze]');
// 人の直し 5 つ（題・拾わない・覚え書き・系統・見込み）を戻し、6 回目で解析の結果
for (let i = 0; i < 6; i++) await page.click('#b-undo');
s = await st();
ok(s.cats === 1 && s.notes === 0 && s.exp === 0, '元に戻すで、解析の結果がまとめて消える', s);
// 9. 最後の応答をもう一度入れる
await page.click('.an-rtabs button:has-text("解析")');
await page.click('button:has-text("最後の応答をもう一度入れる")');
await page.waitForTimeout(300);
s = await st();
ok(s.cats === 12 && s.sys === 2, 'ブラウザに残した応答を、もう一度入れる', s);

// 10. 鍵の欄
await page.evaluate(() => { self.__hiroiGeminiStub = null; });
await page.click('.an-rtabs button:has-text("解析")');
await page.click('.an-rbody button:has-text("鍵を入れる")');
await page.locator('#modal-root input[type=password]').fill('AIzaTEST1234');
await page.click('#modal-root .mfoot button.primary');
ok((await page.evaluate(() => localStorage.getItem('hiroi-tool:gemini-key'))) === 'AIzaTEST1234', '鍵をこのブラウザに保存する');
ok((await page.locator('.an-rbody').textContent()).includes('…1234'), '鍵は末尾 4 文字だけ見せる');
await page.click('.an-rbody button:has-text("変える")');
await page.click('#modal-root .mfoot button:has-text("消す")');
ok((await page.evaluate(() => localStorage.getItem('hiroi-tool:gemini-key'))) === null, '鍵を消す');

// 11. 読み直しても残る（localStorage）
await page.reload();
await page.waitForFunction(() => self.__min && self.__min.app.pdf, null, { timeout: 30000 });
s = await st();
ok(s.ann === 2 && s.cats === 12, '読み直しても注釈と結果が残る', s);
await shot('an_04_reload');

console.log('problems:', problems.length ? problems : 'なし');
if (problems.length) failed++;
console.log(failed ? 'FAILED ' + failed : 'ALL OK');
await browser.close();
process.exit(failed ? 1 : 0);
