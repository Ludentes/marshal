// @vitest-environment node
import { describe, expect, it } from "vitest"
import { pick } from "./pick"
import type { Job, RankFn } from "./types"

const job = (id: string, ...needs: string[]): Job => ({ id, needs })

/** Simplest possible policy: the order given. Ranking is the consumer's. */
const asGiven: RankFn = (jobs) =>
  jobs.map((j, index) => ({
    job: j,
    rank: jobs.length - index,
    why: { base: jobs.length - index },
  }))

describe("pick", () => {
  it("grants up to a counting resource's limit and refuses by name", () => {
    const result = pick({
      jobs: [job("a", "lane"), job("b", "lane"), job("c", "lane")],
      capacity: {
        counting: {
          lane: {
            limit: 2,
            holders: [],
          },
        },
      },
      rank: asGiven,
      now: 1000,
    })
    expect(result.granted.map((g) => g.job.id)).toEqual(["a", "b"])
    expect(result.refused).toHaveLength(1)
    const blocked = result.refused[0]?.blocked
    expect(blocked?.kind).toBe("no-capacity")
    if (blocked?.kind === "no-capacity") {
      expect(blocked.resource).toBe("lane")
      // "all lanes are full" with no name leaves an operator nothing to wait
      // for, which is the refusal quality permit.ts already insists on.
      expect(blocked.holders.map((h) => h.id)).toEqual(["a", "b"])
    }
  })

  it("counts holders that were already there", () => {
    const result = pick({
      jobs: [job("a", "lane")],
      capacity: {
        counting: {
          lane: {
            limit: 1,
            holders: [{ id: "z", what: "already running", since: "earlier" }],
          },
        },
      },
      rank: asGiven,
      now: 1000,
    })
    expect(result.granted).toEqual([])
    expect(result.refused[0]?.blocked.kind).toBe("no-capacity")
  })

  it("gives an exclusive resource to one job and names the holder", () => {
    const result = pick({
      jobs: [job("a", "repo:cms"), job("b", "repo:cms")],
      capacity: { exclusive: { "repo:cms": {} } },
      rank: asGiven,
      now: 1000,
    })
    expect(result.granted.map((g) => g.job.id)).toEqual(["a"])
    const blocked = result.refused[0]?.blocked
    expect(blocked?.kind).toBe("resource-held")
    if (blocked?.kind === "resource-held") expect(blocked.by.id).toBe("a")
  })

  it("refuses an unavailable resource with the time it comes back", () => {
    const result = pick({
      jobs: [job("a", "provider")],
      capacity: { unavailable: { provider: { until: 5000 } } },
      rank: asGiven,
      now: 1000,
    })
    const blocked = result.refused[0]?.blocked
    expect(blocked?.kind).toBe("not-ready")
    if (blocked?.kind === "not-ready") expect(blocked.until).toBe(5000)
  })

  it("lets an unavailable resource through once its time has passed", () => {
    const result = pick({
      jobs: [job("a", "provider")],
      capacity: {
        unavailable: { provider: { until: 5000 } },
        counting: { provider: { limit: 1, holders: [] } },
      },
      rank: asGiven,
      now: 6000,
    })
    expect(result.granted.map((g) => g.job.id)).toEqual(["a"])
  })

  it("refuses a resource it has never heard of rather than assuming it is free", () => {
    // Silently granting an unknown name is how a scheduler hands out something
    // nobody is tracking. A refusal is recoverable; a phantom grant is not.
    const result = pick({
      jobs: [job("a", "mystery")],
      capacity: {},
      rank: asGiven,
      now: 1000,
    })
    const blocked = result.refused[0]?.blocked
    expect(blocked?.kind).toBe("not-ready")
    if (blocked?.kind === "not-ready") {
      expect(blocked.resource).toBe("mystery")
      expect(blocked.until).toBeUndefined()
    }
  })

  it("takes all of a job's needs or none of them", () => {
    const result = pick({
      jobs: [job("a", "lane", "repo:cms"), job("b", "lane")],
      capacity: {
        // Exactly one lane, so the leak is observable. At limit 2 this test
        // passes whether or not `a` leaks one on its way out, because `b`
        // still finds room — it would assert its own name and check nothing.
        counting: { lane: { limit: 1, holders: [] } },
        exclusive: {
          "repo:cms": { by: { id: "z", what: "held", since: "x" } },
        },
      },
      rank: asGiven,
      now: 1000,
    })
    // `a` is refused on the repo, and must NOT have consumed a lane on its way
    // out — a half-taken job leaks capacity that nothing will ever release.
    expect(result.granted.map((g) => g.job.id)).toEqual(["b"])
    expect(result.refused[0]?.blocked.kind).toBe("resource-held")
  })

  it("follows the rank function's order, not the array's", () => {
    const reversed: RankFn = (jobs) =>
      [...jobs].reverse().map((j, index) => ({
        job: j,
        rank: jobs.length - index,
        why: { base: jobs.length - index },
      }))
    const result = pick({
      jobs: [job("a", "lane"), job("b", "lane")],
      capacity: { counting: { lane: { limit: 1, holders: [] } } },
      rank: reversed,
      now: 1000,
    })
    expect(result.granted.map((g) => g.job.id)).toEqual(["b"])
  })

  it("honours the returned order even when the numbers disagree with it", () => {
    // The two tests above cannot tell order from numbers, because in both the
    // two agree. `pick` walks the array `rank` returns and never sorts, so the
    // ORDER is the contract and the number is only recorded for the audit
    // record. Pinned explicitly, because a later reader looking at a field
    // called `rank` will assume it is what orders the walk, and a defensive
    // sort added on that assumption would silently change who gets granted.
    const misordered: RankFn = (jobs) =>
      jobs.map((j, index) => ({
        job: j,
        rank: index,
        why: { base: index },
      }))
    const result = pick({
      jobs: [job("a", "lane"), job("b", "lane")],
      capacity: { counting: { lane: { limit: 1, holders: [] } } },
      rank: misordered,
      now: 1000,
    })
    expect(result.granted.map((g) => g.job.id)).toEqual(["a"])
    expect(result.granted[0]?.rank).toBe(0)
  })

  it("reports the rank it granted at, so a grant can be explained", () => {
    const result = pick({
      jobs: [job("a", "lane")],
      capacity: { counting: { lane: { limit: 1, holders: [] } } },
      rank: asGiven,
      now: 1000,
    })
    expect(result.granted[0]?.rank).toBe(1)
  })

  it("does not mutate the capacity it was given", () => {
    const capacity = {
      counting: { lane: { limit: 1, holders: [] } },
    }
    pick({ jobs: [job("a", "lane")], capacity, rank: asGiven, now: 1000 })
    // The caller decides what to persist. A pick that edits its input has
    // already committed a grant the caller may refuse to act on.
    expect(capacity.counting.lane.holders).toEqual([])
  })
})
