import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/conformance.ts"],
  format: "esm",
  dts: true,
  clean: true,
  // Keep dependencies and Bun built-ins out of the bundle; `bun:test` is only
  // reachable through the conformance entry, which runs in Bun by definition.
  external: [/^bun:/],
  platform: "neutral",
  treeshake: true,
});
