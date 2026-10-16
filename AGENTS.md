# AGENTS.md — pi-reminder

読者: pi-reminder を変更するエージェントと開発者。利用者向けの仕様は README、設計判断は DESIGN.md。
共通の検証と規則はルートの `AGENTS.md` にある。

## 壊してはいけない制約

- モデル向けのツールを登録しない（注入専用）。コマンドは `/reminder` の1つだけ。イベントは `session_start` / `before_agent_start` / `message_end` / `context` / `turn_end` の5種で各1ハンドラ（`test/contract/surface.test.ts`）。
- 文字数は assistant の出力だけを数える。対象は text と toolCall の引数、`countThinking` が true なら thinking。ツール結果とユーザー入力は数えない（`test/integration/extension.test.ts`）。
- transient は閾値超過後の次の `context` に1回だけ末尾追加し、その後は予算をリセットする。注入直後の assistant 1件はカウントしない。新しいユーザーターンで予算はリセットされる（`test/integration/extension.test.ts`）。
- persistent は `turn_end` で `custom_message`（`customType: "reminder"`）を追加し、`continue: true` を返す。abort・error のターンでは注入しない。`prompt` が空のときは注入も保留もしない（予算は数える）（`test/integration/extension.test.ts`）。
- 設定はグローバル → プロジェクトの順にマージし、project が優先する。未信頼プロジェクトの設定は無視する。壊れた設定は警告して既定値で動き、セッションを止めない（`test/unit/config.test.ts`）。
- `/reminder` のアクションは `status` / `now` / `reset` / `on` / `off` / `reload` だけ。未知のアクションは usage を警告する（`test/integration/extension.test.ts`）。
- ステータスは `🔔 <used>/<budget>`。注入待ちは `→` を付け、無効時は `🔔 off`（`test/integration/extension.test.ts`）。
- 実行時依存を持たない（`dependencies` は空）。配布は `files` の範囲内（`test/contract/dependencies.test.ts`、`test/ci/package-contents.test.ts`）。

## 変更手順

- イベントやコマンドを増減するときは、`test/contract/surface.test.ts` の `EXPECTED_EVENTS` とコマンド期待値を先に更新する。1つ落とすと機能が静かに消える。
- カウントや注入の意味を変えるときは、`test/integration/extension.test.ts` を先に更新し、セマンティクスを固定してから実装する。
- 依存を追加するときは devDependency だけ。`ALLOWED_DEV_DEPENDENCIES` を更新し、コミットメッセージに理由を書く。
- 手動で確認する項目は [docs/manual-checks.md](docs/manual-checks.md) に書く。
- 決定の記録は [docs/adr/](docs/adr/) にある。
