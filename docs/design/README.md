# HALO Detailed Design Documents

Source: [HALO Requirements Specification v1.8](../../../docs/HALO要件定義書.md) (2026-07-09). For the background of design decisions, see the [ADR index](../adr/README.md).
The document system follows [HALO Design Document Index](../../../docs/HALO設計書一覧.md) (D1-D9).

> Note: 01-06 contain content as of v1.5 (e.g., the bash-core premise). Where they contradict the core TypeScript migration and the abolition of specs/ confirmed in v1.8, the individual design documents of the D system (d1-, d4-, ...) are authoritative.

| # | Section | Corresponding requirements | Related ADR |
|---|---|---|---|
| 01 | [Core loop and ports](01-core-loop-and-ports.md) — JSON contract of the 9 ports, helpers.sh specification, fail re-injection sequence, conf.d activation rules | §3-4.3 | 0001, 0006 |
| 02 | [executor / worktree / runtime](02-executor-worktree-runtime.md) — claude -p execution specification, disposable worktree state transitions, .harness.yml schema, runtime 4-type difference table | §4.2③⑦⑧ | 0002, 0007 |
| 03 | [gate / sink / on-fail](03-gate-sink-onfail.md) — loop-audit 6-item inspection, evaluator skepticism policy, per-autonomy sink correspondence table, failure-learning loop | §4.2④⑤⑥, §7, §11 | 0004, 0006 |
| 04 | [Launch layer (trigger / profile / preflight)](04-trigger-profiles-preflight.md) — schedule/polling triggers, environment variables of the 3 profiles, 2-stage preflight, daily budget computation | §4.4 | 0008, 0006 |
| 05 | [Context layer (graph foundation)](05-context-layer-graphs.md) — CGC+KuzuDB re-indexing, knowledge-graph Cypher DDL, knowledge MCP tool specification, Agentic Graph RAG | §5, §11.1 | 0003, 0005 |
| D1 | [Contract Specification](d1-contract-spec.md) — 9-port I/O types, plugin.json, exit code rules, kg:// URI, STUCK marker, JSON Schema validation (v1.8-compliant, most-conservative change management) | §3-4, §11.1 | 0001, 0009-0011 |
| D2 | [Core Detailed Design](d2-core-design.md) — 9-module split, loop state machine, runPort, 2-stage preflight, budget per-call measurement, discovery, worktree lifecycle | §3-4, §8 | 0002, 0009, 0010 |
| D3 | [CLI Specification](d3-cli-spec.md) — 6-command system, flag override rules, project init artifacts, doctor inspection, exit code rules, core delegation map | §4.4, §8.2 | 0010 |
| D4 | [Security Design (skeleton)](d4-security-design.md) — bubblewrap, standard deny set, fine-grained PAT, loop-audit 7 inspections, graph-write control, injection countermeasures, MCP permissions (v1.8-compliant) | §6, §7, §11.1 | 0004, 0011 |
| D5 | [Plugin Development Guide](d5-plugin-dev-guide.md) — minimal plugin (TS/bash), per-port implementation points, explanation of the 4 sample types, contract test, placement method | §4, §8 | 0001 |
| D6 | [Graph Design](d6-graph-design.md) ◆private — KuzuDB DDL, kg:// resolution, CGC re-indexing, staleness detection → automatic issue creation, glossary check, MCP tools, requirement-ingestion procedure | §5 | 0003, 0005, 0011 |
| D7 | [Operations Runbook (skeleton)](d7-ops-runbook.md) — autonomy promotion/demotion, needs-human flow, failure-catalog/sign promotion, budget monitoring, troubleshooting (measured values filled in after Phase 1-2) | §7, §9 | 0006, 0012 |
| D8 | [Test Strategy](d8-test-strategy.md) — core unit (vitest), loop regression (executor mock), contract test, E2E, CI configuration | §9 | 0010 |
| D9 | [Reliability Design](d9-reliability-design.md) — watchdog supervisor, status aggregation, transient-failure requeue/quarantine | §3.2, §8.2 | 0013, 0014 |
| D10 | [Portability Design](d10-portability-design.md) — POSIX target, fire fixes, scheduler backend abstraction (schtasks/systemd/cron/launchd), doctor env checks, CI matrix | §6.1, §11.2 | 0008, 0015 |
| 06 | [Security / cost control / observability](06-security-cost-observability.md) — bubblewrap specification, list of blocked operations, PAT scope, cost parameter table, iter_N.json schema | §6, §10 | 0004, 0008 |
