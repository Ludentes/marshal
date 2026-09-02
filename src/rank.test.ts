// @vitest-environment node
import { describe, expect, it } from "vitest"
import { agingRank } from "./rank"
import type { Job } from "./types"

const at = (
  id: string,
  since: number,
  priority: number,
): Job & {
  since: number
  priority: number
} => ({ id, needs: [], since, priority })

const ranker = agingRank({
  priority: (j) => (j as never as { priority: number }).priority,
  since: (j) => (j as never as { since: number }).since,
  cap: 5,
  interval: 60_000,
})

describe("agingRank", () => {
  it("returns every job exactly once", () => {
    const jobs = [at("a", 0, 1), at("b", 0, 2), at("c", 0, 3)]
    const out = ranker(jobs, 0)
    expect(out.map((r) => r.job.id).sort()).toEqual(["a", "b", "c"])
  })

  it("lifts a waited job above a higher-priority fresh one", () => {
    const now = 10 * 60_000
    const out = ranker([at("fresh", now, 3), at("old", 0, 0)], now)
    expect(out[0]?.job.id).toBe("old")
  })

  it("never lets age exceed the cap", () => {
    const now = 1000 * 60_000
    const out = ranker([at("ancient", 0, 0), at("fresh", now, 6)], now)
    expect(out[0]?.job.id).toBe("fresh")
  })

  it("reports the numbers behind the rank", () => {
    const now = 3 * 60_000
    const out = ranker([at("a", 0, 2)], now)
    expect(out[0]?.why).toEqual({ base: 2, waited: 3 })
  })
})

describe("agingRank polices its caller's contract", () => {
  // Every other module in the package throws on a caller contract broken
  // here: `costOf`, `unitsOf`, `reconcile` and `pick`'s rank-permutation
  // checks. This one did not. The accessors are deliberately untyped, so a
  // job missing the field is a realistic input — and a missing `priority`
  // gave every job `rank: NaN` and `why: {base: NaN, waited: NaN}` with no
  // throw at all. Those NaNs reach `Grant.rank`, the audit record this module
  // exists to produce, and scramble `sort` into implementation-defined order.

  const good = { priority: () => 1, since: () => 0, cap: 5, interval: 60_000 }
  const one: Job[] = [{ id: "a", needs: [] }]

  it("throws when priority does not return a finite number", () => {
    const ranker = agingRank({ ...good, priority: () => Number.NaN })
    expect(() => ranker(one, 0)).toThrow(/priority.*\ba\b/)
  })

  it("throws when since does not return a finite number", () => {
    const ranker = agingRank({ ...good, since: () => Number.NaN })
    expect(() => ranker(one, 0)).toThrow(/since.*\ba\b/)
  })

  it("throws on an interval of zero rather than returning 0/0", () => {
    // `now === since` with `interval: 0` is 0/0, which is NaN, which is the
    // same silent corruption by a different route.
    expect(() => agingRank({ ...good, interval: 0 })).toThrow(/interval/)
  })

  it("throws on a negative interval", () => {
    expect(() => agingRank({ ...good, interval: -1 })).toThrow(/interval/)
  })

  it("throws on a negative cap", () => {
    expect(() => agingRank({ ...good, cap: -1 })).toThrow(/cap/)
  })

  it("throws on a non-finite cap", () => {
    expect(() => agingRank({ ...good, cap: Number.POSITIVE_INFINITY })).toThrow(
      /cap/,
    )
  })

  it("allows a cap of zero, which is aging turned off", () => {
    const ranker = agingRank({ ...good, cap: 0 })
    expect(ranker(one, 10 * 60_000)[0]?.why).toEqual({ base: 1, waited: 0 })
  })
})
