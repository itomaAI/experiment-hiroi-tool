# 保存の形

## 作業（「書き出す」）

```jsonc
{
  "kind": "hiroi-job",
  "format": 5,
  "doc": { "name": "図面.pdf", "pages": 76, "fingerprint": "…", "sample": false }, // PDF そのものは含まない
  "palette": { … },                    // 下のパレットと同じ
  "pages":    [{ "id": "pg-036", "index": 36, "title": "1 階 電灯", "width": 1190.55, "height": 841.89 }],
  "areas":    [{ "id": "ar-0001", "page": "pg-036", "shape": { "type": "rect" | "poly", "points": [[x, y], …] }, "label": "lb-…" }],
  "nodes":    [{ "id": "nd-0001", "page": "pg-036", "x": 470, "y": 300, "level": "上", "base": "nd-…" }],   // level・base は立の印だけ
  "segments": [{ "id": "sg-0001", "page": "pg-036", "a": "nd-…", "b": "nd-…", "points": [[x, y], …], "riser": true }], // riser は立の線分だけ
  "routes":   [{ "id": "rt-0001", "page": "pg-036", "segments": ["sg-…"], "label": "lb-…" }
             | { "id": "rt-0002", "page": "pg-036", "segments": ["sg-…"], "label": null, "length_h": 11.4, "length_v": 2.0 }],
  "pickups":  [{ "id": "pk-0001", "kind": "box", "page": "pg-036", "category": "ct-…", "bbox": [x, y, w, h], "chosen": null }
             | { "id": "pk-0002", "kind": "line", "page": "pg-036", "category": "ct-…", "nodes": [...], "path": ["sg-…"],
                 "name": "1A2", "additions": { "nd-…": 5 }, "lengths": { "sg-…": { "h": 7, "v": null } } }],
  "annotations": [{ "id": "an-0001", "page": "pg-036", "bbox": [x, y, w, h], "kind": "schedule", "title": "器具表", "note": "機械への覚え書き", "allPages": false }],
  "analysis": {
    "focus": "今回の範囲（人が解析に伝えること）",
    "notes": [{ "id": "nt-0001", "kind": "注意", "text": "…", "pages": [36], "src": ["A3"], "by": "llm" | "human", "done": false }],
    "runs":  [{ "id": "run-…", "at": "…", "model": "gemini-3.8-flash", "ms": 61000, "pages": [1, 2, 3], "crops": 9, "tokensIn": 35000, "tokensOut": 16000, "sum": { … } }]
  },
  "seq": { … }                          // 次の id の番号
}
```

ページは図面解析の欄も持ちます: `sheet`・`kinds`（種類の並び）・`work`・`floor`・`scale`・`summary`・`send`（解析に送る）・`pick`（拾いのタブに出す）・`checked`（人が確かめた）・`tagBy`（欄ごとに `llm` か `human`）・`pickBy`。
注釈の `kind` は `spec`（仕様書）・`legend`（凡例）・`schedule`（機器表）・`wiring`（配線表）・`note`（注記）・`layer`（層の手がかり）・`object`（対象の見本）・`caution`（注意）・`title`（題欄）。

座標は PDF のポイント（原点は左上）。

## パレット（「パレットを書き出す」）

```jsonc
{
  "kind": "hiroi-palette",
  "format": 1,
  "palette": {
    "name": "…",
    "categories": [
      { "id": "cat-root", "name": "拾えるもの（根）", "parent": null, "size": null },
      { "id": "ct-0001", "name": "照明器具", "parent": "cat-root", "size": "個数" },
      { "id": "ct-0009", "name": "1A2", "parent": "ct-0007", "size": "長さ",
        "components": [{ "material": "ct-0010", "count": 1, "when": [], "add": true },      // add: 余長を足す
                       { "material": "ct-0012", "count": 1, "when": ["lb-…"], "add": false }] } // when: このラベルの層の上だけ
    ],
    "labels": [
      { "id": "lb-0001", "name": "部屋", "parent": null, "root": true, "hue": 275 },        // root: 見出し（塗れない）
      { "id": "lb-0002", "name": "玄関・風除室", "parent": "lb-0001",
        "rules": [{ "category": "ct-0003", "candidates": ["ct-0004"] }] }
    ],
    "views": [],                         // 保存した観点（集計表の行・列）。無くてよい
    "expected": [{ "labels": ["lb-0002"], "category": "ct-0004", "count": 4, "by": "llm", "src": ["A3"] }], // 見込み（表に書いてある個数）
    "systems":  [{ "name": "1A2", "from": "キュービクル", "to": "L1-1", "category": "ct-0009", "text": "…", "by": "llm" }] // 系統（配線表の行）
  }
}
```

カテゴリ・ラベルは、図面解析が作ったものに `by: "llm"` と `src`（根拠の札・ページ）を持ちます。

パレットを読み込むときは「置き換える」か「足し合わせる（無い id だけ足す）」を選びます。
置き換えは、図面の上の層・拾いが使っている id が新しいパレットに無ければ止まります。
