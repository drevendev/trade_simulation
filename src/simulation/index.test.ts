import { describe, expect, it } from "vitest";

import { SIMULATION_MODULE_AREA } from "./index";

describe("simulation module area", () => {
  it("exists as a distinct scaffolding area and typechecks under vitest", () => {
    expect(SIMULATION_MODULE_AREA).toBe("simulation");
  });
});
