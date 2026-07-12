# ADR-0010: TypeScript for Core, CLI, and Contracts (plugins remain any-language)

**Date**: 2026-07-11
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.8 §2.1 / §3.2)

## Context

We need to settle the implementation language for the core loop, CLI, and contract type definitions. The original plan was a bash script implementation, but HALO is premised on being published and distributed as OSS, and ease of adoption, cross-platform support, and minimal external-binary dependencies govern its distributability. Meanwhile, the unified contract (JSON over stdin/stdout + exit code) is a public API placed at the process boundary, and is the most important invariant making plugins independent of the core's implementation language (ADR-0001).

## Decision

Implement the core, CLI, and contract type definitions in TypeScript. Distribute via npm, make it adoptable with `npx halo`, and eliminate external-binary dependencies so it works cross-platform. Because the unified contract sits at the process boundary, plugins remain any-language (bash / Python / Node all fine).

## Alternatives Considered

### Alternative 1: A bash core implementation
- **Pros**: Few dependencies; no additional runtime needed in Unix environments.
- **Cons**: A weak OSS distribution path (no standard package channel like npm). Requires external binaries to run on Windows-family systems, giving low cross-platform support. Hard to provide typed public contract definitions.
- **Why not**: Cannot satisfy OSS distributability, ease of adoption via `npx halo`, elimination of external-binary dependencies, and cross-platform operation. Because the contract sits at the process boundary, making the core TS does not compromise plugins' freedom of language.

### Alternative 2: Single-binary distribution via Go / Rust
- **Pros**: Simple distribution as a single binary, fast execution.
- **Cons**: Falls outside the npm ecosystem (adoption as a devDependency, plugin distribution). Hard to share contract types with JS/TS users.
- **Why not**: Adoption presupposes `npm i -D halo` (§8.2), and the benefits of npm integration (plugin distribution, type sharing) outweigh the benefits of a single binary.

## Consequences

### Positive
- A standard adoption/teardown path via `npm i -D halo` / `npx halo` (consistent with zero global state in §8.2, ADR-0009).
- Contract type definitions can be published in TypeScript, and Node-based plugins can share the types directly.
- Cross-platform operation by eliminating external-binary dependencies.

### Negative
- Running the core requires a Node runtime (more prerequisites than a bash-only environment).
- When a plugin is in a non-Node language, it does not benefit from type sharing and must each ensure conformance to the contract (JSON schema).

### Risks
- Concern that making the core TS implicitly narrows plugins' freedom of language → maintain the invariant of fixing the contract at the process boundary (JSON over stdin/stdout + exit code) (ADR-0001), structurally guaranteeing plugin language independence.
