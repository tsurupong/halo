# ADR-0001: Adoption of Ports & Adapters Structure and a Unified Contract

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.5 §3.2)

## Context

The autonomous development harness HALO frequently adds, removes, and swaps constituent elements — task sources, context sources, quality gates, executors, and sinks — during operation. We want configuration changes to be completed by file operations alone, without touching the core. We also want plugins to be writable in any of bash / Python / Node.

## Decision

Fix the core loop as the domain and abstract every external contact point as a port (hexagonal). All plugins communicate via "JSON over stdin/stdout + exit code," and are enabled by placing files under `ports/<port name>.d/`, with a numeric prefix controlling execution order (the conf.d approach).

## Alternatives Considered

### Alternative 1: A monolithic loop script
- **Pros**: Fastest to implement initially. Fewer files.
- **Cons**: Every swap of a constituent element requires modifying the core. ON/OFF toggling for effect measurement is not possible.
- **Why not**: It contradicts the harness's central philosophy of "building a structure in advance that makes change cheap and safe."

### Alternative 2: In-language plugin mechanism (Python entry points, etc.)
- **Pros**: Typed interfaces, easy to test.
- **Cons**: The plugin implementation language is fixed. Without process isolation, a runaway plugin drags the core down with it.
- **Why not**: We prioritize language independence and isolation via process boundaries.

## Consequences

### Positive
- Adding and removing plugins is completed by file operations alone, enabling one-variable-at-a-time effect measurement (Principle 2).
- The exit code convention aligns with Claude Code hooks (exit 2 = fail), keeping cognitive load low.

### Negative
- JSON serialization/parsing is scattered across each plugin (mitigated by JSON schemas under contracts/).
- Process startup overhead is incurred per iteration (negligible compared to AI execution time).

### Risks
- Introduction of contract-violating plugins → mitigated by validation via contracts/ schemas and gates.
