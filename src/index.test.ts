import { describe, expect, it } from "vitest";

import { toolchainStatus } from "./index";

// The point of this suite is not the assertion. It is that a red TypeScript test
// can fail the build at all: until this runs in CI, any canonical TypeScript work
// would arrive with no check behind it, and the acceptor would be right to refuse it.
describe("canonical toolchain", () => {
  it("runs TypeScript under vitest", () => {
    expect(toolchainStatus().runtime).toBe("typescript");
  });

  it("claims canonical scaffolding exists now that REQ-MIGRATION-003 is done", () => {
    expect(toolchainStatus().canonicalScaffolding).toBe(true);
  });
});
