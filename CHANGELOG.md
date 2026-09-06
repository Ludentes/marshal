# Changelog

Entries record what a *consumer* would notice. Refreshes that only replay
Galatea's history into `src/` without changing behaviour are not listed.

Everything below `0.1.0` predates the first npm release and is keyed by
**commit**, because there was no version to key it by: a git install resolved
to whatever `main` was when you ran it.

## `0.1.0` — the first published version

The package is on npm as `@opcheese/marshal`, and `0.0.0` / `private: true` are
gone. Semver applies, with the pre-1.0 caveat that a minor may break you —
this one does, twice.

### Breaking: `needs` carries structure, not bare strings

`Job.needs` was `string[]` and is now `Need[]`.

```ts
// before
{ id: "job-1", needs: ["repo:cms"] }
// after
{ id: "job-1", needs: [{ resource: "repo:cms" }] }
```

The mechanical migration is `needs: names.map((resource) => ({ resource }))`,
and a bare `{ resource }` means exactly what a plain string meant: one unit, at
whatever the `CostFn` says. TypeScript catches every call site.

What it buys is a job saying *how much*: `units` for counting resources,
`amount` for consumable ones. Before this, a job needing two of a pool of three
could only ask twice — and two identical entries are indistinguishable, so the
release of one leaked the other. Naming a resource twice still coalesces;
naming it twice two *different* ways now throws rather than silently picking
one.

### Breaking: `Job.cost` is gone, and `CostFn` takes the resource

`Job.cost` (a per-job override) is removed. Use `Need.amount`, which is the
same override said per resource — the level a price actually lives at.

`CostFn` widened from `(job) => number` to `(job, resource) => number`, because
a job needing two budgets in different denominations — tokens and emails — has
no single right number.

**This one does not break your build, which is the danger.** A one-argument
function stays assignable to the two-argument type, so an existing `CostFn`
compiles unchanged and goes on pricing every budget alike. Nothing in the
toolchain will point at it. If you budget more than one resource, go look at
your `CostFn` deliberately; spelling both parameters, even where you ignore the
second, is what makes the omission visible next time.

`CountingState.holders` changed from `Holder[]` to `{ holder, units }[]` for
the same reason — the count belongs in the state, not in repeated entries.

### New: `@opcheese/marshal/rank`

A fourth subpath export. `agingRank({ priority, since, cap, interval })` builds
the `effective = priority + min(cap, floor(waited / interval))` curve that the
README has always described and the package has always refused to contain.

It is a separate module on purpose: never-queue trades deadlock for starvation,
and the package that removed the first should not leave the second unanswered —
but the curve is still policy, so taking it is an import you write rather than
a default you inherit. `Job` gains no `priority` and no `since` field; the
accessors are the seam. Ties past the cap break by elapsed time, which is the
part a hand-rolled version usually misses: without it, two equally-aged jobs
fall back to `sort` stability, and the order you handed in is not FIFO.

### Also

Defects found while the above was being written, each reproduced before it was
fixed: a negative price credited a budget and manufactured allowance for
the jobs behind it; a need was priced twice per job so the admission check and
the debit could disagree; jobs saturating a counting resource were ordered
arbitrarily rather than oldest-first; and holder units arriving from a consumer
were not validated at the boundary.

## Before `0.1.0`

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
