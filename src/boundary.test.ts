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

// Every `from "..."`, not `^import ... from "..."`. A line-anchored pattern
// sees only single-line imports, so a multi-line `import {…} from
// "./anything"` would slip past the very assertion written to catch it. Stated
// as a rule rather than as an observation about today's files: these imports
// are single-line now, and a future one need not be.
function importsOf(source: string): string[] {
  // Comments first: the very comment above contains the words `from "..."`,
  // and a scanner that cannot tell prose from code reports its own
  // explanation as a violation. Stripping can only lose a specifier that sits
  // behind a `//` on its own line, which is already not an import.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  return [...code.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1] as string)
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
