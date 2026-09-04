import { describe, expect, it } from "vitest";

import { CONFIG_MODULE_AREA } from "./index";

describe("config module area", () => {
  it("exists as a distinct scaffolding area and typechecks under vitest", () => {
    expect(CONFIG_MODULE_AREA).toBe("config");
  });
});
