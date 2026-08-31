# Marshal

Decides **whether work may start, and records that it decided** — capacity,
exclusivity, order, and a refusal that names its reason. It knows nothing about
agents, and by construction it cannot: `boundary.test.ts` fails the build if any
file here imports anything but `node:` and its own siblings, or if an exported
name carries one of six domain nouns.

Extracted from Galatea, where it runs the admission half of an agent scheduler.

## The resource model

Four kinds, and a refusal for each.

| Kind | Question | Refusal |
|---|---|---|
| counting | are all N in use? | `no-capacity`, naming the holders |
| exclusive | is this one taken? | `resource-held`, naming the holder |
| unavailable | may it be taken yet? | `not-ready`, with an optional `until` |
| budget | is there allowance left in **every** window? | `budget-exhausted`, with `resets` |

`pick()` is all-or-nothing: a job that took two of three resources and then
refused would leak the two, and nothing would release them because no grant was
returned to release. Ranking is injected — an aging curve is policy wearing
mechanism's clothes, and left inside `pick()` every consumer that disagrees
with it forks the package.

`permit.ts` is the enforcement half: at most N holders of one named resource
across unrelated processes on one box, over `openSync(file, "wx")` and **pid
liveness, never a TTL**. A job legitimately runs far longer than any timeout we
would dare set, so a TTL either strands the resource after a crash or steals it
from work still in progress.

Neither half ever queues. A refusal names a holder and returns immediately;
waiting is the caller's decision, made with the caller's information.

## The finding this package exists to carry

On a measured two-lane run, the provider's **weekly** allowance window bound
throughput at roughly 13 jobs per week while every other resource sat idle. The
5-hour window that is easy to mistake for the constraint is **6.7× looser** —
pacing to it drains the week in a day.

That is why `budget` is a *set of windows* rather than a gauge, and why
admission must satisfy every one of them rather than the loosest.

## Example: what a consumer supplies

A consumer names its own resources and hands in its own clock, rank and cost
functions. Marshal never learns what the strings mean.

```ts
import { pick } from "@ludentes/marshal/pick"

const result = pick({
  jobs: [{ id: "job-1", needs: ["repo:cms", "provider"] }],
  capacity: {
    exclusive: { "repo:cms": {} },
    budget: {
      provider: [
        { name: "week", limit: 13, spent: 11, resets: 1756000000 },
      ],
    },
  },
  rank: (jobs) => jobs.map((job) => ({ job, rank: 0, why: { base: 0 } })),
  now: Date.now(),
})
```

That specifier is the package's declared export, not an npm coordinate —
see [Status](#status).

## Status

**Not on npm, but built.** `package.json` keeps `"private": true` so an
accidental `npm publish` fails rather than succeeds. Install it from this
repository:

```bash
pnpm add git+https://github.com/Ludentes/marshal.git
```

`dist/` is **committed**, and the subpath exports point at it. That is not a
preference: pnpm gates install-time build scripts behind
`onlyBuiltDependencies`, so a `prepare` script would leave a consumer with no
`dist/` and no error. Exports onto TypeScript source do not work either —
measured against an agent runtime that marks anything under `node_modules`
external, where Node then refuses to strip types inside `node_modules` at all.
CI rebuilds `dist/` and fails if it differs from what is committed, and imports
every export in plain Node so an unloadable build cannot pass.

**A worked reference.** [`Ludentes/sieve`](https://github.com/Ludentes/sieve)
uses this package to admit concurrent agent sessions against a shared
workspace.

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
