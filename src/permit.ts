// At most N holders of one named resource, across unrelated processes on one
// box.
//
// This is the generic half of what `host-lease.ts` used to do alone, split out
// because permits are the first of the arc scheduler's three allocators
// (project locks, permits, stack leases) and that scheduler is intended to
// become its own repository. Nothing in here knows what an arc, a host or a
// dev environment is: it takes a directory, an opaque key, a count and a
// holder record. Keeping it that way is the entire point — a module that
// cannot import this codebase cannot read this codebase's shared state, which
// is this repo's recurring defect.
//
// The decisions below are inherited from host-lease.ts and are the part worth
// carrying to any other project:
//
//   - PID LIVENESS, NOT A TTL. A job legitimately runs far longer than any
//     timeout we would dare set, so a TTL either strands the resource after a
//     crash or steals it from work still in progress. A pid answers the only
//     question that matters and makes a killed holder self-healing with no
//     exit handler to forget.
//   - `openSync(file, "wx")`, NOT a lock file plus a write. Create-if-absent
//     is atomic in the kernel; a read-modify-write of a holders array would
//     need its own lock to protect it, which is the machinery this avoids.
//     The holder record is then written THROUGH that fd — see `acquirePermit`
//     — because create-now-write-later leaves a window in which the file
//     exists and is empty. No test here covers that window: it needs two
//     processes interleaved inside a few microseconds, and a single-process
//     test asserting the end state would pass against the broken version too,
//     which is worse than no test.
//   - A DIRECTORY EVERY CONTENDER AGREES ON, chosen by the caller. Mutual
//     exclusion over two different paths excludes nothing, silently.
//   - NEVER QUEUE. A refusal names a holder and returns immediately; waiting
//     is the caller's decision to make with its own information.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import path from "node:path"

export interface PermitHolder {
  pid: number
  /** What the holder is doing, in the words a waiting operator needs. */
  what: string
  since: string
  /** The resource, echoed into the file for anyone reading it by hand. */
  scope: string
}

export class NoPermit extends Error {
  /** Whoever held the LAST slot tried — somebody concrete to wait for. */
  readonly holder: PermitHolder
  readonly permits: number
  constructor(holder: PermitHolder, permits: number) {
    super(
      `all ${permits} permit(s) for ${holder.scope} are held; the last is ` +
        `${holder.what} (pid ${holder.pid}, since ${holder.since}). Not ` +
        "waiting.",
    )
    this.name = "NoPermit"
    this.holder = holder
    this.permits = permits
  }
}

export interface Permit {
  readonly holder: PermitHolder
  /** Which slot this is, 0-based. Callers pass it to children. */
  readonly slot: number
  /** Idempotent, and a no-op once somebody else holds this slot. */
  release(): void
}

export interface PermitProbes {
  isAlive?: (pid: number) => boolean
  log?: (message: string) => void
}

export interface AcquirePermitInput {
  dir: string
  /** File-name-safe already; this module does not sanitise it. */
  key: string
  permits: number
  holder: PermitHolder
  probes?: PermitProbes
}

/**
 * Slot 0 has NO suffix, deliberately.
 *
 * It is what makes a rolling deploy safe: a process running the previous
 * single-lease code holds `.eve-host-lease-<key>`, and a process running this
 * code contends on the same file rather than sailing past it into a second
 * concurrent writer. Suffixes start at 1 and only exist above one permit.
 */
export function permitFile(dir: string, key: string, slot: number): string {
  return path.join(dir, `.eve-host-lease-${key}${slot === 0 ? "" : `-${slot}`}`)
}

function livePid(pid: number): boolean {
  try {
    // Signal 0 checks existence + permission without delivering anything.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to another user — alive for our
    // purposes, and stomping it is exactly what this prevents.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readHolder(file: string): PermitHolder | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(file, "utf8"),
    ) as Partial<PermitHolder>
    if (typeof parsed.pid !== "number") return undefined
    return {
      pid: parsed.pid,
      what: parsed.what ?? "unknown work",
      since: parsed.since ?? "unknown",
      scope: parsed.scope ?? "unknown",
    }
  } catch {
    // Missing (a holder released and we raced it) or truncated (killed
    // mid-write). Either way we cannot ask whether its owner is alive.
    return undefined
  }
}

/**
 * Take a permit, or throw {@link NoPermit} when live holders fill every slot.
 *
 * Walks the slots in order, so at N=1 this is the old single-file behaviour
 * and at N>1 the lowest free lane is always taken — which makes the slot index
 * stable enough to name in a log.
 */
export function acquirePermit(i: AcquirePermitInput): Permit {
  const isAlive = i.probes?.isAlive ?? livePid
  const permits = Math.max(1, Math.floor(i.permits))
  let lastHolder: PermitHolder | undefined

  for (let slot = 0; slot < permits; slot++) {
    const file = permitFile(i.dir, i.key, slot)
    // Bounded: each pass either wins the file, refuses it, or clears one dead
    // holder. Three is more than enough for the only real race — two
    // processes clearing the same corpse — and it can never spin.
    for (let attempt = 0; attempt < 3; attempt++) {
      let fd: number
      try {
        fd = openSync(file, "wx")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const current = readHolder(file)
        if (current && isAlive(current.pid)) {
          lastHolder = current
          break // this slot is genuinely held; try the next one
        }
        i.probes?.log?.(
          current
            ? `[permit] ${file}: holder pid ${current.pid} (${current.what}) ` +
                "is gone — taking the slot over"
            : `[permit] ${file}: unreadable, assuming a holder died ` +
                "mid-write — taking the slot over",
        )
        rmSync(file, { force: true })
        continue
      }
      // Written THROUGH the fd we won, before closing it. `openSync(wx)` +
      // a later `writeFileSync` leaves the file zero-length for a moment, and
      // a contender arriving in that window reads it as unparseable, concludes
      // a holder died mid-write, removes it and takes the slot — so both
      // processes believe they hold the lane and the loser's `release()`
      // no-ops. Harmless-looking before permits; under them each lane maps to
      // its own dev database, so a double-take is the two-arcs-one-schema
      // failure `arc-permit-guard.ts` exists to prevent.
      try {
        writeSync(fd, `${JSON.stringify(i.holder)}\n`)
      } finally {
        closeSync(fd)
      }
      return {
        holder: i.holder,
        slot,
        release() {
          // Only ours to remove. After a takeover the file belongs to somebody
          // else, and deleting it would let a third process in on top of them.
          const now = readHolder(file)
          if (now && now.pid !== i.holder.pid) return
          rmSync(file, { force: true })
        },
      }
    }
  }

  throw new NoPermit(
    lastHolder ?? {
      pid: -1,
      what: "an unidentified process",
      since: "unknown",
      scope: i.key,
    },
    permits,
  )
}
