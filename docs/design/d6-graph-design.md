# D6. Graph Design (HALO Graph Design)

| Item | Content |
|---|---|
| Document version | 1.0 |
| Prerequisites | The HALO Requirements Specification v1.8 is the top-level document; consistent with [D1 Contract Specification](./d1-contract-spec.md) (especially §4 kg:// URI) |
| Positioning | **Private**. The implementation specification for the graph integration plugin group (`ports/mcp.d/`, `mcp-knowledge/`, context.d, docs-md runtime, sink 35) |
| Public/Private | **Private** (the graph is a knowledge asset specific to the project itself and is not a target of OSS distribution. The core and contracts have their public API defined by D1) |
| Basis | Requirements Specification v1.8 §5 (context layer) / §11.1, [ADR-0003](../adr/0003-kuzudb-merge-driven-reindex.md) / [ADR-0005](../adr/0005-knowledge-graph-schema-granularity.md) / [ADR-0011](../adr/0011-specs-abolition-graph-consolidation.md) |
| Source material | [Detailed Design 05](./05-context-layer-graphs.md) (v1.5 material. Reuses the KuzuDB DDL etc. and revised to match v1.8's graph consolidation = specs/ abolition) |
| Authoring timing | **Before Phase 4 begins** (preceding the introduction of the knowledge graph and enabling kg:// references and freeze-guarantee) |

> This document details Requirements Specification §5 down to the implementation level and does not introduce content that contradicts the requirements. For points where numbers or details are undefined in the requirements, it explicitly marks them as "initial value (tentative)" (per §11.2).

---

## 0. Scope and overview

The context layer holds 2 kinds of graphs (code graph / knowledge graph), both backed by **KuzuDB** (embedded, a single file, no server required, ADR-0003). The two graphs are stored separately in 2 files.

| Graph | File | Producer | MCP server | Write |
|---|---|---|---|---|
| Code graph | `graphs/code.kuzu` | CodeGraphContext (tree-sitter, no LLM) | `codegraph` (`ports/mcp.d/10-codegraph.json`) | Only during preflight |
| Knowledge graph | `graphs/knowledge.kuzu` | Human-designed + machine extraction by sink 35 | `knowledge` (`ports/mcp.d/20-knowledge.json`, actual body `mcp-knowledge/`) | 2 routes: manual + sink 35 (ADR-0011) |

Responsibility separation (ADR-0005):

- **Code graph** = the auto-generated domain. Structural information a machine can read as fact (call relationships, definition locations, dead code).
- **Knowledge graph** = the human-designed domain. Tacit knowledge such as design intent, ubiquitous language, and decisions. **The single management site for requirements, specifications, and acceptance criteria** (ADR-0011: it has no specs/ directory).
- The two are logically connected only via `IMPLEMENTED_BY` (aggregate node → directory path), avoiding dual management at the field level.

The 7 items this document defines:

| # | Section | Content |
|---|---|---|
| 1 | §1 | KuzuDB schema DDL (5 node kinds, 5 edge kinds) |
| 2 | §2 | Resolution implementation for kg:// URIs |
| 3 | §3 | Code graph (CGC) ingestion and preflight re-indexing (Plan A) |
| 4 | §4 | Staleness detection → `kind:docs` auto-issue logic |
| 5 | §5 | Glossary consistency check (deprecated / synonyms, block on forbidden terms only) |
| 6 | §6 | MCP tool definitions (`search_docs` / `trace_spec_to_code`, Agentic RAG) |
| 7 | §7 | Procedure for loading requirements (source md → graph nodes) |

---

## 1. KuzuDB schema DDL

### 1.1 Schema granularity (finalized = ADR-0005 / §11.1)

Start with **5 node kinds** and **5 edge kinds**, and do not descend to the entity/field level. The bridging edge `IMPLEMENTED_BY` is drawn from aggregate → directory path.

- **5 node kinds**: BoundedContext / Aggregate / DomainTerm / Document / Decision
- **5 edge kinds**: `BELONGS_TO` / `DEFINED_IN` / `IMPLEMENTED_BY` / `SUPERSEDES` / `AFFECTS`

Correspondence between kg:// URI node types (D1 §4.1) and this schema:

| kg:// node-type | NODE TABLE | PRIMARY KEY value domain |
|---|---|---|
| `context` | `BoundedContext` | Domain boundary slug (e.g. `billing`) |
| `aggregate` | `Aggregate` | Aggregate slug (e.g. `invoice`) |
| `term` | `DomainTerm` | Term slug |
| `document` | `Document` | Document slug (e.g. `auth-login`) |
| `decision` | `Decision` | Lowercase slug of the decision ID (e.g. `adr-0005`, corresponding to the original ADR number 0005) |

> **The `id` of a kg:// URI = the node's PRIMARY KEY.** This match is the basis of the resolution implementation in §2. The ID is a slug (kebab-case recommended) and is unique.

### 1.2 Knowledge graph DDL (`graphs/knowledge.kuzu`)

Because KuzuDB requires a structured schema, nodes are defined as `NODE TABLE` and edges as `REL TABLE`. The following is the initial DDL (loaded via hand-written Cypher).

```cypher
-- ============ Node tables (5 kinds) ============

-- (1) Bounded Context
CREATE NODE TABLE BoundedContext (
    id        STRING,        -- the <id> of kg://context/<id> (e.g. "billing")
    name      STRING,        -- display name (e.g. "Billing Context")
    summary   STRING,        -- summary
    PRIMARY KEY (id)
);

-- (2) Aggregate: the origin of the bridge. dir_path is the link to the implementation
CREATE NODE TABLE Aggregate (
    id        STRING,        -- kg://aggregate/<id> (e.g. "invoice")
    name      STRING,        -- aggregate name (e.g. "Invoice")
    dir_path  STRING,        -- implementation directory path (basis for IMPLEMENTED_BY)
    summary   STRING,
    PRIMARY KEY (id)
);

-- (3) Domain term (ubiquitous language)
CREATE NODE TABLE DomainTerm (
    id          STRING,      -- kg://term/<id>
    term        STRING,      -- term (canonical)
    definition  STRING,      -- definition
    synonyms    STRING,      -- allowed synonyms (comma-separated; consistency check warns only)
    deprecated  STRING,      -- forbidden terms (comma-separated; a violation is a block)
    PRIMARY KEY (id)
);

-- (4) Document (design doc / ADR / requirement / glossary)
CREATE NODE TABLE Document (
    id        STRING,        -- kg://document/<id> (e.g. "auth-login")
    title     STRING,
    path      STRING,        -- source relative path (management is outside HALO's concern; optional)
    doc_type  STRING,        -- "design" | "adr" | "requirement" | "glossary"
    body_hash STRING,        -- source hash at ingestion time (for staleness detection / freeze verification)
    PRIMARY KEY (id)
);

-- (5) Decision (Decision / the ADR decision unit)
CREATE NODE TABLE Decision (
    id        STRING,        -- kg://decision/<id> (e.g. "adr-0005")
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

-- IMPLEMENTED_BY: aggregate → aggregate (held on its own origin to carry confidence meta)
--   The counterpart code is in a separate DB (code.kuzu) and no physical edge can be
--   drawn, so it is a logical join keyed on the dir_path string (§2.3 / §6.2).
CREATE REL TABLE IMPLEMENTED_BY (
    FROM Aggregate TO Aggregate,
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

> **Note (multi-pair relationships)**: KuzuDB can declare multiple `FROM ... TO ...` in a single `REL TABLE`. `DEFINED_IN` / `AFFECTS` use this to hold multiple source/target types in one table. The counterpart of `IMPLEMENTED_BY` is originally a code-side node, but the code graph is in a separate DB (`code.kuzu`) and physical edges cannot span DBs. Therefore the bridge is a **logical join keyed on the `Aggregate.dir_path` string**, and the edge itself is held on the aggregate side in order to carry the confidence meta (`confidence` / `source`).

### 1.3 Code graph schema

The code graph is a domain auto-generated by CodeGraphContext (tree-sitter), and its schema/DDL follow CGC's implementation (not defined in this document). What the HALO side depends on is only the MCP tools CGC exposes (`find_code` / `analyze_code_relationships` / `find_dead_code` / `execute_cypher_query`) and the meta for the re-index decision (§3.2).

### 1.4 Schema extension policy (ADR-0005)

- Adding edges is permitted as an extension from the "starting set."
- **Adding node kinds is a matter for reconsideration** (do not increase them lightly). At the point where knowledge appears that the 5 kinds cannot fully express, raise an ADR.
- `Document.doc_type`'s `spec` is **renamed to `requirement` in v1.8** (ADR-0011: with the abolition of specs/, the "specification file" concept disappears, and the requirement itself becomes a Document node. See §9).

---

## 2. Resolution implementation for kg:// URIs

### 2.1 URI form (consistent with D1 §4)

```
kg://<node-type>/<node-id>
```

| Element | Description | Example |
|---|---|---|
| `<node-type>` | Knowledge graph node kind (5 kinds) | `document` / `decision` / `term` / `context` / `aggregate` |
| `<node-id>` | Slug unique within the kind (= PRIMARY KEY) | `auth-login` / `rate-limit-policy` |

D1 defines only "the form and the meaning of 'pointing to a graph node'," and **the resolution implementation is under this document's (private) purview** (D1 §4.2).

### 2.2 Resolution algorithm

The URI resolver lives inside the `knowledge` MCP server. There are 2 callers: loop-audit (gate `50-loop-audit`) and `trace_spec_to_code`.

```
resolve(uri):
  1. Parse:   strip the "kg://" prefix → split "<type>/<id>" on "/"
             if the type is none of the 5 kinds, return INVALID_TYPE
  2. Determine the NODE TABLE via the type → table mapping (table in §1.1)
  3. Cypher:  MATCH (n:<Table> {id:$id}) RETURN n LIMIT 1
  4. Hit:     return the node properties (exists = true)
     Miss:    return NOT_FOUND (exists = false)
```

Validate the type, path length, and slug form (`^[a-z0-9][a-z0-9-]*$`) at the input boundary, and return an invalid URI with its original text attached to the fail reason (observability).

### 2.3 Existence verification by loop-audit (guaranteeing the freeze requirement)

`spec_refs` (the array of kg:// URIs in the task-source output, D1 §1.1) is verified by loop-audit at loop start.

| Check | Content | On failure |
|---|---|---|
| Form check | Whether each URI matches `kg://<type>/<id>` | gate fail (exit 2) |
| Existence check | Whether `resolve(uri)` returns existence = true (read-only graph query) | gate fail (exit 2) |
| Hash check | Whether the hash of `graphs/knowledge.kuzu` matches the one recorded at loop start (detecting direct modification during execution, ADR-0011 (3)) | gate fail (exit 2) |

A task with non-existent `spec_refs` is bounced back by structural check ① (Requirements §11.1). This blocks the path where "the AI invents/alters the goal (requirement node) and self-justifies."

> **Phase transitional measure** (ADR-0011 / D1 §4.2): before the graph is introduced (Phases 1–3), `spec_refs` is empty and requirements are described directly in the Issue body. The existence verification in this section is enabled upon the Phase 4 graph introduction.

---

## 3. Code graph ingestion and preflight re-indexing (Plan A)

### 3.1 Trigger point of re-indexing (merge-driven + preflight)

Per ADR-0003, `watch` mode is not adopted (the watch target becomes a worktree that is created and destroyed, so the graph gets polluted with intermediate states, which is structurally incompatible with the disposable-worktree scheme). The re-index trigger point is **only the single preflight at loop launch**.

```
run (preflight stage 1: graph freshness decision)
  IF   current HEAD of main != last_indexed_sha recorded in code.kuzu
  THEN run reindex (based on main, single process, the only write happens here)
       → update last_indexed_sha to main HEAD
       → go to the kind:docs issue decision for stale aggregates (§4)
  ELSE skip (not stale)
  → start the loop body (graph is immutable thereafter)
```

### 3.2 Freshness-decision metadata

| Key | Content | Storage |
|---|---|---|
| `last_indexed_sha` | The main commit SHA indexed last time | Meta node inside `code.kuzu` or `graphs/.code.meta` |
| `indexed_at` | Last index time (ISO8601) | Same as above |
| `schema_version` | Code graph schema version (tree-sitter extraction rule version) | Same as above |

Re-indexing **defaults to a full index based on main**, not a diff (state consistency is the top priority under KuzuDB's single-process write constraint. Diff indexing is an optimization candidate for Phase 2 onward = deferred).

### 3.3 Exclusion scheme (read-only snapshot sharing)

KuzuDB assumes writes from a single process. Simultaneous writes from parallel worktrees are structurally forbidden.

| Phase | Actor | Access | Exclusion means |
|---|---|---|---|
| Preflight | run (single parent process) | Read-write (re-index) | `flock` (shared with the multiple-launch-prevention lock. The write process is at most 1) |
| During loop execution | Each worktree's agent | **read-only** only | No write path (MCP exposes only reference-type tools) |

Key points:

1. Writes happen only once, during preflight. `flock` ensures there is at most 1 write process at a time.
2. During loop execution, all worktrees share the same immutable snapshot read-only → guaranteeing **context reproducibility across iterations** (same input → same graph → same context).
3. The substance of read-only sharing is opening KuzuDB in read-only mode. No file copy is required. Tools that attempt to write are not included in `10-codegraph.json` / `20-knowledge.json`.

---

## 4. Staleness detection → `kind:docs` auto-issue

### 4.1 The 2 staleness routes and their reflection

Between a merge and the next preflight, the graph goes stale (ADR-0003 Negative). It is mitigated with bidirectional auto-reflection.

| Origin | Reflection route | Implementation |
|---|---|---|
| docs merge | Update the knowledge graph | sink `35-reindex-knowledge` (§7.3) |
| code change | Staleness detection → auto-issue a `kind:docs` task (detecting divergence between design docs and implementation) | Preflight stage 1 (this section) |

### 4.2 Issue-decision logic

When the code graph is updated by re-indexing (§3.1), it detects as divergence the case where **the implementation directory of an aggregate linked by `IMPLEMENTED_BY` has changed, but the corresponding Document has not followed**.

```
detect_staleness(old_sha, new_sha):
  1. Changed directory set:
       changed_dirs = git diff --name-only old_sha..new_sha → normalize to directories
  2. Identify affected aggregates:
       FOR each IMPLEMENTED_BY edge e (confidence in {"explicit","reviewed"}):
         IF e.dir_path prefix-matches any of changed_dirs:
           affected aggregate a = the origin Aggregate of e
  3. Follow-up decision:
       FOR each affected aggregate a:
         related Document d = the design doc linked via AFFECTS reverse lookup or BELONGS_TO
         IF d.body_hash != the source's current hash  → treat as already hand-updated (skip)
         IF d exists and d.path is not included in the changed_dirs diff
                                                → divergence candidate (only code moved, design not followed)
  4. Issue:
       auto-issue a kind:docs Issue per divergence candidate (§4.3)
```

- The decision relies only on edges with `confidence in {explicit, reviewed}` (`inferred` = unreviewed AI estimates are a source of false positives, so they are excluded, ADR-0005).
- The decision is deterministic (no LLM). Diff, prefix match, and hash comparison only.

### 4.3 Issue content and duplicate suppression

| Item | Value |
|---|---|
| Labels | `kind:docs`, `ready`, `auto-generated` |
| Title | `[docs] design doc for <aggregate name> has not followed the implementation` |
| Body | Affected aggregate ID / changed directories / target Document's kg:// URI / detected commit range |
| `spec_refs` | The kg:// URI of the target Document / aggregate (the generated task's own frozen reference) |
| Duplicate suppression | If an unclosed `auto-generated` Issue with the same `(aggregate id, target Document id)` already exists, do not issue (idempotent) |

Issuing is via the task-source adapter (GitHub Issues). Issuing itself is done regardless of autonomy, but whether the docs task is executed follows the normal loop and autonomy filter.

---

## 5. Glossary consistency check (docs-md runtime)

### 5.1 Positioning

The dynamic verification borne by the `test.sh` of the `docs-md` runtime (D1 §1.7). It references the `DomainTerm` nodes of the knowledge graph and inspects whether the changed document is consistent with the ubiquitous language. A concrete example of using the graph as the foundation of a quality gate (ADR-0005: because there are types, you can write automatic gates).

### 5.2 Check kinds and severity

| # | Check | Basis property | On violation | Severity |
|---|---|---|---|---|
| 1 | **Use of a forbidden term** | `DomainTerm.deprecated` (comma-separated) | **block (exit 2)** | CRITICAL |
| 2 | Synonym variance | `DomainTerm.synonyms` (comma-separated) | warning (exit 0, to stderr) | LOW |
| 3 | Suspected undefined term | Technical-looking notation not hit by exact `term` match | note (exit 0, to stderr) | NOTE |

**Only forbidden terms (deprecated) block.** Synonym variance and suspected-undefined are kept to warnings and do not stop the loop (avoiding stalling autonomous execution with excessive gates. The philosophy of §11.2).

### 5.3 Decision algorithm

```
glossary_check(changed_docs):
  terms = read-only fetch of all DomainTerm from the knowledge MCP
        (expand and index term / synonyms / deprecated)
  FOR each doc in changed_docs (only added/changed lines):
    tokenize(doc body)
    1. token matching the deprecated set → add to violations (block target)
    2. token matching the synonyms set (not the canonical term) → add to warnings
    3. unknown token that looks like a technical term → add to notes
  IF violations non-empty:  print the forbidden-term list and substitute terms to stderr, exit 2
  ELSE:                     record warnings/notes to stderr, exit 0
```

- The inspection target is only the added/changed lines of the change diff (no re-check of the whole existing text = noise suppression).
- Deterministic (no LLM). Token match only.
- Violation output always attaches "the correct term to substitute" (so the agent can self-correct after being bounced back).

---

## 6. MCP tool definitions (Agentic Graph RAG)

### 6.1 Policy

The MCP definition is `ports/mcp.d/20-knowledge.json`, and the server body is `mcp-knowledge/`. The initial tools are narrowed to **2** (`search_docs` / `trace_spec_to_code`) (ADR-0003: minimizing the migration surface of Cypher dialect differences at a Neo4j migration). Both tools are **read-only** (they have no graph write path whatsoever).

Graph construction is human-designed, and **only the query side is agentified**. Each tool's return value embeds "the arguments of the next tool to call" (`next_tools`), making the return value itself a runbook (a procedure with the next action attached). Each search step is deterministic, and only the multi-hop orchestration is delegated to the AI (do not let the AI invent the argument values = guaranteeing determinism).

### 6.2 `search_docs`

Purpose: an entry-point tool that searches for related documents, terms, and decision nodes from natural language or a term.

**Input**:

```json
{
  "query": "design intent of the billing closing process",
  "node_types": ["Document", "Decision", "DomainTerm"],
  "limit": 10
}
```

| Field | Required | Description |
|---|---|---|
| `query` | ✓ | Search term (natural language or a term) |
| `node_types` | | Narrowing. Default is all node kinds |
| `limit` | | Default 10 (initial value, tentative) |

**Output** (embeds the next moves in `next_tools`):

```json
{
  "results": [
    {
      "node_type": "Aggregate",
      "id": "invoice",
      "name": "Invoice",
      "summary": "The invoice aggregate. The subject of the closing process.",
      "kg_uri": "kg://aggregate/invoice",
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
      "kg_uri": "kg://decision/adr-0005",
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

The search is deterministic. The internal implementation is a fallback in the order **term exact match → partial match → summary substring** (LLM embedding search is not adopted initially = prioritizing local self-containment). Each result includes `kg_uri` so it can be transcribed directly into `spec_refs`.

### 6.3 `trace_spec_to_code`

Purpose: starting from an aggregate node (or document), follow the bridging edge `IMPLEMENTED_BY` to reach the implementation directory / code symbols. It bears the hop from knowledge graph → code graph (the logical join point of the 2 graphs).

**Input**:

```json
{
  "aggregate_id": "invoice",
  "document_id": null,
  "resolve_symbols": true
}
```

| Field | Required | Description |
|---|---|---|
| `aggregate_id` | △ | Aggregate origin (one of `aggregate_id` / `document_id` is required) |
| `document_id` | △ | Document origin (`DEFINED_IN` reverse lookup → aggregate) |
| `resolve_symbols` | | If true, delegate to codegraph and resolve down to symbols (default false) |

**Output**:

```json
{
  "aggregate": { "id": "invoice", "name": "Invoice" },
  "implemented_by": [
    { "dir_path": "src/billing/invoice/", "confidence": "reviewed", "source": "human" }
  ],
  "code_symbols": [
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

When `resolve_symbols=true`, this tool delegates to the codegraph MCP (a separate graph) with `dir_path` as an argument. It always returns `confidence` (`explicit`/`inferred`/`reviewed`) so the caller can judge the certainty.

### 6.4 Concrete example of multi-hop exploration

Example task: "Starting on an Issue to fix the invoice closing process. I want to grasp the related design intent and implementation locations."

```
[Hop 1] search_docs({query:"invoice closing process"})
  → results[0] = Aggregate "invoice"
     next_tools = [ trace_spec_to_code({aggregate_id:"invoice"}) ]   ← args already embedded
  → results[1] = Decision "adr-0005"
     next_tools = [ search_docs({query:"...", node_types:["Aggregate"]}) ]

[Hop 2] trace_spec_to_code({aggregate_id:"invoice"})
  → implemented_by = [ "src/billing/invoice/" (confidence:reviewed) ]
     next_tools = [ codegraph.analyze_code_relationships({path:"src/billing/invoice/"}) ]

[Hop 3] codegraph.analyze_code_relationships({path:"src/billing/invoice/"})
  → obtain call relationships and dependencies (code graph side, read-only snapshot)

→ the AI autonomously assembles and grasps "design intent (ADR) + implementation directory + call relationships"
```

The input arguments of each hop are **already built on the server side** as the previous stage's `next_tools[].args`, and the AI only judges "which next_tool to choose."

### 6.5 Relationship with context.d (hybrid scheme)

Per the hybrid scheme of Requirements §4.2 ②, the context plugin (`20-knowledge`) **pre-injects only light summaries**, and the deep dives of the above multi-hop are **fetched by the AI itself via MCP tools during execution**. It does not expand the whole graph in pre-injection (avoiding token waste and reduced reproducibility).

---

## 7. Procedure for loading requirements (source md → graph nodes)

Per ADR-0011, requirements, specifications, and acceptance criteria are managed centrally in the knowledge graph, with no specs/ directory. Where a human manages the source md is outside HALO's concern (it just needs to be loaded into the graph). Loading is via one of the 2 write routes (manual / sink 35).

### 7.1 Mapping of loading units

| Source description | Graph node | Main properties |
|---|---|---|
| Domain boundary (subsystem) | `BoundedContext` | id / name / summary |
| Aggregate (unit of implementation) | `Aggregate` | id / name / **dir_path** / summary |
| Term definition (ubiquitous language) | `DomainTerm` | term / definition / synonyms / deprecated |
| Design doc / ADR / requirement doc | `Document` | id / title / path / doc_type / **body_hash** |
| Decision (the ADR body) | `Decision` | id / title / status / date |

Edges are drawn from the relationships within the description (belonging = `BELONGS_TO`, definition source = `DEFINED_IN`, decision impact = `AFFECTS`, decision supersession = `SUPERSEDES`, design ⇔ implementation = `IMPLEMENTED_BY`).

### 7.2 Loading flow (manual route)

```
1. A human reads the source md and writes the node/edge Cypher per the table above (human-designed)
2. Compute body_hash and store it in the Document node (the basis for staleness detection / freeze verification)
3. Manually ingest into knowledge.kuzu (while the loop is stopped, write route a)
4. Run IMPLEMENTED_BY stage 1 (machine extraction of explicit links) → draw explicit edges (§7.4)
5. Aggregates not filled in are promoted to reviewed via stage 2 (AI estimation → human review) (§7.4)
```

Freeze property: after loading, during loop execution the knowledge MCP opens read-only, and loop-audit performs hash checking (§2.3 / ADR-0011).

### 7.3 sink 35 (auto re-load after docs merge, write route b)

`ports/sink.d/35-reindex-knowledge` (`minAutonomy: L3`). It updates the knowledge graph **only after a docs merge that has passed PR review** (ADR-0011: the route is limited to prevent accidents that let unreviewed writes through during execution).

```
35-reindex-knowledge (after a docs merge):
  1. Recompute and update the body_hash of changed Document sources
  2. Reflect DomainTerm / Decision additions and changes into the graph
  3. Re-run IMPLEMENTED_BY stage 1 (machine extraction of explicit links) to keep explicit edges in sync
```

### 7.4 Extraction of the IMPLEMENTED_BY bridging edge (2 stages)

Mapping the bridging edge (design node ⇔ implementation component) is the greatest source of value (Requirements §5.4).

**Stage 1: machine extraction of explicit links** (`confidence="explicit"` / `source="link"`, no LLM, deterministic)

```
1. Scan the md pointed to by Document.path
2. Extract implementation-path notations by regex (a path inside a code span / "implementation: src/..." style /
   a path that prefix-matches Aggregate.dir_path)
3. Match extracted paths against Aggregate.dir_path → on a match, draw IMPLEMENTED_BY(explicit, link)
```

**Stage 2: AI estimation of the shortfall + human review** (`inferred`→`reviewed` / `ai`→`human`)

```
1. Enumerate Aggregates that have no IMPLEMENTED_BY
2. The AI proposes candidate dir_paths from the similarity between the aggregate name/summary and codegraph's directory/symbol names
   → tentatively register as IMPLEMENTED_BY(inferred, ai)
3. Human review (needs-human): if valid, update to reviewed/human; if wrong, delete the edge
```

Key points:

- AI-estimated edges (`inferred`) are **not used as-is** as the basis of the quality gate (§4 staleness detection). Only those promoted to `reviewed` are treated as valid for the machine gate (ADR-0005).
- Re-wiring is required when the directory structure is refactored. Explicit links (the explicit portion) automatically follow via the re-extraction of Stage 1, so **it is recommended to make it a practice to state the implementation path explicitly in the design doc**.

---

## 8. Acceptance-criteria fulfillment mapping

| Acceptance criterion | Fulfillment location |
|---|---|
| KuzuDB schema DDL (5 node kinds, 5 edge kinds) | §1.2 |
| Resolution implementation for kg:// URIs | §2.2 (resolver) / §2.3 (loop-audit existence verification) |
| CGC ingestion and preflight re-indexing (Plan A) | §3.1–3.3 |
| Staleness detection → kind:docs auto-issue | §4.2–4.3 |
| Glossary consistency check (block on forbidden terms only) | §5.2–5.3 |
| MCP 2 tools (Agentic RAG) | §6.2–6.4 |
| Procedure for loading requirements (source md → nodes) | §7.1–7.4 |

---

## 9. Revision points from v1.5 → v1.8 (against source doc 05)

| # | Revision | Reason |
|---|---|---|
| 1 | **Removed the specs/ premise** and consolidated requirements into the knowledge graph (§0 / §7) | ADR-0011. The freeze property is guaranteed not by directory freezing but by read-only opening + hash checking |
| 2 | Renamed `Document.doc_type`'s `"spec"` to **`"requirement"`** (§1.2 / §1.4) | With specs/ abolished, the "specification file" concept disappears and the requirement itself becomes a Document node |
| 3 | Added a **`body_hash`** property to `Document` (§1.2) | Needed as the basis for staleness detection (§4.2) and freeze-property hash checking (§2.3) |
| 4 | **Aligned kg:// URI resolution with D1 §4** (node-type to PRIMARY KEY correspondence table, slug form validation) (§1.1 / §2) | Since kg:// became D1's public contract in v1.8, the match of id = PRIMARY KEY is made explicit |
| 5 | **Newly detailed the staleness → kind:docs auto-issue logic** (§4.2 decision algorithm / §4.3 idempotent duplicate suppression) | Doc 05 had only a single sentence on "auto-issue." D6 brought it down to a deterministic algorithm |
| 6 | **Newly added the requirement loading procedure (§7)** (source md → nodes, 2 write routes, sink 35's review-passed limitation) | Concretizes ADR-0011's centralized management and write-route limitation into an implementation procedure. Doc 05 has no corresponding section |
| 7 | **Limited the glossary consistency check's block to deprecated only**, downgrading synonyms/undefined to warnings (§5.2) | Avoiding stalling autonomous execution with excessive gates (making explicit the philosophy of §11.2) |

> Note that the priority concatenation of context.d fragments in source doc 05 (doc 05 §6) is outside D6's 7 items and is not treated in this document. However, D1 §1.2 stipulates "the larger the priority, the higher the precedence, concatenated in descending order," which is the reverse of doc 05 §6.3's "the smaller, the higher the precedence." Here D1 (the v1.8 authority) is correct, and the context.d implementation should be aligned with D1 (under the purview of D2 Core Detailed Design).

---

## 10. Open items (deferred / initial values)

| Item | State | Basis |
|---|---|---|
| The default of 10 for `search_docs.limit` | Initial value (tentative) | §6.2 |
| Diff indexing (optimization from full → diff) | Deferred. Phase 2 onward | §3.2 |
| Migration to Neo4j | Deferred. When it becomes necessary | ADR-0003 |
| Adding node kinds | Matter for reconsideration (do not increase lightly) | ADR-0005 |
| Adding MCP tools (2 → 3 onward) | Room for extension. Fixed at 2 initially to minimize the migration surface | §6.1 / ADR-0003 |
| Tokenization for the glossary check (whether Japanese morphological analysis is needed) | Initial value (tentative). Start from simple token matching | §5.3 |
