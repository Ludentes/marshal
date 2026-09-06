/**
 * `effective = priority + min(cap, floor(waited / interval))`, descending,
 * with raw elapsed time as the tiebreak beneath it: oldest first.
 *
 * The cap is not decoration. Uncapped, a long-waiting job eventually outranks
 * everything and priority stops meaning anything; capped, it climbs a bounded
 * amount and then holds. The cap alone does NOT guarantee a waiting job is
 * eventually considered before any job of equal base priority: past
 * `cap * interval` two such jobs have identical ranks, and their order falls
 * back to `sort` stability — the order the consumer handed in, which from a
 * map iteration or a directory listing is not FIFO. The tiebreak is what
 * restores the guarantee, and it sits BENEATH the rank so age still cannot
 * erase priority. `why.waited` keeps reporting the capped bonus, because that
 * is the number that entered the rank.
 *
 * Returns every job exactly once — the contract `pick()` polices, asserted by
 * this module's own test rather than assumed.
 */
export function agingRank(o) {
    // Validated ONCE, here, rather than per job: `cap` and `interval` are
    // properties of the policy, not of any job, and re-checking them inside the
    // loop would report the same fault N times and say nothing more.
    //
    // `interval: 0` is the case worth naming: with `now === since` it computes
    // 0/0, which is NaN, which is the same silent corruption the accessor
    // guards below exist to stop.
    if (!Number.isFinite(o.interval) || o.interval <= 0) {
        throw new Error(`agingRank interval must be a positive finite number, got ${o.interval}`);
    }
    if (!Number.isFinite(o.cap) || o.cap < 0) {
        throw new Error(`agingRank cap must be a non-negative finite number, got ${o.cap}`);
    }
    return (jobs, now) => {
        // `now` is the one input the guards below missed, and it fails the same
        // way: a timestamp that failed to parse, or `Number(process.env.X)`,
        // makes every rank NaN. `pick()` does not validate it either, so nothing
        // upstream catches it.
        if (!Number.isFinite(now)) {
            throw new Error(`agingRank now must be a finite number, got ${now}`);
        }
        return (jobs
            .map((job) => {
            // The accessors are deliberately untyped — they are the seam where
            // the consumer's vocabulary stays the consumer's — so a job missing
            // the field is a realistic input, not a hypothetical one. It THROWS
            // for the reason `costOf`, `unitsOf` and `pick`'s permutation checks
            // throw: this is the caller breaking its own contract, not a scarcity
            // condition. A NaN rank reaches `Grant.rank`, the audit record this
            // module exists to produce, and scrambles `sort` into
            // implementation-defined order — a wrong answer nobody can see.
            const base = o.priority(job);
            if (!Number.isFinite(base)) {
                throw new Error(`priority for job ${job.id} must be a finite number, got ${base}`);
            }
            const at = o.since(job);
            if (!Number.isFinite(at)) {
                throw new Error(`since for job ${job.id} must be a finite number, got ${at}`);
            }
            const waited = Math.max(0, Math.min(o.cap, Math.floor((now - at) / o.interval)));
            return { job, rank: base + waited, why: { base, waited }, at };
        })
            // `pick()` walks the ORDER, not the number — it does not sort.
            .sort((a, b) => b.rank - a.rank || a.at - b.at)
            // `at` is scaffolding for the tiebreak, not part of `Ranked`.
            .map(({ job, rank, why }) => ({ job, rank, why })));
    };
}
//# sourceMappingURL=rank.js.map