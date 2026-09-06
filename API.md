# Marshal API

Four subpath exports. There is no barrel and no default export — import the
module you need.

```ts
import { pick, reconcile } from "@opcheese/marshal/pick"
import { acquirePermit, NoPermit, permitFile } from "@opcheese/marshal/permit"
import { agingRank } from "@opcheese/marshal/rank"
import { BLOCKED_KINDS } from "@opcheese/marshal/types"
import type {
  Blocked, Holder, Job, Need, RankFn, CostFn,
} from "@opcheese/marshal/types"
```

**ESM, and verified on Node 20, 22 and 24.** No dependencies: the package
imports nothing outside `node:`, and `boundary.test.ts` fails the build if that
changes.

A CommonJS consumer can `require()` these subpaths on Node 22 and later, where
Node supports requiring an ES module. On Node 20 it raises `ERR_REQUIRE_ESM` —
import it instead, or upgrade.

Every example below is executable as written, and its output is what it
actually printed.

---

## `@opcheese/marshal/pick`

### `pick(input: PickInput): PickResult`

Decides which of the offered jobs may start, given the capacity the caller
describes. Pure: no clock, no filesystem, no logging, no I/O. It never queues —
a refusal comes back immediately and waiting is your decision.

```ts
interface PickInput {
  jobs: Job[]
  capacity: Capacity
  rank: RankFn
  /** Your clock, your units. Compared against `resets` and `until`. */
  now: number
  cost?: CostFn
}

interface PickResult {
  granted: Grant[]
  refused: Refusal[]
}

interface Grant {
  job: Job
  /** The resource names this job now holds, deduplicated. */
  holds: string[]
  /** Effective priority at grant, for the audit record. */
  rank: number
}

interface Refusal {
  job: Job
  blocked: Blocked
}
```

`granted.length + refused.length === jobs.length`, always. A job appears in
exactly one of the two lists, which is what makes it safe to re-ask with what
you were told.

**Every job in one call is decided against the same capacity, and grants are
debited as the pass proceeds** — so two jobs wanting the same exclusive
resource contend inside a single `pick()`:

```ts
import { pick } from "@opcheese/marshal/pick"

const rank = (jobs) => jobs.map((job) => ({ job, rank: 0, why: { base: 0 } }))

const result = pick({
  jobs: [
    { id: "job-1", needs: [{ resource: "repo:cms" }] },
    { id: "job-2", needs: [{ resource: "repo:cms" }] },
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
  by: { id: 'job-1', what: 'job-1', since: '1788780461390' }
}
```

The holder Marshal invents for a job granted in the same pass has `what` equal
to the job's id and `since` equal to stringified `now`. That is genuinely all
this package knows: a richer description would have to come from your
vocabulary, which is the one thing that may not cross this boundary.

**Asking does not charge you.** `pick` copies every window and holder list
before touching them, so calling it to find out whether a job *would* be
admitted leaves your own state untouched. Applying the decision is your step.

#### Throws

`pick` throws — rather than refusing — when the caller breaks its own
contract, because there is no honest `Blocked` for "you passed nonsense".

| Condition | Message |
|---|---|
| `rank` dropped a job | `rank() must return every job it was given; it dropped b` |
| `rank` returned one twice | `rank() must return each job exactly once; it returned a twice` |
| a cost is not finite | `cost for job X on "Y" must be a finite number, got NaN` |
| a cost is negative | `cost for job X on "Y" must not be negative, got -1` |
| `units` is not a positive integer | `units for "Y" must be a positive integer, got 0` |
| one job asks for a resource two ways | `job X asks for "Y" two different ways; a resource may appear once per job` |

The first two are the same defect seen from two sides, and both are silent
corruption if allowed through: a dropped job is neither run nor refused and
nobody can notice, and a duplicated one is granted twice — two holders, a
double budget debit, and a job the consumer may launch twice.

### `capacity` — the four kinds

Every map is optional. A resource name may appear in more than one, and **all
of them are checked**: a name that is both budgeted and rate-limited has both
limits enforced.

```ts
interface Capacity {
  counting?: Record<string, { limit: number; holders: CountingHolder[] }>
  exclusive?: Record<string, { by?: Holder }>
  unavailable?: Record<string, { until?: number }>
  budget?: Record<string, BudgetWindow[]>
}
```

| Kind | Question it answers | Refusal |
|---|---|---|
| `counting` | are all N in use? | `no-capacity`, naming every holder |
| `exclusive` | is this one taken? | `resource-held`, naming the holder |
| `unavailable` | may it be taken yet? | `not-ready`, with an optional `until` |
| `budget` | is there allowance left in **every** window? | `budget-exhausted`, with `resets` |

**A name in no map at all is refused `not-ready` with no `until`.** Granting it
would hand out something nothing counts, so a typo fails closed. A name
declared *only* in `unavailable` whose window has passed is a different thing
and is granted: you told Marshal about it and told it no allocation limit
applies, which is what a bare circuit breaker on an unmetered provider looks
like.

**The count lives in the state, not in repeated entries.** A counting
resource's `holders` is `{ holder, units }[]`, so one holder taking three units
is one record saying three — not three identical records. N identical `Holder`
entries are indistinguishable, and a release removing "the holder whose id is
A" removes one of them and leaks the rest, silently lowering the limit for the
life of the process.

**A repeated name in `needs` is one resource, not two.** Two bare
`{ resource: "lane" }` entries hold one lane and debit one unit. Two entries
that *disagree* — one asking two units, one asking one — throw: the package
will not pick a winner between two things you said.

```ts
pick({
  jobs: [
    { id: "big", needs: [{ resource: "lane", units: 2 }] },
    { id: "small", needs: [{ resource: "lane" }] },
  ],
  capacity: { counting: { lane: { limit: 2, holders: [] } } },
  rank,
  now,
})
```

```
granted big [ 'lane' ]
refused small {
  kind: 'no-capacity',
  resource: 'lane',
  holders: [ { id: 'big', what: 'big', since: '1788780461390' } ]
}
```

### `BudgetWindow`

```ts
interface BudgetWindow {
  name: string
  limit: number
  spent: number
  /** When this window replenishes. Your clock, your units. */
  resets: number
}
```

A resource carries a *set* of windows and admission must satisfy **every** one.
See [the finding](README.md#the-finding-this-package-exists-to-carry) for why
this is a set rather than a gauge. When several windows are short, the refusal
reports the **latest** `resets` among them — telling an operator to retry in
five hours while the weekly allowance is gone is worse than saying nothing.

### `cost` — the one that bites

**An unpriced job is free.** A need is priced by its own `amount`, else by
`cost(job, resource)`, else **zero** — and a zero-cost job is admitted by a
completely exhausted window, because `spent + 0 > limit` is false. Guessing a
number here would be a policy, so the package refuses to guess; the consequence
is that a budget you never priced never binds.

`cost` takes the **resource** as well as the job, because one job may need two
budgets in different denominations — tokens and emails — and one number cannot
be right for both. A price is computed once per resource per job and reused for
the check and the debit, so those two can never disagree.

```ts
const capacity = {
  budget: {
    provider: [
      { name: "week", limit: 13, spent: 13, resets: now + 604_800_000 },
      { name: "5h", limit: 87, spent: 3, resets: now + 18_000_000 },
    ],
  },
}
const jobs = [{ id: "job-1", needs: [{ resource: "provider" }] }]

// No cost: priced at zero, so a FULL window still admits it.
pick({ jobs, capacity, rank, now }).granted.length        // 1

// With a cost, the tightest window binds.
pick({ jobs, capacity, rank, now, cost: () => 1 }).refused[0].blocked

// Or price the need itself, with no CostFn at all — same refusal.
pick({
  jobs: [{ id: "job-1", needs: [{ resource: "provider", amount: 1 }] }],
  capacity, rank, now,
}).refused[0].blocked
```

```
without cost: 1 granted
with cost:    {
  kind: 'budget-exhausted',
  resource: 'provider',
  resets: 1788780461390
}
```

Same exhausted window, opposite answers. If you configure `budget` and never
see a refusal, this is why.

### `reconcile(windows, input): Reconciliation`

Settles an estimate against what a job actually cost. This is the difference
between a thermostat and a thermometer: a budget debited only by the estimate
never learns the estimate is wrong, so a `CostFn` that systematically
underestimates keeps granting while the real window drains — and the failure
surfaces as a provider outage rather than as the admission error it is.

```ts
interface ReconcileInput {
  estimated: number
  actual: number
  /** Fractional drift above which you are told. 0.5 is 50% out. */
  tolerance: number
}

interface Reconciliation {
  windows: BudgetWindow[]
  /** |actual - estimated| / estimated, as a fraction. */
  drift: number
  beyondTolerance: boolean
}
```

```ts
import { reconcile } from "@opcheese/marshal/pick"

const windows = [{ name: "week", limit: 13, spent: 5, resets: now + 604_800_000 }]

// Admission charged 1. The job actually cost 3.
const settled = reconcile(windows, { estimated: 1, actual: 3, tolerance: 0.5 })
console.log("spent now:", settled.windows[0].spent)
console.log("drift:", settled.drift, "beyondTolerance:", settled.beyondTolerance)
console.log("original untouched:", windows[0].spent)
```

```
spent now: 7
drift: 2 beyondTolerance: true
original untouched: 5
```

New windows are returned rather than the input edited, for the same reason
`pick` copies: you decide what to persist.

Three behaviours worth knowing, each of which was once a bug:

- `spent` is **clamped at zero**. An overestimate larger than anything ever
  debited would otherwise manufacture allowance out of a bookkeeping error.
- A **non-finite** `estimated` or `actual` changes nothing and reports
  `drift: 1, beyondTolerance: true`. A NaN actual used to write `spent: NaN`
  into every window while reporting the estimate as within tolerance.
- `estimated: 0` with a non-zero `actual` reports `beyondTolerance: true`
  regardless of the tolerance you set. `drift` reports 1 to stay finite and
  comparable, but the flag does not rest on the comparison — at
  `tolerance: 1`, which a coarse estimator would plausibly set, the case that
  most needs reporting was the one silently passing.

---

## `@opcheese/marshal/permit`

The **other** layer, and the one most often merged with `pick()` by mistake.
`pick` decides which job may start, from capacity you describe, inside one
process. `acquirePermit` decides whether **this process** may run at all,
against unrelated OS processes on one machine, over lease files.

It has no refusal kinds. It throws.

### `acquirePermit(input: AcquirePermitInput): Permit`

```ts
interface AcquirePermitInput {
  dir: string
  /** File-name-safe already; this module does not sanitise it. */
  key: string
  permits: number
  holder: PermitHolder
  probes?: PermitProbes
}

interface PermitHolder {
  pid: number
  /** What the holder is doing, in the words a waiting operator needs. */
  what: string
  since: string
  /** The resource, echoed into the file for anyone reading it by hand. */
  scope: string
}

interface Permit {
  readonly holder: PermitHolder
  /** Which slot this is, 0-based. Pass it to children. */
  readonly slot: number
  /** Idempotent, and a no-op once somebody else holds this slot. */
  release(): void
}
```

Walks slots in order and takes the lowest free one, so at `permits: 1` this is
plain single-lease behaviour and above one the slot index is stable enough to
name in a log.

**Liveness is a pid, never a TTL.** A job legitimately runs far longer than any
timeout you would dare set, so a TTL either strands the resource after a crash
or steals it from work still in progress. A dead holder's claim is free
immediately; a live holder's claim is honoured indefinitely.

```ts
import { acquirePermit, NoPermit, permitFile } from "@opcheese/marshal/permit"

const holder = (what) => ({
  pid: process.pid,
  what,
  since: new Date().toISOString(),
  scope: "deploy",
})

const first = acquirePermit({ dir, key: "deploy", permits: 1, holder: holder("deploying v2") })
console.log("took slot", first.slot)

try {
  acquirePermit({ dir, key: "deploy", permits: 1, holder: holder("deploying v3") })
} catch (error) {
  if (!(error instanceof NoPermit)) throw error
  console.log("refused:", error.message)
  console.log("waiting for:", error.holder.what, "pid", error.holder.pid)
}

first.release()
```

```
took slot 0
refused: all 1 permit(s) for deploy are held; the last is deploying v2 (pid 3722017, since 2026-08-31T11:27:51.574Z). Not waiting.
waiting for: deploying v2 pid 3722017
after release, took slot 0
```

**Do not call this at module scope in a framework whose runtime evaluates your
module more than once.** Two evaluations in one process are two claims on a
resource that admits one, and the second throws `NoPermit` — the process
refuses itself. There is deliberately no same-pid exemption: the lease cannot
tell which of the two evaluations is the real one. Call it from your process
entry point.

### `NoPermit`

```ts
class NoPermit extends Error {
  /** Whoever held the LAST slot tried — somebody concrete to wait for. */
  readonly holder: PermitHolder
  readonly permits: number
}
```

### `permitFile(dir, key, slot): string`

The path a given slot uses. Slot 0 has **no suffix**, deliberately: it is what
makes a rolling deploy safe, because a process running older single-lease code
contends on the same file rather than sailing past it into a second concurrent
writer. Suffixes start at 1 and exist only above one permit.

> The current filename carries an `.eve-host-lease-` prefix, inherited from the
> system Marshal was extracted from. It is on-disk format, so changing it would
> break exactly the rolling-deploy compatibility the no-suffix rule protects.
> Use `permitFile()` rather than constructing the path yourself.

### `PermitProbes`

```ts
interface PermitProbes {
  isAlive?: (pid: number) => boolean
  log?: (message: string) => void
}
```

Seams for tests and for observability. Overriding `isAlive` is how the reclaim
path is tested without killing real processes.

---

## `@opcheese/marshal/rank`

### `agingRank(input: AgingRankInput): RankFn`

A ready-made ranking, because never-queue trades deadlock for starvation and
the package that removes the first should not leave the second unanswered. It
lives in its own module rather than inside `pick()` so that taking it is a
decision: the curve is policy, and a consumer who disagrees should be able to
not import it rather than fork the package.

```ts
interface AgingRankInput {
  priority: (job: Job) => number
  /** When the job was first asked for, in the same clock `pick` is given. */
  since: (job: Job) => number
  /** Ceiling on the aging bonus. Zero turns aging off. */
  cap: number
  /** Clock units per point of bonus. */
  interval: number
}
```

`effective = priority + min(cap, floor(waited / interval))`, descending, with
raw elapsed time as the tiebreak beneath it — oldest first.

**`Job` gains no `priority` and no `since` field.** Those are your vocabulary,
and a package that learned them could not claim to know nothing about what a
job is. The accessors are the seam.

```ts
import { agingRank } from "@opcheese/marshal/rank"

const rank = agingRank({
  priority: (job) => job.p,
  since: (job) => job.at,
  cap: 5,
  interval: 60_000,
})

const jobs = [
  { id: "urgent", p: 3, at: now, needs: [] },
  { id: "waiting", p: 0, at: now - 600_000, needs: [] },
]

for (const r of rank(jobs, now)) console.log(r.job.id, r.rank, r.why)
```

```
waiting 5 { base: 0, waited: 5 }
urgent 3 { base: 3, waited: 0 }
```

Ten minutes of waiting at `interval: 60_000` earns ten points of bonus, capped
at five — enough to overtake a priority of three.

**The cap is not decoration.** Uncapped, a long-waiting job eventually outranks
everything and priority stops meaning anything. But the cap alone does not
guarantee a waiting job is eventually considered: past `cap * interval` two
jobs of equal base priority have identical ranks, and their order falls back to
`sort` stability — the order you handed in, which out of a map iteration or a
directory listing is not FIFO. The elapsed-time tiebreak is what restores the
guarantee, and it sits *beneath* the rank so age still cannot erase priority.

#### Throws

Like `pick`, on the caller breaking its own contract rather than on scarcity.
`cap` and `interval` are validated once when the `RankFn` is built, because
they are properties of the policy and re-checking them per job would report one
fault N times.

| Condition | Message |
|---|---|
| `interval` not positive and finite | `agingRank interval must be a positive finite number, got 0` |
| `cap` negative or not finite | `agingRank cap must be a non-negative finite number, got -1` |
| `now` not finite | `agingRank now must be a finite number, got NaN` |
| `priority(job)` not finite | `priority for job X must be a finite number, got undefined` |
| `since(job)` not finite | `since for job X must be a finite number, got undefined` |

The accessors are deliberately untyped — they are the seam where your
vocabulary stays yours — so a job missing the field is a realistic input, not a
hypothetical one. A NaN rank reaches `Grant.rank`, the audit record this module
exists to produce, and scrambles `sort` into implementation-defined order: a
wrong answer nobody can see.

---

## `@opcheese/marshal/types`

The vocabulary, kept apart from the algorithm so a consumer that only needs to
*read* a refusal does not import the decision procedure.

```ts
/** Whoever holds a resource. Opaque to this package. */
interface Holder {
  /** Your identifier, echoed back untouched. */
  id: string
  /** What the holder is doing, in the words a waiting operator needs. */
  what: string
  since: string
}

/** A unit of work asking for resources. */
interface Job {
  id: string
  needs: Need[]
}

/**
 * One resource a job asks for, and how much of it. A bare `{ resource }` is
 * one unit at whatever the injected CostFn says the resource costs.
 */
interface Need {
  /** An opaque name. Marshal never learns what it means. */
  resource: string
  /** Counting resources: units to take. Default 1. */
  units?: number
  /** Consumable resources: amount to debit. Overrides CostFn. */
  amount?: number
}

/** How much of a counting resource one holder has. */
interface CountingHolder {
  holder: Holder
  units: number
}

type Blocked =
  | { kind: "no-capacity"; resource: string; holders: Holder[] }
  | { kind: "resource-held"; resource: string; by: Holder }
  | { kind: "not-ready"; resource: string; until?: number }
  | { kind: "budget-exhausted"; resource: string; resets: number }
  | { kind: "custom"; tag: string; detail: unknown }

/** Adding an entry is a breaking change. */
const BLOCKED_KINDS = [
  "no-capacity", "resource-held", "not-ready", "budget-exhausted", "custom",
] as const
```

`Blocked` is a discriminated union, so narrow on `kind` before reading the
fields — they differ per arm, and that is the point: a refusal carries what you
need to act on *that* refusal.

`custom` is a construct-only escape hatch for consumers. `pick()` never returns
it.

### `RankFn` and `CostFn`

```ts
type RankFn = (jobs: Job[], now: number) => Ranked[]
type CostFn = (job: Job, resource: string) => number

interface Ranked {
  job: Job
  rank: number
  why: RankWhy
}

/** The numbers behind a rank, so a grant can be explained after the fact. */
interface RankWhy {
  base: number
  waited?: number
  note?: string
}
```

Descending by `rank`. A rank *function* rather than a comparator because
observability requires logging effective priority at grant, and a two-argument
comparator cannot produce that number.

Both are injected rather than built in. `effective = priority + min(CAP,
floor(waited / INTERVAL))` is policy wearing mechanism's clothes: left inside
`pick()`, every consumer that disagrees with the aging curve forks the package.

A one-argument `CostFn` stays assignable to the two-argument type, so a
consumer that ignores `resource` keeps compiling and keeps pricing every budget
alike. That is convenient and it is a trap: nothing in the toolchain will tell
you the second denomination is wrong. Spell both parameters even when you
ignore the second.

The simplest legal rank — order preserved, nothing prioritised:

```ts
const rank = (jobs) => jobs.map((job) => ({ job, rank: 0, why: { base: 0 } }))
```

For one that actually ages, see
[`agingRank`](#agingrankinput-agingrankinput-rankfn).

`why` is not decoration. It is what lets you answer "why did that job go
first?" a week later, and `pick` returns the effective `rank` on every `Grant`
for the same reason.
