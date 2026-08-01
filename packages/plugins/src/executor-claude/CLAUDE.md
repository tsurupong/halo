# product/packages/plugins/src/executor-claude/

executor ポート実装。Claude Code(headless)を起動してタスクを実行させる中核プラグイン。settings deny 注入(ADR-0019)、allowedTools + dontAsk 既定(ADR-0020)、max_budget_usd 上限(ADR-0021)、egress 禁止(ADR-0026)に関わる。
