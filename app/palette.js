/*
 * 拾いツール — パレットの画面（タブ「パレット」）。
 *
 * パレット = 型の集合。ここで編集するのは 2 つ:
 *   部材カテゴリ  拾いの型。部材を葉とする木（数え方 = 個数／長さ。葉は構成を持てる）
 *   層のラベル    層（エリア・ルート）の型。節の森。節が規則（この中では カテゴリ は 候補 のどれか）を持つ
 * どちらも木なので、真ん中はアウトライナー（名前をその場で書き、Enter で兄弟・Tab で子・Shift+Tab で戻す）。
 * 右は、選んだ 1 つの詳細（カテゴリなら 数え方・構成・使われている所、ラベルなら 規則・使っている層）。
 * 「規則の一覧」は、規則を 節 × カテゴリ の表で見渡す。
 *
 * 画面（app.js）とは ctx だけでつながる。編集はすべて ctx.edit（ストアの 1 回の編集＝履歴の 1 行）を通す。
 */
(function () {
  'use strict';

  self.SMPaletteScreen = function (ctx) {
    const { el, store, P, h, edit, toast, openModal, confirmBox, catColor } = ctx;

    const st = {
      kind: 'category', // 'category' | 'label' | 'rules'
      sel: { category: 'cat-root', label: null },
      collapsed: { category: new Set(), label: new Set() },
      query: { category: '', label: '', rules: '' },
      focus: null, // { kind, id, select }
      draftRule: null, // { label, category } 候補をまだ選んでいない規則
      rendering: false,
    };
    const KIND = {
      category: { title: '部材カテゴリ', unit: '件', hint: '拾うものの木。粗い分類から、集計表に出る部材（葉）まで。箱は「個数」、線は「長さ」の葉だけを候補にします。' },
      label: { title: '層のラベル', unit: '件', hint: 'エリア・ルートに付ける意味の木。節に「この中では、カテゴリ は 候補 のどれか」という規則を付けると、重なった拾いの部材が絞られます。木の中の節どうしは排他です。' },
      systems: { title: '系統（配線表）', unit: '件', hint: '配線表の行（1A2 など）。線を引くときの名前の候補になり、引いた線の数で消し込みます。図面解析が配線表から読んだものも、ここで直せます。' },
      expected: { title: '見込み（表の個数）', unit: '件', hint: '器具表などに書いてある個数（部屋 × 器具 × 台数）。集計タブの「照合」で、置いた数と比べます。' },
      rules: { title: '規則の一覧', unit: '本', hint: '規則を「節 × カテゴリ」の表で見渡します。セルを押すと、その節の規則を直せます。' },
    };

    /* ---------------- 木の取り扱い（カテゴリとラベルで違うところだけ） ---------------- */
    const T = {
      category: {
        tops: (pal) => pal.categoryRoots().map((c) => c.id),
        kids: (pal, id) => pal.categoryChildren(id).map((c) => c.id),
        get: (pal, id) => pal.category(id),
        parentOf: (pal, id) => (pal.category(id) || {}).parent || null,
        isFixed: (pal, id) => (pal.category(id) || {}).parent === null, // 根
        add: (S, parent, before) => S.addCategory(parent, '新しいカテゴリ', { before }),
        rename: (S, id, name) => S.updateCategory(id, { name }),
        move: (S, id, parent, before) => S.moveCategory(id, parent, before),
        newName: '新しいカテゴリ',
      },
      label: {
        tops: (pal) => pal.labelRoots().map((l) => l.id),
        kids: (pal, id) => pal.labelChildren(id).map((l) => l.id),
        get: (pal, id) => pal.label(id),
        parentOf: (pal, id) => (pal.label(id) || {}).parent || null,
        isFixed: () => false,
        add: (S, parent, before) => {
          const id = S.addLabel(parent, '新しい節');
          S.moveLabel(id, parent, before);
          return id;
        },
        rename: (S, id, name) => S.updateLabel(id, { name }),
        move: (S, id, parent, before) => S.moveLabel(id, parent, before),
        newName: '新しい節',
      },
    };

    // 兄弟の並び（森の一番上も含む）
    const siblings = (kind, pal, id) => {
      const par = T[kind].parentOf(pal, id);
      return par === null ? T[kind].tops(pal) : T[kind].kids(pal, par);
    };

    /* ---------------- 使われ方 ---------------- */
    function usage() {
      const pal = P();
      const s = store.state;
      // カテゴリ → 拾いの数（置いたカテゴリ・決まった葉、と、その祖先）
      const cat = new Map();
      const bump = (id, pk) => {
        for (const x of [id].concat(pal.categoryAncestors(id))) {
          if (!cat.has(x)) cat.set(x, new Set());
          cat.get(x).add(pk);
        }
      };
      for (const p of s.pickups) if (pal.category(p.category)) bump(p.category, p.id);
      for (const o of ctx.objects()) if (o.leaf && pal.category(o.leaf)) bump(o.leaf, o.pickup);
      // ラベル → 層の数
      const lab = new Map();
      for (const a of s.areas) lab.set(a.label, (lab.get(a.label) || 0) + 1);
      for (const r of s.routes) if (r.label) lab.set(r.label, (lab.get(r.label) || 0) + 1);
      // カテゴリ → それを候補に持つ規則の節
      const ruled = new Map();
      for (const l of pal.labels) for (const r of l.rules || []) for (const c of r.candidates.concat([r.category])) {
        if (!ruled.has(c)) ruled.set(c, new Set());
        ruled.get(c).add(l.id);
      }
      return { cat, lab, ruled };
    }

    /* ---------------- 描く ---------------- */
    function render() {
      st.rendering = true;
      const pal = P();
      if (st.sel.category && !pal.category(st.sel.category)) st.sel.category = 'cat-root';
      if (st.sel.label && !pal.label(st.sel.label)) st.sel.label = null;
      const u = usage();
      el.innerHTML = '';
      el.append(nav(pal), center(pal, u), right(pal, u));
      st.rendering = false;
      if (st.focus) {
        const f = st.focus;
        st.focus = null;
        const input = el.querySelector('.orow[data-id="' + CSS.escape(f.id) + '"] input.oname');
        if (input) {
          input.focus();
          if (f.select) input.select();
          else input.setSelectionRange(input.value.length, input.value.length);
          input.closest('.orow').scrollIntoView({ block: 'nearest' });
        }
      }
    }

    function nav(pal) {
      const nRules = pal.labels.reduce((s, l) => s + (l.rules || []).length, 0);
      const sp = store.state.palette;
      const counts = { category: pal.categories.length - 1, label: pal.labels.length, rules: nRules, systems: (sp.systems || []).length, expected: (sp.expected || []).length };
      const box = h('div', { class: 'pnav' }, h('div', { class: 'pttl' }, 'パレット'), h('div', { class: 'pname' }, pal.name || h('span', { class: 'dim' }, '（名前なし）')));
      for (const k of ['category', 'label', 'rules', 'systems', 'expected']) {
        box.append(h('button', { class: 'pk' + (st.kind === k ? ' on' : ''), onclick: () => { st.kind = k; render(); } }, h('span', {}, KIND[k].title), h('span', { class: 'pc' }, counts[k])));
      }
      box.append(
        h('div', { class: 'phint' }, KIND[st.kind].hint),
        h('div', { class: 'pfile' },
          h('button', { onclick: ctx.savePalette }, 'パレットを書き出す'),
          h('button', { onclick: ctx.loadPalette }, 'パレットを読み込む'),
          h('button', { onclick: ctx.loadSamplePalette }, 'サンプルのパレット'),
          h('button', { class: 'ghost', onclick: renamePalette }, 'パレットの名前…'),
        ),
      );
      return box;
    }
    async function renamePalette() {
      const input = h('input', { type: 'text', value: P().name || '', style: 'width:100%', placeholder: '例: ○○ビル 電気設備' });
      const m = openModal({ title: 'パレットの名前', width: 420, dismiss: true, body: input, onKey: (e, hd) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); hd.close(input.value); } }, actions: ['spacer', { label: 'やめる', id: 'cancel' }, { label: '決める', primary: true, on: (hd) => hd.close(input.value) }] });
      setTimeout(() => input.focus(), 30);
      const v = await m.result;
      if (v === undefined) return;
      edit('パレットの名前', (S) => { S.state.palette.name = v.trim(); S.touchPalette(); });
    }

    /* ---------------- 真ん中: アウトライナー ---------------- */
    function center(pal, u) {
      if (st.kind === 'rules') return ruleMatrix(pal);
      if (st.kind === 'systems') return systemsTable(pal);
      if (st.kind === 'expected') return expectedTable(pal);
      const kind = st.kind;
      const q = st.query[kind].trim();
      const search = h('input', { class: 'search', type: 'search', placeholder: '名前で探す', value: st.query[kind] });
      search.addEventListener('input', () => { st.query[kind] = search.value; render(); const s2 = el.querySelector('.pcenter .search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } });
      const selId = st.sel[kind];
      const head = h('div', { class: 'phead' },
        h('div', { class: 'ptitle' }, KIND[kind].title),
        search,
        h('span', { class: 'spacer' }),
        h('button', { title: '選んでいるものの下に足す', onclick: () => addChild() }, '＋ 子'),
        h('button', { title: '選んでいるものの後ろに足す（Enter）', disabled: kind === 'category' && (!selId || T.category.isFixed(pal, selId)) ? '' : null, onclick: () => addSibling() }, '＋ 兄弟'),
        kind === 'label' ? h('button', { title: '森の一番上に、新しい木（見出し）を足す', onclick: () => addTop() }, '＋ 木') : null,
        h('button', { title: '字下げした文字で、まとめて足す', onclick: () => pasteModal() }, 'まとめて貼り付け…'),
        h('button', { class: 'ghost', title: '全部開く／畳む', onclick: () => { const set = st.collapsed[kind]; if (set.size) set.clear(); else for (const x of (kind === 'category' ? pal.categories : pal.labels)) if (T[kind].kids(pal, x.id).length && !T[kind].isFixed(pal, x.id)) set.add(x.id); render(); } }, st.collapsed[kind].size ? '全部開く' : '全部畳む'),
      );
      const list = h('div', { class: 'olist', role: 'tree' });
      const visible = (id) => !q || matchDeep(kind, pal, id, q);
      const walk = (ids, depth) => {
        for (const id of ids) {
          if (!visible(id)) continue;
          list.append(row(kind, pal, u, id, depth));
          const kids = T[kind].kids(pal, id);
          if (kids.length && (q || !st.collapsed[kind].has(id))) walk(kids, depth + 1);
        }
      };
      walk(T[kind].tops(pal), 0);
      if (!list.children.length) list.append(h('div', { class: 'empty', style: 'margin:10px' }, kind === 'label' ? 'まだラベルがありません。「＋ 木」で木（部屋・階・敷設 など）を足すか、「まとめて貼り付け」で一度に足してください。' : '見つかりません'));
      const keys = h('div', { class: 'okeys' }, 'Enter 兄弟を足す ・ Tab 子にする ・ Shift+Tab 戻す ・ Alt+↑↓ 並べ替え ・ ↑↓ 移る ・ 空の名前で Backspace 消す ・ Ctrl+Z 元に戻す（名前の欄の外で）');
      return h('div', { class: 'pcenter' }, head, list, keys);
    }
    function matchDeep(kind, pal, id, q) {
      const x = T[kind].get(pal, id);
      if (x && x.name.includes(q)) return true;
      return T[kind].kids(pal, id).some((k) => matchDeep(kind, pal, k, q));
    }

    function row(kind, pal, u, id, depth) {
      const x = T[kind].get(pal, id);
      const kids = T[kind].kids(pal, id);
      const fixed = T[kind].isFixed(pal, id);
      const on = st.sel[kind] === id;
      const input = h('input', { class: 'oname', type: 'text', value: x.name, spellcheck: 'false', 'data-id': id });
      input.addEventListener('focus', () => { if (st.sel[kind] !== id) { st.sel[kind] = id; markSelected(kind, id); renderRightOnly(); } });
      input.addEventListener('blur', (e) => { if (st.rendering) return; commitName(kind, id, input, e.relatedTarget); });
      input.addEventListener('keydown', (e) => onRowKey(e, kind, id, input));
      const badges = h('span', { class: 'obadges' });
      if (kind === 'category') {
        if (!fixed) badges.append(h('span', { class: 'ob size ' + (x.size === '長さ' ? 'len' : 'cnt'), title: '数え方（右の詳細で替える）' }, x.size || '—'));
        if (x.components && x.components.length) badges.append(h('span', { class: 'ob', title: '構成（部材の集まり）' }, '構成 ' + x.components.length));
        const n = (u.cat.get(id) || new Set()).size;
        if (n) badges.append(h('span', { class: 'ob use', title: 'この下で拾ったもの' }, '拾い ' + n));
        const r = (u.ruled.get(id) || new Set()).size;
        if (r && !kids.length) badges.append(h('span', { class: 'ob rule', title: 'これを候補に持つ規則の節' }, '規則 ' + r));
        if (fixed) badges.append(h('span', { class: 'ob dim' }, '根 ＝ 純粋な拾い'));
      } else {
        if (x.root) badges.append(h('span', { class: 'ob dim', title: '見出し（この名前そのものは塗れない）' }, '見出し'));
        const nr = (x.rules || []).length;
        if (nr) badges.append(h('span', { class: 'ob rule' }, '規則 ' + nr));
        const nl = u.lab.get(id) || 0;
        if (nl) badges.append(h('span', { class: 'ob use' }, '層 ' + nl));
      }
      const dot = kind === 'category'
        ? h('span', { class: 'odot', style: kids.length || fixed ? 'background:transparent;border-color:transparent' : 'background:' + catColor(id) })
        : h('span', { class: 'odot', style: 'background:' + (x.color || '#94a3b8') });
      const tg = h('span', { class: 'otg', onclick: (e) => { e.stopPropagation(); const set = st.collapsed[kind]; if (set.has(id)) set.delete(id); else set.add(id); render(); } }, kids.length && !fixed ? (st.collapsed[kind].has(id) ? '▸' : '▾') : '');
      return h('div', { class: 'orow' + (on ? ' on' : '') + (fixed ? ' fixed' : '') + (kind === 'label' && x.root ? ' head' : ''), 'data-id': id, style: '--d:' + depth, onpointerdown: (e) => { if (e.target === input) return; st.sel[kind] = id; st.focus = { kind, id }; render(); } }, tg, dot, input, badges);
    }
    function markSelected(kind, id) {
      for (const r of el.querySelectorAll('.orow')) r.classList.toggle('on', r.dataset.id === id);
    }
    function renderRightOnly() {
      const old = el.querySelector('.pright');
      if (!old) return;
      old.replaceWith(right(P(), usage()));
    }

    function commitName(kind, id, input, next) {
      const x = T[kind].get(P(), id);
      if (!x) return;
      const v = input.value.trim();
      if (!v) {
        input.value = x.name;
        return;
      }
      if (v === x.name) return;
      if (next && next.dataset && next.dataset.id) st.focus = { kind, id: next.dataset.id };
      edit('名前を直す', (S) => T[kind].rename(S, id, v));
    }

    function focusRow(id, select) {
      st.focus = { kind: st.kind, id, select: !!select };
      render();
    }
    function onRowKey(e, kind, id, input) {
      if (e.isComposing || e.keyCode === 229) return; // 日本語の変換中は触らない
      const pal = P();
      const sib = siblings(kind, pal, id);
      const i = sib.indexOf(id);
      const par = T[kind].parentOf(pal, id);
      const flush = () => {
        const x = T[kind].get(P(), id);
        const v = input.value.trim();
        if (v && x && v !== x.name) edit('名前を直す', (S) => T[kind].rename(S, id, v));
      };
      if (e.key === 'Enter') {
        e.preventDefault();
        flush();
        if (T[kind].isFixed(pal, id)) return addChild(id);
        const nid = edit('足す', (S) => T[kind].add(S, par, sib[i + 1] || null));
        if (nid) { st.sel[kind] = nid; focusRow(nid, true); }
      } else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        flush();
        if (i <= 0 || T[kind].isFixed(pal, id)) return;
        const np = sib[i - 1];
        st.collapsed[kind].delete(np);
        const ok = edit('子にする', (S) => { T[kind].move(S, id, np, null); return true; });
        if (ok) focusRow(id);
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        flush();
        if (par === null) return;
        const gp = T[kind].parentOf(pal, par);
        if (kind === 'category' && gp === null) return toast('根の外へは出せません', 2000);
        const psib = siblings(kind, pal, par);
        const ok = edit('戻す', (S) => { T[kind].move(S, id, gp, psib[psib.indexOf(par) + 1] || null); return true; });
        if (ok) focusRow(id);
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        flush();
        if (T[kind].isFixed(pal, id)) return;
        let before;
        if (e.key === 'ArrowUp') { if (i <= 0) return; before = sib[i - 1]; } else { if (i >= sib.length - 1) return; before = sib[i + 2] || null; }
        const ok = edit('並べ替え', (S) => { T[kind].move(S, id, par, before); return true; });
        if (ok) focusRow(id);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const rows = [...el.querySelectorAll('.orow')];
        const k = rows.findIndex((r) => r.dataset.id === id);
        const to = rows[k + (e.key === 'ArrowUp' ? -1 : 1)];
        if (to) to.querySelector('input.oname').focus();
      } else if (e.key === 'Backspace' && input.value === '' ) {
        e.preventDefault();
        removeNode(kind, id, true);
      } else if (e.key === 'Escape') {
        const x = T[kind].get(pal, id);
        input.value = x ? x.name : '';
        input.blur();
      }
    }

    function addChild(parentId) {
      const kind = st.kind;
      const pal = P();
      let par = parentId || st.sel[kind];
      if (kind === 'category' && !par) par = 'cat-root';
      if (par) st.collapsed[kind].delete(par);
      const nid = edit('足す', (S) => T[kind].add(S, par || null, null));
      if (nid) { st.sel[kind] = nid; focusRow(nid, true); }
      return pal;
    }
    function addSibling() {
      const kind = st.kind;
      const pal = P();
      const id = st.sel[kind];
      if (!id) return addTop();
      const sib = siblings(kind, pal, id);
      const nid = edit('足す', (S) => T[kind].add(S, T[kind].parentOf(pal, id), sib[sib.indexOf(id) + 1] || null));
      if (nid) { st.sel[kind] = nid; focusRow(nid, true); }
    }
    function addTop() {
      const nid = edit('木を足す', (S) => S.addLabel(null, '新しい木', { root: true, hue: Math.floor(Math.random() * 360) }));
      if (nid) { st.sel.label = nid; focusRow(nid, true); }
    }

    async function removeNode(kind, id, fromKey) {
      const pal = P();
      if (kind === 'category') {
        if (T.category.isFixed(pal, id)) return toast('根は消せません', 2000);
        const u = store.categoryUsage(id);
        if (u.pickups.length) return toast('このカテゴリ（とその下）で ' + u.pickups.length + ' 件拾っています。拾いのカテゴリを替えるか、拾いを消してから', 4000);
        const n = u.ids.length;
        const extra = [];
        if (n > 1) extra.push('下の ' + (n - 1) + ' 件も消えます');
        if (u.rules.length) extra.push('規則 ' + u.rules.length + ' 節の候補から外れます');
        if (u.components.length) extra.push('構成 ' + u.components.length + ' 件から外れます');
        if (extra.length && !(await confirmBox('「' + pal.category(id).name + '」を消す', extra.join('。') + '。元に戻すで戻せます。', '消す'))) return;
        const prev = prevRow(id);
        edit('カテゴリを消す', (S) => S.removeCategoryTree(id));
        st.sel.category = prev || 'cat-root';
        if (fromKey && prev) focusRow(prev);
      } else {
        const ids = [id].concat(pal.labelDescendants(id));
        const used = ids.reduce((s, x) => s + store.state.areas.filter((a) => a.label === x).length + store.state.routes.filter((r) => r.label === x).length, 0);
        if (used) return toast('この節（とその下）は ' + used + ' 枚の層に使われています。層を消すか、別の節に付け替えてから', 4000);
        if (ids.length > 1 && !(await confirmBox('「' + pal.label(id).name + '」を消す', '下の ' + (ids.length - 1) + ' 件も消えます。元に戻すで戻せます。', '消す'))) return;
        const prev = prevRow(id);
        edit('ラベルを消す', (S) => S.removeLabelTree(id));
        st.sel.label = prev;
        if (fromKey && prev) focusRow(prev);
      }
    }
    function prevRow(id) {
      const rows = [...el.querySelectorAll('.orow')];
      const k = rows.findIndex((r) => r.dataset.id === id);
      return k > 0 ? rows[k - 1].dataset.id : null;
    }

    /* ---------------- 右: 詳細 ---------------- */
    function right(pal, u) {
      const box = h('div', { class: 'pright' });
      if (st.kind === 'systems' || st.kind === 'expected') {
        box.append(h('div', { class: 'muted', style: 'padding:12px' }, KIND[st.kind].hint, ' 「AI」の印は図面解析が書いたもので、直すと消えます。'));
        return box;
      }
      if (st.kind === 'category') box.append(detailCategory(pal, u, st.sel.category));
      else box.append(detailLabel(pal, u, st.sel.label));
      return box;
    }
    const sec = (title, ...kids) => h('div', { class: 'psec' }, h('div', { class: 'pst' }, title), ...kids);

    function detailCategory(pal, u, id) {
      const c = pal.category(id);
      if (!c) return h('div', { class: 'empty' }, '左の木で、カテゴリを選んでください');
      const fixed = c.parent === null;
      const leaf = pal.isLeaf(id);
      const out = h('div', {});
      out.append(h('div', { class: 'ppath' }, pal.categoryPath(id).join(' › ')));
      const name = h('input', { type: 'text', value: c.name, class: 'pin' });
      name.addEventListener('change', () => { const v = name.value.trim(); if (v && v !== c.name) edit('名前を直す', (S) => S.updateCategory(id, { name: v })); });
      out.append(h('div', { class: 'pkv' }, h('span', { class: 'k' }, '名前'), name));
      if (!fixed) {
        const note = h('input', { type: 'text', value: c.note || '', class: 'pin', placeholder: '仕様・品番・メモ' });
        note.addEventListener('change', () => { if (note.value.trim() !== (c.note || '')) edit('メモを直す', (S) => S.updateCategory(id, { note: note.value.trim() })); });
        out.append(h('div', { class: 'pkv' }, h('span', { class: 'k' }, 'メモ'), note));
        if (c.by === 'llm' || (c.src && c.src.length)) out.append(h('div', { class: 'muted', style: 'margin:-2px 0 8px 86px' }, h('span', { class: 'ai' }, 'AI'), ' 図面解析が作った' + (c.src && c.src.length ? '（根拠: ' + c.src.join('・') + '）' : '')));
      }
      if (fixed) {
        out.append(h('p', { class: 'muted' }, '根です。根で置いた拾いは「純粋な拾い」（何を拾ったかを決めずに置いた印）になります。部材カテゴリは、この下に作ってください。'));
      } else {
        const size = h('span', { class: 'seg' });
        for (const v of ['個数', '長さ']) size.append(h('button', { class: c.size === v ? 'on' : '', onclick: () => edit('数え方', (S) => S.updateCategory(id, { size: v })) }, v));
        const deep = !leaf ? h('button', { class: 'ghost', title: '下のものも全部この数え方にする', onclick: () => edit('数え方を下まで揃える', (S) => S.setCategorySizeDeep(id, c.size)) }, '下まで揃える') : null;
        out.append(h('div', { class: 'pkv' }, h('span', { class: 'k' }, '数え方'), h('span', {}, size, deep)), h('div', { class: 'muted', style: 'margin:-2px 0 8px 86px' }, c.size === '長さ' ? '線（長さもの）で拾う。数量 =（長さ ＋ 余長）× 本数' : '箱（個数もの）で拾う。数量 = 1 個'));
      }
      // 構成
      if (!fixed) out.append(sectionComponents(pal, c, leaf));
      // 使われている所
      const pk = u.cat.get(id) ? u.cat.get(id).size : 0;
      const rules = [...(u.ruled.get(id) || [])];
      const usedIn = pal.categories.filter((x) => (x.components || []).some((m) => m.material === id));
      const use = h('div', {});
      use.append(h('div', { class: 'pline' }, '拾い ', h('b', {}, pk), ' 件', h('span', { class: 'spacer' }), h('button', { onclick: () => ctx.usePickup(id) }, 'このカテゴリで拾う →')));
      if (rules.length) {
        use.append(h('div', { class: 'subt' }, 'これに触れる規則（節）'));
        const chips = h('div', { class: 'chips2' });
        for (const lid of rules) chips.append(h('button', { class: 'lch', style: '--c:' + (pal.label(lid).color || '#999'), onclick: () => { st.kind = 'label'; st.sel.label = lid; render(); } }, pal.labelPath(lid).join(' / ')));
        use.append(chips);
      }
      if (usedIn.length) {
        use.append(h('div', { class: 'subt' }, '部材として使っている構成'));
        const chips = h('div', { class: 'chips2' });
        for (const x of usedIn) chips.append(h('button', { class: 'lch', onclick: () => { st.sel.category = x.id; render(); } }, x.name));
        use.append(chips);
      }
      out.append(sec('使われている所', use));
      if (!fixed) out.append(h('div', { class: 'pacts' }, h('button', { onclick: () => addChild(id) }, '＋ 子を足す'), h('span', { class: 'spacer' }), h('button', { class: 'danger', onclick: () => removeNode('category', id) }, leaf ? '消す' : '下ごと消す')));
      return out;
    }

    function sectionComponents(pal, c, leaf) {
      const comps = (c.components || []).map((x) => Object.assign({}, x, { when: (x.when || []).slice() }));
      const save = (label) => edit(label || '構成', (S) => S.setComponents(c.id, comps));
      const box = h('div', {});
      if (!leaf) {
        box.append(h('div', { class: 'muted' }, '構成は葉（いちばん下）に付けます。'));
        return sec('構成', box);
      }
      box.append(h('div', { class: 'muted' }, comps.length ? 'この葉を拾うと、下の部材に展開されます（集計表には部材が出ます）。' : '構成がありません。この葉そのものが部材 1 つとして集計されます。配線表の行（例: CVT 100 E14×2）のように、拾う単位が部材の組なら足してください。'));
      if (comps.length) {
        const tbl = h('table', { class: 'ptbl' }, h('tr', {}, h('th', {}, '部材'), h('th', {}, '本数'), h('th', { title: '線の端の余長を、この部材に足すか' }, '余長'), h('th', {}, '条件（ラベル）'), h('th')));
        comps.forEach((m, i) => {
          const mat = materialSelect(pal, c.id, m.material, (v) => { m.material = v; save(); });
          const cnt = h('input', { type: 'number', min: '0', step: '1', value: m.count, style: 'width:56px' });
          cnt.addEventListener('change', () => { m.count = Number(cnt.value) || 1; save(); });
          const add = h('input', { type: 'checkbox', checked: m.add ? '' : null });
          add.addEventListener('change', () => { m.add = add.checked; save(); });
          const when = h('span', { class: 'chips2' });
          for (const w of m.when) when.append(h('span', { class: 'lch sm', style: '--c:' + ((pal.label(w) || {}).color || '#999') }, (pal.label(w) ? pal.labelPath(w).join('/') : w), h('button', { class: 'ghost icon', onclick: () => { m.when = m.when.filter((x) => x !== w); save(); } }, '×')));
          const addWhen = labelSelect(pal, '＋', (v) => { if (v && !m.when.includes(v)) { m.when.push(v); save(); } });
          when.append(addWhen);
          tbl.append(h('tr', {}, h('td', {}, mat), h('td', {}, cnt), h('td', { style: 'text-align:center' }, add), h('td', {}, when), h('td', {}, h('button', { class: 'ghost icon', title: '外す', onclick: () => { comps.splice(i, 1); save('構成から外す'); } }, '×'))));
        });
        box.append(tbl, h('div', { class: 'muted' }, '条件: そのラベルの層が重なっているときだけ出る部材（例: 電線管は「電線管 あり」のルートの上だけ）。'));
      }
      box.append(h('div', { class: 'pacts' }, materialSelect(pal, c.id, null, (v) => { if (v) { comps.push({ material: v, count: 1, when: [], add: c.size === '長さ' }); save('構成に足す'); } }, '＋ 部材を足す')));
      return sec('構成', box);
    }
    // 部材を選ぶ（葉。自分は除く）
    function materialSelect(pal, self0, value, onPick, placeholder) {
      const leaves = pal.categories.filter((x) => x.id !== self0 && x.parent !== null && pal.isLeaf(x.id));
      const sel = h('select', { class: 'msel' }, placeholder ? h('option', { value: '' }, placeholder) : null, ...leaves.map((x) => h('option', { value: x.id, selected: x.id === value ? '' : null }, pal.categoryPath(x.id).slice(1).join(' / '))));
      sel.addEventListener('change', () => onPick(sel.value || null));
      return sel;
    }
    function labelSelect(pal, placeholder, onPick) {
      const sel = h('select', { class: 'msel sm' }, h('option', { value: '' }, placeholder), ...pal.paintable().map((l) => h('option', { value: l.id }, pal.labelPath(l.id).join(' / '))));
      sel.addEventListener('change', () => onPick(sel.value || null));
      return sel;
    }

    function detailLabel(pal, u, id) {
      const l = id ? pal.label(id) : null;
      if (!l) return h('div', { class: 'empty' }, '左の木で、ラベルの節を選んでください');
      const top = l.parent === null;
      const out = h('div', {});
      out.append(h('div', { class: 'ppath' }, pal.labelAncestors(id).reverse().concat([id]).map((x) => pal.label(x).name).join(' › ')));
      const name = h('input', { type: 'text', value: l.name, class: 'pin' });
      name.addEventListener('change', () => { const v = name.value.trim(); if (v && v !== l.name) edit('名前を直す', (S) => S.updateLabel(id, { name: v })); });
      out.append(h('div', { class: 'pkv' }, h('span', { class: 'k' }, '名前'), name));
      if (l.by === 'llm' || (l.src && l.src.length)) out.append(h('div', { class: 'muted', style: 'margin:-2px 0 8px 86px' }, h('span', { class: 'ai' }, 'AI'), ' 図面解析が作った' + (l.src && l.src.length ? '（根拠: ' + l.src.join('・') + '）' : '')));
      if (top) {
        const head = h('input', { type: 'checkbox', checked: l.root ? '' : null });
        head.addEventListener('change', () => edit(head.checked ? '見出しにする' : '見出しをやめる', (S) => S.updateLabel(id, { root: head.checked })));
        const hue = h('input', { type: 'range', min: '0', max: '359', value: String(l.hue !== undefined ? l.hue : 0), style: 'width:140px' });
        hue.addEventListener('change', () => edit('木の色', (S) => S.updateLabel(id, { hue: Number(hue.value) })));
        out.append(
          h('div', { class: 'pkv' }, h('span', { class: 'k' }, '見出し'), h('label', {}, head, ' この名前は木の名前で、それ自体は塗らない')),
          h('div', { class: 'pkv' }, h('span', { class: 'k' }, '木の色'), h('span', {}, hue, h('span', { class: 'swatch', style: 'background:' + (l.color || '#999') }))),
          h('div', { class: 'muted', style: 'margin:0 0 8px' }, '木 1 本が、重ならない 1 つの観点です（部屋・階・敷設 …）。同じ木の節どうしは、1 つの拾いに 1 つしか付きません。集計表の行・列には木を選びます。'),
        );
      }
      if (!l.root) out.append(sectionRules(pal, l));
      else out.append(sec('規則', h('div', { class: 'muted' }, '見出しには規則を付けられません。節に付けてください（見出しの下の節すべてに効かせたいなら、見出しをやめて節として使う）。')));
      // 祖先から効く規則
      const inh = pal.labelAncestors(id).map((x) => pal.label(x)).filter((x) => !x.root && (x.rules || []).length);
      if (inh.length) {
        const box = h('div', {});
        for (const a of inh) for (const r of a.rules) box.append(h('div', { class: 'inh' }, h('b', {}, a.name), '：', (pal.category(r.category) || { name: r.category }).name, ' → ', r.candidates.map((c) => (pal.category(c) || { name: c }).name).join('・')));
        out.append(sec('祖先の節から効く規則', box));
      }
      // 使っている層
      const layers = store.state.areas.filter((a) => a.label === id).map((a) => ['area', a]).concat(store.state.routes.filter((r) => r.label === id).map((r) => ['route', r]));
      const lbox = h('div', {});
      if (!layers.length) lbox.append(h('div', { class: 'muted' }, l.root ? '見出しは塗れません' : 'まだ図面の上で使っていません。拾いの画面でエリアを囲む・ルートをなぞると、この節を選べます。'));
      for (const [k, x] of layers) {
        const pg = store.page(x.page);
        lbox.append(h('button', { class: 'lrow', onclick: () => ctx.showLayer(k, x.id) }, k === 'area' ? 'エリア' : 'ルート', ' ', h('span', { class: 'dim' }, pg ? pg.title : x.page), ' →'));
      }
      out.append(sec('使っている層（' + layers.length + '）', lbox));
      out.append(h('div', { class: 'pacts' }, h('button', { onclick: () => addChild(id) }, '＋ 子を足す'), h('span', { class: 'spacer' }), h('button', { class: 'danger', onclick: () => removeNode('label', id) }, pal.labelChildren(id).length ? '下ごと消す' : '消す')));
      return out;
    }

    // 規則（この節の中では、カテゴリ は 候補 のどれか）。押すたびに保存。候補をまだ選んでいない規則は下書き
    function sectionRules(pal, l) {
      const rules = (l.rules || []).map((r) => ({ category: r.category, candidates: r.candidates.slice() }));
      const draft = st.draftRule && st.draftRule.label === l.id ? st.draftRule : null;
      const save = (label) => edit(label || '規則', (S) => S.setLabelRules(l.id, rules));
      const box = h('div', {});
      box.append(h('div', { class: 'muted' }, 'この節の層（エリア・ルート）が重なった拾いは、規則のカテゴリの下で置かれたなら、候補のどれかになります。候補が 1 つなら、置くだけで決まります。'));
      const rowOf = (r, isDraft) => {
        const leaves = r.category ? pal.leavesUnder(r.category).filter((x) => x !== r.category || pal.isLeaf(x)) : [];
        const catSel = h('select', { class: 'msel' }, ...pal.categories.filter((c) => c.parent !== null && !pal.isLeaf(c.id)).map((c) => h('option', { value: c.id, selected: c.id === r.category ? '' : null }, pal.categoryPath(c.id).slice(1).join(' / '))));
        catSel.addEventListener('change', () => {
          const nl = pal.leavesUnder(catSel.value);
          if (isDraft) { st.draftRule = { label: l.id, category: catSel.value }; render(); return; }
          r.category = catSel.value;
          r.candidates = r.candidates.filter((c) => nl.includes(c));
          if (!r.candidates.length) { rules.splice(rules.indexOf(r), 1); st.draftRule = { label: l.id, category: catSel.value }; }
          save();
        });
        const cands = h('div', { class: 'rcands' });
        for (const leaf of leaves) {
          const on = r.candidates.includes(leaf);
          const lc = pal.category(leaf);
          cands.append(h('button', { class: 'rcand' + (on ? ' on' : ''), title: pal.categoryPath(leaf).join(' › ') + '（' + (lc.size || '') + '）', onclick: () => {
            if (isDraft) { st.draftRule = null; rules.push({ category: r.category, candidates: [leaf] }); save('規則を足す'); return; }
            r.candidates = on ? r.candidates.filter((c) => c !== leaf) : leaves.filter((c) => c === leaf || r.candidates.includes(c));
            if (!r.candidates.length) rules.splice(rules.indexOf(r), 1);
            save();
          } }, h('span', { class: 'dot', style: '--dot:' + catColor(leaf) }), lc.name, lc.size === '長さ' ? h('small', { class: 'dim' }, ' 長') : null));
        }
        const el2 = h('div', { class: 'rule' }, h('div', { class: 'rh' }, catSel, h('span', { class: 'rt' }, 'は、この中では'), h('span', { class: 'spacer' }), h('button', { class: 'ghost icon', title: 'この規則を消す', onclick: () => { if (isDraft) { st.draftRule = null; render(); return; } rules.splice(rules.indexOf(r), 1); save('規則を消す'); } }, '×')), cands);
        if (isDraft) el2.append(h('div', { class: 'rwarn' }, '候補を 1 つ以上選んでください（選ぶまで保存されません）'));
        else if (r.candidates.length === 1) el2.append(h('div', { class: 'rok' }, '候補が 1 つ。置くだけで決まります'));
        else el2.append(h('div', { class: 'muted' }, '候補 ' + r.candidates.length + ' つ。置いたあとで選びます'));
        return el2;
      };
      for (const r of rules) box.append(rowOf(r, false));
      if (draft) box.append(rowOf({ category: draft.category, candidates: [] }, true));
      const firstCat = pal.categories.find((c) => c.parent !== null && !pal.isLeaf(c.id));
      box.append(h('div', { class: 'pacts' }, h('button', { disabled: firstCat ? null : '', title: firstCat ? '' : '先に部材カテゴリの木を作ってください', onclick: () => { st.draftRule = { label: l.id, category: (draft && draft.category) || firstCat.id }; render(); } }, '＋ 規則を足す')));
      return sec('規則（' + rules.length + '）', box);
    }

    /* ---------------- 規則の一覧（節 × カテゴリ） ---------------- */
    function ruleMatrix(pal) {
      const q = st.query.rules.trim();
      const search = h('input', { class: 'search', type: 'search', placeholder: '節・カテゴリ・候補の名前で探す', value: st.query.rules });
      search.addEventListener('input', () => { st.query.rules = search.value; render(); const s2 = el.querySelector('.pcenter .search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } });
      const withRules = pal.labels.filter((l) => (l.rules || []).length);
      const cats = [...new Set(withRules.flatMap((l) => l.rules.map((r) => r.category)))].filter((c) => pal.category(c)).sort((a, b) => pal.categoryPath(a).join('/').localeCompare(pal.categoryPath(b).join('/')));
      const name = (c) => (pal.category(c) || { name: c }).name;
      const hit = (l) => !q || pal.labelPath(l.id).join('/').includes(q) || l.rules.some((r) => name(r.category).includes(q) || r.candidates.some((c) => name(c).includes(q)));
      const rows = withRules.filter(hit).sort((a, b) => {
        const ra = pal.labelRoots().findIndex((x) => x.id === pal.labelRoot(a.id));
        const rb = pal.labelRoots().findIndex((x) => x.id === pal.labelRoot(b.id));
        return ra - rb || pal.labels.indexOf(a) - pal.labels.indexOf(b);
      });
      const head = h('div', { class: 'phead' }, h('div', { class: 'ptitle' }, '規則の一覧'), search, h('span', { class: 'spacer' }), h('span', { class: 'muted' }, rows.length + ' 節 × ' + cats.length + ' カテゴリ'));
      const body = h('div', { class: 'olist' });
      if (!rows.length) body.append(h('div', { class: 'empty', style: 'margin:10px' }, withRules.length ? '見つかりません' : 'まだ規則がありません。「層のラベル」で節を選んで足すか、「まとめて貼り付け」で「玄関: GS100, G100」の形で一度に足せます。'));
      else {
        const tbl = h('table', { class: 'rmx' }, h('tr', {}, h('th', {}, '節'), ...cats.map((c) => h('th', { title: pal.categoryPath(c).join(' › ') }, name(c)))));
        let lastRoot = null;
        for (const l of rows) {
          const root = pal.labelRoot(l.id);
          if (root !== lastRoot) {
            tbl.append(h('tr', { class: 'grp' }, h('td', { colspan: String(cats.length + 1) }, pal.label(root).name)));
            lastRoot = root;
          }
          const tr = h('tr', {}, h('th', { class: 'ln', onclick: () => { st.kind = 'label'; st.sel.label = l.id; render(); } }, h('span', { class: 'odot', style: 'background:' + (l.color || '#999') }), pal.labelPath(l.id).join(' / ')));
          for (const c of cats) {
            const r = l.rules.find((x) => x.category === c);
            tr.append(h('td', { class: r ? 'has' + (r.candidates.length === 1 ? ' one' : '') : '', onclick: () => { st.kind = 'label'; st.sel.label = l.id; render(); } }, r ? r.candidates.map(name).join('・') : ''));
          }
          tbl.append(tr);
        }
        body.append(tbl);
      }
      const noRule = pal.paintable().filter((l) => !(l.rules || []).length).length;
      return h('div', { class: 'pcenter' }, head, body, h('div', { class: 'okeys' }, '緑は候補が 1 つ（置くだけで決まる）。規則の無い節 ' + noRule + ' 件（階・敷設のように、絞らず集計の観点にだけ使う節もあります）'));
    }

    /* ---------------- 系統（配線表の行） ---------------- */
    function systemsTable(pal) {
      const list = store.state.palette.systems || [];
      const lines = new Map();
      for (const p of store.state.pickups) if (p.kind === 'line' && p.name) lines.set(p.name, (lines.get(p.name) || 0) + 1);
      const lenLeaves = pal.categories.filter((x) => x.parent !== null && pal.isLeaf(x.id) && x.size === '長さ');
      const catSel = (value, onPick) => {
        const sel = h('select', { class: 'msel sm' }, h('option', { value: '' }, '（配線を選ぶ）'), ...lenLeaves.map((x) => h('option', { value: x.id, selected: x.id === value ? '' : null }, pal.categoryPath(x.id).slice(1).join(' / '))));
        sel.addEventListener('change', () => onPick(sel.value || null));
        return sel;
      };
      const inp = (v, w, on) => { const i = h('input', { type: 'text', value: v || '', style: 'width:' + w }); i.addEventListener('change', () => on(i.value.trim())); return i; };
      const done = list.filter((x) => x.name && lines.get(x.name)).length;
      const head = h('div', { class: 'phead' }, h('div', { class: 'ptitle' }, '系統（配線表）'), h('span', { class: 'muted' }, list.length + ' 系統・線を引いた ' + done), h('span', { class: 'spacer' }), h('button', { onclick: () => edit('系統を足す', (S) => S.addSystem({})) }, '＋ 系統'));
      const body = h('div', { class: 'olist' });
      if (!list.length) body.append(h('div', { class: 'empty', style: 'margin:10px' }, 'まだ系統がありません。図面解析で配線表を「配線表」の注釈で囲んで解析するか、「＋ 系統」で足してください。'));
      else {
        const tbl = h('table', { class: 'ptbl sys' }, h('tr', {}, h('th', {}, '系統名'), h('th', {}, '起点'), h('th', {}, '終点'), h('th', {}, '配線（カテゴリ）'), h('th', { class: 'num', title: 'この名前の線の本数' }, '線'), h('th')));
        list.forEach((x, i) => {
          const n = x.name ? lines.get(x.name) || 0 : 0;
          tbl.append(h('tr', { class: n ? 'done' : '' },
            h('td', {}, x.by === 'llm' ? h('span', { class: 'ai' }, 'AI') : null, inp(x.name, '80px', (v) => edit('系統名', (S) => S.updateSystem(i, { name: v })))),
            h('td', {}, inp(x.from, '110px', (v) => edit('系統の起点', (S) => S.updateSystem(i, { from: v })))),
            h('td', {}, inp(x.to, '110px', (v) => edit('系統の終点', (S) => S.updateSystem(i, { to: v })))),
            h('td', { title: x.text || '' }, catSel(x.category, (v) => edit('系統の配線', (S) => S.updateSystem(i, { category: v })))),
            h('td', { class: 'num' }, n || ''),
            h('td', {}, h('button', { class: 'ghost icon', title: '消す', onclick: () => edit('系統を消す', (S) => S.removeSystem(i)) }, '×')),
          ));
        });
        body.append(tbl);
      }
      return h('div', { class: 'pcenter' }, head, body, h('div', { class: 'okeys' }, '拾いの画面で線に系統名を付けると、「線」の欄に本数が出ます（消し込み）。配線は、線を引くときのカテゴリの手がかりです。'));
    }

    /* ---------------- 見込み（表に書いてある個数） ---------------- */
    function expectedTable(pal) {
      const list = store.state.palette.expected || [];
      const leaves = pal.categories.filter((x) => x.parent !== null && pal.isLeaf(x.id));
      const head = h('div', { class: 'phead' }, h('div', { class: 'ptitle' }, '見込み（表の個数）'), h('span', { class: 'muted' }, list.length + ' 件'), h('span', { class: 'spacer' }),
        labelSelect(pal, '＋ 見込み（条件の節を選ぶ）', (v) => { if (v) edit('見込みを足す', (S) => { S.state.palette.expected.push({ labels: [v], category: leaves[0] ? leaves[0].id : null, count: 1, by: 'human' }); S.touchPalette(); }); }));
      const body = h('div', { class: 'olist' });
      if (!list.length) body.append(h('div', { class: 'empty', style: 'margin:10px' }, 'まだ見込みがありません。図面解析で器具表を「機器表」の注釈で囲んで解析すると、部屋ごとの台数が入ります。'));
      else {
        const tbl = h('table', { class: 'ptbl' }, h('tr', {}, h('th', {}, '条件（ラベル）'), h('th', {}, '部材'), h('th', { class: 'num' }, '個数'), h('th')));
        list.forEach((x, i) => {
          const conds = h('span', { class: 'chips2' });
          for (const w of x.labels) conds.append(h('span', { class: 'lch sm', style: '--c:' + ((pal.label(w) || {}).color || '#999') }, pal.label(w) ? pal.labelPath(w).join(' / ') : w + '（無い）', h('button', { class: 'ghost icon', onclick: () => edit('見込みの条件', (S) => S.updateExpected(i, { labels: x.labels.filter((y) => y !== w) })) }, '×')));
          conds.append(labelSelect(pal, '＋', (v) => { if (v && !x.labels.includes(v)) edit('見込みの条件', (S) => S.updateExpected(i, { labels: x.labels.concat([v]) })); }));
          const cnt = h('input', { type: 'number', min: '0', step: '1', value: x.count, style: 'width:64px' });
          cnt.addEventListener('change', () => edit('見込みの個数', (S) => S.updateExpected(i, { count: Number(cnt.value) || 0 })));
          tbl.append(h('tr', {}, h('td', {}, x.by === 'llm' ? h('span', { class: 'ai' }, 'AI') : null, conds), h('td', {}, materialSelect(pal, null, x.category, (v) => edit('見込みの部材', (S) => S.updateExpected(i, { category: v })))), h('td', { class: 'num' }, cnt), h('td', {}, h('button', { class: 'ghost icon', title: '消す', onclick: () => edit('見込みを消す', (S) => S.removeExpected(i)) }, '×'))));
        });
        void leaves;
        body.append(tbl);
      }
      return h('div', { class: 'pcenter' }, head, body, h('div', { class: 'okeys' }, '条件の節（部屋など）が重なった所に置いた部材の数と比べます（集計タブ → 照合）。'));
    }

    /* ---------------- まとめて貼り付け ---------------- */
    async function pasteModal() {
      const kind = st.kind === 'rules' ? 'label' : st.kind;
      const pal = P();
      const selId = st.sel[kind];
      const ta = h('textarea', { class: 'paste', rows: '14', spellcheck: 'false', placeholder: kind === 'category' ? '照明器具 [個数]\n  ダウンライト\n    GS100\n    G100\n  ベースライト\n    A321\n配線 [長さ]\n  幹線\n    CVT 100\n    IV 14' : '# 部屋\n  1F\n    玄関・風除室: GS100, G100\n    事務室: A321\n# 敷設\n  ラック上\n  天井内' });
      const where = h('select', {});
      if (kind === 'category') {
        where.append(h('option', { value: 'cat-root' }, '根の直下'));
        if (selId && selId !== 'cat-root') where.append(h('option', { value: selId, selected: '' }, '「' + pal.category(selId).name + '」の下'));
      } else {
        where.append(h('option', { value: '' }, '森の一番上'));
        if (selId) where.append(h('option', { value: selId }, '「' + pal.label(selId).name + '」の下'));
      }
      const prev = h('div', { class: 'ppreview' });
      const draw = () => {
        const items = SM.parseOutline(ta.value);
        prev.innerHTML = '';
        if (!items.length) { prev.append(h('div', { class: 'muted' }, '1 行 1 つ。字下げ（空白 2 つかタブ）で階層になります。')); return items; }
        const unknown = [];
        const ul = h('div', {});
        for (const it of items) {
          const refs = it.refs || [];
          for (const r of refs) if (!pal.categories.some((c) => c.name === r && pal.isLeaf(c.id))) unknown.push(r);
          ul.append(h('div', { style: 'padding-left:' + it.depth * 16 + 'px' }, it.root ? h('span', { class: 'ob dim' }, '見出し') : null, ' ', it.name, it.size ? h('span', { class: 'ob size' }, it.size) : null, refs.length ? h('span', { class: 'dim' }, '　規則: ' + refs.join('・')) : null));
        }
        prev.append(h('div', { class: 'pst' }, items.length + ' 件を足します'), ul);
        if (unknown.length) prev.append(h('div', { class: 'rwarn' }, '部材カテゴリに無い名前（規則に入りません）: ' + [...new Set(unknown)].join('・')));
        return items;
      };
      ta.addEventListener('input', draw);
      // Tab は字下げ（空白 2 つ）。Shift+Tab で戻す
      ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const a = ta.selectionStart;
        const b = ta.selectionEnd;
        const v = ta.value;
        const ls = v.lastIndexOf('\n', a - 1) + 1;
        const block = v.slice(ls, b);
        const out = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
        ta.value = v.slice(0, ls) + out + v.slice(b);
        ta.selectionStart = Math.max(ls, a + (e.shiftKey ? -(block.length - out.length > 0 ? Math.min(2, block.length - out.length) : 0) : 2));
        ta.selectionEnd = ls + out.length;
        draw();
      });
      const help = kind === 'category'
        ? '1 行 1 つ。字下げで子になります。行末の [個数] / [長さ] で数え方（書かなければ親と同じ）。器具表や配線表から写した一覧を、そのまま貼れます。'
        : '1 行 1 つ。字下げで子になります。行頭の「# 」は見出し（塗らない木の名前）。「名前: A, B」と書くと、A・B を候補にする規則を付けます（A・B は部材カテゴリの葉の名前。規則のカテゴリは、A・B の共通の親）。';
      const m = openModal({ title: (kind === 'category' ? '部材カテゴリ' : '層のラベル') + 'をまとめて足す', width: 760, dismiss: false, body: h('div', { class: 'pastebox' }, h('div', {}, h('div', { class: 'muted', style: 'margin-bottom:6px' }, help), ta, h('div', { style: 'margin-top:6px' }, '足す場所: ', where)), prev), actions: ['spacer', { label: 'やめる', id: 'cancel' }, { label: '足す', primary: true, on: (hd) => hd.close('ok') }] });
      draw();
      setTimeout(() => ta.focus(), 30);
      if ((await m.result) !== 'ok') return;
      const items = SM.parseOutline(ta.value);
      if (!items.length) return;
      const parent = where.value || (kind === 'category' ? 'cat-root' : null);
      const r = edit('まとめて足す', (S) => S.addOutline(kind, parent, items));
      if (!r) return;
      if (parent) st.collapsed[kind].delete(parent);
      st.kind = kind;
      st.sel[kind] = r.ids[0];
      render();
      toast(r.ids.length + ' 件を足した' + (r.unknown.length ? '（規則に入らなかった名前 ' + r.unknown.length + '）' : ''), 3000);
    }

    return { render };
  };
})();
