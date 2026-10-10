// GP の提案（core/gp.js）の試験。特徴量は作り物: セルごとに「記号の向き」を 1 つ持ち、同じ向きは近い埋め込みになる
const test = require('node:test');
const assert = require('node:assert');
const SM = require('../core/model.js');
const G = require('../core/gp.js');

// 20 × 16 セル（stride 8・scale 1 → ページは 160 × 128 pt）。(col,row) に kind を置く。kind 0 は白紙
function makePage(kinds, C = 16) {
  const fw = 20, fh = 16;
  const z = new Float32Array(C * fw * fh);
  const ink = new Uint8Array(fw * fh);
  const unit = (k) => { const v = new Float32Array(C); v[k % C] = 0.9; v[(k * 3) % C] += 0.3; v[(k * 7 + 1) % C] += 0.2; let n = Math.hypot(...v); return v.map((x) => x / n); };
  for (const [col, row, kind] of kinds) {
    const cell = row * fw + col;
    ink[cell] = 1;
    const u = unit(kind);
    for (let k = 0; k < C; k++) z[k * fw * fh + cell] = u[k];
  }
  const q = G.quantize(z, C, fw, fh, ink);
  return new G.Features({ page: 1, scale: 1, width: 160, height: 128, stride: 8, fw, fh, channels: C, kernel: G.DEFAULT_KERNEL }, q.cells, q.feat, q.scale);
}

test('quantize: インクのセルだけ持ち、復元すると元の z に近い', () => {
  const fp = makePage([[2, 3, 1], [10, 8, 2]]);
  assert.strictEqual(fp.N, 2);
  const v = fp.vecAt(2 * 8 + 4, 3 * 8 + 4);
  assert.ok(v && Math.abs(Math.hypot(...v) - 1) < 0.02);
  assert.strictEqual(fp.vecAt(100, 100, 0), null, '白紙なら null');
  assert.ok(fp.vecAt(17, 27, 2), '近くのセルで拾う');
});

test('fit / score / propose: 手本 1 つで同じ向きの場所が高く、別の向きは低い', () => {
  const fp = makePage([[2, 3, 1], [10, 8, 1], [15, 12, 1], [5, 10, 2], [12, 2, 2]]);
  const support = [{ x: fp.vecAt(20, 28), y: 1 }, { x: fp.vecAt(44, 84), y: 0 }];
  const model = G.fit(support);
  const scores = G.score(model, fp);
  const byCell = new Map(Array.from(fp.cells).map((c, i) => [c, scores[i]]));
  assert.ok(byCell.get(8 * 20 + 10) > 0.8, 'same kind far away: ' + byCell.get(8 * 20 + 10));
  assert.ok(byCell.get(2 * 20 + 12) < 0.3, 'other kind: ' + byCell.get(2 * 20 + 12));
  const props = G.propose(fp, scores, { w: 8, h: 8 }, [[16, 24, 8, 8]], { threshold: 0.5 });
  const centers = props.map((p) => [p.bbox[0] + 4, p.bbox[1] + 4]);
  assert.deepStrictEqual(centers.map((c) => c.join(',')).sort(), ['124,100', '84,68'].sort(), JSON.stringify(props));
  assert.ok(props.every((p) => p.score > 0.5));
});

test('collect: 同じカテゴリの箱が正例・他のカテゴリが負例・退けた場所も負例。大きさは手本の平均', () => {
  const fp = makePage([[2, 3, 1], [10, 8, 1], [5, 10, 2]]);
  const store = new SM.Store();
  SM.fill5(store.state);
  store.state.pages = [{ id: 'pg-001', index: 1, title: 'p.1', width: 160, height: 128 }];
  const light = store.addCategory('cat-root', '照明', { size: '個数' });
  const a = store.addCategory(light, 'A', { size: '個数' });
  const b = store.addCategory(light, 'B', { size: '個数' });
  store.touchPalette();
  store.addBox('pg-001', a, [16, 24, 8, 10]);
  store.addBox('pg-001', b, [40, 80, 8, 8]);
  store.state.rejections.push({ page: 'pg-001', category: a, x: 84, y: 68 });
  const feats = new Map([['pg-001', fp]]);
  const c = G.collect(store, store.palette, feats, a);
  assert.strictEqual(c.exemplars.length, 1);
  assert.strictEqual(c.support.filter((s) => s.y === 1).length, 1);
  assert.strictEqual(c.support.filter((s) => s.y === 0).length, 2, '他カテゴリ 1 ＋ 退けた 1');
  assert.deepStrictEqual(c.size, { w: 8, h: 10 });
  // 粗い節で集めると、下の葉の箱は全部正例
  const c2 = G.collect(store, store.palette, feats, light);
  assert.strictEqual(c2.exemplars.length, 2);
  // 特徴量の無いページの手本は missing
  store.addBox('pg-002', a, [1, 1, 2, 2]);
  assert.strictEqual(G.collect(store, store.palette, feats, a).missing, 1);
});

test('store: 提案を入れ替える・承認で箱（by gp）・退けると負例・元に戻せる', () => {
  const store = new SM.Store();
  SM.fill5(store.state);
  store.state.pages = [{ id: 'pg-001', index: 1, title: 'p.1', width: 160, height: 128 }];
  const a = store.addCategory('cat-root', 'A', { size: '個数' });
  store.commit('提案', (st, S) => S.replaceProposals(a, 'pg-001', [{ bbox: [10, 10, 8, 8], score: 0.9 }, { bbox: [50, 50, 8, 8], score: 0.6 }], 'run-1'));
  assert.strictEqual(store.proposalsOn('pg-001').length, 2);
  store.commit('提案', (st, S) => S.replaceProposals(a, 'pg-001', [{ bbox: [30, 30, 8, 8], score: 0.7 }]));
  assert.strictEqual(store.state.proposals.length, 1, '入れ替わる');
  const pid = store.state.proposals[0].id;
  let boxId = null;
  store.commit('承認', (st, S) => { boxId = S.approveProposal(pid); });
  assert.strictEqual(store.state.proposals.length, 0);
  const box = store.pickup(boxId);
  assert.strictEqual(box.by, 'gp');
  assert.deepStrictEqual(box.bbox, [30, 30, 8, 8]);
  store.commit('提案', (st, S) => S.replaceProposals(a, 'pg-001', [{ bbox: [90, 90, 8, 8], score: 0.55 }]));
  const pid2 = store.state.proposals[0].id;
  store.commit('退ける', (st, S) => S.rejectProposal(pid2));
  assert.deepStrictEqual(store.state.rejections, [{ page: 'pg-001', category: a, x: 94, y: 94 }]);
  store.undo();
  assert.strictEqual(store.state.rejections.length, 0);
  assert.strictEqual(store.state.proposals.length, 1);
});
