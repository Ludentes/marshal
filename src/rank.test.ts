// @vitest-environment node
import { describe, expect, it } from "vitest"
import { agingRank } from "./rank"
import type { Job } from "./types"

const at = (id: string, since: number, priority: number): Job & {
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
