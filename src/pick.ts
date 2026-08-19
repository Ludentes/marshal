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

export interface Capacity {
  counting?: Record<string, CountingState>
  exclusive?: Record<string, { by?: Holder }>
  /** A resource that exists but is not takeable yet. Breakers land here. */
  unavailable?: Record<string, { until?: number }>
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
  now: number
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
