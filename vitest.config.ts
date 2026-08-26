import { defineConfig } from "vitest/config"

// node, not jsdom: this package touches the filesystem and nothing else.
export default defineConfig({ test: { environment: "node" } })
