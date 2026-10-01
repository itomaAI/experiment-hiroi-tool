// node --test tests/analysis.test.js — 図面解析（core/analysis.js）
// 応答の見本（tests/fixtures/analysis_response.json）は作り物。実在の図面から読んだ値ではない
const test = require('node:test');
const assert = require('node:assert');
const SM = require('../core/model.js');
const A = require('../core/analysis.js');
const RES = require('./fixtures/analysis_response.json');

function blankStore(n) {
  const st = SM.emptyState();
  st.doc = { name: 'test.pdf', pages: n };
  st.pages = Array.from({ length: n }, (_, i) => ({ id: 'pg-' + String(i + 1).padStart(3, '0'), index: i + 1, title: 'p.' + (i + 1), width: 842, height: 595 }));
  return new SM.Store(A.ensure(st));
}

test('ページの番号の書き方', () => {
  assert.deepStrictEqual(A.parsePageSpec('1-3, 11，5 30〜31 99', 40), [1, 2, 3, 5, 11, 30, 31]);
  assert.strictEqual(A.formatPageSpec([1, 2, 3, 5, 11, 12]), '1-3, 5, 11, 12');
});

test('切り抜きのタイル: 小さければ 1 枚・細長ければ縮めて 1 枚・大きければ分ける', () => {
  const small = A.tilesFor([0, 0, 200, 100]);
  assert.strictEqual(small.tiles.length, 1);
  assert.ok(Math.abs(small.scale - 300 / 72) < 1e-9);
  const thin = A.tilesFor([0, 0, 480, 60]); // 300 dpi では 2000 画素。縮めれば 1 枚
  assert.strictEqual(thin.tiles.length, 1);
  assert.ok(thin.scale * 480 <= 1536 + 1e-6 && thin.scale >= 200 / 72);
  const big = A.tilesFor([0, 0, 1190, 842]);
  assert.ok(big.tiles.length > 1 && big.tiles.length <= 12, String(big.tiles.length));
  // タイルは範囲を覆う
  const right = Math.max(...big.tiles.map((t) => t[0] + t[2]));
  const bottom = Math.max(...big.tiles.map((t) => t[1] + t[3]));
  assert.ok(right >= 1189.9 && bottom >= 841.9);
});

test('送るものの計画: 送るページ・注釈の札・「全ページ」は送る全ページに広がる', () => {
  const s = blankStore(5);
  s.commit('x', (st, S) => {
    S.setPagesFlag(['pg-001', 'pg-003', 'pg-004'], 'send', true);
    S.addAnnotation('pg-003', [100, 100, 200, 100], 'schedule', { title: '器具表' });
    S.addAnnotation('pg-001', [10, 10, 100, 50], 'legend');
    S.addAnnotation('pg-001', [600, 540, 230, 40], 'title');
  });
  const pl = A.plan(s.state);
  assert.deepStrictEqual(pl.pages, [1, 3, 4]);
  assert.deepStrictEqual(pl.crops.map((c) => c.tag), ['A1', 'A2@p1', 'A2@p3', 'A2@p4', 'A3']);
  assert.strictEqual(pl.crops.find((c) => c.tag === 'A3').title, '器具表');
  const parts = A.parts(s.state, pl, {});
  assert.ok(parts.some((p) => p.pdf));
  assert.strictEqual(parts.filter((p) => p.crop !== undefined).length, pl.images);
  assert.match(parts[0].text, /1 枚目 = p\.1/);
  // 何も送らないとき
  const s2 = blankStore(2);
  assert.ok(A.plan(s2.state).problems.length);
});

test('応答の形: 決まりの欄が揃っている', () => {
  for (const k of A.SCHEMA.required) assert.ok(A.SCHEMA.properties[k], k);
  const n = A.normalize({ pages: [{ page: '2', kinds: ['平面図', 'ないもの'] }], categories: [{ key: '', name: 'x' }], notes: [{ kind: '?', text: 'a' }] });
  assert.deepStrictEqual(n.pages[0].kinds, ['平面図']);
  assert.strictEqual(n.categories.length, 0);
  assert.strictEqual(n.notes[0].kind, 'その他');
});

test('応答を入れる: ページ・カテゴリ・構成・ラベル・規則・見込み・系統・覚え書き', () => {
  const s = blankStore(3);
  const sum = s.commit('解析', (st, S) => A.apply(S, RES, { pages: [1, 2, 3], run: 'run-1' }));
  assert.strictEqual(sum.pages, 3);
  assert.strictEqual(sum.warnings.length, 0, sum.warnings.join('\n'));
  const pal = s.palette;
  const byName = (n) => pal.categories.find((c) => c.name === n);
  // カテゴリの木
  assert.deepStrictEqual(pal.categoryPath(byName('DL-1').id), ['拾えるもの（根）', '照明器具', 'ダウンライト', 'DL-1']);
  assert.strictEqual(byName('DL-1').note, 'LED φ100');
  assert.strictEqual(byName('DL-1').by, 'llm');
  assert.deepStrictEqual(byName('DL-1').src, ['A2']);
  assert.strictEqual(byName('配線').size, '長さ');
  // 構成と条件
  const w = byName('CV 38-3C (E51)');
  const lab = (n, parent) => pal.labels.find((l) => l.name === n && (!parent || pal.label(l.parent).name === parent));
  assert.deepStrictEqual(w.components.map((c) => [pal.category(c.material).name, c.count, c.when.map((x) => pal.labelPath(x).join('/')), c.add]), [['CV 38-3C', 1, [], true], ['E 51', 1, ['あり'], false]]);
  // ラベル（木は見出し）
  assert.strictEqual(lab('階').root, true);
  assert.deepStrictEqual(pal.labelPath(lab('事務室').id), ['2階', '事務室']);
  // 規則
  assert.deepStrictEqual(lab('会議室').rules.map((r) => [pal.category(r.category).name, r.candidates.map((c) => pal.category(c).name)]), [['ダウンライト', ['DL-1', 'DL-2']]]);
  // 見込み・系統・覚え書き
  assert.deepStrictEqual(s.state.palette.expected.map((e) => [e.labels.map((l) => pal.label(l).name), pal.category(e.category).name, e.count]), [[['事務室'], 'BL-1', 12], [['会議室'], 'DL-1', 4]]);
  assert.deepStrictEqual(s.state.palette.systems.map((x) => [x.name, x.from, x.to, pal.category(x.category).name]), [['1L-1', '受電盤', 'L-2', 'CV 38-3C (E51)'], ['1L-2', '受電盤', 'L-3', 'CV 38-3C (E51)']]);
  assert.strictEqual(s.state.analysis.notes.length, 2);
  // ページ: 題の頭の工事名は外し、図面番号を添える。拾うの印
  const p1 = s.page('pg-001');
  assert.strictEqual(p1.title, '特記仕様書（E-01）');
  assert.strictEqual(p1.tagBy.title, 'llm');
  assert.deepStrictEqual(A.pickPages(s.state).map((p) => p.index), [2, 3]);
  // 元に戻すと、まとめて戻る
  s.undo();
  assert.strictEqual(s.palette.categories.length, 1);
  assert.strictEqual(s.state.analysis.notes.length, 0);
  assert.strictEqual(s.page('pg-001').title, 'p.1');
});

test('もう一度入れても増えない（同じ親の下の同じ名前は使い回す）。人が直したページの欄は替えない', () => {
  const s = blankStore(3);
  s.commit('1', (st, S) => A.apply(S, RES, {}));
  const n = { c: s.state.palette.categories.length, l: s.state.palette.labels.length, e: s.state.palette.expected.length, y: s.state.palette.systems.length, nt: s.state.analysis.notes.length };
  s.commit('人が直す', (st, S) => { S.setPageMeta('pg-002', { title: '2F 電灯（人）' }, 'human'); S.setPagesFlag(['pg-003'], 'pick', false); });
  const sum = s.commit('2', (st, S) => A.apply(S, RES, {}));
  assert.strictEqual(sum.categories.added, 0);
  assert.strictEqual(sum.labels.added, 0);
  assert.deepStrictEqual({ c: s.state.palette.categories.length, l: s.state.palette.labels.length, e: s.state.palette.expected.length, y: s.state.palette.systems.length, nt: s.state.analysis.notes.length }, n);
  assert.strictEqual(s.page('pg-002').title, '2F 電灯（人）');
  assert.strictEqual(s.page('pg-003').pick, false); // 人が付けた「拾わない」
  // 規則の候補は重ならない
  const pal = s.palette;
  const meeting = pal.labels.find((l) => l.name === '会議室');
  assert.strictEqual(meeting.rules[0].candidates.length, 2);
});

test('入れた規則で、拾いの部材が決まる（演算とつながる）', () => {
  const s = blankStore(3);
  s.commit('解析', (st, S) => A.apply(S, RES, {}));
  const pal = s.palette;
  const office = pal.labels.find((l) => l.name === '事務室').id;
  const light = pal.categories.find((c) => c.name === '照明器具').id;
  s.commit('エリア', (st, S) => S.addArea('pg-002', { type: 'rect', points: [[0, 0], [300, 300]] }, office));
  const pk = s.commit('箱', (st, S) => S.addBox('pg-002', light, [100, 100, 10, 10]));
  const o = SM.derive.objectsOf(s, s.palette, s.pickup(pk))[0];
  assert.strictEqual(s.palette.category(o.leaf).name, 'BL-1');
});

test('相手の無い参照は知らせて飛ばす（落ちない）', () => {
  const s = blankStore(1);
  const bad = { pages: [{ page: 9, title: 'x', kinds: [], pick: true }], categories: [{ key: 'a', name: 'A', parent: 'nope', size: '個数' }], components: [{ owner: 'a', material: 'zz', count: 1 }], label_trees: [], labels: [{ key: 'l', name: 'L', tree: 'tt', parent: '' }], rules: [{ label: 'l', category: 'q', candidates: ['a'] }], expected: [{ labels: ['nope'], category: 'a', count: 1 }], systems: [{ name: 'S', category: 'nope' }], notes: [] };
  const sum = s.commit('x', (st, S) => A.apply(S, bad, { pages: [1] }));
  assert.ok(sum.warnings.length >= 5, sum.warnings.join('\n'));
  assert.strictEqual(s.palette.category(s.palette.categories.find((c) => c.name === 'A').id).parent, 'cat-root');
  // 木の key が label_trees に無くても、その名前の木を作る
  assert.ok(s.palette.labels.find((l) => l.name === 'tt' && l.root));
});

test('注釈・覚え書き・見込み・系統の編集と、古い保存の読み込み', () => {
  const s = blankStore(2);
  const id = s.commit('注釈', (st, S) => S.addAnnotation('pg-001', [1, 2, 3, 4], 'note'));
  s.commit('直す', (st, S) => { S.updateAnnotation(id, { title: 't', note: 'n', kind: 'caution' }); S.moveAnnotation(id, 10, 10); });
  assert.deepStrictEqual([s.annotation(id).kind, s.annotation(id).bbox], ['caution', [11, 12, 3, 4]]);
  const nt = s.commit('覚え書き', (st, S) => S.addNote({ text: 'a', kind: '注意' }));
  s.commit('直す', (st, S) => S.updateNote(nt, { text: 'b', done: true }));
  assert.deepStrictEqual([s.state.analysis.notes[0].text, s.state.analysis.notes[0].done, s.state.analysis.notes[0].by], ['b', true, 'human']);
  s.commit('系統', (st, S) => { S.addSystem({ name: 'X' }); S.updateSystem(0, { to: 'Y' }); });
  assert.strictEqual(s.state.palette.systems[0].to, 'Y');
  s.commit('消す', (st, S) => { S.removeAnnotation(id); S.removeNote(nt); S.removeSystem(0); });
  assert.deepStrictEqual([s.state.annotations.length, s.state.analysis.notes.length, s.state.palette.systems.length], [0, 0, 0]);
  // format 5 の古い保存（欄が無い）
  const old = { format: 5, doc: {}, palette: { categories: [{ id: 'cat-root', name: 'r', parent: null }], labels: [] }, pages: [], areas: [], nodes: [], segments: [], routes: [], pickups: [], seq: {} };
  const m = SM.migrate(old);
  assert.deepStrictEqual([m.annotations, m.analysis.notes, m.palette.expected, m.palette.systems], [[], [], [], []]);
});

test('途中で切れた応答: 最後の閉じた項目までで閉じて読む', () => {
  const full = JSON.stringify({ pages: [{ page: 1, title: 'a', kinds: [], pick: true }], categories: [{ key: 'a', name: 'A', parent: '', size: '個数' }, { key: 'b', name: 'B', parent: 'a', size: '個数' }], systems: [{ name: 'x', category: 'a' }] });
  assert.deepStrictEqual(A.salvage(full).json, JSON.parse(full));
  const cut = full.slice(0, full.indexOf('"systems"')) + '"systems": [{ "name": "LM1-1？/LM1-1？/LM1-1？/LM';
  const sv = A.salvage(cut);
  assert.ok(sv && sv.cut > 0);
  assert.strictEqual(sv.json.categories.length, 2);
  assert.strictEqual(sv.json.systems, undefined); // 切れた並びは落ちる（normalize が空にする）
  assert.deepStrictEqual(A.normalize(sv.json).systems, []);
  assert.strictEqual(A.salvage('{"pages": [{"page": 1, "ti'), null);
});
