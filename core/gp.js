/*
 * 拾いツール — GP による提案（画面を持たない部分。T-0646）。
 *
 * 特徴量（ページごと）: 口「検出」（app/detector.js）が ONNX（ResNet18 layer1+2 ＋ 128 次元の埋め込み。L2 正規化済み）で計算し、
 * インクの近くのセルだけ int8 で持つ（P-0019 の precompute_pages.py と同じ形）:
 *   meta   { page（番号）, scale（px / pt）, width, height（px）, stride, fw, fh（セルの数）, channels, kernel{ lengthscale, outA, outB, noise } }
 *   cells  Uint32Array[N]  セル index（row * fw + col、昇順）
 *   feat   Int8Array[N*C]  量子化した埋め込み（セルごとの倍率を掛けると z に戻る）
 *   scale  Float32Array[N] セルごとの倍率
 *
 * GP: カテゴリごとに 1 つ。手本（そのカテゴリの箱の中心の特徴）を正例、他のカテゴリの箱と、退けた場所を負例にする。
 *     RBF（lengthscale 固定）・事後平均 → ロジット a*m+b → sigmoid（sekisan-gp-demo・product-symbol-annotator の GpEngine.js と同じ）。
 * 座標はページの pt（原点は左上）。
 *
 * 依存: なし（node でも動く）
 */
(function (root, factory) {
  const G = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
  else root.SMGP = G;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const G = {};
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  G.DEFAULT_KERNEL = { lengthscale: 0.320029079914093, outA: 7.103280544281006, outB: -4.5388922691345215, noise: 0.01 };

  /* ---------- 特徴量 ---------- */
  class Features {
    constructor(meta, cells, feat, scale) {
      this.meta = meta;
      this.cells = cells;
      this.feat = feat;
      this.scale = scale;
      this.N = cells.length;
      this.C = meta.channels;
      this.pos = new Int32Array(meta.fw * meta.fh).fill(-1);
      for (let i = 0; i < this.N; i++) this.pos[cells[i]] = i;
    }
    // pt → セルの row/col
    cellRC(x, y) {
      const m = this.meta;
      return { col: clamp(Math.round((x * m.scale) / m.stride), 0, m.fw - 1), row: clamp(Math.round((y * m.scale) / m.stride), 0, m.fh - 1) };
    }
    // セル index → 中心の pt
    cellCenter(i) {
      const m = this.meta;
      const cell = this.cells[i];
      return [((cell % m.fw) * m.stride + m.stride / 2) / m.scale, (Math.floor(cell / m.fw) * m.stride + m.stride / 2) / m.scale];
    }
    // pt の点の特徴ベクトル（復元済み）。白紙なら半径 radius セル以内で最も近いセル。無ければ null
    vecAt(x, y, radius) {
      const m = this.meta;
      const r0 = radius === undefined ? 2 : radius;
      const { row, col } = this.cellRC(x, y);
      let best = -1;
      let bestD = Infinity;
      for (let dr = -r0; dr <= r0; dr++)
        for (let dc = -r0; dc <= r0; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || c < 0 || r >= m.fh || c >= m.fw) continue;
          const idx = this.pos[r * m.fw + c];
          if (idx < 0) continue;
          const d = dr * dr + dc * dc;
          if (d < bestD) {
            bestD = d;
            best = idx;
          }
        }
      if (best < 0) return null;
      const C = this.C;
      const v = new Float32Array(C);
      const base = best * C;
      const s = this.scale[best];
      for (let k = 0; k < C; k++) v[k] = this.feat[base + k] * s;
      return v;
    }
  }
  G.Features = Features;

  // 密な z（Float32Array [C, fh, fw]）と インクの印（Uint8Array [fh*fw]）から、疎な int8 の形にする
  G.quantize = function (z, C, fw, fh, ink) {
    const idx = [];
    for (let i = 0; i < fw * fh; i++) if (ink[i]) idx.push(i);
    const N = idx.length;
    const cells = Uint32Array.from(idx);
    const feat = new Int8Array(N * C);
    const scale = new Float32Array(N);
    const HW = fw * fh;
    for (let n = 0; n < N; n++) {
      const cell = cells[n];
      let mx = 0;
      for (let k = 0; k < C; k++) mx = Math.max(mx, Math.abs(z[k * HW + cell]));
      const s = mx > 0 ? mx / 127 : 1;
      scale[n] = s;
      for (let k = 0; k < C; k++) feat[n * C + k] = Math.max(-127, Math.min(127, Math.round(z[k * HW + cell] / s)));
    }
    return { cells, feat, scale };
  };

  /* ---------- GP ---------- */
  function solveLinear(A, b, n) {
    for (let i = 0; i < n; i++) {
      let piv = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      if (piv !== i) {
        const t = A[i];
        A[i] = A[piv];
        A[piv] = t;
        const tb = b[i];
        b[i] = b[piv];
        b[piv] = tb;
      }
      const pv = A[i][i] || 1e-8;
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / pv;
        if (f === 0) continue;
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / (A[i][i] || 1e-8);
    }
    return x;
  }
  function sqDist(a, b, C) {
    let s = 0;
    for (let k = 0; k < C; k++) {
      const d = a[k] - b[k];
      s += d * d;
    }
    return s;
  }

  // support: [{ x: Float32Array, y: 0|1 }]
  G.fit = function (support, kernel) {
    const k = kernel || G.DEFAULT_KERNEL;
    const M = support.length;
    if (!M) return null;
    const C = support[0].x.length;
    const twoLs2 = 2 * k.lengthscale * k.lengthscale;
    const A = [];
    for (let i = 0; i < M; i++) {
      A.push(new Float64Array(M));
      for (let j = 0; j < M; j++) A[i][j] = Math.exp(-sqDist(support[i].x, support[j].x, C) / twoLs2) + (i === j ? k.noise : 0);
    }
    const y = Float64Array.from(support, (s) => s.y);
    const alpha = solveLinear(A, y, M);
    return { X: support.map((s) => s.x), alpha, twoLs2, kernel: k, positives: support.filter((s) => s.y === 1).length, negatives: support.filter((s) => s.y === 0).length };
  };

  // ページの全セルを採点 → Float32Array(N) の確率
  G.score = function (model, fp) {
    const N = fp.N;
    const C = fp.C;
    const M = model.X.length;
    const out = new Float32Array(N);
    const { outA, outB } = model.kernel;
    for (let i = 0; i < N; i++) {
      const base = i * C;
      const s = fp.scale[i];
      let acc = 0;
      for (let m = 0; m < M; m++) {
        const x = model.X[m];
        let dot = 0;
        for (let k = 0; k < C; k++) dot += fp.feat[base + k] * x[k];
        const d2 = Math.max(0, 2 - 2 * s * dot);
        acc += Math.exp(-d2 / model.twoLs2) * model.alpha[m];
      }
      out[i] = 1 / (1 + Math.exp(-(outA * acc + outB)));
    }
    return out;
  };

  // 峰を拾う。scores: Float32Array(N)、size: { w, h }（pt）、exclude: [[cx, cy, w, h]]（既にある箱と退けた場所。pt）。
  // 近い候補どうし（箱の平均辺長 × 1.1 より近い）は点数の高い方だけ。戻り: [{ bbox:[x,y,w,h], score }]（pt・点数の降順）
  G.propose = function (fp, scores, size, exclude, opts) {
    const o = Object.assign({ threshold: 0.5, max: 200 }, opts || {});
    const pts = [];
    for (let i = 0; i < fp.N; i++) if (scores[i] > o.threshold) pts.push({ i, s: scores[i], c: fp.cellCenter(i) });
    pts.sort((a, b) => b.s - a.s);
    const minDist = 1.1 * ((size.w + size.h) / 2);
    const ex = (exclude || []).map((e) => [e[0] + e[2] / 2, e[1] + e[3] / 2]);
    const kept = [];
    for (const p of pts) {
      if (kept.length >= o.max) break;
      let ok = true;
      for (const e of ex) if (Math.hypot(p.c[0] - e[0], p.c[1] - e[1]) <= minDist) { ok = false; break; }
      if (!ok) continue;
      for (const k of kept) if (Math.hypot(p.c[0] - k.c[0], p.c[1] - k.c[1]) <= minDist) { ok = false; break; }
      if (ok) kept.push(p);
    }
    return kept.map((p) => ({ bbox: [p.c[0] - size.w / 2, p.c[1] - size.h / 2, size.w, size.h].map((v) => Math.round(v * 10) / 10), score: Math.round(p.s * 1000) / 1000 }));
  };

  /* ---------- ストアから手本と負例を集める ---------- */
  // features: Map(pageId → Features)。category: 探すカテゴリの id（葉でも粗い節でもよい。その節の下にあるカテゴリの箱が正例）
  // 戻り: { support, exemplars（正例の箱）, size（手本の bbox の平均。pt）, pages（手本のあるページ）, missing（特徴量の無いページの手本の数）}
  G.collect = function (store, palette, features, category) {
    const under = (cat) => cat === category || palette.categoryAncestors(cat).includes(category);
    const support = [];
    const exemplars = [];
    let missing = 0;
    let sw = 0;
    let sh = 0;
    for (const p of store.state.pickups) {
      if (p.kind !== 'box') continue;
      const fp = features.get(p.page);
      if (!fp) {
        if (under(p.category)) missing++;
        continue;
      }
      const v = fp.vecAt(p.bbox[0] + p.bbox[2] / 2, p.bbox[1] + p.bbox[3] / 2);
      if (!v) continue;
      const pos = under(p.category);
      support.push({ x: v, y: pos ? 1 : 0 });
      if (pos) {
        exemplars.push(p);
        sw += p.bbox[2];
        sh += p.bbox[3];
      }
    }
    for (const r of store.state.rejections || []) {
      if (r.category !== category) continue;
      const fp = features.get(r.page);
      if (!fp) continue;
      const v = fp.vecAt(r.x, r.y);
      if (v) support.push({ x: v, y: 0 });
    }
    const n = exemplars.length;
    return { support, exemplars, size: n ? { w: sw / n, h: sh / n } : null, pages: [...new Set(exemplars.map((e) => e.page))], missing };
  };

  // 1 ページ分の提案を作る。戻り: [{ bbox, score }]
  G.proposeOnPage = function (store, fp, pageId, model, size, category, opts) {
    const scores = G.score(model, fp);
    const exclude = store.state.pickups.filter((p) => p.kind === 'box' && p.page === pageId).map((p) => p.bbox);
    for (const r of store.state.rejections || []) if (r.page === pageId && r.category === category) exclude.push([r.x - size.w / 2, r.y - size.h / 2, size.w, size.h]);
    return G.propose(fp, scores, size, exclude, opts);
  };

  return G;
});
