import { defineConfig } from "vitest/config";

// Library mode, not an application: M0 asks for canonical scaffolding that builds
// and tests independently of the legacy .NET project. The browser host and the
// observatory arrive at M11, around this same engine rather than a second one.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "canonical",
    },
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
