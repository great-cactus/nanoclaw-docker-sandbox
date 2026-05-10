---
name: obsidian-personal-zettelkasten
description: AkiraのObsidian vaultにZettelkasten方式のノート（Permanent/Literature/Input論文/Input書籍/Input記事/DailyNote/WeeklyNote）を作成・編集・検索する際の規則を提供する。トリガー：「ZK」「Zettelkasten」「permanent note」「literature note」「文献ノート」「論文ノート」「読書ノート」「DailyNote」「WeeklyNote」「日次ノート」「週次ノート」「Input/Output」「vaultにメモ」「考察を書く」「論文を読んでまとめる」など、Zettelkastenの読み書きを伴うあらゆるリクエスト。frontmatter形式・ファイル命名規則・タグ規則・Input↔Outputの境界に関わる場合は必ずこのスキルを参照すること。Templater自動化を模倣して書く際の正解を保持している。
---

# AkiraのObsidian Zettelkastenガイド

## 思想：Input / Output の二層構造

Zettelkastenの中核は `Input/` と `Output/` の役割分離：

- **`Input/`** = vault**外**から取り込んだソース。論文・書籍・記事・動画など、自分以外が作ったもの
- **`Output/`** = vault**内**で生まれた自分の言葉。読書メモ・考察・理論・日次/週次の記録

両者の境界は厳密に守る。混ぜると後で「これは要約なのか自分の考えなのか」が分からなくなる。

## ノート種別と命名（早見表）

| 種別 | 場所 | ファイル名 | 特徴 |
|---|---|---|---|
| 論文ノート | `Input/` | `<citekey>.md`（例: `zhangCombustionChemistryAmmonia2023.md`） | `media: JournalPaper` |
| 書籍ノート | `Input/` | `<書名>-<著者>.md` | `media: book` |
| 記事/動画ノート | `Input/` | `<記事タイトル>.md` | mediaは記事種類に応じて |
| LITERATUREノート | `Output/` | `<Inputファイル名のbasename>-<短いタイトル>.md` | tags に `LITERATURE`、本文先頭にInputリンク必須 |
| PERMANENTノート | `Output/` | `<タイトル>.md` | tags に `PERMANENT` |
| DailyNote | `Output/DailyNotes/` | `YYYY-MM-DD.md` | tags に `DailyNote` |
| WeeklyNote | `Output/WeeklyNotes/` | `YYYY-MM-N.md` | tags に `weeklyNote` |

**LITERATUREノートとPERMANENTノートの違い**：
- LITERATURE = 特定のInputから引き出した1つの主張・データ・要約
- PERMANENT = 自分が組み上げた知見・考察・理論

Inputに紐づく読書メモはLITERATURE側、自分の論考はPERMANENT側、と振り分ける。

## LITERATUREノートの命名規則

例：`Input/yuEndgasAutoignitionKnocking2022.md` から派生したsummaryノートは
**`Output/yuEndgasAutoignitionKnocking2022-summary.md`**

**本文の最初の行に必ず元のInputへのリンクを書く**：
```markdown
[[Input/yuEndgasAutoignitionKnocking2022.md]]
```
これによりOutputからInputへ逆引きできる。これを省略するとZettelkastenの相互参照網が破綻するので絶対に省かない。

## Frontmatterリファレンス

### PERMANENTノート

```yaml
---
ID: 202509301008
created: 2025-09-30 10:08
title: <タイトル>
aliases: []
tags: [ 2025/09/30, PERMANENT, <内容タグ...> ]
---
```

- `ID`：`YYYYMMDDhhmm`（12桁、秒なし）
- `created`：`YYYY-MM-DD HH:mm`
- `tags` の順序：作成日 `YYYY/MM/DD` → 大文字 `PERMANENT` → 内容タグ
- 内容タグは階層可（例：`laminar_flame_theory`, `detonation/cell_instability`, `Project/PhD_thesis`）

### LITERATUREノート

```yaml
---
ID: 202510021241
created: 2025-10-02 12:41
title: <タイトル>
aliases: []
tags: [ 2025/10/02, LITERATURE, <Inputから引き継いだタグ + 内容タグ> ]
---
[[Input/<InputFileName>.md]]

<本文>
```

PERMANENTと同じ構造で `tags` に `LITERATURE` が入る。Inputノートの `tags` を引き継いで足すのが慣例。

### Input — 論文ノート

```yaml
---
title: "<論文タイトル>"
citekey: <citekey>
source: <ジャーナル名>
author:
  - <First Last>
  - <First Last>
published: YYYY/MM/DD
tags:
  - <内容タグ>
media: JournalPaper
---

> [!Cite]
> <整形された参考文献情報（doiリンクを含む）>
```

- 著者は**改行＋`  - ` のリスト記法**
- `tags` も**リスト記法**（インラインではない）
- 本文冒頭にCalloutで参考文献情報

### Input — 書籍ノート

```yaml
---
title: <書名>
source: <出版社>
author:
  - <著者>
published: YYYY-MM-DD
created: YYYY/MM/DD
ID: <14桁ID>
tags:
  - YYYY/MM/DD
  - <その他>
media: book
---
# <書名>
<書誌の説明>
```

### DailyNote

```yaml
---
ID: 202605101015
aliases: []
tags: [ 2026/05/10, DailyNote]
---
```
本文は自由記述。

### WeeklyNote

- ファイル名の `N` は当該月における**火曜日基準**でのN番目の週
- 火曜日が属する月をその週の「親」とする（月またぎの週は火曜の月で決める）
- 例：2026年5月の第1火曜日を含む週 → `2026-05-1.md`

```yaml
---
ID: 202605012204
tags: [ 2026/05/01, weeklyNote]
---
```

## タグ規則

- **日付タグ**：`YYYY/MM/DD`（スラッシュ区切り、ゼロ埋め）
- **種別タグ（大文字）**：`PERMANENT`, `LITERATURE`, `DailyNote`, `weeklyNote`, `ARCHIVED`（古いノートに付くことがある）
- **内容タグ**：階層可（例：`Fuel/NH3`, `detonation/cell_instability`, `Project/PhD_thesis`）

タグの順序は「日付 → 種別 → 内容」を必ず守る。Dashboard.md のHeatmap dataviewjsが `#PERMANENT` を拾うなど、種別タグに依存した自動集計がある。

## frontmatter記法の使い分け（実例で確認した支配的なパターン）

- **Inputノート系**（`Input/`配下の論文・書籍）：tags や author は**改行＋`  - ` のリスト記法**
- **Output系**（PERMANENT/LITERATURE/Daily/Weekly）：tags は**インライン記法 `[ a, b, c ]`**

両者は混在せず、新規作成時は上記の慣例に揃える。

## ID/タイムスタンプの生成

人間が手で書くと面倒なので、現在時刻から機械的に作る：

- `ID`（PERMANENT/LITERATURE/Daily/Weekly）：`YYYYMMDDhhmm`（12桁）
- `ID`（書籍frontmatterの旧テンプレート）：`YYYYMMDDhhmmss`（14桁）の場合あり
- `created`：`YYYY-MM-DD HH:mm`
- 日付タグ：`YYYY/MM/DD`

すべて**ローカル時刻（JST）**で生成する。

## 作成ワークフロー

ノートを新しく作る指示を受けたら、以下の順で判断する：

1. **ノート種別を確定**：permanent / literature / input(paper/book/article) / daily / weekly のどれか。曖昧なら1問だけユーザに確認する。
2. **正しいディレクトリと命名規則を決める**：上の早見表を参照。LITERATUREノートを作るときは元のInputファイル名を必ず把握しておく。
3. **frontmatterを書く**：種別に応じた正しいキーを網羅。記法（インライン vs リスト）を実例の慣例に合わせる。日付フォーマット（`-` vs `/`）に注意。
4. **LITERATUREの場合は本文先頭にInputリンクを書く**。
5. **mcp-obsidianツールで実書き込み**：`obsidian_append_content`（新規作成）または `obsidian_patch_content`（既存編集）。ユーザがdry-runを求めている場合は内容のみ提示。

## ノート検索パターン

ユーザが「○○について書いたノートを探して」と言ってきた場合：

| 求められるもの | 使うツール |
|---|---|
| 内容で全文検索 | `obsidian_simple_search` |
| 特定ディレクトリの一覧 | `obsidian_list_files_in_dir` → `obsidian_batch_get_file_contents` |
| 構造化条件（タグ＋日付） | `obsidian_complex_search`（JsonLogic） |
| 最近書いたノート | `obsidian_get_recent_changes` |
| 日次/週次ノート | `obsidian_get_periodic_note` / `obsidian_get_recent_periodic_notes` |

検索結果のファイル名から種別を即座に判定：
- `Input/` → ソース文献
- `Output/<Inputbase>-...md` → LITERATUREノート
- `Output/<その他>.md` → PERMANENTノート
- `Output/DailyNotes/` `Output/WeeklyNotes/` → 期間ノート

## よくある落とし穴

- **LITERATUREノートの先頭リンク忘れ**：本文最初の `[[Input/...]]` が無いとZettelkastenの相互参照網が機能しない。これだけは絶対に書く。
- **PERMANENTノートのtitleとファイル名の不一致**：両者は一致させる（実例で一致している）。
- **`aliases` の表記揺れ**：`aliases: []`（空配列）と `aliases:`（null）の両方が実例にある。新規は `aliases: []` を推奨。
- **Inputの`source`の意味が媒体ごとに違う**：論文ではジャーナル名、書籍では出版社、記事ではサイト名・URL。`media:` でどの種類か分かるが、書くときに意味が違う点に注意。
- **tagsの記法をInputとOutputで混同しない**：Inputはリスト記法、Outputはインライン記法。Templaterが生成したファイルのパターンを崩さない。

## 作成前の最終チェック

書き込む前に心の中で読み返す：

- [ ] ディレクトリは正しいか（Input/ vs Output/、サブディレクトリ）
- [ ] ファイル名規則に従っているか（特にLITERATUREの `<InputBase>-<title>.md`）
- [ ] frontmatterのキーは網羅されているか
- [ ] IDとcreatedは現在時刻（JST）から生成したか
- [ ] tagsの順序は「日付 → 種別大文字 → 内容」か
- [ ] LITERATUREの本文先頭にInputリンクがあるか
- [ ] tags記法（インライン vs リスト）が種別の慣例に合っているか

このチェックを通ったうえで書き込む。
