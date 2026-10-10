/*
 * 拾いツール — 口「検出」の Worker（T-0646）。ONNX（GP の特徴抽出器）をタイルごとに回し、インクの近くのセルだけ int8 で返す。
 * 受けるもの:
 *   { type: 'init', ortUrl, wasmPaths, model: URL の文字列 | ArrayBuffer, ep: 'webgpu' | 'wasm' }      → { type: 'ready', ep } か { type: 'error', message }
 *   { type: 'tile', id, rgba: Uint8ClampedArray, width, height, ox, oy, keep: [x0, y0, x1, y1]（px。この範囲のセルだけ返す）, stride }
 *     → { type: 'tile', id, cells: Uint32Array（タイルの中のセル index: row * tw + col）, feat: Int8Array, scale: Float32Array, tw, th, ms }
 * 画像は 0〜1 の RGB。ink_normalize はモデルの中。
 *
 * ファイルは Worker として直接は読まない。画面（app/detector.js）が SMDetectorWorkerMain の文字列から Blob の Worker を作る
 * （Itera の上では相対パスの Worker が解決されないため）。
 */
self.SMDetectorWorkerMain = function () {
'use strict';
let sess = null;
let epUsed = null;
let C = 128;
const STRIDE = 8;

async function init(m) {
  importScripts(m.ortUrl);
  self.ort.env.wasm.wasmPaths = m.wasmPaths;
  self.ort.env.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  const model = typeof m.model === 'string' ? m.model : new Uint8Array(m.model);
  const tries = m.ep === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'];
  let lastErr = null;
  for (const ep of tries) {
    try {
      sess = await self.ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      epUsed = ep;
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no backend');
}

async function tile(m) {
  const t0 = performance.now();
  const { width: W, height: H, rgba } = m;
  const x = new Float32Array(3 * W * H);
  const HW = W * H;
  for (let i = 0; i < HW; i++) {
    x[i] = rgba[i * 4] / 255;
    x[HW + i] = rgba[i * 4 + 1] / 255;
    x[2 * HW + i] = rgba[i * 4 + 2] / 255;
  }
  const feed = {};
  feed[sess.inputNames[0]] = new self.ort.Tensor('float32', x, [1, 3, H, W]);
  const r = await sess.run(feed);
  const z = r.z.data;
  const th = r.z.dims[2];
  const tw = r.z.dims[3];
  C = r.z.dims[1];
  // インクの印（セルに暗い画素があるか）→ 1 セル膨らませる
  const ink0 = new Uint8Array(tw * th);
  for (let py = 0; py < H; py++) {
    const row = Math.min(th - 1, (py / STRIDE) | 0);
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 4;
      if (rgba[i] + rgba[i + 1] + rgba[i + 2] < 540) ink0[row * tw + Math.min(tw - 1, (px / STRIDE) | 0)] = 1;
    }
  }
  const ink = new Uint8Array(tw * th);
  for (let r2 = 0; r2 < th; r2++)
    for (let c = 0; c < tw; c++) {
      if (!ink0[r2 * tw + c]) continue;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r2 + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < th && cc < tw) ink[rr * tw + cc] = 1; }
    }
  // 返すセル: keep の範囲（px）の中にあるもの
  const [kx0, ky0, kx1, ky1] = m.keep;
  const idx = [];
  for (let r2 = 0; r2 < th; r2++)
    for (let c = 0; c < tw; c++) {
      const px = m.ox + c * STRIDE;
      const py = m.oy + r2 * STRIDE;
      if (px >= kx0 && px < kx1 && py >= ky0 && py < ky1 && ink[r2 * tw + c]) idx.push(r2 * tw + c);
    }
  const N = idx.length;
  const cells = Uint32Array.from(idx);
  const feat = new Int8Array(N * C);
  const scale = new Float32Array(N);
  const TW = tw * th;
  for (let n = 0; n < N; n++) {
    const cell = cells[n];
    let mx = 0;
    for (let k = 0; k < C; k++) mx = Math.max(mx, Math.abs(z[k * TW + cell]));
    const s = mx > 0 ? mx / 127 : 1;
    scale[n] = s;
    for (let k = 0; k < C; k++) feat[n * C + k] = Math.max(-127, Math.min(127, Math.round(z[k * TW + cell] / s)));
  }
  return { type: 'tile', id: m.id, cells, feat, scale, tw, th, channels: C, ms: Math.round(performance.now() - t0) };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      await init(m);
      self.postMessage({ type: 'ready', ep: epUsed, threads: self.ort.env.wasm.numThreads, gpu: !!self.navigator.gpu, coi: !!self.crossOriginIsolated, hc: self.navigator.hardwareConcurrency || null });
    } else if (m.type === 'tile') {
      const out = await tile(m);
      self.postMessage(out, [out.cells.buffer, out.feat.buffer, out.scale.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: (e && e.message) || String(e) });
  }
};
};
