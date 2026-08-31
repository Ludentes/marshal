# Changelog

There are no releases and the version stays `0.0.0`, so this file is keyed by
**commit**. A git install resolves to whatever `main` is when you run it; pin a
sha if you need it to hold still.

Entries record what a *consumer* would notice. Refreshes that only replay
Galatea's history into `src/` without changing behaviour are not listed.

## Unreleased — `main`

### `93f9021` — CommonJS can require it

Every export gained a `require` condition. Previously a CJS project got
`ERR_PACKAGE_PATH_NOT_EXPORTED`, which reads as "that subpath does not exist"
and sends you looking for a typo in a correct path. Node 22+ can now
`require()` these subpaths outright; Node 20 gets the accurate
`ERR_REQUIRE_ESM`.

CI now imports every export by package name on Node 20, 22 and 24, and
requires it on 22+, so the supported-runtime claim is executed rather than
asserted.

**No API change.** Nothing to do on upgrade.

### `d947d12`, `47c99bf` — the interface is documented

[`API.md`](API.md) covers every export with runnable examples. Before this,
`pick()` was the only name the README mentioned; `reconcile()` was reachable
only by reading the `.d.ts`.

### `c128b1a`, `df47ea7` — the package ships a build

`dist/` is committed and the subpath exports point at it, replacing exports
onto TypeScript source. **This is the change most likely to affect you if you
installed before it.** A consumer previously resolved `./src/*.ts` and needed
its own type stripping; it now resolves `./dist/*.js` and needs nothing.

The reason is in the README: pnpm gates install-time build scripts behind
`onlyBuiltDependencies`, so a `prepare` script would leave you with no `dist/`
and no error. CI rebuilds and fails if the committed output differs.

### `e74062d` — MIT, and a README

The repository became readable by someone who did not write it.

## Before the package existed

`src/` carries its own history from Galatea, including the commits below.
`git log -- src/` reaches them, and each file carries its own line: `pick.ts`
reaches the admission commits, `permit.ts` the allocator, `types.ts` the
vocabulary.

- `f4aeb1b` — three ways a NaN walked through admission and was granted. A
  non-finite cost now throws rather than silently disabling the budget for a
  whole pass, and `reconcile()` reports an unusable settlement instead of
  writing `spent: NaN` while claiming the estimate was within tolerance.
- `6a9cb55` — budget admission satisfies **every** window, not the loosest.
  The finding behind the package: the weekly allowance bound 6.7× harder than
  the 5-hour one.
- `4e2e044` — `pick()` decides admission, with ranking injected.
- `52a804d` — the refusal vocabulary, tied to its own allowlist so a kind
  added to the union and not the const stops the build.
- `4f7dbf6` — `permit.ts`, the first allocator: N holders of one named
  resource across processes, on pid liveness rather than a TTL.
