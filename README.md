# pi-reminder

LLM が reasoning → tool call → reasoning… と長いループを回る間に、一定量の出力（既定 20,000 文字）ごとにコンフィグで指定したプロンプトを注入する Pi 拡張です。「N 文字ごとにチェックリストを投げて自己確認させる」用途を想定しています。

```
ユーザー: このバグを直して
  assistant: (thinking 4,000 文字) → read ツール
  assistant: (thinking 3,000 文字) → grep ツール
  assistant: (text 15,000 文字) → edit ツール
  ★ ここで 20,000 文字を超えたので、次のリクエストにリマインダーを注入
  assistant: 「リマインダーを見て、チェックリストを確認しながら続行します…」
```

## インストール

```bash
pi install git:github.com/kurowashi/pi-reminder
```

ref を固定する場合は `pi install git:github.com/kurowashi/pi-reminder@<tag|commit>`。

ローカルの作業コピーを使う場合:

```bash
pi install /path/to/pi-reminder
```

または直接読み込み:

```bash
pi --extension /path/to/pi-reminder/src/index.ts
```

## 設定

設定ファイル（後のものが優先）:

| ファイル | 対象 |
|---|---|
| `~/.pi/agent/reminder.json`（`PI_CODING_AGENT_DIR` で変更可） | ユーザー全体 |
| `<cwd>/.pi/reminder.json` | プロジェクト（信頼されたプロジェクトのみ） |

```json
{
  "enabled": true,
  "everyChars": 20000,
  "countThinking": true,
  "mode": "transient",
  "display": false,
  "prompt": "作業を止めて、次を確認してください:\n- [ ] ユーザーの要求をすべて満たしたか\n- [ ] 変更をテストしたか\n- [ ] 指示されていない変更をしていないか\n- [ ] 残タスクと次の一手を 1 行で述べよ"
}
```

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | `true` | 無効にするとカウントも注入もしない |
| `everyChars` | `20000` | 注入までの assistant 出力文字数 |
| `countThinking` | `true` | thinking ブロックも文字数に数える |
| `mode` | `"transient"` | `"transient"` または `"persistent"`（後述） |
| `display` | `false` | `persistent` のとき、注入メッセージを画面に表示する |
| `prompt` | `""` | 注入する本文。空だと何も注入しない |

## 動作

- 文字数は **assistant メッセージの出力**を数えます:
  - `text` ブロック（本文）
  - `toolCall` の引数 JSON（テキストなしでツールだけ呼ぶメッセージも 0 文字にならないように）
  - `thinking` ブロック（`countThinking` が true のときだけ）
- ツール結果やユーザー入力は数えません（それは入力であって出力ではありません）。
- 予算を使い切ると「注入待ち」になり、**次のモデルリクエストに `prompt` を差し込んで**予算をリセットします。
- **新しいユーザーターンで予算はリセット**されます（1 ターン = 1 予算）。
- **注入直後の assistant メッセージ 1 件はカウントしません。** リマインダーへの「了解しました」という反応が次の予算を消費して、無限に再注入されるのを防ぐためです。
- 注入は末尾に追加するだけなのでプロバイダのプロンプトキャッシュを壊しません。

### `mode`

| | `transient`（既定） | `persistent` |
|---|---|---|
| 注入先 | 次のリクエストのコンテキストのみ | セッションにメッセージとして保存 |
| 追加リクエスト | なし（次の自然なリクエストに乗る） | ターン終了時に 1 回 continuation を強制 |
| 履歴に残るか | 残らない | 残る |
| 向いている用途 | 「その場で思い出してほしい」軽いリマインダー | 「必ず反応させたい／後のターンでも見せたい」チェックリスト |

`persistent` は `turn_end` で `custom_message` を追加して `continue: true` を返すため、モデルが答えを出して終わろうとしたタイミングでも必ず 1 回リアクションします（abort / error のターンでは注入を保留し、反応スキップ + 予算リセットでループは自然に止まります）。

> `persistent` は「必ず反応させる」代わりに、モデルがリマインダーに答えてそのまま終了する可能性があります。プロンプトに「確認したら**そのまま作業を続ける**」旨を書いておくと安全です。

## コマンド

| コマンド | 動作 |
|---|---|
| `/reminder` | 現在の設定と進捗を表示 |
| `/reminder now` | 次のリクエストで即注入（テスト用） |
| `/reminder reset` | カウンタをリセット |
| `/reminder on` / `off` | 一時的に有効／無効 |
| `/reminder reload` | 設定ファイルを読み直す |

フッターには `🔔 8.3k/20k`（注入待ちのときは `→` 付き）を表示します。

## 実装メモ

- 注入は Pi の `context` イベント（次リクエストのメッセージ列に追加）または `turn_end` の boundary entry（`custom_message` + `continue`）で行います。ツール結果を書き換えないので、ツール出力の意味が変わりません。
- 文字数は `message_end`（確定した assistant メッセージ）で数えます。
- 設定が壊れていても警告を出して既定値で動きます。

## 開発

```bash
npm install          # 依存(すべて devDependency。実行時依存はゼロ)
npm run verify       # 完了条件: biome + tsc + 全テスト + カバレッジ閾値
npm test             # 全テスト
```

`npm run verify` の内訳は `package.json` にある。
契約テストは `test/contract/`(登録ツールなし・依存 allowlist・import 境界)と `test/ci/`(npm pack の内容)にあり、`src` を Pi のローダー経由で読み込んで検証する。
カバレッジ閾値は `test/unit/` と `test/integration/` の実行で計測する。

ローカルの git フックは [lefthook](lefthook.yml) が管理する。フックは利便性のためのもので、
完了条件は常に `npm run verify` が通ること(CI も同じコマンドを Node 22.19 / 24 で実行する)。
フックの有効化は `npx lefthook install` を手動で実行する(`package.json` の lifecycle script には置かない:
`pi install git:...` は `npm install --omit=dev` を実行するため、
devDependency の lefthook が無い状態で script が走るとインストールごと失敗する)。
