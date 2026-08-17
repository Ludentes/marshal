// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { acquirePermit, NoPermit, permitFile } from "./permit"

let dir: string
const KEY = "localhost-13100"
const alive = () => true
const dead = () => false

const take = (what: string, permits: number, isAlive = alive, pid = 1234) =>
  acquirePermit({
    dir,
    key: KEY,
    permits,
    holder: { pid, what, since: "2026-08-17T00:00:00.000Z", scope: KEY },
    probes: { isAlive },
  })

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permit-"))
})

describe("acquirePermit", () => {
  // The deploy-window property: at one permit the path is unchanged, so a
  // process running the old code and one running the new contend on one file.
  it("uses the unsuffixed legacy path for slot 0", () => {
    expect(permitFile(dir, KEY, 0)).toBe(
      path.join(dir, `.eve-host-lease-${KEY}`),
    )
    expect(permitFile(dir, KEY, 1)).toBe(
      path.join(dir, `.eve-host-lease-${KEY}-1`),
    )
  })

  it("hands out three permits, then refuses the fourth by name", () => {
    const a = take("arc 1", 3)
    const b = take("arc 2", 3)
    const c = take("arc 3", 3)
    expect([a.slot, b.slot, c.slot]).toEqual([0, 1, 2])
    expect(() => take("arc 4", 3)).toThrow(NoPermit)
    try {
      take("arc 4", 3)
    } catch (err) {
      // "all 3 are held" with no name leaves an operator nothing to wait for.
      expect((err as NoPermit).holder.what).toBe("arc 3")
      expect((err as NoPermit).permits).toBe(3)
    }
  })

  it("releasing the middle slot lets exactly one more in", () => {
    take("arc 1", 3)
    const b = take("arc 2", 3)
    take("arc 3", 3)
    b.release()
    expect(take("arc 4", 3).slot).toBe(1)
    expect(() => take("arc 5", 3)).toThrow(NoPermit)
  })

  it("clears a dead holder's slot and reuses it", () => {
    writeFileSync(
      permitFile(dir, KEY, 0),
      `${JSON.stringify({ pid: 999, what: "a crashed arc", since: "x", scope: KEY })}\n`,
    )
    expect(take("arc 1", 2, dead).slot).toBe(0)
  })

  it("refuses when a live holder is in every slot, even an unreadable one", () => {
    writeFileSync(permitFile(dir, KEY, 0), "{ truncated")
    take("arc 1", 2)
    // Slot 0 is unreadable, so it is cleared and taken; slot 1 then holds.
    expect(() => take("arc 2", 1)).toThrow(NoPermit)
  })

  it("release is a no-op once somebody else holds the slot", () => {
    const a = take("arc 1", 1)
    writeFileSync(
      permitFile(dir, KEY, 0),
      `${JSON.stringify({ pid: 4321, what: "arc 2", since: "y", scope: KEY })}\n`,
    )
    a.release()
    expect(readFileSync(permitFile(dir, KEY, 0), "utf8")).toContain("arc 2")
  })

  it("at one permit it behaves exactly as the old single lease did", () => {
    const a = take("arc 1", 1)
    expect(a.slot).toBe(0)
    expect(() => take("arc 2", 1)).toThrow(NoPermit)
    a.release()
    expect(take("arc 3", 1).slot).toBe(0)
  })

  it("imports nothing from this codebase", () => {
    const src = readFileSync(path.join(__dirname, "permit.ts"), "utf8")
    // Every `from "..."`, not `^import .* from "..."`: this module's node:fs
    // import spans several lines, and a line-anchored pattern would see only
    // the single-line ones — so a multi-line `import {…} from "./anything"`
    // would slip past the very assertion written to catch it.
    const imports = [...src.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1])
    // node: builtins only. The moment this fails, extraction has become a
    // rewrite rather than a move — which is the whole reason it is asserted.
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((s) => !s?.startsWith("node:"))).toEqual([])
  })
})
