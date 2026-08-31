/** An unpriced job is free. Guessing a number here would be a policy. */
function costOf(job, cost) {
    return job.cost ?? cost?.(job) ?? 0;
}
/**
 * `what` is the job's own id because that is genuinely all this package
 * knows. Marshal is forbidden from understanding what a job *is* — that
 * knowledge is the consumer's, and a richer description would have to come
 * from the consumer's vocabulary, which is the one thing that may not cross
 * this boundary. `since` is stringified `now` for the same reason: there is
 * no clock here to format.
 */
function asHolder(job, now) {
    return { id: job.id, what: job.id, since: String(now) };
}
/**
 * The first reason this job cannot run, or undefined if it can.
 *
 * Every map the name appears in is consulted — none of these branches exits
 * the iteration early. A name registered as both budgeted and rate-limited
 * used to have its concurrency limit silently ignored, because the budget
 * branch returned before the counting check ran: three jobs were granted on a
 * limit-of-one. That is the same mistake as sizing admission to the loosest
 * window, made across kinds instead of within one.
 */
function firstBlocker(job, needs, w) {
    for (const resource of needs) {
        // Whether any map has heard of this name at all. A name the caller never
        // declared is a typo; a name declared with no allocation limit is a
        // deliberate choice. The two must not be conflated — see the `known`
        // check at the end of the loop.
        let known = false;
        const gate = w.unavailable[resource];
        if (gate) {
            known = true;
            if (gate.until === undefined || gate.until > w.now) {
                return { kind: "not-ready", resource, until: gate.until };
            }
        }
        if (w.exclusive.has(resource)) {
            known = true;
            const by = w.exclusive.get(resource);
            if (by)
                return { kind: "resource-held", resource, by };
        }
        const budget = w.budget.get(resource);
        if (budget) {
            known = true;
            const price = costOf(job, w.cost);
            // A price that is not a number is the caller breaking its own contract,
            // so it THROWS, exactly as a rank() that drops a job does. It is not a
            // scarcity condition and there is no honest `Blocked` for it:
            // `budget-exhausted` would claim a full window and name a reset that
            // does not exist, and `custom` is construct-only for consumers.
            //
            // Failing closed per-job is not enough either. `spent + NaN > limit` is
            // false for every window, so a NaN price granted the job and wrote
            // `spent: NaN`, after which every later job in the pass was granted too
            // — one bad price silently disabled the budget for the whole pass, and
            // a per-job refusal nobody reads is how that stays invisible.
            if (!Number.isFinite(price)) {
                throw new Error(`cost for job ${job.id} on "${resource}" must be a finite number, got ${price}`);
            }
            // Every window, not the loosest. The tightest one is the allowance; the
            // others are burst limits, and satisfying only a burst limit is how a
            // scheduler sprints into a wall on day two.
            const short = budget.filter((win) => win.spent + price > win.limit);
            if (short.length > 0) {
                // The LATEST reset among the short windows, not the first one found.
                // Answering with whichever the array happened to list first tells an
                // operator to retry in five hours while the weekly allowance is gone.
                // Seeded at -Infinity, not 0: `resets` is the caller's clock in the
                // caller's units, so a caller using offsets from a monotonic base can
                // legitimately have every short window negative, and a 0 seed would
                // report "already reset" — the same wrong answer by another route.
                const resets = short.reduce((late, win) => Math.max(late, win.resets), Number.NEGATIVE_INFINITY);
                return { kind: "budget-exhausted", resource, resets };
            }
        }
        const counted = w.counting.get(resource);
        if (counted) {
            known = true;
            if (counted.holders.length >= counted.limit) {
                // Handed out by reference on purpose, after checking it is not
                // observable: `holders` only grows, so once it reaches `limit` no
                // later job can clear this check for the same resource, and `w` is
                // discarded when `pick` returns. A defensive copy here was written
                // first, along with a test for it — the test could not be made to
                // fail, which is what proved the copy was mechanism nobody needed.
                return { kind: "no-capacity", resource, holders: counted.holders };
            }
        }
        // The name is in no map at all: the caller never declared it. Granting it
        // would hand out something nothing counts, so it is refused as not-ready
        // with no return time — a refusal is recoverable, a phantom grant is not.
        //
        // A name declared ONLY in `unavailable`, whose window has passed, is a
        // different thing and is granted: the caller told us about it and told us
        // no allocation limit applies, which is what a bare circuit breaker on an
        // unmetered provider looks like. The distinction is declared-but-unlimited
        // against never-declared, and it is asserted by its own test rather than
        // left to read as an oversight.
        if (!known)
            return { kind: "not-ready", resource };
    }
    return undefined;
}
/**
 * Called only after {@link firstBlocker} cleared every need.
 *
 * Applies to every map the name appears in, and must walk the SAME list
 * `firstBlocker` checked. Checking one list and debiting another is how a
 * resource gets overcommitted with both halves looking correct in isolation.
 */
function consume(job, needs, w) {
    for (const resource of needs) {
        if (w.exclusive.has(resource)) {
            w.exclusive.set(resource, asHolder(job, w.now));
        }
        const budget = w.budget.get(resource);
        if (budget) {
            const price = costOf(job, w.cost);
            for (const win of budget)
                win.spent += price;
        }
        const counted = w.counting.get(resource);
        if (counted)
            counted.holders.push(asHolder(job, w.now));
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
export function pick(i) {
    const w = {
        counting: new Map(Object.entries(i.capacity.counting ?? {}).map(([name, c]) => [
            name,
            { limit: c.limit, holders: [...c.holders] },
        ])),
        exclusive: new Map(Object.entries(i.capacity.exclusive ?? {}).map(([name, e]) => [
            name,
            e.by,
        ])),
        unavailable: i.capacity.unavailable ?? {},
        // Copied per window: `spent` is incremented in place, so without this,
        // asking whether a job would be admitted charges the caller for it.
        budget: new Map(Object.entries(i.capacity.budget ?? {}).map(([name, wins]) => [
            name,
            wins.map((win) => ({ ...win })),
        ])),
        cost: i.cost,
        now: i.now,
    };
    const granted = [];
    const refused = [];
    const ranked = i.rank(i.jobs, i.now);
    // `rank` must be total. A rank function that filters — a threshold, a
    // de-duplication, a bug — produces a result where granted + refused is
    // shorter than jobs, and the missing job is neither run nor refused. Under
    // NEVER QUEUE the caller re-asks with what it was told, so a job that
    // appears in neither list is not deferred: it is lost, silently, and the
    // consumer has no way to notice. Refusing it is not available either, since
    // there is no honest `Blocked` for "the policy did not mention it".
    const returned = new Set(ranked.map((r) => r.job.id));
    // Onto is not enough; it must be a permutation. A rank function that
    // concatenates two lists returns a job twice, the dropped-set check passes
    // because every job did come back, and the loop then grants the SAME job
    // twice: two Grants the consumer may launch twice, a double budget debit,
    // and two holders. The symmetric case — two distinct jobs sharing an id —
    // loses one of them silently, which is the exact loss the check below was
    // written to make impossible.
    if (returned.size !== ranked.length) {
        const seen = new Set();
        const twice = new Set();
        for (const { job } of ranked) {
            if (seen.has(job.id))
                twice.add(job.id);
            seen.add(job.id);
        }
        throw new Error(`rank() must return each job exactly once; it returned ${[...twice].join(", ")} twice`);
    }
    const dropped = i.jobs.filter((j) => !returned.has(j.id));
    if (dropped.length > 0) {
        throw new Error(`rank() must return every job it was given; it dropped ${dropped
            .map((j) => j.id)
            .join(", ")}`);
    }
    for (const { job, rank } of ranked) {
        // A name repeated in `needs` is one resource, not two. `needs` carries no
        // multiplicity, and the check and the debit read it separately: unfolded,
        // `["lane","lane"]` was tested once against a free lane and then consumed
        // twice, so a limit-of-one resource ended up with two holders and a budget
        // window was debited double what admission approved. If a job ever needs
        // two units of something, that wants an explicit count in the type, not a
        // repeated string that happens to work in one half of the code.
        const needs = [...new Set(job.needs)];
        const blocked = firstBlocker(job, needs, w);
        if (blocked) {
            refused.push({ job, blocked });
            continue;
        }
        consume(job, needs, w);
        granted.push({ job, holds: needs, rank });
    }
    return { granted, refused };
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
export function reconcile(windows, i) {
    // An unusable settlement changes nothing and SHOUTS. A NaN actual gave
    // every window `spent: NaN` — Math.max(0, NaN) is NaN, so the clamp below
    // does not filter it — with `drift: NaN` and `beyondTolerance: false`,
    // because `NaN > tolerance` is false. The caller persisted corrupted
    // windows and was told the estimate was within tolerance, which is the one
    // case this function exists to report.
    if (!Number.isFinite(i.actual) || !Number.isFinite(i.estimated)) {
        return { windows, drift: 1, beyondTolerance: true };
    }
    const correction = i.actual - i.estimated;
    const settled = windows.map((w) => ({
        ...w,
        // Never below zero: an overestimate larger than anything ever debited
        // would otherwise manufacture allowance out of a bookkeeping error.
        spent: Math.max(0, w.spent + correction),
    }));
    // A zero estimate that cost anything is infinitely wrong. `drift` reports 1
    // to keep the number finite and comparable, but the flag does NOT rest on
    // that: `drift > tolerance` is false at `tolerance: 1`, which a coarse
    // estimator would plausibly set, so the case that most needs reporting was
    // the one case silently passing. The comment here used to claim 1 "trips any
    // tolerance a caller would set", which was wrong at exactly one value.
    const unestimated = i.estimated === 0 && i.actual !== 0;
    const drift = i.estimated === 0
        ? i.actual === 0
            ? 0
            : 1
        : Math.abs(correction) / i.estimated;
    return {
        windows: settled,
        drift,
        beyondTolerance: unestimated || drift > i.tolerance,
    };
}
//# sourceMappingURL=pick.js.map