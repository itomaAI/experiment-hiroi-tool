// node --test tests/core.test.js
const test = require('node:test');
const assert = require('node:assert');
const SM = require('../core/model.js');
const F = require('../fixtures/palette.js');

function setup() {
  const store = new SM.Store();
  F.initialState(store, []);
  F.placeSample(store);
  return { palette: store.palette, store };
}
const objsOf = (store, pk) => SM.derive.objectsOf(store, store.palette, store.pickup(pk));

test('パレット: カテゴリの木とラベルの森', () => {
  const palette = new SM.Palette(F.palette());
  assert.deepStrictEqual(palette.leavesUnder('cat-downlight').sort(), ['cat-G100', 'cat-G150', 'cat-GS100', 'cat-H100', 'cat-I100']);
  assert.strictEqual(palette.labelRoot('lb-room-32'), 'lb-floor');
  assert.deepStrictEqual(palette.labelPath('lb-room-32'), ['1F', 'B玄関・風除室']);
  assert.strictEqual(palette.paintable().length, palette.labels.length - palette.labelRoots().length);
});

test('パレットの編集: 節を足す・規則を置く・元に戻す・下見', () => {
  const { store } = setup();
  const id = store.commit('節を足す', (st, S) => S.addLabel('lb-1F', '新しい部屋'));
  assert.strictEqual(store.palette.label(id).parent, 'lb-1F');
  store.commit('規則', (st, S) => S.setLabelRules(id, [{ category: 'cat-lighting', candidates: ['cat-G100'] }]));
  store.commit('エリア', (st, S) => S.addArea('pg-036', { type: 'rect', points: [[100, 100], [200, 200]] }, id));
  const b = store.commit('箱', (st, S) => S.addBox('pg-036', 'cat-root', [150, 150, 10, 10]));
  const o = objsOf(store, b)[0];
  assert.strictEqual(o.leaf, 'cat-G100');
  assert.ok(o.labels.includes('lb-1F'));
  for (let i = 0; i < 4; i++) store.undo();
  assert.strictEqual(store.palette.label(id), null);
  const pv = store.preview((s) => s.addLabel('lb-1F', '下見'));
  assert.ok(pv.store.palette.label(pv.result));
  assert.strictEqual(store.palette.label(pv.result), null);
});

test('見本: 幹線 1A2 の 5 つの値が集計表と合う（長さは長さルート）', () => {
  const { palette, store } = setup();
  const objs = SM.derive.allObjects(store, palette);
  const tb = SM.project.table(palette, objs, palette.views.find((v) => v.id === 'vw-trunk-section'));
  const get = (sec, mat) => (tb.cells.get('1A2 ／ ' + sec + '|' + mat) || { sum: null }).sum;
  assert.deepStrictEqual([get('1', 'CVT 100'), get('1', 'IV 14'), get('2', 'CVT 100'), get('2', 'IV 14'), get('2', 'G 82')], [24.0, 48.0, 59.3, 118.6, 9.7]);
  // つなぎ（ルート無し）は長さ未入力
  assert.ok(objs.some((o) => o.flags.includes('長さ未入力')));
});

test('見本: 分岐回路 #101 — 束のルートで葉が決まり、構成で展開される（平 11.4・立 2.0）', () => {
  const { palette, store } = setup();
  const objs = SM.derive.allObjects(store, palette);
  const tb = SM.project.table(palette, objs, palette.views.find((v) => v.id === 'vw-branch'));
  const sum = (mat) => ['平', '立'].reduce((s, p) => s + ((tb.cells.get('#101 ／ ' + p + '|' + mat) || { sum: 0 }).sum), 0);
  assert.strictEqual(SM.round(sum('VVF 2.0-2C'), 2), 26.8);
  assert.strictEqual(SM.round(sum('VVF 2.0-3C'), 2), 67.0);
  const pk = store.state.pickups.find((p) => p.name === '#101');
  assert.strictEqual(objsOf(store, pk.id)[0].leaf, 'cat-bundle-101-1');
  // 葉を決めたのは束の節の規則（分岐の配線の下に葉が 1 つしか無いから、ではない）
  assert.ok(objsOf(store, pk.id)[0].labels.includes('lb-bundle-101-1'));
  assert.strictEqual(SM.derive.narrow(store.palette, 'cat-branch', new Set(['lb-bundle-101-1'])).applied.length, 1);
});

test('見本: 玄関まわりの 3 部屋の器具', () => {
  const { palette, store } = setup();
  const tb = SM.project.table(palette, SM.derive.allObjects(store, palette), palette.views.find((v) => v.id === 'vw-lighting'));
  assert.strictEqual(tb.cells.get('GS100|1F / B玄関・風除室').sum, 4);
  assert.strictEqual(tb.cells.get('GS100|1F / B商談コーナー').sum, 6);
  assert.strictEqual(tb.cells.get('I100|1F / ポーチ').sum, 2);
  const id = store.addBox('pg-036', 'cat-downlight', [100, 100, 10, 10]);
  const o = objsOf(store, id)[0];
  assert.ok(o.flags.includes('未確定') && o.candidates.length === 5);
  const id3 = store.addBox('pg-036', 'cat-root', [570, 230, 10, 10]);
  assert.strictEqual(objsOf(store, id3)[0].leaf, 'cat-GS100');
});

test('長さの出どころ: 線の上書き ＞ 最も狭い長さルート ＞ 未入力。切っても長さルートは残る', () => {
  const { palette, store } = setup();
  const seg = store.segmentsOn('pg-015')[0]; // c: 長さルート 43.8
  const pk = store.pickupsThrough(seg.id)[0];
  const route = store.routesCovering(seg.id).find((r) => !r.label);
  const before = objsOf(store, pk.id).map((o) => [o.segment, o.material, o.quantity]);
  assert.deepStrictEqual(before, [[route.id, 'cat-CVT100', 43.8], [route.id, 'cat-IV14', 87.6]]);
  // 切る: ルートは 2 線分を覆う。線は両方通るので、ルートで 1 回数える（値は変わらない）
  const at = SM.geom.closestOnPolyline([556.1, 400], seg.points);
  const r = store.commit('切る', (s, st) => st.splitSegment(seg.id, at));
  assert.strictEqual(store.pickup(pk.id).path.length, 2);
  assert.deepStrictEqual(store.route(route.id).segments, r.segments);
  assert.deepStrictEqual(objsOf(store, pk.id).map((o) => [o.segment, o.material, o.quantity]), before);
  // 線の上書き（片方の線分に 20）: その線分は上書き・旗、もう片方はルートの一部
  store.commit('上書き', (s, st) => st.setLineLength(pk.id, r.segments[0], 20, null));
  const mixed = objsOf(store, pk.id);
  const o1 = mixed.find((o) => o.segment === r.segments[0] && o.material === 'cat-CVT100');
  assert.strictEqual(o1.quantity, 20);
  assert.ok(o1.flags.includes('上書き'));
  const o2 = mixed.find((o) => o.segment === r.segments[1]);
  assert.ok(o2.flags.includes('長さ未入力') && o2.flags.includes('ルートの一部'));
  // 狭いルートを被せると、そちらが勝つ
  store.commit('狭いルート', (s, st) => st.addRoute('pg-015', [r.segments[1]], { length_h: 3 }, palette));
  const narrow = store.routesCovering(r.segments[1]).find((x) => !x.label && x.segments.length === 1);
  const o3 = objsOf(store, pk.id).find((o) => o.segment === narrow.id && o.material === 'cat-CVT100');
  assert.strictEqual(o3.quantity, 3);
  store.undo();
  store.undo();
  store.undo();
  assert.strictEqual(store.pickup(pk.id).path.length, 1);
  assert.ok(store.segment(seg.id));
});

test('ルート: 同じ線分・同じ木は置き換え。線分を消すと空のルートは消える。立ルート', () => {
  const { palette, store } = setup();
  const seg = store.segmentsOn('pg-016')[0]; // a: ラック上・区間 1
  let ls = SM.derive.labelsOfSegment(store, palette, seg);
  assert.ok(ls.labels.has('lb-laying-rack') && ls.labels.has('lb-section-1'));
  store.commit('層', (s, st) => st.addRoute('pg-016', [seg.id], { label: 'lb-laying-ceiling' }, palette));
  ls = SM.derive.labelsOfSegment(store, palette, seg);
  assert.ok(ls.labels.has('lb-laying-ceiling') && !ls.labels.has('lb-laying-rack'));
  // 立ルート: ノードに上の印、点 1 つの線分。線がその印を通ると立の長さが乗る
  const node = store.node(seg.b);
  const rz = store.commit('立', (s, st) => st.addRiser(node.id, '上'));
  store.commit('立の長さ', (s, st) => st.addRoute('pg-016', [rz.segment], { length_v: 4 }, palette));
  assert.strictEqual(store.node(rz.node).level, '上');
  const path = store.findPath(seg.a, rz.node);
  assert.deepStrictEqual(path, [seg.id, rz.segment]);
  const pk = store.commit('線', (s, st) => st.addLine('pg-016', 'cat-1A2', [seg.a, rz.node], path, 'Z'));
  const os = objsOf(store, pk);
  assert.ok(os.some((o) => o.part === '立' && o.material === 'cat-CVT100' && o.quantity === 4));
  // 線を消して骨も消すと、ルートは消える
  store.commit('消す', (s, st) => st.removePickup(pk));
  const lenRoute = store.routesCovering(rz.segment)[0];
  assert.strictEqual(store.commit('消す', (s, st) => st.removeRouteWithBones(lenRoute.id)), true);
  assert.strictEqual(store.segment(rz.segment), null);
  assert.strictEqual(store.node(rz.node), null);
});
/* ---- M4: パレットの編集（カテゴリ・節の移動・まとめて足す・丸ごと） ---- */

test('カテゴリの編集: 足す（数え方は親から）・動かす・並べ替え・構成・消す（使われていれば止める）', () => {
  const store = new SM.Store();
  const a = store.commit('足す', (st, S) => S.addCategory('cat-root', '照明器具', { size: '個数' }));
  const b = store.commit('足す', (st, S) => S.addCategory(a, 'ダウンライト'));
  const c = store.commit('足す', (st, S) => S.addCategory(b, 'GS100'));
  const d = store.commit('足す', (st, S) => S.addCategory(b, 'G100'));
  const pal = store.palette;
  assert.strictEqual(pal.category(c).size, '個数');
  assert.deepStrictEqual(pal.leavesUnder(a), [c, d]);
  // 並べ替え: d を c の前へ
  store.commit('動かす', (st, S) => S.moveCategory(d, b, c));
  assert.deepStrictEqual(store.palette.categoryChildren(b).map((x) => x.id), [d, c]);
  // 自分の下へは動かせない
  assert.throws(() => store.commit('動かす', (st, S) => S.moveCategory(a, c, null)));
  // 構成
  const w = store.commit('足す', (st, S) => S.addCategory('cat-root', '配線', { size: '長さ' }));
  const cable = store.commit('足す', (st, S) => S.addCategory(w, 'CVT 100'));
  const row = store.commit('足す', (st, S) => S.addCategory(w, '1A2'));
  store.commit('構成', (st, S) => S.setComponents(row, [{ material: cable, count: 1, add: true }]));
  assert.strictEqual(store.palette.category(row).components[0].material, cable);
  // 拾いが使っていれば消せない
  store.commit('箱', (st, S) => S.addBox('pg-1', c, [0, 0, 10, 10]));
  const r1 = store.commit('消す', (st, S) => S.removeCategoryTree(b));
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.pickups.length, 1);
  // 規則の候補・構成の部材からは外れる
  const lab = store.commit('節', (st, S) => S.addLabel(null, '玄関'));
  store.commit('規則', (st, S) => S.setLabelRules(lab, [{ category: w, candidates: [cable, row] }]));
  const r2 = store.commit('消す', (st, S) => S.removeCategoryTree(cable));
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(store.palette.category(row).components, null);
  assert.deepStrictEqual(store.palette.label(lab).rules[0].candidates, [row]);
  // 根は消せない
  assert.strictEqual(store.commit('消す', (st, S) => S.removeCategoryTree('cat-root')).ok, false);
});

test('節の編集: 木に組む（動かす）・見出し・木ごと消す', () => {
  const store = new SM.Store();
  const x = store.commit('節', (st, S) => S.addLabel(null, '玄関'));
  const y = store.commit('節', (st, S) => S.addLabel(null, '展示コーナー'));
  // 親の無い節はそのまま塗れる（決定 38）
  assert.strictEqual(store.palette.paintable().length, 2);
  const f = store.commit('節', (st, S) => S.addLabel(null, '1F'));
  store.commit('組む', (st, S) => S.moveLabel(x, f, null));
  store.commit('組む', (st, S) => S.moveLabel(y, f, x));
  assert.deepStrictEqual(store.palette.labelChildren(f).map((l) => l.id), [y, x]);
  assert.deepStrictEqual(store.palette.labelPath(x), ['1F', '玄関']);
  assert.throws(() => store.commit('組む', (st, S) => S.moveLabel(f, x, null)));
  const t = store.commit('節', (st, S) => S.addLabel(null, '階'));
  store.commit('見出し', (st, S) => S.updateLabel(t, { root: true }));
  store.commit('組む', (st, S) => S.moveLabel(f, t, null));
  assert.deepStrictEqual(store.palette.labelPath(x), ['1F', '玄関']);
  store.commit('エリア', (st, S) => S.addArea('pg-1', { type: 'rect', points: [[0, 0], [1, 1]] }, x));
  assert.strictEqual(store.commit('消す', (st, S) => S.removeLabelTree(f)).ok, false);
  store.undo(); // 止まった「消す」
  store.undo(); // エリア
  assert.strictEqual(store.commit('消す', (st, S) => S.removeLabelTree(f)).removed, 3);
});

test('まとめて足す: 字下げ → 木。節の行の「: 記号」は規則（候補は葉の名前、カテゴリは共通の祖先）', () => {
  const store = new SM.Store();
  const items = SM.parseOutline('照明器具 [個数]\n  ダウンライト\n    GS100\n    G100\n  ベースライト\n    A321\n配線 [長さ]\n  CVT 100\n');
  const r = store.commit('貼る', (st, S) => S.addOutline('category', 'cat-root', items));
  assert.strictEqual(r.ids.length, 8);
  const pal = store.palette;
  const id = (name) => pal.categories.find((c) => c.name === name).id;
  assert.strictEqual(pal.category(id('CVT 100')).size, '長さ');
  assert.strictEqual(pal.category(id('GS100')).parent, id('ダウンライト'));
  const r2 = store.commit('貼る', (st, S) => S.addOutline('label', null, SM.parseOutline('# 部屋\n  玄関・風除室: GS100, G100\n  事務室：A321、GS100、XX9\n')));
  const p2 = store.palette;
  assert.deepStrictEqual(r2.unknown, ['XX9']);
  const room = p2.labels.find((l) => l.name === '部屋');
  assert.strictEqual(room.root, true);
  const genkan = p2.labels.find((l) => l.name === '玄関・風除室');
  assert.deepStrictEqual(genkan.rules, [{ category: id('ダウンライト'), candidates: [id('GS100'), id('G100')] }]);
  const office = p2.labels.find((l) => l.name === '事務室');
  assert.strictEqual(office.rules[0].category, id('照明器具'));
  // 規則が効く: 事務室で照明器具を置くと A321・GS100 の 2 つ
  store.commit('エリア', (st, S) => S.addArea('pg-1', { type: 'rect', points: [[0, 0], [100, 100]] }, office.id));
  const b = store.commit('箱', (st, S) => S.addBox('pg-1', id('照明器具'), [10, 10, 5, 5]));
  assert.deepStrictEqual(objsOf(store, b)[0].candidates.sort(), [id('A321'), id('GS100')].sort());
});

test('パレットを丸ごと: 置き換え（使っている id が無ければ止める）・足し合わせ・format 4 からの移し', () => {
  const { store } = setup();
  const r = store.commit('置き換え', (st, S) => S.replacePalette(SM.emptyPalette()));
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes('cat-1A2'));
  const fresh = new SM.Store();
  const m = fresh.commit('足す', (st, S) => S.mergePalette(F.palette()));
  assert.ok(m.categories > 10 && m.labels > 10);
  assert.strictEqual(fresh.commit('置き換え', (st, S) => S.replacePalette(F.palette())).ok, true);
  // 足したあとの新しい id は、読み込んだ id と衝突しない
  const nid = fresh.commit('節', (st, S) => S.addLabel(null, '新'));
  assert.strictEqual(fresh.state.palette.labels.filter((l) => l.id === nid).length, 1);
  // format 4 → 5
  const st4 = JSON.parse(JSON.stringify(store.state));
  st4.format = 4;
  delete st4.doc;
  const st5 = SM.migrate(st4, { doc4: { name: 'source.pdf', pages: 76, map: { 11: 11 } } });
  assert.strictEqual(st5.format, 5);
  assert.strictEqual(st5.doc.pages, 76);
});
