/*
 * 描き直しでスクロールの位置を失わないこと（playwright）。白紙の PDF 40 ページ。
 * 山内さんの指摘（2026-10-02）: 図面解析で「拾う」に印を付けると、ページの一覧が先頭へ戻った。
 * 走らせる: node tests/ui/scroll.mjs（先に python3 -m http.server 8792 --bind 127.0.0.1）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.HIROI_BASE || 'http://127.0.0.1:8792';
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

await page.goto(BASE + '/app/index.html');
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('hiroi-tool'); });
await page.reload();
await page.waitForTimeout(500);
await page.setInputFiles('#file-pdf', { name: 'blank40.pdf', mimeType: 'application/pdf', buffer: blankPdf(40) });
await page.waitForFunction(() => self.__min.app.pdf && self.__min.store.state.pages.length === 40 && self.__min.app.screen === 'analyze', null, { timeout: 30000 });
await page.waitForTimeout(300);

// 1. 図面解析: ページの一覧を下へ送って、見えている行の「拾う」「送る」を押す
const list = page.locator('.an-left .an-pages');
await list.evaluate((el) => { el.scrollTop = 1500; });
await page.waitForTimeout(200);
const y0 = await list.evaluate((el) => el.scrollTop);
ok(y0 > 1000, '一覧を下へ送れる', y0);
const visibleIndex = await page.evaluate(() => { const l = document.querySelector('.an-left .an-pages'); const r = l.getBoundingClientRect(); const items = [...l.querySelectorAll('.an-item')]; return items.findIndex((it) => { const b = it.getBoundingClientRect(); return b.top > r.top + 10 && b.bottom < r.bottom - 10; }); });
const item = page.locator('.an-left .an-item').nth(visibleIndex);
await item.locator('.pill.pick').click();
await page.waitForTimeout(150);
let y1 = await page.locator('.an-left .an-pages').evaluate((el) => el.scrollTop);
ok(Math.abs(y1 - y0) < 2, '「拾う」を押しても一覧の位置が残る', [y0, y1]);
ok((await page.evaluate((i) => self.__min.store.state.pages[i].pick, visibleIndex)) === true, '押したページに「拾う」が付く');
await page.locator('.an-left .an-item').nth(visibleIndex).locator('.pill.send').click();
await page.waitForTimeout(150);
y1 = await page.locator('.an-left .an-pages').evaluate((el) => el.scrollTop);
ok(Math.abs(y1 - y0) < 2, '「送る」を押しても一覧の位置が残る', [y0, y1]);
// 行を押してページを替えても
await page.locator('.an-left .an-item').nth(visibleIndex + 1).click();
await page.waitForTimeout(150);
y1 = await page.locator('.an-left .an-pages').evaluate((el) => el.scrollTop);
ok(Math.abs(y1 - y0) < 2, 'ページを替えても一覧の位置が残る', [y0, y1]);

// 2. 右の欄（解析の欄は長い）: 下へ送って、欄の中の印を替えても残る
await page.click('.an-rtabs button:has-text("解析")');
const rb = page.locator('.an-rbody');
await rb.evaluate((el) => { el.scrollTop = el.scrollHeight; });
const r0 = await rb.evaluate((el) => el.scrollTop);
await page.locator('.an-rbody label.chk input[type=checkbox]').first().click();
await page.waitForTimeout(150);
const [r1, rmax] = await page.locator('.an-rbody').evaluate((el) => [el.scrollTop, el.scrollHeight - el.clientHeight]);
// 印で中身の高さが変わると、送れる幅も変わる。送れる限り元の位置
ok(r0 > 0 && Math.abs(r1 - Math.min(r0, rmax)) < 2, '右の欄の印を替えても位置が残る', [r0, r1, rmax]);

// 3. 拾いのタブ: 「拾う」の印を外して全ページを出し、一覧を下へ送ってページを押す
await page.evaluate(() => self.__min.store.commit('外す', (st, S) => S.setPagesFlag(st.pages.map((p) => p.id), 'pick', null)));
await page.click('#apptabs button[data-screen=pick]');
await page.waitForTimeout(300);
const pl = page.locator('#pages');
await pl.evaluate((el) => { el.scrollTop = 2000; });
await page.waitForTimeout(150);
const p0 = await pl.evaluate((el) => el.scrollTop);
const vis2 = await page.evaluate(() => { const l = document.getElementById('pages'); const r = l.getBoundingClientRect(); return [...l.querySelectorAll('.item')].findIndex((it) => { const b = it.getBoundingClientRect(); return b.top > r.top + 10 && b.bottom < r.bottom - 10; }); });
await page.locator('#pages .item').nth(vis2).click();
await page.waitForTimeout(200);
const p1 = await page.locator('#pages').evaluate((el) => el.scrollTop);
ok(p0 > 1000 && Math.abs(p1 - p0) < 2, '拾いのページの一覧も、押しても位置が残る', [p0, p1]);

console.log('problems:', problems.length ? problems : 'なし');
if (problems.length) failed++;
console.log(failed ? 'FAILED ' + failed : 'ALL OK');
await browser.close();
process.exit(failed ? 1 : 0);
