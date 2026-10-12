/*
 * 拾いツール — Itera の上で動くときだけ効く橋（T-0643）。
 *
 *   保存   作業（ストアの状態）と図面の PDF を、ブラウザの localStorage／IndexedDB ではなく Itera の VFS に置く
 *          （data/apps/hiroi-tool/current/{job.json, source.pdf, source.json}）。Itera の AI も同じファイルを読める
 *   道具   Itera の AI（エンジン）に道具を公開する（MetaOS.tools.register）:
 *            hiroi_status   図面・ページ・注釈・パレットの要約
 *            hiroi_page     ページの縮小画像を VFS に書き、そのパスを返す（AI は read_file で見る）
 *            hiroi_crop     注釈の切り抜き画像（300 dpi。大きければタイル）を VFS に書いて返す
 *            hiroi_palette  パレットの中身（id 付き）を読む
 *            hiroi_apply    編集の塊を入れる（図面解析の応答と同じ形。core/analysis.js の apply。履歴 1 行 → 元に戻せる）
 *            hiroi_undo     最後の編集を元に戻す
 *            hiroi_open     VFS の PDF を開く
 *            hiroi_show     画面（タブ・ページ）を切り替える
 *            hiroi_detect   GP の提案（T-0646）: ページの特徴量を用意する・手本から探す・提案をまとめて承認／退ける
 *          AI が書いたものは、図面解析と同じく by: 'llm' を持ち、人が画面で直せる。
 *   起動   spawn の引数 file=<VFS の PDF> があれば、その図面を開く
 *
 * 単体（GitHub Pages）では self.MetaOS が無いので、何もしない。
 * 画面（app.js）とは ctx だけでつながる。編集は ctx.edit（ストアの 1 回の編集）を通す。
 */
(function () {
  'use strict';

  const BASE = 'data/apps/hiroi-tool/current';
  const JOB = BASE + '/job.json';
  const PDF = BASE + '/source.pdf';
  const PDF_META = BASE + '/source.json';
  const SHOTS = BASE + '/shots';
  // GP の特徴抽出器（ONNX・3.7 MB）。VFS にあればそれ（上から順）、無ければホストのオリジン（配信物の public/demo/hiroi/）から取る
  const MODEL_VFS = ['data/apps/hiroi-tool/gp_features_v1.onnx', 'system/demo/hiroi/model/gp_features_v1.onnx'];
  const MODEL_WEB = '/demo/hiroi/gp_features_v1.onnx';

  self.SMIteraBridge = function (ctx) {
    const M = self.MetaOS;
    if (!M) return null;
    const { store, edit, app, toast, setScreen, setPage, attachPdf } = ctx;
    const GP = ctx.gp || null; // 口「検出」と提案の操作（app.js の gp*）。無ければ hiroi_detect は「無い」と返す
    const P = ctx.P || (() => store.palette);
    const A = self.SMA;
    const SM = self.SM;

    /* ======================================================================
     * 保存（VFS）
     * ====================================================================== */
    let dirReady = null;
    async function ensureDirs() {
      if (dirReady) return dirReady;
      dirReady = (async () => {
        for (const d of [BASE, SHOTS]) {
          try {
            if (!(await M.fs.exists(d))) await M.fs.mkdir(d);
          } catch (e) {
            /* 既にある・作れない: 書くときに分かる */
          }
        }
      })();
      return dirReady;
    }
    async function writeText(path, text) {
      await ensureDirs();
      await M.fs.write(path, text, { overwrite: true });
    }
    async function writeBinary(path, data) {
      await ensureDirs();
      await M.fs.write(path, data, { overwrite: true });
    }
    async function readJson(path) {
      try {
        if (!(await M.fs.exists(path))) return null;
        return JSON.parse(await M.fs.read(path));
      } catch (e) {
        console.warn('[itera] read failed', path, e);
        return null;
      }
    }

    let saveTimer = null;
    let saving = Promise.resolve();
    function saveJob() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const text = JSON.stringify(store.state);
        saving = saving.then(() => writeText(JOB, text)).catch((e) => console.warn('[itera] save failed', e));
      }, 600);
    }
    async function flush() {
      clearTimeout(saveTimer);
      saveTimer = null;
      await writeText(JOB, JSON.stringify(store.state));
    }
    async function loadJob() {
      const st = await readJson(JOB);
      return st ? SM.migrate(st) : null;
    }
    async function savePdf(rec) {
      try {
        await writeBinary(PDF, new Uint8Array(rec.bytes.slice(0)));
        await writeText(PDF_META, JSON.stringify({ name: rec.name, fingerprint: rec.fingerprint, pages: rec.pages }));
      } catch (e) {
        console.warn(e);
        toast('PDF を VFS に残せなかった（次に開くとき、もう一度選んでください）', 4000);
      }
    }
    // モデルの中身（ArrayBuffer）。口「検出」（app/detector.js）が Worker を起こすときに呼ぶ。1 度取ったら持つ
    let modelCache = null;
    function loadModel() {
      if (modelCache) return modelCache;
      modelCache = (async () => {
        for (const p of MODEL_VFS) {
          try {
            if (await M.fs.exists(p)) {
              const b = await M.fs.read(p, { encoding: 'binary' });
              if (b && b.byteLength > 1000) return b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b;
            }
          } catch (e) {
            console.warn('[itera] model read failed', p, e);
          }
        }
        // ホストのオリジン: Chrome は ancestorOrigins、Firefox には無いので referrer（親の URL）から
        let origin = (self.location.ancestorOrigins && self.location.ancestorOrigins[0]) || '';
        if (!origin && self.document && self.document.referrer) { try { origin = new URL(self.document.referrer).origin; } catch (e) { /* 無ければ相対 */ } }
        const url = self.HIROI_MODEL_URL || origin + MODEL_WEB;
        if (!M.net) throw new Error('モデルが VFS に無く、ホストから取る口も無い: ' + url);
        // ホストに落としてもらって VFS に置く（次からは VFS から。IPC に 3.7 MB を通さない）。download が無ければ fetch
        if (M.net.download) {
          try {
            await M.net.download(url, MODEL_VFS[0]);
            const b = await M.fs.read(MODEL_VFS[0], { encoding: 'binary' });
            if (b && b.byteLength > 1000) return b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b;
            throw new Error('落としたファイルが小さすぎる（' + (b ? b.byteLength : 0) + ' bytes）');
          } catch (e) {
            console.warn('[itera] model download failed, trying fetch', e);
            try { await M.fs.delete(MODEL_VFS[0], { permanent: true }); } catch (e2) { /* 無ければよい */ }
          }
        }
        if (!M.net.fetch) throw new Error('モデルを取れない: ' + url);
        const r = await M.net.fetch(url, { responseType: 'arraybuffer' });
        if (!r || !r.data || (r.status && r.status >= 400)) throw new Error('モデルを取れない: ' + url + (r && r.status ? ' (HTTP ' + r.status + ')' : ''));
        const d = r.data;
        if (d.byteLength < 1000) throw new Error('モデルが小さすぎる（' + d.byteLength + ' bytes）: ' + url);
        return d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d;
      })();
      modelCache.catch(() => { modelCache = null; });
      return modelCache;
    }
    async function loadPdf() {
      const meta = await readJson(PDF_META);
      if (!meta) return null;
      try {
        if (!(await M.fs.exists(PDF))) return null;
        const bytes = await M.fs.read(PDF, { encoding: 'binary' });
        return { name: meta.name, fingerprint: meta.fingerprint, pages: meta.pages, bytes: bytes.buffer ? bytes.buffer : bytes };
      } catch (e) {
        console.warn('[itera] pdf read failed', e);
        return null;
      }
    }
    async function reset() {
      for (const f of [JOB, PDF, PDF_META]) {
        try {
          if (await M.fs.exists(f)) await M.fs.delete(f);
        } catch (e) {
          console.warn('[itera] delete failed', f, e);
        }
      }
    }
    async function openVfsPdf(path) {
      const bytes = await M.fs.read(path, { encoding: 'binary' });
      const name = path.split('/').pop();
      return attachPdf(bytes.buffer ? bytes.buffer : bytes, name);
    }

    /* ======================================================================
     * 画像（ページ・切り抜き）
     * ====================================================================== */
    function pageByNumber(n) {
      const p = store.state.pages.find((x) => x.index === n);
      if (!p) throw new Error('p.' + n + ' は無い（ページは 1〜' + store.state.pages.length + '）');
      return p;
    }
    async function renderRect(index, rect, scale) {
      const ppg = app.pdfPages && app.pdfPages.get(index);
      if (!ppg) throw new Error('p.' + index + ' を描けない（PDF が開いていない）');
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(rect[2] * scale));
      c.height = Math.max(1, Math.round(rect[3] * scale));
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      await ppg.render({ canvasContext: g, viewport: ppg.getViewport({ scale }), transform: [1, 0, 0, 1, -rect[0] * scale, -rect[1] * scale] }).promise;
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      return { blob, w: c.width, h: c.height };
    }
    async function writeShot(name, img) {
      const path = SHOTS + '/' + name;
      await writeBinary(path, img.blob);
      return path + ' (' + img.w + '×' + img.h + ', ' + Math.round(img.blob.size / 1024) + ' KB)';
    }
    /*
     * 「AI に頼む」の下ごしらえ（T-0647）: 送るページの縮小画像と注釈の切り抜きを一括で描いて、
     * 頼みごとのディレクトリ（shots/ask-<日時>/）に置く。AI は read_file で読むだけ（hiroi_page / hiroi_crop を 1 枚ずつ呼ばない）。
     * pl は A.plan の戻り。hooks.phase(文) で進みを知らせ、hooks.cancelled() が真なら途中で止める。
     * ページは hooks.pdfFor([n]) があれば **そのページだけの PDF**（字が読める。縮小画像では表の字が読めなかった）、無ければ・失敗したら縮小画像（PNG）。
     * 戻り: { dir, pages: [{ page, path, title, width, height, pdf: true } | { page, path, w, h, kb, k, title, pdf: false }], crops: [{ annotation, page, kind, title, note, allPages, paths: [{ path, w, h, kb }] }] }
     */
    async function exportPlan(pl, hooks) {
      const H = Object.assign({ phase: () => {}, cancelled: () => false, pageDpi: 60 }, hooks || {});
      const d = new Date();
      const z = (n) => String(n).padStart(2, '0');
      const dir = SHOTS + '/ask-' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
      await ensureDirs();
      if (!(await M.fs.exists(dir))) await M.fs.mkdir(dir);
      const put = async (name, img) => {
        const path = dir + '/' + name;
        await M.fs.write(path, img.blob, { overwrite: true });
        return { path, w: img.w, h: img.h, kb: Math.round(img.blob.size / 1024) };
      };
      const pages = [];
      for (let i = 0; i < pl.pages.length; i++) {
        if (H.cancelled()) throw new Error('cancelled');
        const n = pl.pages[i];
        H.phase('ページを描いています（' + (i + 1) + ' / ' + pl.pages.length + '）');
        const pg = pageByNumber(n);
        let done = false;
        if (H.pdfFor) {
          try {
            const bytes = await H.pdfFor([n]);
            const path = dir + '/p' + String(n).padStart(3, '0') + '.pdf';
            await M.fs.write(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { overwrite: true });
            pages.push({ page: n, path, title: pg.title || '', width: pg.width, height: pg.height, kb: Math.round(bytes.length / 1024), pdf: true });
            done = true;
          } catch (e) {
            console.warn('[ask] page pdf failed, falling back to png', e);
          }
        }
        if (!done) {
          const img = await renderRect(n, [0, 0, pg.width, pg.height], H.pageDpi / 72);
          pages.push(Object.assign({ page: n, k: SM.round(72 / H.pageDpi, 4), title: pg.title || '', pdf: false }, await put('p' + String(n).padStart(3, '0') + '.png', img)));
        }
      }
      const crops = [];
      const total = pl.crops.reduce((s, c) => s + c.tiles.length, 0);
      let done = 0;
      for (const c of pl.crops) {
        const paths = [];
        for (let i = 0; i < c.tiles.length; i++) {
          if (H.cancelled()) throw new Error('cancelled');
          done++;
          H.phase('切り抜きを描いています（' + done + ' / ' + total + '）');
          const img = await renderRect(c.page, c.tiles[i], c.scale);
          paths.push(await put(c.annotation + '_p' + String(c.page).padStart(3, '0') + (c.tiles.length > 1 ? '_' + (i + 1) : '') + '.png', img));
        }
        crops.push({ annotation: c.annotation, page: c.page, kind: c.kind, title: c.title, note: c.note, allPages: c.allPages, paths });
      }
      return { dir, pages, crops };
    }

    /* ======================================================================
     * 文字にする（AI へ返すもの）
     * ====================================================================== */
    const n2 = (x) => (x === null || x === undefined ? '' : Math.round(x * 10) / 10);
    function statusText() {
      const st = store.state;
      const d = st.doc || {};
      const lines = [];
      lines.push('図面: ' + (d.name ? d.name + '（' + d.pages + ' ページ' + (d.sample ? '・サンプル図面' : '') + '）' : '（開いていない）'));
      const pick = st.pages.filter((p) => p.pick === true).length;
      const send = st.pages.filter((p) => p.send === true).length;
      const tagged = st.pages.filter((p) => p.title && !/^p\.\d+$/.test(p.title)).length;
      lines.push('ページ: ' + st.pages.length + '（拾う ' + pick + '・送る ' + send + '・題あり ' + tagged + '）');
      const anns = (st.annotations || []).map((a) => {
        const pg = st.pages.find((p) => p.id === a.page);
        return '  ' + a.id + ' p.' + (pg ? pg.index : '?') + ' [' + A.kind(a.kind).name + '] ' + (a.title || '') + (a.allPages ? '（全ページ）' : '') + (a.note ? ' — ' + a.note : '');
      });
      lines.push('注釈: ' + anns.length + (anns.length ? '\n' + anns.join('\n') : ''));
      const pal = st.palette;
      lines.push('パレット: カテゴリ ' + pal.categories.length + '・ラベル ' + pal.labels.length + '・規則 ' + pal.labels.reduce((s, l) => s + ((l.rules && l.rules.length) || 0), 0) + '・見込み ' + ((pal.expected && pal.expected.length) || 0) + '・系統 ' + ((pal.systems && pal.systems.length) || 0));
      lines.push('図面の上: エリア ' + st.areas.length + '・ルート ' + st.routes.length + '・拾い ' + st.pickups.length + '（箱 ' + st.pickups.filter((p) => p.kind === 'box').length + '・うち GP の承認 ' + st.pickups.filter((p) => p.by === 'gp').length + '）');
      lines.push(gpText());
      const notes = (st.analysis && st.analysis.notes) || [];
      lines.push('覚え書き: ' + notes.length + '・元に戻せる編集 ' + store.undoStack.length);
      if (st.analysis && st.analysis.focus) lines.push('今回の範囲: ' + st.analysis.focus);
      const digest = A.paletteDigest(pal, 80);
      if (digest) lines.push('', digest);
      return lines.join('\n');
    }
    // GP の提案の様子（hiroi_status の 1 行。詳しくは hiroi_detect）
    function gpText() {
      const det = GP && GP.detector();
      if (!det) return 'GP: （この環境では使えない）';
      const st = store.state;
      const feats = [];
      for (const pg of st.pages) {
        const x = det.status(pg.id);
        if (x.status === 'none') continue;
        feats.push('p.' + pg.index + ' ' + (x.status === 'ready' ? '済' : x.status === 'working' ? '計算中 ' + x.done + '/' + (x.total || '?') : 'できなかった'));
      }
      const props = st.proposals || [];
      const byPage = {};
      for (const pr of props) { const pg = st.pages.find((p) => p.id === pr.page); const k = 'p.' + (pg ? pg.index : '?'); byPage[k] = (byPage[k] || 0) + 1; }
      return 'GP: 特徴量 ' + (feats.length ? feats.join('・') : '無し') + '／提案 ' + props.length + (props.length ? '（' + Object.entries(byPage).map(([k, n]) => k + ' ' + n).join('・') + '・閾値 ' + Math.round(thrDefault() * 100) + '%）' : '') + '／退けた場所 ' + ((st.rejections || []).length);
    }
    const thrDefault = () => (app && app.gp && typeof app.gp.threshold === 'number' ? app.gp.threshold : 0.5);
    function categoryByRef(ref) {
      const pal = P();
      const r = String(ref || '').trim();
      if (!r) throw new Error('category が要る（id か名前）');
      const c = pal.categories.find((c) => c.id === r) || pal.categories.filter((c) => c.name === r);
      if (Array.isArray(c)) {
        if (c.length === 1) return c[0];
        if (c.length > 1) throw new Error('名前「' + r + '」のカテゴリが ' + c.length + ' つある。id で指す: ' + c.map((x) => x.id + '（親 ' + ((pal.category(x.parent) || {}).name || '根') + '）').join('・'));
        throw new Error('カテゴリ「' + r + '」は無い（hiroi_palette で見る）');
      }
      return c;
    }
    function paletteText(part, q) {
      const st = store.state;
      const pal = st.palette;
      const needle = (q || '').trim().toLowerCase();
      const has = (s) => !needle || String(s || '').toLowerCase().includes(needle);
      const parts = part ? part.split(',').map((s) => s.trim()) : ['categories', 'labels', 'rules', 'expected', 'systems', 'notes'];
      const out = [];
      const nameOf = (list, id) => {
        const x = list.find((e) => e.id === id);
        return x ? x.name : id;
      };
      if (parts.includes('categories')) {
        out.push('## カテゴリ（id | 名前 | 親 | 数え方 | 構成）');
        for (const c of pal.categories) {
          if (!has(c.name) && !has(c.id)) continue;
          const comps = (c.components || []).map((k) => nameOf(pal.categories, k.material) + '×' + k.count + (k.add ? '+余長' : '') + (k.when && k.when.length ? '(' + k.when.map((w) => nameOf(pal.labels, w)).join('/') + ')' : '')).join(', ');
          out.push([c.id, c.name, c.parent ? nameOf(pal.categories, c.parent) : '(根)', c.size || '', comps].join(' | ') + (c.by === 'llm' ? ' [llm]' : ''));
        }
      }
      if (parts.includes('labels') || parts.includes('rules')) {
        out.push('## ラベル（id | 名前 | 親 | 規則: カテゴリ → 候補）');
        for (const l of pal.labels) {
          const rules = (l.rules || []).map((r) => nameOf(pal.categories, r.category) + ' → ' + (r.candidates || []).map((k) => nameOf(pal.categories, k)).join('/')).join('; ');
          if (parts.includes('rules') && !parts.includes('labels') && !rules) continue;
          if (!has(l.name) && !has(l.id) && !has(rules)) continue;
          out.push([l.id, (l.root ? '# ' : '') + l.name, l.parent ? nameOf(pal.labels, l.parent) : '(木)', rules].join(' | ') + (l.by === 'llm' ? ' [llm]' : ''));
        }
      }
      if (parts.includes('expected')) {
        out.push('## 見込み（ラベル | カテゴリ | 個数）');
        for (const e of pal.expected || []) out.push([(e.labels || []).map((k) => nameOf(pal.labels, k)).join('/'), nameOf(pal.categories, e.category), e.count].join(' | '));
      }
      if (parts.includes('systems')) {
        out.push('## 系統（名前 | 起点 | 終点 | カテゴリ | 配線）');
        for (const s of pal.systems || []) if (has(s.name) || has(s.text)) out.push([s.name, s.from, s.to, s.category ? nameOf(pal.categories, s.category) : '', s.text].join(' | '));
      }
      if (parts.includes('notes')) {
        out.push('## 覚え書き（id | 種類 | 文 | ページ）');
        for (const nt of (st.analysis && st.analysis.notes) || []) if (has(nt.text)) out.push([nt.id, nt.kind, nt.text, (nt.pages || []).join(',')].join(' | '));
      }
      return out.join('\n');
    }

    /* ======================================================================
     * 道具
     * ====================================================================== */
    const DEFS = {
      hiroi_status: `<define_tag name="hiroi_status">
拾いツール（積算支援）の今を返す: 開いている図面・ページの数（拾う／送る）・注釈の一覧（id・ページ・種類・題）・パレットの要約（カテゴリとラベルの木）・図面の上の層と拾いの数。
Attributes: なし
Note: まずこれを呼んで、注釈の id とパレットの名前を知る。細かい中身は hiroi_palette、画像は hiroi_page / hiroi_crop。
</define_tag>`,
      hiroi_page: `<define_tag name="hiroi_page">
図面のページを画像（PNG）にして VFS に書き、そのパスを返す。read_file でそのパスを読むと画像として見える。
Attributes:
  - page (required): ページ番号（1 始まり）
  - dpi (optional): 既定 60（A3 で 約 1000 px）。上限 150。字を読むには hiroi_crop で範囲を切り抜くほうがよい
Note: ページ全体の把握（図面か表か・どこに表があるか）に使う。細かい字は読めない。
</define_tag>`,
      hiroi_crop: `<define_tag name="hiroi_crop">
注釈（人が囲った読みどころ）の切り抜きを 300 dpi の PNG にして VFS に書き、パスを返す（大きければ 1536 px のタイルに分ける）。read_file で読む。
Attributes:
  - annotation (required): 注釈の id（hiroi_status の一覧。例 an-0001）
  - page (optional): 注釈が「全ページ」のとき、どのページの同じ位置を切り抜くか（既定: 注釈のページ）
  - dpi (optional): 既定 300。上限 400
Note: 表（器具表・配線表）はこれで読む。読んだら hiroi_apply で書く。
</define_tag>`,
      hiroi_palette: `<define_tag name="hiroi_palette">
パレットの中身を id 付きで返す（カテゴリ・ラベルと規則・見込み・系統・覚え書き）。
Attributes:
  - part (optional): カンマ区切り。categories, labels, rules, expected, systems, notes（既定: 全部）
  - q (optional): 名前の部分一致で絞る
</define_tag>`,
      hiroi_apply: `<define_tag name="hiroi_apply">
パレット・ページの欄・覚え書きへの編集を、まとめて入れる（履歴 1 行。人は元に戻せる）。
Content: JSON。図面解析の応答と同じ形。要る鍵だけでよい:
  {
    "pages":      [{ "page": 36, "title": "電灯設備図 1階平面図", "sheet": "E-36", "kinds": ["図面"], "work": "電灯", "floor": "1F", "scale": "1:200", "summary": "…", "pick": true }],
    "label_trees":[{ "key": "t1", "name": "部屋" }],
    "labels":     [{ "key": "l1", "name": "玄関・風除室", "tree": "t1", "parent": null, "source": ["an-0001"] }],
    "categories": [{ "key": "c1", "name": "照明器具", "parent": null, "size": "個数" },
                   { "key": "c2", "name": "GS100", "parent": "c1", "size": "個数", "spec": "LED ダウンライト 100形", "source": ["an-0001"] }],
    "components": [{ "owner": "c3", "material": "c4", "count": 2, "when": ["l9"], "add_slack": true }],
    "rules":      [{ "label": "l1", "category": "c1", "candidates": ["c2"], "source": ["an-0001"] }],
    "expected":   [{ "labels": ["l1"], "category": "c2", "count": 4, "source": ["an-0001"] }],
    "systems":    [{ "name": "1A2", "from": "キュービクル", "to": "L1-1", "category": "c5", "text": "CVT 100 E14×2 (G82)" }],
    "notes":      [{ "kind": "注意", "text": "…", "pages": [36], "source": ["an-0002"] }]
  }
  - key / parent / tree / label / category / candidates / owner / material は、この JSON の中の key で指す。親は同じ JSON に入れる（無ければ根の下に置かれる）
  - 同じ親の下の同じ名前は、いまあるものを使う（増えない）。既存の項目を指すには、その名前で同じ親の下に書く
  - size は "個数" か "長さ"。kind は 注意／決まり／疑問／その他。source は注釈の id かページ（"p.36"）
Returns: 入れた数（ページ・カテゴリ 追加/再利用・ラベル・構成・規則・見込み・系統・覚え書き）と知らせ。
Note: 一度に全部を書こうとしない。注釈 1 つ読んだら、その分だけ入れる。
</define_tag>`,
      hiroi_annotate: `<define_tag name="hiroi_annotate">
図面の上に注釈（読みどころ）を囲う。人が囲うのと同じもの（図面解析のタブに出る）。囲ったら hiroi_crop で読める。
Attributes:
  - page (required): ページ番号（1 始まり）
  - bbox (required): "x,y,w,h"（PDF のポイント。**原点は左上、y は下向き**。hiroi_page の戻りにある「1 px = k pt」を掛けて換算: x_pt = x_px × k。w・h も同じ）
  - kind (optional): spec（仕様書）| legend（凡例）| schedule（機器表）| wiring（配線表）| note（注記）| layer（層の手がかり）| object（対象の見本）| caution（注意）| title（題欄）。既定 schedule
  - title (optional): 題（例 "器具表"）
  - note (optional): 覚え書き（読むときの注意）
  - all_pages (optional): "true" で、送る全ページの同じ位置（題欄に）
Returns: 注釈の id
</define_tag>`,
      hiroi_undo: `<define_tag name="hiroi_undo">
最後の編集を元に戻す（人の編集も含む。直前の hiroi_apply を取り消すときに）。
Attributes: なし
</define_tag>`,
      hiroi_open: `<define_tag name="hiroi_open">
VFS にある PDF を図面として開く。いまの図面と同じなら つなぎ直し、違えばパレットだけ残して新しく始める（図面の上の層と拾いがあれば、画面で利用者に確かめる）。
Attributes:
  - path (required): VFS のパス（.pdf）
</define_tag>`,
      hiroi_show: `<define_tag name="hiroi_show">
画面を切り替える（利用者に見せるため）。
Attributes:
  - screen (optional): analyze（図面解析）| pick（拾い）| table（集計）| palette（パレット）
  - page (optional): ページ番号（1 始まり）
</define_tag>`,
      hiroi_detect: `<define_tag name="hiroi_detect">
GP の提案（記号の検出）。利用者が置いた箱を手本に、同じ記号の場所をページから探して「提案」（点線の箱）にする。提案は拾いではない —— 承認すると拾い（箱）になり、集計に数えられる。退けた場所は次から負例になる。
Attributes:
  - action (required): prepare（ページの特徴量を用意する。数秒〜数十秒）| search（手本から探す）| approve（提案を承認）| reject（提案を退ける）
  - page (required): ページ番号（1 始まり）
  - category (search / approve / reject。search では必須): カテゴリの id か名前。search はこのカテゴリ（とその下）の箱が手本・他のカテゴリの箱が負例。approve / reject では省くと全部
  - threshold (optional): 0〜1。search で返す・approve で承認する提案の下限（既定は画面の閾値 50%）
  - ids (optional): approve / reject で、提案の id をカンマ区切り（省くと page のその category の提案を全部）
Returns: prepare → 状態（セルの数・秒・WebGPU か wasm か）／search → 提案の一覧「id bbox(x,y,w,h pt) 点数」（手本と負例の数つき）／approve / reject → 数
Note: 手本が無ければ search は探せない —— まず利用者に箱を 1 つ置いてもらう（hiroi_apply では箱は置けない）。承認は利用者の判断を代行することになるので、点数の高いものだけに留め、低いものは利用者に見てもらう。
</define_tag>`,
    };

    const handlers = {
      async hiroi_status() {
        return statusText();
      },
      async hiroi_page(p) {
        const n = Number(p.page);
        const pg = pageByNumber(n);
        const dpi = Math.min(150, Math.max(20, Number(p.dpi) || 60));
        const img = await renderRect(n, [0, 0, pg.width, pg.height], dpi / 72);
        const k = SM.round(72 / dpi, 4);
        return 'Saved: ' + (await writeShot('p' + String(n).padStart(3, '0') + '_' + dpi + 'dpi.png', img)) + '\n題: ' + (pg.title || '') + (pg.kinds && pg.kinds.length ? '（' + pg.kinds.join('・') + '）' : '') + '\nページの大きさ: ' + n2(pg.width) + ' × ' + n2(pg.height) + ' pt（原点は左上。画像の 1 px = ' + k + ' pt。hiroi_annotate の bbox は 画像の px × ' + k + '）';
      },
      async hiroi_crop(p) {
        const a = (store.state.annotations || []).find((x) => x.id === p.annotation);
        if (!a) throw new Error('注釈 ' + p.annotation + ' は無い（hiroi_status で id を見る）');
        const own = store.state.pages.find((x) => x.id === a.page);
        const n = p.page ? Number(p.page) : own ? own.index : null;
        if (!n) throw new Error('ページが決まらない');
        if (p.page && !a.allPages && own && own.index !== n) throw new Error('注釈 ' + a.id + ' は p.' + own.index + ' のもの（全ページではない）');
        const dpi = Math.min(400, Math.max(72, Number(p.dpi) || 300));
        const tl = A.tilesFor(a.bbox, { scale: dpi / 72 });
        const out = [];
        for (let i = 0; i < tl.tiles.length; i++) {
          const img = await renderRect(n, tl.tiles[i], tl.scale);
          out.push(await writeShot(a.id + '_p' + String(n).padStart(3, '0') + (tl.tiles.length > 1 ? '_' + (i + 1) : '') + '.png', img));
        }
        return '注釈 ' + a.id + ' [' + A.kind(a.kind).name + '] ' + (a.title || '') + ' p.' + n + (a.note ? '\n覚え書き: ' + a.note : '') + '\n読み方: ' + A.kind(a.kind).ask + '\nSaved (' + out.length + '):\n' + out.map((s) => '  ' + s).join('\n');
      },
      async hiroi_palette(p) {
        return paletteText(p.part, p.q) || '（空）';
      },
      async hiroi_apply(p) {
        let raw;
        try {
          raw = JSON.parse(String(p.content || '').trim());
        } catch (e) {
          throw new Error('JSON として読めない: ' + e.message);
        }
        const sum = edit('AI の編集', (S) => A.apply(S, raw, {}));
        if (!sum) throw new Error('入れられなかった');
        saveJob();
        return '入れた: ページ ' + sum.pages + '・カテゴリ +' + sum.categories.added + '（再利用 ' + sum.categories.reused + '）・ラベル +' + sum.labels.added + '（再利用 ' + sum.labels.reused + '）・構成 ' + sum.components + '・規則 ' + sum.rules + '・見込み ' + sum.expected + '・系統 ' + sum.systems + '・覚え書き ' + sum.notes + (sum.warnings.length ? '\n知らせ:\n' + sum.warnings.map((w) => '  - ' + w).join('\n') : '');
      },
      async hiroi_annotate(p) {
        const pg = pageByNumber(Number(p.page));
        const bbox = String(p.bbox || '').split(/[,\s]+/).filter(Boolean).map(Number);
        if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || bbox[2] <= 0 || bbox[3] <= 0) throw new Error('bbox は "x,y,w,h"（正の数）');
        const kind = A.kind(p.kind || 'schedule').id;
        let id = null;
        const r = edit('AI が囲った', (S) => {
          id = S.addAnnotation(pg.id, bbox, kind, { title: p.title || '', note: p.note || '', allPages: p.all_pages === 'true' || p.all_pages === true, by: 'llm' });
          return id;
        });
        if (!r) throw new Error('囲えなかった');
        saveJob();
        return '囲った: ' + id + ' p.' + pg.index + ' [' + A.kind(kind).name + '] ' + (p.title || '');
      },
      async hiroi_undo() {
        if (!store.undoStack.length) return '戻すものが無い';
        store.undo();
        saveJob();
        return '戻した（残り ' + store.undoStack.length + '）';
      },
      async hiroi_open(p) {
        if (!p.path || !/\.pdf$/i.test(p.path)) throw new Error('path は .pdf');
        const ok = await openVfsPdf(p.path);
        return ok ? '開いた: ' + p.path + '（' + store.state.pages.length + ' ページ）' : '開かなかった（利用者が やめた、または読めない）';
      },
      async hiroi_show(p) {
        if (p.screen) setScreen(p.screen);
        if (p.page) setPage(pageByNumber(Number(p.page)).id);
        return 'ok';
      },
      async hiroi_detect(p) {
        const det = GP && GP.detector();
        if (!det) throw new Error('この環境では GP の提案が使えない（口「検出」が無い）');
        const pg = pageByNumber(Number(p.page));
        const action = String(p.action || '').trim();
        const thr = p.threshold !== undefined && p.threshold !== '' ? Math.max(0, Math.min(1, Number(p.threshold))) : thrDefault();
        const fmt = (pr) => pr.id + ' [' + pr.bbox.map((v) => n2(v)).join(',') + '] ' + Math.round(pr.score * 100) + '%';
        if (action === 'prepare') {
          const fp = await det.ensurePage(pg.id);
          const x = det.status(pg.id);
          if (ctx.renderAll) ctx.renderAll();
          return 'p.' + pg.index + ' の特徴量: 済（セル ' + fp.meta.cells + (x.ms ? '・' + Math.round(x.ms / 100) / 10 + ' 秒' : '・保存から') + ((det.envText && det.envText()) || fp.meta.ep ? '・' + ((det.envText && det.envText()) || fp.meta.ep) : '') + '）';
        }
        if (action === 'search') {
          const cat = categoryByRef(p.category);
          if (det.status(pg.id).status !== 'ready') await det.ensurePage(pg.id);
          const n = GP.search(cat.id, pg.id, { quiet: true });
          if (ctx.renderAll) ctx.renderAll();
          if (n < 0) {
            const ex = store.state.pickups.filter((b) => b.kind === 'box' && (b.category === cat.id || P().categoryAncestors(b.category).includes(cat.id)));
            return '手本が無い: 「' + cat.name + '」の箱が' + (ex.length ? '特徴量のあるページに無い（箱 ' + ex.length + ' は特徴量の無いページ。そのページを prepare する）' : '1 つも無い。利用者に 1 つ囲ってもらう');
          }
          const list = store.proposalsOn(pg.id).filter((pr) => pr.category === cat.id && pr.score >= thr).sort((a, b) => b.score - a.score);
          saveJob();
          return '「' + cat.name + '」の提案 p.' + pg.index + ': ' + list.length + '（閾値 ' + Math.round(thr * 100) + '%・全 ' + n + '）' + (list.length ? '\n' + list.map(fmt).join('\n') : '') + '\n利用者の画面に点線で出ている。承認は hiroi_detect action=approve（ids で選べる）';
        }
        if (action === 'approve' || action === 'reject') {
          const cat = p.category ? categoryByRef(p.category) : null;
          const ids = String(p.ids || '').split(/[,\s]+/).filter(Boolean);
          let list = store.proposalsOn(pg.id).filter((pr) => !cat || pr.category === cat.id);
          if (ids.length) {
            const miss = ids.filter((id) => !list.some((pr) => pr.id === id));
            if (miss.length) throw new Error('提案が無い: ' + miss.join(', ') + '（search の戻りの id を使う）');
            list = list.filter((pr) => ids.includes(pr.id));
          } else if (action === 'approve') list = list.filter((pr) => pr.score >= thr);
          if (!list.length) return '対象の提案が無い';
          const r = edit(action === 'approve' ? '提案を承認（AI・' + list.length + '）' : '提案を退ける（AI・' + list.length + '）', (S) => { for (const pr of list) action === 'approve' ? S.approveProposal(pr.id) : S.rejectProposal(pr.id); return list.length; });
          app.selection = null;
          if (ctx.renderAll) ctx.renderAll();
          saveJob();
          return (action === 'approve' ? '承認した ' : '退けた ') + (r || 0) + '（p.' + pg.index + (cat ? '・' + cat.name : '') + '）。残りの提案 ' + store.proposalsOn(pg.id).length;
        }
        throw new Error('action は prepare | search | approve | reject');
      },
    };

    async function registerTools() {
      if (!M.tools || !M.tools.register) return false;
      for (const name of Object.keys(DEFS)) {
        await M.tools.register({
          name,
          description: '拾いツール: ' + name,
          definition: DEFS[name],
          handler: async (params) => {
            try {
              return await handlers[name](params || {});
            } catch (e) {
              return '[Error] ' + (e && e.message ? e.message : String(e));
            }
          },
        });
      }
      if (M.ai && M.ai.log) {
        M.ai.log(Object.values(DEFS).join('\n') + '\n\n[System] 拾いツール（積算支援）の道具が使える。まず hiroi_status。', 'tool_available');
      }
      return true;
    }

    /* ======================================================================
     * 起動後
     * ====================================================================== */
    async function afterBoot() {
      let args = {};
      try {
        args = (await M.system.getArgs()) || {};
      } catch (e) {
        /* 引数が無い */
      }
      if (args.file && /\.pdf$/i.test(args.file)) {
        try {
          await openVfsPdf(args.file);
        } catch (e) {
          console.warn(e);
          toast('開けなかった: ' + args.file, 4000);
        }
      }
      await registerTools();
      if (typeof window !== 'undefined') window.addEventListener('unload', () => {
        for (const name of Object.keys(DEFS)) {
          try {
            M.tools.unregister(name);
          } catch (e) {
            /* */
          }
        }
      });
    }

    return { saveJob, flush, loadJob, savePdf, loadPdf, loadModel, reset, openVfsPdf, afterBoot, registerTools, handlers, DEFS, statusText, paletteText, exportPlan, paths: { BASE, JOB, PDF, PDF_META, SHOTS, MODEL_VFS, MODEL_WEB } };
  };
})();
