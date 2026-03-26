import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts", "setup-entry.ts"],
  format: ["esm"],
  target: "es2022",
  dts: { resolve: false },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  outDir: "dist",
  tsconfig: "tsconfig.json",
  noExternal: ["@openclaw-china/shared", "zod"],
  external: ["ws"],
});
