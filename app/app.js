/*
 * 拾いツール（試作）— 画面の本体。タブは 3 つ: 拾い・集計・パレット（パレットは app/palette.js）。
 *
 *   - 図面は利用者が開く PDF。PDF はこのブラウザの IndexedDB にだけ置き、作業（パレット・層・拾い）は localStorage に置く
 *   - 拾いの画面: モードは無い。道具は 1 列（選ぶ ／ 拾い: 箱・線 ／ 層: エリア矩形・多角形・ルート）
 *   - 図面の上は、画面の座標で canvas に描く（線は細いまま。塗りは透過）
 *   - エリア・ルートは、囲んだ／なぞった直後にモーダル（ラベルの木から選ぶ・新しく足す・規則・中身の下見）
 *   - 箱・線は、右の木で選んだカテゴリ（筆にインク）で続けて置く。候補が 2 つ以上なら札で選ぶ
 *   - 線とルートは骨（ノードと線分）を共有する。先に引いた方が骨を作り、後の方はなぞる
 * 言葉は docs/concepts.md。
 */
(function () {
  'use strict';

  /* ======================================================================
   * 道具箱
   * ====================================================================== */

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };
  const fmt = (x) => (x === null || x === undefined ? '' : String(SM.round(x, 2)));
  const alpha = (hex, a) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  };
  const CAT_COLORS = ['#0ea5e9', '#22c55e', '#ef4444', '#a855f7', '#f97316', '#14b8a6', '#ec4899', '#84cc16', '#6366f1', '#eab308'];
  const catColor = (id) => {
    let n = 0;
    for (let i = 0; i < String(id).length; i++) n = (n * 31 + String(id).charCodeAt(i)) >>> 0;
    return CAT_COLORS[n % CAT_COLORS.length];
  };
  const COLORS = { route: '#2563eb', noLength: '#ea580c', select: '#f59e0b', undecided: '#d97706', wire: '#16a34a', cross: '#dc2626', draft: '#2563eb' };
  // 当たりの広さ（画面の px。拡大率によらない）
  const PX = { node: 11, seg: 10, border: 9, snap: 12, box: 5, handle: 10 };
  const SCALES = [2, 4, 6];

  // 浮かせた要素の上の出来事を、図面に渡さない
  function shield(el) {
    for (const name of ['pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'wheel']) el.addEventListener(name, (e) => e.stopPropagation());
    return el;
  }

  const ENV = self.MetaOS ? 'itera' : 'browser';
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/';
  const PDFJS_CMAPS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/cmaps/';
  const STORAGE_KEY = 'hiroi-tool:job5';
  const OLD_KEY = 'sekisan-min:job4';

  const store = new SM.Store();
  const P = () => store.palette;

  const app = {
    pageId: null,
    view: { scale: 1, tx: 0, ty: 0 },
    views: new Map(),
    tool: 'select',
    currentCategory: 'cat-root',
    selection: null,
    objects: [],
    screen: 'pick',
    sumTab: 'table',
    viewId: null,
    custom: { rows: ['material'], cols: [], under: null },
    pageQuery: '',
    thumbs: new Map(),
    layers: { area: true, route: true, pickup: true, label: true },
    pdf: null,
    pdfPages: new Map(),
    renderScale: 0,
    serial: 0,
    collapsed: new Set(),
    query: '',
    floats: [],
  };

  const stage = $('#stage');
  const stack = $('#stack');
  const pdfCanvas = $('#pdf');
  const over = $('#over');
  const floatsEl = $('#floats');

  /* ======================================================================
   * 起動・保存・図面
   * ====================================================================== */

  // PDF そのものは IndexedDB に置く（localStorage には入らない大きさなので）。作業は localStorage
  const IDB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const rq = indexedDB.open('hiroi-tool', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('files');
        rq.onsuccess = () => {
          this.db = rq.result;
          res(this.db);
        };
        rq.onerror = () => rej(rq.error);
      });
    },
    async put(key, val) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put(val, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
    async get(key) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const rq = db.transaction('files').objectStore('files').get(key);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => rej(rq.error);
      });
    },
  };

  const pageIdOf = (i) => 'pg-' + String(i).padStart(3, '0');

  async function boot() {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    const saved = load();
    if (saved) store.replace(SMA.ensure(saved));
    store.onChange(onStoreChange);
    bindUI();
    setTool('select');
    let opened = false;
    if (store.state.doc && store.state.doc.pages) {
      try {
        const rec = await IDB.get('pdf');
        const d = store.state.doc;
        if (rec && (d.fingerprint ? rec.fingerprint === d.fingerprint : rec.pages === d.pages)) opened = await attachPdf(rec.bytes, rec.name, { quiet: true, stored: true });
      } catch (e) {
        console.warn(e);
      }
    }
    recompute();
    renderAll();
    if (!opened && saved && store.state.pages.length) toast('前回の作業を開いた。図面の PDF をもう一度選んでください', 4000);
  }

  /*
   * PDF を開く。いまの作業と同じ図面なら（指紋、無ければページ数で見る）つなぎ直す。
   * 違う図面なら、パレットだけ残して新しく始める（確かめてから）。返すもの: 開けたか
   */
  async function attachPdf(bytes, name, opts) {
    const o = opts || {};
    toast('PDF を読んでいます…', 0);
    let doc;
    try {
      doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), cMapUrl: PDFJS_CMAPS, cMapPacked: true }).promise;
    } catch (e) {
      console.error(e);
      toast('PDF を読めなかった: ' + e.message, 6000);
      return false;
    }
    const fp = (doc.fingerprints && doc.fingerprints[0]) || doc.fingerprint || '';
    const n = doc.numPages;
    const cur = store.state.doc || {};
    const has = store.state.pages.length > 0;
    const same = has && (cur.fingerprint ? cur.fingerprint === fp : cur.pages === n);
    if (has && !same && !o.quiet) {
      const work = store.state.pickups.length + store.state.routes.length + store.state.areas.length;
      if (work) {
        const ok = await confirmBox('違う図面です', '「' + name + '」（' + n + ' ページ）で新しく始めます。いまの層と拾い（' + work + ' 件）は消えます。パレットは残ります。必要なら、先に「書き出す」で作業を保存してください。', '新しく始める');
        if (!ok) {
          doc.destroy();
          toast('やめた', 1200);
          return false;
        }
      }
    }
    const sizes = [];
    const pages = new Map();
    for (let i = 1; i <= n; i++) {
      const p = await doc.getPage(i);
      pages.set(i, p);
      const vp = p.getViewport({ scale: 1 });
      sizes.push({ index: i, width: SM.round(vp.width, 2), height: SM.round(vp.height, 2) });
    }
    if (app.pdf) app.pdf.destroy();
    app.pdf = doc;
    app.pdfPages = pages;
    app.thumbs = new Map();
    const sample = !!SMFixture.SAMPLE_FINGERPRINTS && SMFixture.SAMPLE_FINGERPRINTS.includes(fp);
    const titleOf = (i) => {
      const f = sample ? SMFixture.PAGES.find((x) => x.index === i) : null;
      return f ? f.title : 'p.' + i;
    };
    const docInfo = { name, pages: n, fingerprint: fp, sample };
    if (same) {
      // つなぎ直す。足りないページを足す（履歴には積まない）
      const st = store.state;
      st.doc = docInfo;
      for (const s of sizes) if (!st.pages.some((p) => p.index === s.index)) st.pages.push({ id: pageIdOf(s.index), index: s.index, title: titleOf(s.index), width: s.width, height: s.height });
      st.pages.sort((a, b) => a.index - b.index);
      save();
    } else {
      const old = store.state;
      const st = SM.emptyState(SM.clone(old.palette));
      st.seq.lb = old.seq.lb || 0;
      st.seq.ct = old.seq.ct || 0;
      st.doc = docInfo;
      st.pages = sizes.map((s) => ({ id: pageIdOf(s.index), index: s.index, title: titleOf(s.index), width: s.width, height: s.height }));
      SMA.ensure(st);
      store.replace(st);
      app.views = new Map();
    }
    if (!o.stored) {
      try {
        await IDB.put('pdf', { name, fingerprint: fp, pages: n, bytes });
      } catch (e) {
        console.warn(e);
        toast('PDF をブラウザに残せなかった（次に開くとき、もう一度選んでください）', 4000);
      }
    }
    app.pageId = null;
    // 拾うページの印が無ければ、図面解析のタブから始める
    setScreen(store.state.pages.some((p) => p.pick === true) ? 'pick' : 'analyze');
    const withWork = store.state.pages.find((p) => store.pickupsOn(p.id).length || store.areasOn(p.id).some((a) => !isFull(a)));
    setPage((withWork || store.state.pages[0]).id);
    recompute();
    renderAll();
    toast((same ? 'つなぎ直した: ' : '開いた: ') + name + '（' + n + ' ページ）', 2500);
    return true;
  }

  async function openPdfFile(file) {
    if (!file) return;
    const bytes = await file.arrayBuffer();
    await attachPdf(bytes, file.name);
  }

  function confirmBox(title, text, okLabel) {
    const m = openModal({ title, width: 480, dismiss: true, body: h('div', {}, text), actions: ['spacer', { label: 'やめる', id: 'cancel' }, { label: okLabel || 'はい', primary: true, id: 'ok' }] });
    return m.result.then((v) => v === 'ok');
  }

  function onStoreChange(label) {
    save();
    recompute();
    renderAll();
    if (label) setHintOnce(label);
  }
  function recompute() {
    app.objects = SM.derive.allObjects(store, P());
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store.state));
    } catch (e) {
      /* 保存できなくても動く */
    }
  }
  function load() {
    try {
      const t = localStorage.getItem(STORAGE_KEY);
      if (t) return SM.migrate(JSON.parse(t));
      // 試作 M3 までの保存（サンプル図面の 76 ページの PDF の上の作業）
      const t4 = localStorage.getItem(OLD_KEY);
      if (t4) return SM.migrate(JSON.parse(t4), { doc4: { name: 'source.pdf', pages: 76 } });
      return null;
    } catch (e) {
      return null;
    }
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    if (ms !== 0) toastTimer = setTimeout(() => el.classList.remove('on'), ms || 1800);
  }
  let hintTimer = null;
  function setHintOnce(text) {
    clearTimeout(hintTimer);
    $('#hint').textContent = text;
    hintTimer = setTimeout(renderHint, 1500);
  }

  // 編集。失敗したら知らせて null
  function edit(label, fn) {
    try {
      return store.commit(label, (st, S) => fn(S, st));
    } catch (e) {
      console.error(e);
      toast('できなかった: ' + e.message, 4000);
      return null;
    }
  }

  /* ======================================================================
   * ページ・見え方
   * ====================================================================== */

  const page = () => store.page(app.pageId);

  function setPage(id) {
    if (app.pageId === id) return;
    if (curTool && curTool.cancel) curTool.cancel();
    clearFloats();
    if (app.pageId) app.views.set(app.pageId, Object.assign({}, app.view));
    app.pageId = id;
    app.selection = null;
    app.renderScale = 0;
    app.serial++;
    const pg = page();
    stack.style.width = pg.width + 'px';
    stack.style.height = pg.height + 'px';
    const saved = app.views.get(id);
    if (saved) app.view = Object.assign({}, saved);
    else fit();
    pdfCanvas.width = 1;
    pdfCanvas.height = 1;
    renderPdf(SCALES[0], app.serial).then(() => refine());
    renderAll();
  }

  const viewSize = () => ({ w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) });
  const toScreen = (x, y) => [app.view.tx + x * app.view.scale, app.view.ty + y * app.view.scale];
  const toPage = (sx, sy) => [(sx - app.view.tx) / app.view.scale, (sy - app.view.ty) / app.view.scale];
  const tol = (px) => px / app.view.scale;

  function applyView() {
    const k = app.renderScale ? app.view.scale / app.renderScale : app.view.scale;
    stack.style.transform = `translate(${app.view.tx}px,${app.view.ty}px) scale(${k})`;
    $('#zoom').textContent = Math.round((app.view.scale / (96 / 72)) * 100) + '%';
    placeFloats();
    drawOverlay();
  }
  function fit() {
    const pg = page();
    if (!pg) return;
    // 拾いの画面が隠れている間は大きさが測れない。見えたときに合わせ直す
    if (stage.clientWidth < 10) {
      app.needFit = true;
      return;
    }
    app.needFit = false;
    const v = viewSize();
    const m = 24;
    const s = Math.min((v.w - m * 2) / pg.width, (v.h - m * 2) / pg.height);
    app.view.scale = Math.max(0.05, s);
    app.view.tx = (v.w - pg.width * app.view.scale) / 2;
    app.view.ty = (v.h - pg.height * app.view.scale) / 2;
    applyView();
    refine();
  }
  function zoomAt(sx, sy, factor) {
    const old = app.view.scale;
    const next = Math.max(0.05, Math.min(40, old * factor));
    const r = next / old;
    app.view.tx = sx - (sx - app.view.tx) * r;
    app.view.ty = sy - (sy - app.view.ty) * r;
    app.view.scale = next;
    applyView();
    refine();
  }
  function zoomBy(f) {
    const v = viewSize();
    zoomAt(v.w / 2, v.h / 2, f);
  }
  // ページの上の場所を、画面の中央に
  function showPlace(w) {
    const v = viewSize();
    let cx, cy;
    if (w.bbox) {
      cx = w.bbox[0] + w.bbox[2] / 2;
      cy = w.bbox[1] + w.bbox[3] / 2;
      app.view.scale = Math.max(app.view.scale, 3);
    } else {
      cx = w.x;
      cy = w.y;
      app.view.scale = Math.max(app.view.scale, 3);
    }
    app.view.tx = v.w / 2 - cx * app.view.scale;
    app.view.ty = v.h / 2 - cy * app.view.scale;
    applyView();
    refine();
  }

  let refineTimer = null;
  function refine() {
    clearTimeout(refineTimer);
    refineTimer = setTimeout(() => {
      const need = app.view.scale * (window.devicePixelRatio || 1);
      let want = SCALES[0];
      for (const s of SCALES) if (need > want * 1.15) want = s;
      if (want > app.renderScale) renderPdf(want, app.serial);
    }, 260);
  }

  let rendering = null;
  async function renderPdf(scale, serial) {
    const pg = page();
    const p = pg && app.pdfPages.get(pg.index);
    if (!p) return;
    let sc = scale;
    if (pg.width * pg.height * sc * sc > 40e6) sc = Math.sqrt(40e6 / (pg.width * pg.height));
    if (sc <= app.renderScale) return;
    if (rendering) await rendering;
    if (serial !== app.serial) return;
    rendering = (async () => {
      const vp = p.getViewport({ scale: sc });
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      const g = off.getContext('2d', { alpha: false });
      g.fillStyle = '#fff';
      g.fillRect(0, 0, off.width, off.height);
      await p.render({ canvasContext: g, viewport: vp }).promise;
      if (serial !== app.serial) return;
      pdfCanvas.width = off.width;
      pdfCanvas.height = off.height;
      pdfCanvas.style.width = pg.width + 'px';
      pdfCanvas.style.height = pg.height + 'px';
      pdfCanvas.getContext('2d').drawImage(off, 0, 0);
      pdfCanvas.style.width = '';
      pdfCanvas.style.height = '';
      app.renderScale = sc;
      applyView();
    })();
    try {
      await rendering;
    } finally {
      rendering = null;
    }
  }

  function resize() {
    const v = viewSize();
    const dpr = window.devicePixelRatio || 1;
    over.width = Math.round(v.w * dpr);
    over.height = Math.round(v.h * dpr);
    over.style.width = v.w + 'px';
    over.style.height = v.h + 'px';
    drawOverlay();
  }

  /* ---- 浮かせる要素 ---- */
  function float(el, x, y, opts) {
    const f = Object.assign({ el, x, y, dx: 0, dy: 0 }, opts || {});
    el.classList.add('float');
    if (f.dock) el.classList.add('dock');
    floatsEl.append(el);
    app.floats.push(f);
    placeFloats();
    return () => {
      el.remove();
      app.floats = app.floats.filter((z) => z !== f);
    };
  }
  function clearFloats() {
    for (const f of app.floats) f.el.remove();
    app.floats = [];
  }
  function placeFloats() {
    for (const f of app.floats) {
      const [sx, sy] = toScreen(f.x, f.y);
      f.el.style.left = Math.round(sx + f.dx) + 'px';
      f.el.style.top = Math.round(sy + f.dy) + 'px';
    }
  }

  /* ======================================================================
   * 描く（画面の座標で canvas に）
   * ====================================================================== */

  const isFull = (a) => {
    const pg = page();
    return a.shape.type === 'rect' && a.shape.points[0][0] <= 0.5 && a.shape.points[0][1] <= 0.5 && a.shape.points[1][0] >= pg.width - 0.5 && a.shape.points[1][1] >= pg.height - 0.5;
  };
  // 選択は 1 つ、または複数（{ kind: 'multi', items: [{ kind, id }] }）
  const isSel = (kind, id) => {
    const s = app.selection;
    if (!s) return false;
    if (s.kind === 'multi') return s.items.some((x) => x.kind === kind && x.id === id);
    return s.kind === kind && s.id === id;
  };

  function pathOf(g, pts, close) {
    g.beginPath();
    pts.forEach((p, i) => {
      const [sx, sy] = toScreen(p[0], p[1]);
      if (i === 0) g.moveTo(sx, sy);
      else g.lineTo(sx, sy);
    });
    if (close) g.closePath();
  }
  // 線分を、骨の上に中心を合わせた帯として描く（ルート）
  function band(g, pts, width, color) {
    g.save();
    pathOf(g, pts, false);
    g.lineWidth = width;
    g.strokeStyle = color;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.stroke();
    g.restore();
  }
  function tag(g, text, sx, sy, color, opts) {
    const o = opts || {};
    g.save();
    g.font = (o.bold ? '600 ' : '') + '11px system-ui, sans-serif';
    const w = Math.ceil(g.measureText(text).width) + 8;
    const hh = 16;
    const x = o.center ? sx - w / 2 : sx;
    const y = o.above ? sy - hh : sy;
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, hh, 3);
    else g.rect(x, y, w, hh);
    g.fill();
    g.stroke();
    g.fillStyle = o.text || '#0f172a';
    g.textBaseline = 'middle';
    g.fillText(text, x + 4, y + hh / 2 + 0.5);
    g.restore();
  }
  function handles(g, pts) {
    g.save();
    g.fillStyle = '#fff';
    g.strokeStyle = '#0f172a';
    g.lineWidth = 1;
    for (const p of pts) {
      const [sx, sy] = toScreen(p[0], p[1]);
      g.fillRect(sx - 4, sy - 4, 8, 8);
      g.strokeRect(sx - 4, sy - 4, 8, 8);
    }
    g.restore();
  }
  function crossMark(g, x, y) {
    const [sx, sy] = toScreen(x, y);
    g.save();
    g.fillStyle = '#fff';
    g.strokeStyle = COLORS.cross;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(sx, sy, 7, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(sx - 3.5, sy - 3.5);
    g.lineTo(sx + 3.5, sy + 3.5);
    g.moveTo(sx + 3.5, sy - 3.5);
    g.lineTo(sx - 3.5, sy + 3.5);
    g.stroke();
    g.restore();
  }
  function midpoint(pts) {
    let total = 0;
    for (let i = 0; i + 1 < pts.length; i++) total += SM.geom.dist(pts[i], pts[i + 1]);
    let acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = SM.geom.dist(pts[i], pts[i + 1]);
      if (acc + d >= total / 2 && d > 0) {
        const t = (total / 2 - acc) / d;
        return [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])];
      }
      acc += d;
    }
    return pts[0];
  }
  const lengthText = (s) => {
    const parts = [];
    if (s.length_h !== null) parts.push('平 ' + fmt(s.length_h));
    if (s.length_v !== null) parts.push('立 ' + fmt(s.length_v));
    return parts.length ? parts.join(' / ') : '長さ未入力';
  };

  function drawOverlay() {
    const dpr = window.devicePixelRatio || 1;
    const g = over.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = viewSize();
    g.clearRect(0, 0, v.w, v.h);
    const pg = page();
    if (!pg) return;
    const pal = P();
    const lay = app.layers;

    // エリア
    if (lay.area) {
      for (const a of store.areasOn(pg.id)) {
        if (isFull(a)) continue;
        const l = pal.label(a.label);
        const color = l ? l.color : '#64748b';
        const poly = SM.geom.shapePolygon(a.shape);
        const sel = isSel('area', a.id);
        g.save();
        pathOf(g, poly, true);
        g.fillStyle = hslAlpha(color, sel ? 0.18 : 0.07);
        g.fill();
        g.lineWidth = sel ? 2.5 : 1;
        g.strokeStyle = sel ? COLORS.select : hslAlpha(color, 0.6);
        g.stroke();
        g.restore();
        if (lay.label) {
          const xs = poly.map((p) => p[0]);
          const ys = poly.map((p) => p[1]);
          const [sx, sy] = toScreen(Math.min(...xs), Math.min(...ys));
          tag(g, l ? pal.labelPath(l.id).join(' / ') : '?', sx, sy, color, { above: true, bold: sel });
        }
        if (sel) handles(g, poly);
      }
    }

    // 骨とルート
    const wire = new Set();
    if (app.selection && app.selection.kind === 'pickup') {
      const p = store.pickup(app.selection.id);
      if (p && p.kind === 'line') for (const s of p.path) wire.add(s);
    }
    if (lay.route) {
      const segs = store.segmentsOn(pg.id).filter((s) => !s.riser);
      // ルート: どれも骨の上に中心を合わせて描く（脇へずらさない）。
      // ラベルルートは木ごとに太さを変えた帯（このページで使っている木の順に太い → 細い）。太いものから先に描くので、
      // 同じ線分に別の木のルートが重なると入れ子の帯になる。長さルートはそのさらに外側の薄い帯。
      // 骨より先に描く（骨の細い線が帯の上に見える）
      const roots = pal.labelRoots().map((r) => r.id);
      const routesHere = store.routesOn(pg.id);
      const usedRoots = [...new Set(routesHere.filter((r) => r.label).map((r) => pal.labelRoot(r.label)))].sort((a, b) => roots.indexOf(a) - roots.indexOf(b));
      const rankOf = (r) => usedRoots.indexOf(pal.labelRoot(r.label));
      const labelWidth = (r) => 7 + 5 * (usedRoots.length - 1 - rankOf(r));
      const lengthWidth = 10 + 5 * usedRoots.length;
      const widthOf = (r) => (r.label ? labelWidth(r) : lengthWidth);
      const order = routesHere.slice().sort((a, b) => widthOf(b) - widthOf(a));
      for (const r of order) {
        const sel = isSel('route', r.id);
        const rsegs = r.segments.map((id) => store.segment(id)).filter((s) => s && !s.riser);
        if (!r.label) {
          for (const s of rsegs) band(g, s.points, lengthWidth + (sel ? 2 : 0), sel ? alpha(COLORS.select, 0.55) : alpha(COLORS.route, 0.2));
        } else {
          const l = pal.label(r.label);
          for (const s of rsegs) band(g, s.points, labelWidth(r), sel ? alpha(COLORS.select, 0.75) : hslAlpha(l ? l.color : '#999', 0.55));
        }
      }
      // 骨: ルートの無い線分は細い点線、あれば薄い下地
      for (const s of segs) {
        const sel = isSel('segment', s.id);
        const covered = store.routesCovering(s.id).length > 0;
        g.save();
        if (wire.has(s.id)) {
          pathOf(g, s.points, false);
          g.lineWidth = 14;
          g.strokeStyle = alpha(COLORS.select, 0.22);
          g.lineCap = 'round';
          g.lineJoin = 'round';
          g.stroke();
        }
        pathOf(g, s.points, false);
        g.lineWidth = sel ? 3 : covered ? 1 : 1.5;
        g.strokeStyle = sel ? COLORS.select : alpha('#64748b', covered ? 0.35 : 0.7);
        g.lineJoin = 'round';
        g.lineCap = 'round';
        if (!covered) g.setLineDash([6, 4]);
        g.stroke();
        g.restore();
        if (sel && s.points.length > 2) handles(g, s.points.slice(1, -1));
        // 境を跨ぐ所
        if (lay.area) {
          const info = SM.derive.labelsOfSegment(store, pal, s);
          for (const aid of info.straddles) {
            const a = store.area(aid);
            if (!a) continue;
            for (let i = 0; i + 1 < s.points.length; i++) {
              const ia = SM.geom.shapeContains(a.shape, s.points[i]);
              const ib = SM.geom.shapeContains(a.shape, s.points[i + 1]);
              if (ia !== ib) crossMark(g, (s.points[i][0] + s.points[i + 1][0]) / 2, (s.points[i][1] + s.points[i + 1][1]) / 2);
            }
          }
        }
      }
      for (const r of routesHere) {
        const sel = isSel('route', r.id);
        if (lay.label) {
          const pts = store.pathPoints(r.segments.filter((id) => { const s = store.segment(id); return s && !s.riser; }));
          if (pts.length >= 2) {
            const mid = midpoint(pts);
            const [sx, sy] = toScreen(mid[0], mid[1]);
            if (!r.label) tag(g, lengthText(r), sx, sy - 8, COLORS.route, { center: true, above: true, bold: sel });
            else {
              const k = rankOf(r);
              const l = pal.label(r.label);
              tag(g, l ? pal.labelPath(l.id).slice(-1)[0] : '?', sx, sy + 10 + k * 16, l ? l.color : '#999', { center: true, bold: sel });
            }
          }
        }
      }
      // 立の印（▲▼）と、その長さ
      for (const n of store.nodesOn(pg.id)) {
        if (!n.level) continue;
        const [sx, sy] = toScreen(...riserPos(n));
        const sel = isSel('node', n.id);
        const d = n.level === '上' ? -1 : 1;
        g.save();
        g.fillStyle = sel ? COLORS.select : COLORS.route;
        g.beginPath();
        g.moveTo(sx, sy + d * 6);
        g.lineTo(sx - 6, sy - d * 5);
        g.lineTo(sx + 6, sy - d * 5);
        g.closePath();
        g.fill();
        g.restore();
        if (lay.label) {
          const rs = store.segmentsAt(n.id).find((s) => s.riser);
          const lr = rs ? store.routesCovering(rs.id).find((r) => !r.label && SM.hasLen(r)) : null;
          tag(g, '立 ' + (lr ? fmt(lr.length_v !== null ? lr.length_v : lr.length_h) : '—'), sx + 9, sy - 8, COLORS.route, { bold: sel });
        }
      }
      for (const n of store.nodesOn(pg.id)) {
        if (n.level) continue;
        const [sx, sy] = toScreen(n.x, n.y);
        const sel = isSel('node', n.id);
        g.save();
        g.lineWidth = sel ? 2.5 : 1.2;
        g.strokeStyle = sel ? COLORS.select : alpha('#64748b', 0.7);
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(sx, sy, sel ? 4.5 : 3, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.restore();
      }
      // 選んだ線の余長
      if (lay.label && app.selection && app.selection.kind === 'pickup') {
        const p = store.pickup(app.selection.id);
        if (p && p.kind === 'line') {
          for (const [nid, len] of Object.entries(p.additions || {})) {
            const n = store.node(nid);
            if (!n || n.page !== pg.id) continue;
            const [sx, sy] = toScreen(n.x, n.y);
            tag(g, '＋' + fmt(len) + ' m', sx + 8, sy - 24, COLORS.wire, { bold: true });
          }
        }
      }
    }

    // 拾い
    if (lay.pickup) {
      for (const p of store.pickupsOn(pg.id)) {
        const objs = app.objects.filter((o) => o.pickup === p.id);
        const first = objs[0];
        const undecided = !first || !first.leaf;
        const flagged = objs.some((o) => o.flags.length);
        const sel = isSel('pickup', p.id);
        if (p.kind === 'box') {
          const leaf = first && first.leaf ? first.leaf : p.category;
          const color = undecided ? COLORS.undecided : catColor(leaf);
          const box = p.bbox;
          const [sx, sy] = toScreen(box[0], box[1]);
          const w = box[2] * app.view.scale;
          const hh = box[3] * app.view.scale;
          g.save();
          g.fillStyle = alpha(color, sel ? 0.35 : 0.22);
          g.strokeStyle = sel ? COLORS.select : color;
          g.lineWidth = sel ? 2.5 : 2;
          if (undecided) g.setLineDash([4, 3]);
          g.fillRect(sx, sy, w, hh);
          g.strokeRect(sx, sy, w, hh);
          g.restore();
          if (lay.label && (app.view.scale > 1.2 || sel)) {
            let text = leaf === 'cat-root' ? '未指定' : pal.category(leaf).name;
            if (undecided) text += ' ?';
            else if (flagged) text += ' !';
            tag(g, text, sx, sy - 2, color, { above: true, bold: sel });
          }
          if (sel) handles(g, [[box[0], box[1]], [box[0] + box[2], box[1]], [box[0] + box[2], box[1] + box[3]], [box[0], box[1] + box[3]]]);
        } else {
          // 線: 道の上に緑の帯。端に丸
          const color = undecided ? COLORS.undecided : COLORS.wire;
          for (const sid of p.path) {
            const s = store.segment(sid);
            if (!s || s.page !== pg.id) continue;
            // 線（拾い）は、ルートの上に細めで濃い線
            g.save();
            pathOf(g, s.points, false);
            g.lineWidth = sel ? 4 : 3;
            g.strokeStyle = sel ? COLORS.select : alpha(color, 0.9);
            g.lineCap = 'round';
            g.lineJoin = 'round';
            g.stroke();
            g.restore();
          }
          const ends = store.lineEnds(p).map((id) => store.node(id)).filter((n) => n && n.page === pg.id);
          for (const n of ends) {
            const [sx, sy] = toScreen(n.x, n.y);
            g.save();
            g.fillStyle = '#fff';
            g.strokeStyle = sel ? COLORS.select : color;
            g.lineWidth = 2;
            g.beginPath();
            g.arc(sx, sy, 6, 0, Math.PI * 2);
            g.fill();
            g.stroke();
            g.restore();
          }
          const first2 = store.segment(p.path[0]);
          if (lay.label && first2 && first2.page === pg.id) {
            const cat = pal.category(p.category);
            const [sx, sy] = toScreen(first2.points[0][0], first2.points[0][1]);
            tag(g, (p.name ? p.name + ' ' : '') + (cat ? cat.name : '') + (undecided ? ' ?' : flagged ? ' !' : ''), sx + 8, sy + 8, color, { bold: sel });
          }
        }
      }
    }

    if (curTool && curTool.draw) curTool.draw(g);
  }
  // hsl() の色に透明度を付ける
  function hslAlpha(c, a) {
    if (c.startsWith('hsl(')) return c.replace(/\)$/, ' / ' + a + ')');
    return alpha(c, a);
  }

  /* ======================================================================
   * 当たり判定
   * ====================================================================== */

  // 立の印の、図の上の位置（元のノードから上下に 12 px）
  const riserPos = (n) => [n.x, n.y + (n.level === '上' ? -1 : 1) * tol(12)];

  /*
   * その場所にあるものを、手前から順に返す（決定 44）: 拾い（箱・線）→ 層（ルート）→ 骨（立の印・ノード・線分）→ エリア
   */
  function hits(x, y) {
    const pg = page();
    if (!pg) return [];
    const out = [];
    const lay = app.layers;
    const pt = [x, y];
    // 線分（近い順）。立の線分は点なので除く
    const near = [];
    if (lay.route) {
      for (const s of store.segmentsOn(pg.id)) {
        if (s.riser) continue;
        const c = SM.geom.closestOnPolyline(pt, s.points);
        if (c.d <= tol(PX.seg)) near.push({ kind: 'segment', id: s.id, how: 'line', d: c.d, at: c });
      }
      near.sort((a, b) => a.d - b.d);
    }
    if (lay.pickup) {
      const ps = store.pickupsOn(pg.id);
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        if (p.kind !== 'box') continue;
        const t = tol(PX.box);
        if (x >= p.bbox[0] - t && x <= p.bbox[0] + p.bbox[2] + t && y >= p.bbox[1] - t && y <= p.bbox[1] + p.bbox[3] + t) out.push({ kind: 'pickup', id: p.id, how: 'box' });
      }
      const seen = new Set();
      for (const n of near) for (const p of store.pickupsThrough(n.id)) if (!seen.has(p.id)) { seen.add(p.id); out.push({ kind: 'pickup', id: p.id, how: 'wire' }); }
    }
    if (lay.route) {
      // ルート: 近い線分を覆うもの（狭い順）
      const seen = new Set();
      for (const n of near) for (const r of store.routesCovering(n.id).sort((a, b) => a.segments.length - b.segments.length)) if (!seen.has(r.id)) { seen.add(r.id); out.push({ kind: 'route', id: r.id, how: 'route' }); }
      // 骨: 立の印 → ノード → 線分
      for (const n of store.nodesOn(pg.id)) {
        if (!n.level) continue;
        if (SM.geom.dist(riserPos(n), pt) <= tol(PX.node + 1)) out.push({ kind: 'node', id: n.id, how: 'riser' });
      }
      for (const n of store.nodesOn(pg.id)) if (!n.level && SM.geom.dist([n.x, n.y], pt) <= tol(PX.node)) out.push({ kind: 'node', id: n.id, how: 'node' });
      out.push(...near);
    }
    if (lay.area) {
      const inside = [];
      for (const a of store.areasOn(pg.id)) {
        if (isFull(a)) continue;
        const poly = SM.geom.shapePolygon(a.shape);
        const c = SM.geom.closestOnPolyline(pt, poly.concat([poly[0]]));
        if (c.d <= tol(PX.border)) out.push({ kind: 'area', id: a.id, how: 'border' });
        else if (SM.geom.shapeContains(a.shape, pt)) {
          const xs = poly.map((p) => p[0]);
          const ys = poly.map((p) => p[1]);
          inside.push({ kind: 'area', id: a.id, how: 'inside', size: (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) });
        }
      }
      inside.sort((a, b) => a.size - b.size);
      out.push(...inside);
    }
    return out;
  }

  // 矩形の中に全部が入っているもの（範囲選択）。順は 拾い → ルート → エリア → 骨
  function itemsInRect(x0, y0, x1, y1) {
    const pg = page();
    if (!pg) return [];
    const inside = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
    const out = [];
    const lay = app.layers;
    if (lay.pickup) {
      for (const p of store.pickupsOn(pg.id)) {
        if (p.kind === 'box') {
          if (inside([p.bbox[0], p.bbox[1]]) && inside([p.bbox[0] + p.bbox[2], p.bbox[1] + p.bbox[3]])) out.push({ kind: 'pickup', id: p.id });
        } else if (p.path.length && p.path.every((sid) => { const s = store.segment(sid); return s && s.points.every(inside); })) out.push({ kind: 'pickup', id: p.id });
      }
    }
    if (lay.route) for (const r of store.routesOn(pg.id)) if (r.segments.every((sid) => { const s = store.segment(sid); return s && s.points.every(inside); })) out.push({ kind: 'route', id: r.id });
    if (lay.area) for (const a of store.areasOn(pg.id)) if (!isFull(a) && SM.geom.shapePolygon(a.shape).every(inside)) out.push({ kind: 'area', id: a.id });
    if (lay.route) {
      for (const s of store.segmentsOn(pg.id)) if (!s.riser && s.points.every(inside)) out.push({ kind: 'segment', id: s.id });
      for (const n of store.nodesOn(pg.id)) if (!n.level && inside([n.x, n.y])) out.push({ kind: 'node', id: n.id });
    }
    return out;
  }

  /* ======================================================================
   * 道具
   * ====================================================================== */

  const TOOLS = [
    { id: 'select', name: '選ぶ', key: 'V', group: 'common', hint: '押して選ぶ（同じ場所をもう一度押すと 1 つ下。右ボタンで一覧）。空いた所をドラッグで範囲選択。線分の上で右クリック →「ここにノードを足す」。ドラッグで動かす（ノード・箱・角。エリア・線・ルート・線分は選んでから引くと動く。エリアの角・線分の途中の角を引くと形が変わる）。パンは Space＋ドラッグかホイール。Delete で消す' },
    { id: 'box', name: '箱', key: 'B', group: 'pickup', hint: '引いて囲う。押すだけなら、直前と同じ大きさで置く。カテゴリは右の木で選ぶ' },
    { id: 'line', name: '線', key: 'W', group: 'pickup', hint: '押して骨をたどる（既存のノードに吸着。線分の途中から分けるなら右クリックでノードを足す。無ければ骨が出来る）。水平・垂直に揃う（Alt で自由）。Shift で曲がり角。↑↓ で立。Enter か二度押しで置く。長さはルートが与える' },
    { id: 'area-rect', name: 'エリア（矩形）', key: 'R', group: 'layer', hint: '引いて囲む。囲むと、この範囲が何かを決める画面が開く' },
    { id: 'area-poly', name: 'エリア（多角形）', key: 'P', group: 'layer', hint: '押して角を打つ。最初の角を押すか、二度押しか、Enter で閉じる。Backspace で 1 つ戻る' },
    { id: 'route', name: 'ルート', key: 'L', group: 'layer', hint: '線をなぞる（骨をたどる。無ければ骨が出来る）。終えると、このルートが何か（ラベル・規則・長さ）を決める画面が開く。↑↓ で立。水平・垂直に揃う（Alt で自由）' },
  ];
  let curTool = null;
  let curToolId = 'select';
  let lastBox = null;
  let chips = null;

  const api = {
    page,
    toScreen,
    toPage,
    tol,
    hits,
    redraw: drawOverlay,
    cursor: (c) => (stage.style.cursor = c || ''),
    float,
    edit,
    toast,
    select: (sel) => {
      app.selection = sel;
      renderAll();
    },
  };

  function setTool(id) {
    if (curTool && curTool.cancel) curTool.cancel();
    if (curTool && curTool.dispose) curTool.dispose();
    curToolId = id;
    curTool = TOOL_FACTORY[id](api);
    stage.style.cursor = curTool.cursor || '';
    renderTools();
    renderHint();
    drawOverlay();
  }
  function renderHint() {
    const t = TOOLS.find((x) => x.id === curToolId);
    $('#hint').textContent = t ? t.hint : '';
  }

  function strokeRect(g, a, b) {
    const [ax, ay] = toScreen(a[0], a[1]);
    const [bx, by] = toScreen(b[0], b[1]);
    g.save();
    g.fillStyle = alpha(COLORS.draft, 0.1);
    g.strokeStyle = COLORS.draft;
    g.lineWidth = 1.5;
    g.setLineDash([5, 3]);
    g.fillRect(ax, ay, bx - ax, by - ay);
    g.strokeRect(ax, ay, bx - ax, by - ay);
    g.restore();
  }
  function drawShape(g, pts, close, cursor) {
    if (!pts.length) return;
    g.save();
    g.strokeStyle = COLORS.draft;
    g.fillStyle = alpha(COLORS.draft, 0.1);
    g.lineWidth = 1.5;
    g.setLineDash([5, 3]);
    g.beginPath();
    pts.forEach((p, i) => {
      const [sx, sy] = toScreen(p[0], p[1]);
      if (i === 0) g.moveTo(sx, sy);
      else g.lineTo(sx, sy);
    });
    if (cursor) {
      const [cx, cy] = toScreen(cursor[0], cursor[1]);
      g.lineTo(cx, cy);
    }
    if (close) g.closePath();
    if (close || pts.length + (cursor ? 1 : 0) >= 3) g.fill();
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#fff';
    pts.forEach((p, i) => {
      const [sx, sy] = toScreen(p[0], p[1]);
      g.beginPath();
      g.arc(sx, sy, i === 0 && !close ? 5 : 3.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    });
    g.restore();
  }

  // 掴む（ノード・箱・角を動かす）。選ぶ道具と箱の道具が使う
  // opts.areas: 選んだエリアを動かす・形を変える（「選ぶ」だけ。箱の道具では、エリアの中で引くと箱を描く）
  function grabber(opts) {
    const withAreas = !!(opts && opts.areas);
    let g = null;
    return {
      begin(ev) {
        const hs = withAreas ? ev.hits : null;
        if (withAreas) {
          // ノードは、線やルートの下にあっても掴める
          const nh = hs.find((x) => x.kind === 'node');
          if (nh) {
            g = { kind: 'node', id: nh.id, before: SM.clone(store.state), moved: false };
            api.select({ kind: 'node', id: nh.id });
            return true;
          }
          // 選んである線分の途中の角
          const sel = app.selection;
          if (sel && sel.kind === 'segment') {
            const pi = segPoint(store.segment(sel.id), ev);
            if (pi !== null) {
              g = { kind: 'point', id: sel.id, i: pi, before: SM.clone(store.state), moved: false };
              return true;
            }
          }
          // 選んである線・ルート・線分を、まとめて動かす（骨ごと）
          const segs = selectedBones(hs);
          if (segs) {
            g = { kind: 'bones', segs, last: [ev.x, ev.y], before: SM.clone(store.state), moved: false };
            return true;
          }
        }
        const hit = ev.hits[0];
        // 選んであるエリア: 角を引けば形が変わり、エリアを引けば動く（ページ全体の層は動かさない）
        const sa = withAreas && app.selection && app.selection.kind === 'area' ? store.area(app.selection.id) : null;
        if (sa && !isFull(sa)) {
          const vi = areaVertex(sa, ev);
          if (vi !== null) {
            g = { kind: 'vertex', id: sa.id, v: vi, before: SM.clone(store.state), moved: false };
            return true;
          }
          if (hit && hit.kind === 'area' && hit.id === sa.id) {
            g = { kind: 'area', id: sa.id, last: [ev.x, ev.y], before: SM.clone(store.state), moved: false };
            return true;
          }
        }
        if (!hit) return false;
        if (hit.kind === 'node') g = { kind: 'node', id: hit.id, before: SM.clone(store.state), moved: false };
        else if (hit.kind === 'pickup' && hit.how === 'box') {
          const p = store.pickup(hit.id);
          const corner = boxCorner(p, ev);
          g = { kind: corner ? 'corner' : 'box', id: hit.id, corner, last: [ev.x, ev.y], before: SM.clone(store.state), moved: false };
        } else return false;
        api.select({ kind: hit.kind, id: hit.id });
        return true;
      },
      move(ev) {
        if (!g || !ev.dragging) return !!g;
        if (!ev.moved) return true;
        g.moved = true;
        if (g.kind === 'node') store.moveNode(g.id, ev.x, ev.y);
        else if (g.kind === 'vertex') store.moveAreaVertex(g.id, g.v, ev.x, ev.y);
        else if (g.kind === 'point') store.moveSegmentPoint(g.id, g.i, ev.x, ev.y);
        else if (g.kind === 'bones') {
          store.moveBones(g.segs, ev.x - g.last[0], ev.y - g.last[1]);
          g.last = [ev.x, ev.y];
        }
        else if (g.kind === 'area') {
          store.moveArea(g.id, ev.x - g.last[0], ev.y - g.last[1]);
          g.last = [ev.x, ev.y];
        } else if (g.kind === 'box') {
          store.movePickup(g.id, ev.x - g.last[0], ev.y - g.last[1]);
          g.last = [ev.x, ev.y];
        } else if (g.kind === 'corner') {
          const p = store.pickup(g.id);
          const b = p.bbox;
          const x0 = g.corner.includes('l') ? ev.x : b[0];
          const y0 = g.corner.includes('t') ? ev.y : b[1];
          const x1 = g.corner.includes('r') ? ev.x : b[0] + b[2];
          const y1 = g.corner.includes('b') ? ev.y : b[1] + b[3];
          p.bbox = [SM.round(Math.min(x0, x1), 1), SM.round(Math.min(y0, y1), 1), SM.round(Math.abs(x1 - x0), 1), SM.round(Math.abs(y1 - y0), 1)];
        }
        recompute();
        drawOverlay();
        return true;
      },
      end() {
        if (!g) return false;
        const gg = g;
        g = null;
        if (gg.moved) {
          store.undoStack.push({ label: { node: 'ノードを動かす', box: '箱を動かす', corner: '箱の大きさ', area: 'エリアを動かす', vertex: 'エリアの形', point: '線分の角を動かす', bones: '線・ルートを動かす' }[gg.kind], state: gg.before });
          store.redoStack = [];
          onStoreChange(null);
        }
        return true;
      },
      hover(ev) {
        if (withAreas) {
          const hs = ev.hits;
          if (hs.some((x) => x.kind === 'node')) return 'move';
          const sel = app.selection;
          if (sel && sel.kind === 'segment' && segPoint(store.segment(sel.id), ev) !== null) return 'crosshair';
          if (selectedBones(hs)) return 'move';
        }
        const hit = ev.hits[0];
        const sa = withAreas && app.selection && app.selection.kind === 'area' ? store.area(app.selection.id) : null;
        if (sa && !isFull(sa)) {
          if (areaVertex(sa, ev) !== null) return 'crosshair';
          if (hit && hit.kind === 'area' && hit.id === sa.id) return 'move';
        }
        if (!hit) return null;
        if (hit.kind === 'node') return 'move';
        if (hit.kind === 'pickup' && hit.how === 'box') return boxCorner(store.pickup(hit.id), ev) ? 'nwse-resize' : 'move';
        return null;
      },
      cancel() {
        if (g && g.moved) store.state = g.before;
        g = null;
      },
    };
  }
  // 選んである線・ルート・線分が、押した所に当たっていれば、その線分の集まり
  function selectedBones(hs) {
    const sel = app.selection;
    if (!sel || !hs.some((x) => x.kind === sel.kind && x.id === sel.id)) return null;
    if (sel.kind === 'pickup') {
      const p = store.pickup(sel.id);
      return p && p.kind === 'line' ? p.path.slice() : null;
    }
    if (sel.kind === 'route') {
      const r = store.route(sel.id);
      return r ? r.segments.slice() : null;
    }
    if (sel.kind === 'segment') return [sel.id];
    return null;
  }
  // 選んだ線分の途中の角の近くなら、その番号
  function segPoint(s, ev) {
    if (!s || s.riser) return null;
    const t = tol(PX.handle);
    for (let i = 1; i < s.points.length - 1; i++) if (Math.abs(ev.x - s.points[i][0]) <= t && Math.abs(ev.y - s.points[i][1]) <= t) return i;
    return null;
  }
  // 選んだエリアの角の近くなら、その番号
  function areaVertex(a, ev) {
    const t = tol(PX.handle + 1);
    const poly = SM.geom.shapePolygon(a.shape);
    for (let i = 0; i < poly.length; i++) if (Math.abs(ev.x - poly[i][0]) <= t && Math.abs(ev.y - poly[i][1]) <= t) return i;
    return null;
  }
  function boxCorner(p, ev) {
    if (!isSel('pickup', p.id)) return null;
    const t = tol(PX.handle);
    const b = p.bbox;
    const near = (x, y) => Math.abs(ev.x - x) <= t && Math.abs(ev.y - y) <= t;
    if (near(b[0], b[1])) return 'tl';
    if (near(b[0] + b[2], b[1])) return 'tr';
    if (near(b[0] + b[2], b[1] + b[3])) return 'br';
    if (near(b[0], b[1] + b[3])) return 'bl';
    return null;
  }

  function closeChips() {
    if (!chips) return;
    chips.off();
    chips = null;
  }
  // 候補の札（図面の下に留める）
  function showChips(pickupId) {
    closeChips();
    const p = store.pickup(pickupId);
    const o = app.objects.find((x) => x.pickup === pickupId);
    if (!p || !o || o.leaf) return;
    const cands = o.candidates || [];
    if (cands.length < 2) return;
    const pal = P();
    const shown = cands.slice(0, 8);
    const el = shield(h('div', { class: 'cand' }, h('span', { class: 'ct' }, '候補')));
    shown.forEach((c, i) => {
      el.append(h('button', { class: 'ci', title: pal.categoryPath(c).join(' › '), onclick: () => choose(pickupId, c) }, h('span', { class: 'ck' }, String(i + 1)), pal.category(c).name));
    });
    if (cands.length > shown.length) el.append(h('span', { class: 'cn' }, 'ほか ' + (cands.length - shown.length) + '（右の板で）'));
    el.append(h('span', { class: 'cn' }, '数字のキーで選ぶ。選ばずに次を置いてもよい'));
    const off = float(el, 0, 0, { dock: 'bottom' });
    chips = { pickup: pickupId, off, leaves: shown };
  }
  function choose(pickupId, leaf) {
    closeChips();
    edit('候補から選ぶ', (S) => S.setChosen(pickupId, leaf));
  }

  const TOOL_FACTORY = {
    select(api) {
      const grab = grabber({ areas: true });
      let cycle = null;
      let box = null; // 範囲選択の下書き { x, y, cur }
      return {
        onDown(ev) {
          if (grab.begin(ev)) return;
          // 空いた所をドラッグで範囲選択（パンは Space＋ドラッグ・中ボタン・ホイール）
          if (!ev.hits.length) box = { x: ev.x, y: ev.y, cur: null };
        },
        onMove(ev) {
          if (box && ev.dragging) {
            if (ev.moved) box.cur = [ev.x, ev.y];
            api.redraw();
            return;
          }
          if (grab.move(ev)) return;
          if (!ev.dragging) api.cursor(grab.hover(ev) || '');
        },
        onUp(ev) {
          if (box) {
            const b = box;
            box = null;
            api.redraw();
            if (!b.cur || !ev.moved) return;
            const x0 = Math.min(b.x, b.cur[0]);
            const y0 = Math.min(b.y, b.cur[1]);
            const x1 = Math.max(b.x, b.cur[0]);
            const y1 = Math.max(b.y, b.cur[1]);
            const items = itemsInRect(x0, y0, x1, y1);
            if (!items.length) return api.select(null);
            api.select(items.length === 1 ? items[0] : { kind: 'multi', items });
            setHintOnce('範囲で ' + items.length + ' つ選んだ。Delete でまとめて消す');
            return;
          }
          grab.end(ev);
        },
        draw(g) {
          if (box && box.cur) strokeRect(g, [box.x, box.y], box.cur);
        },
        // 押すと手前のもの。同じ場所をもう一度押すと 1 つ下へ（巡回。決定 44）
        onClick(ev) {
          const hs = ev.hits;
          if (!hs.length) return api.select(null);
          const cur = app.selection;
          const same = cycle && Math.abs(cycle.x - ev.x) <= api.tol(6) && Math.abs(cycle.y - ev.y) <= api.tol(6);
          let i = 0;
          if (same && cur) {
            const k = hs.findIndex((x) => x.kind === cur.kind && x.id === cur.id);
            if (k >= 0) i = (k + 1) % hs.length;
          }
          cycle = { x: ev.x, y: ev.y };
          api.select({ kind: hs[i].kind, id: hs[i].id });
          if (hs.length > 1) setHintOnce('ここに ' + hs.length + ' つ。もう一度押すと次（' + (i + 1) + '/' + hs.length + '）。右ボタンで一覧');
        },
        // 右ボタン: ここにあるものの一覧
        onContext(ev) {
          const hs = ev.hits;
          if (!hs.length) return;
          const pal = P();
          const name = (x) => {
            if (x.kind === 'pickup') { const p = store.pickup(x.id); return (p.kind === 'box' ? '箱 ' : '線 ') + (p.name || p.id) + ' ' + (pal.category(p.category) || {}).name; }
            if (x.kind === 'route') return 'ルート ' + routeName(pal, store.route(x.id));
            if (x.kind === 'area') return 'エリア ' + pal.labelPath(store.area(x.id).label).join('/');
            if (x.kind === 'segment') return '骨: 線分 ' + x.id;
            if (x.kind === 'node') return '骨: ノード ' + x.id + ((store.node(x.id) || {}).level ? '（立 ' + store.node(x.id).level + '）' : '');
            return x.kind + ' ' + x.id;
          };
          const el = shield(h('div', { class: 'cand', style: 'flex-direction:column;align-items:stretch' }, h('span', { class: 'ct' }, 'ここにあるもの')));
          const seen = new Set();
          for (const x of hs) {
            const key = x.kind + ':' + x.id;
            if (seen.has(key)) continue;
            seen.add(key);
            el.append(h('button', { class: 'ci', onclick: () => { off(); api.select({ kind: x.kind, id: x.id }); } }, h('span', { class: 'ck', style: 'background:' + (x.kind === 'pickup' ? 'var(--pickup)' : x.kind === 'area' || x.kind === 'route' ? 'var(--layer)' : '#64748b') }, x.kind === 'pickup' ? '拾' : x.kind === 'area' || x.kind === 'route' ? '層' : '骨'), name(x)));
          }
          // 線分の上なら、ノードを足す行い
          const sh = hs.find((x) => x.kind === 'segment');
          if (sh) el.append(h('button', { class: 'ci', onclick: () => { off(); const r = edit('ノードを足す', (S) => S.splitSegment(sh.id, sh.at)); if (r) api.select({ kind: 'node', id: r.node }); } }, h('span', { class: 'ck', style: 'background:#0f172a' }, '＋'), 'ここにノードを足す（' + sh.id + '）'));
          const off = float(el, ev.x, ev.y, { dx: 8, dy: 8 });
          const close = (e) => { if (!el.contains(e.target)) { off(); window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc, true); } };
          const esc = (e) => { if (e.key === 'Escape') { off(); window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc, true); } };
          setTimeout(() => { window.addEventListener('pointerdown', close, true); window.addEventListener('keydown', esc, true); }, 0);
        },
        onKey(e) {
          if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
        },
        cancel() {
          grab.cancel();
          box = null;
        },
      };
    },

    box(api) {
      const grab = grabber();
      let draft = null;
      let pressed = false;
      function place(bbox) {
        const cat = P().category(app.currentCategory);
        if (cat && cat.size === '長さ') {
          api.toast('「' + cat.name + '」は長さもののカテゴリ。箱には、個数もののカテゴリか根を選ぶ', 3500);
          return null;
        }
        const id = edit('箱を置く', (S) => S.addBox(api.page().id, app.currentCategory, bbox));
        if (!id) return null;
        lastBox = { w: bbox[2], h: bbox[3] };
        api.select({ kind: 'pickup', id });
        showChips(id);
        return id;
      }
      return {
        cursor: 'crosshair',
        onDown(ev) {
          draft = null;
          pressed = false;
          if (!ev.alt && grab.begin(ev)) {
            closeChips();
            return;
          }
          if (!ev.inPage) return;
          pressed = true;
          draft = { x: ev.x, y: ev.y, cur: null };
        },
        onMove(ev) {
          if (grab.move(ev)) return;
          if (draft && ev.moved) {
            draft.cur = [ev.x, ev.y];
            api.redraw();
            return;
          }
          if (!ev.dragging) api.cursor((!ev.alt && grab.hover(ev)) || 'crosshair');
        },
        onUp(ev) {
          if (grab.end(ev)) return;
          const d = draft;
          draft = null;
          if (!d || !d.cur) return;
          const x0 = Math.min(d.x, d.cur[0]);
          const y0 = Math.min(d.y, d.cur[1]);
          const w = Math.abs(d.cur[0] - d.x);
          const hh = Math.abs(d.cur[1] - d.y);
          api.redraw();
          if (w < api.tol(4) || hh < api.tol(4)) return;
          place([x0, y0, w, hh]);
        },
        onClick(ev) {
          if (!pressed) return;
          pressed = false;
          const size = lastBox || { w: 12, h: 12 };
          place([ev.x - size.w / 2, ev.y - size.h / 2, size.w, size.h]);
        },
        onKey(e) {
          if (chips && /^[1-9]$/.test(e.key)) {
            const leaf = chips.leaves[parseInt(e.key, 10) - 1];
            if (leaf) {
              e.preventDefault();
              choose(chips.pickup, leaf);
            }
            return;
          }
          if (e.key === 'Delete' || e.key === 'Backspace') {
            closeChips();
            deleteSelection();
          }
        },
        cancel() {
          draft = null;
          pressed = false;
          grab.cancel();
          closeChips();
        },
        dispose: closeChips,
        draw(g) {
          if (draft && draft.cur) strokeRect(g, [draft.x, draft.y], draft.cur);
        },
      };
    },

    line: (api) => traceTool(api, 'line'),
    route: (api) => traceTool(api, 'route'),

    'area-rect'(api) {
      let draft = null;
      let pending = null;
      return {
        cursor: 'crosshair',
        onDown(ev) {
          draft = pending ? null : { x: ev.x, y: ev.y, cur: null };
        },
        onMove(ev) {
          if (draft && ev.moved) {
            draft.cur = [ev.x, ev.y];
            api.redraw();
          }
        },
        async onUp() {
          const d = draft;
          draft = null;
          if (!d || !d.cur) return;
          const x0 = Math.min(d.x, d.cur[0]);
          const y0 = Math.min(d.y, d.cur[1]);
          const x1 = Math.max(d.x, d.cur[0]);
          const y1 = Math.max(d.y, d.cur[1]);
          api.redraw();
          if (x1 - x0 < api.tol(8) || y1 - y0 < api.tol(8)) return;
          pending = { type: 'rect', points: [[SM.round(x0, 1), SM.round(y0, 1)], [SM.round(x1, 1), SM.round(y1, 1)]] };
          api.redraw();
          try {
            const id = await openLayerModal({ page: api.page().id, shape: pending });
            if (id) api.select({ kind: 'area', id });
          } finally {
            pending = null;
            api.redraw();
          }
        },
        onClick() {
          if (!pending) api.toast('引いて、範囲を囲んでください');
        },
        cancel() {
          draft = null;
        },
        draw(g) {
          if (pending) drawShape(g, SM.geom.shapePolygon(pending), true, null);
          if (draft && draft.cur) strokeRect(g, [draft.x, draft.y], draft.cur);
        },
      };
    },

    'area-poly'(api) {
      let pts = [];
      let cursor = null;
      let pending = null;
      const near = (a, b, px) => SM.geom.dist(a, b) <= api.tol(px);
      async function close() {
        const out = [];
        for (const p of pts) if (!out.length || !near(out[out.length - 1], p, 3)) out.push(p);
        if (out.length > 1 && near(out[0], out[out.length - 1], 3)) out.pop();
        if (out.length < 3) return api.toast('角を 3 つ以上打ってください');
        pts = [];
        cursor = null;
        pending = { type: 'polygon', points: out.map((p) => [SM.round(p[0], 1), SM.round(p[1], 1)]) };
        api.redraw();
        try {
          const id = await openLayerModal({ page: api.page().id, shape: pending });
          if (id) api.select({ kind: 'area', id });
        } finally {
          pending = null;
          api.redraw();
        }
      }
      return {
        cursor: 'crosshair',
        onMove(ev) {
          if (!pts.length) return;
          cursor = [ev.x, ev.y];
          api.cursor(pts.length >= 3 && near(pts[0], cursor, 9) ? 'pointer' : 'crosshair');
          api.redraw();
        },
        onClick(ev) {
          if (pending) return;
          const p = [ev.x, ev.y];
          if (pts.length >= 3 && near(pts[0], p, 9)) return close();
          pts.push(p);
          api.redraw();
        },
        onDblClick() {
          if (!pending && pts.length) close();
        },
        onKey(e) {
          if (e.key === 'Enter' && pts.length) {
            e.preventDefault();
            close();
          } else if (e.key === 'Backspace' && pts.length) {
            e.preventDefault();
            pts.pop();
            api.redraw();
          }
        },
        cancel() {
          pts = [];
          cursor = null;
        },
        draw(g) {
          if (pending) drawShape(g, pending.points, true, null);
          drawShape(g, pts, false, cursor);
        },
      };
    },
  };

  /* ---- 線・ルート（どちらも骨の上の道。先に引いた側が骨を作り、後の側はなぞる） ---- */

  function traceTool(api, kind) {
    const makeLine = kind === 'line';
    let d = null; // { lastNode, nodes, path, corners, cursor, snap, created }
    function begin() {
      store.beginDraft();
      d = { lastNode: null, nodes: [], path: [], corners: [], cursor: null, snap: null, created: new Set() };
    }
    // 直前の点から見て、水平・垂直の ±10° 以内なら軸に揃える（Alt で自由。決定 42）
    const AXIS_DEG = 10;
    function lastPoint() {
      if (!d) return null;
      if (d.corners.length) return d.corners[d.corners.length - 1];
      const n = d.lastNode ? store.node(d.lastNode) : null;
      return n ? [n.x, n.y] : null;
    }
    function axisSnap(pt, free) {
      const from = lastPoint();
      if (!from || free) return pt;
      const dx = pt[0] - from[0];
      const dy = pt[1] - from[1];
      if (!dx && !dy) return pt;
      const deg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
      if (deg <= AXIS_DEG) return [pt[0], from[1]];
      if (deg >= 90 - AXIS_DEG) return [from[0], pt[1]];
      return pt;
    }
    // 吸着: 立の印 → ノード → 線分
    function snapAt(pt) {
      const hs = api.hits(pt[0], pt[1]);
      const n = hs.find((x) => x.kind === 'node');
      if (n) return { node: n.id };
      const s = hs.find((x) => x.kind === 'segment');
      if (s) return { segment: s.id, at: s.at };
      return null;
    }
    function click(ev) {
      let pt = [ev.x, ev.y];
      const sn0 = snapAt(pt);
      // 線分の上を押しても切らない（ノードを足すのは右クリックだけ。誤操作が多かったため）
      if (sn0 && sn0.segment && !(d && d.lastNode && d.created.has(sn0.segment))) {
        setHintOnce('線分の上です。ここにノードを足すなら右クリック。既存の骨は、ノードを押してたどる');
        return;
      }
      if (!d) begin();
      if (!sn0) pt = axisSnap(pt, ev.alt);
      if (ev.shift && d.lastNode) {
        d.corners.push([SM.round(pt[0], 1), SM.round(pt[1], 1)]);
        api.redraw();
        return;
      }
      let nodeId = null;
      let fresh = false;
      if (sn0 && sn0.node) nodeId = sn0.node;
      if (!nodeId) {
        nodeId = store.addNode(api.page().id, pt[0], pt[1]);
        fresh = true;
        d.created.add(nodeId);
      }
      if (d.lastNode && d.lastNode !== nodeId) {
        let segs = null;
        if (!d.corners.length) {
          const direct = store.segmentBetween(d.lastNode, nodeId);
          if (direct) segs = [direct.id];
          else if (!fresh && !d.created.has(d.lastNode)) {
            const p = store.findPath(d.lastNode, nodeId);
            if (p && p.length) {
              segs = p;
              api.toast('骨の道を通した（' + p.length + ' 線分）', 1800);
            }
          }
        }
        if (!segs) {
          const sid = store.addSegment(api.page().id, d.lastNode, nodeId, d.corners);
          d.created.add(sid);
          segs = [sid];
        }
        for (const s of segs) if (!d.path.includes(s)) d.path.push(s);
      }
      d.corners = [];
      d.lastNode = nodeId;
      if (!d.nodes.includes(nodeId)) d.nodes.push(nodeId);
      recompute();
      api.redraw();
    }
    // 右クリック: 線分の上ならノードを足す（引いている途中でもよい）
    function addNodeAt(ev) {
      const sh = api.hits(ev.x, ev.y).find((x) => x.kind === 'segment');
      if (!sh) return;
      if (d) {
        const r = store.splitSegment(sh.id, sh.at);
        if (!r) return;
        const k = d.path.indexOf(sh.id);
        if (k >= 0) d.path.splice(k, 1, ...r.segments);
        recompute();
        api.redraw();
      } else if (!edit('ノードを足す', (S) => S.splitSegment(sh.id, sh.at))) return;
      setHintOnce('ノードを足した。押すとそこからたどれる');
    }
    // 立の印（決定 24・45）: いまのノードに ↑↓ で立の線分を足し、そこへ進む
    function riser(level) {
      if (!d || !d.lastNode) return api.toast('先にノードを押してから ↑↓', 2000);
      const n = store.node(d.lastNode);
      if (n.level) return api.toast('立の印の上には、さらに立は足せない', 2000);
      const have = store.state.nodes.find((m) => m.base === d.lastNode && m.level === level);
      let rid;
      let sid;
      if (have) {
        rid = have.id;
        sid = store.segmentBetween(d.lastNode, rid).id;
      } else {
        const r = store.addRiser(d.lastNode, level);
        rid = r.node;
        sid = r.segment;
        d.created.add(rid);
        d.created.add(sid);
      }
      d.path.push(sid);
      d.lastNode = rid;
      d.nodes.push(rid);
      recompute();
      api.redraw();
      api.toast('立（' + level + '）の線分を足した。長さは、ルートの道具でこの印をなぞって入れる', 2500);
    }
    async function finish() {
      if (!d) return;
      const dd = d;
      d = null;
      if (!dd.path.length) {
        store.cancelDraft();
        recompute();
        api.toast(makeLine ? '線は、ノードを 2 つ以上たどって置く' : 'ルートは、ノードを 2 つ以上たどって置く', 2500);
        return;
      }
      if (makeLine) {
        const cat = P().category(app.currentCategory);
        if (cat && cat.size === '個数') {
          store.cancelDraft();
          recompute();
          api.toast('「' + cat.name + '」は個数もののカテゴリ。線には、長さもののカテゴリか根を選ぶ', 3500);
          return;
        }
        const id = store.addLine(api.page().id, app.currentCategory, dd.nodes, dd.path, '');
        store.endDraft('線を置く');
        api.select({ kind: 'pickup', id });
        const noLen = app.objects.filter((o) => o.pickup === id).some((o) => o.flags.includes('長さ未入力'));
        if (noLen) api.toast('線を置いた。長さは、ルート（L）でなぞって入れるか、右の板で線分ごとに入れる', 4000);
        return;
      }
      // ルート: 骨は確定し、意味（ラベル・長さ）はモーダルで。やめたら骨も戻す
      store.endDraft('ルートの骨をなぞる');
      const id = await openLayerModal({ page: api.page().id, segments: dd.path });
      if (id) api.select({ kind: 'route', id });
      else {
        // 骨だけ残す（新しく出来た骨も残す。消すなら Ctrl+Z）
        api.toast('ルートの意味は決めなかった。骨は残っている（Ctrl+Z で戻せる）', 3000);
      }
    }
    return {
      cursor: 'crosshair',
      onMove(ev) {
        if (!d) {
          const sn = snapAt([ev.x, ev.y]);
          api.cursor(sn && sn.node ? 'pointer' : sn ? 'not-allowed' : 'crosshair');
          return;
        }
        const raw = [ev.x, ev.y];
        const sn = snapAt(raw);
        // 吸い付くのはノードだけ（線分の上は押しても切らない。右クリックでノードを足す）
        d.snap = sn && sn.node ? [store.node(sn.node).x, store.node(sn.node).y] : null;
        d.cursor = sn ? raw : axisSnap(raw, ev.alt);
        api.redraw();
      },
      onClick: click,
      onContext: addNodeAt,
      onDblClick() {
        finish();
      },
      onKey(e) {
        if (e.key === 'Enter' && d) {
          e.preventDefault();
          finish();
        } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && d) {
          e.preventDefault();
          riser(e.key === 'ArrowUp' ? '上' : '下');
        }
      },
      cancel() {
        if (d) {
          d = null;
          store.cancelDraft();
          recompute();
        }
      },
      draw(g) {
        if (!d) return;
        const last = d.lastNode ? store.node(d.lastNode) : null;
        const pts = (last ? [[last.x, last.y]] : []).concat(d.corners, d.cursor ? [d.cursor] : []);
        if (pts.length > 1) {
          g.save();
          pathOf(g, pts, false);
          g.strokeStyle = makeLine ? COLORS.wire : COLORS.route;
          g.lineWidth = 1.5;
          g.setLineDash([5, 4]);
          g.stroke();
          g.restore();
        }
        for (const c of d.corners) {
          const [sx, sy] = toScreen(c[0], c[1]);
          g.fillStyle = '#0f172a';
          g.beginPath();
          g.arc(sx, sy, 3, 0, Math.PI * 2);
          g.fill();
        }
        if (d.snap) {
          const [sx, sy] = toScreen(d.snap[0], d.snap[1]);
          g.save();
          g.strokeStyle = '#0f172a';
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(sx, sy, 7, 0, Math.PI * 2);
          g.stroke();
          g.restore();
        }
      },
    };
  }

  /* ======================================================================
   * 図面の出来事
   * ====================================================================== */

  let down = null;
  let spacePan = null;
  let spaceHeld = false;
  function ev(e) {
    const r = stage.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const p = toPage(sx, sy);
    const x = SM.round(p[0], 2);
    const y = SM.round(p[1], 2);
    const pg = page();
    return {
      x,
      y,
      sx,
      sy,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      original: e,
      inPage: !!pg && x >= 0 && y >= 0 && x <= pg.width && y <= pg.height,
      get hits() {
        return hits(x, y);
      },
    };
  }
  function onDown(e) {
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) return;
    stage.focus({ preventScroll: true });
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      spacePan = { x: e.clientX, y: e.clientY, tx: app.view.tx, ty: app.view.ty };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('panning');
      return;
    }
    if (e.button !== 0 || !page()) return;
    stage.setPointerCapture(e.pointerId);
    down = { sx: e.clientX, sy: e.clientY, moved: false };
    if (curTool.onDown) curTool.onDown(ev(e));
  }
  function onMove(e) {
    if (spacePan) {
      app.view.tx = spacePan.tx + e.clientX - spacePan.x;
      app.view.ty = spacePan.ty + e.clientY - spacePan.y;
      applyView();
      return;
    }
    if (!page()) return;
    if (down && Math.abs(e.clientX - down.sx) + Math.abs(e.clientY - down.sy) > 3) down.moved = true;
    if (curTool.onMove) curTool.onMove(Object.assign(ev(e), { dragging: !!down, moved: !!(down && down.moved) }));
  }
  function onUp(e) {
    if (spacePan) {
      spacePan = null;
      stage.classList.remove('panning');
      refine();
      return;
    }
    if (!down) return;
    const moved = down.moved;
    down = null;
    const x = Object.assign(ev(e), { moved });
    if (curTool.onUp) curTool.onUp(x);
    if (!moved && curTool.onClick) curTool.onClick(x);
  }
  function onKey(e, isDown) {
    if (!isDown && e.code === 'Space') {
      spaceHeld = false;
      stage.classList.remove('pan-ready');
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (modalOpen) return;
    if (e.code === 'Space' && app.screen === 'pick') {
      e.preventDefault();
      spaceHeld = isDown;
      stage.classList.toggle('pan-ready', isDown);
      return;
    }
    if (!isDown) return;
    if (e.key === 'Escape') closeMenu();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      store.redo();
      return;
    }
    if (app.screen !== 'pick' || !app.pdf) return;
    if (e.key === 'Escape') {
      if (curTool.cancel) curTool.cancel();
      app.selection = null;
      renderAll();
      return;
    }
    if (curTool.onKey) {
      curTool.onKey(e);
      if (e.defaultPrevented) return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') return deleteSelection();
    const k = e.key.toLowerCase();
    if (k === '0') return fit();
    for (const t of TOOLS) if (t.key.toLowerCase() === k && !e.ctrlKey && !e.metaKey) return setTool(t.id);
  }

  function deleteSelection() {
    const sel = app.selection;
    if (!sel) return;
    if (sel.kind === 'multi') {
      // まとめて消す: 拾い → ルート（骨は残す）→ エリア → 線分（通る線が無ければ）→ ノード（線分が無ければ）
      const items = sel.items;
      const res = edit('まとめて消す（' + items.length + '）', (S) => {
        let n = 0;
        for (const x of items.filter((x) => x.kind === 'pickup')) { S.removePickup(x.id); n++; }
        for (const x of items.filter((x) => x.kind === 'route')) if (S.route(x.id)) { S.removeRoute(x.id); n++; }
        for (const x of items.filter((x) => x.kind === 'area')) { S.removeArea(x.id); n++; }
        for (const x of items.filter((x) => x.kind === 'segment')) if (S.segment(x.id) && S.removeSegment(x.id)) n++;
        for (const x of items.filter((x) => x.kind === 'node')) if (S.node(x.id) && S.removeNode(x.id)) n++;
        return n;
      });
      if (res !== null) toast(res + ' つ消した（通る線のある線分や、線分の残るノードは残した）', 3000);
      app.selection = null;
      renderAll();
      return;
    }
    if (sel.kind === 'area') edit('エリアを消す', (S) => S.removeArea(sel.id));
    else if (sel.kind === 'pickup') edit('拾いを消す', (S) => S.removePickup(sel.id));
    else if (sel.kind === 'route') {
      const r = store.route(sel.id);
      const through = r ? linesOver(store, r.segments) : [];
      if (through.length) return toast('このルートを通る線がある（' + through.length + '）。先に線を消すか、「ルートを外す（骨は残す）」', 3500);
      edit('ルートを骨ごと消す', (S) => S.removeRouteWithBones(sel.id));
    } else if (sel.kind === 'segment') {
      const through = store.pickupsThrough(sel.id);
      if (through.length) return toast('この線分を通る拾いがある（' + through.length + '）。先に拾いを消す', 3000);
      edit('線分を消す', (S) => S.removeSegment(sel.id));
    } else if (sel.kind === 'node') {
      if (store.segmentsAt(sel.id).length) return toast('線分がつながっているノードは消せない', 3000);
      edit('ノードを消す', (S) => S.removeNode(sel.id));
    }
    app.selection = null;
    renderAll();
  }

  /* ======================================================================
   * モーダル
   * ====================================================================== */

  let modalOpen = false;
  function openModal(opts) {
    modalOpen = true;
    let resolve;
    const result = new Promise((r) => (resolve = r));
    const foot = h('div', { class: 'mfoot' });
    const back = h('div', { class: 'mback' }, h('div', { class: 'modal', style: 'width:' + (opts.width || 600) + 'px; max-width: calc(100vw - 48px)' }, h('div', { class: 'mhead' }, opts.title), h('div', { class: 'mbody' }, opts.body), foot));
    const hd = {
      close(v) {
        back.remove();
        modalOpen = false;
        window.removeEventListener('keydown', onk, true);
        resolve(v);
      },
      setActions(acts) {
        foot.innerHTML = '';
        for (const a of acts) {
          if (a === 'spacer') foot.append(h('span', { class: 'spacer' }));
          else if (a.text) foot.append(h('span', { class: 'note' }, a.text));
          else foot.append(h('button', { class: a.primary ? 'primary' : '', disabled: a.disabled ? '' : null, title: a.title, onclick: () => (a.on ? a.on(hd) : hd.close(a.id === 'cancel' ? undefined : a.id)) }, a.label));
        }
      },
      result,
    };
    const onk = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        hd.close(undefined);
      } else if (opts.onKey) opts.onKey(e, hd);
    };
    window.addEventListener('keydown', onk, true);
    back.addEventListener('pointerdown', (e) => {
      if (e.target === back && opts.dismiss) hd.close(undefined);
    });
    $('#modal-root').append(back);
    if (opts.actions) hd.setActions(opts.actions);
    return hd;
  }

  /* ---- 層のモーダル: 囲んだ範囲／なぞったルートに意味を与える ---- */
  /*
   * target:
   *   { page, shape }       新しく囲んだ形 → エリア
   *   { area }              置いてあるエリア
   *   { page, segments }    なぞった線分の集まり → ルート（ラベルルート。長さを入れれば長さルートも）
   *   { route }             置いてあるラベルルート
   * 返すもの: Promise。確定したら層の id（エリア／ラベルルート。長さだけなら長さルート）。やめたら undefined
   */

  let lastRootBy = { area: null, route: null }; // 直前に使った木（エリアとルートで別）
  let lastParent = null;

  // 範囲の中にある箱
  function boxesIn(st, pageId, shape) {
    return st.pickupsOn(pageId).filter((p) => p.kind === 'box' && SM.geom.shapeContains(shape, SM.geom.bboxCenter(p.bbox)));
  }
  // 線分の集まりを通る線
  function linesOver(st, segments) {
    const out = new Map();
    for (const sid of segments) for (const p of st.pickupsThrough(sid)) out.set(p.id, p);
    return [...out.values()];
  }
  const stateText = (pal, o) => {
    if (!o) return '—';
    if (o.leaf) return pal.category(o.leaf).name;
    const placed = o.pickupCat === 'cat-root' ? '未指定' : pal.category(o.pickupCat).name;
    if (!o.candidates.length) return '候補なし（' + placed + '）';
    return '未確定（' + placed + '・' + o.candidates.length + ' 候補）';
  };

  function openLayerModal(target) {
    const isRoute = !!(target.route || target.segments);
    const area = target.area ? store.area(target.area) : null;
    const route = target.route ? store.route(target.route) : null;
    const pageId = area ? area.page : route ? route.page : target.page;
    const shape = area ? area.shape : target.shape;
    const segments = route ? route.segments : target.segments;
    const editing = !!(area || route);
    const want = isRoute ? '長さ' : '個数';
    // 下書き: root（木）、node（ある節の id）、fresh（新しく足す名前）、parent（新しく足すときの親）、rules、長さ（ルートだけ）
    const d = { root: null, node: null, fresh: null, parent: null, query: '', rules: [], h: null, v: null, lenOnly: false };
    let hd = null;

    const chosen = () => (d.fresh !== null ? { fresh: d.fresh, parent: d.parent || d.root } : d.node ? { node: d.node } : null);
    const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
    const hasLenInput = () => num(d.h) !== null || num(d.v) !== null;
    // 既にこの線分の集まりに掛かっている長さルート
    const existingLen = () => (isRoute && segments ? store.state.routes.find((r) => !r.label && r.segments.length === segments.length && r.segments.every((s) => segments.includes(s))) : null);

    function loadRules() {
      d.rules = [];
      if (d.fresh !== null || !d.node) return;
      const l = P().label(d.node);
      for (const r of (l && l.rules) || []) d.rules.push({ category: r.category, candidates: r.candidates.slice(), removed: false });
    }
    function pickRoot(id) {
      d.root = id;
      d.node = null;
      d.fresh = null;
      d.parent = null;
      d.query = '';
      elSearch.value = '';
      loadRules();
      draw();
    }
    function pickNode(id) {
      // 選んである節をもう一度押すと外す（新しく置くときだけ。ルートなら長さだけにできる）
      if (!editing && d.node === id && d.fresh === null) {
        clearLabel();
        return;
      }
      d.node = id;
      d.fresh = null;
      loadRules();
      draw();
    }
    function clearLabel() {
      d.node = null;
      d.fresh = null;
      d.rules = [];
      draw();
    }
    function pickFresh(name) {
      if (!editing && d.fresh === name) {
        clearLabel();
        return;
      }
      d.node = null;
      d.fresh = name;
      if (!d.parent) d.parent = lastParent && P().labelRoot(lastParent) === d.root ? lastParent : d.root;
      d.rules = [];
      draw();
    }

    // 下書きをストアに当てる（下見でも本物でも同じ）。返すもの: 層の id
    function apply(S) {
      const c = chosen();
      let labelId = c ? c.node : null;
      if (c && c.fresh !== undefined) labelId = S.addLabel(c.parent, c.fresh);
      let outId = null;
      if (!isRoute) {
        if (!labelId) return null;
        outId = area ? area.id : null;
        if (outId) {
          if (S.area(outId).label !== labelId) S.setAreaLabel(outId, labelId);
        } else outId = S.addArea(pageId, shape, labelId);
      } else {
        const pal = S.palette;
        if (labelId) {
          if (route) {
            if (route.label !== labelId) S.setRouteLabel(route.id, labelId);
            outId = route.id;
          } else outId = S.addRoute(pageId, segments, { label: labelId }, pal);
        }
        if (hasLenInput() || d.lenTouched) {
          const lid = setLengthOn(S, pageId, segments, d.h, d.v);
          if (!outId) outId = lid;
        }
      }
      if (labelId) S.setLabelRules(labelId, d.rules.filter((r) => !r.removed));
      return outId;
    }

    const elRoots = h('div', { class: 'pills' });
    const elSearch = h('input', { class: 'search', type: 'search', placeholder: '探す・新しい名前を書く' });
    const elValues = h('div', { class: 'am-values' });
    const elParent = h('div');
    const elLen = h('div');
    const elRight = h('div', { class: 'am-right' });
    elSearch.addEventListener('input', () => {
      d.query = elSearch.value;
      if (d.fresh !== null) {
        const q = d.query.trim();
        const same = P().labelDescendants(d.root).find((id) => P().label(id).name === q);
        if (!q) d.fresh = null;
        else if (same) {
          d.fresh = null;
          d.node = same;
          loadRules();
        } else d.fresh = q;
      }
      draw();
    });
    elSearch.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const first = elValues.querySelector('.am-v:not(.none)');
      if (first) first.click();
    });

    function drawRoots() {
      elRoots.innerHTML = '';
      for (const r of P().labelRoots()) elRoots.append(h('button', { class: 'pill' + (r.id === d.root ? ' on' : ''), onclick: () => pickRoot(r.id) }, r.name));
      elRoots.append(h('button', { class: 'pill', style: 'border-style:dashed', title: '木（ラベルの種類）を足す', onclick: addRoot }, '＋ 木'));
    }
    async function addRoot() {
      const input = h('input', { type: 'text', placeholder: '例: 部屋、天井の種類' });
      const m = openModal({ title: 'ラベルの木を足す', width: 420, dismiss: true, body: h('div', { class: 'form' }, h('label', {}, h('span', { class: 'fn' }, '名前'), input), h('div', { class: 'muted' }, '木は、重ならない単位です。同じ木の節どうしは、1 つの拾いに 1 つしか付きません（部屋と部屋、階と階）。')), onKey: (e, hd2) => { if (e.key === 'Enter') { e.preventDefault(); hd2.close(input.value.trim()); } }, actions: ['spacer', { label: 'やめる', id: 'cancel' }, { label: '足す', primary: true, on: (hd2) => hd2.close(input.value.trim()) }] });
      setTimeout(() => input.focus(), 50);
      const name = await m.result;
      if (!name) return;
      const id = edit('ラベルの木を足す', (S) => S.addLabel(null, name, { root: true, hue: Math.floor(Math.random() * 360) }));
      if (id) pickRoot(id);
    }
    function drawValues() {
      elValues.innerHTML = '';
      elParent.innerHTML = '';
      const pal = P();
      if (!d.root) {
        elValues.append(h('div', { class: 'empty' }, '上で、木を選んでください'));
        return;
      }
      const q = d.query.trim();
      // 親の無い節（見出しでないもの）は、それ自身も塗れる（決定 38）
      const base = pal.label(d.root) && !pal.label(d.root).root ? [d.root] : [];
      const ids = base.concat(pal.labelDescendants(d.root)).filter((id) => !q || pal.label(id).name.includes(q) || pal.labelPath(id).join('/').includes(q));
      for (const id of ids) {
        const l = pal.label(id);
        const nAreas = store.state.areas.filter((a) => a.id !== (area && area.id) && a.label === id).length + store.state.routes.filter((r) => r.id !== (route && route.id) && r.label === id).length;
        const nRules = (l.rules || []).length;
        const path = pal.labelPath(id);
        elValues.append(
          h('button', { class: 'am-v' + (d.node === id && d.fresh === null ? ' on' : ''), onclick: () => pickNode(id) }, h('span', { class: 'bar', style: 'background:' + l.color }), h('span', { class: 'nm' }, path.length > 1 ? h('span', { class: 'path' }, path.slice(0, -1).join(' / ') + ' / ') : null, l.name), nRules ? h('span', { class: 'bd' }, '規則 ' + nRules) : null, nAreas ? h('span', { class: 'bd' }, '層 ' + nAreas) : null),
        );
      }
      // 新しいルート: ラベルを付けず、長さだけにする行
      if (isRoute && !route) {
        const none = !chosen();
        elValues.prepend(h('button', { class: 'am-v none' + (none ? ' on' : ''), 'data-role': 'no-label', onclick: clearLabel }, h('span', { class: 'plus' }, '—'), h('span', { class: 'nm' }, 'ラベルなし（長さだけ）')));
      }
      const exact = ids.some((id) => pal.label(id).name === q);
      if (q && !exact) elValues.append(h('button', { class: 'am-v new' + (d.fresh === q ? ' on' : ''), onclick: () => pickFresh(q) }, h('span', { class: 'plus' }, '＋'), h('span', { class: 'nm' }, '「' + q + '」を、新しく足す')));
      if (!ids.length && !q) elValues.append(h('div', { class: 'empty' }, 'まだ節がありません。上の欄に名前を書いて、足してください'));
      if (d.fresh !== null) {
        const sel = h('select', {}, h('option', { value: d.root }, '（' + pal.label(d.root).name + ' の直下）'), ...pal.labelDescendants(d.root).map((id) => h('option', { value: id, selected: id === d.parent ? '' : null }, pal.labelPath(id).join(' / ') + ' の下')));
        sel.value = d.parent || d.root;
        sel.addEventListener('change', () => { d.parent = sel.value; draw(); });
        elParent.append(h('div', { class: 'muted', style: 'margin-top:6px' }, '新しい節「' + d.fresh + '」の親: ', sel));
      }
    }
    // ルートの長さ（長さルート）
    function drawLen() {
      elLen.innerHTML = '';
      if (!isRoute || route) return;
      const inH = h('input', { type: 'number', step: '0.1', value: d.h === null ? '' : d.h, placeholder: '平 m', 'data-role': 'len-h', style: 'width:72px' });
      const inV = h('input', { type: 'number', step: '0.1', value: d.v === null ? '' : d.v, placeholder: '立 m', 'data-role': 'len-v', style: 'width:72px' });
      inH.addEventListener('input', () => { d.h = inH.value === '' ? null : inH.value; drawRight(); });
      inV.addEventListener('input', () => { d.v = inV.value === '' ? null : inV.value; drawRight(); });
      const ex = existingLen();
      inH.addEventListener('input', () => { d.lenTouched = true; });
      inV.addEventListener('input', () => { d.lenTouched = true; });
      elLen.append(h('div', { class: 'st', style: 'margin-top:10px' }, '長さ', h('span', { class: 'cnt' }, ex ? '（いまは ' + lengthText(ex) + '。書き換える・空にすると外す）' : '入れると、この線分の集まりに長さルートが乗る')), h('div', {}, '平 ', inH, '　立 ', inV, ' m'), h('div', { class: 'muted', style: 'margin-top:4px' }, '人が入れる。図の形は根拠にしない。縦の図のように線分ごとに決まらないときは、なぞった全体に 1 つ'));
    }

    function sectionInside(pal) {
      if (isRoute) {
        const lines = linesOver(store, segments);
        const by = new Map();
        for (const p of lines) by.set(p.category, (by.get(p.category) || 0) + 1);
        const box = h('div', {}, h('div', { class: 'st' }, 'このルートを通る線', h('span', { class: 'cnt' }, lines.length + ' 本')));
        if (!lines.length) box.append(h('div', { class: 'muted' }, 'まだありません。先にルートを置いて、あとから線を通してもかまいません。'));
        else {
          const line = h('div', { class: 'inside' });
          for (const [k, n] of by) line.append(h('span', { class: 'in' }, h('span', { class: 'dot', style: '--dot:' + (k === 'cat-root' ? '#94a3b8' : catColor(k)) }), (k === 'cat-root' ? '未指定' : pal.category(k).name) + ' ' + n));
          box.append(line);
        }
        return { el: box, by, ids: lines.map((p) => p.id) };
      }
      const boxes = boxesIn(store, pageId, shape);
      const by = new Map();
      for (const p of boxes) by.set(p.category, (by.get(p.category) || 0) + 1);
      const box = h('div', {}, h('div', { class: 'st' }, 'この範囲の中の箱', h('span', { class: 'cnt' }, boxes.length + ' 個')));
      if (!boxes.length) box.append(h('div', { class: 'muted' }, 'まだありません。先に範囲を決めて、あとから箱を置いてもかまいません。'));
      else {
        const line = h('div', { class: 'inside' });
        for (const [k, n] of by) line.append(h('span', { class: 'in' }, h('span', { class: 'dot', style: '--dot:' + (k === 'cat-root' ? '#94a3b8' : catColor(k)) }), (k === 'cat-root' ? '未指定' : pal.category(k).name) + ' ' + n));
        box.append(line);
      }
      return { el: box, by, ids: boxes.map((p) => p.id) };
    }
    const branchCats = (pal) => pal.categories.filter((c) => !pal.isLeaf(c.id) && pal.leavesUnder(c.id).some((l) => pal.category(l).size === want) && c.id !== 'cat-root');
    async function pickRuleCat(r) {
      const pal = P();
      const sel = h('select', {}, ...branchCats(pal).map((c) => h('option', { value: c.id, selected: c.id === r.category ? '' : null }, pal.categoryPath(c.id).slice(1).join(' / '))));
      const m = openModal({ title: 'どのカテゴリの規則か', width: 420, dismiss: true, body: h('div', { class: 'form' }, h('label', {}, h('span', { class: 'fn' }, 'カテゴリ（これと、その下で置いた' + (isRoute ? '線' : '箱') + 'に効く）'), sel)), actions: ['spacer', { label: 'やめる', id: 'cancel' }, { label: '決める', primary: true, on: (hd2) => hd2.close(sel.value) }] });
      const id = await m.result;
      if (!id) return false;
      const leaves = pal.leavesUnder(id);
      r.category = id;
      r.candidates = r.candidates.filter((c) => leaves.includes(c));
      draw();
      return true;
    }
    async function addRule(catId) {
      const r = { category: catId || null, candidates: [], removed: false };
      if (!catId && !(await pickRuleCat(r))) return;
      d.rules.push(r);
      draw();
    }
    function ruleRow(pal, r) {
      const leaves = r.category ? pal.leavesUnder(r.category).filter((c) => pal.category(c).size === want) : [];
      const el = h('div', { class: 'rule' },
        h('div', { class: 'rh' },
          h('button', { class: 'rc', title: 'カテゴリを替える', disabled: r.removed ? '' : null, onclick: () => pickRuleCat(r) }, r.category ? pal.category(r.category).name : 'カテゴリを選ぶ'),
          h('span', { class: 'rt' }, isRoute ? 'は、このルートでは' : 'は、この中では'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'ghost icon', title: r.removed ? '消すのをやめる' : 'この規則を消す', onclick: () => { r.removed = !r.removed; draw(); } }, r.removed ? '↺' : '×'),
        ),
      );
      if (r.removed) {
        el.append(h('div', { class: 'muted' }, '確定すると、この規則は消えます'));
        return el;
      }
      const cands = h('div', { class: 'rcands' });
      for (const leaf of leaves) {
        const on = r.candidates.includes(leaf);
        cands.append(h('button', { class: 'rcand' + (on ? ' on' : ''), title: pal.categoryPath(leaf).join(' › '), onclick: () => { r.candidates = on ? r.candidates.filter((c) => c !== leaf) : leaves.filter((c) => c === leaf || r.candidates.includes(c)); draw(); } }, h('span', { class: 'dot', style: '--dot:' + catColor(leaf) }), pal.category(leaf).name));
      }
      el.append(cands);
      if (r.category && !r.candidates.length) el.append(h('div', { class: 'rwarn' }, '候補を 1 つ以上選んでください（選ぶまで、この規則は保存されません）'));
      else if (r.candidates.length === 1) el.append(h('div', { class: 'rok' }, '候補が 1 つなので、置くだけで決まります'));
      else if (r.candidates.length > 1) el.append(h('div', { class: 'muted' }, '候補が ' + r.candidates.length + ' つ。置いたあとで、この中から選びます'));
      return el;
    }
    function sectionRules(pal, inside) {
      const c = chosen();
      const box = h('div', {}, h('div', { class: 'st' }, '規則', c ? h('span', { class: 'cnt' }, c.node ? pal.labelPath(c.node).join(' / ') : '新しい節「' + c.fresh + '」') : null));
      if (!c) {
        box.append(h('div', { class: 'muted' }, isRoute ? '左で、このルートが何かを選ぶと、その節の規則が出ます。長さだけを付けるなら、ラベルは選ばなくてよい。' : '左で、この範囲が何かを選ぶと、その節の規則が出ます。'));
        return box;
      }
      const others = c.node ? store.state.areas.filter((a) => a.id !== (area && area.id) && a.label === c.node).length + store.state.routes.filter((r) => r.id !== (route && route.id) && r.label === c.node).length : 0;
      box.append(h('div', { class: 'muted' }, '規則は、この' + (isRoute ? 'ルート' : 'エリア') + 'ではなく節に付きます。' + (others ? '同じ節の層がほかに ' + others + ' つあり、そこにも効きます。' : '') + (c.node && pal.labelAncestors(c.node).filter((x) => !pal.label(x).root).length ? '祖先の節の規則も効きます。' : '')));
      if (!d.rules.length) box.append(h('div', { class: 'muted' }, 'まだ規則がありません。'));
      for (const r of d.rules) box.append(ruleRow(pal, r));
      const used = new Set(d.rules.filter((r) => !r.removed).map((r) => r.category));
      const adds = h('div', { class: 'pills' });
      for (const [k, n] of inside.by) {
        if (k === 'cat-root' || used.has(k) || pal.isLeaf(k)) continue;
        adds.append(h('button', { onclick: () => addRule(k) }, '＋ ' + pal.category(k).name + '（' + n + '）の規則'));
      }
      adds.append(h('button', { class: 'ghost', onclick: () => addRule(null) }, '＋ ほかのカテゴリの規則'));
      box.append(adds);
      return box;
    }
    function sectionPreview(pal, inside) {
      const box = h('div', {}, h('div', { class: 'st' }, '確定すると'));
      const ok = !!chosen() || (isRoute && !route && hasLenInput());
      if (!ok) {
        box.append(h('div', { class: 'muted' }, isRoute ? '節を選ぶか長さを入れると、通る線がどう変わるかが出ます。' : '節を選ぶと、中の箱がどう変わるかが出ます。'));
        return { el: box, ok: false };
      }
      const pv = store.preview((S) => apply(S));
      if (pv.error) {
        box.append(h('div', { class: 'rwarn' }, pv.error.message));
        return { el: box, ok: false };
      }
      const kind = isRoute ? 'line' : 'box';
      const ids = inside.ids;
      const summ = (objs, p) => (objs.length ? { leaf: objs[0].leaf, candidates: objs[0].candidates, pickupCat: p.category, qty: objs.reduce((s, o) => s + (o.quantity || 0), 0), unlen: objs.some((o) => o.flags.includes('長さ未入力')) } : null);
      const rows = new Map();
      let decided = 0;
      let still = 0;
      for (const id of ids) {
        const p = store.pickup(id);
        const b = summ(app.objects.filter((o) => o.pickup === id && o.kind === kind), p);
        const a = summ(SM.derive.objectsOf(pv.store, pv.store.palette, pv.store.pickup(id)), p);
        let from = stateText(pal, b);
        let to = stateText(pv.store.palette, a);
        if (isRoute) {
          from += b ? '・' + (b.unlen ? '長さ未入力' : fmt(b.qty)) : '';
          to += a ? '・' + (a.unlen ? '長さ未入力' : fmt(a.qty)) : '';
        }
        const key = from + '|' + to;
        if (!rows.has(key)) rows.set(key, { from, to, n: 0, changed: from !== to, done: !!(a && a.leaf && !(isRoute && a.unlen)) });
        rows.get(key).n++;
        if (a && a.leaf && !(b && b.leaf)) decided++;
        if (!(a && a.leaf)) still++;
      }
      const parts = [];
      if (decided) parts.push(decided + ' 本が決まります'.replace('本', isRoute ? '本' : '個'));
      if (still) parts.push(still + (isRoute ? ' 本' : ' 個') + 'は、未確定のままです');
      if (!ids.length) parts.push(isRoute ? 'このルートを通る線は、まだありません' : 'この範囲の中に、箱はまだありません');
      else if (!decided && !still) parts.push('通る ' + ids.length + (isRoute ? ' 本' : ' 個') + 'は、もう決まっています');
      if (isRoute && hasLenInput()) parts.push('長さ 平 ' + (num(d.h) === null ? '—' : d.h) + '／立 ' + (num(d.v) === null ? '—' : d.v) + ' を与えます');
      box.append(h('div', { class: 'sum ' + (still ? 'warn' : 'ok') }, parts.join('。') + '。'));
      if (rows.size) {
        const table = h('table', {}, h('tr', {}, h('th', {}, 'いま'), h('th'), h('th', {}, '確定したあと'), h('th', { class: 'num' }, isRoute ? '本数' : '個数')));
        for (const r of rows.values()) table.append(h('tr', { class: (r.changed ? 'chg ' : '') + (r.done ? 'done' : 'open') }, h('td', {}, r.from), h('td', { class: 'arrow' }, r.changed ? '→' : '＝'), h('td', { class: 'to' }, r.to), h('td', { class: 'num' }, r.n)));
        box.append(table);
      }
      return { el: box, ok: true };
    }
    function commit() {
      if (!(chosen() || (isRoute && !route && hasLenInput()))) return;
      const id = edit(editing ? (isRoute ? 'ルートの意味を直す' : 'エリアの規則を直す') : isRoute ? 'ルートを置く' : 'エリアを囲む', (S) => apply(S));
      if (!id) return;
      lastRootBy[isRoute ? 'route' : 'area'] = d.root;
      if (d.fresh !== null) lastParent = d.parent || d.root;
      hd.close(id);
    }
    function drawRight() {
      const pal = P();
      elRight.innerHTML = '';
      const inside = sectionInside(pal);
      elRight.append(inside.el, sectionRules(pal, inside));
      const pv = sectionPreview(pal, inside);
      elRight.append(pv.el);
      hd.setActions([{ text: '確定は履歴の 1 行。Ctrl+Z でまとめて戻る' }, 'spacer', { label: 'やめる', id: 'cancel' }, { label: editing ? '直す' : isRoute ? 'このルートを確定する' : 'この範囲を確定する', primary: true, disabled: !pv.ok, title: 'Ctrl+Enter', on: commit }]);
    }
    function draw() {
      drawRoots();
      drawValues();
      drawLen();
      drawRight();
    }

    const pal0 = P();
    if (area) {
      d.root = pal0.labelRoot(area.label);
      d.node = area.label;
    } else if (route) {
      d.root = pal0.labelRoot(route.label);
      d.node = route.label;
    } else {
      const roots = pal0.labelRoots().map((r) => r.id);
      const prefer = isRoute ? (roots.includes('lb-laying') ? 'lb-laying' : roots[0]) : roots.includes('lb-floor') ? 'lb-floor' : roots[0];
      const lastRoot = lastRootBy[isRoute ? 'route' : 'area'];
      d.root = roots.includes(lastRoot) ? lastRoot : prefer || null;
    }
    loadRules();
    // ルート: 同じ線分の集まりにもう長さがあれば、欄に入れておく
    if (isRoute && !route) {
      const ex0 = existingLen();
      if (ex0) {
        d.h = ex0.length_h;
        d.v = ex0.length_v;
      }
    }
    const body = h('div', { class: 'am' }, h('div', { class: 'am-left' }, h('div', { class: 'st' }, isRoute ? 'このルートは、何ですか' : 'この範囲は、何ですか'), elRoots, elSearch, elValues, elParent, elLen), elRight);
    hd = openModal({ title: editing ? (isRoute ? 'ルートの意味を直す' : 'エリアの意味を直す') : isRoute ? 'なぞったルート（' + segments.length + ' 線分）に、意味を与える' : '囲んだ範囲に、意味を与える', width: 920, body, onKey: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } } });
    draw();
    elSearch.focus();
    return hd.result;
  }

  /* ======================================================================
   * 右の板
   * ====================================================================== */

  function renderPanel() {
    const el = $('#panel');
    el.innerHTML = '';
    el.append(secCategoryTree(), secDetail());
  }
  const lchip = (labelId) => {
    const l = P().label(labelId);
    return h('span', { class: 'lchip', style: 'background:' + (l ? l.color : '#999') }, l ? P().labelPath(l.id).join('/') : labelId);
  };

  function secCategoryTree() {
    const pal = P();
    const counts = {};
    for (const o of app.objects) if (o.material) counts[o.material] = (counts[o.material] || 0) + (o.quantity || 0);
    const search = h('input', { class: 'search', type: 'search', placeholder: 'カテゴリを探す', value: app.query });
    search.addEventListener('input', () => { app.query = search.value; renderPanel(); const s2 = $('#panel .search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } });
    const q = app.query.trim();
    const match = (id) => !q || pal.categoryPath(id).join('/').includes(q) || pal.categoryDescendants(id).some((d) => pal.category(d).name.includes(q));
    const tree = h('div', { class: 'tree' });
    const row = (c, depth) => {
      const hasKids = pal.categoryChildren(c.id).length > 0;
      const total = pal.leavesUnder(c.id).reduce((s, id) => s + (counts[id] || 0), 0);
      return h('div', { class: 'row' + (app.currentCategory === c.id ? ' on' : ''), style: 'padding-left:' + (6 + depth * 14) + 'px', onclick: () => { app.currentCategory = c.id; renderTools(); renderPanel(); } },
        h('span', { class: 'tg', onclick: (e) => { e.stopPropagation(); if (app.collapsed.has(c.id)) app.collapsed.delete(c.id); else app.collapsed.add(c.id); renderPanel(); } }, hasKids ? (app.collapsed.has(c.id) ? '▸' : '▾') : ''),
        h('span', { class: 'sw', style: 'background:' + (hasKids ? 'transparent' : catColor(c.id)) + (hasKids ? ';border:0' : '') }),
        h('span', {}, c.name, c.components ? h('small', { class: 'dim' }, ' 構成 ' + c.components.length) : null),
        total ? h('span', { class: 'cnt' }, fmt(total) + (c.size === '長さ' ? ' m' : ' 個')) : null,
      );
    };
    const walk = (parent, depth) => {
      const wrap = h('div', { class: 'kids' + (app.collapsed.has(parent) && !q ? ' hide' : '') });
      for (const c of pal.categoryChildren(parent)) {
        if (!match(c.id)) continue;
        wrap.append(row(c, depth));
        if (pal.categoryChildren(c.id).length) wrap.append(walk(c.id, depth + 1));
      }
      return wrap;
    };
    const root = pal.category('cat-root');
    tree.append(h('div', { class: 'row root' + (app.currentCategory === 'cat-root' ? ' on' : ''), onclick: () => { app.currentCategory = 'cat-root'; renderTools(); renderPanel(); } }, h('span', { class: 'tg' }), h('span', {}, root ? root.name : '根'), h('span', { class: 'cnt' }, '純粋な拾い')), walk('cat-root', 1));
    return h('div', { class: 'sec' }, h('h3', {}, h('span', { class: 'badge pickup' }, '拾い'), '置くカテゴリ', h('span', { class: 'dim' }, '— 粗くてよい。層が絞る')), search, tree);
  }

  function secDetail() {
    const sel = app.selection;
    const pal = P();
    if (!sel) return h('div', { class: 'sec' }, h('h3', {}, '選んだもの'), h('div', { class: 'empty' }, '図面の上の、箱・線・エリア・線分・ノードを押すと、ここに出る'));
    if (sel.kind === 'multi') {
      const by = {};
      for (const x of sel.items) by[x.kind] = (by[x.kind] || 0) + 1;
      const nm = { pickup: '拾い', route: 'ルート', area: 'エリア', segment: '線分', node: 'ノード' };
      return h('div', { class: 'sec' }, h('h3', {}, '範囲で選んだもの'), h('div', { class: 'detail' }, h('div', {}, Object.entries(by).map(([k, n]) => h('span', { class: 'lchip', style: 'background:' + (k === 'pickup' ? 'var(--pickup)' : k === 'route' || k === 'area' ? 'var(--layer)' : '#64748b') }, nm[k] + ' ' + n))), h('div', { class: 'muted', style: 'margin:6px 0' }, '線分とノードは、通る線や線分が残っていれば消えない。ルートを消しても骨は残る'), h('div', { class: 'acts' }, h('button', { class: 'danger', onclick: deleteSelection }, 'まとめて消す（' + sel.items.length + '）'), h('button', { onclick: () => { app.selection = null; renderAll(); } }, '選択を外す'))));
    }
    if (sel.kind === 'pickup') return detailPickup(pal, store.pickup(sel.id));
    if (sel.kind === 'area') return detailArea(pal, store.area(sel.id));
    if (sel.kind === 'route') return detailRoute(pal, store.route(sel.id));
    if (sel.kind === 'segment') return detailBone(pal, store.segment(sel.id));
    if (sel.kind === 'node') return detailNode(pal, store.node(sel.id));
    return h('div');
  }
  const head = (badge, t) => h('h3', {}, h('span', { class: 'badge ' + badge }, badge === 'pickup' ? '拾い' : '層'), t);

  function detailPickup(pal, p) {
    if (!p) return h('div');
    const objs = app.objects.filter((o) => o.pickup === p.id);
    const first = objs[0];
    const cands = first ? first.candidates : [];
    const candBox = h('div', { class: 'cands' });
    candBox.append(h('label', { class: p.chosen ? '' : 'on' }, h('input', { type: 'radio', name: 'cand', checked: p.chosen ? null : '', onchange: () => edit('選択を外す', (S) => S.setChosen(p.id, null)) }), ' 層にまかせる（' + (cands.length === 1 ? pal.category(cands[0]).name : cands.length + ' 候補') + '）'));
    for (const c of cands) candBox.append(h('label', { class: p.chosen === c ? 'on' : '' }, h('input', { type: 'radio', name: 'cand', checked: p.chosen === c ? '' : null, onchange: () => edit('候補から選ぶ', (S) => S.setChosen(p.id, c)) }), ' ' + pal.categoryPath(c).slice(1).join(' / ')));
    if (p.chosen && !cands.includes(p.chosen)) candBox.append(h('div', { class: 'flag' }, '選んだ葉「' + pal.category(p.chosen).name + '」は候補の外'));
    const want = p.kind === 'box' ? '個数' : '長さ';
    const catSel = h('select', {}, ...['cat-root'].concat(pal.categoryDescendants('cat-root')).filter((id) => { const c = pal.category(id); return !c.size || c.size === want; }).map((id) => h('option', { value: id, selected: id === p.category ? '' : null }, pal.categoryPath(id).join(' / '))));
    catSel.addEventListener('change', () => edit('拾いのカテゴリを替える', (S) => S.setPickupCategory(p.id, catSel.value)));
    const rows = [h('span', { class: 'k' }, 'カテゴリ'), catSel];
    if (p.kind === 'line') {
      const systems = (store.state.palette.systems || []).filter((x) => x.name);
      const nm = h('input', { type: 'text', value: p.name || '', placeholder: '系統名（1A2 など）', style: 'width:150px', list: 'dl-systems' });
      // 系統（配線表の行）の名前を選ぶと、線のカテゴリもその行の配線にする（いまのカテゴリがその祖先のとき）
      nm.addEventListener('change', () => edit('線の名前', (S) => {
        S.setPickupName(p.id, nm.value);
        const sys = systems.find((x) => x.name === nm.value.trim());
        if (sys && sys.category && pal.category(sys.category) && sys.category !== p.category && pal.categoryUnder(sys.category, p.category)) S.setPickupCategory(p.id, sys.category);
      }));
      rows.push(h('span', { class: 'k' }, '名前'), h('span', {}, nm, h('datalist', { id: 'dl-systems' }, ...systems.map((x) => h('option', { value: x.name }, (x.from || '') + (x.to ? ' → ' + x.to : ''))))));
      for (const nid of store.lineEnds(p)) {
        const inp = h('input', { type: 'number', step: '0.1', value: p.additions[nid] === undefined ? '' : p.additions[nid], placeholder: '余長 m' });
        inp.addEventListener('change', () => edit('余長を入れる', (S) => S.setAddition(p.id, nid, inp.value)));
        rows.push(h('span', { class: 'k' }, '余長 ' + nid), h('span', {}, inp, ' m'));
      }
      // 通る線分: 長さの出どころと、線分ごとの上書き（決定 47）
      const segs = h('table', {}, h('tr', {}, h('th', {}, '線分'), h('th', {}, 'ルートの長さ'), h('th', {}, '上書き 平'), h('th', {}, '上書き 立'), h('th', {}, 'ラベル')));
      for (const sid of p.path) {
        const s = store.segment(sid);
        if (!s) continue;
        const own = (p.lengths || {})[sid];
        const lr = store.routesCovering(sid).filter((x) => !x.label && SM.hasLen(x)).sort((a, b) => a.segments.length - b.segments.length)[0];
        const inH = h('input', { type: 'number', step: '0.1', value: own && own.h !== null ? own.h : '', style: 'width:56px', placeholder: '—' });
        const inV = h('input', { type: 'number', step: '0.1', value: own && own.v !== null ? own.v : '', style: 'width:56px', placeholder: '—' });
        const ap = () => edit('線分の長さを上書き', (S) => S.setLineLength(p.id, sid, inH.value === '' ? null : inH.value, inV.value === '' ? null : inV.value));
        inH.addEventListener('change', ap);
        inV.addEventListener('change', ap);
        segs.append(h('tr', {}, h('td', { style: 'cursor:pointer', onclick: () => { app.selection = { kind: 'segment', id: sid }; renderAll(); } }, sid + (s.riser ? ' 立' : '')), h('td', {}, lr ? lengthText(lr) + (lr.segments.length > 1 ? '（' + lr.segments.length + ' 線分で）' : '') : h('span', { class: 'muted' }, 'なし')), h('td', {}, inH), h('td', {}, inV), h('td', {}, [...SM.derive.labelsOfSegment(store, pal, s).labels].map((l) => pal.label(l) ? pal.labelPath(l).slice(-1)[0] : l).join('・'))));
      }
      rows.push(h('span', { class: 'k' }, '道'), h('span', {}, p.path.length + ' 線分'));
      rows.push(h('div', { style: 'grid-column: 1 / -1' }, segs, h('div', { class: 'muted' }, '長さはルートが与える。ここに入れると、この線についてだけ上書き（ルートがあれば旗「上書き」）。ルートが無いときは、ここに入れるだけで集計に出る')));
    }
    const tbl = h('table', {}, h('tr', {}, h('th', {}, '部材'), h('th', {}, p.kind === 'line' ? '線分・平立' : ''), h('th', { class: 'num' }, '数量'), h('th', {}, '旗')));
    for (const o of objs) tbl.append(h('tr', {}, h('td', {}, o.material ? pal.category(o.material).name : '—'), h('td', {}, o.kind === 'line' ? o.segment + ' ' + (o.part || '—') + (o.addition ? ' +' + fmt(o.addition) : '') : ''), h('td', { class: 'num' }, fmt(o.quantity)), h('td', { class: 'flag' }, o.flags.join(' '))));
    const labels = first ? first.labels : [];
    return h('div', { class: 'sec' }, head('pickup', '選んだ拾い: ' + (p.kind === 'box' ? '箱（個数もの）' : '線（長さもの）')),
      h('div', { class: 'detail' },
        h('div', { class: 'kv' }, ...rows, h('span', { class: 'k' }, '効くラベル'), h('span', {}, labels.length ? labels.map(lchip) : h('span', { class: 'muted' }, 'なし（層の外）'))),
        h('div', { class: 'subt' }, '葉（絞られた結果）'), candBox,
        h('div', { class: 'subt' }, '対象（計算の結果）'), tbl,
        h('div', { class: 'acts' }, h('button', { onclick: () => showPlace(p.kind === 'box' ? { bbox: p.bbox } : { x: store.node(store.lineEnds(p)[0]).x, y: store.node(store.lineEnds(p)[0]).y }) }, '図面で見る'), h('button', { class: 'danger', onclick: deleteSelection }, '消す'))));
  }
  function detailArea(pal, a) {
    if (!a) return h('div');
    const l = pal.label(a.label);
    const inside = boxesIn(store, a.page, a.shape);
    return h('div', { class: 'sec' }, head('layer', '選んだ層: エリア'),
      h('div', { class: 'detail' },
        h('div', { class: 'kv' }, h('span', { class: 'k' }, 'ラベル'), h('span', {}, lchip(a.label)), h('span', { class: 'k' }, '規則'), h('span', {}, (l && l.rules.length) ? l.rules.map((r) => pal.category(r.category).name + ' → ' + r.candidates.map((c) => pal.category(c).name).join('・')).join('／') : h('span', { class: 'muted' }, 'なし')), h('span', { class: 'k' }, '形'), h('span', {}, a.shape.type === 'rect' ? '矩形' : '多角形（' + a.shape.points.length + ' 点）'), h('span', { class: 'k' }, '中の箱'), h('span', {}, inside.length + ' 個')),
        h('div', { class: 'acts' }, h('button', { class: 'primary', onclick: async () => { const id = await openLayerModal({ area: a.id }); if (id) { app.selection = { kind: 'area', id }; renderAll(); } } }, '意味・規則を直す…'), h('button', { class: 'danger', onclick: deleteSelection }, '消す'))));
  }
  // ストロークの詳細（線分を押すと、これが出る。押した線分は focusSeg）
  // ルート（層）の詳細
  function detailRoute(pal, r) {
    if (!r) return h('div');
    const segs = r.segments.map((id) => store.segment(id)).filter(Boolean);
    const through = new Set();
    for (const s of segs) for (const p of store.pickupsThrough(s.id)) through.add(p.id);
    const isLen = !r.label;
    const rows = [h('span', { class: 'k' }, '種類'), h('span', {}, isLen ? '長さルート' : 'ラベルルート'), h('span', { class: 'k' }, '線分'), h('span', {}, segs.length + ' 本（' + segs.map((s) => s.id).join('・') + '）')];
    if (isLen) {
      const inH = h('input', { type: 'number', step: '0.1', value: r.length_h === null ? '' : r.length_h, placeholder: '平 m', style: 'width:64px' });
      const inV = h('input', { type: 'number', step: '0.1', value: r.length_v === null ? '' : r.length_v, placeholder: '立 m', style: 'width:64px' });
      const ap = () => edit('ルートの長さ', (S) => setLengthOn(S, r.page, r.segments, inH.value, inV.value));
      inH.setAttribute('data-role', 'lr-h');
      inV.setAttribute('data-role', 'lr-v');
      inH.addEventListener('change', ap);
      inV.addEventListener('change', ap);
      rows.push(h('span', { class: 'k' }, '長さ'), h('span', {}, '平 ', inH, ' 立 ', inV, ' m'));
    } else {
      const l = pal.label(r.label);
      const lr = lengthRouteOn(r.segments);
      rows.push(h('span', { class: 'k' }, '長さ'), lr
        ? h('span', {}, h('a', { href: '#', 'data-role': 'goto-len', onclick: (e) => { e.preventDefault(); app.selection = { kind: 'route', id: lr.id }; renderAll(); } }, '長さルート ' + lengthText(lr) + ' →'))
        : h('button', { 'data-role': 'add-len', title: 'このルートと同じ線分の集まりに、長さルートを置く', onclick: () => addLengthRouteFor(r) }, '＋ 同じ線分に長さルートを置く'));
      rows.push(h('span', { class: 'k' }, 'ラベル'), h('span', {}, lchip(r.label)), h('span', { class: 'k' }, '規則'), h('span', {}, l && l.rules.length ? l.rules.map((x) => pal.category(x.category).name + ' → ' + x.candidates.map((c) => pal.category(c).name).join('・')).join('／') : h('span', { class: 'muted' }, 'なし')));
    }
    // 同じ線分を覆うほかのルート
    const others = store.state.routes.filter((x) => x.id !== r.id && x.segments.some((s) => r.segments.includes(s)));
    return h('div', { class: 'sec' }, head('layer', '選んだ層: ルート'),
      h('div', { class: 'detail' },
        h('div', { class: 'kv' }, ...rows, h('span', { class: 'k' }, '通る線'), h('span', {}, through.size ? [...through].map((id) => { const p = store.pickup(id); return h('a', { href: '#', onclick: (e) => { e.preventDefault(); app.selection = { kind: 'pickup', id }; renderAll(); } }, (p.name || p.id) + ' ' + pal.category(p.category).name); }) : 'なし'), h('span', { class: 'k' }, '重なるルート'), h('span', {}, others.length ? others.map((x) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); app.selection = { kind: 'route', id: x.id }; renderAll(); } }, routeName(pal, x) + ' ')) : 'なし')),
        h('div', { class: 'muted', style: 'margin:4px 0' }, isLen ? '長さは、通る線がこのルートの全部の線分を通るとき、1 回だけ数える。線の側に線分ごとの上書きがあれば、そちらが勝つ（旗「上書き」）。平・立とも空にすると、長さルートを外す' : 'ラベルは、覆う線分を通る線に効く（祖先の節の規則も）。同じ木のラベルを同じ線分に重ねると置き換わる。長さはラベルではなく別の層（長さルート）。一部だけ重なる長さルートは「重なるルート」に出る'),
        h('div', { class: 'acts' }, isLen ? null : h('button', { class: 'primary', onclick: async () => { const id = await openLayerModal({ route: r.id }); if (id) { app.selection = { kind: 'route', id }; renderAll(); } } }, '意味・規則を直す…'), h('button', { class: 'danger', onclick: () => edit('ルートを外す', (S) => S.removeRoute(r.id)) }, 'ルートを外す（骨は残す）'), h('button', { class: 'danger', onclick: deleteSelection, disabled: through.size ? '' : null }, '骨ごと消す'))));
  }
  // 線分の集まり（ちょうどその集まり）に掛かっている長さルート
  function lengthRouteOn(segments) {
    return store.state.routes.find((r) => !r.label && r.segments.length === segments.length && r.segments.every((x) => segments.includes(x))) || null;
  }
  // その線分の集まりの長さを入れる。平・立とも空なら長さルートを外す
  function setLengthOn(S, pageId, segments, hh, vv) {
    const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
    const H = num(hh);
    const V = num(vv);
    const ex = S.state.routes.find((r) => !r.label && r.segments.length === segments.length && r.segments.every((x) => segments.includes(x)));
    if (H === null && V === null) {
      if (ex) S.removeRoute(ex.id);
      return null;
    }
    if (ex) {
      S.setRouteLength(ex.id, H, V);
      return ex.id;
    }
    return S.addRoute(pageId, segments, { length_h: H, length_v: V }, S.palette);
  }
  // 長さの欄（平・立）。change で入れる
  function lengthInputs(pageId, segments, label, role) {
    const ex = lengthRouteOn(segments);
    const inH = h('input', { type: 'number', step: '0.1', value: ex && ex.length_h !== null ? ex.length_h : '', placeholder: '平 m', style: 'width:64px', 'data-role': role + '-h' });
    const inV = h('input', { type: 'number', step: '0.1', value: ex && ex.length_v !== null ? ex.length_v : '', placeholder: '立 m', style: 'width:64px', 'data-role': role + '-v' });
    const ap = () => edit(label, (S) => setLengthOn(S, pageId, segments, inH.value, inV.value));
    inH.addEventListener('change', ap);
    inV.addEventListener('change', ap);
    return h('span', {}, '平 ', inH, ' 立 ', inV, ' m');
  }
  // ラベルルートと同じ線分の集まりに、長さルートを置く（平・立を訊く）→ 置いた長さルートを選ぶ
  async function addLengthRouteFor(r) {
    const inH = h('input', { type: 'number', step: '0.1', placeholder: '平 m', style: 'width:80px', 'data-role': 'newlen-h' });
    const inV = h('input', { type: 'number', step: '0.1', placeholder: '立 m', style: 'width:80px', 'data-role': 'newlen-v' });
    const m = openModal({ title: '長さルートを置く（' + r.segments.length + ' 線分）', width: 420, dismiss: true, body: h('div', {}, h('div', {}, '平 ', inH, '　立 ', inV, ' m'), h('div', { class: 'muted', style: 'margin-top:6px' }, 'このラベルルートと同じ線分の集まりに、長さの層を 1 枚置きます。線分ごとに違う長さなら、線分を選んで「この線分の長さ」で入れてください。')), onKey: (e, hd) => { if (e.key === 'Enter') { e.preventDefault(); hd.close('ok'); } }, actions: ['spacer', { label: 'やめる', id: 'cancel' }, { label: '置く', primary: true, id: 'ok' }] });
    setTimeout(() => inH.focus(), 30);
    if ((await m.result) !== 'ok') return;
    if (inH.value === '' && inV.value === '') return toast('平か立のどちらかを入れてください', 2500);
    const id = edit('長さルートを置く', (S) => setLengthOn(S, r.page, r.segments, inH.value, inV.value));
    if (id) { app.selection = { kind: 'route', id }; renderAll(); }
  }
  const routeName = (pal, r) => (r.label ? pal.labelPath(r.label).join('/') : '長さ ' + lengthText(r)) + '（' + r.segments.length + '）';

  // 骨（線分）の詳細。層でも拾いでもない土台
  function detailBone(pal, s) {
    if (!s) return h('div');
    const through = store.pickupsThrough(s.id);
    const routes = store.routesCovering(s.id);
    const ls = SM.derive.labelsOfSegment(store, pal, s);
    return h('div', { class: 'sec' }, h('h3', {}, '骨: 線分（層でも拾いでもない）'),
      h('div', { class: 'detail' },
        h('div', { class: 'kv' }, h('span', { class: 'k' }, '線分'), h('span', {}, s.id + (s.riser ? '（立）' : '')), h('span', { class: 'k' }, 'この線分の長さ'), lengthInputs(s.page, [s.id], '線分に長さを入れる', 'slen'), h('span', { class: 'k' }, '覆うルート'), h('span', {}, routes.length ? routes.map((r) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); app.selection = { kind: 'route', id: r.id }; renderAll(); } }, routeName(pal, r) + ' ')) : h('span', { class: 'muted' }, 'なし')), h('span', { class: 'k' }, '通る線'), h('span', {}, through.length ? through.map((p) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); app.selection = { kind: 'pickup', id: p.id }; renderAll(); } }, (p.name || p.id) + ' ')) : 'なし'), h('span', { class: 'k' }, '効くラベル'), h('span', {}, ...[...ls.labels].map(lchip))),
        ls.straddles.length ? h('div', { class: 'flag' }, 'エリアの境を跨いでいる（' + ls.straddles.length + '）。線やルートの道具で線分の上を押すと、そこで切れる') : null,
        h('div', { class: 'muted', style: 'margin-top:4px' }, '「この線分の長さ」は、この線分 1 本を覆う長さルートとして入る（いくつかの線分にまとめて 1 つの長さなら、ルートの道具でなぞる）。特定の線だけ違う長さにするなら、線を選んで上書き'),
        h('div', { class: 'acts' }, h('button', { class: 'danger', onclick: deleteSelection, disabled: through.length ? '' : null }, '消す'))));
  }
  function detailNode(pal, n) {
    if (!n) return h('div');
    const segs = store.segmentsAt(n.id);
    return h('div', { class: 'sec' }, head('layer', '選んだ層: ノード'), h('div', { class: 'detail' }, h('div', { class: 'kv' }, h('span', { class: 'k' }, '位置'), h('span', {}, fmt(n.x) + ', ' + fmt(n.y) + ' pt'), h('span', { class: 'k' }, '線分'), h('span', {}, segs.length + ' 本')), h('div', { class: 'muted' }, 'ドラッグで動かせる。線の端なら、余長は線（拾い）の側で入れる'), h('div', { class: 'acts' }, h('button', { class: 'danger', onclick: deleteSelection, disabled: segs.length ? '' : null }, '消す'))));
  }

  /* ======================================================================
   * 下の板（対象・集計・照合）
   * ====================================================================== */

  /* ======================================================================
   * 集計の画面（タブ「集計」）
   * ====================================================================== */

  const palExpected = () => ((store.state.palette && store.state.palette.expected) || []).filter((e) => P().category(e.category) && e.labels.every((l) => P().label(l)));
  const hasExpected = () => palExpected().length > 0 || (!!P().label('lb-room-01') && !!P().category('cat-GS100'));
  function renderSum() {
    const el = $('#sum');
    el.innerHTML = '';
    const tabs = [['table', '集計表'], ['objects', '対象の一覧']];
    if (hasExpected()) tabs.push(['check', '照合（器具表）']);
    if (!tabs.some((t) => t[0] === app.sumTab)) app.sumTab = 'table';
    el.append(
      h('div', { class: 'subtabs' }, ...tabs.map(([id, name]) => h('button', { class: app.sumTab === id ? 'on' : '', onclick: () => { app.sumTab = id; renderSum(); } }, name)), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, '表の行・セルを押すと、拾いの画面でその場所へ')),
      h('div', { class: 'sumbody bbody' }, app.sumTab === 'objects' ? viewObjects() : app.sumTab === 'check' ? viewCheck() : viewTable()),
    );
  }
  function selectPickup(id, pageId) {
    setScreen('pick');
    if (pageId !== app.pageId) setPage(pageId);
    app.selection = { kind: 'pickup', id };
    const p = store.pickup(id);
    if (p && p.kind === 'box') showPlace({ bbox: p.bbox });
    renderAll();
  }
  function viewObjects() {
    const pal = P();
    const objs = app.objects;
    const tbl = h('table', {}, h('tr', {}, h('th', {}, '拾い'), h('th', {}, 'ページ'), h('th', {}, '種類'), h('th', {}, '部材'), h('th', {}, 'ラベル'), h('th', {}, '線分・平立'), h('th', { class: 'num' }, '長さ'), h('th', { class: 'num' }, '余長'), h('th', { class: 'num' }, '本数'), h('th', { class: 'num' }, '数量'), h('th', {}, '旗')));
    for (const o of objs) {
      const pg = store.page(o.page);
      tbl.append(h('tr', { class: 'row' + (isSel('pickup', o.pickup) ? ' on' : ''), onclick: () => selectPickup(o.pickup, o.page) }, h('td', {}, o.pickup + (o.name ? ' ' + o.name : '')), h('td', {}, pg ? 'p.' + pg.index : o.page), h('td', {}, o.kind === 'box' ? '個数' : '長さ'), h('td', {}, o.material ? pal.category(o.material).name : '—'), h('td', {}, o.labels.map((l) => pal.labelPath(l).slice(-1)[0]).join('・')), h('td', {}, o.segment ? o.segment + ' ' + (o.part || '—') : ''), h('td', { class: 'num' }, fmt(o.length)), h('td', { class: 'num' }, o.addition ? fmt(o.addition) : ''), h('td', { class: 'num' }, o.count), h('td', { class: 'num' }, fmt(o.quantity)), h('td', { class: 'ng' }, o.flags.join(' '))));
    }
    const flagged = objs.filter((o) => o.flags.length).length;
    return h('div', {}, h('div', { class: 'bar' }, h('b', {}, objs.length + ' 対象'), h('span', { class: 'muted' }, '（拾い ' + store.state.pickups.length + '）'), flagged ? h('span', { class: 'ng' }, '旗 ' + flagged) : h('span', { class: 'ok' }, '旗なし')), objs.length ? tbl : h('div', { class: 'empty' }, 'まだ拾いがありません'));
  }
  const keyName = (k) => (k === 'material' ? '部材' : k === 'name' ? '系統（線の名前）' : k === 'part' ? '平立' : (P().label(k) || { name: k }).name);
  // 観点: パレットに保存した観点か、その場で組む観点（行・列の鍵とカテゴリの絞り）
  function currentView() {
    const pal = P();
    const saved = (pal.views || []).find((v) => v.id === app.viewId);
    if (saved) return saved;
    const keys = ['material', 'name', 'part'].concat(pal.labelRoots().map((r) => r.id));
    const c = app.custom;
    c.rows = c.rows.filter((k) => keys.includes(k));
    c.cols = c.cols.filter((k) => keys.includes(k));
    if (!c.rows.length) c.rows = ['material'];
    return { id: '', name: 'その場で組む', under: c.under && pal.category(c.under) ? c.under : null, labels: [], rows: c.rows, cols: c.cols.length ? c.cols : [] };
  }
  function keyPicker(axis) {
    const pal = P();
    const c = app.custom;
    const list = c[axis];
    const keys = ['material', 'name', 'part'].concat(pal.labelRoots().map((r) => r.id));
    const box = h('span', { class: 'keys' });
    list.forEach((k, i) => box.append(h('span', { class: 'key' }, keyName(k), h('button', { class: 'ghost icon', title: '外す', onclick: () => { list.splice(i, 1); renderSum(); } }, '×'))));
    const rest = keys.filter((k) => !c.rows.includes(k) && !c.cols.includes(k));
    if (rest.length) {
      const sel = h('select', {}, h('option', { value: '' }, '＋ 足す'), ...rest.map((k) => h('option', { value: k }, keyName(k))));
      sel.addEventListener('change', () => { if (sel.value) { list.push(sel.value); renderSum(); } });
      box.append(sel);
    }
    return box;
  }
  function tableCsv(view, tb) {
    const esc = (x) => (/[",\n]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : String(x));
    const lines = [[view.rows.map(keyName).join(' / ') + ' \\ ' + (view.cols.map(keyName).join(' / ') || '計')].concat(tb.cols.map((c) => c || '—'), ['計'])];
    for (const r of tb.rows) lines.push([r || '—'].concat(tb.cols.map((c) => { const cell = tb.cells.get(r + '|' + c); return cell ? cell.sum : ''; }), [tb.rowSums[r]]));
    lines.push(['計'].concat(tb.cols.map((c) => tb.colSums[c]), [SM.round(Object.values(tb.rowSums).reduce((a, b) => a + b, 0), 2)]));
    return '\ufeff' + lines.map((l) => l.map(esc).join(',')).join('\r\n');
  }
  function viewTable() {
    const pal = P();
    const view = currentView();
    const sel = h('select', {}, h('option', { value: '', selected: !app.viewId ? '' : null }, 'その場で組む'), ...(pal.views || []).map((v) => h('option', { value: v.id, selected: v.id === app.viewId ? '' : null }, v.name)));
    sel.addEventListener('change', () => { app.viewId = sel.value || null; renderSum(); });
    const tb = SM.project.table(pal, app.objects, view);
    const bar = h('div', { class: 'bar' }, '観点: ', sel);
    if (!view.id) {
      const under = h('select', {}, h('option', { value: '' }, '全部のカテゴリ'), ...pal.categories.filter((c) => !pal.isLeaf(c.id) && c.parent).map((c) => h('option', { value: c.id, selected: c.id === app.custom.under ? '' : null }, pal.categoryPath(c.id).slice(1).join(' / ') + ' の下')));
      under.addEventListener('change', () => { app.custom.under = under.value || null; renderSum(); });
      bar.append(h('span', { class: 'muted' }, '行'), keyPicker('rows'), h('span', { class: 'muted' }, '列'), keyPicker('cols'), under);
    }
    bar.append(h('span', { class: 'spacer' }), h('span', { class: 'muted' }, tb.count + ' 対象（未確定・長さ未入力は入らない）'), h('button', { disabled: tb.rows.length ? null : '', onclick: () => download(tableCsv(view, tb), (view.name || '集計') + '.csv', 'text/csv') }, 'CSV'));
    const tbl = h('table', {});
    const hdr = h('tr', {}, h('th', {}, view.rows.map(keyName).join(' ／ ') + (view.cols.length ? ' ＼ ' + view.cols.map(keyName).join(' ／ ') : '')));
    for (const c of tb.cols) hdr.append(h('th', {}, c || '数量'));
    if (view.cols.length) hdr.append(h('th', { class: 'sum' }, '計'));
    tbl.append(hdr);
    for (const r of tb.rows) {
      const tr = h('tr', {}, h('th', {}, r || '—'));
      for (const c of tb.cols) {
        const cell = tb.cells.get(r + '|' + c);
        tr.append(h('td', { class: 'num' + (cell ? ' row' : ''), onclick: cell ? () => { const o = app.objects.find((x) => cell.objects.includes(x.key)); if (o) selectPickup(o.pickup, o.page); } : null }, cell ? fmt(cell.sum) : ''));
      }
      if (view.cols.length) tr.append(h('td', { class: 'num sum' }, fmt(tb.rowSums[r])));
      tbl.append(tr);
    }
    if (view.cols.length) {
      const foot = h('tr', {}, h('th', { class: 'sum' }, '計'));
      for (const c of tb.cols) foot.append(h('td', { class: 'num sum' }, fmt(tb.colSums[c])));
      foot.append(h('td', { class: 'num sum' }, fmt(Object.values(tb.rowSums).reduce((a, b) => a + b, 0))));
      tbl.append(foot);
    }
    return h('div', {}, bar, tb.rows.length ? tbl : h('div', { class: 'empty' }, app.objects.length ? 'この観点に入る対象がありません（未確定・長さ未入力のものは入りません）' : 'まだ拾いがありません'));
  }
  function viewCheck() {
    if (palExpected().length) return viewCheckPalette();
    const pal = P();
    const exp = SMFixture.expected();
    const placed = {};
    for (const o of app.objects) {
      if (o.kind !== 'box' || !o.material || o.quantity === null) continue;
      const room = SM.derive.deepestIn(pal, new Set(o.labels), 'lb-floor')[0];
      if (!room) continue;
      placed[room] = placed[room] || {};
      placed[room][o.material] = (placed[room][o.material] || 0) + o.quantity;
    }
    const tbl = h('table', {}, h('tr', {}, h('th', {}, '部屋（器具表）'), h('th', {}, '記号'), h('th', { class: 'num' }, '見込み'), h('th', { class: 'num' }, '置いた'), h('th', { class: 'num' }, 'あと')));
    let done = 0;
    let total = 0;
    for (const [room, items] of Object.entries(exp)) {
      if (!pal.label(room)) continue;
      for (const [mat, n] of Object.entries(items)) {
        const got = (placed[room] || {})[mat] || 0;
        total += n;
        done += Math.min(got, n);
        const left = n - got;
        tbl.append(h('tr', { class: 'row', onclick: () => { const a = store.state.areas.find((x) => x.label === room); if (a) { setPage(a.page); app.selection = { kind: 'area', id: a.id }; renderAll(); } } }, h('td', {}, pal.label(room).name), h('td', {}, pal.category(mat).name), h('td', { class: 'num' }, n), h('td', { class: 'num' }, got), h('td', { class: 'num ' + (left === 0 ? 'ok' : left < 0 ? 'ng' : '') }, left)));
      }
    }
    return h('div', {}, h('div', { class: 'bar' }, h('b', {}, '器具表（p.36）との照合'), h('span', { class: 'muted' }, '置いた ' + done + ' / ' + total + ' 台。行を押すと、その部屋のエリアへ')), tbl);
  }

  // パレットの見込み（解析が表から読んだ個数。パレットの画面で直せる）との照合
  function viewCheckPalette() {
    const pal = P();
    const list = palExpected();
    const tbl = h('table', {}, h('tr', {}, h('th', {}, '条件（ラベル）'), h('th', {}, '部材'), h('th', { class: 'num' }, '見込み'), h('th', { class: 'num' }, '置いた'), h('th', { class: 'num' }, 'あと')));
    let done = 0;
    let total = 0;
    for (const e of list) {
      let got = 0;
      for (const o of app.objects) {
        if (o.material !== e.category && o.leaf !== e.category) continue;
        if (o.quantity === null) continue;
        if (!e.labels.every((l) => o.labels.includes(l))) continue;
        got += o.kind === 'box' ? o.quantity : 1;
      }
      total += e.count;
      done += Math.min(got, e.count);
      const left = e.count - got;
      tbl.append(h('tr', { class: 'row', onclick: () => { const a = store.state.areas.find((x) => e.labels.includes(x.label)); if (a) { setScreen('pick'); setPage(a.page); app.selection = { kind: 'area', id: a.id }; renderAll(); } else toast('この条件のエリアは、まだ図面にありません', 2000); } },
        h('td', {}, e.labels.map((l) => pal.labelPath(l).join(' / ')).join(' × ') || '（条件なし）'), h('td', {}, pal.category(e.category).name), h('td', { class: 'num' }, e.count), h('td', { class: 'num' }, got), h('td', { class: 'num ' + (left === 0 ? 'ok' : left < 0 ? 'ng' : '') }, left)));
    }
    return h('div', {}, h('div', { class: 'bar' }, h('b', {}, '見込み（表に書いてある個数）との照合'), h('span', { class: 'muted' }, '置いた ' + done + ' / ' + total + '。行を押すと、そのエリアへ。見込みはパレットの画面で直せます')), tbl);
  }

  /* ======================================================================
   * 左・ヘッダ・配線
   * ====================================================================== */

  /* ---- ページの一覧（縮小画像は見えたものから描く） ---- */
  const thumbObs = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { thumbObs.unobserve(e.target); queueThumb(Number(e.target.dataset.index)); }
  }, { root: $('#pages'), rootMargin: '300px' }) : null;
  const thumbQ = [];
  let thumbBusy = false;
  function thumbFor(index) {
    let c = app.thumbs.get(index);
    if (!c) {
      c = h('canvas', { class: 'thumb', 'data-index': index, width: 1, height: 1 });
      app.thumbs.set(index, c);
      if (thumbObs) thumbObs.observe(c);
      else queueThumb(index);
    }
    return c;
  }
  async function queueThumb(index) {
    thumbQ.push(index);
    if (thumbBusy) return;
    thumbBusy = true;
    while (thumbQ.length) {
      const k = thumbQ.shift();
      const c = app.thumbs.get(k);
      const p = app.pdfPages.get(k);
      if (!c || !p) continue;
      const vp0 = p.getViewport({ scale: 1 });
      const sc = 168 / vp0.width;
      const vp = p.getViewport({ scale: sc * Math.min(2, window.devicePixelRatio || 1) });
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      try {
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        await p.render({ canvasContext: g, viewport: vp }).promise;
      } catch (e) {
        /* 描けなくても一覧は使える */
      }
    }
    thumbBusy = false;
  }
  function renamePage(p) {
    const input = h('input', { type: 'text', value: p.title, style: 'width:100%' });
    const m = openModal({ title: 'ページの題（p.' + p.index + '）', width: 420, dismiss: true, body: h('div', { class: 'form' }, input, h('div', { class: 'muted', style: 'margin-top:6px' }, '図面番号や階など、探しやすい題にしておくと一覧で見つけやすくなります')), onKey: (e, hd) => { if (e.key === 'Enter') { e.preventDefault(); hd.close(input.value.trim()); } }, actions: ['spacer', { label: 'やめる', id: 'cancel' }, { label: '決める', primary: true, on: (hd) => hd.close(input.value.trim()) }] });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    m.result.then((t) => { if (t && t !== p.title) edit('ページの題', (S) => S.setPageTitle(p.id, t)); });
  }
  function renderPages() {
    const el = $('#pages');
    el.innerHTML = '';
    const all = store.state.pages;
    const pages = SMA.pickPages(store.state);
    $('#pagecount').textContent = all.length ? (pages.length < all.length ? pages.length + ' / ' + all.length + ' 枚' : all.length + ' 枚') : '';
    const q = app.pageQuery.trim();
    for (const p of pages) {
      if (q && !(p.title + ' p.' + p.index).includes(q)) continue;
      const n = store.pickupsOn(p.id).length;
      const m = store.areasOn(p.id).filter((a) => !isFull(a)).length + store.routesOn(p.id).length;
      const full = store.areasOn(p.id).filter((a) => isFull(a)).map((a) => (P().label(a.label) || { name: '?' }).name);
      el.append(
        h('div', { class: 'item' + (p.id === app.pageId ? ' on' : ''), onclick: () => setPage(p.id), ondblclick: () => renamePage(p), title: 'ダブルクリックで題を直す' },
          app.pdf ? thumbFor(p.index) : null,
          h('div', { class: 'pt' }, p.title),
          h('div', { class: 'n' }, (p.title === 'p.' + p.index ? '' : 'p.' + p.index) + (m ? '　層 ' + m : '') + (n ? '　拾い ' + n : '') + (full.length ? '　' + full.join('・') : '')),
        ),
      );
    }
    if (!pages.length) el.append(h('div', { class: 'empty', style: 'margin:8px' }, '図面の PDF を開くと、ここにページが並びます'));
    else if (pages.length < all.length) el.append(h('div', { class: 'muted', style: 'margin:8px' }, '図面解析で「拾う」に印を付けたページだけを出しています（ほかに ' + (all.length - pages.length) + ' 枚）。', h('a', { href: '#', onclick: (e) => { e.preventDefault(); setScreen('analyze'); } }, '図面解析へ')));
  }
  function renderChips() {
    const el = $('#chips');
    el.innerHTML = '';
    const pg = page();
    if (!pg) return;
    el.append(h('span', { class: 'ptitle', title: 'ダブルクリックで題を直す', ondblclick: () => renamePage(pg) }, pg.title));
    for (const a of store.areasOn(pg.id)) {
      if (!isFull(a)) continue;
      const l = P().label(a.label);
      el.append(h('button', { class: 'chip' + (isSel('area', a.id) ? ' sel' : ''), style: '--chip:' + (l ? l.color : '#999'), title: 'ページ全体の層。押して選ぶ', onclick: () => { app.selection = isSel('area', a.id) ? null : { kind: 'area', id: a.id }; renderAll(); } }, l ? P().labelPath(l.id).join(' / ') : '?'));
    }
    el.append(h('button', { class: 'chip add', title: 'このページ全体に掛かる層（階・工事種目など）を置く', onclick: () => openLayerModal({ page: pg.id, shape: { type: 'rect', points: [[0, 0], [pg.width, pg.height]] } }) }, '＋ ページ全体の層'));
  }
  function renderTools() {
    const el = $('#tools');
    el.innerHTML = '';
    for (const t of TOOLS.filter((x) => x.group === 'common')) el.append(h('button', { class: 'tool' + (curToolId === t.id ? ' on' : ''), title: t.hint, onclick: () => setTool(t.id) }, t.name, h('kbd', {}, t.key)));
    for (const grp of ['pickup', 'layer']) {
      const g = h('div', { class: 'grp ' + grp }, h('span', { class: 'gname' }, grp === 'pickup' ? '拾い' : '層'));
      for (const t of TOOLS.filter((x) => x.group === grp)) g.append(h('button', { class: 'tool' + (curToolId === t.id ? ' on' : ''), title: t.hint, onclick: () => setTool(t.id) }, t.name, h('kbd', {}, t.key)));
      el.append(g);
    }
    const c = P().category(app.currentCategory);
    el.append(h('span', { class: 'cur' }, '置くカテゴリ: ', h('b', {}, c ? P().categoryPath(c.id).join(' / ') : '—')));
  }
  function renderLayers() {
    const el = $('#layers');
    el.innerHTML = '';
    el.append(h('span', { class: 'lt' }, '表示'));
    for (const [k, name] of [['area', 'エリア'], ['route', 'ルート'], ['pickup', '拾い'], ['label', '名前']]) {
      const cb = h('input', { type: 'checkbox', checked: app.layers[k] ? '' : null });
      cb.addEventListener('change', () => { app.layers[k] = cb.checked; drawOverlay(); });
      el.append(h('label', {}, cb, name));
    }
  }

  /* ---- 最初の画面（図面が開いていないとき） ---- */
  function renderWelcome() {
    const el = $('#welcome');
    const on = !app.pdf;
    el.classList.toggle('on', on);
    if (!on) return;
    el.innerHTML = '';
    const d = store.state.doc || {};
    const pal = P();
    const nCat = pal.categories.length - 1;
    const nLab = pal.labels.length;
    const card = h('div', { class: 'wcard' });
    if (d.pages && store.state.pages.length) {
      card.append(h('h2', {}, 'この作業の図面を開いてください'), h('p', {}, '「' + (d.name || '図面') + '」（' + d.pages + ' ページ）。PDF は書き出した作業に含まれないので、もう一度選んでください。'), h('div', { class: 'wacts' }, h('button', { class: 'primary big', onclick: () => $('#file-pdf').click() }, '図面の PDF を選ぶ')));
    } else {
      card.append(
        h('h2', {}, '図面の PDF を開いて始めます'),
        h('p', {}, 'ここへドロップするか、ボタンで選んでください。PDF はこのブラウザの中にだけ置かれ、どこへも送られません。'),
        h('div', { class: 'wacts' }, h('button', { class: 'primary big', onclick: () => $('#file-pdf').click() }, '図面の PDF を選ぶ'), h('button', { onclick: () => $('#file').click() }, '書き出した作業（JSON）を読み込む')),
      );
    }
    card.append(
      h('div', { class: 'wpal' },
        h('div', { class: 'wt' }, 'パレット（型）', h('span', { class: 'dim' }, nCat || nLab ? '　部材カテゴリ ' + nCat + '・層のラベル ' + nLab : '　まだ空です')),
        h('p', {}, '拾うもの（部材カテゴリ）と、図面に重ねる意味（層のラベルと規則）の一覧です。図面を開く前に作っておけます。'),
        h('div', { class: 'wacts' }, h('button', { onclick: () => setScreen('palette') }, 'パレットを作る・見る'), h('button', { onclick: () => loadSamplePalette() }, 'サンプルのパレットを読み込む')),
      ),
      h('div', { class: 'whow' },
        h('div', { class: 'wt' }, '使い方の流れ'),
        h('ol', {},
          h('li', {}, h('b', {}, '層'), ' — 部屋や「ラック上」などの範囲をエリアで囲み、配線の通り道をルートでなぞって、意味（ラベル）を与えます。ラベルには「この中では、照明器具は GS100」のような規則が付けられます'),
          h('li', {}, h('b', {}, '拾い'), ' — 右の木で粗いカテゴリを選び、記号を箱で囲う・配線を線で引く。重なった層の規則で、部材が決まっていきます'),
          h('li', {}, h('b', {}, '集計'), ' — 部材 × 部屋、系統 × 区間 などの表に。CSV で書き出せます'),
        ),
      ),
    );
    el.append(card);
  }

  /* ---- 画面の切り替え ---- */
  function setScreen(id) {
    if (app.screen === id) return;
    if (id !== 'pick' && curTool && curTool.cancel) curTool.cancel();
    app.screen = id;
    for (const b of $$('#apptabs button')) b.classList.toggle('on', b.dataset.screen === id);
    for (const sc of $$('.screen')) sc.classList.toggle('on', sc.id === 'screen-' + id);
    closeMenu();
    if (id === 'pick') setTimeout(() => { resize(); if (app.needFit) fit(); else applyView(); }, 0);
    if (id === 'analyze' && anScreen) anScreen.shown();
    renderAll();
  }

  function renderAll() {
    renderPages();
    renderChips();
    renderTools();
    renderPanel();
    renderWelcome();
    drawOverlay();
    if (app.screen === 'sum') renderSum();
    if (app.screen === 'palette' && palScreen) palScreen.render();
    if (app.screen === 'analyze' && anScreen) anScreen.render();
    const d = store.state.doc || {};
    $('#docname').textContent = d.name ? d.name + (d.pages ? '（' + d.pages + ' ページ）' : '') : '';
    $('#b-undo').disabled = !store.undoStack.length;
    $('#b-redo').disabled = !store.redoStack.length;
  }

  /* ---- 書き出し・読み込み ---- */
  async function download(text, name, type) {
    if (ENV === 'itera' && MetaOS.host && MetaOS.host.showSaveDialog) {
      const ext = name.slice(name.lastIndexOf('.'));
      const path = await MetaOS.host.showSaveDialog({ title: '書き出す', filters: [ext], defaultName: name, defaultDir: 'data/apps/hiroi-tool' });
      if (!path) return;
      await MetaOS.fs.write(path, text, { overwrite: true });
      toast('書き出した: ' + path, 3000);
      return;
    }
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'application/json' })), download: name });
    document.body.append(a);
    a.click();
    a.remove();
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  function saveJob() {
    const base = ((store.state.doc && store.state.doc.name) || '作業').replace(/\.pdf$/i, '');
    download(JSON.stringify(Object.assign({ kind: 'hiroi-job' }, store.state), null, 1), base + '_拾い_' + stamp() + '.json');
  }
  function savePalette() {
    download(JSON.stringify({ kind: 'hiroi-palette', format: 1, palette: store.state.palette }, null, 1), 'パレット_' + (P().name || stamp()) + '.json');
  }
  // パレットを入れる。置き換えるか足し合わせるかを訊く（空なら訊かずに置き換える）
  async function applyPalette(def, label) {
    const cur = store.state.palette;
    const empty = cur.categories.length <= 1 && !cur.labels.length;
    let mode = 'replace';
    if (!empty) {
      const m = openModal({ title: label + 'を入れる', width: 520, dismiss: true, body: h('div', {}, h('p', {}, 'いまのパレット（部材カテゴリ ' + (cur.categories.length - 1) + '・ラベル ' + cur.labels.length + '）があります。'), h('ul', {}, h('li', {}, h('b', {}, '置き換える'), ' — いまのパレットを捨てて入れ替えます。図面の上の層や拾いが使っているものが新しいパレットに無ければ、置き換えません'), h('li', {}, h('b', {}, '足し合わせる'), ' — いまのものは残し、無いもの（id で見る）だけを足します'))), actions: ['spacer', { label: 'やめる', id: 'cancel' }, { label: '足し合わせる', id: 'merge' }, { label: '置き換える', primary: true, id: 'replace' }] });
      mode = await m.result;
      if (!mode) return false;
    }
    if (mode === 'merge') {
      const r = edit(label + 'を足し合わせる', (S) => S.mergePalette(def));
      if (r) toast('足した: 部材カテゴリ ' + r.categories + '・ラベル ' + r.labels, 3000);
      return !!r;
    }
    const pv = store.preview((S) => S.replacePalette(def));
    if (pv.result && !pv.result.ok) {
      toast('置き換えられない: 図面の上で使っているものが新しいパレットに無い（' + pv.result.missing.length + ' 件）。足し合わせるか、先に層・拾いを消してください', 6000);
      return false;
    }
    edit(label + 'に置き換える', (S) => S.replacePalette(def));
    app.currentCategory = 'cat-root';
    toast(label + 'を入れた', 2500);
    return true;
  }
  function loadSamplePalette() {
    return applyPalette(SMFixture.palette(), 'サンプルのパレット');
  }
  async function loadJsonFile(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.kind === 'hiroi-palette' && data.palette) return applyPalette(data.palette, 'パレット「' + file.name + '」');
      let st = data;
      if (st.kind) delete st.kind;
      st = SM.migrate(st, { doc4: { name: 'source.pdf', pages: 76 } });
      if (!st || !st.palette || !st.pages) throw new Error('作業でもパレットでもない形です');
      if (store.state.pickups.length + store.state.areas.length + store.state.routes.length && !(await confirmBox('作業を読み込む', 'いまの作業を、読み込んだもの（' + file.name + '）に入れ替えます。よいですか', '入れ替える'))) return;
      const keep = app.pdf && st.doc && st.doc.fingerprint && store.state.doc && st.doc.fingerprint === store.state.doc.fingerprint;
      store.replace(st);
      app.selection = null;
      app.pageId = null;
      app.views = new Map();
      if (!keep && app.pdf) {
        app.pdf.destroy();
        app.pdf = null;
        app.pdfPages = new Map();
      }
      if (keep && store.state.pages.length) setPage(store.state.pages[0].id);
      renderAll();
      toast('読み込んだ' + (keep ? '' : '。図面の PDF を開いてください'), 3000);
    } catch (err) {
      toast('読み込めなかった: ' + err.message, 5000);
    }
  }

  /* ---- そのほかのメニュー ---- */
  let menuEl = null;
  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
  }
  function openMenu() {
    if (menuEl) return closeMenu();
    const d = store.state.doc || {};
    const items = [
      ['パレットを書き出す', savePalette],
      ['パレットを読み込む', () => $('#file').click()],
      ['サンプルのパレットを読み込む', loadSamplePalette],
      null,
      ['層と拾いを全部消す（パレット・ページは残す）', clearWork],
    ];
    if (d.sample && P().category('cat-1A2')) items.push(['見本を置く（サンプル図面のとき）', placeSample]);
    items.push(null, ['このブラウザの作業をすべて消す', resetAll]);
    menuEl = h('div', { class: 'menu' });
    for (const it of items) menuEl.append(it ? h('button', { onclick: () => { closeMenu(); it[1](); } }, it[0]) : h('hr'));
    const r = $('#b-menu').getBoundingClientRect();
    menuEl.style.top = r.bottom + 4 + 'px';
    menuEl.style.right = window.innerWidth - r.right + 'px';
    document.body.append(menuEl);
  }
  async function clearWork() {
    if (!(await confirmBox('層と拾いを全部消す', '層（エリア・ルート）・骨・拾いを全部消します。パレットとページは残ります。元に戻すで戻せます。', '消す'))) return;
    edit('層と拾いを全部消す', (S, st) => {
      st.areas = [];
      st.nodes = [];
      st.segments = [];
      st.routes = [];
      st.pickups = [];
    });
    app.selection = null;
  }
  async function resetAll() {
    if (!(await confirmBox('すべて消す', 'このブラウザに残っている作業・パレット・図面の PDF を消して、最初の画面に戻ります。書き出していない作業は戻せません。', 'すべて消す'))) return;
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(OLD_KEY); } catch (e) { /* */ }
    try { await IDB.put('pdf', null); } catch (e) { /* */ }
    location.reload();
  }
  function placeSample() {
    if (store.state.pickups.length && !confirm('いまの層と拾いに、見本（1A2 と玄関まわり）を足します。よいですか')) return;
    edit('見本を置く', (S) => {
      if (!S.state.areas.some((a) => isFull(a))) SMFixture.pageWideAreas(S);
      SMFixture.placeSample(S);
    });
    setPage('pg-036');
    showPlace({ bbox: [500, 183, 110, 85] });
    toast('見本を置いた: 1A2 のルートと線（p.16・11・15・13）、#101、玄関まわりの 3 部屋と 12 台（p.36）', 4000);
  }

  /* ---- 落とす ---- */
  function bindDrop() {
    let depth = 0;
    const cover = $('#dropcover');
    window.addEventListener('dragenter', (e) => { if (![...(e.dataTransfer.types || [])].includes('Files')) return; e.preventDefault(); depth++; cover.classList.add('on'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) cover.classList.remove('on'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      cover.classList.remove('on');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') openPdfFile(f);
      else if (/\.json$/i.test(f.name)) loadJsonFile(f);
      else toast('PDF か JSON を落としてください', 3000);
    });
  }

  function bindUI() {
    renderLayers();
    $('#b-undo').addEventListener('click', () => store.undo());
    $('#b-redo').addEventListener('click', () => store.redo());
    $('#b-fit').addEventListener('click', fit);
    $('#b-zoomin').addEventListener('click', () => zoomBy(1.4));
    $('#b-zoomout').addEventListener('click', () => zoomBy(1 / 1.4));
    $('#b-pdf').addEventListener('click', () => $('#file-pdf').click());
    $('#b-save').addEventListener('click', saveJob);
    $('#b-load').addEventListener('click', () => $('#file').click());
    $('#b-menu').addEventListener('click', (e) => { e.stopPropagation(); openMenu(); });
    document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
    $('#file').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await loadJsonFile(f); });
    $('#file-pdf').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await openPdfFile(f); });
    $('#pagefind').addEventListener('input', (e) => { app.pageQuery = e.target.value; renderPages(); });
    for (const b of $$('#apptabs button')) b.addEventListener('click', () => setScreen(b.dataset.screen));
    bindDrop();

    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('dblclick', (e) => { e.preventDefault(); if (curTool.onDblClick) curTool.onDblClick(ev(e)); });
    stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); const f = Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.max(0.5, Math.min(2, f))); }, { passive: false });
    stage.addEventListener('contextmenu', (e) => { e.preventDefault(); if (curTool.onContext) curTool.onContext(ev(e)); });
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('resize', resize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(stage);
    resize();
  }

  /* ---- パレットの画面（app/palette.js）へ渡すもの ---- */
  const palScreen = self.SMPaletteScreen
    ? self.SMPaletteScreen({
        el: $('#pal'),
        store,
        P,
        h,
        $,
        edit,
        toast,
        openModal,
        confirmBox,
        catColor,
        fmt,
        objects: () => app.objects,
        usePickup: (catId) => { app.currentCategory = catId; setScreen('pick'); },
        showLayer: (kind, id) => { const x = kind === 'area' ? store.area(id) : store.route(id); if (!x) return; setScreen('pick'); setPage(x.page); app.selection = { kind, id }; renderAll(); },
        savePalette,
        loadPalette: () => $('#file').click(),
        loadSamplePalette,
      })
    : null;

  /* ---- 図面解析の画面（app/analyze.js） ---- */
  const anScreen = self.SMAnalyzeScreen ? self.SMAnalyzeScreen({ el: $('#an'), store, P, h, $, edit, toast, openModal, confirmBox, app, IDB, ENV, setScreen, renderAll }) : null;

  // 外から覗く（試験・inject_js 用）
  self.__min = { app, store, SM, get palette() { return P(); }, setTool, setPage, setScreen, fit, showPlace, toPage, toScreen, renderAll, openLayerModal, attachPdf, loadSamplePalette, placeSample, palScreen: () => palScreen, anScreen: () => anScreen, view: (scale, tx, ty) => { app.view = { scale, tx, ty }; applyView(); refine(); }, tool: () => curTool };

  boot();
})();
