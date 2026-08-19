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

describe("pick, the findings from review", () => {
  it("treats a resource named twice as one resource", () => {
    // `needs` carries no multiplicity. Unfolded, this was checked once against
    // a free lane and then consumed twice: granted, two holders on a limit of
    // one, and `holds` handed back the name twice so the caller double-frees.
    const result = pick({
      jobs: [job("a", "lane", "lane"), job("b", "lane")],
      capacity: { counting: { lane: { limit: 1, holders: [] } } },
      rank: asGiven,
      now: 1000,
    })
    expect(result.granted.map((g) => g.holds)).toEqual([["lane"]])
    expect(result.refused.map((r) => r.job.id)).toEqual(["b"])
  })

  it("does not debit a budget twice for one repeated name", () => {
    const capacity = {
      budget: { tokens: [{ name: "w", limit: 100, spent: 90, resets: 5 }] },
    }
    const result = pick({
      jobs: [
        { id: "a", needs: ["tokens", "tokens"], cost: 8 },
        { id: "b", needs: ["tokens"], cost: 8 },
      ],
      capacity,
      rank: asGiven,
      now: 1000,
    })
    // Admission approved 90 + 8. Debiting 16 leaves 106 spent against a limit
    // of 100 — an overdraw invisible until the provider refuses.
    expect(result.granted.map((g) => g.job.id)).toEqual(["a"])
    expect(result.refused[0]?.blocked.kind).toBe("budget-exhausted")
  })

  it("applies every map a name is registered in, not just the first", () => {
    // A resource that is both budgeted and concurrency-limited is an ordinary
    // thing to declare. The budget branch used to return before the counting
    // check ran, so the limit was simply not applied.
    const result = pick({
      jobs: [job("a", "t"), job("b", "t"), job("c", "t")],
      capacity: {
        counting: { t: { limit: 1, holders: [] } },
        budget: { t: [{ name: "w", limit: 1000, spent: 0, resets: 5 }] },
      },
      rank: asGiven,
      now: 1000,
    })
    expect(result.granted.map((g) => g.job.id)).toEqual(["a"])
    expect(result.refused.map((r) => r.blocked.kind)).toEqual([
      "no-capacity",
      "no-capacity",
    ])
  })

  it("refuses to lose a job the rank function dropped", () => {
    // Neither granted nor refused is not "deferred" under NEVER QUEUE — the
    // caller re-asks with what it was told, so an omitted job is lost.
    const dropping: RankFn = (jobs) =>
      jobs.slice(0, 1).map((j) => ({ job: j, rank: 1, why: { base: 1 } }))
    expect(() =>
      pick({
        jobs: [job("a", "lane"), job("b", "lane")],
        capacity: { counting: { lane: { limit: 9, holders: [] } } },
        rank: dropping,
        now: 1000,
      }),
    ).toThrow(/dropped b/)
  })

  it("reports a negative reset rather than rounding it up to zero", () => {
    // `resets` is the caller's clock in the caller's units, so offsets from a
    // monotonic base are legitimate. A 0 seed reported "already reset".
    const result = pick({
      jobs: [{ id: "a", needs: ["t"], cost: 50 }],
      capacity: {
        budget: { t: [{ name: "w", limit: 10, spent: 9, resets: -100 }] },
      },
      rank: asGiven,
      now: 1000,
    })
    const blocked = result.refused[0]?.blocked
    if (blocked?.kind !== "budget-exhausted") throw new Error("wrong kind")
    expect(blocked.resets).toBe(-100)
  })

  it("grants a cleared breaker on a resource with no allocation limit", () => {
    // Declared-but-unlimited, not never-declared. The caller named it and
    // attached no limit, which is what a bare circuit breaker on an unmetered
    // provider looks like. The existing cleared-breaker test also registers
    // the name in `counting`, so this path had no coverage and read as an
    // oversight next to the unknown-name refusal directly below it.
    const result = pick({
      jobs: [job("a", "prov")],
      capacity: { unavailable: { prov: { until: 5 } } },
      rank: asGiven,
      now: 6000,
    })
    expect(result.granted.map((g) => g.job.id)).toEqual(["a"])
  })

  it("flags a zero estimate that cost money even at a tolerance of one", () => {
    const result = reconcile([{ name: "w", limit: 100, spent: 0, resets: 1 }], {
      estimated: 0,
      actual: 900,
      tolerance: 1,
    })
    expect(result.beyondTolerance).toBe(true)
  })
})

describe("non-finite numbers fail closed", () => {
  // Three findings from the 2026-08-19 medium review. A NaN is not an
  // unlikely input here: the next caller derives a CostFn from a provider
  // quota reading, and one absent field in that payload produces one.

  it("throws when a job's price is not a number", () => {
    // Measured before the fix: with a window at 9 of 10 and price NaN, BOTH
    // queued jobs were granted and nothing was refused, because
    // `spent + NaN > limit` is false. `consume` then wrote `spent: NaN`, so
    // every later job in the same pass was granted too — a budget that has
    // stopped counting is not a budget.
    //
    // It throws rather than refusing because there is no honest `Blocked` for
    // it: the window may well have room, `budget-exhausted` would name a
    // reset that does not exist, and `custom` is construct-only for
    // consumers. A broken CostFn is a caller contract violation, which is
    // what the rank() guard already throws for.
    expect(() =>
      pick({
        jobs: [
          { id: "a", needs: ["prov"] },
          { id: "b", needs: ["prov"] },
        ],
        capacity: {
          budget: {
            prov: [{ name: "weekly", limit: 10, spent: 9, resets: 100 }],
          },
        },
        now: 0,
        cost: () => Number.NaN,
        rank: (jobs) =>
          jobs.map((job, n) => ({ job, rank: n, why: { base: n } })),
      }),
    ).toThrow(/finite number/)
  })

  it("throws on an infinite price too", () => {
    // Infinity already failed closed on its own — `spent + Infinity > limit`
    // is true — so this window was refused rather than granted. It still
    // throws now, because a CostFn returning Infinity is the same broken
    // contract and a refusal would report scarcity that is not there.
    expect(() =>
      pick({
        jobs: [{ id: "a", needs: ["prov"] }],
        capacity: {
          budget: {
            prov: [{ name: "weekly", limit: 10, spent: 0, resets: 1 }],
          },
        },
        now: 0,
        cost: () => Number.POSITIVE_INFINITY,
        rank: (jobs) => jobs.map((job) => ({ job, rank: 0, why: { base: 0 } })),
      }),
    ).toThrow(/finite number/)
  })

  it("still grants a finite price", () => {
    const out = pick({
      jobs: [{ id: "a", needs: ["prov"] }],
      capacity: {
        budget: { prov: [{ name: "weekly", limit: 10, spent: 0, resets: 1 }] },
      },
      now: 0,
      cost: () => 1,
      rank: (jobs) => jobs.map((job) => ({ job, rank: 0, why: { base: 0 } })),
    })
    expect(out.granted).toHaveLength(1)
  })

  it("reconcile reports rather than swallows an unusable actual", () => {
    // Measured before the fix: a NaN actual gave every window `spent: NaN`
    // (Math.max(0, NaN) is NaN), `drift: NaN`, and `beyondTolerance: false`
    // because `NaN > tolerance` is false — so the caller persisted corrupted
    // windows and was told the estimate was fine. That is the one case this
    // function exists to report.
    const before = [{ name: "weekly", limit: 10, spent: 5, resets: 1 }]
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = reconcile(before, {
        estimated: 1,
        actual: bad,
        tolerance: 0.2,
      })
      expect(out.windows).toEqual(before)
      expect(out.beyondTolerance).toBe(true)
    }
  })

  it("reconcile reports an unusable estimate the same way", () => {
    const before = [{ name: "weekly", limit: 10, spent: 5, resets: 1 }]
    const out = reconcile(before, {
      estimated: Number.NaN,
      actual: 1,
      tolerance: 0.2,
    })
    expect(out.windows).toEqual(before)
    expect(out.beyondTolerance).toBe(true)
  })
})

describe("rank must be a permutation, not merely onto", () => {
  it("throws when rank returns the same job twice", () => {
    // Measured before the fix: granted was ['a', 'a'] — two Grants for one
    // job, which the consumer may launch twice, with a double budget debit
    // and two holders. The dropped-set check could not see it: every job it
    // was given did come back.
    expect(() =>
      pick({
        jobs: [{ id: "a", needs: ["lane"] }],
        capacity: { counting: { lane: { limit: 5, holders: [] } } },
        now: 0,
        rank: (jobs) =>
          [...jobs, ...jobs].map((job, n) => ({
            job,
            rank: n,
            why: { base: n },
          })),
      }),
    ).toThrow(/twice|duplicate/i)
  })

  it("throws when two distinct jobs share an id", () => {
    // The symmetric loss: the dropped-set is keyed on id, so one of these is
    // silently discarded while the guard stays green.
    expect(() =>
      pick({
        jobs: [
          { id: "a", needs: ["lane"] },
          { id: "a", needs: ["lane"] },
        ],
        capacity: { counting: { lane: { limit: 5, holders: [] } } },
        now: 0,
        rank: (jobs) =>
          jobs.map((job, n) => ({ job, rank: n, why: { base: n } })),
      }),
    ).toThrow(/twice|duplicate/i)
  })
})
