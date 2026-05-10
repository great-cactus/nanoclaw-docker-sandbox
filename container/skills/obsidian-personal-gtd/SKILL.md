---
name: obsidian-personal-gtd
description: AkiraのObsidian vaultのGTD領域（Getting Things Done）でタスクとプロジェクトを作成・編集・整理する際の規則を提供する。トリガー：「タスク追加」「GTD」「inbox」「次に取るべき行動」「いつかやる」「買うもの」「buyリスト」「プロジェクト」「締切」「scheduled」「やること」「TODO」「片付ける」「Dashboard」「タスク一覧」など、GTDの捕捉・明確化・整理・実行・レビューに関わるあらゆるリクエスト。task kind / task status の限定値、Inbox運用、Dashboard連携の仕組みに関わる場合は必ずこのスキルを参照すること。
---

# AkiraのObsidian GTD ガイド

## GTD領域の構造

```
GTD/
├── Projects/     プロジェクトノート（複数タスクの束ね）
├── Tasks/        個別タスク
└── Trash/        削除候補（実体は残す）
```

集計と表示はvault root の `Dashboard.md` と `Templates/GTD-Inbox.md`（Bases）に集約されている。これら2ファイルがTasks/Projects配下の frontmatter を読むので、frontmatterのキー名と値は厳格に保つ必要がある。

## タスクの作成

ファイル：`GTD/Tasks/<タスクタイトル>.md`

```yaml
---
ID: 20260403110101
created: 2026-04-03 11:00
title: "<タスクタイトル>"
aliases:
deadline:
scheduled date:
project: <プロジェクト名（自由テキスト）>
task kind: <次に取るべき行動 | いつかやる | 買うもの | ごみ箱>
task status: <not_yet | in_progress | done>
---
```

- `ID`：`YYYYMMDDhhmm`（12桁、JSTローカル時刻）
- `created`：`YYYY-MM-DD HH:mm`
- `title`：ファイル名と一致させる（**ダブルクォートで囲む**のが慣例）
- `deadline`, `scheduled date`：`YYYY-MM-DD` 形式、空欄可
- `project`：自由テキスト。慣例として `GTD/Projects/` 配下の同名ファイルと揃えるとプロジェクト単位の集約が効く

## 限定値の厳守

`task kind` と `task status` は **Metadata MenuのSelect型** で定義された限定値しか受け付けない。これ以外の値を書くとダッシュボードのDataviewクエリで拾われない。

### `task kind`（4種＋空欄）

| 値 | 意味 |
|---|---|
| `次に取るべき行動` | 即実行可能、明確化済み |
| `いつかやる` | 期限はないが残しておくアイデア |
| `買うもの` | 購入が必要なアイテム（買い物リスト用） |
| `ごみ箱` | 不要になった（削除しないが集計から除外） |
| （空欄） | **Inbox扱い**：まだ明確化されていない捕捉物 |

### `task status`（3種）

| 値 | 意味 |
|---|---|
| `not_yet` | 未着手（新規タスクのデフォルト） |
| `in_progress` | 着手中 |
| `done` | 完了 |

## Inbox運用

GTDの「捕捉→明確化→整理」フェーズに対応：

1. **捕捉**：思いついたらまず `GTD/Tasks/` にタスクを作る。`task kind` は**空欄のまま**でよい
2. **明確化**：後でレビューしたとき、空欄の `task kind` を上記4種のどれかに振り分ける
3. **整理**：明確化された後は、`scheduled date`, `deadline`, `project` を必要に応じて埋める

`Templates/GTD-Inbox.md` のBases定義は、`task kind` が空のものを「Inbox」ビュー、それ以外を種別ごとのビューに振り分ける。**捕捉直後の空欄は意図的なシグナル**なので、ユーザが「task kindを空のままにして」と言わない限り、Claudeが勝手に埋めない方が望ましい場合がある — 文脈で判断する：
- 「タスクを思いついたから記録して」→ task kind 空欄でよい（Inbox入り）
- 「明日やるべきこととしてXを追加して」→ `次に取るべき行動` + `scheduled date: 明日の日付`

## プロジェクトノート

ファイル：`GTD/Projects/<プロジェクト名>.md`

**タスクと同じfrontmatterスキーマ**を使う（同じMetadata Menu定義の下にあるため）：

```yaml
---
ID: 202604031100
created: 2026-04-03 11:00
title: "<プロジェクト名>"
aliases:
deadline:
scheduled date:
project:
task kind:
task status: not_yet
---

- [[配下のタスク1]]
- [[配下のタスク2]]
- [[配下のタスク3]]
```

本文に関連タスクへのObsidianリンクを列挙するのが慣例。プロジェクトの `project:` フィールドは通常空で、配下のタスクの `project:` にこのプロジェクト名（タイトル）が入る。

旧式のUUID形式のIDを持つプロジェクトもある（例：`"a5844a5e-1901-4a89-a11b-f38e3db4e444"`）が、新規作成時は新しい形式（`YYYYMMDDhhmm`）でよい。

## Dashboard.md との連携

vault root の `Dashboard.md` に以下のDataviewJSビューがあり、Tasks配下の frontmatter を読み取っている：

| ビュー | フィルタ条件 |
|---|---|
| 今日のタスク | `scheduled date` が今日、`task status != done` |
| 締切一週間前 | `deadline` が7日以内、`task status != done` |
| 締切一ヶ月前 | `deadline` が30日以内、`task status != done`、`task kind != ごみ箱` |
| 買うもの | `task kind == 買うもの`、`task status != done` |

このため：
- タスクを「今日やる」リストに出すには `scheduled date: <今日の日付>`
- 締切リマインダーに出すには `deadline: <該当日>`
- 買い物リストに出すには `task kind: 買うもの`
- 完了したタスクは `task status: done` に変える（削除しない）

## 検索と一覧パターン

| 求められるもの | 推奨される操作 |
|---|---|
| 「今日のタスクは？」 | Dashboard.md を開いてビューを見る、または `obsidian_get_file_contents` でDashboard.mdを取得 |
| 「○○プロジェクトに紐づくタスク一覧」 | `GTD/Projects/<name>.md` を読む（本文のリンクを取得） |
| Inboxに何が溜まっているか | `obsidian_complex_search` で `task kind == null` のものを抽出、または `obsidian_list_files_in_dir` で `GTD/Tasks/` を舐めて frontmatter を読む |
| 完了済みタスク | `task status == done` でフィルタ |

## ファイル操作の注意

- **タスクの削除**：原則 `task kind: ごみ箱` または `task status: done` に変更で対応。`obsidian_delete_file` は使わない（履歴が消える）
- **タスク名の変更**：ファイル名と `title:` 両方を一致させる。Obsidianのバックリンクは更新されるが、本文中のWikiLink表記によっては手動修正が必要

## 作成ワークフロー

タスクを新しく作る指示を受けたら：

1. **タイトルを確定**：ユーザの言い回しから簡潔な名詞句にする
2. **task kind を決める**：
   - 「思いついた」「メモ」「Inboxに」→ 空欄
   - 「明日やる」「次にやる」→ `次に取るべき行動`
   - 「いつかやりたい」→ `いつかやる`
   - 「買う」→ `買うもの`
3. **日付情報を抽出**：「明日まで」「来週」などの言い回しから `deadline` または `scheduled date` を埋める
4. **project を決める**：既存のProjectsに該当があれば紐づけ、なければ空欄
5. **`obsidian_append_content` で新規作成**：`GTD/Tasks/<title>.md`

## 作成前の最終チェック

- [ ] ファイル名は `GTD/Tasks/` または `GTD/Projects/` 配下か
- [ ] `task kind` は限定値（または空欄）か
- [ ] `task status` は限定値（新規なら `not_yet`）か
- [ ] `deadline` / `scheduled date` の日付フォーマットは `YYYY-MM-DD` か
- [ ] `title` はファイル名と一致しているか、ダブルクォートで囲んだか
- [ ] IDとcreatedは現在時刻（JST）から生成したか
