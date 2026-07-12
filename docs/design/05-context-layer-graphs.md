# Detailed Design Document 05: Context Layer (Graph Foundation)

> **Revised to follow up on v1.8 (reflecting the core TS migration and the removal of specs/)**. The `run.sh` that drives preflight/reindexing refers to the launch entry point of `packages/cli` (`halo run`). v1.8 manages requirements and specifications **centrally in the knowledge graph rather than in a specs/ directory**, and freezability is guaranteed by graph write control (read-only during execution / two write paths / hash verification, D4 §5). The graph foundation described in this document is its core.

**Scope**: HALO context layer (the `context` port and the graph foundation)
**Basis**: HALO Requirements Definition v1.8 §5, §11.1, [ADR-0003](../adr/0003-kuzudb-merge-driven-reindex.md), [ADR-0005](../adr/0005-knowledge-graph-schema-granularity.md), ADR-0010 (core TypeScript migration)
**Positioning**: This document elaborates §5 of the Requirements Definition down to the implementation level, and contains nothing that contradicts the Requirements Definition. Where numbers or details are undefined in the requirements, they are explicitly marked as "initial value (tentative)".

---

## 0. Scope and Overview

The context layer holds two kinds of graphs (code graph / knowledge graph), both backed by KuzuDB (embedded, single file, no server required). The two graphs are stored separately in two files, `graphs/code.kuzu` and `graphs/knowledge.kuzu`.

```
┌─────────────────────────── Context layer ───────────────────────────┐
│                                                                      │
│  graphs/code.kuzu           graphs/knowledge.kuzu                    │
│  ├ tree-sitter auto-gen      ├ human-designed, hand-written Cypher    │
│  └ MCP via CGC: codegraph    └ custom MCP: knowledge                  │
│         │                            │                               │
│         │  bridged logically via IMPLEMENTED_BY (aggregate→dir path) │
│         ▼                            ▼                               │
│  ┌──────────────────── context.d plugins ────────────────────────┐   │
│  │ 10-codegraph / 20-knowledge / 30-recent-failures             │   │
│  │  → concat fragments by priority, truncate at token limit      │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

Separation of responsibilities (ADR-0005):
- **Code graph** = automatically generated domain. Structural information at entity/field granularity.
- **Knowledge graph** = human-designed domain. Tacit knowledge such as design intent, ubiquitous language, and decisions.
- The two are connected only via `IMPLEMENTED_BY` (aggregate node → directory path), avoiding duplicate management at the field level.

---

## 1. Code Graph (CodeGraphContext + KuzuDB)

### 1.1 Composition

| Item | Content |
|---|---|
| Tool | CodeGraphContext (CGC) |
| Backend | KuzuDB (`graphs/code.kuzu`) |
| Generation method | Static analysis via tree-sitter. **No LLM API used, fully local** (zero cost, works offline) |
| Provided tools | `find_code` / `analyze_code_relationships` / `find_dead_code` / `execute_cypher_query` |
| MCP definition | `ports/mcp.d/10-codegraph.json` |

Reason for using tree-sitter: purely syntactic analysis can extract call relationships, definition locations, and dead code, and because it involves no LLM inference it is deterministic and free. In contrast to the knowledge graph side (human-designed), the code graph deals only with "things a machine can read as fact".

### 1.2 Reindexing Timing (Merge-Driven + Preflight = Option A)

Following the decision in ADR-0003, the `watch` mode is not adopted (its watch target would not be main but ephemeral worktrees that come and go, contaminating the graph with intermediate states, so it is structurally incompatible with the disposable-worktree approach).

The reindexing trigger point is **only the single preflight at loop startup**.

```
run.sh launch
  └─ preflight (stage 1 of 2: graph freshness decision)
       IF  current HEAD of main != last_indexed_sha recorded in graphs/code.kuzu
       THEN run reindex (based on main, single process, the only write happens here)
            → update last_indexed_sha to main HEAD
       ELSE skip (not stale)
  └─ start the loop body (graph is immutable thereafter)
```

Metadata used for the decision:

| Key | Content | Storage location |
|---|---|---|
| `last_indexed_sha` | The commit SHA of main from the previous index | Meta node inside code.kuzu, or `graphs/.code.meta` |
| `indexed_at` | Timestamp of the previous index (ISO8601) | Same as above |
| `schema_version` | Code graph schema version (tree-sitter extraction rule version) | Same as above |

Reindexing defaults to **a full index based on main**, not a differential one (under KuzuDB's single-process write constraint, state consistency is the top priority. Differential indexing is a deferred optimization candidate for Phase 2 and beyond).

### 1.3 Exclusion Method (Read-Only Snapshot Sharing)

KuzuDB assumes writes from a single process. Simultaneous writes from parallel worktrees are structurally prohibited.

**Method**: share a "read-only snapshot based on the main branch" across all worktrees.

| Phase | Actor | Access to code.kuzu | Exclusion mechanism |
|---|---|---|---|
| Preflight | run.sh (single parent process) | Read/write (reindex) | `flock` (the same lock that `run.sh` ships with by default; shared with the multiple-launch prevention) |
| During loop execution | The agent in each worktree | **read-only** only | Has no write path (MCP exposes only reference-type tools) |

Key points:
1. Writes occur only once, during preflight. Because `flock` excludes multiple launches of run.sh, there is at most one writing process at a time.
2. During loop execution, all worktrees share the same immutable snapshot read-only. This also guarantees **context reproducibility across iterations** (same input → same graph → same context).
3. The substance of read-only sharing is opening KuzuDB in read-only mode. File copies are unnecessary (given the immutability assumption). MCP tools that attempt writes are not included in `10-codegraph.json`.

### 1.4 Staleness Mitigation (Bidirectional Automatic Reflection)

Between a merge and the next preflight, the graph becomes stale (ADR-0003 Negative). This is mitigated as follows.

| Origin | Reflection path |
|---|---|
| docs merge | The sink `35-reindex-knowledge.sh` updates the knowledge graph |
| code change | Staleness is detected at the next preflight → a `kind:docs` task is automatically filed (detecting divergence between design docs and implementation) |

---

## 2. Knowledge Graph (Schema Definition)

### 2.1 Schema Granularity (Finalized = ADR-0005 / §11.1)

Start with **5 node types** and **5 edge types**, without descending to the entity/field level. The bridging edge `IMPLEMENTED_BY` is drawn as aggregate → directory path.

**5 node types**: Bounded Context / Aggregate / Domain Term / Document / Decision
**5 edge types**: `BELONGS_TO` / `DEFINED_IN` / `IMPLEMENTED_BY` / `SUPERSEDES` / `AFFECTS`

### 2.2 Cypher DDL-Equivalent Schema Definition (KuzuDB)

Because KuzuDB requires a structured schema, nodes are defined as `NODE TABLE` and edges as `REL TABLE` (a typed property-graph schema). The following is the initial DDL for `graphs/knowledge.kuzu`. It is loaded via hand-written Cypher (KuzuDB DDL).

```cypher
-- ============ Node tables (5 kinds) ============

-- (1) Bounded Context
CREATE NODE TABLE BoundedContext (
    id        STRING,        -- unique identifier (e.g. "billing")
    name      STRING,        -- display name (e.g. "Billing Context")
    summary   STRING,        -- summary
    PRIMARY KEY (id)
);

-- (2) Aggregate: the origin of the bridge. dir_path is the link to the implementation
CREATE NODE TABLE Aggregate (
    id        STRING,
    name      STRING,        -- aggregate name (e.g. "Invoice")
    dir_path  STRING,        -- implementation directory path (basis for IMPLEMENTED_BY)
    summary   STRING,
    PRIMARY KEY (id)
);

-- (3) Domain term (ubiquitous language)
CREATE NODE TABLE DomainTerm (
    id          STRING,
    term        STRING,      -- term (canonical)
    definition  STRING,      -- definition
    synonyms    STRING,      -- allowed synonyms (comma-separated; for glossary consistency check)
    deprecated  STRING,      -- forbidden terms (comma-separated; a forbidden-term violation is a block)
    PRIMARY KEY (id)
);

-- (4) Document (design doc / ADR / requirement)
CREATE NODE TABLE Document (
    id        STRING,
    title     STRING,
    path      STRING,        -- repo-relative path (e.g. "docs/design/05-...md")
    doc_type  STRING,        -- "design" | "adr" | "requirement" | "glossary"
    body_hash STRING,        -- source hash at ingestion time (for staleness detection / freeze verification)
    PRIMARY KEY (id)
);

-- (5) Decision (Decision / the ADR decision unit)
CREATE NODE TABLE Decision (
    id        STRING,        -- e.g. "adr-0005"
    title     STRING,
    status    STRING,        -- "accepted" | "superseded" | "proposed"
    date      STRING,        -- ISO8601
    PRIMARY KEY (id)
);

-- ============ Edge tables (5 kinds) ============

-- BELONGS_TO: aggregate → bounded context (belonging)
CREATE REL TABLE BELONGS_TO (
    FROM Aggregate TO BoundedContext
);

-- DEFINED_IN: domain term/decision → document (which document defined it)
CREATE REL TABLE DEFINED_IN (
    FROM DomainTerm TO Document,
    FROM Decision   TO Document
);

-- IMPLEMENTED_BY: aggregate → directory path (the bridge; design ⇔ implementation)
--   The counterpart is the code side pointed to by Aggregate.dir_path. Inside the
--   knowledge graph, avoid a self-reference and carry the confidence meta as properties.
CREATE REL TABLE IMPLEMENTED_BY (
    FROM Aggregate TO Aggregate,   -- held on the aggregate side for resilience to logical re-wiring
    dir_path   STRING,             -- implementation directory (redundantly held = faster search)
    confidence STRING,             -- "explicit" | "inferred" | "reviewed"
    source     STRING              -- extraction basis ("link" | "ai" | "human")
);

-- SUPERSEDES: decision → decision (a new decision supersedes an old one)
CREATE REL TABLE SUPERSEDES (
    FROM Decision TO Decision
);

-- AFFECTS: decision → bounded context/aggregate/document (impact scope)
CREATE REL TABLE AFFECTS (
    FROM Decision TO BoundedContext,
    FROM Decision TO Aggregate,
    FROM Decision TO Document
);
```

> Note: KuzuDB allows declaring multiple `FROM ... TO ...` pairs in a single `REL TABLE` (multi-pair relationship). `DEFINED_IN` / `AFFECTS` use this to allow multiple source/target types in one table. The counterpart of `IMPLEMENTED_BY` is originally a code-side node, but because the code graph lives in a separate DB (`code.kuzu`), a physical edge crossing DBs cannot be drawn. Therefore the bridge is a **logical join keyed on the `Aggregate.dir_path` string**, and the `IMPLEMENTED_BY` edge itself is held with the aggregate as its origin in order to retain confidence metadata (`confidence` / `source`) (the trace_spec_to_code in §4 passes this `dir_path` as a parameter to a code-graph-side query to hop).

### 2.3 Schema Extension Policy

- Adding edges is permitted as an extension from the "starting set" (ADR-0005).
- **Adding node types is a matter for reconsideration** (do not increase them lightly). When knowledge appears that cannot be fully expressed by the 5 types, an ADR is filed.

---

## 3. Tool I/O Specification of the Custom knowledge MCP

The MCP definition is `ports/mcp.d/20-knowledge.json`, and the server itself is `mcp-knowledge/`. The initial tools are narrowed to **two** (`search_docs` / `trace_spec_to_code`) (ADR-0003: to minimize the migration surface of Cypher dialect differences when migrating to Neo4j). Both tools are **read-only** (they have no graph write path whatsoever).

### 3.1 `search_docs`

Purpose: an entry-point tool that searches for related document/term/decision nodes from natural language or a term.

**Input**:
```json
{
  "query": "design intent of the billing closing process",   // required: search term (natural language or term)
  "node_types": ["Document", "Decision", "DomainTerm"], // optional: narrowing. Default is all node kinds
  "limit": 10                            // optional: default 10 (initial value, tentative)
}
```

**Output** (search results rather than `fragments`. The return value embeds "the arguments for the next tool to call" = §4):
```json
{
  "results": [
    {
      "node_type": "Aggregate",
      "id": "invoice",
      "name": "Invoice",
      "summary": "The invoice aggregate. The subject of the closing process.",
      "path": null,
      "next_tools": [
        {
          "tool": "trace_spec_to_code",
          "args": { "aggregate_id": "invoice" },
          "why": "trace to this aggregate's implementation directory and related code"
        }
      ]
    },
    {
      "node_type": "Decision",
      "id": "adr-0005",
      "title": "Knowledge graph schema granularity",
      "status": "accepted",
      "path": "docs/adr/0005-...md",
      "next_tools": [
        {
          "tool": "search_docs",
          "args": { "query": "IMPLEMENTED_BY bridge", "node_types": ["Aggregate"] },
          "why": "trace the aggregates this decision AFFECTS"
        }
      ]
    }
  ],
  "truncated": false
}
```

Search is deterministic (§5.3: each step is deterministic, only the orchestration is AI). The internal implementation is a fallback in the order of exact term match → partial match → summary substring (LLM embedding search is not adopted initially, prioritizing a fully local approach).

### 3.2 `trace_spec_to_code`

Purpose: starting from an aggregate node (or a document), follow the bridging edge `IMPLEMENTED_BY` to reach the implementation directory / code symbols. Handles the hop from the knowledge graph to the code graph.

**Input**:
```json
{
  "aggregate_id": "invoice",     // one of the two is required (aggregate origin)
  "document_id": null,           // or document origin (DEFINED_IN reverse lookup → aggregate)
  "resolve_symbols": true        // optional: if true, delegate to codegraph and resolve down to symbols (default false)
}
```

**Output**:
```json
{
  "aggregate": { "id": "invoice", "name": "Invoice" },
  "implemented_by": [
    {
      "dir_path": "src/billing/invoice/",
      "confidence": "reviewed",     // explicit | inferred | reviewed
      "source": "human"
    }
  ],
  "code_symbols": [                 // only when resolve_symbols=true
    { "symbol": "InvoiceService", "file": "src/billing/invoice/service.ts" }
  ],
  "next_tools": [
    {
      "tool": "codegraph.analyze_code_relationships",
      "args": { "path": "src/billing/invoice/" },
      "why": "dig into the call relationships of the implementation directory (over to the code graph side)"
    }
  ]
}
```

When `resolve_symbols=true`, this tool delegates to the codegraph MCP (a separate graph) with `dir_path` as an argument. This is the logical join point of the two graphs (§2.2 note).

---

## 4. Agentic Graph RAG: A Concrete Example of the runbook Approach

Policy (§5.3): graph construction is human-designed, and **only the query side is agentized**. The return value of each tool embeds "the arguments of the tool to call next", making the return value itself a runbook (a procedure with the next action attached). Each search step is deterministic, and only the multi-hop orchestration is delegated to AI.

### 4.1 Concrete Example of Multi-Hop Exploration

Example task: "Starting work on an Issue that fixes the closing process for invoices. I want to grasp the related design intent and implementation locations."

```
[Hop 1] search_docs({query:"invoice closing process"})
  → results[0] = Aggregate "invoice"
     next_tools = [ trace_spec_to_code({aggregate_id:"invoice"}) ]   ← args already embedded
  → results[1] = Decision "adr-0005"
     next_tools = [ search_docs({query:"...", node_types:["Aggregate"]}) ]

[Hop 2] (the AI just runs next_tools as-is)
  trace_spec_to_code({aggregate_id:"invoice"})
  → implemented_by = [ "src/billing/invoice/" (confidence:reviewed) ]
     next_tools = [ codegraph.analyze_code_relationships({path:"src/billing/invoice/"}) ]

[Hop 3]
  codegraph.analyze_code_relationships({path:"src/billing/invoice/"})
  → obtain call relationships and dependencies (code graph side, read-only snapshot)

→ the AI autonomously assembles and grasps "design intent (ADR) + implementation directory + call relationships"
```

The input arguments for each hop are **already constructed by the server** as the preceding stage's `next_tools[].args`, and the AI decides only "which next_tool to choose". The AI is not made to invent the argument values (ensuring determinism).

### 4.2 Relationship with context.d (Hybrid Approach)

Following the hybrid approach in Requirements Definition §4.2 ②, the context plugin (§6) **pre-injects only a light summary**, and the deep dive of the above multi-hop is **obtained by the AI itself via MCP tools during execution**. The entire graph is not expanded during pre-injection (to avoid token waste and reduced reproducibility).

---

## 5. Extraction Procedure for the IMPLEMENTED_BY Bridging Edge

The mapping of the bridging edge (design-doc node ⇔ implementation component) is the greatest source of value (§5.4). Extraction is in two stages.

### 5.1 Stage 1: Mechanical Extraction of Explicit Links (confidence=explicit / source=link)

Extract mechanically from explicit file-path notations within design documents.

```
1. Scan the Markdown pointed to by the Document node's path
2. Extract implementation-path notations by regex:
     - a path inside a code span:  `src/billing/invoice/`
     - an explicit "implementation: src/..." style notation
     - a path that prefix-matches Aggregate.dir_path
3. Match the extracted paths against Aggregate.dir_path
     → on a match, draw IMPLEMENTED_BY(confidence="explicit", source="link")
```

This stage uses no LLM and is deterministic. It is re-run after a docs merge from the sink `35-reindex-knowledge.sh`.

### 5.2 Stage 2: AI Inference for the Shortfall + Human Review (confidence=inferred → reviewed / source=ai → human)

For aggregates not covered by explicit links, AI inference produces candidates, which are **finalized through human review**.

```
1. Enumerate Aggregates that have no IMPLEMENTED_BY
2. The AI proposes candidate dir_paths from the similarity between the aggregate name/summary and codegraph's directory/symbol names
     → tentatively register as IMPLEMENTED_BY(confidence="inferred", source="ai")
3. Human review (needs-human): if valid, update confidence to "reviewed" and source to "human".
   If wrong, delete the edge.
```

Key points:
- AI-inferred edges (`inferred`) are **not used as-is** as a basis for quality gates. Only those promoted to `reviewed` are treated as authoritative by the mechanical gate (ADR-0005: because the graph is used as the foundation for quality gates, types and confidence are required).
- When refactoring the directory structure, `IMPLEMENTED_BY` needs to be re-wired (ADR-0005 Negative). Re-wiring automatically follows through the re-extraction of Stage 1 (for the explicit portion), so writing explicit links in design documents is the recommended practice.

---

## 6. fragments Output Specification of the context.d Plugin

`ports/context.d/` is the implementation of the context port. The core executes all plugins in order, **concatenates `fragments` in priority order**, and **truncates them at the token limit** (§4.2 ②).

### 6.1 Plugin Composition

| File | source | Role | Default priority |
|---|---|---|---|
| `10-codegraph.sh` | `codegraph` | Injects an impact-scope summary (light summary) from the code graph | 10 |
| `20-knowledge.sh` | `knowledge` | Injects a summary of related design intent/terms/decisions from the knowledge graph | 20 |
| `30-recent-failures.sh` | `recent-failures` | Injects recent failures of similar tasks from `failure-catalog.md` / logs | 30 |

> The existing directory diagram in Requirements Definition §8 illustrates two files in `context.d/`: `10-codegraph.sh` and `20-knowledge.sh`. This design follows that while adding `30-recent-failures.sh` (corresponding to the change of context-injection strategy on retry = the extension latitude in §11.2. It does not contradict the requirements and is within the scope of extension).

### 6.2 Output (fragment) Specification of Each Plugin

Each plugin, following the contract in Requirements Definition §4.2 ②, emits elements of the `fragments` array to stdout.

```json
{
  "fragments": [
    { "source": "codegraph",        "content": "...", "priority": 10 },
    { "source": "knowledge",        "content": "...", "priority": 20 },
    { "source": "recent-failures",  "content": "...", "priority": 30 }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `source` | string | Generating plugin identifier (`codegraph` / `knowledge` / `recent-failures`) |
| `content` | string | Injected body. **Light summary only** (hybrid approach: deep dives are obtained by the AI via MCP during execution) |
| `priority` | number | Concatenation order. **Smaller comes first** (higher = more important, preferentially retained within the token limit) |

Each plugin returns one or more fragments for its own source. If there is no applicable information, it returns an empty array `{"fragments": []}` (does not error = it is recorded in logs to avoid silent failure).

### 6.3 Priority Concatenation and Token-Limit Truncation

The core's combination algorithm:

```
1. Collect:  gather all plugins' fragments via run_ports_all(context.d)
2. Sort:     stable-sort fragments by ascending priority (same priority = plugin number order)
3. Concat:   concatenate content in order (insert a source-labeled separator header)
4. Truncate: when cumulative tokens exceed CONTEXT_TOKEN_BUDGET, discard the excess from the tail (= lowest priority)
          - drop per fragment (do not cut off mid-fragment)
          - record dropped fragments in logs (make what was discarded observable)
5. Output:   the final context string passed to the executor
```

| Parameter | Initial value (tentative) | Review | Notes |
|---|---|---|---|
| `CONTEXT_TOKEN_BUDGET` | Undecided (set via the profile `profiles/*.env`. Initial value adjusted with operational data) | After Phase 2 measurement | Conforms to the "numbers are adjusted through operation" policy of §11.2. No false precision is set in advance |
| Truncation unit | Per fragment | — | No partial truncation is done, in order to preserve the meaning of priority (importance) |

Key points:
- **The smaller a fragment's priority, the more likely it is retained** (preferentially preserving the important impact-scope summary).
- Pre-injection is kept lightweight, on the premise that the AI deep-dives via MCP during execution (§4.2). Therefore the full text of a huge graph is not placed in content.
- The fact that truncation occurred is itself made observable (Requirements §6.3 observability).

---

## 7. Acceptance-Criteria Fulfillment Mapping

| Acceptance criterion | Where fulfilled |
|---|---|
| There is a schema definition for the knowledge graph (Cypher DDL-equivalent) | §2.2 (NODE/REL TABLE DDL, 5 node types and 5 edge types) |
| There is an I/O specification for the 2 MCP tools | §3.1 `search_docs` / §3.2 `trace_spec_to_code` (read-only, I/O JSON) |
| Reindexing timing and the exclusion method are specified | §1.2 (merge-driven + preflight, single trigger point) / §1.3 (read-only snapshot sharing, flock, write only once) |

---

## 8. Open Items (Deferred, Initial Values Made Explicit)

| Item | Status | Basis |
|---|---|---|
| The concrete value of `CONTEXT_TOKEN_BUDGET` | Initial value (tentative). Adjusted with operational data | §11.2 |
| Differential indexing (full → differential optimization) | Deferred. An optimization candidate for Phase 2 and beyond | This document §1.2 |
| Migration to Neo4j | Deferred. When it becomes necessary | ADR-0003 |
| Adding node types | A matter for reconsideration (do not increase lightly) | ADR-0005 |
| Adding MCP tools (2 → 3 and beyond) | Extension latitude. Fixed at 2 initially to minimize the migration surface | §5.2 / ADR-0003 |
