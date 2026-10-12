# Itera の上で動かす

拾いツールは単体（GitHub Pages）で動きますが、[Itera](https://github.com/itomaAI/itera2-dev)（ブラウザで動く AI OS）の上でアプリとして開くと、次が足されます（`app/itera.js`）。単体では何も変わりません。

## 保存

作業と図面は、ブラウザの localStorage／IndexedDB ではなく Itera の VFS に置きます。

| パス | 中身 |
| :-- | :-- |
| `data/apps/hiroi-tool/current/job.json` | 作業（[data-format.md](data-format.md) の「作業」と同じ形） |
| `data/apps/hiroi-tool/current/source.pdf`・`source.json` | 図面の PDF と、その名前・指紋・ページ数 |
| `data/apps/hiroi-tool/current/shots/` | AI のために描いた画像（ページの縮小・注釈の切り抜き） |

`spawn` の引数 `file=<VFS の PDF>` で開くと、その図面から始まります。「…」→「すべて消す」は VFS のこれらも消します。

## AI への道具

Itera の AI（エンジン）に、次の道具を公開します（`MetaOS.tools.register`）。AI は図面解析の「解析する」とは違い、**注釈を 1 つ読んでは、その分だけパレットに書く**ことを繰り返せます。一度の応答の長さの上限に当たりません。人が画面で直したものと AI が書いたものは同じ場所に入り、どちらも元に戻せます。

| 道具 | 何をするか |
| :-- | :-- |
| `hiroi_status` | 開いている図面・ページ（拾う／送る）・注釈の一覧・パレットの要約・図面の上の層と拾いの数 |
| `hiroi_page page= dpi=` | ページの縮小画像を VFS に書き、パスを返す（既定 60 dpi。上限 150） |
| `hiroi_annotate page= bbox= kind= title= note=` | 図面の上に注釈（読みどころ）を囲う。人が囲うのと同じもの |
| `hiroi_crop annotation= page= dpi=` | 注釈の切り抜き（既定 300 dpi。大きければ 1536 px のタイル）を VFS に書き、パスを返す |
| `hiroi_palette part= q=` | パレットの中身（id 付き）。categories / labels / rules / expected / systems / notes |
| `hiroi_apply` | 編集の塊（図面解析の応答と同じ JSON）を入れる。`core/analysis.js` の `apply`。履歴 1 行 |
| `hiroi_undo` | 最後の編集を元に戻す |
| `hiroi_open path=` | VFS の PDF を開く |
| `hiroi_show screen= page=` | 画面（タブ・ページ）を切り替える |
| `hiroi_detect action= page= category= threshold= ids=` | GP の提案（[docs/gp.md](gp.md)）。`prepare`（ページの特徴量を用意する）／`search`（手本から探す。カテゴリは id か名前）／`approve`・`reject`（提案を承認・退ける。`ids` で選ぶ、省けば閾値の上を全部） |

AI が書いたものは `by: "llm"` を持ちます（図面解析と同じ）。AI が承認した提案の箱は `by: "gp"` です。

GP の特徴抽出器（ONNX・3.7 MB）は、VFS の `data/apps/hiroi-tool/gp_features_v1.onnx`（無ければ `system/demo/hiroi/model/`）から読みます。どちらにも無ければ、ホストのオリジンの `/demo/hiroi/gp_features_v1.onnx` を `MetaOS.net.download` で落として VFS に置きます（配信物の `public/demo/hiroi/` に置く）。

典型的な流れ: `hiroi_status` → `hiroi_page`（表の場所を見る）→ `hiroi_annotate`（器具表を囲う）→ `hiroi_crop` → 画像を読む → `hiroi_apply`（その表の分）→ 次の注釈へ。利用者が「この部屋の規則を直して」と言えば、同じ `hiroi_apply` で直せます。

## 図面解析タブの「AI に頼む」

Itera の上では、図面解析タブの「解析する」（単体版では利用者の鍵で Gemini へ直接送る）が **「AI に頼む ▶」** になります。鍵は要りません。押すと、送るページを **1 ページずつの PDF** に切り出し（pdf-lib。読めなければ 60 dpi の縮小画像）、注釈の切り抜き（300 dpi。大きければタイル）と合わせて **先に一括で用意して** `data/apps/hiroi-tool/current/shots/ask-<日時>/` に置き、そのパスを並べた頼みの文をチャットに送って OS の AI を起こします（`MetaOS.ai.ask`）。AI はそれらを `read_file` で読むだけでよく、`hiroi_page` / `hiroi_crop` を 1 枚ずつ呼ばずに済みます。書くのは `hiroi_apply` で、読めた分ずつ。

描くのは pdf.js で、`requestAnimationFrame` で刻んで進むため、**タブが裏にある間は止まります**（`hiroi_page` / `hiroi_crop` も同じ）。

## 試験

`node --test tests/itera.test.js`（MetaOS を偽物にして、道具の登録・`hiroi_apply`・`hiroi_annotate`・`hiroi_detect`（口「検出」も偽物）・保存を通す。画像を描く道具と特徴量の計算は canvas と Worker が要るので、Itera の上で確かめる）。
