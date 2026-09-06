import type { Job, RankFn } from "./types";
export interface AgingRankInput {
    priority: (job: Job) => number;
    /** When the job was first asked for, in the same clock `pick` is given. */
    since: (job: Job) => number;
    /**
     * Ceiling on the aging bonus. Without one, age erases priority. Must be a
     * non-negative finite number; zero is aging turned off.
     */
    cap: number;
    /** Clock units per point of bonus. Must be positive and finite. */
    interval: number;
}
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
export declare function agingRank(o: AgingRankInput): RankFn;
//# sourceMappingURL=rank.d.ts.map