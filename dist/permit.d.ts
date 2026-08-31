export interface PermitHolder {
    pid: number;
    /** What the holder is doing, in the words a waiting operator needs. */
    what: string;
    since: string;
    /** The resource, echoed into the file for anyone reading it by hand. */
    scope: string;
}
export declare class NoPermit extends Error {
    /** Whoever held the LAST slot tried — somebody concrete to wait for. */
    readonly holder: PermitHolder;
    readonly permits: number;
    constructor(holder: PermitHolder, permits: number);
}
export interface Permit {
    readonly holder: PermitHolder;
    /** Which slot this is, 0-based. Callers pass it to children. */
    readonly slot: number;
    /** Idempotent, and a no-op once somebody else holds this slot. */
    release(): void;
}
export interface PermitProbes {
    isAlive?: (pid: number) => boolean;
    log?: (message: string) => void;
}
export interface AcquirePermitInput {
    dir: string;
    /** File-name-safe already; this module does not sanitise it. */
    key: string;
    permits: number;
    holder: PermitHolder;
    probes?: PermitProbes;
}
/**
 * Slot 0 has NO suffix, deliberately.
 *
 * It is what makes a rolling deploy safe: a process running the previous
 * single-lease code holds `.eve-host-lease-<key>`, and a process running this
 * code contends on the same file rather than sailing past it into a second
 * concurrent writer. Suffixes start at 1 and only exist above one permit.
 */
export declare function permitFile(dir: string, key: string, slot: number): string;
/**
 * Take a permit, or throw {@link NoPermit} when live holders fill every slot.
 *
 * Walks the slots in order, so at N=1 this is the old single-file behaviour
 * and at N>1 the lowest free lane is always taken — which makes the slot index
 * stable enough to name in a log.
 */
export declare function acquirePermit(i: AcquirePermitInput): Permit;
//# sourceMappingURL=permit.d.ts.map