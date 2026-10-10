/*
 * 拾いツール — 口「検出」（T-0646）。ページの特徴量を Worker で計算し、IndexedDB に置き、GP の提案を出す。
 *
 *   ensurePage(pageId)   そのページの特徴量を用意する（あれば IndexedDB から、無ければ pdf.js で 360 dpi のタイルを描いて Worker へ）
 *   status(pageId)       'none' | 'working' | 'ready' | 'error' と進み具合
 *   features             Map(pageId → SMGP.Features)
 *   propose(category, pageIds, opts)   手本（箱）から GP を当てはめ、ページごとの提案を返す（ストアには入れない。入れるのは画面）
 *
 * モデル（ONNX・3.7 MB）の URL は ctx.modelUrl（無ければ ../data/gp_features_v1.onnx）。onnxruntime-web は CDN。
 * 画面（app.js）とは ctx だけでつながる: { store, P, app, IDB, toast, onChange }
 */
(function () {
  'use strict';

  const ORT_VERSION = '1.22.0';
  const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/';
  const SCALE = 5; // 72 dpi に対する倍率（360 dpi。学習データと同じ）
  const TILE = 1024;
  const OVERLAP = 64;
  const STRIDE = 8;

  self.SMDetector = function (ctx) {
    const { store, P, app, IDB, toast } = ctx;
    const G = self.SMGP;
    const features = new Map(); // pageId → Features
    const state = new Map(); // pageId → { status, done, total, ms, error }
    const listeners = [];
    let worker = null;
    let ready = null;
    let ep = null;
    let queue = Promise.resolve();
    let pending = new Map(); // id → resolve
    let seq = 0;

    const notify = () => { for (const fn of listeners) fn(); };
    const modelUrl = () => ctx.modelUrl || new URL('../data/gp_features_v1.onnx', location.href).href;

    function ensureWorker() {
      if (ready) return ready;
      ready = new Promise((res, rej) => {
        if (!self.SMDetectorWorkerMain) return rej(new Error('detector_worker.js が読まれていない'));
        const src = '(' + self.SMDetectorWorkerMain.toString() + ')()';
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        worker.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'ready') { ep = m.ep; res(m); return; }
          if (m.type === 'error' && m.id === undefined) { rej(new Error(m.message)); return; }
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          if (m.type === 'error') p.reject(new Error(m.message));
          else p.resolve(m);
        };
        worker.onerror = (e) => rej(new Error(e.message || 'worker error'));
        worker.postMessage({ type: 'init', ortUrl: ORT_BASE + 'ort.webgpu.min.js', wasmPaths: ORT_BASE, modelUrl: modelUrl(), ep: ctx.ep || 'auto' });
      });
      ready.catch(() => { ready = null; });
      return ready;
    }
    function runTile(msg) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        worker.postMessage(Object.assign({ type: 'tile', id }, msg), [msg.rgba.buffer]);
      });
    }

    const key = (pageIndex) => 'feat:' + ((store.state.doc && store.state.doc.fingerprint) || 'nofp') + ':' + pageIndex;

    async function loadStored(pg) {
      try {
        const rec = await IDB.get(key(pg.index));
        if (!rec || !rec.meta) return null;
        return new G.Features(rec.meta, rec.cells, rec.feat, rec.scale);
      } catch (e) {
        return null;
      }
    }

    // ページ全体を 360 dpi のタイルで描いて Worker へ。疎な int8 を組み立てる
    async function compute(pg) {
      const ppg = app.pdfPages && app.pdfPages.get(pg.index);
      if (!ppg) throw new Error('p.' + pg.index + ' を描けない（PDF が開いていない）');
      const W = Math.round(pg.width * SCALE);
      const H = Math.round(pg.height * SCALE);
      const fw = Math.ceil(W / STRIDE);
      const fh = Math.ceil(H / STRIDE);
      const step = TILE - OVERLAP;
      const xs = [];
      for (let x = 0; x < W; x += step) { xs.push(x); if (x + TILE >= W) break; }
      const ys = [];
      for (let y = 0; y < H; y += step) { ys.push(y); if (y + TILE >= H) break; }
      const st = state.get(pg.id);
      st.total = xs.length * ys.length;
      st.done = 0;
      const t0 = performance.now();
      const parts = [];
      // ページは 1 回だけ描く（タイルごとに描くと pdf.js がページ全体を 35 回処理し、20 秒かかった）。大きすぎて描けなければタイルごと
      let full = null;
      try {
        const fc = document.createElement('canvas');
        fc.width = W;
        fc.height = H;
        const fg = fc.getContext('2d', { willReadFrequently: true });
        if (!fg) throw new Error('no 2d');
        fg.fillStyle = '#fff';
        fg.fillRect(0, 0, W, H);
        await ppg.render({ canvasContext: fg, viewport: ppg.getViewport({ scale: SCALE }) }).promise;
        if (fg.getImageData(0, 0, 1, 1).data[3] === 0) throw new Error('canvas too large');
        full = fg;
      } catch (e) {
        console.warn('[detector] full-page render failed, falling back to tiles', e);
        full = null;
      }
      const canvas = document.createElement('canvas');
      canvas.width = TILE;
      canvas.height = TILE;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      st.renderMs = Math.round(performance.now() - t0);
      for (let j = 0; j < ys.length; j++)
        for (let i = 0; i < xs.length; i++) {
          const ox = xs[i];
          const oy = ys[j];
          const tw = Math.min(TILE, W - ox);
          const th = Math.min(TILE, H - oy);
          let img;
          if (full) img = full.getImageData(ox, oy, tw, th);
          else {
            g.fillStyle = '#fff';
            g.fillRect(0, 0, TILE, TILE);
            await ppg.render({ canvasContext: g, viewport: ppg.getViewport({ scale: SCALE }), transform: [1, 0, 0, 1, -ox, -oy] }).promise;
            img = g.getImageData(0, 0, tw, th);
          }
          const keep = [i === 0 ? 0 : ox + OVERLAP / 2, j === 0 ? 0 : oy + OVERLAP / 2, i === xs.length - 1 ? W : ox + TILE - OVERLAP / 2, j === ys.length - 1 ? H : oy + TILE - OVERLAP / 2];
          const r = await runTile({ rgba: img.data, width: tw, height: th, ox, oy, keep, stride: STRIDE });
          parts.push({ r, ox, oy });
          st.done++;
          notify();
        }
      // 組み立て（タイルのセル index → ページのセル index）
      let N = 0;
      for (const p of parts) N += p.r.cells.length;
      const C = parts.length ? parts[0].r.channels : 128;
      const cellsArr = new Uint32Array(N);
      const feat = new Int8Array(N * C);
      const scale = new Float32Array(N);
      let n = 0;
      const tmp = [];
      for (const p of parts) {
        const col0 = p.ox / STRIDE;
        const row0 = p.oy / STRIDE;
        for (let k = 0; k < p.r.cells.length; k++) {
          const c = p.r.cells[k];
          tmp.push({ cell: (row0 + Math.floor(c / p.r.tw)) * fw + (col0 + (c % p.r.tw)), k, p });
        }
      }
      tmp.sort((a, b) => a.cell - b.cell);
      for (const t of tmp) {
        cellsArr[n] = t.cell;
        feat.set(t.p.r.feat.subarray(t.k * C, (t.k + 1) * C), n * C);
        scale[n] = t.p.r.scale[t.k];
        n++;
      }
      const meta = { page: pg.index, scale: SCALE, width: W, height: H, stride: STRIDE, fw, fh, channels: C, kernel: G.DEFAULT_KERNEL, cells: N, ep, ms: Math.round(performance.now() - t0), renderMs: st.renderMs, at: new Date().toISOString() };
      const rec = { meta, cells: cellsArr, feat, scale };
      try { await IDB.put(key(pg.index), rec); } catch (e) { console.warn('[detector] IDB put failed', e); }
      return new G.Features(meta, cellsArr, feat, scale);
    }

    function status(pageId) {
      return state.get(pageId) || { status: features.has(pageId) ? 'ready' : 'none' };
    }

    // 特徴量を用意する（直列）。戻り: Features
    function ensurePage(pageId) {
      if (features.has(pageId)) return Promise.resolve(features.get(pageId));
      const pg = store.page(pageId);
      if (!pg) return Promise.reject(new Error('ページが無い'));
      const cur = state.get(pageId);
      if (cur && cur.status === 'working' && cur.promise) return cur.promise;
      const st = { status: 'working', done: 0, total: 0 };
      state.set(pageId, st);
      notify();
      st.promise = queue = queue.then(async () => {
        try {
          let fp = await loadStored(pg);
          if (!fp) {
            await ensureWorker();
            fp = await compute(pg);
          }
          features.set(pageId, fp);
          st.status = 'ready';
          st.ms = fp.meta.ms;
          notify();
          return fp;
        } catch (e) {
          st.status = 'error';
          st.error = (e && e.message) || String(e);
          notify();
          throw e;
        }
      });
      return st.promise;
    }

    // 手本から提案を作る。戻り: { byPage: Map(pageId → [{bbox, score}]), model, collect }
    function propose(category, pageIds, opts) {
      const pal = P();
      const c = G.collect(store, pal, features, category);
      if (!c.exemplars.length || !c.size) return { byPage: new Map(), collect: c, model: null };
      const model = G.fit(c.support, G.DEFAULT_KERNEL);
      const byPage = new Map();
      for (const pid of pageIds) {
        const fp = features.get(pid);
        if (!fp) continue;
        byPage.set(pid, G.proposeOnPage(store, fp, pid, model, c.size, category, opts));
      }
      return { byPage, collect: c, model };
    }

    async function forgetAll() {
      features.clear();
      state.clear();
      notify();
    }

    return { ensurePage, status, features, propose, onChange: (fn) => listeners.push(fn), forgetAll, get ep() { return ep; }, SCALE, modelUrl };
  };
})();
