/*
 * GP の提案（T-0646）の画面試験（playwright）。図面は白紙の PDF（記号が無い）なので、特徴量は作り物を IndexedDB に入れて通す。
 * ONNX も Worker も使わない（口「検出」は IndexedDB に特徴量があればそれを読む）。
 * 先に: python3 -m http.server 8792 --bind 127.0.0.1（置き場の根で）
 * 走らせる: node tests/ui/gp.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
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
// 白紙の PDF（A4 横・n ページ）。smoke.mjs と同じ
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
page.on('dialog', (d) => d.accept());
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
const at = (x, y) => page.evaluate(([x, y]) => { const r = document.getElementById('stage').getBoundingClientRect(); const [sx, sy] = self.__min.toScreen(x, y); return { x: r.left + sx, y: r.top + sy }; }, [x, y]);
const drag = async (x0, y0, x1, y1) => { const a = await at(x0, y0); const b = await at(x1, y1); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.mouse.move(b.x, b.y); await page.mouse.up(); };
// 板の様子: 箱・GP の箱・提案（閾値の上）・退けた場所
const S = () => page.evaluate(() => {
  const st = self.__min.store.state;
  const app = self.__min.app;
  const props = self.__min.store.proposalsOn('pg-001');
  return { boxes: st.pickups.filter((p) => p.kind === 'box').length, gp: st.pickups.filter((p) => p.by === 'gp').length, props: props.length, shown: props.filter((p) => p.score >= app.gp.threshold).length, rej: st.rejections.length, status: self.__min.detector().status('pg-001').status };
});
// 提案の中心が、作り物の記号の場所（2 × 2 セル＝16 pt の塊）に乗っているか
const KIND1 = [[10, 10], [30, 20], [50, 40], [70, 60], [90, 30]]; // (col,row)。先頭を手本にする
const LOOK = [[40, 60], [95, 65]]; // 向き 1 に似た記号（埋め込みを 2 割だけ向き 3 へ寄せる。手本 1 つでは提案に出るが、1 つ退けると両方消える）
const KIND2 = [[20, 50], [60, 10], [80, 50]];
const center = ([c, r]) => [c * 8 + 8, r * 8 + 8];
const near = (bbox, cr) => { const [cx, cy] = center(cr); return Math.hypot(bbox[0] + bbox[2] / 2 - cx, bbox[1] + bbox[3] / 2 - cy) < 10; };
const propsOn = () => page.evaluate(() => self.__min.store.proposalsOn('pg-001').map((p) => ({ id: p.id, bbox: p.bbox, score: p.score })));

await page.goto(BASE + '/app/index.html');
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('hiroi-tool'); });
await page.reload();
await page.waitForTimeout(800);
ok(await page.evaluate(() => !!(self.SMGP && self.SMDetector && self.__min.detector())), '口「検出」と核（gp.js）が読まれている');

// 1. 白紙の PDF を開く
await page.setInputFiles('#file-pdf', { name: 'blank.pdf', mimeType: 'application/pdf', buffer: blankPdf(2) });
await page.waitForFunction(() => self.__min.app.pdf && self.__min.store.state.pages.length === 2, null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.evaluate(() => self.__min.setScreen('pick'));
await page.waitForTimeout(300);
let s = await S();
ok(s.status === 'none' && s.boxes === 0, '開いた直後: 特徴量は無い', s);
ok(await page.evaluate(() => !!document.querySelector('.sec.gp') && document.querySelector('.sec.gp').textContent.includes('特徴量はまだ無い')), '右の板「提案（GP）」に「特徴量はまだ無い」');

// 2. 作り物の特徴量を IndexedDB に入れる（scale 1・stride 8 → 106 × 75 セル。記号は 2 × 2 セルの塊、向きごとに同じ埋め込み）
const made = await page.evaluate(([K1, K2, LK]) => new Promise((resolve, reject) => {
  const G = self.SMGP;
  const C = 16, fw = Math.ceil(842 / 8), fh = Math.ceil(595 / 8), HW = fw * fh;
  const z = new Float32Array(C * HW);
  const ink = new Uint8Array(HW);
  const unit = (k) => { const v = new Float32Array(C); v[k % C] = 0.9; v[(k * 3) % C] += 0.3; v[(k * 7 + 1) % C] += 0.2; const n = Math.hypot(...v); return v.map((x) => x / n); };
  const mix = (a, b, t) => { const v = new Float32Array(C); for (let k = 0; k < C; k++) v[k] = a[k] * (1 - t) + b[k] * t; const n = Math.hypot(...v); return v.map((x) => x / n); };
  const put = ([col, row], kind) => { const u = typeof kind === 'number' ? unit(kind) : kind; for (const [dc, dr] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const cell = (row + dr) * fw + col + dc; ink[cell] = 1; for (let k = 0; k < C; k++) z[k * HW + cell] = u[k] + (Math.random() - 0.5) * 0.02; } };
  for (const p of K1) put(p, 1);
  for (const p of K2) put(p, 2);
  for (const p of LK) put(p, mix(unit(1), unit(3), 0.2));
  const q = G.quantize(z, C, fw, fh, ink);
  const fp = self.__min.store.state.doc.fingerprint || 'nofp';
  const meta = { page: 1, scale: 1, width: 842, height: 595, stride: 8, fw, fh, channels: C, kernel: G.DEFAULT_KERNEL, cells: q.cells.length, ep: 'fake', at: new Date().toISOString() };
  const rq = indexedDB.open('hiroi-tool', 1);
  rq.onupgradeneeded = () => rq.result.createObjectStore('files');
  rq.onerror = () => reject(rq.error);
  rq.onsuccess = () => {
    const tx = rq.result.transaction('files', 'readwrite');
    tx.objectStore('files').put({ meta, cells: q.cells, feat: q.feat, scale: q.scale }, 'feat:' + fp + ':1');
    tx.oncomplete = () => resolve({ key: 'feat:' + fp + ':1', cells: q.cells.length });
    tx.onerror = () => reject(tx.error);
  };
}), [KIND1, KIND2, LOOK]);
ok(made.cells === (KIND1.length + KIND2.length + LOOK.length) * 4, '作り物の特徴量（' + made.cells + ' セル）を ' + made.key + ' に置いた', made);

// 3. 「特徴量を用意する」→ IndexedDB から読む（Worker は起きない）
await page.evaluate(() => { document.querySelector('.sec.gp').open = true; });
await page.click('.sec.gp button');
await page.waitForFunction(() => self.__min.detector().status('pg-001').status === 'ready', null, { timeout: 10000 });
await page.waitForTimeout(300);
s = await S();
ok(s.status === 'ready', '特徴量を用意する → 保存から読んで ready', s);
ok(await page.evaluate(() => document.querySelector('.sec.gp').textContent.includes('保存から')), '右の板に「特徴量あり（保存から）」');

// 4. カテゴリを作り、手本の箱を 1 つ置く → 自動で探す
await page.evaluate(() => { const st = self.__min.store; const light = st.addCategory('cat-root', '照明', { size: '個数' }); const a = st.addCategory(light, 'A', { size: '個数' }); const b = st.addCategory(light, 'B', { size: '個数' }); st.touchPalette(); self.__min.app.currentCategory = a; self.__min.app.gp.auto = true; self.__min.setTool('box'); self.__min.renderAll(); });
await page.evaluate(() => self.__min.fit && self.__min.fit());
await page.waitForTimeout(200);
{
  const [cx, cy] = center(KIND1[0]);
  await drag(cx - 8, cy - 8, cx + 8, cy + 8);
}
await page.waitForTimeout(400);
s = await S();
const TRUE = KIND1.slice(1);
ok(s.boxes === 1 && s.props === TRUE.length + LOOK.length, '箱を 1 つ置く → 自動で探す → 同じ向き ' + TRUE.length + '＋似た記号 ' + LOOK.length + ' が提案', s);
let props = await propsOn();
const isTrue = (p) => TRUE.some((cr) => near(p.bbox, cr));
const isLook = (p) => LOOK.some((cr) => near(p.bbox, cr));
ok(props.every((p) => isTrue(p) || isLook(p)), '提案は同じ向きと似た記号の上だけ（別の向きには出ない）', props.map((p) => [p.bbox, p.score]));
ok(props.filter(isTrue).every((p) => p.score >= 0.85) && props.filter(isLook).every((p) => p.score >= 0.5 && p.score < 0.85), '同じ向きは高く（≥85%）・似た記号は低め（50〜85%）', props.map((p) => [isTrue(p) ? 'true' : 'look', p.score]));
ok(await page.evaluate(() => (document.querySelector('.sec.gp summary').textContent || '').includes('提案（GP）')), '右の板の見出しに提案の数');
await shot('gp_proposals');

// 5. 1 つ目を選んで Enter → 承認（by: gp の箱）。次が自動で選ばれる
await page.evaluate((id) => { self.__min.setTool('select'); self.__min.app.selection = { kind: 'proposal', id }; self.__min.renderAll(); }, props.find(isTrue).id);
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
s = await S();
ok(s.boxes === 2 && s.gp === 1 && s.props === TRUE.length + LOOK.length - 1, 'Enter で承認 → by: gp の箱が 1 つ・提案が 1 つ減る', s);
const gpBox = await page.evaluate(() => { const st = self.__min.store.state; const b = st.pickups.find((p) => p.by === 'gp'); return b && { by: b.by, score: b.score, category: b.category, state: b.state }; });
ok(gpBox && gpBox.by === 'gp' && typeof gpBox.score === 'number', '承認した箱に by と score が付く', gpBox);
ok(await page.evaluate(() => self.__min.app.selection && self.__min.app.selection.kind === 'proposal'), '承認のあと次の提案が選ばれている');

// 6. 似た記号の提案を選んで Delete → 退ける（負例）。1 つだけ減る（二度走らない）
await page.evaluate((id) => { self.__min.app.selection = { kind: 'proposal', id }; self.__min.renderAll(); }, props.find(isLook).id);
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
s = await S();
ok(s.rej === 1 && s.props === TRUE.length + LOOK.length - 2, 'Delete で退ける → 退けた場所 1・提案が 1 つだけ減る', s);

// 7. 探し直す → 退けた場所と箱のある場所は出ない。まとめて承認 → 提案 0
await page.evaluate(() => { self.__min.app.selection = null; const pal = self.__min.palette; self.__min.gp.search(pal.categories.find((c) => c.name === 'A').id, 'pg-001'); self.__min.renderAll(); });
await page.waitForTimeout(200);
s = await S();
ok(s.props === TRUE.length - 1, '探し直す → 退けた似た記号が負例になり、もう 1 つの似た記号も消える。承認した箱の場所も出ない', s);
props = await propsOn();
ok(props.every(isTrue) && props.every((p) => p.score >= 0.85), '残った提案は同じ向きだけ', props.map((p) => [p.bbox, p.score]));
await page.evaluate(() => self.__min.gp.approveAll('pg-001', null));
await page.waitForTimeout(200);
s = await S();
ok(s.props === 0 && s.boxes === KIND1.length && s.gp === KIND1.length - 1, 'まとめて承認 → 提案 0・箱 ' + KIND1.length + '（gp ' + (KIND1.length - 1) + '）', s);
const table = await page.evaluate(() => { const m = self.__min; const a = m.app.objects.filter((o) => m.palette.category(o.leaf) && m.palette.category(o.leaf).name === 'A'); return a.reduce((n, o) => n + (o.quantity || 0), 0); });
ok(table === KIND1.length, '集計: A の個数 = ' + KIND1.length + '（承認した箱も数えられる）', table);
await shot('gp_approved');

// 8. 別の向き（B）を 1 つ囲うと、A の箱は負例になり、B の残りだけ提案になる
await page.evaluate(() => { const pal = self.__min.palette; self.__min.app.currentCategory = pal.categories.find((c) => c.name === 'B').id; self.__min.setTool('box'); self.__min.fit(); });
await page.waitForTimeout(200);
{
  const [cx, cy] = center(KIND2[0]);
  await drag(cx - 8, cy - 8, cx + 8, cy + 8);
}
await page.waitForTimeout(400);
props = await propsOn();
ok(props.length === KIND2.length - 1 && props.every((p) => KIND2.slice(1).some((cr) => near(p.bbox, cr))), 'B を 1 つ囲う → B の残り ' + (KIND2.length - 1) + ' だけ提案（A の箱は負例）', props.map((p) => [p.bbox, p.score]));

// 9. 読み直しても残る（提案・退けた場所は localStorage、特徴量は IndexedDB）
await page.reload();
await page.waitForFunction(() => self.__min && self.__min.app.pdf && self.__min.store.state.pages.length === 2, null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.evaluate(() => self.__min.setScreen('pick'));
await page.waitForTimeout(300);
s = await S();
ok(s.boxes === KIND1.length + 1 && s.rej === 1 && s.props === KIND2.length - 1 && s.status === 'none', '読み直し: 箱・退けた場所・提案は残り、特徴量は読み直しまで none', s);
await page.evaluate(() => self.__min.gp.prepare('pg-001'));
await page.waitForFunction(() => self.__min.detector().status('pg-001').status === 'ready', null, { timeout: 10000 });
ok((await S()).status === 'ready', '読み直しのあとも IndexedDB から ready');

ok(problems.length === 0, 'ページのエラーが無い', problems);
await browser.close();
console.log(failed ? 'FAILED: ' + failed : 'ALL OK');
process.exit(failed ? 1 : 0);
