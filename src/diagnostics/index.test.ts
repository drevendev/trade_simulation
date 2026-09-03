import { describe, expect, it } from "vitest";

import { DIAGNOSTICS_MODULE_AREA } from "./index";

describe("diagnostics module area", () => {
  it("exists as a distinct scaffolding area and typechecks under vitest", () => {
    expect(DIAGNOSTICS_MODULE_AREA).toBe("diagnostics");
  });
});
