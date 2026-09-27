# AGENTS.md — pi-reminder で作業するエージェント向けの指示

読者は pi-reminder を変更する AI エージェントと開発者です。利用者向けの仕様は README に、
設計の判断基準は DESIGN.md と PHILOSOPHY.md(このプラグイン群共通)に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、
下の表はその索引です。実装と表が食い違った場合はテストが正です。検証手段を併記できないものは
制約として書かず、自動テストできない範囲は末尾に分けます。

## 完了条件

`npm run verify`(= `npm run check` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。CI は同じ `verify` を Node 22.19 / 24 で実行します。
カバレッジは `test/unit` と `test/integration` で計測します。下の表の「検証」列は個別の検証箇所で
あり、自動検証はすべて `verify` に含まれます。

## 制約

### フック面

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| モデル向けのツールを登録しない(注入専用) | `test/contract/surface.test.ts` | `src/index.ts` |
| コマンドは `/reminder` の1つだけ | `test/contract/surface.test.ts` | `test/contract/surface.test.ts` のコマンド期待値 |
| イベントは `session_start` / `before_agent_start` / `message_end` / `context` / `turn_end` の5種で、各1ハンドラ | `test/contract/surface.test.ts` | `test/contract/surface.test.ts` の `EXPECTED_EVENTS`、`src/index.ts` |

### カウントと注入

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 文字数は assistant 出力だけを数える。対象は text と toolCall の引数、`countThinking` が true なら thinking | `test/unit/config.test.ts` + `test/integration/extension.test.ts` | `src/index.ts` の `assistantOutputChars` |
| ツール結果とユーザー入力は数えない | `test/unit/config.test.ts` + `test/integration/extension.test.ts` | `src/index.ts` の `assistantOutputChars` |
| transient は閾値超過後の次の `context` に1回だけ末尾追加し、その後は予算をリセットする | `test/integration/extension.test.ts` | `src/index.ts` の `consumeBudget` と `context` ハンドラ |
| 注入直後の assistant 1件はカウントしない | `test/integration/extension.test.ts` | `src/index.ts` の `skipNextAssistant` |
| 新しいユーザーターンで予算はリセットされる | `test/integration/extension.test.ts` | `src/index.ts` の `before_agent_start` ハンドラ |
| persistent は `turn_end` で `custom_message`(`customType: "reminder"`)を追加して `continue: true` を返す | `test/integration/extension.test.ts` | `src/index.ts` の `turn_end` ハンドラ |
| abort / error のターンでは persistent の注入をしない | `test/integration/extension.test.ts` | `src/index.ts` の `turn_end` ハンドラ |

### 設定

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 設定はグローバル→プロジェクトの順にマージし、project が優先される | `test/unit/config.test.ts` | `src/config.ts` の `loadConfig` |
| 未信頼プロジェクトの設定は無視する | `test/unit/config.test.ts` | `src/config.ts` の `loadConfig` |
| 壊れた設定は警告して既定値で動き、セッションを止めない | `test/unit/config.test.ts` | `src/config.ts` の `resolveConfig` |

### 表示・コマンド

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| ステータスは `🔔 <used>/<budget>`(注入待ちは `→` 付き、無効時は `🔔 off`) | `test/integration/extension.test.ts` | `src/index.ts` の `updateStatus` |
| `/reminder` のアクションは `status` / `now` / `reset` / `on` / `off` / `reload` のみ | `test/integration/extension.test.ts` | `src/index.ts` の `applyAction` |
| 未知のアクションは usage を警告する | `test/integration/extension.test.ts` | `src/index.ts` の `applyAction` |

### 依存関係・import

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 実行時依存を持たない(`dependencies` は空) | `test/contract/dependencies.test.ts` | `package.json` |
| `src` の import は node builtin・相対 `.ts`・Pi 提供パッケージのみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_PEER_DEPENDENCIES` |
| devDependency は allowlist 内のみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_DEV_DEPENDENCIES` |

### 配布・ビルド

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 配布物は `files` の whitelist 内のみ | `test/ci/package-contents.test.ts` | `package.json` の `files` |
| `pi.extensions` のエントリが配布物に含まれる | `test/ci/package-contents.test.ts` | `package.json` の `pi.extensions` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/package-contents.test.ts` | `package.json`(`build` script なし、`pi.extensions` が `./src/index.ts`) |

### コード品質

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` の `suspicious` / `nursery` |
| `console` を使わない | `npx biome check .` | `biome.jsonc` |
| 認知複雑度は 12 以下 | `npx biome check .` | `biome.jsonc` の `noExcessiveCognitiveComplexity` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` + Node 実行 | `tsconfig.json` |

## 変更時の手順

- イベントやコマンドを増減する場合は `test/contract/surface.test.ts` の `EXPECTED_EVENTS` と
  コマンド期待値を先に更新する。1つ落とすと機能が静かに消えるため、契約が変更の入口になる。
- カウントや注入の意味を変える場合は `test/integration/extension.test.ts` を先に更新し、
  セマンティクスを固定してから実装する。
- 依存を追加する場合は devDependency のみ可能。`ALLOWED_DEV_DEPENDENCIES` の更新と
  コミットメッセージの理由をセットで行う。実行時依存(`dependencies`)の追加は不可。
- 決定の記録は `docs/adr/` に置く(1決定 = 1ファイル、`NNNN-<topic>.md`)。追加するのは、却下した
  代替を再提案されうる決定、機能や振る舞いを削除・置き換える決定、DESIGN.md / PHILOSOPHY.md に
  触れる決定のときだけ。却下案は結果ではなく理由を書く。
- ツール・コマンド・設定・公開の振る舞いを変える前に `docs/adr/` を読み、却下済みの代替を
  再提案しない。決定が変わったら同じコミットで状態を更新する(採用 → 廃止)。
- カバレッジの数値は契約テストの影響を受けます。契約テストは jiti 経由で `src` をもう一度
  ロードするため、同じファイルが2実体として数えられます。

## 手動確認項目(自動検証の対象外)

前提: TUI と実モデルのセッションで確認します。

1. TUI でフッターの `🔔` 表示が更新され、`/reminder` の各アクション(特に `now` / `reload`)が
   動くこと。
2. 実モデルで長いターンを回し、閾値超過後の次のリクエストでモデルがリマインダーに反応すること。
   transient は履歴に残らず、persistent は履歴に残って継続が強制されること。
3. persistent で abort / error になったターンの後も pending が残り、次の completed ターンで
   注入されること。
4. 設定ファイルを編集して `/reminder reload` すると新しい値が反映されること。
5. 壊れた JSON や不正値の設定ファイルでもセッションが止まらず、警告が出て既定値で動くこと。
