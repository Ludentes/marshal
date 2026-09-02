// A default ranking, because never-queue trades deadlock for starvation and
// the package that removes the first should not leave the second unanswered.
//
// The POLICY stays injected. `Job` gains no `priority` and no `since` field:
// those are the consumer's vocabulary, and a package that learned them could
// not claim to know nothing about what a job is. Accessors are the seam.
import type { Job, Ranked, RankFn } from "./types"

export interface AgingRankInput {
  priority: (job: Job) => number
  /** When the job was first asked for, in the same clock `pick` is given. */
  since: (job: Job) => number
  /**
   * Ceiling on the aging bonus. Without one, age erases priority. Must be a
   * non-negative finite number; zero is aging turned off.
   */
  cap: number
  /** Clock units per point of bonus. Must be positive and finite. */
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
  // Validated ONCE, here, rather than per job: `cap` and `interval` are
  // properties of the policy, not of any job, and re-checking them inside the
  // loop would report the same fault N times and say nothing more.
  //
  // `interval: 0` is the case worth naming: with `now === since` it computes
  // 0/0, which is NaN, which is the same silent corruption the accessor
  // guards below exist to stop.
  if (!Number.isFinite(o.interval) || o.interval <= 0) {
    throw new Error(
      `agingRank interval must be a positive finite number, got ${o.interval}`,
    )
  }
  if (!Number.isFinite(o.cap) || o.cap < 0) {
    throw new Error(
      `agingRank cap must be a non-negative finite number, got ${o.cap}`,
    )
  }
  return (jobs: Job[], now: number): Ranked[] =>
    jobs
      .map((job) => {
        // The accessors are deliberately untyped — they are the seam where
        // the consumer's vocabulary stays the consumer's — so a job missing
        // the field is a realistic input, not a hypothetical one. It THROWS
        // for the reason `costOf`, `unitsOf` and `pick`'s permutation checks
        // throw: this is the caller breaking its own contract, not a scarcity
        // condition. A NaN rank reaches `Grant.rank`, the audit record this
        // module exists to produce, and scrambles `sort` into
        // implementation-defined order — a wrong answer nobody can see.
        const base = o.priority(job)
        if (!Number.isFinite(base)) {
          throw new Error(
            `priority for job ${job.id} must be a finite number, got ${base}`,
          )
        }
        const at = o.since(job)
        if (!Number.isFinite(at)) {
          throw new Error(
            `since for job ${job.id} must be a finite number, got ${at}`,
          )
        }
        const waited = Math.max(
          0,
          Math.min(o.cap, Math.floor((now - at) / o.interval)),
        )
        return { job, rank: base + waited, why: { base, waited } }
      })
      // `pick()` walks the ORDER, not the number — it does not sort.
      .sort((a, b) => b.rank - a.rank)
}
