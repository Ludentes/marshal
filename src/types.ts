// The vocabulary, kept apart from the algorithm so a consumer that only needs
// to read a refusal does not import the decision procedure.
//
// Every name here is resource-shaped on purpose. The nouns this package must
// never learn -- arc, seat, project, stack, repo, host -- are asserted absent
// by boundary.test.ts, because the first draft of this union had three of
// them.

/** Whoever holds a resource. Opaque to this package. */
export interface Holder {
  /** The consumer's identifier, echoed back untouched. */
  id: string
  /** What the holder is doing, in the words a waiting operator needs. */
  what: string
  since: string
}

/**
 * One resource a job asks for, and how much of it.
 *
 * A bare `{ resource }` is one unit, unpriced — exactly what a plain string
 * meant before. `units` and `amount` each apply to the capacity map the name
 * appears in, which is the rule `firstBlocker` already follows: every map is
 * consulted and no branch exits the iteration early.
 */
export interface Need {
  resource: string
  /** Counting resources: units to take. Default 1. */
  units?: number
  /** Consumable resources: amount to debit. Overrides {@link CostFn}. */
  amount?: number
}

/** A unit of work asking for resources. */
export interface Job {
  id: string
  needs: Need[]
}

/**
 * Why a job was not granted.
 *
 * `not-ready` is where a circuit breaker lands: a breaker makes a resource
 * *unavailable* rather than *held*, and saying it that way keeps provider
 * semantics -- which belong to the consumer -- out of this package.
 */
export type Blocked =
  | { kind: "no-capacity"; resource: string; holders: Holder[] }
  | { kind: "resource-held"; resource: string; by: Holder }
  | { kind: "not-ready"; resource: string; until?: number }
  | { kind: "budget-exhausted"; resource: string; resets: number }
  | { kind: "custom"; tag: string; detail: unknown }

/** Asserted by boundary.test.ts. Adding an entry is a breaking change. */
export const BLOCKED_KINDS = [
  "no-capacity",
  "resource-held",
  "not-ready",
  "budget-exhausted",
  "custom",
] as const

/** The numbers behind a rank, so a grant can be explained after the fact. */
export interface RankWhy {
  base: number
  waited?: number
  note?: string
}

export interface Ranked {
  job: Job
  rank: number
  why: RankWhy
}

/**
 * Descending. A rank *function* rather than a comparator because
 * observability requires logging effective priority at grant, and a
 * two-argument comparator cannot produce that number.
 *
 * Injected because `effective = priority + min(CAP, floor(waited / INTERVAL))`
 * is policy wearing mechanism's clothes: left inside `pick()`, every consumer
 * that disagrees with the aging curve forks the package.
 */
export type RankFn = (jobs: Job[], now: number) => Ranked[]

/**
 * Estimating a job's cost is domain knowledge, so it is injected.
 *
 * `resource` is passed because a job may need two budgets in different
 * denominations — tokens and emails — and one number cannot be right for
 * both. An existing one-argument function stays assignable, so a consumer
 * that ignores it keeps today's behaviour and must be migrated deliberately.
 */
export type CostFn = (job: Job, resource: string) => number

// The const and the union are two declarations of one fact, so they are tied
// together at compile time: a kind added to one and not the other stops the
// build. Without this the allowlist test asserts a list that no longer
// describes the type it claims to guard -- measured, not assumed: adding an
// `arc-held` arm to the union left all seven boundary tests green and tsc
// clean, because the allowlist reads the const and the noun guard reads
// exported names, and a union's string literals are neither.
type KindsMatch = Blocked["kind"] extends (typeof BLOCKED_KINDS)[number]
  ? (typeof BLOCKED_KINDS)[number] extends Blocked["kind"]
    ? true
    : never
  : never
export const _kindsMatch: KindsMatch = true
