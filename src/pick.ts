// The decision, and nothing else. Pure: no clock, no filesystem, no logging.
// `permit.ts` is the enforcement half — it wins a slot against other processes
// — and this is the admission half, which decides who should try.
//
// NEVER QUEUE, inherited from permit.ts: a refusal names a holder and returns
// immediately. Waiting is the caller's decision, made with its own information.
import type { Blocked, CostFn, Holder, Job, RankFn } from "./types"

export interface CountingState {
  limit: number
  holders: Holder[]
}

/**
 * One replenishing allowance over one resource.
 *
 * Several of these cover a single resource, because a provider publishes more
 * than one and they disagree about what is scarce. Measured 2026-08-18: the
 * weekly window bound 6.7x harder than the 5-hour one, and pacing to the
 * 5-hour figure would have drained the week in a day.
 */
export interface BudgetWindow {
  name: string
  limit: number
  spent: number
  /** When this window replenishes. The caller's clock, the caller's units. */
  resets: number
}

export interface Capacity {
  counting?: Record<string, CountingState>
  exclusive?: Record<string, { by?: Holder }>
  /** A resource that exists but is not takeable yet. Breakers land here. */
  unavailable?: Record<string, { until?: number }>
  /** A set of windows per resource. Admission must satisfy every one. */
  budget?: Record<string, BudgetWindow[]>
}

export interface PickInput {
  jobs: Job[]
  capacity: Capacity
  rank: RankFn
  now: number
  cost?: CostFn
}

export interface Grant {
  job: Job
  holds: string[]
  /** Effective priority at grant, for the audit record. */
  rank: number
}

export interface Refusal {
  job: Job
  blocked: Blocked
}

export interface PickResult {
  granted: Grant[]
  refused: Refusal[]
}

interface Working {
  counting: Map<string, CountingState>
  exclusive: Map<string, Holder | undefined>
  unavailable: Record<string, { until?: number }>
  budget: Map<string, BudgetWindow[]>
  cost?: CostFn
  now: number
}

/** An unpriced job is free. Guessing a number here would be a policy. */
function costOf(job: Job, cost?: CostFn): number {
  return job.cost ?? cost?.(job) ?? 0
}

/**
 * `what` is the job's own id because that is genuinely all this package
 * knows. Marshal is forbidden from understanding what a job *is* — that
 * knowledge is the consumer's, and a richer description would have to come
 * from the consumer's vocabulary, which is the one thing that may not cross
 * this boundary. `since` is stringified `now` for the same reason: there is
 * no clock here to format.
 */
function asHolder(job: Job, now: number): Holder {
  return { id: job.id, what: job.id, since: String(now) }
}

/** The first reason this job cannot run, or undefined if it can. */
function firstBlocker(job: Job, w: Working): Blocked | undefined {
  for (const resource of job.needs) {
    const gate = w.unavailable[resource]
    if (gate && (gate.until === undefined || gate.until > w.now)) {
      return { kind: "not-ready", resource, until: gate.until }
    }

    if (w.exclusive.has(resource)) {
      const by = w.exclusive.get(resource)
      if (by) return { kind: "resource-held", resource, by }
      continue
    }

    const budget = w.budget.get(resource)
    if (budget) {
      const price = costOf(job, w.cost)
      // Every window, not the loosest. The tightest one is the allowance; the
      // others are burst limits, and satisfying only a burst limit is how a
      // scheduler sprints into a wall on day two.
      const short = budget.filter((win) => win.spent + price > win.limit)
      if (short.length > 0) {
        // The LATEST reset among the short windows, not the first one found.
        // `find` would answer whichever the array happened to list first, so
        // an operator told "retry in five hours" while the weekly allowance is
        // gone comes back to the same refusal. That is the loose-window error
        // this whole kind exists to prevent, one level further down.
        const resets = short.reduce(
          (late, win) => Math.max(late, win.resets),
          0,
        )
        return { kind: "budget-exhausted", resource, resets }
      }
      continue
    }

    const counted = w.counting.get(resource)
    if (counted) {
      if (counted.holders.length >= counted.limit) {
        // Handed out by reference on purpose, after checking it is not
        // observable: `holders` only grows, so once it reaches `limit` no
        // later job can clear this check for the same resource, and `w` is
        // discarded when `pick` returns. A defensive copy here was written
        // first, along with a test for it — the test could not be made to
        // fail, which is what proved the copy was mechanism nobody needed.
        return { kind: "no-capacity", resource, holders: counted.holders }
      }
      continue
    }

    // Reaching here means the name is in no capacity map at all. (A resource
    // listed only in `unavailable`, whose window has passed, is deliberately
    // let through: a breaker that has cleared is not a resource to allocate.)
    // Granting an untracked name would hand out something nothing counts, so
    // it is refused as not-ready with no return time.
    if (!gate) return { kind: "not-ready", resource }
  }
  return undefined
}

/** Called only after {@link firstBlocker} cleared every need. */
function consume(job: Job, w: Working): void {
  for (const resource of job.needs) {
    if (w.exclusive.has(resource)) {
      w.exclusive.set(resource, asHolder(job, w.now))
      continue
    }
    const budget = w.budget.get(resource)
    if (budget) {
      const price = costOf(job, w.cost)
      for (const win of budget) win.spent += price
      continue
    }
    const counted = w.counting.get(resource)
    if (counted) counted.holders.push(asHolder(job, w.now))
  }
}

/**
 * Rank the jobs, then walk them in that order taking all-or-nothing.
 *
 * The ORDER `rank` returns is the contract. `pick` does not sort, and the
 * `rank` number it records is for the audit trail only — see the test named
 * "honours the returned order even when the numbers disagree with it". A
 * defensive sort added later on the assumption that the number orders the
 * walk would silently change who gets granted.
 *
 * All-or-nothing matters: a job that took two of its three resources and then
 * refused would leak the two, and nothing would ever release them because no
 * grant was returned to release.
 */
export function pick(i: PickInput): PickResult {
  const w: Working = {
    counting: new Map(
      Object.entries(i.capacity.counting ?? {}).map(([name, c]) => [
        name,
        { limit: c.limit, holders: [...c.holders] },
      ]),
    ),
    exclusive: new Map(
      Object.entries(i.capacity.exclusive ?? {}).map(([name, e]) => [
        name,
        e.by,
      ]),
    ),
    unavailable: i.capacity.unavailable ?? {},
    // Copied per window: `spent` is incremented in place, so without this,
    // asking whether a job would be admitted charges the caller for it.
    budget: new Map(
      Object.entries(i.capacity.budget ?? {}).map(([name, wins]) => [
        name,
        wins.map((win) => ({ ...win })),
      ]),
    ),
    cost: i.cost,
    now: i.now,
  }

  const granted: Grant[] = []
  const refused: Refusal[] = []

  for (const { job, rank } of i.rank(i.jobs, i.now)) {
    const blocked = firstBlocker(job, w)
    if (blocked) {
      refused.push({ job, blocked })
      continue
    }
    consume(job, w)
    granted.push({ job, holds: [...job.needs], rank })
  }

  return { granted, refused }
}

export interface ReconcileInput {
  estimated: number
  actual: number
  /** Fractional drift above which the caller is told. 0.5 is 50% out. */
  tolerance: number
}

export interface Reconciliation {
  windows: BudgetWindow[]
  /** |actual - estimated| / estimated, as a fraction. */
  drift: number
  beyondTolerance: boolean
}

/**
 * Settle an estimate against what a job actually cost.
 *
 * This is the difference between a thermostat and a thermometer. A budget
 * debited only by the estimate never learns the estimate is wrong: a CostFn
 * that systematically underestimates keeps granting while the real window
 * drains, and the failure surfaces as a provider outage rather than as the
 * admission error it is.
 *
 * Returns new windows rather than editing the ones handed in, for the same
 * reason `pick` copies: the caller decides what to persist.
 */
export function reconcile(
  windows: BudgetWindow[],
  i: ReconcileInput,
): Reconciliation {
  const correction = i.actual - i.estimated
  const settled = windows.map((w) => ({
    ...w,
    // Never below zero: an overestimate larger than anything ever debited
    // would otherwise manufacture allowance out of a bookkeeping error.
    spent: Math.max(0, w.spent + correction),
  }))
  // A zero estimate that cost anything is infinitely wrong; reporting 1 keeps
  // the number finite and still trips any tolerance a caller would set.
  const drift =
    i.estimated === 0
      ? i.actual === 0
        ? 0
        : 1
      : Math.abs(correction) / i.estimated
  return { windows: settled, drift, beyondTolerance: drift > i.tolerance }
}
