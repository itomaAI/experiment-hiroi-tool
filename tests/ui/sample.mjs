/*
 * サンプル図面での試験（playwright）。図面の PDF は公開していないので、手元に在るときだけ走る（SAMPLE_PDF で場所を指す）。
 * 先に: python3 -m http.server 8792 --bind 127.0.0.1（置き場の根で）
 * 走らせる: node tests/ui/sample.mjs
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
  const dir = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
  return path.join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
}
let failed = 0;
const ok = (c, what, detail) => {
  if (!c) failed++;
  console.log((c ? '  ok   ' : '  FAIL ') + what + (detail !== undefined ? '  ← ' + JSON.stringify(detail) : ''));
};
const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });

const browser = await chromium.launch({ executablePath: headlessShell() });
const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

const at = (x, y) => page.evaluate(([x, y]) => { const r = document.getElementById('stage').getBoundingClientRect(); const [sx, sy] = self.__min.toScreen(x, y); return { x: r.left + sx, y: r.top + sy }; }, [x, y]);
const click = async (x, y, opts) => { const p = await at(x, y); await page.mouse.click(p.x, p.y, opts); };
const drag = async (x0, y0, x1, y1) => { const a = await at(x0, y0); const b = await at(x1, y1); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.mouse.move(b.x, b.y); await page.mouse.up(); };
const state = () => page.evaluate(() => { const st = self.__min.store.state; return { pk: st.pickups.length, sg: st.segments.length, rt: st.routes.length, nd: st.nodes.length, ar: st.areas.length, lb: st.palette.labels.length }; });
const lastPickup = () => page.evaluate(() => { const st = self.__min.store.state; const p = st.pickups[st.pickups.length - 1]; const os = self.__min.app.objects.filter((x) => x.pickup === p.id); return { id: p.id, kind: p.kind, path: p.path ? p.path.length : null, objs: os.map((o) => [o.material, o.quantity, o.flags]), labels: os[0] ? os[0].labels : [], leaf: os[0] ? os[0].leaf : null, chosen: p.chosen }; });
const modal = () => page.evaluate(() => !!document.querySelector('.modal'));

// サンプル図面（公開しない PDF）。無ければ、この試験は飛ばす
const SAMPLE_PDF = process.env.SAMPLE_PDF || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data/sample.pdf');
if (!fs.existsSync(SAMPLE_PDF)) {
  console.log('サンプル図面が無いので飛ばす: ' + SAMPLE_PDF);
  await browser.close();
  process.exit(0);
}
await page.goto(BASE + '/app/index.html');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(800);
await page.setInputFiles('#file-pdf', SAMPLE_PDF);
await page.waitForFunction(() => self.__min && self.__min.app.pdf && self.__min.store.state.pages.length > 0, null, { timeout: 120000 });
await page.waitForTimeout(1500);
const doc = await page.evaluate(() => ({ d: self.__min.store.state.doc, t36: self.__min.store.page('pg-036').title }));
ok(doc.d.sample === true && doc.d.pages === 76 && doc.t36.includes('E-36'), 'サンプル図面を開く: 指紋で見分け、ページの題が付く', doc);

// サンプルのパレット → 見本
await page.evaluate(() => self.__min.loadSamplePalette());
await page.waitForTimeout(300);
await page.evaluate(() => self.__min.placeSample());
await page.waitForTimeout(1500);
let s = await state();
ok(s.pk === 17 && s.sg === 9 && s.rt === 19 && s.ar === 14, '見本: 拾い 17・線分 9・ルート 19（ラベル 12・長さ 7）・エリア 14', s);
await shot('m3_sample_p36');
const cells = await page.evaluate(() => {
  const m = self.__min;
  const t1 = m.SM.project.table(m.palette, m.app.objects, m.palette.views.find((v) => v.id === 'vw-trunk-section'));
  const t2 = m.SM.project.table(m.palette, m.app.objects, m.palette.views.find((v) => v.id === 'vw-branch'));
  return { trunk: Object.fromEntries([...t1.cells].map(([k, v]) => [k, v.sum])), branch: Object.fromEntries([...t2.cells].map(([k, v]) => [k, v.sum])) };
});
ok(cells.trunk['1A2 ／ 1|CVT 100'] === 24 && cells.trunk['1A2 ／ 2|IV 14'] === 118.6 && cells.trunk['1A2 ／ 2|G 82'] === 9.7, '幹線の値（長さルート）', cells.trunk);
ok(cells.branch['#101 ／ 平|VVF 2.0-2C'] === 22.8 && cells.branch['#101 ／ 立|VVF 2.0-3C'] === 10, '分岐回路 #101（束のルート → 構成）', cells.branch);

// 箱
await page.evaluate(() => { self.__min.app.currentCategory = 'cat-root'; self.__min.setTool('box'); });
await click(580, 245);
await page.waitForTimeout(300);
let last = await lastPickup();
ok(last.kind === 'box' && last.leaf === 'cat-GS100' && !(await page.$('.cand')), '玄関の中に根で箱 → GS100（札は出ない）', last);
await page.evaluate(() => { self.__min.app.currentCategory = 'cat-downlight'; });
await drag(420, 300, 432, 312);
await page.waitForTimeout(300);
ok((await page.evaluate(() => document.querySelectorAll('.cand .ci').length)) === 5, '部屋の外にダウンライト → 候補の札 5');
await page.keyboard.press('2');
await page.waitForTimeout(200);
last = await lastPickup();
ok(last.chosen === 'cat-G150' && last.leaf === 'cat-G150', '数字キー 2 で G150', last);

// エリア: 囲む → モーダル → 東門
await page.evaluate(() => self.__min.setTool('area-rect'));
await drag(410, 290, 450, 330);
await page.waitForTimeout(400);
ok(await modal(), 'エリアを囲むとモーダルが開く');
await page.fill('.modal input.search', '東門');
await page.waitForTimeout(100);
await page.click('.modal .am-v');
await page.waitForTimeout(200);
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(300);
last = await lastPickup();
ok((await state()).ar === 15 && last.labels.includes('lb-room-01') && last.objs[0][2].includes('候補の外'), 'エリア確定: 中の箱は東門の規則で「候補の外」', last);

// 線（拾い）: 3 点。モーダルは出ない。長さ未入力の旗
await page.evaluate(() => { self.__min.app.currentCategory = 'cat-1A2'; self.__min.setTool('line'); });
await click(500, 200);
await click(540, 202);
await click(540, 230);
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
last = await lastPickup();
s = await state();
ok(last.kind === 'line' && last.path === 2 && !(await modal()) && last.objs.every((o) => o[2].includes('長さ未入力')), '線を 3 点で引く: モーダル無し・骨 2 線分・長さ未入力', { last, s });
ok(s.sg === 11 && s.nd === 17, '骨: 線分 2・ノード 3 が増えた', s);
const y2 = await page.evaluate(() => { const st = self.__min.store.state; return st.nodes[st.nodes.length - 2].y; });
ok(y2 === 200, '2 点目が水平に揃う（202 → 200）', y2);
await shot('m3_line_nolen');

// ルート（層）: 同じ骨をなぞる → モーダル（節＋長さ）→ 確定
await page.evaluate(() => self.__min.setTool('route'));
await click(500, 200);
await click(540, 200);
await click(540, 230);
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
ok(await modal(), 'ルートをなぞるとモーダルが開く');
ok((await state()).sg === 11, 'なぞっただけなので骨は増えない', await state());
await page.fill('.modal input[data-role=len-h]', '15');
await page.fill('.modal input.search', '天井内');
await page.waitForTimeout(100);
await page.click('.modal .am-v');
await page.waitForTimeout(300);
const pv = await page.evaluate(() => (document.querySelector('.modal .sum') || {}).textContent);
ok(pv && pv.includes('長さ 平 15'), '下見: 長さと層', pv);
await shot('m3_route_modal');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(400);
last = await lastPickup();
s = await state();
ok(s.rt === 21 && JSON.stringify(last.objs.map((o) => o.slice(0, 2))) === JSON.stringify([['cat-CVT100', 15], ['cat-IV14', 30]]) && last.labels.includes('lb-laying-ceiling'), 'ルート確定: ラベルルート＋長さルート。線は CVT 15・IV 30（天井内）', { s, objs: last.objs, labels: last.labels });
await shot('m3_route_done');

// 選ぶ: 同じ場所をもう一度押すと 1 つ下（拾い → ルート）。右ボタンで一覧
await page.evaluate(() => self.__min.setTool('select'));
await click(520, 200);
await page.waitForTimeout(150);
const s1 = await page.evaluate(() => self.__min.app.selection);
await click(520, 200);
await page.waitForTimeout(150);
const s2 = await page.evaluate(() => self.__min.app.selection);
ok(s1 && s1.kind === 'pickup' && s2 && s2.kind === 'route', '押す: 拾い → もう一度押す: ルート', { s1, s2 });
await click(520, 200, { button: 'right' });
await page.waitForTimeout(200);
const listed = await page.evaluate(() => [...document.querySelectorAll('.cand .ci')].map((e) => e.textContent));
ok(listed.length >= 4, '右ボタン: ここにあるものの一覧（拾い・ルート 2・骨）', listed);
await shot('m3_context_list');
await page.keyboard.press('Escape');
await page.evaluate(() => { for (const f of self.__min.app.floats.slice()) f.el.remove(); self.__min.app.floats = []; });

// 立ルート: ルートの道具で端のノードを押して ↑ → Enter → モーダルで立 3
await page.evaluate(() => self.__min.setTool('route'));
await click(540, 230);
await page.keyboard.press('ArrowUp');
await page.waitForTimeout(200);
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
ok(await modal(), '立の印を足して Enter → モーダル');
await page.fill('.modal input[data-role=len-v]', '3');
await page.waitForTimeout(200);
await page.click('.modal .mfoot button.primary');
await page.waitForTimeout(400);
const rz = await page.evaluate(() => { const st = self.__min.store.state; const n = st.nodes.find((x) => x.level); const seg = st.segments.find((x) => x.riser); const r = seg ? st.routes.find((x) => x.segments.includes(seg.id)) : null; return { level: n && n.level, riser: !!seg, len_v: r && r.length_v }; });
ok(rz.level === '上' && rz.riser && rz.len_v === 3, '立ルート（上・立 3）が出来た', rz);
await shot('m3_riser');

// 線の上書き: 線分ごとの長さを入れると勝つ（旗「上書き」）
await page.evaluate(() => { const m = self.__min; const p = m.store.state.pickups.find((x) => x.category === 'cat-1A2' && x.page === 'pg-036'); m.store.commit('上書き', (st, S) => S.setLineLength(p.id, p.path[0], 7, null)); });
await page.waitForTimeout(200);
const ov = await page.evaluate(() => { const m = self.__min; const p = m.store.state.pickups.find((x) => x.category === 'cat-1A2' && x.page === 'pg-036'); return m.app.objects.filter((o) => o.pickup === p.id).map((o) => [o.segment.startsWith('sg-') ? 'seg' : 'route', o.material, o.quantity, o.flags.join(' ')]); });
ok(ov.some((o) => o[0] === 'seg' && o[2] === 7 && o[3].includes('上書き')) && ov.some((o) => o[3].includes('ルートの一部')), '上書き 7 が勝ち（旗）。残りはルートの一部', ov);

// 二度押しで線分にノードを足す（線の道が 1 つ増える）
await page.evaluate(() => self.__min.setTool('select'));
{
  const b = await state();
  const pt = await at(520, 200);
  await page.mouse.dblclick(pt.x, pt.y);
  await page.waitForTimeout(300);
  const a = await state();
  const sel = await page.evaluate(() => self.__min.app.selection);
  const line = await page.evaluate(() => { const p = self.__min.store.state.pickups.find((x) => x.category === 'cat-1A2' && x.page === 'pg-036'); return p.path.length; });
  ok(a.nd === b.nd + 1 && a.sg === b.sg + 1 && sel && sel.kind === 'node' && line === 3, '二度押し: ノード＋1・線分＋1、線の道は 3', { b, a, line });
}
// 範囲選択: 玄関まわりの箱を囲んで Delete
{
  const b = await state();
  await drag(495, 180, 615, 275);
  await page.waitForTimeout(300);
  const sel = await page.evaluate(() => self.__min.app.selection);
  ok(sel && sel.kind === 'multi' && sel.items.filter((x) => x.kind === 'pickup').length >= 12, '範囲選択: 玄関まわりの箱 12 以上と層が選ばれる', sel && { kind: sel.kind, n: sel.items.length });
  await shot('m3_marquee');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  const a = await state();
  ok(a.pk <= b.pk - 12 && a.ar <= b.ar - 3, 'Delete でまとめて消える（箱 12・エリア 3）', { b, a });
}

// 元に戻す
let n = 0;
while ((await page.evaluate(() => self.__min.store.undoStack.length)) > 2 && n < 60) { await page.keyboard.press('Control+z'); n++; }
s = await state();
ok(s.pk === 17 && s.sg === 9 && s.rt === 19 && s.ar === 14 && s.lb === 57, '元に戻すで見本の直後に戻る', s);

console.log('\nproblems:', problems.length ? problems : 'なし');
console.log(failed ? 'FAILED ' + failed : 'ALL OK');
await browser.close();
process.exit(failed || problems.length ? 1 : 0);