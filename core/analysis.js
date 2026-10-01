/*
 * 拾いツール — 図面解析（画面を持たない部分）。
 *
 * 図面解析タブで扱うもの
 *   ページの分類   題・図面番号・種類（いくつでも）・工事種目・階・縮尺・要約、拾う（拾いタブに出す）／送る（解析に使う）
 *   注釈           人が図面の上に囲う「読みどころ」。種類（仕様書・凡例・機器表…）と、機械への覚え書き
 *   解析           送るページの PDF ＋ 注釈の切り抜き（画像）を LLM に 1 回渡し、ページの分類とパレット（カテゴリ・ラベル・規則・構成・見込み）と覚え書きを受け取る
 *
 * LLM が書いたものは、どれも人が直せる（ページの欄・パレットの画面・覚え書きの一覧）。出どころは by（'llm' / 'human'）と src（注釈の札かページ）で持つ。
 * ここは送り方（fetch・PDF の切り出し・切り抜きの描画）を知らない。それは画面の側（app/analyze.js）と試験の側が持つ。
 *
 * 依存: core/model.js（SM）
 */
(function (root, factory) {
  const SM = typeof module !== 'undefined' && module.exports ? require('./model.js') : root.SM;
  const A = factory(SM);
  if (typeof module !== 'undefined' && module.exports) module.exports = A;
  else root.SMA = A;
})(typeof self !== 'undefined' ? self : this, function (SM) {
  'use strict';

  const A = {};

  /* ======================================================================
   * 1. 言葉
   * ====================================================================== */

  // 注釈の種類。ask は機械に渡す説明（何のために囲ったか）
  A.ANNOT_KINDS = [
    { id: 'spec', name: '仕様書', color: '#7c3aed', hint: '特記仕様書・共通事項。どの設備が対象か（採用の●）、図に描かれない部材の決まり', ask: '対象の範囲（採用の●・不採用の○や取消線）と、図に描かれない部材の決まり（例: 空配管の呼び線）を読む。対象外の設備はカテゴリにせず、覚え書きにする' },
    { id: 'legend', name: '凡例', color: '#0891b2', hint: '記号と名称、線種と敷設方法の対応', ask: '記号の形と名称を読み、記号の形で見分けられる分類をカテゴリの中くらいの段に、名称・品番を葉にする。線種と敷設方法の対応は、ラベルの木「敷設」にする' },
    { id: 'schedule', name: '機器表', color: '#16a34a', hint: '器具表・姿図・盤表・機器リスト。部材の記号・品番・仕様、部屋ごとの台数', ask: '部材（カテゴリの葉）と仕様を読む。部屋・階ごとに器具と台数が書いてあれば、部屋の節ごとに規則（その部屋の器具の候補）と見込み（台数）を作る' },
    { id: 'wiring', name: '配線表', color: '#2563eb', hint: '幹線・動力・制御などの配線の一覧（番号・起点・終点・配線・配管）', ask: '行ごとの配線の書き方（例: CVT 100 E14×2 (G82)）を長さものの葉にし、構成（ケーブル・電線・電線管と本数）に分ける。番号（系統名）と起点・終点は覚え書き（系統）に書く' },
    { id: 'note', name: '注記', color: '#d97706', hint: 'その図面だけの記号や決まり', ask: '拾い方に効く決まり（規則・構成の条件・注意）を読む' },
    { id: 'layer', name: '層の手がかり', color: '#db2777', hint: '部屋名・区画・ラックや天井などの範囲。層（ラベル）にするもの', ask: '囲った範囲の中の部屋名・区画・敷設の範囲を、ラベルの節にする' },
    { id: 'object', name: '対象の見本', color: '#0d9488', hint: '拾うものの例。記号のほか、ラック・盤・キュービクルのような広い対象も', ask: 'それが何か（凡例・機器表のどの項目か）を見分け、カテゴリに入れる。見本の数え方（個数か長さか）も決める' },
    { id: 'caution', name: '注意', color: '#dc2626', hint: '範囲外・既設・別途工事・図面どうしの食い違いの疑いなど', ask: '注意すべき理由を読み、覚え書き（注意）にする。範囲外のものはカテゴリにしない' },
    { id: 'title', name: '題欄', color: '#64748b', hint: '図面名称・図面番号・縮尺の枠。「全ページ」にすると、送る全ページの同じ位置を切り抜いて添える', ask: 'ページの分類（題・図面番号・縮尺・階）に使う' },
  ];
  A.kind = (id) => A.ANNOT_KINDS.find((k) => k.id === id) || A.ANNOT_KINDS[A.ANNOT_KINDS.length - 1];

  // ページの種類（いくつでも）
  A.PAGE_KINDS = ['仕様書', '凡例', '機器表', '配線表', '系統図', '平面図', '姿図', '詳細図', '盤図', 'その他'];

  // 覚え書きの種類
  A.NOTE_KINDS = ['範囲', '図に無い部材', '決まり', '系統', '注意', '食い違い', 'その他'];

  /* ======================================================================
   * 2. 状態に足すもの（format 5 のまま、欄を足す）
   * ====================================================================== */

  // 欠けている欄を埋める（古い保存・書き出しを読んだとき）
  A.ensure = function (st) {
    if (!st) return st;
    if (!Array.isArray(st.annotations)) st.annotations = [];
    if (!st.analysis) st.analysis = { notes: [], runs: [] };
    if (!Array.isArray(st.analysis.notes)) st.analysis.notes = [];
    if (!Array.isArray(st.analysis.runs)) st.analysis.runs = [];
    if (!st.seq) st.seq = {};
    for (const k of ['an', 'nt']) if (typeof st.seq[k] !== 'number') st.seq[k] = 0;
    if (st.palette && !Array.isArray(st.palette.expected)) st.palette.expected = [];
    if (st.palette && !Array.isArray(st.palette.systems)) st.palette.systems = [];
    return st;
  };

  const S = SM.Store.prototype;
  const normEarly = (s) => (s === null || s === undefined ? '' : String(s).trim()).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
  const nextId = (st, kind) => {
    A.ensure(st);
    st.seq[kind] = (st.seq[kind] || 0) + 1;
    return kind + '-' + String(st.seq[kind]).padStart(4, '0');
  };

  /* ---- ページの分類 ---- */
  const PAGE_FIELDS = ['title', 'sheet', 'kinds', 'work', 'floor', 'scale', 'summary'];
  // ページの欄を直す。by: 'human'（既定）か 'llm'。人が直した欄は tagBy に残り、解析で上書きしない
  S.setPageMeta = function (id, patch, by) {
    const p = this.page(id);
    if (!p) return;
    const who = by || 'human';
    for (const k of PAGE_FIELDS) {
      if (patch[k] === undefined) continue;
      p[k] = k === 'kinds' ? (patch[k] || []).slice() : patch[k];
      p.tagBy = p.tagBy || {};
      p.tagBy[k] = who;
    }
    if (patch.pick !== undefined) {
      p.pick = patch.pick === null ? undefined : !!patch.pick;
      p.pickBy = patch.pick === null ? undefined : who;
    }
    if (patch.send !== undefined) p.send = !!patch.send;
    if (patch.checked !== undefined) p.checked = !!patch.checked;
  };
  // いくつかのページの「送る」「拾う」をまとめて
  S.setPagesFlag = function (ids, key, value) {
    for (const id of ids) {
      const p = this.page(id);
      if (!p) continue;
      if (key === 'send') p.send = !!value;
      if (key === 'pick') {
        p.pick = value === null ? undefined : !!value;
        p.pickBy = value === null ? undefined : 'human';
      }
    }
  };

  /* ---- 注釈 ---- */
  S.annotation = function (id) {
    return (this.state.annotations || []).find((a) => a.id === id) || null;
  };
  S.annotationsOn = function (page) {
    return (this.state.annotations || []).filter((a) => a.page === page);
  };
  // bbox: [x, y, 幅, 高さ]（PDF のポイント）
  S.addAnnotation = function (page, bbox, kind, extra) {
    A.ensure(this.state);
    const id = nextId(this.state, 'an');
    const k = A.kind(kind).id;
    this.state.annotations.push(Object.assign({ id, page, bbox: bbox.map((v) => SM.round(v, 1)), kind: k, title: '', note: '', allPages: k === 'title' }, extra || {}));
    return id;
  };
  S.updateAnnotation = function (id, patch) {
    const a = this.annotation(id);
    if (!a) return;
    for (const k of ['kind', 'title', 'note', 'allPages']) if (patch[k] !== undefined) a[k] = patch[k];
    if (patch.bbox) a.bbox = patch.bbox.map((v) => SM.round(v, 1));
  };
  S.moveAnnotation = function (id, dx, dy) {
    const a = this.annotation(id);
    if (!a) return;
    a.bbox[0] = SM.round(a.bbox[0] + dx, 1);
    a.bbox[1] = SM.round(a.bbox[1] + dy, 1);
  };
  S.removeAnnotation = function (id) {
    this.state.annotations = (this.state.annotations || []).filter((a) => a.id !== id);
  };

  /* ---- 今回の範囲（人が解析に伝えること。作業といっしょに残す） ---- */
  S.setAnalysisFocus = function (text) {
    A.ensure(this.state);
    this.state.analysis.focus = String(text || '');
  };

  /* ---- 覚え書き ---- */
  S.addNote = function (note) {
    A.ensure(this.state);
    const id = nextId(this.state, 'nt');
    this.state.analysis.notes.push(Object.assign({ id, kind: 'その他', text: '', pages: [], src: [], by: 'human', done: false }, note || {}, { id }));
    return id;
  };
  S.updateNote = function (id, patch) {
    const n = (this.state.analysis.notes || []).find((x) => x.id === id);
    if (!n) return;
    for (const k of ['kind', 'text', 'pages', 'done']) if (patch[k] !== undefined) n[k] = patch[k];
    if (patch.text !== undefined || patch.kind !== undefined) n.by = 'human';
  };
  S.removeNote = function (id) {
    this.state.analysis.notes = (this.state.analysis.notes || []).filter((x) => x.id !== id);
  };

  /* ---- 見込み（表に書いてある個数。照合に使う） ---- */
  // labels: ラベルの id の並び（どれも満たす拾い）。category: 部材の葉。count: 個数
  S.setExpected = function (labels, category, count, extra) {
    A.ensure(this.state);
    const list = this.state.palette.expected;
    const key = labels.slice().sort().join('&') + '|' + category;
    const i = list.findIndex((e) => e.labels.slice().sort().join('&') + '|' + e.category === key);
    if (count === null || count === undefined || count === '') {
      if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) {
      list[i].count = Number(count);
      if (extra) Object.assign(list[i], extra);
    } else list.push(Object.assign({ labels: labels.slice(), category, count: Number(count) }, extra || {}));
    this.touchPalette();
  };

  /* ---- 系統（配線表の行。線の名前と、消し込みに使う） ---- */
  // 同じ名前（名前が空なら 起点→終点）の系統は替える
  S.setSystem = function (sys) {
    A.ensure(this.state);
    const list = this.state.palette.systems;
    const keyOf = (x) => (x.name ? 'n:' + normEarly(x.name) : 'e:' + normEarly(x.from) + '→' + normEarly(x.to));
    const i = list.findIndex((x) => keyOf(x) === keyOf(sys));
    const rec = Object.assign({ name: '', from: '', to: '', category: null, text: '' }, i >= 0 ? list[i] : {}, sys);
    if (i >= 0) list[i] = rec;
    else list.push(rec);
    this.touchPalette();
  };
  S.addSystem = function (sys) {
    A.ensure(this.state);
    this.state.palette.systems.push(Object.assign({ name: '', from: '', to: '', category: null, text: '', by: 'human' }, sys || {}));
    this.touchPalette();
  };
  S.updateSystem = function (i, patch) {
    A.ensure(this.state);
    const x = this.state.palette.systems[i];
    if (!x) return;
    for (const k of ['name', 'from', 'to', 'category', 'text']) if (patch[k] !== undefined) x[k] = patch[k];
    x.by = 'human';
    this.touchPalette();
  };
  S.updateExpected = function (i, patch) {
    A.ensure(this.state);
    const x = this.state.palette.expected[i];
    if (!x) return;
    if (patch.labels) x.labels = patch.labels.slice();
    if (patch.category !== undefined) x.category = patch.category;
    if (patch.count !== undefined) x.count = Number(patch.count) || 0;
    x.by = 'human';
    this.touchPalette();
  };
  S.removeExpected = function (i) {
    A.ensure(this.state);
    this.state.palette.expected.splice(i, 1);
    this.touchPalette();
  };
  S.removeSystem = function (i) {
    A.ensure(this.state);
    this.state.palette.systems.splice(i, 1);
    this.touchPalette();
  };

  // 拾いタブに出すページ（拾うの印が 1 つでもあれば、印の付いたものだけ）
  A.pickPages = function (state) {
    const pages = state.pages || [];
    if (!pages.some((p) => p.pick === true)) return pages.slice();
    return pages.filter((p) => p.pick === true);
  };

  /* ======================================================================
   * 3. 送るものの計画
   * ====================================================================== */

  // 「11, 30-36」→ [11, 30, …, 36]
  A.parsePageSpec = function (text, max) {
    const out = new Set();
    for (const part of String(text || '').split(/[,，、\s]+/)) {
      if (!part) continue;
      const m = /^(\d+)\s*[-‐－~〜]\s*(\d+)$/.exec(part);
      if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (!max || i <= max) out.add(i);
      } else if (/^\d+$/.test(part)) {
        const n = Number(part);
        if (!max || n <= max) out.add(n);
      }
    }
    return [...out].sort((a, b) => a - b);
  };
  A.formatPageSpec = function (nums) {
    const s = [...new Set(nums)].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < s.length; ) {
      let j = i;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      out.push(j > i + 1 ? s[i] + '-' + s[j] : j === i + 1 ? s[i] + ', ' + s[j] : String(s[i]));
      i = j + 1;
    }
    return out.join(', ');
  };

  /*
   * 範囲を、切り抜きのタイルに分ける。scale は 1 pt あたりの画素（300 dpi ≒ 4.17）。
   * タイルの長い辺は maxPx まで。タイルが maxTiles を超えるなら、scale を minScale まで下げる。
   * 返すもの: { scale, tiles: [[x, y, 幅, 高さ]]（pt） }
   */
  A.tilesFor = function (bbox, opts) {
    const o = Object.assign({ scale: 300 / 72, minScale: 200 / 72, maxPx: 1536, overlap: 40, maxTiles: 12 }, opts || {});
    const [x, y, w, h] = bbox;
    let scale = o.scale;
    const count = (sc) => {
      const step = (o.maxPx - o.overlap) / sc;
      const nx = w * sc <= o.maxPx ? 1 : Math.ceil((w - o.overlap / sc) / step);
      const ny = h * sc <= o.maxPx ? 1 : Math.ceil((h - o.overlap / sc) / step);
      return { nx, ny, step };
    };
    let c = count(scale);
    // 少し縮めれば 1 枚に収まるなら、分けない（題欄のような細長い範囲）
    if (c.nx * c.ny > 1) {
      const fit1 = Math.min(o.maxPx / w, o.maxPx / h);
      if (fit1 >= o.minScale) {
        scale = fit1;
        c = count(scale);
      }
    }
    while (c.nx * c.ny > o.maxTiles && scale > o.minScale) {
      scale = Math.max(o.minScale, scale * 0.9);
      c = count(scale);
    }
    const tiles = [];
    const tw = Math.min(w, o.maxPx / scale);
    const th = Math.min(h, o.maxPx / scale);
    for (let j = 0; j < c.ny; j++) {
      for (let i = 0; i < c.nx; i++) {
        const tx = c.nx === 1 ? x : x + Math.min(i * c.step, w - tw);
        const ty = c.ny === 1 ? y : y + Math.min(j * c.step, h - th);
        tiles.push([SM.round(tx, 1), SM.round(ty, 1), SM.round(tw, 1), SM.round(th, 1)]);
      }
    }
    return { scale, tiles };
  };

  /*
   * 送るものを決める。返すもの:
   *   { pages: [ページの番号（1 始まり）], pageIds, crops: [{ tag, annotation, page（番号）, pageId, bbox, kind, title, note, tiles, scale }], problems: [文] }
   * opts.pages: 送るページの番号（無ければ、send の印のページ）
   */
  A.plan = function (state, opts) {
    const o = opts || {};
    A.ensure(state);
    const byId = new Map(state.pages.map((p) => [p.id, p]));
    let pages = o.pages ? o.pages.slice() : state.pages.filter((p) => p.send).map((p) => p.index);
    pages = [...new Set(pages)].sort((a, b) => a - b);
    const pageIds = pages.map((n) => (state.pages.find((p) => p.index === n) || {}).id).filter(Boolean);
    const problems = [];
    if (!pages.length) problems.push('送るページがありません（ページの一覧で「送る」に印を付けてください）');
    const anns = state.annotations.slice().sort((a, b) => {
      const pa = (byId.get(a.page) || {}).index || 0;
      const pb = (byId.get(b.page) || {}).index || 0;
      return pa - pb || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0];
    });
    const crops = [];
    let n = 0;
    for (const a of anns) {
      const pg = byId.get(a.page);
      if (!pg) continue;
      n++;
      const tag = 'A' + n;
      const targets = a.allPages ? pageIds.map((id) => byId.get(id)) : [pg];
      for (const t of targets) {
        const tl = A.tilesFor(a.bbox, o.tile);
        crops.push({ tag: a.allPages ? tag + '@p' + t.index : tag, group: tag, annotation: a.id, page: t.index, pageId: t.id, bbox: a.bbox.slice(), kind: a.kind, title: a.title || '', note: a.note || '', allPages: !!a.allPages, tiles: tl.tiles, scale: tl.scale });
      }
    }
    const images = crops.reduce((s, c) => s + c.tiles.length, 0);
    return { pages, pageIds, crops, images, problems };
  };

  /* ======================================================================
   * 4. 頼む文と、応答の形
   * ====================================================================== */

  A.SYSTEM = [
    'あなたは、電気設備の積算（数量の拾い出し）を手伝う担当です。',
    '積算士はこのあと「拾いツール」で、図面の上の記号を箱で囲い（個数もの）、配線を線で引き（長さもの）、部屋や敷設の範囲を「層」として塗ります。',
    'あなたの仕事は、拾いを始める前の準備です。渡された図面（PDF のページと、人が囲った範囲の切り抜き画像）を読み、次の 3 つを作ります。人は、あなたの出力を画面で確かめて直します。',
    '  1. ページの分類（送られた PDF のページごと）',
    '  2. パレット（拾うものの木「カテゴリ」・層の意味「ラベル」・規則・構成・見込み）',
    '  3. 覚え書き（拾う人が知っておくべきこと）',
    '',
    '## 道具の考え方',
    '- カテゴリ: 拾うものの木。根の下に粗い分類（照明器具・配線器具・盤・配線・ケーブルラック・弱電機器 など）、その下に図面の上の記号の形で見分けられる分類（例: ダウンライト・ベースライト）、葉に集計表に出る部材（器具の記号・品番。例: GS100）。積算士は、記号の形で分かる段のカテゴリで箱を置き、層の規則で葉が決まる。',
    '  - 数え方 size: 器具・機器・盤・ボックスなど個数で数えるものは「個数」、配線・電線管・ラックなど長さで数えるものは「長さ」。',
    '- 構成: 長さものの葉が、部材の集まりに展開されるとき（配線表の「CVT 100 E14×2 (G82)」→ CVT 100 × 1・IV 14 × 2・G 82 × 1）。部材は、カテゴリの木の「部材」の下に、別の葉として立てる（同じ部材は 1 つだけ）。',
    '  - 一部の区間にだけ付く部材（電線管など）は、条件のラベル when（例: 電線管 > あり）を持たせる。配線表で「(ケーブルラック) (G82)」のようにラックと電線管が並ぶときは、ラックの区間には電線管を付けない、と読む。',
    '  - add_slack: 余長を足すのはケーブルと電線だけ（true）。電線管・ラックは false。',
    '  - アース線（E14×2 など）は、電線（例: IV 14）を本数分。',
    '- ラベル: 層（図面の上の範囲）に付ける意味。木（見出し）ごとにまとめる。木の中の節どうしは排他。',
    '  - よく使う木: 工事種目（幹線・電灯・コンセント・動力 …）、階、部屋（階の節の下に置く）、敷設（ラック上・天井内・露出・地中・床下 …。凡例の線種から）、電線管（あり・なし）。図面に書いてあるものだけを作る。',
    '- 規則: ラベルの節が持つ「この範囲の中では、カテゴリ X は 候補 Y のどれか」。器具表が部屋ごとの器具を書いていれば、部屋の節ごとに、照明器具（またはその粗い分類）→ その部屋の器具の葉、の規則を作る。',
    '- 見込み expected: 表に書いてある個数（部屋 × 器具 × 台数 など）。拾ったあとの照合に使う。',
    '- 系統 systems: 配線表の行ごとの番号（系統名。例: 1A2）・起点・終点と、その行の配線の葉。積算士は線を引くときに系統名を付け、まだ引いていない系統を消し込みで確かめる。',
    '- 覚え書き notes: 対象の範囲（特記仕様書で採用された設備・採用されていない設備）、図に描かれない部材の決まり（例: 1 m 以上の空配管には呼び線）、拾い方に効く決まり、系統（配線表の番号ごとの起点 → 終点と配線）、注意（防爆・既設・別途工事）、図面どうしの食い違い（器具表と平面図の個数・部屋名の違い など）。',
    '',
    '## 読み方の決まり',
    '- 書いてあることだけを答える。推測で埋めない。読めない字は「？」にする。',
    '- 名前は図面に書いてあるとおりに書く（器具の記号・品番・部屋名・ケーブルの書き方）。',
    '- 切り抜き画像は、PDF のページより細かく読める。表や注記の中身は、切り抜きを正とする。PDF のページは、全体の把握（ページの種類・題欄・図の内容）に使う。',
    '- 人が切り抜きに付けた種類と覚え書きは、どう読んでほしいかの指示である。従う。',
    '- 拾いの対象外（特記仕様書で採用されていない設備・既設・別途工事）は、カテゴリにしない。覚え書き（範囲）に書く。',
    '- source には、根拠にした切り抜きの札（例: A3）かページ（例: p.36）を書く。いくつでもよい。',
    '- key は、この応答の中だけで使う短い名前（英数字と - _）。parent・owner・material・when・label・category・candidates は key で指す。',
    '- 規則の候補は葉の key。規則の category は、候補の共通の祖先（積算士が箱を置く段）にする。',
    '- 同じものを二度作らない（同じ部材、同じ部屋）。',
    "- 仕様（spec）は短く（品番と主な仕様だけ。60 字まで）。出力には上限があるので、長い説明で埋めない。",
    '- 読めない字が続くときは、その行・その項目を書かない。「？」や同じ文字を繰り返さない。表の中身は、ふつう切り抜きから読む（PDF のページだけでは、細かい表の字は読めないことが多い）。',
    '- 表は、全部の行・全部の箱を読む。途中で省略しない。配線表は、行の配線の書き方ごとに葉を 1 つ（同じ書き方の行は同じ葉）、系統は行ごとに 1 つ。',
  ].join('\n');

  A.PAGE_RULES = [
    '## ページの分類（pages）',
    '- 送られた PDF のページごとに 1 つ。page は元の図面のページ番号（下に対応を書く）。',
    '- title: 題欄の図面名称を書いてあるとおり（工事の名前の行は含めない）。sheet: 図面番号。scale: 縮尺の記載。',
    '- kinds: そのページに載っているものを全部（' + A.PAGE_KINDS.join('・') + '）。1 枚に平面図と機器表と注記が載ることがある。',
    '- work: 工事種目（例: 電灯設備・幹線設備・動力設備・自動火災報知設備）。floor: 図面名称に階があるとき（例: 1階）。',
    '- summary: 何が載っているか、拾いにどう使うかを 1〜2 文で。',
    '- pick: このページの図の上で拾う（記号を数える・配線を引く）なら true。平面図・系統図・縦の図は true。仕様書・凡例・機器表だけのページは false。',
  ].join('\n');

  const str = (d) => ({ type: 'STRING', description: d });
  const strs = (d) => ({ type: 'ARRAY', items: { type: 'STRING' }, description: d });

  A.SCHEMA = {
    type: 'OBJECT',
    properties: {
      pages: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            page: { type: 'INTEGER', description: '元の図面のページ番号' },
            title: str('題欄の図面名称'),
            sheet: str('図面番号'),
            kinds: { type: 'ARRAY', items: { type: 'STRING', enum: A.PAGE_KINDS.slice() } },
            work: str('工事種目'),
            floor: str('階。無ければ空文字'),
            scale: str('縮尺の記載'),
            summary: str('何が載っていて、拾いにどう使うか'),
            pick: { type: 'BOOLEAN', description: 'このページの図の上で拾うか' },
          },
          required: ['page', 'title', 'kinds', 'pick'],
        },
      },
      categories: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            key: str('この応答の中の名前'),
            name: str('カテゴリの名前（記号・品番・分類名。書いてあるとおり）'),
            parent: str('親の key。根の直下なら空文字'),
            size: { type: 'STRING', enum: ['個数', '長さ'] },
            spec: str('仕様・品名・型番など（葉なら）'),
            source: strs('根拠（切り抜きの札・ページ）'),
          },
          required: ['key', 'name', 'parent', 'size'],
        },
      },
      components: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            owner: str('構成を持つ葉の key'),
            material: str('部材の葉の key'),
            count: { type: 'NUMBER', description: '本数' },
            when: strs('付く条件のラベルの key（無ければ空）'),
            add_slack: { type: 'BOOLEAN', description: '余長を足すか（ケーブル・電線は true）' },
          },
          required: ['owner', 'material', 'count'],
        },
      },
      label_trees: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { key: str('木の key'), name: str('木の名前（例: 階・部屋・敷設）') }, required: ['key', 'name'] },
      },
      labels: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            key: str('節の key'),
            name: str('節の名前（部屋名などは書いてあるとおり）'),
            tree: str('木の key'),
            parent: str('親の節の key。木の直下なら空文字'),
            source: strs('根拠'),
          },
          required: ['key', 'name', 'tree', 'parent'],
        },
      },
      rules: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { label: str('節の key'), category: str('積算士が箱を置く段のカテゴリの key'), candidates: strs('候補の葉の key'), source: strs('根拠') },
          required: ['label', 'category', 'candidates'],
        },
      },
      expected: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { labels: strs('条件の節の key（部屋など）'), category: str('葉の key'), count: { type: 'NUMBER' }, source: strs('根拠') },
          required: ['labels', 'category', 'count'],
        },
      },
      systems: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { name: str('系統名（番号の欄のとおり）'), from: str('起点'), to: str('終点'), category: str('その行の配線の葉の key'), text: str('行に書いてあることのまま（配線・配管）'), source: strs('根拠') },
          required: ['name', 'category'],
        },
      },
      notes: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { kind: { type: 'STRING', enum: A.NOTE_KINDS.slice() }, text: str('覚え書き'), pages: { type: 'ARRAY', items: { type: 'INTEGER' } }, source: strs('根拠') },
          required: ['kind', 'text'],
        },
      },
    },
    required: ['pages', 'categories', 'components', 'label_trees', 'labels', 'rules', 'expected', 'systems', 'notes'],
    // 出力の順。応答が上限で切れても、短くて大事なもの（ページ・覚え書き・系統）が先に残るように。長いカテゴリは後ろ
    propertyOrdering: ['pages', 'notes', 'systems', 'label_trees', 'labels', 'categories', 'components', 'rules', 'expected'],
  };

  // いまのパレットを、機械に見せる短い文にする（同じものを同じ名前で書いてもらうため）
  A.paletteDigest = function (palDef, limit) {
    const pal = new SM.Palette(palDef);
    const lines = [];
    const walkC = (id, d) => {
      for (const c of pal.categoryChildren(id)) {
        lines.push('  '.repeat(d) + c.name + (c.size ? ' [' + c.size + ']' : ''));
        walkC(c.id, d + 1);
      }
    };
    const walkL = (id, d) => {
      for (const l of pal.labelChildren(id)) {
        lines.push('  '.repeat(d) + l.name);
        walkL(l.id, d + 1);
      }
    };
    const root = pal.categoryRoots()[0];
    if (root) walkC(root.id, 0);
    const cats = lines.splice(0);
    for (const r of pal.labelRoots()) {
      lines.push((r.root ? '# ' : '') + r.name);
      walkL(r.id, 1);
    }
    const labs = lines.splice(0);
    if (!cats.length && !labs.length) return '';
    const cut = (arr) => (arr.length > (limit || 300) ? arr.slice(0, limit || 300).concat(['…（ほか ' + (arr.length - (limit || 300)) + '）']) : arr);
    return ['## いまのパレット（人が作ったもの。同じものは同じ名前で書き、足りないものを足す）', '### カテゴリ', ...cut(cats), '### ラベル', ...cut(labs)].join('\n');
  };

  /*
   * 頼む中身の並び。返すもの: [{ text } | { pdf: true } | { crop: crops の番号, tile: タイルの番号 }]
   * 送り方の側が、pdf と crop に実物（PDF の切り出し・切り抜きの画像）を入れる。
   * state: いまの状態（ページの題・パレット）。plan: A.plan の結果
   */
  A.parts = function (state, plan, opts) {
    const o = opts || {};
    const out = [];
    const byIndex = new Map(state.pages.map((p) => [p.index, p]));
    const head = ['# 図面', '図面の名前: ' + ((state.doc && state.doc.name) || '（無題）') + (state.doc && state.doc.pages ? '（全 ' + state.doc.pages + ' ページ）' : '')];
    if (plan.pages.length) {
      head.push('送る PDF は ' + plan.pages.length + ' ページ。PDF の何枚目が、元の図面の何ページかは次のとおり。');
      plan.pages.forEach((n, i) => {
        const p = byIndex.get(n) || {};
        const human = p.title && p.title !== 'p.' + n && p.tagBy && p.tagBy.title === 'human' ? '（人が付けた題: ' + p.title + '）' : '';
        head.push('- ' + (i + 1) + ' 枚目 = p.' + n + human);
      });
    }
    out.push({ text: head.join('\n') });
    if (plan.pages.length) out.push({ pdf: true });
    if (plan.crops.length) {
      out.push({ text: '# 人が囲った範囲の切り抜き（' + plan.crops.length + ' 件。札・種類・覚え書き・元のページ）\n種類ごとの読み方:\n' + A.ANNOT_KINDS.filter((k) => plan.crops.some((c) => c.kind === k.id)).map((k) => '- ' + k.name + ': ' + k.ask).join('\n') });
      plan.crops.forEach((c, ci) => {
        const k = A.kind(c.kind);
        const bits = ['## 切り抜き ' + c.tag + '（' + k.name + '・p.' + c.page + (c.title ? '・題「' + c.title + '」' : '') + '）'];
        if (c.note) bits.push('人の覚え書き: ' + c.note);
        if (c.tiles.length > 1) bits.push('大きいので ' + c.tiles.length + ' 枚に分けた（左上から、重なりあり）。');
        out.push({ text: bits.join('\n') });
        c.tiles.forEach((t, ti) => out.push({ crop: ci, tile: ti }));
      });
    }
    const digest = o.palette === false ? '' : A.paletteDigest(state.palette, o.digestLimit);
    const ask = [A.PAGE_RULES];
    const focus = clean(o.focus !== undefined ? o.focus : state.analysis && state.analysis.focus);
    if (focus) ask.push('## 今回の積算の範囲と、人からの指示\n' + focus + '\n- 範囲の外の設備は、カテゴリ・ラベル・系統にしない（凡例や仕様書に載っていても）。ページの分類は、送ったページ全部について答える。');
    if (digest) ask.push(digest);
    ask.push('# 頼みごと\n以上を読み、決まりに従って JSON で答えてください。pages には送った PDF のページだけを入れてください。' + (o.extra ? '\n' + o.extra : ''));
    out.push({ text: ask.join('\n\n') });
    return out;
  };

  /* ======================================================================
   * 5. 応答をパレットとページに入れる
   * ====================================================================== */

  const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const norm = (s) => clean(s).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
  const srcOf = (x) => (Array.isArray(x) ? x.map(clean).filter(Boolean) : x ? [clean(x)] : []);

  // 応答の形を整える（欠けた並びを空に、型をそろえる）
  A.normalize = function (raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const arr = (x) => (Array.isArray(x) ? x.filter((e) => e && typeof e === 'object') : []);
    return {
      pages: arr(r.pages).filter((p) => Number.isInteger(Number(p.page))).map((p) => ({ page: Number(p.page), title: clean(p.title), sheet: clean(p.sheet), kinds: (p.kinds || []).filter((k) => A.PAGE_KINDS.includes(k)), work: clean(p.work), floor: clean(p.floor), scale: clean(p.scale), summary: clean(p.summary), pick: typeof p.pick === 'boolean' ? p.pick : null })),
      categories: arr(r.categories).filter((c) => clean(c.key) && clean(c.name)).map((c) => ({ key: clean(c.key), name: clean(c.name), parent: clean(c.parent), size: c.size === '長さ' ? '長さ' : c.size === '個数' ? '個数' : null, spec: clean(c.spec), source: srcOf(c.source) })),
      components: arr(r.components).filter((c) => clean(c.owner) && clean(c.material)).map((c) => ({ owner: clean(c.owner), material: clean(c.material), count: Number(c.count) > 0 ? Number(c.count) : 1, when: srcOf(c.when), add: !!c.add_slack })),
      label_trees: arr(r.label_trees).filter((t) => clean(t.key) && clean(t.name)).map((t) => ({ key: clean(t.key), name: clean(t.name) })),
      labels: arr(r.labels).filter((l) => clean(l.key) && clean(l.name)).map((l) => ({ key: clean(l.key), name: clean(l.name), tree: clean(l.tree), parent: clean(l.parent), source: srcOf(l.source) })),
      rules: arr(r.rules).filter((x) => clean(x.label) && clean(x.category)).map((x) => ({ label: clean(x.label), category: clean(x.category), candidates: srcOf(x.candidates), source: srcOf(x.source) })),
      expected: arr(r.expected).filter((e) => clean(e.category) && Number.isFinite(Number(e.count))).map((e) => ({ labels: srcOf(e.labels), category: clean(e.category), count: Number(e.count), source: srcOf(e.source) })),
      systems: arr(r.systems).filter((x) => clean(x.name) || clean(x.from) || clean(x.to)).map((x) => ({ name: clean(x.name), from: clean(x.from), to: clean(x.to), category: clean(x.category), text: clean(x.text), source: srcOf(x.source) })),
      notes: arr(r.notes).filter((n) => clean(n.text)).map((n) => ({ kind: A.NOTE_KINDS.includes(n.kind) ? n.kind : 'その他', text: clean(n.text), pages: Array.isArray(n.pages) ? n.pages.map(Number).filter(Number.isInteger) : [], source: srcOf(n.source) })),
    };
  };

  /*
   * 応答をストアに入れる（ストアの 1 回の編集の中で呼ぶ: store.commit('解析の結果', (st, S) => SMA.apply(S, res, opts))）。
   * 入れ方: パレットは足し合わせる（同じ親の下の同じ名前は、いまのものを使う）。ページの欄は、人が直した欄を替えない（opts.overwriteHuman で替える）。
   * 機械が足したものには by: 'llm' と src を付ける。
   * 返すもの: 数と知らせ { pages, categories: { added, reused }, labels: { added, reused }, components, rules, expected, notes, warnings }
   */
  A.apply = function (S, raw, opts) {
    const o = opts || {};
    const r = A.normalize(raw);
    const st = S.state;
    A.ensure(st);
    const sum = { pages: 0, categories: { added: 0, reused: 0 }, labels: { added: 0, reused: 0 }, components: 0, rules: 0, expected: 0, systems: 0, notes: 0, warnings: [] };
    const warn = (t) => {
      if (sum.warnings.length < 50) sum.warnings.push(t);
    };
    const run = o.run || null;

    /* ---- ページ ---- */
    const allowPages = o.pages ? new Set(o.pages) : null;
    for (const rp of r.pages) {
      if (allowPages && !allowPages.has(rp.page)) {
        warn('送っていない p.' + rp.page + ' の分類は入れなかった');
        continue;
      }
      const p = st.pages.find((x) => x.index === rp.page);
      if (!p) continue;
      const human = (k) => !o.overwriteHuman && p.tagBy && p.tagBy[k] === 'human';
      const patch = {};
      for (const k of ['title', 'sheet', 'kinds', 'work', 'floor', 'scale', 'summary']) {
        if (human(k)) continue;
        const v = rp[k];
        if (k === 'kinds' ? v.length : v) patch[k] = v;
      }
      // 題の頭の工事名（「電気設備工事 」など）は、一覧で読みにくいので外す
      if (patch.title) {
        const m = /^(\S{2,20}工事)[\s　]+(.{4,})$/.exec(patch.title);
        if (m) patch.title = m[2];
      }
      if (patch.title && rp.sheet) patch.title = patch.title + (patch.title.includes(rp.sheet) ? '' : '（' + rp.sheet + '）');
      S.setPageMeta(p.id, patch, 'llm');
      if (rp.pick !== null && !(p.pickBy === 'human' && !o.overwriteHuman)) {
        p.pick = rp.pick;
        p.pickBy = 'llm';
      }
      p.checked = false;
      sum.pages++;
    }

    /* ---- カテゴリ ---- */
    const pal = st.palette;
    const rootCat = pal.categories.find((c) => c.parent === null) || null;
    const catOf = new Map(); // key → id
    const byKey = new Map(r.categories.map((c) => [c.key, c]));
    const resolving = new Set();
    const resolveCat = (key) => {
      if (catOf.has(key)) return catOf.get(key);
      const c = byKey.get(key);
      if (!c) return null;
      if (resolving.has(key)) {
        warn('カテゴリの親が輪になっている: ' + c.name);
        return null;
      }
      resolving.add(key);
      let parent = c.parent ? resolveCat(c.parent) : null;
      if (c.parent && !parent) warn('カテゴリ「' + c.name + '」の親 ' + c.parent + ' が見つからないので、根の下に置いた');
      if (!parent) parent = rootCat ? rootCat.id : null;
      resolving.delete(key);
      const hit = st.palette.categories.find((x) => x.parent === parent && norm(x.name) === norm(c.name));
      let id;
      if (hit) {
        id = hit.id;
        if (!hit.note && c.spec) hit.note = c.spec;
        sum.categories.reused++;
      } else {
        const par = st.palette.categories.find((x) => x.id === parent);
        const size = c.size || (par && par.size) || '個数';
        id = S.addCategory(parent, c.name, { size, note: c.spec || undefined, by: 'llm', src: c.source, run: run || undefined });
        sum.categories.added++;
      }
      catOf.set(key, id);
      return id;
    };
    for (const c of r.categories) resolveCat(c.key);

    /* ---- ラベル ---- */
    const labOf = new Map();
    const treeOf = new Map();
    const findLabel = (parent, name) => st.palette.labels.find((l) => (l.parent || null) === (parent || null) && norm(l.name) === norm(name));
    for (const t of r.label_trees) {
      const hit = findLabel(null, t.name);
      if (hit) {
        treeOf.set(t.key, hit.id);
        sum.labels.reused++;
      } else {
        treeOf.set(t.key, S.addLabel(null, t.name, { root: true, by: 'llm', run: run || undefined }));
        sum.labels.added++;
      }
    }
    const lByKey = new Map(r.labels.map((l) => [l.key, l]));
    const lResolving = new Set();
    const resolveLab = (key) => {
      if (labOf.has(key)) return labOf.get(key);
      if (treeOf.has(key)) return treeOf.get(key);
      const l = lByKey.get(key);
      if (!l) return null;
      if (lResolving.has(key)) {
        warn('ラベルの親が輪になっている: ' + l.name);
        return null;
      }
      lResolving.add(key);
      let parent = l.parent ? resolveLab(l.parent) : null;
      if (!parent && l.tree) {
        if (!treeOf.has(l.tree)) {
          const hit = findLabel(null, l.tree);
          treeOf.set(l.tree, hit ? hit.id : S.addLabel(null, l.tree, { root: true, by: 'llm', run: run || undefined }));
          if (!hit) sum.labels.added++;
        }
        parent = treeOf.get(l.tree);
      }
      lResolving.delete(key);
      const hit = findLabel(parent, l.name);
      let id;
      if (hit) {
        id = hit.id;
        sum.labels.reused++;
      } else {
        id = S.addLabel(parent || null, l.name, { by: 'llm', src: l.source, run: run || undefined });
        sum.labels.added++;
      }
      labOf.set(key, id);
      return id;
    };
    for (const l of r.labels) resolveLab(l.key);
    const labelId = (key) => labOf.get(key) || treeOf.get(key) || null;

    /* ---- 構成 ---- */
    const comps = new Map();
    for (const c of r.components) {
      const owner = catOf.get(c.owner);
      const mat = catOf.get(c.material);
      if (!owner || !mat) {
        warn('構成の ' + (!owner ? '持ち主 ' + c.owner : '部材 ' + c.material) + ' が見つからない');
        continue;
      }
      const when = c.when.map(labelId).filter(Boolean);
      if (!comps.has(owner)) comps.set(owner, []);
      comps.get(owner).push({ material: mat, count: c.count, when, add: c.add });
    }
    for (const [owner, list] of comps) {
      const cat = st.palette.categories.find((x) => x.id === owner);
      if (cat && cat.components && cat.components.length && !o.overwriteComponents) {
        warn('「' + cat.name + '」はもう構成を持っているので、替えなかった');
        continue;
      }
      S.setComponents(owner, list);
      sum.components++;
    }

    /* ---- 規則 ---- */
    for (const x of r.rules) {
      const lab = labelId(x.label);
      const cat = catOf.get(x.category);
      const cands = x.candidates.map((k) => catOf.get(k)).filter(Boolean);
      if (!lab || !cat || !cands.length) {
        warn('規則（' + x.label + ' → ' + x.category + '）の相手が見つからない');
        continue;
      }
      const l = st.palette.labels.find((y) => y.id === lab);
      const rules = (l.rules || []).map((y) => ({ category: y.category, candidates: y.candidates.slice() }));
      const same = rules.find((y) => y.category === cat);
      if (same) {
        for (const c of cands) if (!same.candidates.includes(c)) same.candidates.push(c);
      } else rules.push({ category: cat, candidates: [...new Set(cands)] });
      S.setLabelRules(lab, rules);
      sum.rules++;
    }

    /* ---- 見込み ---- */
    for (const e of r.expected) {
      const labs = e.labels.map(labelId).filter(Boolean);
      const cat = catOf.get(e.category);
      if (!cat || labs.length !== e.labels.length) {
        warn('見込み（' + e.labels.join('・') + ' × ' + e.category + '）の相手が見つからない');
        continue;
      }
      S.setExpected(labs, cat, e.count, { by: 'llm', src: e.source });
      sum.expected++;
    }

    /* ---- 系統 ---- */
    for (const x of r.systems) {
      const cat = catOf.get(x.category) || null;
      if (x.category && !cat) warn('系統 ' + (x.name || x.from + '→' + x.to) + ' の配線 ' + x.category + ' が見つからない');
      S.setSystem({ name: x.name, from: x.from, to: x.to, category: cat, text: x.text, src: x.source, by: 'llm' });
      sum.systems++;
    }

    /* ---- 覚え書き ---- */
    const have = new Set(st.analysis.notes.map((n) => norm(n.text)));
    for (const n of r.notes) {
      if (have.has(norm(n.text))) continue;
      have.add(norm(n.text));
      S.addNote({ kind: n.kind, text: n.text, pages: n.pages, src: n.source, by: 'llm', run: run || undefined });
      sum.notes++;
    }
    S.touchPalette();
    return sum;
  };

  /*
   * 途中で切れた JSON を、切れる前の最後の「並びの中の、閉じたオブジェクト」までで閉じて読む。
   * 応答が出力の上限（MAX_TOKENS）に届いたとき（読めない字の繰り返しに入ったときなど）に、読めたところまでを入れるため。
   * 返すもの: { json, cut: 捨てた文字数 } か null
   */
  A.salvage = function (text) {
    const t = String(text || '');
    try {
      return { json: JSON.parse(t), cut: 0 };
    } catch (e) {
      /* 続ける */
    }
    const stack = [];
    let inStr = false;
    let esc = false;
    let best = null;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') {
        stack.pop();
        if (ch === '}' && stack[stack.length - 1] === '[') best = { at: i + 1, stack: stack.slice() };
      }
    }
    if (!best) return null;
    const close = best.stack.slice().reverse().map((c) => (c === '{' ? '}' : ']')).join('');
    try {
      return { json: JSON.parse(t.slice(0, best.at) + close), cut: t.length - best.at };
    } catch (e) {
      return null;
    }
  };

  // 応答の数（入れる前に見せる）
  A.counts = function (raw) {
    const r = A.normalize(raw);
    return { pages: r.pages.length, categories: r.categories.length, labels: r.labels.length + r.label_trees.length, rules: r.rules.length, components: r.components.length, expected: r.expected.length, systems: r.systems.length, notes: r.notes.length };
  };

  return A;
});
