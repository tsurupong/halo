<!--
Security fix? Do not open a PR — see SECURITY.md for the private channel.
Plugin PR? The acceptance criteria are in CONTRIBUTING.md § Contributing a plugin.
-->

## What and why

<!-- What changes, and what problem it solves. Link the issue or ADR if there is one. -->

## Verification

<!--
How you confirmed it works — paste the output, do not just assert it.
At minimum: pnpm build && pnpm test && pnpm lint && pnpm format
-->

```
```

## Checklist

- [ ] `pnpm build` / `pnpm test` / `pnpm lint` / `pnpm format` all pass locally
- [ ] Tests cover the change (a bug fix has a test that failed before the fix)
- [ ] Contracts regenerated and committed if `packages/contracts` types changed
      (`pnpm --filter @tsurupong/halo-contracts gen`)
- [ ] Design docs / ADRs updated if behaviour diverges from what they describe
- [ ] No new third-party runtime dependency (or it is justified above)
- [ ] Does not weaken a safety invariant (self-modification blocking, autonomy ceiling,
      permission allowlist) — or an ADR in this PR explains why the change is correct
