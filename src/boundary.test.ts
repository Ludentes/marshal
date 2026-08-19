// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// Discovered, never listed. A listed set goes vacuously green the moment
// somebody adds a file to the package, which is the failure mode recorded in
// the directory-loaded-contracts lesson: the check kept passing and the
// contract it protected had already moved.
function packageFiles(): string[] {
  return readdirSync(__dirname)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(__dirname, name))
}

// Matches every from-clause anywhere in the file, rather than being anchored
// to the start of a line. A line-anchored pattern sees only single-line
// imports, so an import of a local path whose specifier is pushed onto the
// next line would slip past the very assertion written to catch it. Stated as
// a rule rather than as an observation about today's files: these imports are
// single-line now, and a future one need not be.
//
// It reads raw source and deliberately does NOT strip comments first, so
// prose that spells a from-clause out literally gets reported as a violation.
// That is the intended trade. Stripping comments removes that false positive
// but loses every specifier containing '//' or '/*' -- which silently admits
// a URL import, exactly the foreign dependency this guard exists to catch.
// One failure mode shouts and is fixed in a minute; the other is a guard that
// passes while the boundary is gone. Prefer the one that shouts, and write
// the surrounding prose so it does not trip.
function importsOf(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1] as string)
}

describe("the Marshal boundary", () => {
  it("discovers the package rather than trusting a list", () => {
    const names = packageFiles().map((f) => path.basename(f))
    expect(names).toContain("permit.ts")
    expect(names.length).toBeGreaterThan(1)
  })

  it("stays one flat directory, so discovery cannot be evaded", () => {
    const dirs = readdirSync(__dirname, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    // A subdirectory would be invisible to the sweep above, which is the
    // cheapest way to smuggle an import past this file.
    expect(dirs).toEqual([])
  })

  it("admits only node: and ./ in non-test files", () => {
    const offenders: string[] = []
    for (const file of packageFiles()) {
      if (file.endsWith(".test.ts")) continue
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (!spec.startsWith("node:") && !spec.startsWith("./")) {
          offenders.push(`${path.basename(file)} -> ${spec}`)
        }
      }
    }
    // The moment this fails, extraction has become a rewrite rather than a
    // move — which is the whole reason it is asserted.
    expect(offenders).toEqual([])
  })

  it("admits vitest in test files, and nothing else", () => {
    // The carve-out is discovered by suffix, not by an exemption list, so it
    // cannot be widened by renaming a file into it.
    const offenders: string[] = []
    for (const file of packageFiles()) {
      if (!file.endsWith(".test.ts")) continue
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        const ok =
          spec.startsWith("node:") || spec.startsWith("./") || spec === "vitest"
        if (!ok) offenders.push(`${path.basename(file)} -> ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("the Marshal vocabulary", () => {
  it("the refusal kinds are exactly the allowlist", async () => {
    const { BLOCKED_KINDS } = await import("./types")
    // Adding a kind after publication is a breaking change to a union a
    // consumer cannot opt out of, so the list is asserted rather than trusted.
    expect([...BLOCKED_KINDS]).toEqual([
      "no-capacity",
      "resource-held",
      "not-ready",
      "budget-exhausted",
      "custom",
    ])
  })

  it("never emits the custom arm from its own source", () => {
    // `custom` is construct-only for consumers. A consumer's tag is its own
    // vocabulary; the package emitting one would be the leak, and a check that
    // reads only `kind` would wave a custom-tagged refusal carrying a domain
    // noun straight through the allowlist above.
    //
    // Declaring the arm and constructing one are told apart by what follows
    // the string: a type member ends in `;`, an object property in `,` or `}`.
    // types.ts MUST declare the arm — it is the file that defines the union —
    // so a check that cannot make this distinction forbids the one thing the
    // package is required to do. That is what the first version did.
    //
    // Known gap, stated rather than implied: this reads text, so it misses
    // `kind: "custom" as const` and anything built through a variable. It
    // catches the forms a leak is actually written in, and is not a proof.
    const emitted = /kind:\s*"custom"\s*[,}]/
    const offenders: string[] = []
    for (const file of packageFiles()) {
      if (file.endsWith(".test.ts")) continue
      if (emitted.test(readFileSync(file, "utf8"))) {
        offenders.push(path.basename(file))
      }
    }
    expect(offenders).toEqual([])
  })

  // Split into words rather than matched as a substring-with-boundaries. The
  // first version of this guard used a case-insensitive pattern requiring a
  // non-letter on each side of the noun, which meant a following capital
  // blocked the match: it caught a bare `Arc` and missed `arcHolder`,
  // `hostLease`, `ProjectLock`, `StackLease` and `repoName` -- every form
  // these names actually take. A guard that passes while the boundary is gone
  // is worse than no guard.
  const BANNED = new Set(["arc", "seat", "project", "stack", "repo", "host"])

  function words(name: string): string[] {
    return name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase())
  }

  it("no exported name carries Galatea's nouns", () => {
    const offenders: string[] = []
    for (const file of packageFiles()) {
      if (file.endsWith(".test.ts")) continue
      const src = readFileSync(file, "utf8")
      const declared =
        /export\s+(?:interface|type|class|function|const|enum)\s+(\w+)/g
      for (const m of src.matchAll(declared)) {
        const name = m[1] as string
        const hit = words(name).some(
          (w) => BANNED.has(w) || BANNED.has(w.replace(/s$/, "")),
        )
        if (hit) offenders.push(`${path.basename(file)}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
