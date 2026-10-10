# GP の提案（記号の検出）

拾いの画面で、**利用者が置いた箱を手本に、同じ記号の場所をページから探して「提案」にする**仕組みです（T-0646）。
提案は拾いではありません —— 点線の箱と点数（%）で図面の上に出るだけで、集計には数えません。
**承認する**と拾い（箱）になり、**退ける**とその場所は次から負例になります。

## 使い方（拾いのタブ）

1. 右の板の「提案（GP）」を開き、**特徴量を用意する** を押す。ページの画像から特徴量を計算します（A3 1 ページ: WebGPU なら数秒、wasm なら数十秒。一度計算すればブラウザの IndexedDB に残ります）
2. 右の木でカテゴリを選び、記号を **1 つ** 箱で囲う。「箱を置いたら探す」が入っていれば、そのまま提案が出ます（手で探すなら **探す**）
3. 提案を押して **Enter で承認・Delete で退ける**。承認すると次の提案が選ばれます。点数の高いものが並んでいれば **見えている提案を承認** でまとめて。**閾値** で見せる下限を動かせます
4. 違うものが混じれば退ける（負例）→ もう一度探す。**他のカテゴリの箱も負例** になるので、別の記号を囲うほど提案は絞れます

承認した箱は `by: "gp"` と `score` を持ち、普通の箱と同じように動かす・消す・集計できます。

## 仕組み

| 段 | どこ | 何をするか |
| :-- | :-- | :-- |
| 特徴量 | `app/detector.js`（口「検出」）＋ `app/detector_worker.js`（Worker） | ページを 360 dpi で 1 回描き、1024 px のタイル（重なり 64 px）に切って Worker へ。Worker は ONNX（`data/gp_features_v1.onnx`・3.7 MB。P-0019 で学習した特徴抽出器）を onnxruntime-web（CDN）で回し、**インクの近くのセル（8 px 刻み）だけ** 128 次元を int8 ＋ セルごとの倍率で返す。ページ全体で組み立てて IndexedDB `feat:<図面の指紋>:<ページ>` に置く |
| GP | `core/gp.js`（画面を持たない。node でも動く） | 手本（そのカテゴリとその下の箱の中心の特徴ベクトル。y=1）と負例（他のカテゴリの箱・退けた場所。y=0）で GP 回帰（RBF 核。核のパラメータは学習済みの固定値 `DEFAULT_KERNEL`）。全セルの事後平均を logit に通して点数にし、閾値の上から順に、**手本の大きさの 1.1 倍より近いものを除いて**（既にある箱・退けた場所の近くも）拾う |
| データ | `core/model.js` | `proposals`（id・ページ・カテゴリ・bbox・score・run）と `rejections`（ページ・カテゴリ・中心）。`approveProposal` → `addBox(…, { by: 'gp', score })`。`rejectProposal` → rejections に 1 行。どちらも履歴 1 行（元に戻せる） |
| 画面 | `app/app.js` | 点線の提案・当たり判定・右の板「提案（GP）」・Enter／Delete・まとめて承認・箱を置いたら探す |
| Itera | `app/itera.js` | AI の道具 `hiroi_detect`（prepare / search / approve / reject）。モデルは VFS → 無ければホストのオリジンの `/demo/hiroi/gp_features_v1.onnx` を落として VFS に置く |

Worker は相対パスでは作りません（Itera の上では解決されないため）。`SMDetectorWorkerMain` の文字列から Blob の Worker を起こし、`importScripts` で CDN の onnxruntime-web を読みます。

### 実行環境による速さ

A3 1 ページ（35 タイル）の目安。WebGPU → wasm の順に試し、使えたほうで動きます。
右の板と `hiroi_detect action=prepare` の戻りに、何で動いたかが出ます。

| 環境 | 1 ページ |
| :-- | :-- |
| Chrome・WebGPU（Intel iGPU） | 約 3〜5 秒 |
| wasm 4 スレッド（cross-origin isolated なページ） | 約 20 秒 |
| wasm 1 スレッド（Firefox on Linux・WebGPU 無し・isolated でない） | 約 65 秒 |

多スレッドの wasm には COOP/COEP（cross-origin isolated）が要ります。GitHub Pages も Itera の上もそうではないので、WebGPU が無い環境では 1 スレッドになります。

## 試験

- `node --test tests/gp.test.js` — 核（quantize・fit/score/propose・collect）。特徴量は作り物（セルごとに「記号の向き」を 1 つ持ち、同じ向きは近い埋め込みになる）
- `node tests/ui/gp.mjs` — 画面（playwright）。白紙の PDF に作り物の特徴量を IndexedDB に入れて通す（ONNX も Worker も使わない）。似た記号を 1 つ退けると、もう 1 つの似た記号も提案から消えることまで見る
- サンプル図面 p.36（公開していない）で、GS100 のダウンライト 12 個のうち 1 個を手本にすると、残り 11 個が提案になる（35 提案のうち ≥50% が 30）

## 分かっていること・まだのこと

- 手本 1 つでも当たるが、似た記号（例: 同じ丸にちがう印）が混じる。退けると分かれる
- 倍率は固定（360 dpi）。学習データの記号の大きさ（38 × 35 px）から外れる図面（縮尺が大きく違う）では落ちるはず。倍率を記号の大きさに合わせて決めるのはこれから
- 複数ページにまたがって手本を使う（`collect` は全ページの箱を見るが、探すのはいまのページだけ）
- Cloud Run での計算（ブラウザが遅いとき）は退避先。まだ無い
