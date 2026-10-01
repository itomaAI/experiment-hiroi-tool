/*
 * 拾いツール — 図面解析の画面（タブ「図面解析」）。図面を開いて最初に触るタブ。
 *
 *   左   ページの一覧。ページごとに「送る」（解析に使う）と「拾う」（拾いタブに出す）の印。種類の札
 *   中   図面。注釈（読みどころ）を種類ごとの筆で囲む。選んで動かす・角で大きさを変える・Delete で消す
 *   右   ページの分類／注釈の中身／覚え書き／解析（鍵・送るもの・解析する・結果）
 *
 * 解析は 1 回の頼みで済ませる: 送るページを切り出した PDF ＋ 注釈の切り抜き（画像）→ Gemini →
 * ページの分類・パレット（カテゴリ・ラベル・規則・構成・見込み・系統）・覚え書き。結果はそのまま入れる（元に戻すで戻せる）。
 * 機械が書いたものは、どれもこの画面かパレットの画面で人が直せる。
 *
 * 画面（app.js）とは ctx だけでつながる。編集は ctx.edit（ストアの 1 回の編集）を通す。
 * 頼む中身と、結果の入れ方は core/analysis.js（SMA）。ここは送り方（鍵・PDF の切り出し・切り抜き・fetch）と画面。
 */
(function () {
  'use strict';

  const PDFLIB_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const API = 'https://generativelanguage.googleapis.com';
  const KEY_STORE = 'hiroi-tool:gemini-key';
  const OPT_STORE = 'hiroi-tool:analyze-opts';
  const INLINE_LIMIT = 14 * 1024 * 1024; // これを超える PDF は Files API で上げる（頼みの全体は 20 MB まで）

  self.SMAnalyzeScreen = function (ctx) {
    const { el, store, P, h, edit, toast, openModal, confirmBox, app, IDB, ENV } = ctx;
    const A = self.SMA;

    const st = {
      pageId: null,
      tool: 'select', // 'select' か 注釈の種類の id
      sel: null, // 注釈の id
      view: { scale: 1, tx: 0, ty: 0 },
      views: new Map(),
      filter: 'all',
      q: '',
      rtab: 'page',
      drag: null,
      run: null, // 走っている解析 { phase, t0, abort, steps }
      last: null, // 最後の解析の結果 { ok, sum, error, meta }
      bitmap: null, // { index, scale, canvas }
      thumbs: new Map(),
      noteKind: '',
    };
    IDB.get('analysis:last').then((r) => { st.hasLast = !!(r && r.raw); }).catch(() => {});
    const opts = Object.assign({ model: 'gemini-3.8-flash', thinking: 'low', media: 'MEDIA_RESOLUTION_HIGH', withPalette: true }, readJson(OPT_STORE) || {});

    function readJson(k) {
      try {
        return JSON.parse(localStorage.getItem(k) || 'null');
      } catch (e) {
        return null;
      }
    }
    const saveOpts = () => {
      try {
        localStorage.setItem(OPT_STORE, JSON.stringify(opts));
      } catch (e) {
        /* */
      }
    };
    const pages = () => store.state.pages;
    const page = () => store.page(st.pageId);
    const ensure = () => A.ensure(store.state);
    const modalOpen = () => !!document.querySelector('#modal-root .mback');

    /* ======================================================================
     * 骨組み
     * ====================================================================== */
    el.innerHTML = '';
    const bar = h('div', { class: 'an-bar' });
    const left = h('aside', { class: 'an-left' });
    const stage = h('div', { class: 'an-stage', tabindex: '0' });
    const canvas = h('canvas', { class: 'an-canvas' });
    const hint = h('div', { class: 'an-hint' });
    const empty = h('div', { class: 'an-empty' });
    stage.append(canvas, hint, empty);
    const right = h('aside', { class: 'an-right' });
    el.append(bar, h('div', { class: 'an-body' }, left, h('main', { class: 'an-main' }, stage), right));

    /* ======================================================================
     * 上の帯: 筆（注釈の種類）・拡大・解析の要約
     * ====================================================================== */
    function renderBar() {
      bar.innerHTML = '';
      const tools = h('div', { class: 'an-tools' });
      tools.append(h('button', { class: 'tool' + (st.tool === 'select' ? ' on' : ''), title: '選ぶ・動かす（V）。空いた所を引くと図面が動く', onclick: () => setTool('select') }, '選ぶ', h('kbd', {}, 'V')));
      const grp = h('div', { class: 'an-kinds' }, h('span', { class: 'gname' }, '囲む'));
      A.ANNOT_KINDS.forEach((k, i) => {
        grp.append(h('button', { class: 'tool kind' + (st.tool === k.id ? ' on' : ''), style: '--k:' + k.color, title: k.name + ' — ' + k.hint + '（' + (i + 1) + '）', onclick: () => setTool(k.id) }, h('i', { class: 'sw' }), k.name, h('kbd', {}, String(i + 1))));
      });
      tools.append(grp);
      bar.append(tools, h('span', { class: 'spacer' }));
      const pl = planNow();
      const sendN = pl.pages.length;
      bar.append(
        h('span', { class: 'an-sum', title: '解析に送るもの' }, '送る ', h('b', {}, sendN), ' ページ・注釈 ', h('b', {}, (store.state.annotations || []).length), '（画像 ' + pl.images + ' 枚）'),
        st.run
          ? h('button', { class: 'danger', onclick: () => cancelRun() }, 'やめる（' + Math.round((Date.now() - st.run.t0) / 1000) + ' 秒）')
          : h('button', { class: 'primary', disabled: sendN || pl.crops.length ? null : '', title: sendN ? 'Gemini に送って、ページの分類とパレットを作る' : '左の一覧で「送る」ページを選んでください', onclick: () => startRun() }, '解析する ▶'),
      );
    }
    function setTool(t) {
      st.tool = t;
      stage.style.cursor = t === 'select' ? 'default' : 'crosshair';
      renderBar();
      renderHint();
    }
    function renderHint() {
      const k = st.tool === 'select' ? null : A.kind(st.tool);
      hint.textContent = !page() ? '' : k ? '「' + k.name + '」で囲む — ' + k.hint + '。Esc で選ぶに戻る' : '注釈を押して選ぶ・引いて動かす・角で大きさを変える・Delete で消す。ホイールで拡大、空いた所を引くと図面が動く';
    }

    /* ======================================================================
     * 左: ページの一覧
     * ====================================================================== */
    const isUnchecked = (p) => (p.tagBy && Object.values(p.tagBy).includes('llm') && !p.checked) || p.pickBy === 'llm';
    function renderLeft() {
      left.innerHTML = '';
      const ps = pages();
      const counts = { all: ps.length, send: ps.filter((p) => p.send).length, pick: ps.filter((p) => p.pick === true).length, todo: ps.filter(isUnchecked).length };
      const seg = h('div', { class: 'an-seg' });
      for (const [id, name] of [['all', '全部'], ['send', '送る'], ['pick', '拾う'], ['todo', '未確認']]) seg.append(h('button', { class: st.filter === id ? 'on' : '', onclick: () => { st.filter = id; renderLeft(); } }, name, h('span', { class: 'n' }, counts[id])));
      const find = h('input', { type: 'search', class: 'search', placeholder: '題・種類・p.番号で探す', value: st.q });
      find.addEventListener('input', () => { st.q = find.value; renderList(); });
      const spec = h('input', { type: 'text', placeholder: '例: 1-3, 11, 36', value: A.formatPageSpec(ps.filter((p) => p.send).map((p) => p.index)), title: '送るページの番号。範囲は 30-36 の形' });
      const applySpec = () => {
        const nums = A.parsePageSpec(spec.value, ps.length);
        edit('送るページ', (S) => {
          S.setPagesFlag(ps.map((p) => p.id), 'send', false);
          S.setPagesFlag(ps.filter((p) => nums.includes(p.index)).map((p) => p.id), 'send', true);
        });
        toast('送るページ: ' + (nums.length ? A.formatPageSpec(nums) : 'なし'), 2000);
      };
      spec.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applySpec(); } });
      left.append(
        h('div', { class: 'ttl' }, 'ページ ', h('span', { class: 'dim' }, ps.length ? ps.length + ' 枚' : '')),
        seg,
        h('div', { class: 'an-lrow' }, find),
        h('div', { class: 'an-lrow' }, h('span', { class: 'lab' }, '送る'), spec, h('button', { onclick: applySpec, title: 'この番号のページだけを送る' }, '決める')),
      );
      const list = h('div', { class: 'list an-pages' });
      left.append(list);
      renderList(list);
    }
    function renderList(listEl) {
      const list = listEl || left.querySelector('.an-pages');
      if (!list) return;
      list.innerHTML = '';
      const q = st.q.trim();
      let shown = 0;
      for (const p of pages()) {
        if (st.filter === 'send' && !p.send) continue;
        if (st.filter === 'pick' && p.pick !== true) continue;
        if (st.filter === 'todo' && !isUnchecked(p)) continue;
        if (q && !((p.title || '') + ' p.' + p.index + ' ' + (p.kinds || []).join(' ') + ' ' + (p.work || '') + ' ' + (p.sheet || '')).includes(q)) continue;
        shown++;
        const nAnn = store.annotationsOn(p.id).length;
        const pill = (on, label, title, fn, cls) => h('button', { class: 'pill ' + cls + (on ? ' on' : ''), title, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
        list.append(
          h('div', { class: 'item an-item' + (p.id === st.pageId ? ' on' : ''), onclick: () => setPage(p.id) },
            app.pdf ? thumb(p.index) : null,
            h('div', { class: 'an-it' },
              h('div', { class: 'pt' }, p.title || 'p.' + p.index),
              h('div', { class: 'n' }, 'p.' + p.index + (p.sheet && !(p.title || '').includes(p.sheet) ? '・' + p.sheet : '') + (nAnn ? '・注釈 ' + nAnn : '')),
              (p.kinds || []).length ? h('div', { class: 'kinds' }, ...(p.kinds || []).map((k) => h('span', { class: 'kd' }, k))) : null,
              h('div', { class: 'pills' },
                pill(p.send, '送る', '解析に送るページ', () => edit('送る', (S) => S.setPagesFlag([p.id], 'send', !p.send)), 'send'),
                pill(p.pick === true, '拾う' + (p.pickBy === 'llm' ? '*' : ''), p.pickBy === 'llm' ? '拾いタブに出す（* は解析が付けた印。押すと人の印になる）' : '拾いタブに出す', () => edit('拾う', (S) => S.setPagesFlag([p.id], 'pick', p.pick === true ? false : true)), 'pick'),
              ),
            ),
          ),
        );
      }
      if (!pages().length) list.append(h('div', { class: 'empty', style: 'margin:8px' }, '図面の PDF を開くと、ここにページが並びます'));
      else if (!shown) list.append(h('div', { class: 'empty', style: 'margin:8px' }, '当てはまるページがありません'));
    }

    // 縮小画像（拾いの一覧とは別に持つ。同じ canvas は 2 か所に置けないので）
    const thumbObs = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { thumbObs.unobserve(e.target); queueThumb(Number(e.target.dataset.index)); }
    }, { root: null, rootMargin: '300px' }) : null;
    const thumbQ = [];
    let thumbBusy = false;
    function thumb(index) {
      let c = st.thumbs.get(index);
      if (!c) {
        c = h('canvas', { class: 'thumb', 'data-index': index, width: 1, height: 1 });
        st.thumbs.set(index, c);
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
        const c = st.thumbs.get(k);
        const pg = app.pdfPages.get(k);
        if (!c || !pg) continue;
        const vp0 = pg.getViewport({ scale: 1 });
        const vp = pg.getViewport({ scale: (96 / vp0.width) * Math.min(2, window.devicePixelRatio || 1) });
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        try {
          const g = c.getContext('2d');
          g.fillStyle = '#fff';
          g.fillRect(0, 0, c.width, c.height);
          await pg.render({ canvasContext: g, viewport: vp }).promise;
        } catch (e) {
          /* */
        }
      }
      thumbBusy = false;
    }

    /* ======================================================================
     * 中: 図面と注釈
     * ====================================================================== */
    function setPage(id) {
      if (st.pageId === id) return;
      if (st.pageId) st.views.set(st.pageId, Object.assign({}, st.view));
      st.pageId = id;
      st.sel = null;
      st.bitmap = null;
      const saved = st.views.get(id);
      if (saved) st.view = Object.assign({}, saved);
      else st.needFit = true;
      render();
    }
    function resize() {
      const r = stage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
      if (st.needFit && r.width > 10) fit();
      draw();
    }
    function fit() {
      const pg = page();
      const r = stage.getBoundingClientRect();
      if (!pg || r.width < 10) {
        st.needFit = true;
        return;
      }
      st.needFit = false;
      const s = Math.min((r.width - 24) / pg.width, (r.height - 24) / pg.height);
      st.view = { scale: s, tx: (r.width - pg.width * s) / 2, ty: (r.height - pg.height * s) / 2 };
      draw();
    }
    function zoomAt(x, y, f) {
      const v = st.view;
      const s = Math.max(0.05, Math.min(20, v.scale * f));
      const k = s / v.scale;
      st.view = { scale: s, tx: x - (x - v.tx) * k, ty: y - (y - v.ty) * k };
      draw();
    }
    const toPage = (x, y) => [(x - st.view.tx) / st.view.scale, (y - st.view.ty) / st.view.scale];
    const toScreen = (p) => [p[0] * st.view.scale + st.view.tx, p[1] * st.view.scale + st.view.ty];

    // ページの画像（拡大率に合わせて描き直す。1 枚だけ持つ）
    let bmBusy = false;
    async function ensureBitmap() {
      const pg = page();
      if (!pg || !app.pdf) return;
      const dpr = window.devicePixelRatio || 1;
      const want = Math.min(6, Math.max(1, Math.ceil(st.view.scale * dpr * 1.2 * 2) / 2));
      if (st.bitmap && st.bitmap.index === pg.index && st.bitmap.scale >= want) return;
      if (bmBusy) return;
      const ppg = app.pdfPages.get(pg.index);
      if (!ppg) return;
      bmBusy = true;
      try {
        const vp = ppg.getViewport({ scale: want });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        await ppg.render({ canvasContext: g, viewport: vp }).promise;
        if (page() && page().index === pg.index) st.bitmap = { index: pg.index, scale: want, canvas: c };
      } catch (e) {
        console.warn(e);
      }
      bmBusy = false;
      draw();
    }

    function bboxOf(a) {
      const d = st.drag;
      if (d && d.id === a.id && d.bbox) return d.bbox;
      return a.bbox;
    }
    function draw() {
      const g = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      const pg = page();
      empty.classList.toggle('on', !pg || !app.pdf);
      empty.textContent = !app.pdf ? '図面の PDF を開くと、ここに出ます' : !pg ? '左の一覧からページを選んでください' : '';
      if (!pg || !app.pdf) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const v = st.view;
      g.fillStyle = '#fff';
      g.shadowColor = 'rgba(0,0,0,.18)';
      g.shadowBlur = 12;
      g.fillRect(v.tx, v.ty, pg.width * v.scale, pg.height * v.scale);
      g.shadowBlur = 0;
      if (st.bitmap && st.bitmap.index === pg.index) g.drawImage(st.bitmap.canvas, v.tx, v.ty, pg.width * v.scale, pg.height * v.scale);
      ensureBitmap();
      // 注釈
      const anns = store.annotationsOn(pg.id);
      const tags = tagMap();
      for (const a of anns) {
        const k = A.kind(a.kind);
        const b = bboxOf(a);
        const [x, y] = toScreen([b[0], b[1]]);
        const w = b[2] * v.scale;
        const hh = b[3] * v.scale;
        const sel = a.id === st.sel;
        g.fillStyle = hexA(k.color, sel ? 0.14 : 0.07);
        g.fillRect(x, y, w, hh);
        g.lineWidth = sel ? 2.5 : 1.5;
        g.strokeStyle = k.color;
        g.setLineDash(a.allPages ? [6, 4] : []);
        g.strokeRect(x, y, w, hh);
        g.setLineDash([]);
        const label = (tags.get(a.id) || '') + ' ' + k.name + (a.title ? '・' + a.title : '') + (a.allPages ? '（全ページ）' : '');
        g.font = '600 12px sans-serif';
        const tw = g.measureText(label).width + 10;
        g.fillStyle = k.color;
        g.fillRect(x, y - 18, tw, 18);
        g.fillStyle = '#fff';
        g.fillText(label, x + 5, y - 5);
        if (sel) {
          g.fillStyle = '#fff';
          g.strokeStyle = k.color;
          g.lineWidth = 1.5;
          for (const [hx, hy] of corners(b)) {
            const [sx, sy] = toScreen([hx, hy]);
            g.fillRect(sx - 4, sy - 4, 8, 8);
            g.strokeRect(sx - 4, sy - 4, 8, 8);
          }
        }
      }
      // 他のページの「全ページ」の題欄を、このページにも薄く出す
      for (const a of store.state.annotations || []) {
        if (a.page === pg.id || !a.allPages) continue;
        const [x, y] = toScreen([a.bbox[0], a.bbox[1]]);
        g.strokeStyle = hexA(A.kind(a.kind).color, 0.6);
        g.setLineDash([3, 4]);
        g.lineWidth = 1;
        g.strokeRect(x, y, a.bbox[2] * v.scale, a.bbox[3] * v.scale);
        g.setLineDash([]);
      }
      // 囲んでいる途中
      const d = st.drag;
      if (d && d.mode === 'new') {
        const k = A.kind(d.kind);
        const b = normBox(d.start, d.cur);
        const [x, y] = toScreen([b[0], b[1]]);
        g.fillStyle = hexA(k.color, 0.12);
        g.fillRect(x, y, b[2] * v.scale, b[3] * v.scale);
        g.strokeStyle = k.color;
        g.lineWidth = 2;
        g.setLineDash([5, 3]);
        g.strokeRect(x, y, b[2] * v.scale, b[3] * v.scale);
        g.setLineDash([]);
      }
    }
    const corners = (b) => [[b[0], b[1]], [b[0] + b[2], b[1]], [b[0] + b[2], b[1] + b[3]], [b[0], b[1] + b[3]]];
    const normBox = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
    function hexA(hex, a) {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
      return m ? 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')' : hex;
    }
    // 注釈の札（A1, A2 …）。送るときの名前と同じ
    function tagMap() {
      const pl = A.plan(store.state, { pages: [] });
      const m = new Map();
      for (const c of pl.crops) m.set(c.annotation, c.group);
      return m;
    }

    // 当たり: 選んだ注釈の角 → 注釈の中（小さい順）
    function hit(x, y) {
      const pg = page();
      if (!pg) return null;
      const anns = store.annotationsOn(pg.id);
      const s = store.annotation(st.sel);
      if (s && s.page === pg.id) {
        const cs = corners(s.bbox);
        for (let i = 0; i < 4; i++) {
          const [sx, sy] = toScreen(cs[i]);
          if (Math.abs(sx - x) <= 8 && Math.abs(sy - y) <= 8) return { id: s.id, corner: i };
        }
      }
      const p = toPage(x, y);
      const tol = 6 / st.view.scale;
      const inside = anns.filter((a) => p[0] >= a.bbox[0] - tol && p[0] <= a.bbox[0] + a.bbox[2] + tol && p[1] >= a.bbox[1] - tol && p[1] <= a.bbox[1] + a.bbox[3] + tol);
      // 札（左上の帯）も当たりにする
      for (const a of anns) {
        const [sx, sy] = toScreen([a.bbox[0], a.bbox[1]]);
        if (x >= sx && x <= sx + 140 && y >= sy - 18 && y <= sy) inside.push(a);
      }
      inside.sort((a, b) => a.bbox[2] * a.bbox[3] - b.bbox[2] * b.bbox[3]);
      return inside.length ? { id: inside[0].id, corner: -1 } : null;
    }

    let spaceHeld = false;
    stage.addEventListener('pointerdown', (e) => {
      if (!page() || !app.pdf) return;
      stage.focus();
      const r = stage.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      stage.setPointerCapture(e.pointerId);
      if (e.button === 1 || spaceHeld || e.button === 2) {
        st.drag = { mode: 'pan', x, y, v: Object.assign({}, st.view) };
        return;
      }
      if (st.tool !== 'select') {
        const p = toPage(x, y);
        st.drag = { mode: 'new', kind: st.tool, start: p, cur: p };
        return;
      }
      const hh = hit(x, y);
      if (hh) {
        const a = store.annotation(hh.id);
        if (st.sel !== a.id) {
          st.sel = a.id;
          st.rtab = 'annot';
          renderRight();
        }
        st.drag = { mode: hh.corner >= 0 ? 'resize' : 'move', id: a.id, corner: hh.corner, start: toPage(x, y), orig: a.bbox.slice(), bbox: a.bbox.slice() };
        draw();
        return;
      }
      if (st.sel) {
        st.sel = null;
        renderRight();
      }
      st.drag = { mode: 'pan', x, y, v: Object.assign({}, st.view) };
      draw();
    });
    stage.addEventListener('pointermove', (e) => {
      const d = st.drag;
      const r = stage.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (!d) {
        if (st.tool === 'select' && page()) {
          const hh = hit(x, y);
          stage.style.cursor = hh ? (hh.corner >= 0 ? (hh.corner % 2 ? 'nesw-resize' : 'nwse-resize') : 'move') : 'default';
        }
        return;
      }
      if (d.mode === 'pan') {
        st.view = { scale: d.v.scale, tx: d.v.tx + (x - d.x), ty: d.v.ty + (y - d.y) };
        draw();
        return;
      }
      const p = toPage(x, y);
      if (d.mode === 'new') d.cur = p;
      else if (d.mode === 'move') {
        d.bbox = [d.orig[0] + p[0] - d.start[0], d.orig[1] + p[1] - d.start[1], d.orig[2], d.orig[3]];
      } else if (d.mode === 'resize') {
        const c = corners(d.orig);
        const opp = c[(d.corner + 2) % 4];
        d.bbox = normBox(opp, p);
      }
      draw();
    });
    const endDrag = () => {
      const d = st.drag;
      st.drag = null;
      if (!d) return;
      if (d.mode === 'new') {
        const b = normBox(d.start, d.cur);
        if (b[2] * st.view.scale < 6 || b[3] * st.view.scale < 6) {
          draw();
          return;
        }
        const pg = page();
        const id = edit('注釈を囲む（' + A.kind(d.kind).name + '）', (S) => S.addAnnotation(pg.id, clampBox(b, pg), d.kind));
        if (id) {
          st.sel = id;
          st.rtab = 'annot';
          render();
        }
        return;
      }
      if ((d.mode === 'move' || d.mode === 'resize') && d.bbox) {
        const same = d.bbox.every((v, i) => Math.abs(v - d.orig[i]) < 0.05);
        if (!same && d.bbox[2] > 1 && d.bbox[3] > 1) edit(d.mode === 'move' ? '注釈を動かす' : '注釈の大きさ', (S) => S.updateAnnotation(d.id, { bbox: clampBox(d.bbox, page()) }));
        else draw();
      }
    };
    const clampBox = (b, pg) => {
      const x0 = Math.max(0, b[0]);
      const y0 = Math.max(0, b[1]);
      const x1 = Math.min(pg.width, b[0] + b[2]);
      const y1 = Math.min(pg.height, b[1] + b[3]);
      return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const f = Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.max(0.5, Math.min(2, f)));
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (app.screen !== 'analyze' || modalOpen()) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.code === 'Space') {
        spaceHeld = true;
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (st.drag) st.drag = null;
        else if (st.tool !== 'select') setTool('select');
        else if (st.sel) { st.sel = null; renderRight(); }
        draw();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel) {
        e.preventDefault();
        removeAnnotation(st.sel);
        return;
      }
      if (e.key === '0') return fit();
      if (e.key.toLowerCase() === 'v') return setTool('select');
      const n = Number(e.key);
      if (n >= 1 && n <= A.ANNOT_KINDS.length) setTool(A.ANNOT_KINDS[n - 1].id);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        const ps = pages();
        const i = ps.findIndex((p) => p.id === st.pageId);
        const j = i + (e.key === 'ArrowDown' || e.key === 'PageDown' ? 1 : -1);
        if (ps[j]) setPage(ps[j].id);
      }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });
    window.addEventListener('resize', () => { if (app.screen === 'analyze') resize(); });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (app.screen === 'analyze') resize(); }).observe(stage);

    function removeAnnotation(id) {
      edit('注釈を消す', (S) => S.removeAnnotation(id));
      if (st.sel === id) st.sel = null;
      render();
    }

    /* ======================================================================
     * 右: ページ・注釈・覚え書き・解析
     * ====================================================================== */
    function renderRight() {
      ensure();
      right.innerHTML = '';
      const nNotes = store.state.analysis.notes.length;
      const nAnn = (store.state.annotations || []).length;
      const tabs = h('div', { class: 'an-rtabs' });
      for (const [id, name] of [['page', 'ページ'], ['annot', '注釈' + (nAnn ? ' ' + nAnn : '')], ['notes', '覚え書き' + (nNotes ? ' ' + nNotes : '')], ['run', '解析']]) tabs.append(h('button', { class: st.rtab === id ? 'on' : '', onclick: () => { st.rtab = id; renderRight(); } }, name));
      right.append(tabs);
      const body = h('div', { class: 'an-rbody' });
      right.append(body);
      if (st.rtab === 'page') renderPagePanel(body);
      else if (st.rtab === 'annot') renderAnnotPanel(body);
      else if (st.rtab === 'notes') renderNotesPanel(body);
      else renderRunPanel(body);
    }

    const ai = (on) => (on ? h('span', { class: 'ai', title: '解析が書いた値（直すと人の値になる）' }, 'AI') : null);

    /* ---- ページ ---- */
    function renderPagePanel(body) {
      const p = page();
      if (!p) {
        body.append(h('div', { class: 'empty' }, '左の一覧からページを選んでください'));
        return;
      }
      const by = (k) => p.tagBy && p.tagBy[k] === 'llm';
      const set = (patch, label) => edit(label || 'ページの分類', (S) => S.setPageMeta(p.id, patch, 'human'));
      const field = (k, name, multiline) => {
        const inp = multiline ? h('textarea', { rows: 4 }, p[k] || '') : h('input', { type: 'text', value: p[k] || '' });
        inp.addEventListener('change', () => set({ [k]: inp.value.trim() }, 'ページの' + name));
        return h('label', { class: 'fld' }, h('span', { class: 'fn' }, name, ai(by(k))), inp);
      };
      const kinds = h('div', { class: 'kchips' });
      for (const k of A.PAGE_KINDS) {
        const on = (p.kinds || []).includes(k);
        kinds.append(h('button', { class: 'kchip' + (on ? ' on' : ''), onclick: () => set({ kinds: on ? (p.kinds || []).filter((x) => x !== k) : (p.kinds || []).concat([k]) }, 'ページの種類') }, k));
      }
      const tri = h('div', { class: 'tri' });
      for (const [v, name] of [[true, '拾う'], [false, '拾わない'], [null, '未定']]) {
        const on = v === null ? p.pick === undefined || p.pick === null : p.pick === v;
        tri.append(h('button', { class: on ? 'on' : '', onclick: () => edit('拾う', (S) => S.setPagesFlag([p.id], 'pick', v)) }, name));
      }
      body.append(
        h('div', { class: 'an-ph' }, h('b', {}, 'p.' + p.index), h('span', { class: 'spacer' }), h('label', { class: 'chk' }, checkbox(!!p.send, (v) => edit('送る', (S) => S.setPagesFlag([p.id], 'send', v))), '解析に送る')),
        h('div', { class: 'fld' }, h('span', { class: 'fn' }, '拾いタブに', ai(p.pickBy === 'llm')), tri, h('div', { class: 'muted' }, '「拾う」のページだけが拾いタブに出ます（1 枚も無ければ全部）')),
        field('title', '題'),
        h('div', { class: 'two' }, field('sheet', '図面番号'), field('scale', '縮尺')),
        h('div', { class: 'two' }, field('work', '工事種目'), field('floor', '階')),
        h('div', { class: 'fld' }, h('span', { class: 'fn' }, '種類', ai(by('kinds'))), kinds),
        field('summary', '要約', true),
        h('label', { class: 'chk' }, checkbox(!!p.checked, (v) => edit('ページを確かめた', (S) => S.setPageMeta(p.id, { checked: v }, 'human'))), '確かめた（「未確認」から外す）'),
      );
      const anns = store.annotationsOn(p.id);
      body.append(h('div', { class: 'sec' }, 'このページの注釈 ', h('span', { class: 'dim' }, anns.length)));
      if (!anns.length) body.append(h('div', { class: 'muted' }, '上の帯の「囲む」の筆で、仕様書・凡例・機器表などの読みどころを囲むと、解析のときに切り抜いて画像で送ります（PDF だけでは細かい字が読めないため）'));
      annList(body, anns);
    }
    function checkbox(on, fn) {
      const c = h('input', { type: 'checkbox', checked: on ? '' : null });
      c.addEventListener('change', () => fn(c.checked));
      return c;
    }
    function annList(body, anns) {
      const tags = tagMap();
      for (const a of anns) {
        const k = A.kind(a.kind);
        const pg = store.page(a.page);
        body.append(h('div', { class: 'an-arow' + (a.id === st.sel ? ' on' : ''), onclick: () => { if (pg && pg.id !== st.pageId) setPage(pg.id); st.sel = a.id; st.rtab = 'annot'; showBox(a.bbox); render(); } },
          h('span', { class: 'tg', style: 'background:' + k.color }, tags.get(a.id) || '—'),
          h('span', { class: 'kn' }, k.name),
          h('span', { class: 'tt' }, a.title || (a.note ? '「' + a.note.slice(0, 18) + '」' : '')),
          h('span', { class: 'spacer' }),
          h('span', { class: 'dim' }, 'p.' + (pg ? pg.index : '?') + (a.allPages ? '・全' : '')),
        ));
      }
    }
    function showBox(b) {
      const r = stage.getBoundingClientRect();
      if (r.width < 10) return;
      const s = Math.min(st.view.scale, (r.width * 0.8) / b[2], (r.height * 0.8) / b[3]);
      const c = [b[0] + b[2] / 2, b[1] + b[3] / 2];
      st.view = { scale: s, tx: r.width / 2 - c[0] * s, ty: r.height / 2 - c[1] * s };
    }

    /* ---- 注釈 ---- */
    function renderAnnotPanel(body) {
      const a = store.annotation(st.sel);
      if (!a) {
        body.append(h('div', { class: 'muted', style: 'margin-bottom:8px' }, '注釈 = 解析に「ここを読んで」と渡す範囲。上の帯の筆（1〜9）で図面を囲みます。解析のとき、PDF とは別に、この範囲を細かく切り抜いた画像を送ります。'));
        const kinds = h('div', { class: 'an-kindhelp' });
        for (const k of A.ANNOT_KINDS) kinds.append(h('div', {}, h('i', { class: 'sw', style: 'background:' + k.color }), h('b', {}, k.name), ' — ', k.hint));
        body.append(kinds, h('div', { class: 'sec' }, 'すべての注釈 ', h('span', { class: 'dim' }, (store.state.annotations || []).length)));
        annList(body, (store.state.annotations || []).slice().sort((x, y) => ((store.page(x.page) || {}).index || 0) - ((store.page(y.page) || {}).index || 0)));
        return;
      }
      const k = A.kind(a.kind);
      const pg = store.page(a.page);
      const sel = h('select', {});
      for (const x of A.ANNOT_KINDS) sel.append(h('option', { value: x.id, selected: x.id === a.kind ? '' : null }, x.name));
      sel.addEventListener('change', () => edit('注釈の種類', (S) => S.updateAnnotation(a.id, { kind: sel.value })));
      const title = h('input', { type: 'text', value: a.title || '', placeholder: '例: 器具表（1 階）' });
      title.addEventListener('change', () => edit('注釈の題', (S) => S.updateAnnotation(a.id, { title: title.value.trim() })));
      const note = h('textarea', { rows: 4, placeholder: '例: この表は 1 階だけ。記号の横の数字は回路番号なので無視' }, a.note || '');
      note.addEventListener('change', () => edit('注釈の覚え書き', (S) => S.updateAnnotation(a.id, { note: note.value.trim() })));
      const prev = h('canvas', { class: 'an-prev' });
      const tl = A.tilesFor(a.bbox);
      body.append(
        h('div', { class: 'an-ph' }, h('span', { class: 'tg', style: 'background:' + k.color }, tagMap().get(a.id) || ''), h('b', {}, k.name), h('span', { class: 'dim' }, '　p.' + (pg ? pg.index : '?')), h('span', { class: 'spacer' }), h('button', { class: 'danger', onclick: () => removeAnnotation(a.id) }, '消す')),
        h('div', { class: 'muted' }, k.hint),
        h('label', { class: 'fld' }, h('span', { class: 'fn' }, '種類'), sel),
        h('label', { class: 'fld' }, h('span', { class: 'fn' }, '題'), title),
        h('label', { class: 'fld' }, h('span', { class: 'fn' }, '機械への覚え書き（どう読んでほしいか）'), note),
        h('label', { class: 'chk' }, checkbox(!!a.allPages, (v) => edit('注釈を全ページに', (S) => S.updateAnnotation(a.id, { allPages: v }))), '送る全ページの同じ位置も切り抜く（題欄のように、どのページも同じ場所にあるもの）'),
        h('div', { class: 'muted' }, '送る画像: ' + tl.tiles.length + ' 枚（' + Math.round(tl.scale * 72) + ' dpi' + (tl.tiles.length > 1 ? '・大きいので分ける' : '') + '）'),
        prev,
        h('div', { class: 'an-btns' }, h('button', { onclick: () => { st.sel = null; renderRight(); draw(); } }, '選ぶのをやめる'), h('button', { onclick: () => { showBox(a.bbox); draw(); } }, 'この範囲へ寄る')),
      );
      drawPreview(prev, a);
    }
    async function drawPreview(c, a) {
      const pg = store.page(a.page);
      const ppg = pg && app.pdfPages.get(pg.index);
      if (!ppg) return;
      const sc = Math.min(2, 300 / Math.max(1, a.bbox[2]));
      c.width = Math.max(1, Math.round(a.bbox[2] * sc));
      c.height = Math.max(1, Math.round(a.bbox[3] * sc));
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      try {
        await ppg.render({ canvasContext: g, viewport: ppg.getViewport({ scale: sc }), transform: [1, 0, 0, 1, -a.bbox[0] * sc, -a.bbox[1] * sc] }).promise;
      } catch (e) {
        /* */
      }
    }

    /* ---- 覚え書き ---- */
    function renderNotesPanel(body) {
      const notes = store.state.analysis.notes;
      const kindSel = h('select', {}, h('option', { value: '' }, 'すべての種類'), ...A.NOTE_KINDS.map((k) => h('option', { value: k, selected: st.noteKind === k ? '' : null }, k + '（' + notes.filter((n) => n.kind === k).length + '）')));
      kindSel.addEventListener('change', () => { st.noteKind = kindSel.value; renderRight(); });
      body.append(
        h('div', { class: 'muted', style: 'margin-bottom:6px' }, '拾うときに知っておくこと。解析が書いたもの（AI）も、人が書いたものも、ここで直せます。済んだものは印を付けておけます。'),
        h('div', { class: 'an-btns' }, kindSel, h('span', { class: 'spacer' }), h('button', { onclick: () => { edit('覚え書きを足す', (S) => S.addNote({ kind: st.noteKind || 'その他', text: '', pages: page() ? [page().index] : [], by: 'human' })); } }, '＋ 覚え書き')),
      );
      const list = notes.filter((n) => !st.noteKind || n.kind === st.noteKind);
      if (!list.length) body.append(h('div', { class: 'empty' }, '覚え書きはまだありません'));
      for (const n of list) {
        const ks = h('select', { class: 'nk' }, ...A.NOTE_KINDS.map((k) => h('option', { value: k, selected: n.kind === k ? '' : null }, k)));
        ks.addEventListener('change', () => edit('覚え書きの種類', (S) => S.updateNote(n.id, { kind: ks.value })));
        const ta = h('textarea', { rows: Math.min(6, Math.max(2, Math.ceil((n.text || '').length / 30))) }, n.text || '');
        ta.addEventListener('change', () => edit('覚え書きを直す', (S) => S.updateNote(n.id, { text: ta.value.trim() })));
        const pagesEl = h('span', { class: 'np' });
        for (const pn of n.pages || []) {
          const pg = pages().find((x) => x.index === pn);
          pagesEl.append(h('a', { href: '#', onclick: (e) => { e.preventDefault(); if (pg) setPage(pg.id); } }, 'p.' + pn), ' ');
        }
        body.append(h('div', { class: 'an-note' + (n.done ? ' done' : '') },
          h('div', { class: 'nh' }, ks, ai(n.by === 'llm'), pagesEl, n.src && n.src.length ? h('span', { class: 'dim' }, '根拠 ' + n.src.join('・')) : null, h('span', { class: 'spacer' }), h('label', { class: 'chk', title: '済んだ' }, checkbox(!!n.done, (v) => edit('覚え書きの済み', (S) => S.updateNote(n.id, { done: v }))), '済'), h('button', { class: 'ghost', title: '消す', onclick: () => edit('覚え書きを消す', (S) => S.removeNote(n.id)) }, '×')),
          ta,
        ));
      }
    }

    /* ---- 解析 ---- */
    function planNow() {
      ensure();
      return A.plan(store.state, {});
    }
    function keyStatus() {
      const k = localStorage.getItem(KEY_STORE);
      if (k) return { has: true, where: 'このブラウザに保存した鍵（…' + k.slice(-4) + '）' };
      if (ENV === 'itera') return { has: true, where: 'Itera の鍵（system/credentials/gemini.json）', itera: true };
      return { has: false, where: '未設定' };
    }
    async function getKey() {
      const k = localStorage.getItem(KEY_STORE);
      if (k) return k;
      if (ENV === 'itera' && self.MetaOS) {
        try {
          return JSON.parse(await MetaOS.fs.read('system/credentials/gemini.json')).api_key || null;
        } catch (e) {
          return null;
        }
      }
      return null;
    }
    function openKeyModal() {
      const inp = h('input', { type: 'password', value: localStorage.getItem(KEY_STORE) || '', placeholder: 'AIza…', style: 'width:100%', autocomplete: 'off' });
      const m = openModal({
        title: 'Gemini API の鍵',
        width: 520,
        dismiss: true,
        body: h('div', { class: 'form' },
          h('p', {}, 'Google AI Studio で作った API キーを入れてください。鍵は', h('b', {}, 'このブラウザの中（localStorage）にだけ'), '保存され、解析のときに Google の API（generativelanguage.googleapis.com）へだけ送られます。'),
          inp,
          h('p', { class: 'muted' }, ENV === 'itera' ? '空にすると、Itera の鍵（system/credentials/gemini.json）を使います。' : '共用の端末では、使い終わったら消してください。'),
        ),
        actions: [{ label: '消す', on: (hd) => hd.close('clear') }, 'spacer', { label: 'やめる', id: 'cancel' }, { label: '保存する', primary: true, on: (hd) => hd.close('save') }],
        onKey: (e, hd) => { if (e.key === 'Enter') { e.preventDefault(); hd.close('save'); } },
      });
      setTimeout(() => inp.focus(), 30);
      m.result.then((v) => {
        if (v === 'save' && inp.value.trim()) localStorage.setItem(KEY_STORE, inp.value.trim());
        else if (v === 'clear' || (v === 'save' && !inp.value.trim())) localStorage.removeItem(KEY_STORE);
        if (v) {
          toast(v === 'save' && inp.value.trim() ? '鍵を保存した' : '鍵を消した', 1800);
          renderRight();
        }
      });
    }
    function renderRunPanel(body) {
      const ks = keyStatus();
      const pl = planNow();
      const model = h('input', { type: 'text', value: opts.model, list: 'an-models', style: 'width:100%' });
      model.addEventListener('change', () => { opts.model = model.value.trim() || 'gemini-3.8-flash'; saveOpts(); });
      const think = h('select', {}, ...[['low', '少なめ（速い）'], ['high', '多め（遅い・丁寧）']].map(([v, n]) => h('option', { value: v, selected: opts.thinking === v ? '' : null }, n)));
      think.addEventListener('change', () => { opts.thinking = think.value; saveOpts(); });
      body.append(
        h('div', { class: 'sec', style: 'margin-top:0' }, 'Gemini'),
        h('div', { class: 'fld' }, h('span', { class: 'fn' }, '鍵'), h('div', { class: 'an-btns' }, h('span', { class: ks.has ? 'ok' : 'warn' }, ks.where), h('span', { class: 'spacer' }), h('button', { onclick: openKeyModal }, ks.has && !ks.itera ? '変える' : '鍵を入れる'))),
        h('div', { class: 'two' }, h('label', { class: 'fld' }, h('span', { class: 'fn' }, 'モデル'), model, h('datalist', { id: 'an-models' }, h('option', { value: 'gemini-3.8-flash' }), h('option', { value: 'gemini-3.1-pro-preview' }))), h('label', { class: 'fld' }, h('span', { class: 'fn' }, '考える量'), think)),
        h('div', { class: 'sec' }, '送るもの'),
      );
      const send = h('div', { class: 'an-send' });
      send.append(
        h('div', {}, 'PDF: ', pl.pages.length ? h('b', {}, A.formatPageSpec(pl.pages)) : h('span', { class: 'warn' }, 'なし'), pl.pages.length ? '（' + pl.pages.length + ' ページを切り出して送る）' : ''),
        h('div', {}, '注釈の切り抜き: ', h('b', {}, pl.crops.length), ' 件・画像 ', h('b', {}, pl.images), ' 枚'),
        h('div', {}, 'いまのパレット: ', opts.withPalette ? '名前の一覧を添える（同じものを同じ名前で書いてもらうため）' : '添えない'),
      );
      for (const pr of pl.problems) send.append(h('div', { class: 'warn' }, pr));
      body.append(send, h('label', { class: 'chk' }, checkbox(!!opts.withPalette, (v) => { opts.withPalette = v; saveOpts(); renderRight(); }), 'いまのパレットの名前を添える'));
      body.append(h('div', { class: 'muted' }, 'PDF のページは Gemini の側で縮めて読まれ、細かい字（表の中身・注記）は読めないことが多いので、読ませたい所は注釈で囲んでください。題欄を 1 つ囲んで「全ページ」にすると、ページの題が正しく取れます。'));
      if (st.run) {
        const r = st.run;
        body.append(h('div', { class: 'an-progress' }, h('div', { class: 'spin' }), h('div', {}, h('b', {}, r.phase), h('div', { class: 'muted' }, Math.round((Date.now() - r.t0) / 1000) + ' 秒')), h('span', { class: 'spacer' }), h('button', { class: 'danger', onclick: cancelRun }, 'やめる')));
      } else {
        body.append(h('div', { class: 'an-btns', style: 'margin:10px 0' }, h('button', { class: 'primary big', disabled: pl.pages.length || pl.crops.length ? null : '', onclick: () => startRun() }, '解析する ▶')));
      }
      if (st.last) renderLast(body, st.last);
      const runs = store.state.analysis.runs || [];
      if (runs.length) {
        body.append(h('div', { class: 'sec' }, 'これまでの解析 ', h('span', { class: 'dim' }, runs.length)));
        for (const r of runs.slice().reverse().slice(0, 8)) {
          body.append(h('div', { class: 'an-run' }, h('div', {}, h('b', {}, localTime(r.at)), ' ', r.model, '・', Math.round(r.ms / 1000) + ' 秒'), h('div', { class: 'muted' }, 'p.' + A.formatPageSpec(r.pages || []) + '・注釈 ' + (r.crops || 0) + '・入力 ' + (r.tokensIn || '?') + '・出力 ' + (r.tokensOut || '?') + ' トークン'), r.sum ? h('div', { class: 'muted' }, sumText(r.sum)) : null));
        }
      }
      if (st.hasLast) body.append(h('div', { class: 'an-btns', style: 'margin-top:8px' }, h('button', { onclick: reapplyLast, title: 'ブラウザに残してある最後の応答を、もう一度パレットに入れる（足し合わせ。送り直さない）' }, '最後の応答をもう一度入れる')));
    }
    const localTime = (iso) => { const d = new Date(iso); const z = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); };
    const sumText = (s) => 'ページ ' + s.pages + '・カテゴリ +' + s.categories.added + '・ラベル +' + s.labels.added + '・規則 ' + s.rules + '・構成 ' + s.components + '・見込み ' + s.expected + '・系統 ' + (s.systems || 0) + '・覚え書き ' + s.notes;
    function renderLast(body, L) {
      const box = h('div', { class: 'an-last ' + (L.ok ? 'ok' : 'ng') });
      if (L.ok) {
        box.append(
          h('div', {}, h('b', {}, '解析を入れた'), '（' + Math.round(L.meta.ms / 1000) + ' 秒・入力 ' + L.meta.tokensIn + '・出力 ' + L.meta.tokensOut + ' トークン）'),
          h('div', {}, sumText(L.sum)),
          h('div', { class: 'muted' }, '元に戻す（Ctrl+Z）で、まとめて戻せます。'),
          h('div', { class: 'an-btns' }, h('button', { onclick: () => ctx.setScreen('palette') }, 'パレットを見る'), h('button', { onclick: () => { st.rtab = 'notes'; renderRight(); } }, '覚え書きを見る'), h('button', { onclick: () => { st.filter = 'todo'; renderLeft(); } }, '未確認のページ')),
        );
        if (L.sum.warnings.length) box.append(h('details', {}, h('summary', {}, '知らせ ' + L.sum.warnings.length + ' 件'), h('ul', {}, ...L.sum.warnings.map((w) => h('li', {}, w)))));
      } else box.append(h('div', {}, h('b', {}, L.cancelled ? 'やめた' : 'できなかった')), h('div', { class: 'err' }, L.error || ''));
      body.append(box);
    }

    /* ---- 送る ---- */
    function cancelRun() {
      if (st.run) {
        st.run.cancelled = true;
        if (st.run.abort) st.run.abort.abort();
      }
    }
    function phase(text) {
      if (!st.run) return;
      st.run.phase = text;
      renderBar();
      if (st.rtab === 'run') renderRight();
    }
    let ticker = null;
    async function startRun() {
      if (st.run) return;
      if (!app.pdf) return toast('図面の PDF を開いてください', 2500);
      ensure();
      const pl = planNow();
      if (!pl.pages.length && !pl.crops.length) return toast('送るものがありません', 2500);
      // 試験の差し替え口があれば、鍵は要らない（外へ送らない）
      const key = typeof self.__hiroiGeminiStub === 'function' ? 'stub' : await getKey();
      if (!key) {
        toast('Gemini の鍵を入れてください', 2500);
        st.rtab = 'run';
        renderRight();
        openKeyModal();
        return;
      }
      const ok = await confirmBox('Gemini に送る', h('div', {},
        h('p', {}, '次のものを Google の Gemini API（' + opts.model + '）へ送ります。'),
        h('ul', {}, h('li', {}, 'PDF: ' + (pl.pages.length ? 'p.' + A.formatPageSpec(pl.pages) + '（' + pl.pages.length + ' ページ）' : 'なし')), h('li', {}, '注釈の切り抜き: ' + pl.crops.length + ' 件（画像 ' + pl.images + ' 枚）'), opts.withPalette ? h('li', {}, 'いまのパレットの名前') : null),
        h('p', { class: 'muted' }, '結果は、ページの分類・パレット・覚え書きにそのまま入ります（元に戻すで戻せます）。人が直したページの欄は替えません。'),
      ), '送る');
      if (!ok) return;
      st.rtab = 'run';
      st.run = { phase: '用意しています', t0: Date.now(), abort: new AbortController(), cancelled: false };
      ticker = setInterval(() => { renderBar(); const t = right.querySelector('.an-progress .muted'); if (t && st.run) t.textContent = Math.round((Date.now() - st.run.t0) / 1000) + ' 秒'; }, 1000);
      renderAll();
      let uploaded = null;
      try {
        const parts = A.parts(store.state, pl, { palette: opts.withPalette });
        // PDF
        let pdfPart = null;
        if (pl.pages.length) {
          phase('PDF を切り出しています（' + pl.pages.length + ' ページ）');
          const bytes = await subsetPdf(pl.pages);
          if (st.run.cancelled) throw cancelled();
          if (bytes.length > INLINE_LIMIT) {
            phase('PDF を上げています（' + Math.round(bytes.length / 1048576) + ' MB）');
            uploaded = await uploadFile(key, bytes, 'application/pdf', (store.state.doc.name || 'drawing') + '.pdf', st.run.abort.signal);
            pdfPart = { fileData: { mimeType: 'application/pdf', fileUri: uploaded.uri } };
          } else pdfPart = { inlineData: { mimeType: 'application/pdf', data: b64(bytes) } };
          pdfPart.mediaResolution = { level: opts.media };
        }
        // 切り抜き
        const real = [];
        let n = 0;
        for (const p of parts) {
          if (st.run.cancelled) throw cancelled();
          if (p.text) real.push({ text: p.text });
          else if (p.pdf) real.push(pdfPart);
          else {
            n++;
            phase('切り抜きを描いています（' + n + ' / ' + pl.images + '）');
            const c = pl.crops[p.crop];
            const data = await renderCrop(c.page, c.tiles[p.tile], c.scale);
            real.push({ inlineData: { mimeType: 'image/png', data } });
          }
        }
        phase('Gemini が読んでいます（' + opts.model + '）');
        const res = await callGemini(key, { systemInstruction: { parts: [{ text: A.SYSTEM }] }, contents: [{ role: 'user', parts: real }], generationConfig: { responseMimeType: 'application/json', responseSchema: A.SCHEMA, thinkingConfig: { thinkingLevel: opts.thinking }, maxOutputTokens: 65536 } }, st.run.abort.signal);
        const meta = { ms: Date.now() - st.run.t0, model: opts.model, tokensIn: (res.usage || {}).promptTokenCount, tokensOut: (res.usage || {}).candidatesTokenCount, finish: res.finish };
        try {
          await IDB.put('analysis:last', { at: new Date().toISOString(), raw: res.json, plan: { pages: pl.pages, crops: pl.crops.length }, meta });
          st.hasLast = true;
        } catch (e) {
          /* 残せなくても入れる */
        }
        const sum = applyResult(res.json, pl, meta);
        st.last = { ok: true, sum, meta };
        toast('解析を入れた: ' + sumText(sum), 5000);
      } catch (e) {
        console.error(e);
        st.last = { ok: false, cancelled: !!(e && e.cancelled), error: e && e.cancelled ? '' : String((e && e.message) || e) };
        toast(st.last.cancelled ? 'やめた' : 'できなかった: ' + st.last.error.slice(0, 80), 5000);
      } finally {
        if (uploaded) deleteFile(key, uploaded.name).catch(() => {});
        clearInterval(ticker);
        st.run = null;
        renderAll();
      }
    }
    const cancelled = () => Object.assign(new Error('やめた'), { cancelled: true });

    function applyResult(raw, pl, meta) {
      const runId = 'run-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      let sum = null;
      edit('解析の結果を入れる', (S, s) => {
        sum = A.apply(S, raw, { pages: pl.pages, run: runId });
        A.ensure(s);
        s.analysis.runs.push({ id: runId, at: new Date().toISOString(), model: meta.model, ms: meta.ms, pages: pl.pages.slice(), crops: pl.crops.length, tokensIn: meta.tokensIn, tokensOut: meta.tokensOut, finish: meta.finish, sum: Object.assign({}, sum, { warnings: sum.warnings.length }) });
        if (s.analysis.runs.length > 30) s.analysis.runs.shift();
      });
      return sum;
    }
    async function reapplyLast() {
      const rec = await IDB.get('analysis:last');
      if (!rec || !rec.raw) return toast('残っている応答がありません', 2500);
      const sum = applyResult(rec.raw, { pages: rec.plan.pages, crops: { length: rec.plan.crops } }, Object.assign({}, rec.meta, { ms: 0 }));
      st.last = { ok: true, sum, meta: Object.assign({}, rec.meta) };
      renderAll();
    }

    /* ---- 送り方の部品 ---- */
    let pdfLib = null;
    function loadPdfLib() {
      if (self.PDFLib) return Promise.resolve(self.PDFLib);
      if (pdfLib) return pdfLib;
      pdfLib = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = PDFLIB_URL;
        s.onload = () => (self.PDFLib ? res(self.PDFLib) : rej(new Error('pdf-lib を読めなかった')));
        s.onerror = () => {
          pdfLib = null;
          rej(new Error('pdf-lib を読めなかった（ネットワーク）'));
        };
        document.head.append(s);
      });
      return pdfLib;
    }
    let srcDoc = null;
    async function subsetPdf(nums) {
      const L = await loadPdfLib();
      const fp = (store.state.doc || {}).fingerprint || (store.state.doc || {}).name;
      if (!srcDoc || srcDoc.fp !== fp) {
        const rec = await IDB.get('pdf');
        if (!rec || !rec.bytes) throw new Error('PDF がブラウザに残っていません。図面を開き直してください');
        srcDoc = { fp, doc: await L.PDFDocument.load(rec.bytes.slice(0), { ignoreEncryption: true, updateMetadata: false }) };
      }
      const out = await L.PDFDocument.create();
      const cp = await out.copyPages(srcDoc.doc, nums.map((n) => n - 1));
      for (const p of cp) out.addPage(p);
      return await out.save({ useObjectStreams: true });
    }
    function b64(bytes) {
      let s = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return btoa(s);
    }
    async function renderCrop(index, tile, scale) {
      const ppg = app.pdfPages.get(index);
      if (!ppg) throw new Error('p.' + index + ' を描けない');
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(tile[2] * scale));
      c.height = Math.max(1, Math.round(tile[3] * scale));
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      await ppg.render({ canvasContext: g, viewport: ppg.getViewport({ scale }), transform: [1, 0, 0, 1, -tile[0] * scale, -tile[1] * scale] }).promise;
      const url = c.toDataURL('image/png');
      return url.slice(url.indexOf(',') + 1);
    }
    async function uploadFile(key, bytes, mime, name, signal) {
      const boundary = 'hiroi' + Math.random().toString(16).slice(2);
      const meta = JSON.stringify({ file: { display_name: name } });
      const body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n', bytes, '\r\n--' + boundary + '--\r\n']);
      const res = await fetch(API + '/upload/v1beta/files', { method: 'POST', headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'multipart', 'Content-Type': 'multipart/related; boundary=' + boundary }, body, signal });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.file) throw new Error('PDF を上げられなかった: HTTP ' + res.status + ' ' + JSON.stringify(j.error || j).slice(0, 200));
      // 使えるようになるまで待つ
      let f = j.file;
      for (let i = 0; i < 30 && f.state === 'PROCESSING'; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const g = await fetch(API + '/v1beta/' + f.name, { headers: { 'x-goog-api-key': key }, signal });
        f = await g.json();
      }
      if (f.state === 'FAILED') throw new Error('Gemini が PDF を受け付けなかった');
      return { name: f.name, uri: f.uri };
    }
    async function deleteFile(key, name) {
      await fetch(API + '/v1beta/' + name, { method: 'DELETE', headers: { 'x-goog-api-key': key } });
    }
    async function callGemini(key, body, signal) {
      // 試験のための差し替え口（外へ送らない）
      if (typeof self.__hiroiGeminiStub === 'function') return self.__hiroiGeminiStub(body, { model: opts.model });
      const url = API + '/v1beta/models/' + encodeURIComponent(opts.model) + ':generateContent';
      let last = '';
      for (let i = 1; i <= 3; i++) {
        let res;
        try {
          res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal });
        } catch (e) {
          if (signal && signal.aborted) throw cancelled();
          last = '通信の失敗: ' + e.message;
          await new Promise((r) => setTimeout(r, 3000 * i));
          continue;
        }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          last = 'HTTP ' + res.status + ' ' + ((data && data.error && data.error.message) || '').slice(0, 300);
          if (res.status === 429 || res.status >= 500) {
            phase('Gemini が混んでいます。待って送り直します（' + i + ' 回目）');
            await new Promise((r) => setTimeout(r, 5000 * i));
            continue;
          }
          throw new Error(last);
        }
        const cand = ((data && data.candidates) || [])[0] || {};
        const text = ((cand.content || {}).parts || []).filter((x) => x.text && !x.thought).map((x) => x.text).join('');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          last = '応答を読めなかった（finish=' + (cand.finishReason || '?') + '・' + text.length + ' 文字）';
          if (cand.finishReason === 'MAX_TOKENS') throw new Error(last + '。送るページや注釈を減らしてください');
          continue;
        }
        return { json, usage: data.usageMetadata, finish: cand.finishReason };
      }
      throw new Error(last || 'できなかった');
    }

    /* ======================================================================
     * 描き直し
     * ====================================================================== */
    function render() {
      if (!st.pageId || !store.page(st.pageId)) {
        const ps = pages();
        st.pageId = null;
        if (ps.length) {
          st.pageId = (ps.find((p) => p.send) || ps[0]).id;
          st.needFit = true;
          st.bitmap = null;
        }
      }
      if (st.sel && !store.annotation(st.sel)) st.sel = null;
      renderBar();
      renderLeft();
      renderRight();
      renderHint();
      if (st.needFit) fit();
      draw();
    }
    const renderAll = () => ctx.renderAll();

    return {
      render,
      shown: () => setTimeout(resize, 0),
      setPage,
      startRun,
      state: st,
      opts,
      _: { planNow, subsetPdf, renderCrop, applyResult, tagMap },
    };
  };
})();
