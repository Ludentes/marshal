// @vitest-environment node
import { describe, expect, it } from "vitest"
import { pick, reconcile } from "./pick"
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

const windows = () => ({
  tokens: [
    { name: "weekly", limit: 100, spent: 83, resets: 604_800 },
    { name: "5-hour", limit: 100, spent: 0, resets: 18_000 },
  ],
})

describe("pick with a budget", () => {
  it("refuses when any one window cannot fit the cost", () => {
    // The 5-hour window has 100 free and would say yes on its own. The weekly
    // window has 17. Admission must satisfy every window, not the loosest.
    const result = pick({
      jobs: [{ id: "a", needs: ["tokens"], cost: 37.5 }],
      capacity: { budget: windows() },
      rank: asGiven,
      now: 1000,
    })
    expect(result.granted).toEqual([])
    const blocked = result.refused[0]?.blocked
    expect(blocked?.kind).toBe("budget-exhausted")
    if (blocked?.kind === "budget-exhausted") {
      expect(blocked.resource).toBe("tokens")
      expect(blocked.resets).toBe(604_800)
    }
  })

  it("reports the latest reset when more than one window is short", () => {
    // Whichever window is found first must not decide the answer. Telling an
    // operator to retry when the SOONEST short window replenishes sends them
    // back into a refusal, because the others are still empty. This is the
    // loose-window error the whole budget kind exists to prevent, and it hides
    // one level down inside it: a `find` would answer 18_000 here purely
    // because of array order.
    const result = pick({
      jobs: [{ id: "a", needs: ["tokens"], cost: 60 }],
      capacity: {
        budget: {
          tokens: [
            { name: "5-hour", limit: 100, spent: 83, resets: 18_000 },
            { name: "weekly", limit: 100, spent: 83, resets: 604_800 },
          ],
        },
      },
      rank: asGiven,
      now: 1000,
    })
    const blocked = result.refused[0]?.blocked
    expect(blocked?.kind).toBe("budget-exhausted")
    if (blocked?.kind === "budget-exhausted") {
      expect(blocked.resets).toBe(604_800)
    }
  })

  it("grants when every window fits, and debits all of them", () => {
    const result = pick({
      jobs: [
        { id: "a", needs: ["tokens"], cost: 7.5 },
        { id: "b", needs: ["tokens"], cost: 7.5 },
        { id: "c", needs: ["tokens"], cost: 7.5 },
      ],
      capacity: { budget: windows() },
      rank: asGiven,
      now: 1000,
    })
    // 83 + 7.5 + 7.5 = 98 fits; the third would reach 105.5 and does not.
    expect(result.granted.map((g) => g.job.id)).toEqual(["a", "b"])
    expect(result.refused[0]?.blocked.kind).toBe("budget-exhausted")
  })

  it("uses the injected CostFn when the job carries no cost", () => {
    const result = pick({
      jobs: [{ id: "a", needs: ["tokens"] }],
      capacity: { budget: windows() },
      rank: asGiven,
      now: 1000,
      cost: () => 37.5,
    })
    expect(result.granted).toEqual([])
    expect(result.refused[0]?.blocked.kind).toBe("budget-exhausted")
  })

  it("treats an unpriced job as free rather than guessing a number", () => {
    const result = pick({
      jobs: [{ id: "a", needs: ["tokens"] }],
      capacity: { budget: windows() },
      rank: asGiven,
      now: 1000,
    })
    expect(result.granted.map((g) => g.job.id)).toEqual(["a"])
  })

  it("does not debit the budget it was given", () => {
    // The counting equivalent of this is asserted above. Budget needs its own,
    // because `spent` is incremented in place: without a copy at the door,
    // asking whether a job WOULD be admitted silently charges the caller for
    // it, and a caller that then declines to act has paid for nothing.
    const capacity = { budget: windows() }
    pick({
      jobs: [{ id: "a", needs: ["tokens"], cost: 7.5 }],
      capacity,
      rank: asGiven,
      now: 1000,
    })
    expect(capacity.budget.tokens.map((w) => w.spent)).toEqual([83, 0])
  })
})

describe("reconcile", () => {
  it("applies the difference between estimate and actual to every window", () => {
    const result = reconcile(windows().tokens, {
      estimated: 7.5,
      actual: 12,
      tolerance: 0.5,
    })
    expect(result.windows.map((w) => w.spent)).toEqual([87.5, 4.5])
    expect(result.drift).toBeCloseTo(0.6, 5)
    expect(result.beyondTolerance).toBe(true)
  })

  it("says nothing when the estimate was close enough", () => {
    const result = reconcile(windows().tokens, {
      estimated: 10,
      actual: 11,
      tolerance: 0.5,
    })
    expect(result.beyondTolerance).toBe(false)
  })

  it("never drives a window below zero", () => {
    // An overestimate that exceeds what was ever debited would otherwise
    // manufacture allowance out of a bookkeeping error.
    const result = reconcile(
      [{ name: "weekly", limit: 100, spent: 2, resets: 1 }],
      { estimated: 50, actual: 1, tolerance: 0.5 },
    )
    expect(result.windows[0]?.spent).toBe(0)
  })

  it("treats a zero estimate as fully drifted rather than dividing by zero", () => {
    const result = reconcile(
      [{ name: "weekly", limit: 100, spent: 0, resets: 1 }],
      { estimated: 0, actual: 9, tolerance: 0.5 },
    )
    expect(result.beyondTolerance).toBe(true)
    expect(Number.isFinite(result.drift)).toBe(true)
  })

  it("does not edit the windows it was handed", () => {
    const given = windows().tokens
    reconcile(given, { estimated: 7.5, actual: 12, tolerance: 0.5 })
    expect(given.map((w) => w.spent)).toEqual([83, 0])
  })
})
