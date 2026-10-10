// Itera の上で効く橋（app/itera.js）の試験。MetaOS を偽物にして node で回す。画像を描く道具（hiroi_page / hiroi_crop）は canvas が要るので、ここでは通さない。
const test = require('node:test');
const assert = require('node:assert');
const SM = require('../core/model.js');
const A = require('../core/analysis.js');

function fakeMetaOS() {
  const files = new Map();
  const dirs = new Set();
  const log = [];
  const registered = new Map();
  return {
    files,
    dirs,
    log,
    registered,
    fs: {
      async exists(p) { return files.has(p) || dirs.has(p); },
      async mkdir(p) { dirs.add(p); },
      async write(p, content) { files.set(p, content); },
      async read(p, o) { if (!files.has(p)) throw new Error('no ' + p); return files.get(p); },
      async delete(p) { files.delete(p); },
    },
    tools: { async register(t) { registered.set(t.name, t); }, unregister(n) { registered.delete(n); } },
    ai: { log(text, type) { log.push({ text, type }); } },
    system: { async getArgs() { return {}; } },
  };
}

function load(M) {
  global.self = { SM, SMA: A, MetaOS: M };
  delete require.cache[require.resolve('../app/itera.js')];
  require('../app/itera.js');
  return global.self.SMIteraBridge;
}

function ctxWith(M) {
  const store = new SM.Store();
  A.ensure(store.state);
  store.state.pages = [{ id: 'pg-001', index: 1, title: 'p.1', width: 1190.55, height: 841.89 }, { id: 'pg-002', index: 2, title: 'p.2', width: 1190.55, height: 841.89 }];
  store.state.doc = { name: 'x.pdf', pages: 2, fingerprint: 'fp' };
  const shown = [];
  const ctx = {
    store,
    app: {},
    edit: (label, fn) => store.commit(label, (st, S) => fn(S, st)),
    toast: () => {},
    setScreen: (s) => shown.push(['screen', s]),
    setPage: (id) => shown.push(['page', id]),
    attachPdf: async () => true,
    confirmBox: async () => true,
  };
  const bridge = load(M)(ctx);
  return { store, ctx, bridge, shown };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('MetaOS が無ければ橋は作られない', () => {
  global.self = { SM, SMA: A };
  delete require.cache[require.resolve('../app/itera.js')];
  require('../app/itera.js');
  assert.strictEqual(global.self.SMIteraBridge({}), null);
});

test('道具を登録し、定義を tool_available で知らせる', async () => {
  const M = fakeMetaOS();
  const { bridge } = ctxWith(M);
  await bridge.afterBoot();
  for (const n of ['hiroi_status', 'hiroi_page', 'hiroi_crop', 'hiroi_palette', 'hiroi_apply', 'hiroi_annotate', 'hiroi_undo', 'hiroi_open', 'hiroi_show']) assert.ok(M.registered.has(n), n);
  assert.strictEqual(M.log.length, 1);
  assert.strictEqual(M.log[0].type, 'tool_available');
  assert.ok(M.log[0].text.includes('<define_tag name="hiroi_apply">'));
});

test('hiroi_apply: 編集の塊が入り、2 回目は同じ名前を使い回す。元に戻せる', async () => {
  const M = fakeMetaOS();
  const { store, bridge } = ctxWith(M);
  const h = bridge.handlers;
  const first = await h.hiroi_apply({ content: JSON.stringify({ label_trees: [{ key: 't', name: '部屋' }], labels: [{ key: 'r1', name: '玄関', tree: 't' }], categories: [{ key: 'c', name: '照明器具', parent: null, size: '個数' }, { key: 'g', name: 'GS100', parent: 'c' }], rules: [{ label: 'r1', category: 'c', candidates: ['g'] }], expected: [{ labels: ['r1'], category: 'g', count: 4 }] }) });
  assert.match(first, /カテゴリ \+2/);
  assert.match(first, /規則 1/);
  const second = await h.hiroi_apply({ content: JSON.stringify({ label_trees: [{ key: 't', name: '部屋' }], labels: [{ key: 'r2', name: '廊下', tree: 't' }], categories: [{ key: 'c', name: '照明器具', parent: null }, { key: 'g', name: 'GS100', parent: 'c' }, { key: 'h', name: 'H100', parent: 'c' }], rules: [{ label: 'r2', category: 'c', candidates: ['g', 'h'] }] }) });
  assert.match(second, /カテゴリ \+1（再利用 2）/);
  assert.strictEqual(store.state.palette.categories.filter((c) => c.name === 'GS100').length, 1);
  const pal = bridge.paletteText('categories,rules');
  assert.ok(pal.includes('GS100') && pal.includes('照明器具 → GS100/H100'), pal);
  assert.match(bridge.statusText(), /カテゴリ 4・ラベル 3・規則 2・見込み 1/);
  await h.hiroi_undo({});
  assert.strictEqual(store.state.palette.labels.filter((l) => l.name === '廊下').length, 0);
});

test('hiroi_apply: JSON でなければ知らせる', async () => {
  const M = fakeMetaOS();
  const { bridge } = ctxWith(M);
  await assert.rejects(bridge.handlers.hiroi_apply({ content: '{oops' }), /JSON として読めない/);
});

test('hiroi_annotate: 注釈が増え、status に出る。bbox が変なら止まる', async () => {
  const M = fakeMetaOS();
  const { store, bridge } = ctxWith(M);
  const r = await bridge.handlers.hiroi_annotate({ page: '2', bbox: '835,288,300,135', kind: 'schedule', title: '器具表' });
  assert.match(r, /囲った: an-0001 p\.2 \[機器表\] 器具表/);
  assert.deepStrictEqual(store.state.annotations[0].bbox, [835, 288, 300, 135]);
  assert.strictEqual(store.state.annotations[0].by, 'llm');
  assert.ok(bridge.statusText().includes('an-0001 p.2 [機器表] 器具表'));
  await assert.rejects(bridge.handlers.hiroi_annotate({ page: '2', bbox: '1,2,3' }), /bbox/);
  await assert.rejects(bridge.handlers.hiroi_annotate({ page: '9', bbox: '1,2,3,4' }), /p\.9 は無い/);
});

test('保存: 変えると少し待って job.json を VFS に書く。読み直せる。reset で消える', async () => {
  const M = fakeMetaOS();
  const { store, bridge } = ctxWith(M);
  await bridge.handlers.hiroi_apply({ content: JSON.stringify({ categories: [{ key: 'c', name: '照明器具', parent: null }] }) });
  assert.ok(!M.files.has(bridge.paths.JOB), '書くのは少し後');
  await wait(800);
  assert.ok(M.files.has(bridge.paths.JOB));
  const back = await bridge.loadJob();
  assert.strictEqual(back.palette.categories.length, store.state.palette.categories.length);
  await bridge.savePdf({ name: 'x.pdf', fingerprint: 'fp', pages: 2, bytes: new Uint8Array([1, 2, 3]).buffer });
  assert.ok(M.files.has(bridge.paths.PDF) && M.files.has(bridge.paths.PDF_META));
  const rec = await bridge.loadPdf();
  assert.strictEqual(rec.name, 'x.pdf');
  await bridge.reset();
  assert.ok(!M.files.has(bridge.paths.JOB) && !M.files.has(bridge.paths.PDF));
});

test('hiroi_page の戻りに、ページの大きさと px → pt の換算を添える（canvas 無しでは描けないので、文の部分だけ）', async () => {
  const M = fakeMetaOS();
  const { bridge } = ctxWith(M);
  // 描画は canvas が要るので失敗する。失敗の前に pageByNumber が通ることだけ確かめる
  await assert.rejects(bridge.handlers.hiroi_page({ page: '2', dpi: '60' }), /描けない|canvas|document/);
  await assert.rejects(bridge.handlers.hiroi_page({ page: '9' }), /p\.9 は無い/);
  assert.ok(bridge.DEFS.hiroi_annotate.includes('原点は左上'));
});

test('hiroi_show: 画面とページを切り替える', async () => {
  const M = fakeMetaOS();
  const { bridge, shown } = ctxWith(M);
  await bridge.handlers.hiroi_show({ screen: 'palette', page: '2' });
  assert.deepStrictEqual(shown, [['screen', 'palette'], ['page', 'pg-002']]);
});
