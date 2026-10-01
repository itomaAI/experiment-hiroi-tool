/*
 * 手で書いた完全なパレット — 解説動画で参照されたページ。
 *
 * ページ: p.11 系統図（E-11）、p.13 1 階（E-13）、p.14 2 階（E-14）、p.15 3 階（E-15）、p.16 PH 階（E-16）、p.36 電灯 1 階（E-36）
 *
 * 出どころ（sekisan-proto の fixtures/sample_p36.js・sample_trunk.js と同じ）
 *   部屋・器具の記号・台数   p.36 の器具表（部屋ごとの箱 37 個）
 *   器具の種類の名前         完成した集計表「8_照明器具」
 *   配線表の行・構成         p.11 の配線表（1A1・1A2）と集計表「3_幹線」
 *   見本の位置・長さ         1A2 のルートは図面の緑の帯。長さは集計表の値（図面から測った値ではない）
 *
 * 図面から読んだ値を含むので、この置き場を外へ出すときは、このファイルの扱いを先に決める。
 */
(function (root, factory) {
  const X = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = X;
  else root.SMFixture = X;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const X = {};

  /* ---- ページ ---- */
  X.PAGES = [
    { id: 'pg-011', index: 11, title: '系統図（E-11）高圧引込・幹線', work: 'lb-work-trunk', floor: null },
    { id: 'pg-013', index: 13, title: '1 階 幹線（E-13）', work: 'lb-work-trunk', floor: 'lb-1F' },
    { id: 'pg-014', index: 14, title: '2 階 幹線（E-14）', work: 'lb-work-trunk', floor: 'lb-2F' },
    { id: 'pg-015', index: 15, title: '3 階 幹線（E-15）', work: 'lb-work-trunk', floor: 'lb-3F' },
    { id: 'pg-016', index: 16, title: 'PH 階 幹線（E-16）', work: 'lb-work-trunk', floor: 'lb-PH' },
    { id: 'pg-036', index: 36, title: '1 階 電灯（E-36）器具表つき', work: 'lb-work-light', floor: 'lb-1F' },
  ];

  /* ---- 器具表（p.36）: 部屋 → 記号 × 台数 ---- */
  X.ROOMS = [
    ['東門', [['L160', 1]]],
    ['駐車場', [['PL1', 4]]],
    ['外壁', [['J60', 10]]],
    ['C23・1号電気炉室', [['B322', 2]]],
    ['第2号電気炉室兼作業室', [['B322', 3]]],
    ['G17・排水処理機械室', [['F402', 5]]],
    ['G19・GC担体篩別室', [['A322', 4]]],
    ['G10・GC担体倉庫', [['F401', 5]]],
    ['GC粉砕篩別室', [['A322', 5]]],
    ['G21・GC粉砕篩別室', [['A322', 6]]],
    ['G7・乾燥室', [['B322', 2]]],
    ['G5・GC2号室', [['A322J', 6]]],
    ['G11・GC担体製造室', [['A322', 8]]],
    ['前室(G21・GC粉砕篩別室)', [['G150', 1]]],
    ['R13・第1分級室', [['A322', 4]]],
    ['C24・作業室2', [['A322J', 3]]],
    ['G6・GC1号製造室', [['A322', 11]]],
    ['G8・GC検査室', [['A322', 15]]],
    ['G12・キャピラリー製造室', [['A322', 8]]],
    ['廊下(2)-1', [['A321', 10]]],
    ['R14・第2分級室', [['A322', 4]]],
    ['男子・女子WC(SK含む)', [['G100', 9]]],
    ['男子・女子WC(個室)', [['H100', 4]]],
    ['B商談コーナー', [['GS100', 6]]],
    ['廊下(1)', [['G100', 4]]],
    ['EVホール', [['G100', 6]]],
    ['廊下(2)-2', [['A321', 10]]],
    ['B16・女子更衣室', [['A401', 2], ['H100', 1]]],
    ['B15・男子更衣室', [['A321J', 3]]],
    ['下駄箱', [['A402', 3]]],
    ['ポーチ', [['I100', 2]]],
    ['B玄関・風除室', [['GS100', 4]]],
    ['B1・IT室', [['A322', 2]]],
    ['消火ポンプ室', [['F401', 2]]],
    ['G2・屋内貯蔵庫', [['B322', 2]]],
    ['G3・ボンベ庫', [['F402', 2]]],
    ['L22・コンプレッサー室', [['F322J', 2]]],
  ];

  X.GROUPS = [
    ['cat-base-open', '下面開放型ベースライト', ['A321', 'A322', 'A321J', 'A322J', 'A401', 'A402']],
    ['cat-explosion', '耐圧防爆照明', ['B322']],
    ['cat-base-direct', '直付ベースライト', ['F322J', 'F401', 'F402']],
    ['cat-downlight', 'ダウンライト', ['G100', 'G150', 'H100', 'I100', 'GS100']],
    ['cat-bracket', '屋外ブラケット', ['J60']],
    ['cat-line', '枠付ライン照明', ['L160']],
    ['cat-pole', 'ポールライト', ['PL1']],
  ];

  const sym = (s) => 'cat-' + s;
  const roomId = (i) => 'lb-room-' + String(i + 1).padStart(2, '0');
  X.roomId = roomId;
  X.roomIdByName = function (name) {
    const i = X.ROOMS.findIndex((r) => r[0] === name);
    return i < 0 ? null : roomId(i);
  };

  /* ---- パレット（型） ---- */
  X.palette = function () {
    // カテゴリ: 部材を葉とする木。葉は構成を持てる
    const categories = [
      { id: 'cat-root', name: '拾えるもの（根）', parent: null, size: null },
      { id: 'cat-lighting', name: '照明器具', parent: 'cat-root', size: '個数' },
      { id: 'cat-wiring', name: '配線', parent: 'cat-root', size: '長さ' },
      { id: 'cat-trunk', name: '幹線', parent: 'cat-wiring', size: '長さ' },
      {
        id: 'cat-1A1',
        name: 'CVT 38 E8×2 (E63)',
        parent: 'cat-trunk',
        size: '長さ',
        components: [
          { material: 'cat-CVT38', count: 1, when: [], add: true },
          { material: 'cat-IV8', count: 2, when: [], add: true },
          { material: 'cat-E63', count: 1, when: ['lb-conduit-yes'], add: false },
        ],
      },
      {
        id: 'cat-1A2',
        name: 'CVT 100 E14×2 (G82)',
        parent: 'cat-trunk',
        size: '長さ',
        components: [
          { material: 'cat-CVT100', count: 1, when: [], add: true },
          { material: 'cat-IV14', count: 2, when: [], add: true },
          { material: 'cat-G82', count: 1, when: ['lb-conduit-yes'], add: false },
        ],
      },
      // 分岐回路（決定 18・案 B）: 束は線分（ルート）のラベルで決まり、束の葉が構成を持つ
      { id: 'cat-branch', name: '分岐の配線', parent: 'cat-wiring', size: '長さ' },
      {
        id: 'cat-bundle-101-1',
        name: '束 #101-1',
        parent: 'cat-branch',
        size: '長さ',
        components: [
          { material: 'cat-VVF20-2C', count: 2, when: [], add: false },
          { material: 'cat-VVF20-3C', count: 5, when: [], add: false },
        ],
      },
      { id: 'cat-parts', name: '部材（長さ）', parent: 'cat-root', size: '長さ' },
      { id: 'cat-VVF20-2C', name: 'VVF 2.0-2C', parent: 'cat-parts', size: '長さ' },
      { id: 'cat-VVF20-3C', name: 'VVF 2.0-3C', parent: 'cat-parts', size: '長さ' },
      { id: 'cat-CVT38', name: 'CVT 38', parent: 'cat-parts', size: '長さ' },
      { id: 'cat-CVT100', name: 'CVT 100', parent: 'cat-parts', size: '長さ' },
      { id: 'cat-IV8', name: 'IV 8', parent: 'cat-parts', size: '長さ' },
      { id: 'cat-IV14', name: 'IV 14', parent: 'cat-parts', size: '長さ' },
      { id: 'cat-E63', name: 'E 63', parent: 'cat-parts', size: '長さ' },
      { id: 'cat-G82', name: 'G 82', parent: 'cat-parts', size: '長さ' },
    ];
    for (const [gid, gname, symbols] of X.GROUPS) {
      categories.push({ id: gid, name: gname, parent: 'cat-lighting', size: '個数' });
      for (const s of symbols) categories.push({ id: sym(s), name: s, parent: gid, size: '個数' });
    }

    // ラベル: 節の森。根（root）は木の名前で、塗れない
    const labels = [
      { id: 'lb-work', name: '工事種目', root: true, hue: 210 },
      { id: 'lb-work-trunk', name: '幹線', parent: 'lb-work' },
      { id: 'lb-work-light', name: '電灯', parent: 'lb-work' },

      { id: 'lb-floor', name: '階', root: true, hue: 275 },
      { id: 'lb-PH', name: 'PH', parent: 'lb-floor' },
      { id: 'lb-3F', name: '3F', parent: 'lb-floor' },
      { id: 'lb-2F', name: '2F', parent: 'lb-floor' },
      { id: 'lb-1F', name: '1F', parent: 'lb-floor' },

      { id: 'lb-laying', name: '敷設', root: true, hue: 130 },
      { id: 'lb-laying-rack', name: 'ラック上', parent: 'lb-laying' },
      { id: 'lb-laying-ceiling', name: '天井内', parent: 'lb-laying' },
      { id: 'lb-laying-exposed', name: '露出', parent: 'lb-laying' },

      { id: 'lb-conduit', name: '電線管', root: true, hue: 25 },
      { id: 'lb-conduit-yes', name: 'あり', parent: 'lb-conduit' },
      { id: 'lb-conduit-no', name: 'なし', parent: 'lb-conduit' },

      { id: 'lb-section', name: '区間', root: true, hue: 180 },
      { id: 'lb-section-1', name: '1', parent: 'lb-section' },
      { id: 'lb-section-2', name: '2', parent: 'lb-section' },

      // 束（分岐回路の線分の組。決定 18・案 B）。節の規則で「分岐の配線」の葉が決まる
      { id: 'lb-bundle', name: '束', root: true, hue: 330 },
      { id: 'lb-bundle-101-1', name: '#101-1', parent: 'lb-bundle', rules: [{ category: 'cat-branch', candidates: ['cat-bundle-101-1'] }] },
    ];
    // 部屋は 1F の下。規則「この部屋では、照明器具は器具表の記号のどれか」を節に持つ
    X.ROOMS.forEach(([name, items], i) => {
      labels.push({ id: roomId(i), name, parent: 'lb-1F', rules: [{ category: 'cat-lighting', candidates: items.map((x) => sym(x[0])) }] });
    });

    const views = [
      { id: 'vw-lighting', name: '照明器具: 部材 × 階／部屋', under: 'cat-lighting', labels: [], rows: ['material'], cols: ['lb-floor'] },
      { id: 'vw-lighting-total', name: '照明器具: 部材ごとの計', under: 'cat-lighting', labels: [], rows: ['material'], cols: [] },
      { id: 'vw-trunk', name: '幹線: 系統 × 区間 × 平立 → 部材', under: 'cat-parts', labels: ['lb-work-trunk'], rows: ['name', 'lb-section', 'part'], cols: ['material'] },
      { id: 'vw-trunk-section', name: '幹線: 系統 × 区間 → 部材', under: 'cat-parts', labels: ['lb-work-trunk'], rows: ['name', 'lb-section'], cols: ['material'] },
      { id: 'vw-branch', name: '分岐回路: 回路 × 平立 → 部材', under: 'cat-parts', labels: ['lb-work-light'], rows: ['name', 'part'], cols: ['material'] },
      { id: 'vw-all', name: '全部: 部材 × 階', under: null, labels: [], rows: ['material'], cols: ['lb-floor'] },
    ];

    return { name: 'サンプル図面（解説動画のページ）', categories, labels, views };
  };

  // 器具表から出る、見込み（部屋 → 記号 → 台数）。照合に使う（後回しの項目だが、数だけ出す）
  X.expected = function () {
    const out = {};
    X.ROOMS.forEach(([name, items], i) => {
      out[roomId(i)] = {};
      for (const [s, n] of items) out[roomId(i)][sym(s)] = n;
    });
    return out;
  };

  /* ---- 初期状態: ページ全域の層（工事種目・階） ---- */
  // サンプル図面の PDF の指紋（pdf.js の fingerprints[0]）。この図面を開いたときだけ、ページの題と「見本を置く」を出す。
  // PDF そのものはリポジトリに入れていない（公開しない）
  X.SAMPLE_FINGERPRINTS = ['3233c78ee945cb5d1e9e9afea89d2d5f'];

  X.initialState = function (store, sizes) {
    store.state.palette = X.palette();
    store.touchPalette();
    const pages = X.PAGES.map((p) => {
      const sz = sizes[p.index - 1] || { width: 1190.55, height: 841.89 };
      return { id: p.id, index: p.index, title: p.title, width: sz.width, height: sz.height };
    });
    store.setPages(pages);
    X.pageWideAreas(store);
  };

  // ページ全域の層（工事種目・階）
  X.pageWideAreas = function (store) {
    for (const p of X.PAGES) {
      const pg = store.page(p.id);
      if (!pg) continue;
      const full = { type: 'rect', points: [[0, 0], [pg.width, pg.height]] };
      if (p.work) store.addArea(p.id, full, p.work);
      if (p.floor) store.addArea(p.id, full, p.floor);
    }
  };

  /* ---- 見本: 1A2 のルートと線、分岐回路 #101、玄関・風除室の GS100 ---- */
  /*
   * 骨（線分）を置き、その上に ラベルルート（木ごとに 1 枚）と 長さルート（線分 1 本を覆う）を被せ、線を通す。
   *   bones: [名前, 端 a, 端 b, 途中の角, { h, v（長さルート）, labels（ラベルルート） }]
   *   p.11 の k1・k2 は縦の図のつなぎ（長さ無し・ラベル無し）。線は通るが、覆うルートが無いので「長さ未入力」の旗が出る
   */
  X.ROUTE = [
    {
      page: 'pg-016',
      nodes: { cub: [445.9, 274.3], hato: [592.8, 318.0] },
      bones: [['a', 'cub', 'hato', [[445.9, 281.5], [592.8, 281.5]], { h: 16.5, labels: ['lb-laying-rack', 'lb-section-1'] }]],
      through: ['cub', 'hato'],
    },
    {
      page: 'pg-011',
      nodes: { v1: [534.6, 409.3], v2: [534.6, 445.3], v3: [236.5, 445.3], v4: [236.5, 595.8], v5: [261.7, 595.8], v6: [261.7, 610.2] },
      bones: [
        ['b', 'v1', 'v2', [], { v: 2.5, labels: ['lb-section-1'] }],
        ['k1', 'v2', 'v3', [], { labels: [] }],
        ['d', 'v3', 'v4', [], { v: 8.2, labels: ['lb-section-2', 'lb-conduit-yes'] }],
        ['k2', 'v4', 'v5', [], { labels: [] }],
        ['f', 'v5', 'v6', [], { v: 1.5, labels: ['lb-section-2', 'lb-conduit-yes'] }],
      ],
      through: ['v1', 'v6'],
    },
    {
      page: 'pg-015',
      nodes: { c1: [589.2, 324.0], c2: [356.4, 459.6] },
      bones: [['c', 'c1', 'c2', [[589.2, 279.1], [556.1, 279.1], [556.1, 505.2], [336.0, 505.2], [336.0, 459.6]], { h: 43.8, labels: ['lb-laying-ceiling', 'lb-section-2'] }]],
      through: ['c1', 'c2'],
    },
    {
      page: 'pg-013',
      nodes: { e1: [357.8, 460.8], e2: [356.4, 449.1] },
      bones: [['e', 'e1', 'e2', [[344.7, 460.8], [344.7, 449.1]], { h: 2.8, labels: ['lb-laying-ceiling', 'lb-section-2'] }]],
      through: ['e1', 'e2'],
    },
  ];
  X.ADDITIONS = { cub: 5, v6: 3 };

  /*
   * 分岐回路 #101（決定 18・案 B。`データと操作.md` 15.3）。p.36 の上に線分 1 本。
   * 束のラベルルートと長さルート（平 11.4・立 2.0）。線は「分岐の配線」で置き、束の規則で葉が決まる。
   * 位置は見本のための仮置き（図面の配線をなぞったものではない）
   */
  X.BRANCH = {
    page: 'pg-036',
    nodes: { p1: [470.0, 300.0], p2: [470.0, 360.0] },
    bones: [['g', 'p1', 'p2', [], { h: 11.4, v: 2.0, labels: ['lb-bundle-101-1'] }]],
    through: ['p1', 'p2'],
    name: '#101',
    category: 'cat-branch',
  };

  X.LIGHT = {
    page: 'pg-036',
    areas: {
      B商談コーナー: [[500, 183], [553, 268]],
      'B玄関・風除室': [[555, 216], [609, 268]],
      ポーチ: [[555, 183], [609, 215]],
    },
    // 記号の箱（中心。大きさは 10 pt）
    symbols: {
      B商談コーナー: [[512.4, 199.9], [540.0, 199.9], [512.4, 228.7], [540.0, 228.7], [512.4, 258.7], [540.0, 258.7]],
      'B玄関・風除室': [[568.3, 228.7], [594.7, 228.7], [568.3, 258.7], [594.7, 258.7]],
      ポーチ: [[568.3, 199.9], [594.7, 199.9]],
    },
  };

  // 完成した集計表の値: 「3_幹線」の 1A2（区間ごと）、「7-1_電灯」の #101、玄関まわりの台数
  X.EXPECTED_TRUNK = { '1': { 'CVT 100': 24.0, 'IV 14': 48.0 }, '2': { 'CVT 100': 59.3, 'IV 14': 118.6, 'G 82': 9.7 } };
  X.EXPECTED_BRANCH = { 'VVF 2.0-2C': 26.8, 'VVF 2.0-3C': 67.0 };
  X.EXPECTED_LIGHT = { B商談コーナー: { GS100: 6 }, 'B玄関・風除室': { GS100: 4 }, ポーチ: { I100: 2 } };

  // 骨とルートを置いて、線を通す。返すもの: 線の拾いの id
  function placeRoute(store, palette, part, category, name) {
    const ids = {};
    for (const key of Object.keys(part.nodes)) {
      const n = part.nodes[key];
      ids[key] = store.addNode(part.page, n[0], n[1]);
    }
    const segIds = {};
    for (const b of part.bones) {
      const o = b[4] || {};
      const sid = store.addSegment(part.page, ids[b[1]], ids[b[2]], b[3]);
      segIds[b[0]] = sid;
      for (const l of o.labels || []) store.addRoute(part.page, [sid], { label: l }, palette);
      if (o.h !== undefined || o.v !== undefined) store.addRoute(part.page, [sid], { length_h: o.h === undefined ? null : o.h, length_v: o.v === undefined ? null : o.v }, palette);
    }
    const path = part.bones.map((b) => segIds[b[0]]);
    const pk = store.addLine(part.page, category, part.through.map((k) => ids[k]), path, name);
    return { pk, ids };
  }

  X.placeSample = function (store, paletteArg) {
    const palette = paletteArg || store.palette;
    // 1A2: ページごとに別の線の拾い。名前で束ねる
    for (const part of X.ROUTE) {
      const { pk, ids } = placeRoute(store, palette, part, 'cat-1A2', '1A2');
      for (const key of Object.keys(X.ADDITIONS)) if (part.nodes[key]) store.setAddition(pk, ids[key], X.ADDITIONS[key]);
    }
    // 分岐回路 #101
    placeRoute(store, palette, X.BRANCH, X.BRANCH.category, X.BRANCH.name);
    // 玄関まわりの 3 部屋: エリアと箱
    const L = X.LIGHT;
    for (const room of Object.keys(L.areas)) {
      const [a, b] = L.areas[room];
      store.addArea(L.page, { type: 'rect', points: [a, b] }, X.roomIdByName(room));
      for (const c of L.symbols[room]) store.addBox(L.page, 'cat-downlight', [c[0] - 5, c[1] - 5, 10, 10]);
    }
  };
  return X;
});