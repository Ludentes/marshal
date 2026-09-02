// A default ranking, because never-queue trades deadlock for starvation and
// the package that removes the first should not leave the second unanswered.
//
// The POLICY stays injected. `Job` gains no `priority` and no `since` field:
// those are the consumer's vocabulary, and a package that learned them could
// not claim to know nothing about what a job is. Accessors are the seam.
import type { Job, RankFn, Ranked } from "./types"

export interface AgingRankInput {
  priority: (job: Job) => number
  /** When the job was first asked for, in the same clock `pick` is given. */
  since: (job: Job) => number
  /** Ceiling on the aging bonus. Without one, age erases priority. */
  cap: number
  /** Clock units per point of bonus. */
  interval: number
}

/**
 * `effective = priority + min(cap, floor(waited / interval))`, descending.
 *
 * The cap is not decoration. Uncapped, a long-waiting job eventually outranks
 * everything and priority stops meaning anything; capped, it climbs a bounded
 * amount and then holds, which is enough to guarantee it is eventually
 * considered before any job of equal base priority.
 *
 * Returns every job exactly once — the contract `pick()` polices, asserted by
 * this module's own test rather than assumed.
 */
export function agingRank(o: AgingRankInput): RankFn {
  return (jobs: Job[], now: number): Ranked[] =>
    jobs
      .map((job) => {
        const base = o.priority(job)
        const waited = Math.max(
          0,
          Math.min(o.cap, Math.floor((now - o.since(job)) / o.interval)),
        )
        return { job, rank: base + waited, why: { base, waited } }
      })
      // `pick()` walks the ORDER, not the number — it does not sort.
      .sort((a, b) => b.rank - a.rank)
}
