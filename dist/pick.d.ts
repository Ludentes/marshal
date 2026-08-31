import type { Blocked, CostFn, Holder, Job, RankFn } from "./types";
export interface CountingState {
    limit: number;
    holders: Holder[];
}
/**
 * One replenishing allowance over one resource.
 *
 * Several of these cover a single resource, because a provider publishes more
 * than one and they disagree about what is scarce. Measured 2026-08-18: the
 * weekly window bound 6.7x harder than the 5-hour one, and pacing to the
 * 5-hour figure would have drained the week in a day.
 */
export interface BudgetWindow {
    name: string;
    limit: number;
    spent: number;
    /** When this window replenishes. The caller's clock, the caller's units. */
    resets: number;
}
export interface Capacity {
    counting?: Record<string, CountingState>;
    exclusive?: Record<string, {
        by?: Holder;
    }>;
    /** A resource that exists but is not takeable yet. Breakers land here. */
    unavailable?: Record<string, {
        until?: number;
    }>;
    /** A set of windows per resource. Admission must satisfy every one. */
    budget?: Record<string, BudgetWindow[]>;
}
export interface PickInput {
    jobs: Job[];
    capacity: Capacity;
    rank: RankFn;
    now: number;
    cost?: CostFn;
}
export interface Grant {
    job: Job;
    holds: string[];
    /** Effective priority at grant, for the audit record. */
    rank: number;
}
export interface Refusal {
    job: Job;
    blocked: Blocked;
}
export interface PickResult {
    granted: Grant[];
    refused: Refusal[];
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
export declare function pick(i: PickInput): PickResult;
export interface ReconcileInput {
    estimated: number;
    actual: number;
    /** Fractional drift above which the caller is told. 0.5 is 50% out. */
    tolerance: number;
}
export interface Reconciliation {
    windows: BudgetWindow[];
    /** |actual - estimated| / estimated, as a fraction. */
    drift: number;
    beyondTolerance: boolean;
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
export declare function reconcile(windows: BudgetWindow[], i: ReconcileInput): Reconciliation;
//# sourceMappingURL=pick.d.ts.map