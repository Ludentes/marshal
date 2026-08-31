# Marshal

Decides **whether work may start, and records that it decided** — capacity,
exclusivity, order, and a refusal that names its reason. It knows nothing about
what your jobs are, and by construction it cannot: `boundary.test.ts` fails the
build if any file here imports anything but `node:` and its own siblings, or if
an exported name carries one of six domain nouns.

Extracted from Galatea, where it runs the admission half of an agent scheduler.

- **[API reference](API.md)** — every export, with runnable examples
- **[`Ludentes/sieve`](https://github.com/Ludentes/sieve)** — a worked
  reference: an agent app that uses this package to keep two sessions off one
  workspace

## Install

Not on npm. `package.json` keeps `"private": true` so an accidental
`npm publish` fails rather than succeeds. Install from this repository:

```bash
pnpm add git+https://github.com/Ludentes/marshal.git
```

No credential needed, and no build step: `dist/` is committed. ESM only, no
dependencies.

**The version is `0.0.0` and stays there.** There is no release cadence and no
semver promise: a git install resolves to whatever `main` is when you run it.
If that matters, pin the commit —
`pnpm add git+https://github.com/Ludentes/marshal.git#<sha>` — and read
[Status](#status) for what does and does not change here. Adding an entry to
`BLOCKED_KINDS` is the one change that would break a consumer silently, so it
is guarded by a compile-time tie between the const and the union.

## Sixty seconds

Two jobs want one repository. One gets it; the other is told who has it.

```ts
import { pick } from "@ludentes/marshal/pick"

const rank = (jobs) => jobs.map((job) => ({ job, rank: 0, why: { base: 0 } }))

const result = pick({
  jobs: [
    { id: "job-1", needs: ["repo:cms"] },
    { id: "job-2", needs: ["repo:cms"] },
  ],
  capacity: { exclusive: { "repo:cms": {} } },
  rank,
  now: Date.now(),
})

for (const g of result.granted) console.log("granted", g.job.id, g.holds)
for (const r of result.refused) console.log("refused", r.job.id, r.blocked)
```

```
granted job-1 [ 'repo:cms' ]
refused job-2 {
  kind: 'resource-held',
  resource: 'repo:cms',
  by: { id: 'job-1', what: 'job-1', since: '1788175651109' }
}
```

`"repo:cms"` means nothing to Marshal. You name your own resources, hand in
your own clock, and supply your own ranking; the package decides and explains,
and never learns what the strings mean.

## The resource model

Four kinds, and a refusal for each.

| Kind | Question | Refusal |
|---|---|---|
| counting | are all N in use? | `no-capacity`, naming the holders |
| exclusive | is this one taken? | `resource-held`, naming the holder |
| unavailable | may it be taken yet? | `not-ready`, with an optional `until` |
| budget | is there allowance left in **every** window? | `budget-exhausted`, with `resets` |

`pick()` is all-or-nothing per job: one that took two of three resources and
then refused would leak the two, and nothing would release them because no
grant was returned to release. Ranking is injected — an aging curve is policy
wearing mechanism's clothes, and left inside `pick()` every consumer that
disagrees with it forks the package.

## The two layers

Merging these is the mistake most worth naming first, because both are about
"who may go" and they answer different questions.

**`pick()` — which job may start.** Pure: no clock, no filesystem. Capacity is
an argument, so the state lives in your bookkeeping, not in this package.

**`acquirePermit()` — whether this process may run at all.** Lease files and
pid liveness across unrelated OS processes on one machine, over
`openSync(file, "wx")` — **never a TTL**. A job legitimately runs far longer
than any timeout we would dare set, so a TTL either strands the resource after
a crash or steals it from work still in progress. It has no refusal kinds; it
throws `NoPermit`.

Neither half ever queues. A refusal names a holder and returns immediately;
waiting is the caller's decision, made with the caller's information.

## Three things that will bite you

Each of these is a real defect that reached a real system.

**An unpriced job is free.** `pick()` uses `job.cost`, else `cost(job)`, else
zero — and a zero-cost job is admitted by a *completely exhausted* window.
Guessing a number would be a policy, so the package refuses to guess. If you
configured `budget` and never see a refusal, this is why. See
[`cost`](API.md#cost--the-one-that-bites) for the same window answering both
ways.

**`rank` must be a total permutation.** Return every job exactly once or
`pick()` throws. A rank that filters loses a job into neither list, where
nothing can notice it; one that concatenates grants the same job twice.

**Take the process lease from your entry point, not at module scope.** If your
framework evaluates the module twice in one process, the second call finds a
live holder and the process refuses itself. There is deliberately no same-pid
exemption — the lease cannot tell which evaluation is the real one.

## The finding this package exists to carry

On a measured two-lane run, the provider's **weekly** allowance window bound
throughput at roughly 13 jobs per week while every other resource sat idle. The
5-hour window that is easy to mistake for the constraint is **6.7× looser** —
pacing to it drains the week in a day.

That is why `budget` is a *set of windows* rather than a gauge, and why
admission must satisfy every one of them rather than the loosest. It is also
why [`reconcile()`](API.md#reconcilewindows-input-reconciliation) exists: a
budget debited only by the estimate never learns the estimate is wrong, and a
`CostFn` that systematically underestimates keeps granting while the real
window drains. The failure then surfaces as a provider outage rather than as
the admission error it is.

## Status

**Built, not published.** `dist/` is committed and the subpath exports point at
it. That is not a preference: pnpm gates install-time build scripts behind
`onlyBuiltDependencies`, so a `prepare` script would leave a consumer with no
`dist/` and no error. Exports onto TypeScript source do not work either —
measured against an agent runtime that marks anything under `node_modules`
external, where Node then refuses to strip types inside `node_modules` at all.
CI rebuilds `dist/` and fails if it differs from what is committed, and imports
every export in plain Node so an unloadable build cannot pass.

**Generated, not edited.** Galatea holds the authoritative copy at
`scripts/marshal/`, and this repository is regenerated from it by
`git filter-repo` over both the old and the current paths. `upstream` is pure
filter-repo output and only ever fast-forwards; `main` is `upstream` merged
with root-only scaffolding — the two sides touch disjoint paths, so no refresh
has ever needed a force-push.

The practical consequence: an edit made directly to `src/` here is discarded by
the next refresh. Issues and discussion are welcome; a patch to `src/` has to
be applied upstream to survive, so say what should change and why rather than
sending the diff.

## License

MIT. See [LICENSE](LICENSE).
