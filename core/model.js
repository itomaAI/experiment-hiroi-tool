/*
 * 積算支援ツール ミニマル版 — 画面を持たない部分。
 *
 * 言葉（docs/concepts.md）
 *   拾い     図面の上に 箱（個数もの）か 線（長さもの）を置く一手。必ず粗いカテゴリが付く
 *   層       拾いを修飾するもの。エリア（面）と ルート（ノード・線分）。ラベルを持つ
 *   ラベル   層の型。節の木（森）。節が規則を持つ。木の中は排他
 *   カテゴリ 拾いの型。部材を葉とする木。葉は構成（部材の集まり）を持てる
 *   対象     （層 × 層 × …）(拾い) の結果。部材 × ラベルの組 × 数量。保存しない
 *
 * 依存: なし（DOM によらない。node でも動く）
 */
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.SM = M;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const M = {};

  const round = (x, d) => {
    const p = Math.pow(10, d || 0);
    return Math.round(x * p) / p;
  };
  M.round = round;

  /* ======================================================================
   * 1. パレット（型）
   * ====================================================================== */

  class Palette {
    constructor(def) {
      this.categories = (def.categories || []).map((c) => Object.assign({ parent: null, size: '個数', components: null }, c));
      this.labels = (def.labels || []).map((l) => Object.assign({ parent: null, root: false, rules: [], color: null }, l));
      this._cat = new Map(this.categories.map((c) => [c.id, c]));
      this._lab = new Map(this.labels.map((l) => [l.id, l]));
      this.views = def.views || [];
      this.name = def.name || '';
      this._colorize();
    }

    /* ---- カテゴリの木 ---- */
    category(id) {
      return this._cat.get(id) || null;
    }
    categoryChildren(id) {
      return this.categories.filter((c) => c.parent === id);
    }
    categoryRoots() {
      return this.categories.filter((c) => c.parent === null);
    }
    categoryAncestors(id) {
      const out = [];
      let c = this.category(id);
      while (c && c.parent) {
        out.push(c.parent);
        c = this.category(c.parent);
      }
      return out;
    }
    // id が under の下（または同じ）か
    categoryUnder(id, under) {
      if (id === under) return true;
      return this.categoryAncestors(id).includes(under);
    }
    categoryDescendants(id) {
      const out = [];
      const walk = (p) => {
        for (const c of this.categoryChildren(p)) {
          out.push(c.id);
          walk(c.id);
        }
      };
      walk(id);
      return out;
    }
    isLeaf(id) {
      return this.categoryChildren(id).length === 0;
    }
    leavesUnder(id) {
      if (this.isLeaf(id)) return [id];
      return this.categoryDescendants(id).filter((d) => this.isLeaf(d));
    }
    categoryPath(id) {
      return this.categoryAncestors(id)
        .reverse()
        .concat([id])
        .map((x) => (this.category(x) || { name: x }).name);
    }

    /* ---- ラベルの森 ---- */
    label(id) {
      return this._lab.get(id) || null;
    }
    labelChildren(id) {
      return this.labels.filter((l) => l.parent === id);
    }
    labelRoots() {
      return this.labels.filter((l) => l.parent === null);
    }
    labelAncestors(id) {
      const out = [];
      let l = this.label(id);
      while (l && l.parent) {
        out.push(l.parent);
        l = this.label(l.parent);
      }
      return out;
    }
    // 木の根（root: true の節）
    labelRoot(id) {
      const anc = this.labelAncestors(id);
      return anc.length ? anc[anc.length - 1] : id;
    }
    labelUnder(id, under) {
      if (id === under) return true;
      return this.labelAncestors(id).includes(under);
    }
    labelDescendants(id) {
      const out = [];
      const walk = (p) => {
        for (const c of this.labelChildren(p)) {
          out.push(c.id);
          walk(c.id);
        }
      };
      walk(id);
      return out;
    }
    // 塗れるラベル（根ではないもの）
    paintable() {
      return this.labels.filter((l) => !l.root);
    }
    // 根を除いた、根からの道の名前
    labelPath(id) {
      return this.labelAncestors(id)
        .reverse()
        .concat([id])
        .filter((x) => !(this.label(x) || {}).root)
        .map((x) => (this.label(x) || { name: x }).name);
    }

    // 木ごとに色相を割り、節ごとに明るさを変える
    _colorize() {
      const roots = this.labelRoots();
      roots.forEach((r, i) => {
        const hue = r.hue !== undefined ? r.hue : (i * 67) % 360;
        if (!r.color) r.color = `hsl(${hue} 60% 45%)`;
        const desc = this.labelDescendants(r.id);
        desc.forEach((d, k) => {
          const l = this.label(d);
          if (l.color) return;
          const depth = this.labelAncestors(d).length;
          const light = 42 + ((k * 7) % 22) + depth * 2;
          const sat = 70 - depth * 8;
          l.color = `hsl(${(hue + (k * 13) % 30) % 360} ${sat}% ${light}%)`;
        });
      });
    }
  }
  M.Palette = Palette;

  /* ======================================================================
   * 2. 幾何（座標は PDF のポイント。原点は左上）
   * ====================================================================== */

  const G = {};
  M.geom = G;

  G.dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // 多角形の内外（辺の上は内とする）
  G.pointInPolygon = function (p, poly) {
    const x = p[0];
    const y = p[1];
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0];
      const yi = poly[i][1];
      const xj = poly[j][0];
      const yj = poly[j][1];
      if (G.distToSegment(p, poly[i], poly[j]) < 1e-6) return true;
      const cross = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (cross) inside = !inside;
    }
    return inside;
  };

  G.shapePolygon = function (shape) {
    if (shape.type === 'rect') {
      const [a, b] = shape.points;
      return [
        [a[0], a[1]],
        [b[0], a[1]],
        [b[0], b[1]],
        [a[0], b[1]],
      ];
    }
    return shape.points;
  };

  G.shapeContains = (shape, p) => G.pointInPolygon(p, G.shapePolygon(shape));

  // 折れ線の全部の点が中にあるか
  G.shapeContainsAll = (shape, pts) => pts.every((p) => G.shapeContains(shape, p));
  G.shapeContainsAny = (shape, pts) => pts.some((p) => G.shapeContains(shape, p));

  // 点と線分の距離と、最も近い点
  G.closestOnSegment = function (p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { t, point: [a[0] + t * dx, a[1] + t * dy] };
  };
  G.distToSegment = (p, a, b) => G.dist(p, G.closestOnSegment(p, a, b).point);

  // 点と折れ線の距離。最も近い場所（どの辺・位置）も返す
  G.closestOnPolyline = function (p, pts) {
    let best = { d: Infinity, i: -1, t: 0, point: null };
    for (let i = 0; i + 1 < pts.length; i++) {
      const c = G.closestOnSegment(p, pts[i], pts[i + 1]);
      const d = G.dist(p, c.point);
      if (d < best.d) best = { d, i, t: c.t, point: c.point };
    }
    return best;
  };

  G.bboxContains = (bbox, p) => p[0] >= bbox[0] && p[0] <= bbox[0] + bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[1] + bbox[3];
  G.bboxCenter = (bbox) => [bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2];

  /* ======================================================================
   * 3. ストア（正のデータ: ページ・層・拾い）
   * ====================================================================== */

  /*
   * 正のデータ（format 5。4 との違いは doc だけ）
   *   doc       図面の PDF（name・pages（枚数）・demo）。PDF そのものは保存しない（画面の側が IndexedDB に持つ）
   *   areas     エリア（多角形 × ラベル 1 つ）。層
   *   nodes     ノード。segments 線分（a・b・points）。骨 —— 線とルートが共有する土台。層でも拾いでもない
   *             立のノードは level（上／下）と base（元のノード）を持ち、点 1 つの線分（riser）で元のノードとつながる
   *   routes    ルート（線分の集まり × ラベル 1 つ、または 長さ）。層。線を覆い、ラベルか長さを与える
   *   pickups   拾い（箱・線）。線は path（線分の列）と、線分ごとの長さの上書き（lengths）を持つ
   */
  M.emptyState = function (paletteDef) {
    return { format: 5, doc: { name: '', pages: null, demo: false }, palette: paletteDef || M.emptyPalette(), pages: [], areas: [], nodes: [], segments: [], routes: [], pickups: [], seq: { ar: 0, nd: 0, sg: 0, rt: 0, pk: 0, lb: 0, ct: 0 } };
  };
  const hasLen = (x) => !!x && ((x.length_h !== null && x.length_h !== undefined) || (x.length_v !== null && x.length_v !== undefined));
  M.hasLen = hasLen;

  const clone = (x) => JSON.parse(JSON.stringify(x));
  M.clone = clone;

  /*
   * 配列の中で、me を「same を満たすものの並び」の before の前（null なら末尾）へ動かす。
   * 兄弟の順は配列の順で持っている
   */
  function moveInList(list, me, before, same) {
    const i = list.indexOf(me);
    if (i >= 0) list.splice(i, 1);
    if (before) {
      const j = list.findIndex((x) => x.id === before);
      if (j >= 0) {
        list.splice(j, 0, me);
        return;
      }
    }
    // 兄弟の最後の後ろ（兄弟が無ければ末尾）
    let last = -1;
    list.forEach((x, k) => {
      if (same(x)) last = k;
    });
    list.splice(last >= 0 ? last + 1 : list.length, 0, me);
  }
  M.moveInList = moveInList;

  // 葉の共通の祖先（自分を含む）
  function commonAncestor(pal, ids) {
    const chains = ids.map((id) => [id].concat(pal.categoryAncestors(id)));
    const first = chains[0];
    for (const c of first) if (chains.every((ch) => ch.includes(c))) return c;
    return pal.categoryRoots()[0] ? pal.categoryRoots()[0].id : null;
  }
  M.commonAncestor = commonAncestor;

  /*
   * 字下げの文字列 → [{ depth, name, refs, size, root }]
   *   字下げはタブか空白（2 つで 1 段）。行頭の「- 」「・」「* 」は飛ばす。空行は飛ばす
   *   「名前: a, b, c」「名前：a、b」 … refs（規則の候補の名前）
   *   「名前 [長さ]」「名前 [個数]」 … size（カテゴリの数え方）
   *   「# 名前」 … root（ラベルの見出し。塗れない）
   */
  M.parseOutline = function (text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const lead = /^[\t 　]*/.exec(raw)[0];
      let depth = 0;
      for (const ch of lead) depth += ch === '\t' ? 2 : ch === '　' ? 2 : 1;
      depth = Math.floor(depth / 2);
      let line = raw.slice(lead.length).replace(/^([-*・•]\s*)/, '').trim();
      const item = { depth, name: '', refs: null, size: null, root: false };
      if (/^#\s*/.test(line)) {
        item.root = true;
        line = line.replace(/^#\s*/, '');
      }
      const sz = /\s*[\[［](個数|長さ)[\]］]\s*$/.exec(line);
      if (sz) {
        item.size = sz[1];
        line = line.slice(0, sz.index).trim();
      }
      const colon = line.search(/[:：]/);
      if (colon >= 0) {
        item.refs = line.slice(colon + 1).split(/[,，、\t]/).map((x) => x.trim()).filter(Boolean);
        line = line.slice(0, colon).trim();
      }
      item.name = line;
      if (item.name) out.push(item);
    }
    return out;
  };

  // まっさらなパレット（根「拾えるもの」だけ）
  M.emptyPalette = function () {
    return { name: '', categories: [{ id: 'cat-root', name: '拾えるもの（根）', parent: null, size: null }], labels: [], views: [] };
  };

  /*
   * 保存の形を今の版へ。format 4 → 5: doc（図面の PDF の名前と枚数）を足す。
   * opts.doc4: format 4 の作業がどの図面のものだったか（ページの index の付け替え表 map を持てる）
   */
  M.migrate = function (st, opts) {
    if (!st || !st.format) return null;
    if (st.format === 5) return st;
    if (st.format === 4) {
      const o = opts || {};
      const d = o.doc4 || { name: '', pages: null };
      if (d.map) for (const p of st.pages) if (d.map[p.index]) p.index = d.map[p.index];
      st.doc = { name: d.name || '', pages: d.pages || null, demo: !!d.demo };
      st.format = 5;
      return st;
    }
    return null;
  };

  class Store {
    constructor(state) {
      this.state = state || M.emptyState();
      this.undoStack = [];
      this.redoStack = [];
      this.listeners = [];
      this.lastLabel = '';
      this._palette = null;
    }

    // パレット（型）。state.palette から組む。編集のたびに組み直す
    get palette() {
      if (!this._palette) this._palette = new Palette(this.state.palette);
      return this._palette;
    }
    touchPalette() {
      this._palette = null;
    }

    onChange(fn) {
      this.listeners.push(fn);
    }
    _emit(what) {
      this._palette = null;
      for (const fn of this.listeners) fn(what, this);
    }

    /*
     * 下見: 写しの上で fn を実行し、その結果（状態と対象）を返す。本物は変えない。
     */
    preview(fn) {
      const copy = new Store(clone(this.state));
      copy.seq = this.state.seq;
      let error = null;
      let result;
      try {
        result = fn(copy);
      } catch (e) {
        error = e;
      }
      return { store: copy, result, error };
    }

    /* ---- 元に戻す ---- */
    commit(label, fn) {
      const before = clone(this.state);
      const out = fn(this.state, this);
      this.undoStack.push({ label, state: before });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.lastLabel = label;
      this._emit(label);
      return out;
    }
    undo() {
      const h = this.undoStack.pop();
      if (!h) return false;
      this.redoStack.push({ label: h.label, state: clone(this.state) });
      this.state = h.state;
      this._emit('元に戻す: ' + h.label);
      return true;
    }
    redo() {
      const h = this.redoStack.pop();
      if (!h) return false;
      this.undoStack.push({ label: h.label, state: clone(this.state) });
      this.state = h.state;
      this._emit('やり直す: ' + h.label);
      return true;
    }
    replace(state) {
      this.state = state;
      this.undoStack = [];
      this.redoStack = [];
      this._emit('読み込み');
    }
    /*
     * 下書き（ルートや線を引いている間）。途中の編集はストアに直に入れ、
     * 終えたら 1 回の編集として履歴に積む。やめたら、始める前の状態に戻す。
     */
    beginDraft() {
      this._draft = clone(this.state);
    }
    endDraft(label) {
      if (!this._draft) return;
      this.undoStack.push({ label, state: this._draft });
      this.redoStack = [];
      this._draft = null;
      this.lastLabel = label;
      this._emit(label);
    }
    cancelDraft() {
      if (!this._draft) return;
      this.state = this._draft;
      this._draft = null;
      this._emit('やめた');
    }
    get drafting() {
      return !!this._draft;
    }

    /* ---- 引く ---- */
    page(id) {
      return this.state.pages.find((p) => p.id === id) || null;
    }
    area(id) {
      return this.state.areas.find((a) => a.id === id) || null;
    }
    node(id) {
      return this.state.nodes.find((n) => n.id === id) || null;
    }
    segment(id) {
      return this.state.segments.find((s) => s.id === id) || null;
    }
    pickup(id) {
      return this.state.pickups.find((p) => p.id === id) || null;
    }
    areasOn(page) {
      return this.state.areas.filter((a) => a.page === page);
    }
    nodesOn(page) {
      return this.state.nodes.filter((n) => n.page === page);
    }
    segmentsOn(page) {
      return this.state.segments.filter((s) => s.page === page);
    }
    pickupsOn(page) {
      return this.state.pickups.filter((p) => p.page === page);
    }
    segmentsAt(nodeId) {
      return this.state.segments.filter((s) => s.a === nodeId || s.b === nodeId);
    }
    // 2 つのノードを直接つなぐ線分
    segmentBetween(a, b) {
      return this.state.segments.find((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a)) || null;
    }
    // 線分を通る拾い
    pickupsThrough(segId) {
      return this.state.pickups.filter((p) => p.kind === 'line' && (p.path || []).includes(segId));
    }

    nextId(kind) {
      const n = (this.state.seq[kind] = (this.state.seq[kind] || 0) + 1);
      return kind + '-' + String(n).padStart(4, '0');
    }

    /* ---- ページ ---- */
    setPages(pages) {
      this.state.pages = pages;
    }
    setPageTitle(id, title) {
      const p = this.page(id);
      if (p) p.title = title;
    }

    /* ---- パレット: ラベルの節と規則 ---- */
    // 節を足す。parent は根でも節でもよい。返すもの: 新しい節の id
    addLabel(parent, name, extra) {
      const id = this.nextId('lb');
      this.state.palette.labels.push(Object.assign({ id, name, parent, rules: [] }, extra || {}));
      this.touchPalette();
      return id;
    }
    renameLabel(id, name) {
      const l = this.state.palette.labels.find((x) => x.id === id);
      if (l) l.name = name;
      this.touchPalette();
    }
    // 節の規則を丸ごと置き換える。rules: [{ category, candidates }]
    setLabelRules(id, rules) {
      const l = this.state.palette.labels.find((x) => x.id === id);
      if (!l) return;
      l.rules = rules.filter((r) => r.category && r.candidates && r.candidates.length).map((r) => ({ category: r.category, candidates: r.candidates.slice() }));
      this.touchPalette();
    }
    // 節を消す（使っている層があれば消さない）。返すもの: 消せたか
    removeLabel(id) {
      const used = this.state.areas.some((a) => a.label === id) || this.state.routes.some((r) => r.label === id);
      const kids = this.state.palette.labels.some((l) => l.parent === id);
      if (used || kids) return false;
      this.state.palette.labels = this.state.palette.labels.filter((l) => l.id !== id);
      this.touchPalette();
      return true;
    }

    // 節の欄を直す（name・root（見出し。塗れない）・hue（木の色））
    updateLabel(id, patch) {
      const l = this.state.palette.labels.find((x) => x.id === id);
      if (!l) return;
      for (const k of ['name', 'root', 'hue']) if (patch[k] !== undefined) l[k] = patch[k];
      if (l.root === false) delete l.root;
      this.touchPalette();
    }
    /*
     * 節を動かす（木に組む・並べ替える）。parent: 新しい親（null で森の一番上）。before: この兄弟の前へ（null で末尾）。
     * 自分の子孫の下へは動かせない
     */
    moveLabel(id, parent, before) {
      const list = this.state.palette.labels;
      const me = list.find((x) => x.id === id);
      if (!me) throw new Error('節がありません: ' + id);
      if (parent !== null && this._under(list, parent, id)) throw new Error('自分の下へは動かせません');
      me.parent = parent;
      moveInList(list, me, before, (x) => x.parent === parent);
      this.touchPalette();
    }
    // 節とその子孫を消す（どれかが層に使われていれば消さない）。返すもの: { ok, used }
    removeLabelTree(id) {
      const list = this.state.palette.labels;
      const ids = new Set([id].concat(this._descendants(list, id)));
      const used = this.state.areas.filter((a) => ids.has(a.label)).length + this.state.routes.filter((r) => ids.has(r.label)).length;
      if (used) return { ok: false, used };
      this.state.palette.labels = list.filter((l) => !ids.has(l.id));
      // 構成の条件から外す
      for (const c of this.state.palette.categories) if (c.components) for (const comp of c.components) comp.when = (comp.when || []).filter((w) => !ids.has(w));
      this.touchPalette();
      return { ok: true, removed: ids.size };
    }

    /* ---- パレット: カテゴリ ---- */
    // カテゴリを足す。size は既定で親から受け継ぐ。返すもの: 新しい id
    addCategory(parent, name, extra) {
      const cats = this.state.palette.categories;
      const par = parent ? cats.find((c) => c.id === parent) : null;
      if (parent && !par) throw new Error('親がありません: ' + parent);
      const id = this.nextId('ct');
      const size = par && par.size ? par.size : '個数';
      const c = Object.assign({ id, name, parent: parent || null, size }, extra || {});
      cats.push(c);
      if (extra && extra.before !== undefined) {
        delete c.before;
        moveInList(cats, c, extra.before, (x) => x.parent === c.parent);
      }
      this.touchPalette();
      return id;
    }
    // 欄を直す（name・size（'個数'|'長さ'）・color・note）
    updateCategory(id, patch) {
      const c = this.state.palette.categories.find((x) => x.id === id);
      if (!c) return;
      for (const k of ['name', 'size', 'color', 'note']) if (patch[k] !== undefined) c[k] = patch[k];
      this.touchPalette();
    }
    // 数え方を子孫まで揃える
    setCategorySizeDeep(id, size) {
      const cats = this.state.palette.categories;
      const ids = [id].concat(this._descendants(cats, id));
      for (const c of cats) if (ids.includes(c.id)) c.size = size;
      this.touchPalette();
    }
    moveCategory(id, parent, before) {
      const cats = this.state.palette.categories;
      const me = cats.find((x) => x.id === id);
      if (!me) throw new Error('カテゴリがありません: ' + id);
      if (me.parent === null) throw new Error('根は動かせません');
      if (!parent) throw new Error('根の外へは動かせません');
      if (this._under(cats, parent, id)) throw new Error('自分の下へは動かせません');
      me.parent = parent;
      moveInList(cats, me, before, (x) => x.parent === parent);
      this.touchPalette();
    }
    // 構成を丸ごと置き換える。comps: [{ material, count, when, add }]。空なら構成なし（葉そのものが部材）
    setComponents(id, comps) {
      const c = this.state.palette.categories.find((x) => x.id === id);
      if (!c) return;
      const list = (comps || []).filter((x) => x.material).map((x) => ({ material: x.material, count: Number(x.count) || 1, when: (x.when || []).slice(), add: !!x.add }));
      c.components = list.length ? list : null;
      this.touchPalette();
    }
    // カテゴリが使われている所（自分と子孫）
    categoryUsage(id) {
      const cats = this.state.palette.categories;
      const ids = new Set([id].concat(this._descendants(cats, id)));
      const pickups = this.state.pickups.filter((p) => ids.has(p.category) || ids.has(p.chosen)).map((p) => p.id);
      const rules = [];
      for (const l of this.state.palette.labels) for (const r of l.rules || []) if (ids.has(r.category) || r.candidates.some((c) => ids.has(c))) rules.push(l.id);
      const components = cats.filter((c) => !ids.has(c.id) && (c.components || []).some((x) => ids.has(x.material))).map((c) => c.id);
      return { ids: [...ids], pickups, rules: [...new Set(rules)], components };
    }
    /*
     * カテゴリとその子孫を消す。拾いが使っていれば消さない（拾いのカテゴリを先に替える）。
     * 規則の候補・構成の部材からは外す（候補が空になった規則は消す）。返すもの: { ok, pickups, rules, components }
     */
    removeCategoryTree(id) {
      const cats = this.state.palette.categories;
      const me = cats.find((x) => x.id === id);
      if (!me) return { ok: false };
      if (me.parent === null) return { ok: false, root: true };
      const u = this.categoryUsage(id);
      if (u.pickups.length) return Object.assign({ ok: false }, u);
      const ids = new Set(u.ids);
      this.state.palette.categories = cats.filter((c) => !ids.has(c.id));
      for (const l of this.state.palette.labels) {
        l.rules = (l.rules || [])
          .filter((r) => !ids.has(r.category))
          .map((r) => ({ category: r.category, candidates: r.candidates.filter((c) => !ids.has(c)) }))
          .filter((r) => r.candidates.length);
      }
      for (const c of this.state.palette.categories) {
        if (!c.components) continue;
        c.components = c.components.filter((x) => !ids.has(x.material));
        if (!c.components.length) c.components = null;
      }
      this.touchPalette();
      return Object.assign({ ok: true }, u);
    }

    /*
     * まとめて足す（字下げの文字列から）。items: M.parseOutline の結果。
     * kind 'category': parent の下にカテゴリの木を足す。
     * kind 'label': parent（null で森の一番上）の下に節の木を足す。行の「: a, b」は規則の候補（葉の名前）。
     *   規則のカテゴリは、当たった葉の共通の祖先（opts.ruleCategory があればそれ）。
     * 返すもの: { ids, unknown: [当たらなかった名前] }
     */
    addOutline(kind, parent, items, opts) {
      const o = opts || {};
      const ids = [];
      const unknown = [];
      const stack = [{ depth: -1, id: parent }];
      for (const it of items) {
        while (stack.length > 1 && stack[stack.length - 1].depth >= it.depth) stack.pop();
        const par = stack[stack.length - 1].id;
        let id;
        if (kind === 'category') {
          id = this.addCategory(par, it.name, it.size ? { size: it.size } : null);
        } else {
          id = this.addLabel(par, it.name, par === null && it.root ? { root: true } : null);
          if (it.refs && it.refs.length) {
            const pal = this.palette;
            const leaves = [];
            for (const name of it.refs) {
              const hit = pal.categories.filter((c) => c.name === name && pal.isLeaf(c.id));
              if (hit.length) leaves.push(hit[0].id);
              else unknown.push(name);
            }
            if (leaves.length) {
              const cat = o.ruleCategory || commonAncestor(pal, leaves);
              this.setLabelRules(id, [{ category: cat, candidates: leaves }]);
            }
          }
        }
        ids.push(id);
        stack.push({ depth: it.depth, id });
      }
      this.touchPalette();
      return { ids, unknown };
    }

    /* ---- パレットを丸ごと ---- */
    // 置き換える。図面の上の層・拾いが指している id が新しいパレットに無ければ、置き換えない。返すもの: { ok, missing }
    replacePalette(def) {
      const cats = new Set((def.categories || []).map((c) => c.id));
      const labs = new Set((def.labels || []).map((l) => l.id));
      const missing = [];
      for (const p of this.state.pickups) {
        if (!cats.has(p.category)) missing.push(p.category);
        if (p.chosen && !cats.has(p.chosen)) missing.push(p.chosen);
      }
      for (const a of this.state.areas) if (!labs.has(a.label)) missing.push(a.label);
      for (const r of this.state.routes) if (r.label && !labs.has(r.label)) missing.push(r.label);
      if (missing.length) return { ok: false, missing: [...new Set(missing)] };
      this.state.palette = clone(def);
      this._bumpSeqFromPalette();
      this.touchPalette();
      return { ok: true };
    }
    // 足し合わせる（同じ id のものは残す。新しい id のものだけ足す）。返すもの: { categories, labels }（足した数）
    mergePalette(def) {
      const pal = this.state.palette;
      const haveC = new Set(pal.categories.map((c) => c.id));
      const haveL = new Set(pal.labels.map((l) => l.id));
      let nc = 0;
      let nl = 0;
      for (const c of def.categories || []) if (!haveC.has(c.id)) { pal.categories.push(clone(c)); nc++; }
      for (const l of def.labels || []) if (!haveL.has(l.id)) { pal.labels.push(clone(l)); nl++; }
      const haveV = new Set((pal.views || []).map((v) => v.id));
      pal.views = (pal.views || []).concat((def.views || []).filter((v) => !haveV.has(v.id)).map(clone));
      this._bumpSeqFromPalette();
      this.touchPalette();
      return { categories: nc, labels: nl };
    }
    _bumpSeqFromPalette() {
      const bump = (kind, ids) => {
        for (const id of ids) {
          const m = new RegExp('^' + kind + '-(\\d+)$').exec(id);
          if (m) this.state.seq[kind] = Math.max(this.state.seq[kind] || 0, Number(m[1]));
        }
      };
      bump('ct', this.state.palette.categories.map((c) => c.id));
      bump('lb', this.state.palette.labels.map((l) => l.id));
    }

    _descendants(list, id) {
      const out = [];
      const walk = (p) => {
        for (const x of list) if (x.parent === p) { out.push(x.id); walk(x.id); }
      };
      walk(id);
      return out;
    }
    // a が b の下（または同じ）か
    _under(list, a, b) {
      let cur = list.find((x) => x.id === a);
      while (cur) {
        if (cur.id === b) return true;
        cur = cur.parent ? list.find((x) => x.id === cur.parent) : null;
      }
      return false;
    }

    /* ---- 層: エリア ---- */
    addArea(page, shape, label) {
      const id = this.nextId('ar');
      this.state.areas.push({ id, page, shape, label });
      return id;
    }
    setAreaLabel(id, label) {
      const a = this.area(id);
      if (a) a.label = label;
    }
    // エリアを動かす（形ごと平行移動）
    moveArea(id, dx, dy) {
      const a = this.area(id);
      if (!a) return;
      a.shape = Object.assign({}, a.shape, { points: a.shape.points.map((p) => [round(p[0] + dx, 1), round(p[1] + dy, 1)]) });
    }
    // エリアの角を動かす。i は G.shapePolygon の並びの番号（矩形は向かいの角を止めて引き直す）
    moveAreaVertex(id, i, x, y) {
      const a = this.area(id);
      if (!a) return;
      if (a.shape.type === 'rect') {
        const poly = G.shapePolygon(a.shape);
        const o = poly[(i + 2) % 4];
        a.shape = { type: 'rect', points: [[round(Math.min(o[0], x), 1), round(Math.min(o[1], y), 1)], [round(Math.max(o[0], x), 1), round(Math.max(o[1], y), 1)]] };
      } else {
        const pts = a.shape.points.map((p) => p.slice());
        pts[i] = [round(x, 1), round(y, 1)];
        a.shape = Object.assign({}, a.shape, { points: pts });
      }
    }
    removeArea(id) {
      this.state.areas = this.state.areas.filter((a) => a.id !== id);
    }

    /* ---- 骨: ノードと線分（層でも拾いでもない共有の土台） ---- */
    addNode(page, x, y, extra) {
      const id = this.nextId('nd');
      this.state.nodes.push(Object.assign({ id, page, x: round(x, 1), y: round(y, 1) }, extra || {}));
      return id;
    }
    addSegment(page, a, b, points) {
      const id = this.nextId('sg');
      const na = this.node(a);
      const nb = this.node(b);
      const pts = [[na.x, na.y]].concat((points || []).map((p) => [round(p[0], 1), round(p[1], 1)]), [[nb.x, nb.y]]);
      this.state.segments.push({ id, page, a, b, points: pts });
      return id;
    }
    /*
     * 立ルートの骨: ノードに重ねた「上／下」のノードと、点 1 つの線分（決定 24）。
     * 返すもの: { node, segment }
     */
    addRiser(nodeId, level) {
      const n = this.node(nodeId);
      if (!n) return null;
      const rid = this.addNode(n.page, n.x, n.y, { level: level || '上', base: nodeId });
      const sid = this.nextId('sg');
      this.state.segments.push({ id: sid, page: n.page, a: nodeId, b: rid, points: [[n.x, n.y], [n.x, n.y]], riser: true });
      return { node: rid, segment: sid };
    }
    _num(v) {
      return v === null || v === undefined || v === '' || isNaN(v) ? null : Number(v);
    }
    /*
     * 線分を、折れ線の上の点で切る。ノード 1 つと線分 2 つになる。
     * 通っていた拾いの path、ルートの線分の集まり、線の上書きの長さ（切った線分の分は消える）を直す。
     * 返すもの: { node, segments }
     */
    splitSegment(id, at) {
      const s = this.segment(id);
      if (!s || s.riser) return null;
      const nid = this.addNode(s.page, at.point[0], at.point[1]);
      const n = this.node(nid);
      const pts1 = s.points.slice(0, at.i + 1).concat([[n.x, n.y]]);
      const pts2 = [[n.x, n.y]].concat(s.points.slice(at.i + 1));
      const mk = (a, b, pts) => {
        const sid = this.nextId('sg');
        this.state.segments.push({ id: sid, page: s.page, a, b, points: pts });
        return sid;
      };
      const s1 = mk(s.a, nid, pts1);
      const s2 = mk(nid, s.b, pts2);
      for (const r of this.state.routes) {
        const k = r.segments.indexOf(id);
        if (k >= 0) r.segments.splice(k, 1, s1, s2);
      }
      for (const p of this.pickupsThrough(id)) {
        const k = p.path.indexOf(id);
        const prev = k > 0 ? this.segment(p.path[k - 1]) : null;
        const forward = !prev || prev.a === s.a || prev.b === s.a;
        p.path.splice(k, 1, ...(forward ? [s1, s2] : [s2, s1]));
        if (p.lengths && p.lengths[id]) delete p.lengths[id];
      }
      this.state.segments = this.state.segments.filter((x) => x.id !== id);
      return { node: nid, segments: [s1, s2] };
    }
    // 線分を消す（通る拾いがあれば消さない）。ルートからは外し、空になったルートは消す
    removeSegment(id) {
      if (this.pickupsThrough(id).length) return false;
      const s = this.segment(id);
      if (!s) return false;
      this.state.segments = this.state.segments.filter((x) => x.id !== id);
      for (const r of this.state.routes) r.segments = r.segments.filter((x) => x !== id);
      this.state.routes = this.state.routes.filter((r) => r.segments.length);
      for (const n of [s.a, s.b]) if (!this.segmentsAt(n).length) this.state.nodes = this.state.nodes.filter((x) => x.id !== n);
      return true;
    }
    removeNode(id) {
      if (this.segmentsAt(id).length) return false;
      this.state.nodes = this.state.nodes.filter((x) => x.id !== id);
      return true;
    }
    moveNode(id, x, y) {
      const n = this.node(id);
      if (!n) return;
      n.x = round(x, 1);
      n.y = round(y, 1);
      const upd = (m) => {
        for (const s of this.segmentsAt(m.id)) {
          if (s.riser) {
            s.points = [[m.x, m.y], [m.x, m.y]];
            continue;
          }
          if (s.a === m.id) s.points[0] = [m.x, m.y];
          if (s.b === m.id) s.points[s.points.length - 1] = [m.x, m.y];
        }
      };
      upd(n);
      // 立のノードは、元のノードといっしょに動く
      for (const r of this.state.nodes.filter((m) => m.base === id)) {
        r.x = n.x;
        r.y = n.y;
        upd(r);
      }
    }
    // 骨をまとめて平行移動する（線分の集まりの端のノードと途中の角）。ほかの線分と共有するノードも動くので、その線分は伸び縮みする
    moveBones(segIds, dx, dy) {
      const set = new Set(segIds);
      const ids = new Set();
      for (const s of this.state.segments) if (set.has(s.id)) { ids.add(s.a); ids.add(s.b); }
      for (const id of ids) {
        const n = this.node(id);
        if (!n || n.base) continue; // 立のノードは元のノードといっしょに動く
        this.moveNode(id, n.x + dx, n.y + dy);
      }
      for (const s of this.state.segments) {
        if (!set.has(s.id) || s.riser) continue;
        for (let i = 1; i < s.points.length - 1; i++) s.points[i] = [round(s.points[i][0] + dx, 1), round(s.points[i][1] + dy, 1)];
      }
    }
    // 線分の途中の角を動かす（i は points の番号。端は動かさない）
    moveSegmentPoint(segId, i, x, y) {
      const s = this.segment(segId);
      if (!s || i <= 0 || i >= s.points.length - 1) return;
      s.points[i] = [round(x, 1), round(y, 1)];
    }
    // 線分を骨の上の道でつないだ、連続する折れ線（path の順）
    pathPoints(path) {
      let out = [];
      let prevEnd = null;
      for (const sid of path) {
        const s = this.segment(sid);
        if (!s) continue;
        let pts = s.points;
        if (prevEnd && (pts[0][0] !== prevEnd[0] || pts[0][1] !== prevEnd[1])) pts = pts.slice().reverse();
        out = out.concat(out.length ? pts.slice(1) : pts);
        prevEnd = pts[pts.length - 1];
      }
      return out;
    }

    /*
     * 2 つのノードの間の道（線分の列）。閉路があれば本数が最少（長さは線分に無いので）。
     * 立の線分は通らない（印を通るノードに選んだときだけ通る）。
     * 返すもの: 線分 id の配列。無ければ null
     */
    findPath(a, b) {
      if (a === b) return [];
      const dist = new Map([[a, 0]]);
      const prev = new Map();
      const todo = [a];
      const done = new Set();
      while (todo.length) {
        todo.sort((x, y) => dist.get(x) - dist.get(y));
        const u = todo.shift();
        if (done.has(u)) continue;
        done.add(u);
        if (u === b) break;
        for (const s of this.segmentsAt(u)) {
          const w = s.a === u ? s.b : s.a;
          // 立の線分は、道の端（始点から出る・終点へ入る）でだけ通る
          if (s.riser && !(u === a || w === b)) continue;
          const d = dist.get(u) + 1;
          if (!dist.has(w) || d < dist.get(w)) {
            dist.set(w, d);
            prev.set(w, { node: u, seg: s.id });
            todo.push(w);
          }
        }
      }
      if (!dist.has(b)) return null;
      const out = [];
      let cur = b;
      while (cur !== a) {
        const p = prev.get(cur);
        out.unshift(p.seg);
        cur = p.node;
      }
      return out;
    }

    /* ---- 層: ルート（線分の集まり × ラベル 1 つ、または 長さ） ---- */
    route(id) {
      return this.state.routes.find((r) => r.id === id) || null;
    }
    routesOn(page) {
      return this.state.routes.filter((r) => r.page === page);
    }
    // 線分を覆うルート
    routesCovering(segId) {
      return this.state.routes.filter((r) => r.segments.includes(segId));
    }
    /*
     * ルートを置く。opts: { label, length_h, length_v }。ラベルか長さのどちらかは要る。
     * 同じ線分の集まりに同じ木のラベルがあれば置き換える（木の中は排他）。長さルートも同じ集まりなら置き換える
     */
    addRoute(page, segments, opts, palette) {
      const o = opts || {};
      const label = o.label || null;
      const h = this._num(o.length_h);
      const v = this._num(o.length_v);
      if (!label && h === null && v === null) return null;
      const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
      this.state.routes = this.state.routes.filter((r) => {
        if (!same(r.segments, segments)) return true;
        if (label) return !(r.label && palette.labelRoot(r.label) === palette.labelRoot(label));
        return !!r.label;
      });
      const id = this.nextId('rt');
      this.state.routes.push({ id, page, segments: segments.slice(), label, length_h: label ? null : h, length_v: label ? null : v });
      return id;
    }
    setRouteLength(id, h, v) {
      const r = this.route(id);
      if (!r) return;
      if (h !== undefined) r.length_h = this._num(h);
      if (v !== undefined) r.length_v = this._num(v);
    }
    setRouteLabel(id, label) {
      const r = this.route(id);
      if (r) r.label = label || null;
    }
    removeRoute(id) {
      this.state.routes = this.state.routes.filter((r) => r.id !== id);
    }
    // ルートが線分の集まりごと骨を消す（ほかのルートや拾いが使う線分は残す）
    removeRouteWithBones(id) {
      const r = this.route(id);
      if (!r) return false;
      this.removeRoute(id);
      for (const sid of r.segments) if (!this.routesCovering(sid).length) this.removeSegment(sid);
      return true;
    }

    /* ---- 拾い ---- */
    addBox(page, category, bbox) {
      const id = this.nextId('pk');
      this.state.pickups.push({ id, kind: 'box', page, category, chosen: null, bbox: bbox.map((v) => round(v, 1)) });
      return id;
    }
    addLine(page, category, nodes, path, name) {
      const id = this.nextId('pk');
      this.state.pickups.push({ id, kind: 'line', page, category, chosen: null, nodes: nodes.slice(), path: path.slice(), name: name || '', additions: {}, lengths: {} });
      return id;
    }
    // 線の、線分ごとの長さの上書き（決定 47）。両方 null なら消す
    setLineLength(id, segId, h, v) {
      const p = this.pickup(id);
      if (!p || p.kind !== 'line') return;
      if (!p.lengths) p.lengths = {};
      const hh = this._num(h);
      const vv = this._num(v);
      if (hh === null && vv === null) delete p.lengths[segId];
      else p.lengths[segId] = { h: hh, v: vv };
    }
    setPickupCategory(id, category) {
      const p = this.pickup(id);
      if (p) {
        p.category = category;
        p.chosen = null;
      }
    }
    setChosen(id, leaf) {
      const p = this.pickup(id);
      if (p) p.chosen = leaf || null;
    }
    setPickupName(id, name) {
      const p = this.pickup(id);
      if (p) p.name = name;
    }
    setAddition(id, node, len) {
      const p = this.pickup(id);
      if (!p || p.kind !== 'line') return;
      if (len === null || len === '' || isNaN(len)) delete p.additions[node];
      else p.additions[node] = Number(len);
    }
    movePickup(id, dx, dy) {
      const p = this.pickup(id);
      if (!p || p.kind !== 'box') return;
      p.bbox[0] = round(p.bbox[0] + dx, 1);
      p.bbox[1] = round(p.bbox[1] + dy, 1);
    }
    removePickup(id) {
      this.state.pickups = this.state.pickups.filter((p) => p.id !== id);
    }

    // 線の拾いの、端のノード（道の両端。1 本も無ければ、通るノード）
    lineEnds(p) {
      if (!p.path.length) return p.nodes.slice(0, 2);
      const first = this.segment(p.path[0]);
      const last = this.segment(p.path[p.path.length - 1]);
      if (!first || !last) return [];
      let start;
      if (p.path.length === 1) start = first.a;
      else {
        const second = this.segment(p.path[1]);
        start = first.a === second.a || first.a === second.b ? first.b : first.a;
      }
      let end;
      if (p.path.length === 1) end = first.b;
      else {
        const before = this.segment(p.path[p.path.length - 2]);
        end = last.a === before.a || last.a === before.b ? last.b : last.a;
      }
      return [start, end];
    }
  }
  M.Store = Store;

  /* ======================================================================
   * 4. 演算 — （層 × 層 × …）(拾い) → 対象
   * ====================================================================== */

  const D = {};
  M.derive = D;

  // ラベルの集合に、祖先（根を除く）を足す
  D.withAncestors = function (palette, labels) {
    const out = new Set();
    for (const l of labels) {
      if (!palette.label(l)) continue;
      out.add(l);
      for (const a of palette.labelAncestors(l)) if (!palette.label(a).root) out.add(a);
    }
    return out;
  };

  // 点に効くラベル（その点を中に含むエリア）
  D.labelsAtPoint = function (store, palette, page, pt) {
    const found = store.areasOn(page).filter((a) => G.shapeContains(a.shape, pt));
    return { labels: D.withAncestors(palette, found.map((a) => a.label)), areas: found.map((a) => a.id) };
  };

  // 線分に効くラベル（折れ線の全部を中に含むエリア ∪ 線分を覆うラベルルート）。跨ぐエリアも返す
  D.labelsOfSegment = function (store, palette, seg) {
    const all = store.areasOn(seg.page).filter((a) => G.shapeContainsAll(a.shape, seg.points));
    const some = store.areasOn(seg.page).filter((a) => !G.shapeContainsAll(a.shape, seg.points) && G.shapeContainsAny(a.shape, seg.points));
    const routes = store.routesCovering(seg.id).filter((r) => r.label);
    const labels = D.withAncestors(palette, all.map((a) => a.label).concat(routes.map((r) => r.label)));
    return { labels, areas: all.map((a) => a.id), routes: routes.map((r) => r.id), straddles: some.map((a) => a.id) };
  };

  // 木ごとの重複（同じ木で、祖先関係にない 2 つ以上のラベル）
  D.duplicates = function (palette, labels) {
    const byRoot = new Map();
    for (const l of labels) {
      const r = palette.labelRoot(l);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(l);
    }
    const out = [];
    for (const [r, ls] of byRoot) {
      // 最も深いもの（他のどれの祖先でもないもの）が 2 つ以上なら重複
      const deepest = ls.filter((x) => !ls.some((y) => y !== x && palette.labelUnder(y, x)));
      if (deepest.length > 1) out.push({ root: r, labels: deepest });
    }
    return out;
  };

  // 木ごとの、いちばん深いラベル（集計の鍵）
  D.deepestIn = function (palette, labels, rootId) {
    const ls = [...labels].filter((l) => palette.labelRoot(l) === rootId);
    const deepest = ls.filter((x) => !ls.some((y) => y !== x && palette.labelUnder(y, x)));
    return deepest;
  };

  /*
   * 絞り込み。粗いカテゴリ以下の葉から、ラベルに付いた規則で候補を削る。
   * 規則は、節（とその祖先）に付いているものが効く。
   *   規則のカテゴリが、拾いのカテゴリの祖先または同じ → 候補 ∩ 規則の候補
   *   規則のカテゴリが、拾いのカテゴリの子孫          → その子孫の下の葉のうち、規則に無いものを外す
   */
  D.narrow = function (palette, category, labels) {
    let cands = palette.leavesUnder(category);
    const applied = [];
    for (const l of labels) {
      const lab = palette.label(l);
      for (const r of lab.rules || []) {
        if (palette.categoryUnder(category, r.category)) {
          cands = cands.filter((c) => r.candidates.includes(c));
          applied.push({ label: l, rule: r });
        } else if (palette.categoryUnder(r.category, category)) {
          const under = palette.leavesUnder(r.category);
          cands = cands.filter((c) => !under.includes(c) || r.candidates.includes(c));
          applied.push({ label: l, rule: r });
        }
      }
    }
    return { candidates: cands, applied };
  };

  D.resolveLeaf = function (palette, pickup, labels) {
    const n = D.narrow(palette, pickup.category, labels);
    // 箱は個数の部材、線は長さの部材だけが候補
    const want = pickup.kind === 'box' ? '個数' : '長さ';
    n.candidates = n.candidates.filter((c) => {
      const cat = palette.category(c);
      return !cat.size || cat.size === want;
    });
    const flags = [];
    let leaf = null;
    if (pickup.chosen) {
      leaf = pickup.chosen;
      if (!n.candidates.includes(leaf)) flags.push('候補の外');
    } else if (n.candidates.length === 1) leaf = n.candidates[0];
    else if (n.candidates.length === 0) flags.push('候補なし');
    else flags.push('未確定');
    return { leaf, candidates: n.candidates, applied: n.applied, flags };
  };

  // 葉の構成（無ければ、葉そのものが部材 1 つ・本数 1）
  D.componentsOf = function (palette, leaf) {
    const c = palette.category(leaf);
    if (c && c.components && c.components.length) return c.components;
    return [{ material: leaf, count: 1, when: [], add: true }];
  };

  const whenOk = (when, labels) => (when || []).every((l) => labels.has(l));

  /*
   * 対象の生成。拾い 1 つ → 対象の配列。
   * 対象: { key, pickup, kind, segment, part, material, labels(Set→Array), count, length, addition, quantity, flags, candidates, leaf, name, page }
   */
  D.objectsOf = function (store, palette, pickup) {
    const out = [];
    if (pickup.kind === 'box') {
      const c = G.bboxCenter(pickup.bbox);
      const la = D.labelsAtPoint(store, palette, pickup.page, c);
      const r = D.resolveLeaf(palette, pickup, la.labels);
      const flags = r.flags.slice();
      for (const d of D.duplicates(palette, la.labels)) flags.push('重複: ' + palette.label(d.root).name);
      const comps = r.leaf ? D.componentsOf(palette, r.leaf) : [{ material: null, count: 1, when: [] }];
      for (const comp of comps) {
        if (!whenOk(comp.when, la.labels)) continue;
        out.push({
          key: pickup.id + '/' + (comp.material || '?'),
          pickup: pickup.id,
          kind: 'box',
          page: pickup.page,
          segment: null,
          part: null,
          material: comp.material,
          leaf: r.leaf,
          candidates: r.candidates,
          labels: [...la.labels],
          count: comp.count,
          length: null,
          addition: 0,
          quantity: r.leaf ? comp.count : null,
          flags,
          name: '',
        });
      }
      return out;
    }
    /*
     * 線: 線分ごとに、長さの出どころを決める（決定 47）。
     *   線の上書き（lengths[seg]）があればそれ（長さルートもあれば旗「上書き」）
     *   無ければ、線分を覆う長さルートのうち最も狭いもの（線がその全部の線分を通るとき）。ルートは 1 回だけ数える
     *   どちらも無い → 旗「長さ未入力」（覆う長さルートの一部しか通っていなければ「ルートの一部」）
     */
    const ends = store.lineEnds(pickup);
    const own = pickup.lengths || {};
    const pathSet = new Set(pickup.path);
    const emitted = new Set(); // 数えた長さルート
    const emit = (ref, page, labels, flags0, candidates, leaf, parts, touchNodes) => {
      const comps = leaf ? D.componentsOf(palette, leaf) : [{ material: null, count: 1, when: [], add: false }];
      const touching = [...new Set(touchNodes)].filter((n) => ends.includes(n) && pickup.additions && pickup.additions[n] !== undefined);
      const addTotal = touching.reduce((s, n) => s + pickup.additions[n], 0);
      const addPart = parts.length === 2 ? '立' : parts[0][0];
      for (const [part, len] of parts) {
        for (const comp of comps) {
          if (!whenOk(comp.when, labels)) continue;
          const addition = part === addPart && comp.add ? addTotal : 0;
          const f = flags0.slice();
          if (part === null) f.push('長さ未入力');
          const q = leaf && part !== null ? round((len + addition) * comp.count, 2) : null;
          out.push({
            key: pickup.id + '/' + ref + '/' + (part || '-') + '/' + (comp.material || '?'),
            pickup: pickup.id,
            kind: 'line',
            page,
            segment: ref,
            part,
            material: comp.material,
            leaf,
            candidates,
            labels: [...labels],
            count: comp.count,
            length: len,
            addition,
            quantity: q,
            flags: f,
            name: pickup.name || '',
          });
        }
      }
    };
    const partsOf = (x) => {
      const parts = [];
      const hh = x.h !== undefined ? x.h : x.length_h;
      const vv = x.v !== undefined ? x.v : x.length_v;
      if (hh !== null && hh !== undefined) parts.push(['平', hh]);
      if (vv !== null && vv !== undefined) parts.push(['立', vv]);
      if (!parts.length) parts.push([null, null]);
      return parts;
    };
    for (const sid of pickup.path) {
      const seg = store.segment(sid);
      if (!seg) continue;
      const ls = D.labelsOfSegment(store, palette, seg);
      const r = D.resolveLeaf(palette, pickup, ls.labels);
      const flags = r.flags.slice();
      if (ls.straddles.length) flags.push('境を跨ぐ');
      for (const d of D.duplicates(palette, ls.labels)) flags.push('重複: ' + palette.label(d.root).name);
      // 覆う長さルート（狭い順）
      const lenRoutes = store.routesCovering(sid).filter((x) => !x.label && hasLen(x)).sort((a, b) => a.segments.length - b.segments.length);
      if (own[sid]) {
        if (lenRoutes.length) flags.push('上書き');
        emit(seg.id, seg.page, ls.labels, flags, r.candidates, r.leaf, partsOf(own[sid]), [seg.a, seg.b]);
        continue;
      }
      // 線がルートの全部の線分を通り、どの線分も上書きしていないとき、ルートを 1 単位として数える
      const whole = lenRoutes.find((x) => x.segments.every((s) => pathSet.has(s) && !own[s]));
      if (whole) {
        if (emitted.has(whole.id)) continue;
        emitted.add(whole.id);
        // ルートを 1 単位として数える。ラベルは、覆う線分に共通のもの
        let labels = null;
        let straddle = false;
        const touch = [];
        for (const s2 of whole.segments) {
          const sg = store.segment(s2);
          if (!sg) continue;
          const l2 = D.labelsOfSegment(store, palette, sg);
          labels = labels === null ? new Set(l2.labels) : new Set([...labels].filter((l) => l2.labels.has(l)));
          if (l2.straddles.length) straddle = true;
          touch.push(sg.a, sg.b);
        }
        const r2 = D.resolveLeaf(palette, pickup, labels);
        const f2 = r2.flags.slice();
        if (straddle) f2.push('境を跨ぐ');
        for (const d of D.duplicates(palette, labels)) f2.push('重複: ' + palette.label(d.root).name);
        emit(whole.id, seg.page, labels, f2, r2.candidates, r2.leaf, partsOf(whole), touch);
        continue;
      }
      if (lenRoutes.length) flags.push('ルートの一部');
      emit(seg.id, seg.page, ls.labels, flags, r.candidates, r.leaf, [[null, null]], [seg.a, seg.b]);
    }
    return out;
  };

  D.allObjects = function (store, palette) {
    let out = [];
    for (const p of store.state.pickups) out = out.concat(D.objectsOf(store, palette, p));
    return out;
  };

  /* ======================================================================
   * 5. 集計 — 対象の集合の射影
   * ====================================================================== */

  const P = {};
  M.project = P;

  /*
   * 鍵の値を取る。鍵は 'material' | 'name' | 'part' | ラベルの木の根の id
   */
  P.keyOf = function (palette, obj, key) {
    if (key === 'material') return obj.material ? palette.category(obj.material).name : '（未確定）';
    if (key === 'name') return obj.name || '（名前なし）';
    if (key === 'part') return obj.part || '—';
    const deep = D.deepestIn(palette, new Set(obj.labels), key);
    if (deep.length === 0) return '（未分類）';
    if (deep.length > 1) return '（重複）';
    return palette.labelPath(deep[0]).join(' / ');
  };

  /*
   * view: { name, under (カテゴリ。null で全部), labels: [要るラベル], rows: [鍵], cols: [鍵] }
   * 返すもの: { rows: [名前], cols: [名前], cells: Map('r|c' → { sum, objects: [key] }), rowSums, colSums }
   */
  P.table = function (palette, objects, view) {
    const sel = objects.filter((o) => {
      if (o.quantity === null) return false;
      if (view.under && !(o.material && palette.categoryUnder(o.material, view.under))) return false;
      if (view.labels && view.labels.some((l) => !o.labels.includes(l))) return false;
      return true;
    });
    const rows = new Map();
    const cols = new Map();
    const cells = new Map();
    for (const o of sel) {
      const r = view.rows.map((k) => P.keyOf(palette, o, k)).join(' ／ ');
      const c = view.cols.map((k) => P.keyOf(palette, o, k)).join(' ／ ');
      rows.set(r, true);
      cols.set(c, true);
      const k = r + '|' + c;
      if (!cells.has(k)) cells.set(k, { sum: 0, objects: [] });
      const cell = cells.get(k);
      cell.sum = round(cell.sum + o.quantity, 2);
      cell.objects.push(o.key);
    }
    const rowList = [...rows.keys()].sort();
    const colList = [...cols.keys()].sort();
    const rowSums = {};
    const colSums = {};
    for (const [k, v] of cells) {
      const [r, c] = k.split('|');
      rowSums[r] = round((rowSums[r] || 0) + v.sum, 2);
      colSums[c] = round((colSums[c] || 0) + v.sum, 2);
    }
    return { rows: rowList, cols: colList, cells, rowSums, colSums, count: sel.length };
  };

  return M;
});