/*
 * 画面の煙試験（playwright）。図面は試験の中で作る白紙の PDF（2 ページ）を使うので、どこでも走る。
 * 先に: python3 -m http.server 8792 --bind 127.0.0.1（置き場の根で）
 * 走らせる: node tests/ui/smoke.mjs   （playwright は PLAYWRIGHT_DIR で場所を指せる）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
// playwright は、PLAYWRIGHT_DIR があればそこから、無ければこの置き場の node_modules から（npm install）
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const BASE = process.env.HIROI_BASE || 'http://127.0.0.1:8792';
const SHOTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../shots');
fs.mkdirSync(SHOTS, { recursive: true });

function headlessShell() {
  const root = path.join(os.homedir(), '.cache/ms-playwright');
  if (!fs.existsSync(root)) return undefined;
  const dir = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
  return dir ? path.join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell') : undefined;
}
// 白紙の PDF（A4 横・n ページ）
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
const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
const S = () => page.evaluate(() => { const st = self.__min.store.state; return { pk: st.pickups.length, ar: st.areas.length, ct: st.palette.categories.length, lb: st.palette.labels.length, pages: st.pages.length }; });
const at = (x, y) => page.evaluate(([x, y]) => { const r = document.getElementById('stage').getBoundingClientRect(); const [sx, sy] = self.__min.toScreen(x, y); return { x: r.left + sx, y: r.top + sy }; }, [x, y]);
const click = async (x, y) => { const p = await at(x, y); await page.mouse.click(p.x, p.y); };
const drag = async (x0, y0, x1, y1) => { const a = await at(x0, y0); const b = await at(x1, y1); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.mouse.move(b.x, b.y); await page.mouse.up(); };
const cats = () => page.evaluate(() => { const pal = self.__min.palette; const walk = (id) => pal.categoryChildren(id).map((c) => (pal.categoryChildren(c.id).length ? [c.name, walk(c.id)] : c.name)); return walk('cat-root'); });
const typeIn = async (text) => { await page.keyboard.press('Control+a'); await page.keyboard.type(text); };

await page.goto(BASE + '/app/index.html');
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('hiroi-tool'); });
await page.reload();
await page.waitForTimeout(800);
ok(await page.evaluate(() => document.getElementById('welcome').classList.contains('on')), '最初の画面（図面が無い）');

// 1. PDF を開く
await page.setInputFiles('#file-pdf', { name: 'blank.pdf', mimeType: 'application/pdf', buffer: blankPdf(2) });
await page.waitForFunction(() => self.__min.app.pdf && self.__min.store.state.pages.length === 2, null, { timeout: 30000 });
await page.waitForTimeout(500);
let s = await S();
ok(s.pages === 2 && !(await page.evaluate(() => document.getElementById('welcome').classList.contains('on'))), 'PDF を開く: 2 ページ、最初の画面が消える', s);

// 2. パレット: 部材カテゴリをキーボードで組む
await page.click('#apptabs button[data-screen=palette]');
await page.waitForTimeout(200);
await page.click('.phead button:has-text("＋ 子")');
await page.waitForTimeout(150);
await typeIn('照明器具');
await page.keyboard.press('Enter'); // 兄弟
await page.waitForTimeout(150);
await typeIn('ダウンライト');
await page.keyboard.press('Tab'); // 照明器具の子に
await page.waitForTimeout(150);
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
await typeIn('GS100');
await page.keyboard.press('Tab'); // ダウンライトの子に
await page.waitForTimeout(150);
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
await typeIn('G100');
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
await page.keyboard.press('Backspace'); // 選ばれた「新しいカテゴリ」を消す
await page.keyboard.press('Backspace'); // 空で Backspace → 項目を消す
await page.waitForTimeout(150);
ok(JSON.stringify(await cats()) === JSON.stringify([['照明器具', [['ダウンライト', ['GS100', 'G100']]]]]), 'Enter 兄弟・Tab 子・空で Backspace 消す', await cats());
// Alt+↑ で並べ替え（G100 にいる）
await page.keyboard.press('Alt+ArrowUp');
await page.waitForTimeout(150);
ok(JSON.stringify(await cats()) === JSON.stringify([['照明器具', [['ダウンライト', ['G100', 'GS100']]]]]), 'Alt+↑ で並べ替え', await cats());
// Shift+Tab で戻す（G100 をダウンライトの兄弟へ）→ Ctrl+Z（名前の欄の外で）で戻る
await page.keyboard.press('Shift+Tab');
await page.waitForTimeout(150);
ok(JSON.stringify(await cats()) === JSON.stringify([['照明器具', [['ダウンライト', ['GS100']], 'G100']]]), 'Shift+Tab で戻す', await cats());
await page.click('.pright');
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
ok(JSON.stringify(await cats()) === JSON.stringify([['照明器具', [['ダウンライト', ['G100', 'GS100']]]]]), '元に戻す', await cats());
// 名前の書き換え（欄を離れると 1 回の編集）
await page.click('.orow:has(input[value="照明器具"]) input');
await typeIn('照明');
await page.click('.pright');
await page.waitForTimeout(150);
ok((await cats())[0][0] === '照明', '名前を書き換える', await cats());
// まとめて貼り付け（配線は長さ）
await page.click('.orow[data-id="cat-root"]');
await page.click('.phead button:has-text("まとめて貼り付け")');
await page.fill('.modal textarea.paste', '配線 [長さ]\n  幹線\n    CVT 100\n    IV 14\n  1A2\n');
await page.waitForTimeout(100);
const pv = await page.textContent('.modal .ppreview');
await page.click('.modal .mfoot button.primary');
await page.waitForTimeout(200);
const wire = await page.evaluate(() => { const pal = self.__min.palette; const c = pal.categories.find((x) => x.name === 'CVT 100'); return { size: c.size, path: pal.categoryPath(c.id) }; });
ok(pv.includes('5 件') && wire.size === '長さ' && wire.path.join('/') === '拾えるもの（根）/配線/幹線/CVT 100', 'まとめて貼り付け: 字下げで木・[長さ] は子へ受け継ぐ', { pv: pv.slice(0, 30), wire });
// 構成: 1A2 = CVT 100 × 1 ＋ IV 14 × 2
await page.click('.orow:has(input[value="1A2"]) input');
await page.waitForTimeout(150);
await page.selectOption('.pright .pacts select.msel', { label: '配線 / 幹線 / CVT 100' });
await page.waitForTimeout(150);
await page.selectOption('.pright .pacts select.msel', { label: '配線 / 幹線 / IV 14' });
await page.waitForTimeout(150);
await page.fill('.pright .ptbl tr:nth-child(3) input[type=number]', '2');
await page.press('.pright .ptbl tr:nth-child(3) input[type=number]', 'Enter');
await page.waitForTimeout(150);
const comp = await page.evaluate(() => { const pal = self.__min.palette; const c = pal.categories.find((x) => x.name === '1A2'); return (c.components || []).map((m) => [pal.category(m.material).name, m.count]); });
ok(JSON.stringify(comp) === JSON.stringify([['CVT 100', 1], ['IV 14', 2]]), '構成を足す（部材と本数）', comp);
await shot('m4_smoke_palette_cat');

// 3. 層のラベル: 貼り付けで節と規則 → 詳細で候補を外す
await page.click('.pnav .pk:has-text("層のラベル")');
await page.click('.phead button:has-text("まとめて貼り付け")');
await page.fill('.modal textarea.paste', '# 部屋\n  玄関: GS100\n  事務室: GS100, G100, XX9\n');
await page.waitForTimeout(100);
const warn = await page.textContent('.modal .ppreview');
await page.click('.modal .mfoot button.primary');
await page.waitForTimeout(200);
let rules = await page.evaluate(() => { const pal = self.__min.palette; const l = pal.labels.find((x) => x.name === '事務室'); return l.rules.map((r) => [pal.category(r.category).name, r.candidates.map((c) => pal.category(c).name)]); });
ok(warn.includes('XX9') && JSON.stringify(rules) === JSON.stringify([['ダウンライト', ['GS100', 'G100']]]), '貼り付け「事務室: GS100, G100, XX9」→ 規則（XX9 は知らせる）', { rules });
await page.click('.orow:has(input[value="事務室"]) input');
await page.waitForTimeout(150);
await page.click('.pright .rcand:has-text("G100") >> nth=0');
await page.waitForTimeout(150);
rules = await page.evaluate(() => { const pal = self.__min.palette; const l = pal.labels.find((x) => x.name === '事務室'); return l.rules.map((r) => r.candidates.map((c) => pal.category(c).name)); });
ok(JSON.stringify(rules) === JSON.stringify([['GS100']]), '詳細で候補を外す（GS100 だけ）', rules);
await shot('m4_smoke_palette_label');
await page.click('.pnav .pk:has-text("規則の一覧")');
await page.waitForTimeout(150);
ok((await page.$$eval('.rmx tr', (rs) => rs.length)) === 4, '規則の一覧: 見出し行・木の行・節 2', await page.$$eval('.rmx tr', (rs) => rs.length));

// 4. 拾い: エリア → モーダルで事務室 → 箱 → GS100 に決まる
await page.click('#apptabs button[data-screen=pick]');
await page.waitForTimeout(400);
await page.evaluate(() => self.__min.setTool('area-rect'));
await drag(100, 100, 300, 250);
await page.waitForTimeout(300);
await page.click('.modal .am-v:has-text("事務室")');
await page.waitForTimeout(150);
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(200);
await page.evaluate(() => { const pal = self.__min.palette; self.__min.app.currentCategory = pal.categories.find((x) => x.name === 'ダウンライト').id; self.__min.setTool('box'); });
await drag(150, 150, 160, 160);
await page.waitForTimeout(200);
const leaf = await page.evaluate(() => { const o = self.__min.app.objects[0]; return o && self.__min.palette.category(o.leaf).name; });
ok(leaf === 'GS100', 'エリア（事務室）の中にダウンライトの箱 → GS100', leaf);
// エリアを選んで動かす・角で形を変える
await page.evaluate(() => self.__min.setTool('select'));
await click(250, 220);
await page.waitForTimeout(100);
await drag(250, 220, 270, 230);
await page.waitForTimeout(100);
await drag(320, 260, 340, 300);
await page.waitForTimeout(100);
const shape = await page.evaluate(() => self.__min.store.state.areas[0].shape.points);
ok(JSON.stringify(shape) === JSON.stringify([[120, 110], [340, 300]]), 'エリアを動かす（+20,+10）・右下の角を引く', shape);
// ページ全体の層: 新しい木「階」を足して 1F
await page.click('#chips .chip.add');
await page.waitForTimeout(200);
ok(await page.evaluate(() => !!document.querySelector('.modal')), 'ページ全体の層のモーダル');
await page.keyboard.press('Escape');
await shot('m4_smoke_pick');

// 5. 集計: 行 部材・列 部屋
await page.click('#apptabs button[data-screen=sum]');
await page.waitForTimeout(200);
await page.selectOption('.sumbody .bar .keys >> nth=1 >> select', { label: '部屋' });
await page.waitForTimeout(200);
const cell = await page.evaluate(() => [...document.querySelectorAll('.sumbody table tr')].map((r) => [...r.children].map((c) => c.textContent)));
ok(JSON.stringify(cell[1]) === JSON.stringify(['GS100', '1', '1']) && cell[0].includes('事務室'), '集計表: GS100 × 事務室 = 1', cell);
const dl = page.waitForEvent('download');
await page.click('.sumbody button:has-text("CSV")');
const csv = fs.readFileSync(await (await dl).path(), 'utf8');
ok(csv.includes('GS100,1,1'), 'CSV に書き出す', csv.split('\n').slice(0, 2));

// 6. 書き出す → 消す → 読み込む。再読み込みで PDF も戻る
const dl2 = page.waitForEvent('download');
await page.click('#b-save');
const jobPath = await (await dl2).path();
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
ok(job.kind === 'hiroi-job' && job.format === 5 && job.pickups.length === 1 && !JSON.stringify(job).includes('%PDF'), '作業を書き出す（PDF は含まない）', { kind: job.kind, format: job.format });
await page.reload();
await page.waitForFunction(() => self.__min && self.__min.app.pdf, null, { timeout: 30000 });
await page.waitForTimeout(300);
s = await S();
ok(s.pk === 1 && s.ar === 1 && s.pages === 2, '再読み込み: 作業と図面（IndexedDB）が戻る', s);
await page.click('#b-menu');
await page.click('.menu button:has-text("層と拾いを全部消す")');
await page.click('.modal .mfoot button.primary');
await page.waitForTimeout(200);
ok((await S()).pk === 0, '層と拾いを全部消す', await S());
await page.setInputFiles('#file', jobPath);
await page.waitForTimeout(300);
ok((await S()).pk === 1 && (await page.evaluate(() => !!self.__min.app.pdf)), '書き出した作業を読み込む（同じ図面なら開いたまま）', await S());

// 7. パレットだけ書き出して、まっさらな作業に読み込む
const dl3 = page.waitForEvent('download');
await page.click('#b-menu');
await page.click('.menu button:has-text("パレットを書き出す")');
const palPath = await (await dl3).path();
const pj = JSON.parse(fs.readFileSync(palPath, 'utf8'));
ok(pj.kind === 'hiroi-palette' && pj.palette.categories.length === 10, 'パレットを書き出す', { kind: pj.kind, n: pj.palette.categories.length });
await page.setInputFiles('#file-pdf', { name: 'other.pdf', mimeType: 'application/pdf', buffer: blankPdf(3) });
await page.waitForTimeout(300);
if (await page.$('.modal')) await page.click('.modal .mfoot button.primary');
await page.waitForFunction(() => self.__min.store.state.pages.length === 3, null, { timeout: 30000 });
s = await S();
ok(s.pages === 3 && s.pk === 0 && s.ct === 10, '違う図面を開く: 層と拾いは消え、パレットは残る', s);

// 8. 長さ: ラベルだけのルートに、あとから長さを入れる（ルートの板・モーダル・線分の板）
await page.click('#apptabs button[data-screen=pick]');
await page.waitForTimeout(300);
await page.evaluate(() => { const pal = self.__min.palette; self.__min.app.currentCategory = pal.categories.find((x) => x.name === '1A2').id; self.__min.setTool('line'); });
await click(400, 320);
await click(550, 320);
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
await page.evaluate(() => self.__min.setTool('route'));
await click(400, 320);
await click(550, 320);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
await page.click('.modal .am-v:has-text("玄関")');
await page.waitForTimeout(150);
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(200);
const qty = () => page.evaluate(() => self.__min.app.objects.map((o) => [self.__min.palette.category(o.material).name, o.quantity, o.flags.join(' ')]));
let q = await qty();
ok(q.length === 2 && q.every((o) => o[2].includes('長さ未入力')), 'ラベルだけのルート: 長さ未入力', q);
await page.evaluate(() => { const r = self.__min.store.state.routes.find((x) => x.label); self.__min.setTool('select'); self.__min.app.selection = { kind: 'route', id: r.id }; self.__min.renderAll(); });
await page.waitForTimeout(150);
await page.click('#panel button[data-role=add-len]');
await page.waitForTimeout(200);
await page.fill('.modal input[data-role=newlen-h]', '12');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
q = await qty();
let selr = await page.evaluate(() => { const sel = self.__min.app.selection; const r = sel && self.__min.store.route(sel.id); return r && { label: r.label, h: r.length_h }; });
ok(JSON.stringify(q.map((o) => o.slice(0, 2))) === JSON.stringify([['CVT 100', 12], ['IV 14', 24]]) && selr && selr.label === null && selr.h === 12, 'ラベルルートの板「＋ 同じ線分に長さルートを置く」→ 長さルート（12）が出来て選ばれる', { q, selr });
await page.fill('#panel input[data-role=lr-h]', '15');
await page.press('#panel input[data-role=lr-h]', 'Tab');
await page.waitForTimeout(200);
q = await qty();
ok(q[0][1] === 15 && (await page.evaluate(() => self.__min.store.state.routes.length)) === 2, '長さルートの板で 15 に直す（長さルートは 1 枚のまま）', q);
await page.evaluate(() => { const r = self.__min.store.state.routes.find((x) => x.label); self.__min.app.selection = { kind: 'route', id: r.id }; self.__min.renderAll(); });
await page.waitForTimeout(100);
ok(!!(await page.$('#panel a[data-role=goto-len]')), 'ラベルルートの板は、長さルートへの案内だけ（欄は持たない）');
await page.click('#panel button:has-text("意味・規則を直す")');
await page.waitForTimeout(300);
ok(!(await page.$('.modal input[data-role=len-h]')), '直すモーダルはラベルだけ（長さの欄は無い）');
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
await page.evaluate(() => { const r = self.__min.store.state.routes.find((x) => !x.label); self.__min.app.selection = { kind: 'route', id: r.id }; self.__min.renderAll(); });
await page.fill('#panel input[data-role=lr-h]', '');
await page.press('#panel input[data-role=lr-h]', 'Tab');
await page.waitForTimeout(200);
q = await qty();
ok(q.every((o) => o[2].includes('長さ未入力')) && (await page.evaluate(() => self.__min.store.state.routes.length)) === 1, '平・立とも空にすると長さルートを外す', q);
await page.evaluate(() => { const sg = self.__min.store.state.segments[0]; self.__min.app.selection = { kind: 'segment', id: sg.id }; self.__min.renderAll(); });
await page.fill('#panel input[data-role=slen-h]', '7');
await page.press('#panel input[data-role=slen-h]', 'Tab');
await page.waitForTimeout(200);
q = await qty();
ok(q[0][1] === 7 && q[1][1] === 14, '線分の板で、その線分の長さ（7）', q);
// 新しいルートのモーダル: 選んだラベルを外して長さだけにする
{
  const nb = await page.evaluate(() => self.__min.store.state.routes.length);
  await page.evaluate(() => self.__min.setTool('route'));
  await click(400, 450);
  await click(550, 450);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.click('.modal .am-v:has-text("玄関")');
  await page.waitForTimeout(100);
  const on1 = await page.evaluate(() => !!document.querySelector('.modal .am-v.on:not(.none)'));
  await page.click('.modal .am-v:has-text("玄関")');
  await page.waitForTimeout(100);
  const off1 = await page.evaluate(() => !document.querySelector('.modal .am-v.on:not(.none)') && document.querySelector('.modal [data-role=no-label]').classList.contains('on'));
  await page.click('.modal .am-v:has-text("玄関")');
  await page.click('.modal [data-role=no-label]');
  await page.waitForTimeout(100);
  const off2 = await page.evaluate(() => !document.querySelector('.modal .am-v.on:not(.none)'));
  await page.fill('.modal input[data-role=len-h]', '5');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(200);
  const added = await page.evaluate((nb) => self.__min.store.state.routes.slice(nb).map((r) => [r.label, r.length_h]), nb);
  ok(on1 && off1 && off2 && JSON.stringify(added) === JSON.stringify([[null, 5]]), 'ルートのモーダル: 選んだラベルはもう一度押すか「ラベルなし」で外れる → 長さだけのルート', { on1, off1, off2, added });
}
await shot('m4_smoke_route_len');
// 線・ルートを動かす: ノードは線の下でも掴める。選んだ線は骨ごと動く
{
  await page.evaluate(() => { self.__min.setTool('select'); self.__min.app.selection = null; self.__min.renderAll(); });
  const pos = () => page.evaluate(() => { const st = self.__min.store.state; const p = st.pickups.find((x) => x.kind === 'line'); const s0 = st.segments.find((x) => x.id === p.path[0]); return s0.points.map((q) => q.join(',')).join(' '); });
  await drag(550, 320, 560, 330);
  await page.waitForTimeout(150);
  const a1 = await pos();
  await click(470, 320);
  await page.waitForTimeout(150);
  const sel = await page.evaluate(() => self.__min.app.selection);
  await drag(470, 320, 470, 340);
  await page.waitForTimeout(150);
  const a2 = await pos();
  ok(a1 === '400,320 560,330' && sel && sel.kind === 'pickup' && a2 === '400,340 560,350', '線の端のノードを引く／線を選んで引くと骨ごと動く', { a1, sel, a2 });
}

console.log('\nproblems:', problems.length ? problems : 'なし');
console.log(failed ? 'FAILED ' + failed : 'ALL OK');
await browser.close();
process.exit(failed ? 1 : 0);
